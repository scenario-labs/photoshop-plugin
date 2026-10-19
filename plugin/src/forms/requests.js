"use strict";
// What a lane prices (SPEC 3.2, 3.6, 6.1): which file inputs the lane fills
// later (pending, priced by stand-in rules) and which size the source has.
// Shared by the panel and the agent tools, so both price the same request.

var enums = require("../../../shared/enums.json");
var errorsMod = require("../scenario/errors.js");
var map = require("../catalog/map.js");

function invalid(text) {
  return new errorsMod.ScenarioError("InvalidParameter", text);
}

function checkLane(lane) {
  if (enums.lane.v1.indexOf(lane) >= 0) return;
  if (enums.lane.v1_1 && enums.lane.v1_1.indexOf(lane) >= 0) throw invalid("The " + lane + " lane comes in a later release.");
  throw invalid("lane must be one of: " + enums.lane.v1.join(", ") + ".");
}

function fileInput(schema, name) {
  for (var i = 0; i < schema.file_inputs.length; i++) if (schema.file_inputs[i].name === name) return schema.file_inputs[i];
  return null;
}

// The file inputs the lane fills from the document, as {name: count}.
function pendingFor(lane, schema, params) {
  var pending = {};
  if (lane === "image") return pending;
  var name = schema.capture_input_name;
  if (!name) throw invalid("This model takes no image input, so it can't run in the " + lane + " lane.");
  var input = fileInput(schema, name);
  if (input && (input.multiple || params[name] === undefined)) pending[name] = 1;
  if (lane === "edit" || lane === "expand") {
    for (var i = 0; i < schema.file_inputs.length; i++) {
      var f = schema.file_inputs[i];
      if (f.role === "mask" && params[f.name] === undefined) pending[f.name] = 1;
    }
  }
  return pending;
}

// The model fits the lane (SPEC 3.3 tab rules). Trained models are never
// called: their base is.
function checkModelLane(schema, lane) {
  var row = schema.row;
  if (!row) return;
  if (map.hidden(row)) throw invalid("This model is deprecated.");
  if (row.type !== "custom") throw invalid("A trained model is never the model called: pass one of its base_model_ids as model_id and the trained model in loras (LoRA) or modelId (composition).");
  if (map.lanesOf(row).indexOf(lane) < 0) throw invalid(schema.name + " does not run in the " + lane + " lane.");
}

// a: { lane, model_id, parameters, takes, target, source_size }
function build(schema, a) {
  checkLane(a.lane);
  checkModelLane(schema, a.lane);
  var params = a.parameters || {};
  return {
    model_id: schema.model_id,
    lane: a.lane,
    parameters: params,
    takes: a.takes === undefined ? null : a.takes,
    pending: pendingFor(a.lane, schema, params),
    source_size: a.source_size || null,
    target: a.target || null
  };
}

module.exports = { build: build, pendingFor: pendingFor, checkLane: checkLane };
