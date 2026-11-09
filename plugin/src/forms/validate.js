"use strict";
// Parameters are validated against the model's schema before any price
// check (SPEC 6.1 item 2): names, types, enums, ranges, required inputs. Dry
// runs accepted unknown names, off-grid sizes and wrongly typed values and
// priced them (measured live 2026-10-19), so a typo would be priced and then
// run with defaults; this check refuses it first.

var errorsMod = require("../scenario/errors.js");

var MODEL_ID = /^model_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var ASSET_ID = /^asset_[A-Za-z0-9_-]{1,128}$/;
// SPEC 6.1 item 1: its fee is charged even on a dry run (documented).
var REFUSED = { ipDetection: "ipDetection is not accepted: its fee is charged even on a price check." };

function isPlain(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function isNumber(v) {
  return typeof v === "number" && isFinite(v);
}

function checkNumber(p, v, label) {
  if (!isNumber(v)) return label + " must be a number.";
  if (p.min !== null && v < p.min) return label + " must be at least " + p.min + ".";
  if (p.max !== null && v > p.max) return label + " must be at most " + p.max + ".";
  // Integer steps are checked; fractional steps (0.01, 0.05) are not.
  if (p.step !== null && p.step >= 1 && p.step % 1 === 0) {
    if (v % 1 !== 0) return label + " must be a whole number.";
    if (p.step >= 2 && v % p.step !== 0) return label + " must be a multiple of " + p.step + ".";
  }
  return null;
}

function checkParam(p, v) {
  var label = p.name;
  switch (p.type) {
    case "string":
      if (typeof v !== "string") return label + " must be text.";
      if (p.enum && p.enum.indexOf(v) < 0) return label + " must be one of: " + p.enum.join(", ") + ".";
      if (p.max_length !== null && v.length > p.max_length) return label + " is longer than " + p.max_length + " characters.";
      return null;
    case "number":
      if (p.enum && p.enum.indexOf(v) < 0) return label + " must be one of: " + p.enum.join(", ") + ".";
      return checkNumber(p, v, label);
    case "boolean":
      return typeof v === "boolean" ? null : label + " must be true or false.";
    case "model":
      if (v === "") return null;
      return typeof v === "string" && MODEL_ID.test(v) ? null : label + " must be a Scenario model id.";
    case "model_array":
      if (!Array.isArray(v)) return label + " must be a list of model ids.";
      if (p.max_length !== null && v.length > p.max_length) return label + " takes at most " + p.max_length + " models.";
      for (var i = 0; i < v.length; i++) if (typeof v[i] !== "string" || !MODEL_ID.test(v[i])) return label + " must be a list of model ids.";
      return null;
    case "number_array":
      if (!Array.isArray(v)) return label + " must be a list of numbers.";
      for (var j = 0; j < v.length; j++) {
        var bad = checkNumber({ min: p.min, max: p.max, step: null }, v[j], label + "[" + j + "]");
        if (bad) return bad;
      }
      return null;
    case "string_array":
      if (!Array.isArray(v)) return label + " must be a list of texts.";
      for (var k = 0; k < v.length; k++) if (typeof v[k] !== "string") return label + " must be a list of texts.";
      return null;
    default:
      return null;
  }
}

function checkFile(f, v) {
  if (f.multiple) {
    if (!Array.isArray(v)) return f.name + " must be a list of asset ids.";
    if (f.max !== null && v.length > f.max) return f.name + " takes at most " + f.max + " images.";
    for (var i = 0; i < v.length; i++) if (typeof v[i] !== "string" || !ASSET_ID.test(v[i])) return f.name + " must be a list of asset ids.";
    return null;
  }
  return typeof v === "string" && ASSET_ID.test(v) ? null : f.name + " must be an asset id.";
}

// schema: forms/schema.js normalize(). params: { name: value }; null means
// omitted. pending: { inputName: count } for file inputs the lane fills
// (the capture, the mask, the source) that the person has not uploaded yet.
// Returns a list of problems, empty when the parameters are valid.
function problems(schema, params, pending) {
  pending = pending || {};
  var out = [];
  if (!isPlain(params)) return ["parameters must be an object."];
  var byName = {};
  var all = [];
  for (var i = 0; i < schema.parameters.length; i++) {
    byName[schema.parameters[i].name] = { kind: "param", def: schema.parameters[i] };
    all.push(schema.parameters[i]);
  }
  for (var f = 0; f < schema.file_inputs.length; f++) {
    byName[schema.file_inputs[f].name] = { kind: "file", def: schema.file_inputs[f] };
    all.push(schema.file_inputs[f]);
  }
  var given = {};
  for (var name in params) {
    if (!Object.prototype.hasOwnProperty.call(params, name)) continue;
    var v = params[name];
    if (v === null || v === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(REFUSED, name)) {
      out.push(REFUSED[name]);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(byName, name)) {
      out.push(name + " is not a parameter of this model.");
      continue;
    }
    var entry = byName[name];
    var bad = entry.kind === "file" ? checkFile(entry.def, v) : checkParam(entry.def, v);
    if (bad) out.push(bad);
    given[name] = true;
  }
  for (var a = 0; a < all.length; a++) {
    var d = all[a];
    var present = given[d.name] || (pending[d.name] || 0) > 0;
    if (present) continue;
    if (d.required) {
      out.push(d.name === "prompt" ? "Prompt is required by this model." : d.name + " is required by this model.");
      continue;
    }
    for (var r = 0; r < d.required_with.length; r++) {
      var other = d.required_with[r];
      if (given[other] || (pending[other] || 0) > 0) {
        out.push(d.name + " is required when " + other + " is given.");
        break;
      }
    }
  }
  return out;
}

function assertValid(schema, params, pending) {
  var list = problems(schema, params, pending);
  if (list.length) throw new errorsMod.ScenarioError("InvalidParameter", list.slice(0, 3).join(" "));
}

module.exports = { problems: problems, assertValid: assertValid, MODEL_ID: MODEL_ID, ASSET_ID: ASSET_ID };
