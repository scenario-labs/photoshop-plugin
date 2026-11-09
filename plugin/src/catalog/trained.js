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

// The words that call a trained model up in a prompt (its trigger), from
// the model record only: the training's concept prompt, else the record's
// prompt embedding, else one word in capitals that every sample prompt of
// the training carries (measured live 2026-10-20: Scenario's FLUX.2 LoRA
// trainings leave conceptPrompt empty and write the trigger, such as
// "STYLENAMESTYLE", into each sample prompt). Null when none is found;
// nothing is guessed from the name.
var TRIGGER_MAX = 48;
function triggerOf(rec) {
  if (!rec || typeof rec !== "object") return null;
  var p = rec.parameters && typeof rec.parameters === "object" ? rec.parameters : {};
  var clean = function (v) {
    if (typeof v !== "string") return null;
    var t = v.replace(/\s+/g, " ").trim();
    return t && t.length <= TRIGGER_MAX ? t : null;
  };
  var direct = clean(p.conceptPrompt) || clean(rec.promptEmbedding);
  if (direct) return direct;
  var samples = Array.isArray(p.samplePrompts)
    ? p.samplePrompts.filter(function (x) {
        return typeof x === "string" && x;
      })
    : [];
  if (samples.length < 2) return null;
  var first = samples[0].match(/\b[A-Z][A-Z0-9_]{3,}\b/g) || [];
  for (var i = 0; i < first.length; i++) {
    var w = first[i];
    if (w.length > TRIGGER_MAX) continue;
    var re = new RegExp("\\b" + w + "\\b");
    var all = true;
    for (var j = 1; j < samples.length && all; j++) if (!re.test(samples[j])) all = false;
    if (all) return w;
  }
  return null;
}

// What a trained model is for, as its row says it (tags or name): a
// character (a person, a creature, a mascot) or a style. Only a label: both
// run the same way.
function roleOf(row) {
  var words = [row && row.name ? row.name : ""].concat(row && row.tags ? row.tags : []).join(" ");
  return /character|person|portrait|mascot|creature|hero/i.test(words) ? "character" : "style";
}

// The base that runs several trained models at once (SPEC 3.4, stacking):
// the first candidate of the first model that every other model also
// lists, that takes the needed route (edit: an edit route; image: make new)
// and as many LoRAs as there are. ds: derive() results. Returns
// { base_model_id, reason }.
function commonBase(ds, bases, family) {
  if (!ds.length) return { base_model_id: null, reason: null };
  var comps = ds.filter(function (d) {
    return d.trained_kind === "composition";
  });
  if (comps.length && ds.length > 1) return { base_model_id: null, reason: "A composition runs alone: it cannot be combined with another trained model." };
  var first = ds[0].base_model_ids;
  for (var i = 0; i < first.length; i++) {
    var id = first[i];
    var ok = true;
    for (var k = 1; k < ds.length && ok; k++) if (ds[k].base_model_ids.indexOf(id) < 0) ok = false;
    if (!ok) continue;
    var b = null;
    for (var j = 0; j < bases.length; j++) if (bases[j].model_id === id) b = bases[j];
    if (!b) continue;
    if (family === "edit" && !editRoute(b)) continue;
    if (family === "image" && makeNew(b) === false) continue;
    if (ds.length > 1 && (!b.takes_loras || b.takes_loras.max < ds.length)) continue;
    return { base_model_id: id, reason: null };
  }
  return { base_model_id: null, reason: ds.length > 1 ? "These trained models have no base model in common, so they cannot run together." : family === "edit" ? "This trained model's base cannot edit an image." : "This trained model's base cannot make a new image." };
}

// "LoRA via FLUX.2 Dev"
function kindLabel(d) {
  if (!d.supported) return "This trained model type isn't supported by this version of the plugin.";
  return (d.trained_kind === "lora" ? "LoRA" : "Composition") + " via " + d.base_names[0];
}

module.exports = { derive: derive, editRoute: editRoute, makeNew: makeNew, kindLabel: kindLabel, defaultScale: defaultScale, triggerOf: triggerOf, roleOf: roleOf, commonBase: commonBase };
