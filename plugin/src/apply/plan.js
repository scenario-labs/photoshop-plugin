"use strict";
// What a placement does, as plain data (SPEC 5.7, 6.5, 9.1, 9.2), so it is
// tested under Node; host.placeResults carries it out in Photoshop.
//
// - Every take lands as an embedded smart object. Image lane plates cover
//   the box, centered (the smart object keeps the whole result, so the
//   person can move it). Edits, Expand, upscales and cutouts fit the box
//   exactly when the result's aspect is within 1% of it, else they are
//   contained in it, centered (SPEC 5.7, 5.8).
// - One take is one layer `Scenario image <slug> <tail6>`. Several takes are
//   a group `Scenario image <slug> (<n> takes)` holding `Take <i> <tail6>`,
//   take 1 on top and visible, the others hidden.
// - Each layer, and the group, carries the scenario XMP packet (schema 1).
// - One History state: "Scenario: Place <kind>", or "Scenario: Expand".
// - With "leave prompts out", names carry no slug and the packet no prompt
//   and no free-text setting; with "leave prices out", no CU amounts.

var canonical = require("../util/canonical-json.js");
var slugMod = require("../util/slug.js");
var builtinMod = require("../util/builtin.js");
var xmp = require("../util/xmp.js");

var HISTORY = { image: "Scenario: Place image", edit: "Scenario: Place edit", expand: "Scenario: Expand", upscale: "Scenario: Place upscale", cutout: "Scenario: Place cutout", library: "Scenario: Place library" };
var ASPECT_TOLERANCE = 0.01;

function kindOf(lane) {
  if (lane === "remove_background") return "cutout";
  if (lane === "library") return "library";
  return lane === "image" || lane === "edit" || lane === "upscale" || lane === "expand" ? lane : "image";
}

// Scale (percent, the same on both axes) and center that make a w x h
// image cover the box.
function cover(w, h, box) {
  var s = Math.max(box.width / w, box.height / h);
  return { scale_pct: s * 100, center_x: box.left + box.width / 2, center_y: box.top + box.height / 2, width: w * s, height: h * s };
}

// The box exactly when the aspects agree within 1%, else contained in it,
// centered. Returns the fit and whether it was contained.
function boxFit(w, h, box) {
  var off = Math.abs(w / h - box.width / box.height) > ASPECT_TOLERANCE * (box.width / box.height);
  if (!off) return { center_x: box.left + box.width / 2, center_y: box.top + box.height / 2, width: box.width, height: box.height, contained: false };
  var s = Math.min(box.width / w, box.height / h);
  return { center_x: box.left + box.width / 2, center_y: box.top + box.height / 2, width: w * s, height: h * s, contained: true };
}

// The parameters as written in metadata: canonical JSON, file inputs as
// asset ids. With prompts left out, every free-text value goes: prompt,
// negativePrompt and any string parameter whose schema has no enum.
function parametersText(params, freeText, leavePrompts) {
  var out = {};
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    if (leavePrompts && (k === "prompt" || k === "negativePrompt" || freeText.indexOf(k) >= 0)) continue;
    out[k] = params[k];
  }
  return canonical.stringify(out);
}

function names(kind, prompt, assetIds, leavePrompts) {
  var slug = leavePrompts ? "" : slugMod.slug(builtinMod.nameOf(prompt) || prompt);
  var lead = "Scenario " + kind + (slug ? " " + slug : "");
  if (assetIds.length === 1) return { layers: [lead + " " + slugMod.tail(assetIds[0])], group: null };
  var layers = assetIds.map(function (id, i) {
    return "Take " + (i + 1) + " " + slugMod.tail(id);
  });
  return { layers: layers, group: lead + " (" + assetIds.length + " takes)" };
}

// rec: a ledger record with outputs saved. o: { version, leave_prompts,
// leave_prices, free_text (string parameter names without enum),
// document: {id, width, height} | null (where it lands), box (document
// pixels; the record's target box by default), mask, restore_active,
// fit ("cover" by default, or "box"), insert ({layer_id} or null: the top),
// canvas (Expand), duplicate ({name}: land in a copy), reads (for the
// checks), cutout (Remove BG: { layer_id, background (the source was the
// Background), lands, box, mask_box, source_path }) }.
function agentHistory(rec, name) {
  return rec.origin && rec.origin.kind === "agent" ? name.replace(/^Scenario: /, "Scenario agent: ") : name;
}

function build(rec, o) {
  o = o || {};
  var kind = kindOf(rec.lane);
  var outputs = (rec.outputs || []).filter(function (x) {
    return x && x.path && (!o.assets || o.assets.indexOf(x.asset_id) >= 0);
  });
  if (!outputs.length) throw new Error("no saved results to place");
  var ids = outputs.map(function (x) {
    return x.asset_id;
  });
  var prompt = rec.parameters && typeof rec.parameters.prompt === "string" ? rec.parameters.prompt : "";
  // A run started from a Suggest proposal keeps the person's short prompt
  // as its name (FLOWS v2, changes after review 8).
  var short = typeof rec.name === "string" && rec.name ? rec.name : null;
  var n = names(kind, short || prompt, ids, !!o.leave_prompts);
  var params = parametersText(rec.parameters || {}, o.free_text || [], !!o.leave_prompts);
  var box = o.box;
  if (!box) {
    var t = rec.target || {};
    if (t.box && t.box.length === 4) box = { left: t.box[0], top: t.box[1], width: t.box[2], height: t.box[3] };
    else box = { left: 0, top: 0, width: t.width || outputs[0].width, height: t.height || outputs[0].height };
  }
  var common = {
    schema: "1",
    jobId: rec.job_id,
    modelId: rec.model_id,
    modelName: rec.model_name,
    trainedModelIds: (rec.trained_model_ids || []).join(","),
    prompt: o.leave_prompts ? null : prompt || null,
    runName: o.leave_prompts ? null : short,
    negativePrompt: o.leave_prompts || !rec.parameters ? null : rec.parameters.negativePrompt || null,
    parameters: params,
    inputAssetIds: (rec.inputs && rec.inputs.asset_ids ? rec.inputs.asset_ids : []).join(","),
    cuQuoted: o.leave_prices ? null : rec.cu_quoted,
    cuCharged: o.leave_prices ? null : rec.cu_charged,
    createdAt: rec.submitted_at || rec.created_at,
    kind: kind,
    captureBox: [box.left, box.top, box.width, box.height].map(Math.round).join(","),
    sample: rec.target && rec.target.sample ? rec.target.sample : null,
    origin: rec.origin && rec.origin.kind === "agent" ? ("agent:" + (rec.origin.client_name || "")).slice(0, 64) : "person",
    pluginVersion: o.version || null
  };
  var takes = outputs.map(function (out, i) {
    var fields = {};
    for (var k in common) fields[k] = common[k];
    fields.assetId = out.asset_id;
    fields.take = String(i + 1);
    var fit = o.fit === "box" ? boxFit(out.width || box.width, out.height || box.height, box) : cover(out.width || box.width, out.height || box.height, box);
    return { path: out.path, asset_id: out.asset_id, name: n.layers[i], xmp: xmp.build(fields), visible: i === 0, width: out.width, height: out.height, fit: fit };
  });
  var group = null;
  if (n.group) {
    var gf = {};
    for (var g in common) gf[g] = common[g];
    group = { name: n.group, xmp: xmp.build(gf) };
  }
  var doc = o.document || null;
  var cut = null;
  if (o.cutout) {
    cut = {
      layer_id: o.cutout.layer_id,
      background: !!o.cutout.background,
      lands: o.cutout.lands,
      box: o.cutout.box,
      mask_box: o.cutout.lands === "mask" ? o.cutout.mask_box : o.cutout.box,
      source_path: o.cutout.source_path || null,
      drop_selection: !!o.cutout.drop_selection,
      source_fit: boxFit(o.cutout.box.width, o.cutout.box.height, o.cutout.box),
      name: takes[0].name,
      xmp: takes[0].xmp
    };
  }
  return {
    // Agent placements are named "Scenario agent: <action>" (SPEC 6.5).
    history_name: agentHistory(rec, HISTORY[kind] || "Scenario: Place " + kind),
    kind: kind,
    document_id: doc ? doc.id : null,
    new_document: doc ? null : { width: Math.round(box.width), height: Math.round(box.height), name: n.group || n.layers[0] },
    duplicate: doc && o.duplicate ? o.duplicate : null,
    box: box,
    takes: takes,
    group: group,
    mask: o.mask || null,
    insert: o.insert || null,
    canvas: o.canvas || null,
    reads: o.reads || null,
    cutout: cut,
    restore_active: !!o.restore_active
  };
}

module.exports = { build: build, cover: cover, boxFit: boxFit, names: names, kindOf: kindOf, parametersText: parametersText, HISTORY: HISTORY };
