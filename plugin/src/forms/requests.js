"use strict";
// What a lane prices (SPEC 3.2, 3.6, 6.1): which file inputs the lane fills
// later (pending, priced by stand-in rules) and which size the source has.
// Shared by the panel and the agent tools, so both price the same request.

var enums = require("../../../shared/enums.json");
var MAP = require("../../../shared/catalog-map.json");
var errorsMod = require("../scenario/errors.js");
var map = require("../catalog/map.js");

function invalid(text) {
  return new errorsMod.ScenarioError("InvalidParameter", text);
}

// Lanes the panel's own flows use that agents are not offered (FLOWS v2, F9
// Animate and Frame to layer): the agent tools keep the shared list.
var PANEL_LANES = ["video"];

function checkLane(lane, panel) {
  if (enums.lane.v1.indexOf(lane) >= 0 || (panel && PANEL_LANES.indexOf(lane) >= 0)) return;
  if (enums.lane.v1_1 && enums.lane.v1_1.indexOf(lane) >= 0) throw invalid("The " + lane + " lane comes in a later release.");
  throw invalid("lane must be one of: " + enums.lane.v1.join(", ") + ".");
}

function fileInput(schema, name) {
  for (var i = 0; i < schema.file_inputs.length; i++) if (schema.file_inputs[i].name === name) return schema.file_inputs[i];
  return null;
}

// The input that takes reference images in the Image lane: the first file
// input whose role is reference, or null.
function referenceInput(schema) {
  for (var i = 0; i < schema.file_inputs.length; i++) if (schema.file_inputs[i].role === "reference") return schema.file_inputs[i];
  return null;
}

// The file inputs the lane fills from the document, as {name: count}. In
// the Image lane these are the references the person added: captured when
// added, uploaded at Generate, priced by count until then. In the other
// lanes, the capture (counted with any references when it goes first among
// them) and, for Edit and Expand, the mask unless opts.mask is false (an
// edit with no selection, an Expand route without a mask).
function pendingFor(lane, schema, params, refCount, opts) {
  opts = opts || {};
  var pending = {};
  if (lane === "image") {
    if (!refCount) return pending;
    var ref = referenceInput(schema);
    if (!ref) throw invalid("This model takes no reference images.");
    var max = ref.multiple ? ref.max || null : 1;
    if (max !== null && refCount > max) throw invalid("This model takes at most " + max + " reference image" + (max === 1 ? "" : "s") + ".");
    pending[ref.name] = refCount;
    return pending;
  }
  var name = schema.capture_input_name;
  if (!name) throw invalid("This model takes no image input, so it can't run in the " + lane + " lane.");
  var input = fileInput(schema, name);
  if (input && (input.multiple || params[name] === undefined)) pending[name] = 1 + (input.multiple && lane === "edit" ? refCount || 0 : 0);
  if (input && input.multiple && input.max && pending[name] > input.max) throw invalid("This model takes at most " + input.max + " images, the capture included.");
  if ((lane === "edit" || lane === "expand") && opts.mask !== false) {
    for (var i = 0; i < schema.file_inputs.length; i++) {
      var f = schema.file_inputs[i];
      if (f.role === "mask" && params[f.name] === undefined) pending[f.name] = 1;
    }
  }
  return pending;
}

// The model fits the lane (SPEC 3.3 tab rules). Trained models are never
// called: their base is. A trained edit (SPEC 3.4) runs in the Edit lane on
// any of the bases the plugin probes for trained models.
function checkModelLane(schema, lane, trained) {
  var row = schema.row;
  if (trained) {
    if (MAP.trained.base_probes.indexOf(schema.model_id) < 0) throw invalid(schema.name + " is not a base for trained models.");
    if (lane !== "edit" && lane !== "image") throw invalid("Trained models run in the image and edit lanes.");
    return;
  }
  if (!row) return;
  if (map.hidden(row)) throw invalid("This model is deprecated.");
  if (row.type !== "custom") throw invalid("A trained model is never the model called: pass one of its base_model_ids as model_id and the trained model in loras (LoRA) or modelId (composition).");
  if (map.lanesOf(row).indexOf(lane) < 0) throw invalid(schema.name + " does not run in the " + lane + " lane.");
}

// a: { lane, model_id, parameters, takes, target, source_size, references
//      (how many references wait for upload), mask (false: no mask input
//      filled), trained (a trained edit on this base) }
function build(schema, a) {
  checkLane(a.lane, a.lane === "video" && a.target && (a.target.kind === "video" || a.target.kind === "frames"));
  checkModelLane(schema, a.lane, !!a.trained);
  var params = a.parameters || {};
  return {
    model_id: schema.model_id,
    lane: a.lane,
    parameters: params,
    takes: a.takes === undefined ? null : a.takes,
    // Frame to layer sends a clip already on Scenario (its asset id): nothing
    // waits for upload.
    pending: a.target && a.target.kind === "frames" ? {} : pendingFor(a.lane, schema, params, a.references || 0, { mask: a.mask }),
    source_size: a.source_size || null,
    target: a.target || null
  };
}

module.exports = { build: build, pendingFor: pendingFor, checkLane: checkLane, referenceInput: referenceInput, fileInput: fileInput };
