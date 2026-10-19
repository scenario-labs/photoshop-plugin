"use strict";
// A model's schema as the plugin and agents use it (MCP.md 4.2,
// `model_schema`), read from the REST record of GET /v1/models/{id}:
// `inputs` (name, type, kind, costImpact, required, min, max, step,
// allowedValues, maxLength, modelTypes) and `uiConfig` (size presets).
// Facts the schema does not state come from shared/catalog-map.json.

var MAP = require("../../../shared/catalog-map.json");

var FILE_TYPES = { file: true, file_array: true };
var KNOWN_TYPES = { string: true, number: true, boolean: true, model: true, model_array: true, number_array: true, string_array: true, file: true, file_array: true };

function num(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function modelFacts(id) {
  return Object.prototype.hasOwnProperty.call(MAP.models, id) && id.charAt(0) !== "$" ? MAP.models[id] : {};
}

function requiredAlways(input) {
  return !!(input.required && input.required.always === true);
}

function roleOf(input) {
  if (input.name === "mask" || input.maskFrom) return "mask";
  if (input.type === "file_array") return "reference";
  return "image";
}

// The size inputs of SPEC 5.8: a grid (width and height with a step), a ratio
// enum, or none.
function sizeInputs(inputs, ui) {
  var byName = {};
  for (var i = 0; i < inputs.length; i++) byName[inputs[i].name] = inputs[i];
  var rc = ui && ui.resolutionComponent;
  var wName = (rc && rc.widthInput) || (byName.width ? "width" : byName.outputWidth ? "outputWidth" : null);
  var hName = (rc && rc.heightInput) || (byName.height ? "height" : byName.outputHeight ? "outputHeight" : null);
  var w = wName && byName[wName];
  var h = hName && byName[hName];
  var sizes = [];
  if (rc && Array.isArray(rc.presets)) {
    for (var p = 0; p < rc.presets.length; p++) {
      var ps = rc.presets[p];
      if (ps && num(ps.width) && num(ps.height)) sizes.push({ width: ps.width, height: ps.height, label: typeof ps.label === "string" ? ps.label : ps.width + " x " + ps.height });
    }
  }
  if (w && h && w.type === "number" && h.type === "number") {
    return {
      kind: "grid",
      width_input: wName,
      height_input: hName,
      step: num(w.step) || 1,
      min: Math.max(num(w.min) || 1, num(h.min) || 1),
      max: Math.min(num(w.max) || 16384, num(h.max) || 16384),
      ratios: [],
      sizes: sizes
    };
  }
  var ratio = byName.aspectRatio || byName.aspect_ratio;
  if (ratio && Array.isArray(ratio.allowedValues)) {
    return { kind: "ratio_enum", width_input: null, height_input: null, step: null, min: null, max: null, ratios: ratio.allowedValues.slice(), sizes: sizes };
  }
  return { kind: "none", width_input: null, height_input: null, step: null, min: null, max: null, ratios: [], sizes: [] };
}

// record: the `model` object of GET /v1/models/{id}.
function normalize(record) {
  var id = record.id;
  var facts = modelFacts(id);
  var inputs = Array.isArray(record.inputs) ? record.inputs.filter(function (x) { return x && typeof x.name === "string" && x.name; }) : [];
  var parameters = [];
  var files = [];
  var priceAffecting = [];
  var takesLoras = null;
  var maskPolarity = null;
  for (var i = 0; i < inputs.length; i++) {
    var x = inputs[i];
    if (x.costImpact === true) priceAffecting.push(x.name);
    if (FILE_TYPES[x.type]) {
      var role = roleOf(x);
      files.push({
        name: x.name,
        kind: typeof x.kind === "string" ? x.kind : "image",
        role: role,
        multiple: x.type === "file_array",
        max: x.type === "file_array" ? num(x.maxLength) || null : 1,
        required: requiredAlways(x),
        required_with: x.required && x.required.ifDefined && typeof x.required.ifDefined === "object" ? Object.keys(x.required.ifDefined) : [],
        price_affecting: x.costImpact === true,
        label: typeof x.label === "string" ? x.label : x.name
      });
      if (role === "mask") {
        if (x.backgroundBehavior === "transparent") maskPolarity = { value: "alpha", source: "schema" };
        else if (facts.mask_polarity) maskPolarity = { value: facts.mask_polarity, source: "table" };
        else maskPolarity = { value: "white", source: "default" };
      }
      continue;
    }
    parameters.push({
      name: x.name,
      type: KNOWN_TYPES[x.type] ? x.type : "string",
      default: x.default === undefined ? null : x.default,
      enum: Array.isArray(x.allowedValues) ? x.allowedValues.slice() : null,
      min: num(x.min),
      max: num(x.max),
      step: num(x.step),
      max_length: num(x.maxLength),
      required: requiredAlways(x),
      required_with: x.required && x.required.ifDefined && typeof x.required.ifDefined === "object" ? Object.keys(x.required.ifDefined) : [],
      model_types: Array.isArray(x.modelTypes) ? x.modelTypes.slice() : null,
      label: typeof x.label === "string" ? x.label : x.name,
      price_affecting: x.costImpact === true
    });
  }
  var byName = {};
  for (var b = 0; b < parameters.length; b++) byName[parameters[b].name] = parameters[b];
  if (byName.loras && byName.loras.type === "model_array") {
    var scale = byName.lorasScale || {};
    takesLoras = { max: byName.loras.max_length, scale_min: scale.min === undefined ? null : scale.min, scale_max: scale.max === undefined ? null : scale.max, types: byName.loras.model_types || [] };
  }
  var fileByName = {};
  for (var f = 0; f < files.length; f++) fileByName[files[f].name] = files[f];
  var captureInput = null;
  var captureName = null;
  if (fileByName.image) {
    captureInput = "image";
    captureName = "image";
  } else if (facts.capture_input && fileByName[facts.capture_input]) {
    captureInput = fileByName[facts.capture_input].role === "reference" ? "reference" : "image";
    captureName = facts.capture_input;
  }
  var expandRoute = facts.expand_route || null;
  if (!expandRoute && Array.isArray(record.tags) && record.tags.indexOf("expand") >= 0) {
    if (fileByName.image && fileByName.mask) expandRoute = "mask";
    else if (byName.position && byName.position.enum) expandRoute = "position";
    else if (fileByName.image) expandRoute = "exact_size";
  }
  return {
    model_id: id,
    name: typeof record.name === "string" ? record.name : id,
    parameters: parameters,
    file_inputs: files,
    mask_polarity: maskPolarity,
    price_affecting: priceAffecting,
    variable_charge: variableCharge(id),
    takes_loras: takesLoras,
    size_inputs: sizeInputs(inputs, record.uiConfig),
    capture_input: captureInput,
    capture_input_name: captureName,
    expand_route: expandRoute,
    takes_input: byName.numOutputs && byName.numOutputs.type === "number" ? "numOutputs" : null,
    takes_max: byName.numOutputs ? byName.numOutputs.max : null,
    prompt_input: byName.prompt && byName.prompt.type === "string" ? "prompt" : null,
    no_refund: record.disableRefund === true,
    output_max_px: num(facts.output_max_px)
  };
}

// SPEC 6.1 item 6: models whose charge can exceed the quote, as data.
function variableCharge(id) {
  var kinds = ["range", "from"];
  for (var k = 0; k < kinds.length; k++) {
    var list = MAP.price_kinds[kinds[k]] || [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e === id || (e && e.model_id === id)) return { kind: kinds[k], bound_parameter: (e && e.bound_parameter) || null, reason: (e && e.reason) || null };
    }
  }
  return null;
}

// What model_schema returns to agents: the MCP.md 4.2 fields.
function forAgents(s) {
  return {
    model_id: s.model_id,
    name: s.name,
    parameters: s.parameters.map(function (p) {
      return { name: p.name, type: p.type, default: p.default, enum: p.enum, min: p.min, max: p.max, step: p.step, max_length: p.max_length, required: p.required, price_affecting: p.price_affecting };
    }),
    file_inputs: s.file_inputs.map(function (f) {
      return { name: f.name, kind: f.kind, role: f.role, multiple: f.multiple, max: f.max, required: f.required, price_affecting: f.price_affecting };
    }),
    mask_polarity: s.mask_polarity,
    price_affecting: s.price_affecting.slice(),
    variable_charge: s.variable_charge,
    takes_loras: s.takes_loras,
    size_inputs: { kind: s.size_inputs.kind, step: s.size_inputs.step, min: s.size_inputs.min, max: s.size_inputs.max, ratios: s.size_inputs.ratios, sizes: s.size_inputs.sizes.map(function (z) { return { width: z.width, height: z.height }; }) },
    capture_input: s.capture_input,
    expand_route: s.expand_route,
    no_refund: s.no_refund
  };
}

module.exports = { normalize: normalize, forAgents: forAgents, modelFacts: modelFacts };
