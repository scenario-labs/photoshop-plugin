"use strict";
// Shared pieces of the Edit and Enhance lane views (lanes/edit.js,
// lanes/enhance.js): the texts, the model facts a view needs, and the
// context a view is built from. Views are plain objects, so the panel and the
// tests read the same thing and nothing here touches the DOM.

var MAP = require("../../../shared/catalog-map.json");
var map = require("../catalog/map.js");
var shapeMod = require("../capture/shape.js");

var TEXT = {
  no_document: "Open or create a document to use this lane.",
  no_layer: "Select a layer first.",
  outside: "Selection is outside the canvas.",
  too_small: "Selection is too small to edit.",
  no_capture: "This model takes no image, so it can't edit an area.",
  no_selection_note: "No selection: edits the whole canvas, lands unmasked.",
  no_selection_layer_note: "No selection: edits the current layer's area, lands unmasked.",
  matte_note: "The layer's transparent parts go to the model as gray; the takes land on gray. Remove background cuts one out.",
  pad_note: "The canvas is smaller than the size this model generates; the edge pixels are repeated, then cropped away.",
  reference_hint: "Say what to change and what to keep",
  change_amount: "Lower keeps closer to your layer.",
  experimental: "Experimental",
  no_edit_route: "This model can't edit an area. Use Make new, then use the result as a reference in Edit.",
  not_a_base: "This trained model's base can't run here.",
  not_expand: "This model does not expand images.",
  nothing_grows: "The new canvas is the same size as this one. Pick another aspect or add pixels on a side.",
  center_only: "This model expands around the center.",
  ratio_only: "This model expands to a ratio. Per side is off for it.",
  no_position: "This model has no position for that anchor.",
  no_selection_box: "Make a selection to use the selection box.",
  layer_empty: "The current layer has no pixels in the canvas.",
  no_pixels: "Pick a layer with pixels: adjustment layers have none.",
  too_big_for_model: "The source is already as large as this model's largest output, so nothing would be gained.",
  cutout_new_layer_only: "This layer can only get a new cutout layer: its own stays as it is.",
  selection_hides: "From the selection box, the mask hides everything outside the box."
};

// The smallest selection the Edit lane accepts, on each side (SPEC 3.8).
var MIN_SELECTION = 16;
var DEFAULT_FEATHER = 2;
var DEFAULT_OVERLAP = 32;

function hiddenText(name) {
  return 'Layer "' + name + '" is hidden. Show it to use it as the source.';
}

function facts(modelId) {
  return Object.prototype.hasOwnProperty.call(MAP.models, modelId) ? MAP.models[modelId] : {};
}

// Whether the model takes JPEG uploads (else captures go as PNG).
function jpegOk(modelId) {
  var f = facts(modelId).input_formats;
  return Array.isArray(f) && f.indexOf("jpeg") >= 0;
}

function param(schema, name) {
  for (var i = 0; i < schema.parameters.length; i++) if (schema.parameters[i].name === name) return schema.parameters[i];
  return null;
}

function fileInput(schema, name) {
  for (var i = 0; i < schema.file_inputs.length; i++) if (schema.file_inputs[i].name === name) return schema.file_inputs[i];
  return null;
}

function maskInput(schema) {
  for (var i = 0; i < schema.file_inputs.length; i++) if (schema.file_inputs[i].role === "mask") return schema.file_inputs[i].name;
  return null;
}

function polarity(schema) {
  return schema.mask_polarity && schema.mask_polarity.value ? schema.mask_polarity.value : "white";
}

// The lane's preset parameters when the model is the lane's default model
// (shared/catalog-map.json defaults), else none.
function presetFor(lane, modelId) {
  var d = map.defaults(lane);
  if (!d || d.model_id !== modelId) return {};
  var out = {};
  for (var k in d.preset) out[k] = d.preset[k];
  return out;
}

function defaultModel(lane) {
  var d = map.defaults(lane);
  return d ? d.model_id : null;
}

// Takes for a lane: the person's choice within the model's limit, else the
// lane default (2 in Edit, 1 elsewhere).
function takesFor(schema, lane, wanted) {
  if (!schema.takes_input) return null;
  var d = map.defaults(lane);
  var t = wanted || (d ? d.takes : 1);
  var max = schema.takes_max || 1;
  return Math.max(1, Math.min(t, max));
}

function boxArray(b) {
  return [b.left, b.top, b.width, b.height];
}

// The largest output the model gives on its long side, from its size inputs
// or the mapping data, or null.
function maxOutput(schema) {
  var si = schema.size_inputs || {};
  if (si.kind === "grid" && si.max) return si.max;
  return schema.output_max_px || null;
}

// The size of a source read for Upscale and Remove BG: at most the read cap
// (or `cap` when smaller) on the long side.
function readSize(box, cap) {
  var limit = Math.min(MAP.stand_ins.read_cap_px, cap || MAP.stand_ins.read_cap_px);
  var long = Math.max(box.width, box.height);
  if (long <= limit) return { width: box.width, height: box.height, scale: 1 };
  var s = limit / long;
  return { width: Math.max(1, Math.round(box.width * s)), height: Math.max(1, Math.round(box.height * s)), scale: s };
}

// A layer's area inside the canvas, or null.
function layerBox(layer, canvas) {
  if (!layer || !layer.bounds) return null;
  return shapeMod.clip(layer.bounds, canvas);
}

module.exports = {
  TEXT: TEXT,
  MIN_SELECTION: MIN_SELECTION,
  DEFAULT_FEATHER: DEFAULT_FEATHER,
  DEFAULT_OVERLAP: DEFAULT_OVERLAP,
  hiddenText: hiddenText,
  facts: facts,
  jpegOk: jpegOk,
  param: param,
  fileInput: fileInput,
  maskInput: maskInput,
  polarity: polarity,
  presetFor: presetFor,
  defaultModel: defaultModel,
  takesFor: takesFor,
  boxArray: boxArray,
  maxOutput: maxOutput,
  readSize: readSize,
  layerBox: layerBox
};
