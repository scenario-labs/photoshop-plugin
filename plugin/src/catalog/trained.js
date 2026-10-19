"use strict";
// Trained models (SPEC 3.4): a trained model is never the model called. Its
// bases come from the catalog: models whose `loras` or `modelId` input lists
// the trained model's type in `modelTypes`. A LoRA when a `loras` input lists
// the type; a composition when only a `modelId` input does. Each record and
// each base's schema decide; nothing is guessed for an unknown type.

var MAP = require("../../../shared/catalog-map.json");

function param(schema, name) {
  for (var i = 0; i < schema.parameters.length; i++) if (schema.parameters[i].name === name) return schema.parameters[i];
  return null;
}

function file(schema, name) {
  for (var i = 0; i < schema.file_inputs.length; i++) if (schema.file_inputs[i].name === name) return schema.file_inputs[i];
  return null;
}

function lists(p, type) {
  return !!(p && Array.isArray(p.model_types) && p.model_types.indexOf(type) >= 0);
}

// How a base edits (SPEC 3.4, first match): image plus strength, reference
// images, a mask input, or none.
function editRoute(base) {
  if (file(base, "image") && param(base, "strength")) return "image_strength";
  if (base.capture_input === "reference") return "reference";
  for (var i = 0; i < base.file_inputs.length; i++) if (base.file_inputs[i].role === "mask") return "mask";
  return null;
}

function makeNew(base) {
  for (var i = 0; i < base.file_inputs.length; i++) {
    var f = base.file_inputs[i];
    if (f.required && f.role === "reference") return "needs_reference";
    if (f.required) return false;
  }
  return true;
}

function defaultScale(row) {
  for (var i = 0; i < row.concepts.length; i++) if (row.concepts[i].modelId === row.id) return row.concepts[i].scale;
  return MAP.trained.default_scale;
}

// row: a catalog display row whose type is not custom. bases: normalized
// schemas of the probed bases (catalog.baseSchemas()).
function derive(row, bases) {
  var loraBases = [];
  var compBases = [];
  for (var i = 0; i < bases.length; i++) {
    var b = bases[i];
    if (lists(param(b, "loras"), row.type)) loraBases.push(b);
    else if (lists(param(b, "modelId"), row.type)) compBases.push(b);
  }
  var kind = loraBases.length ? "lora" : compBases.length ? "composition" : null;
  var candidates = kind === "lora" ? loraBases : compBases;
  // compliantModelIds (base names) orders the candidates through the name map.
  var preferred = [];
  for (var c = 0; c < row.compliant.length; c++) {
    var id = Object.prototype.hasOwnProperty.call(MAP.trained.base_names, row.compliant[c]) ? MAP.trained.base_names[row.compliant[c]] : null;
    if (id && preferred.indexOf(id) < 0) preferred.push(id);
  }
  candidates.sort(function (a, b) {
    var pa = preferred.indexOf(a.model_id);
    var pb = preferred.indexOf(b.model_id);
    pa = pa < 0 ? preferred.length : pa;
    pb = pb < 0 ? preferred.length : pb;
    if (pa !== pb) return pa - pb;
    return MAP.trained.base_probes.indexOf(a.model_id) - MAP.trained.base_probes.indexOf(b.model_id);
  });
  var first = candidates[0] || null;
  var lanes = [];
  var mk = first ? makeNew(first) : false;
  var route = first ? editRoute(first) : null;
  if (first && mk !== false) lanes.push("image");
  if (route) lanes.push("edit");
  return {
    trained: true,
    public: !row.project,
    trained_type: row.type,
    trained_kind: kind,
    base_model_ids: candidates.map(function (s) {
      return s.model_id;
    }),
    base_names: candidates.map(function (s) {
      return s.name;
    }),
    default_scale: defaultScale(row),
    max_loras: kind === "lora" && first && first.takes_loras ? first.takes_loras.max : null,
    make_new: mk,
    edit_route: route,
    supported: candidates.length > 0,
    lanes: lanes
  };
}

// "LoRA via FLUX.2 Dev"
function kindLabel(d) {
  if (!d.supported) return "This trained model type isn't supported by this version of the plugin.";
  return (d.trained_kind === "lora" ? "LoRA" : "Composition") + " via " + d.base_names[0];
}

module.exports = { derive: derive, editRoute: editRoute, makeNew: makeNew, kindLabel: kindLabel, defaultScale: defaultScale };
