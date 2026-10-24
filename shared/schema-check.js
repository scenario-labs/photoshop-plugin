"use strict";
// A small JSON Schema checker for the subset the shared definitions use:
// type (string or list), const, enum, properties, required, additionalProperties
// (false or a schema), items, minLength, maxLength, minimum, maximum, and local $ref
// ("#/definitions/<name>"). Runs in Node and in UXP. Returns a list of problems;
// an empty list means the value conforms.

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(expected, actual) {
  if (expected === actual) return true;
  if (expected === "number" && actual === "integer") return true;
  return false;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function resolveRef(ref, root) {
  var prefix = "#/definitions/";
  if (typeof ref !== "string" || ref.indexOf(prefix) !== 0) return null;
  var name = ref.slice(prefix.length);
  var defs = root && root.definitions;
  if (!defs || !Object.prototype.hasOwnProperty.call(defs, name)) return null;
  return defs[name];
}

function check(schema, value, path, root, out) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    out.push(path + ": not allowed");
    return;
  }
  if (schema.$ref) {
    var target = resolveRef(schema.$ref, root);
    if (!target) {
      out.push(path + ": unknown reference " + schema.$ref);
      return;
    }
    check(target, value, path, root, out);
    return;
  }
  var actual = typeOf(value);
  if (schema.type !== undefined) {
    var types = Array.isArray(schema.type) ? schema.type : [schema.type];
    var ok = false;
    for (var i = 0; i < types.length; i++) {
      if (typeMatches(types[i], actual)) ok = true;
    }
    if (!ok) {
      out.push(path + ": expected " + types.join(" or ") + ", got " + actual);
      return;
    }
  }
  if (schema.const !== undefined && !sameJson(schema.const, value)) {
    out.push(path + ": must be " + JSON.stringify(schema.const));
  }
  if (schema.enum !== undefined) {
    var found = false;
    for (var e = 0; e < schema.enum.length; e++) {
      if (sameJson(schema.enum[e], value)) found = true;
    }
    if (!found) out.push(path + ": must be one of " + JSON.stringify(schema.enum));
  }
  if (actual === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(path + ": shorter than " + schema.minLength);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(path + ": longer than " + schema.maxLength);
  }
  if ((actual === "integer" || actual === "number") && schema.minimum !== undefined && value < schema.minimum) {
    out.push(path + ": below " + schema.minimum);
  }
  if ((actual === "integer" || actual === "number") && schema.maximum !== undefined && value > schema.maximum) {
    out.push(path + ": above " + schema.maximum);
  }
  if (actual === "object") {
    var props = schema.properties || {};
    var req = schema.required || [];
    for (var r = 0; r < req.length; r++) {
      if (!Object.prototype.hasOwnProperty.call(value, req[r])) out.push(path + ": missing " + req[r]);
    }
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var sub = path + "." + key;
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        check(props[key], value[key], sub, root, out);
      } else if (schema.additionalProperties === false) {
        out.push(sub + ": not allowed");
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        check(schema.additionalProperties, value[key], sub, root, out);
      }
    }
  }
  if (actual === "array" && schema.items !== undefined) {
    for (var a = 0; a < value.length; a++) check(schema.items, value[a], path + "[" + a + "]", root, out);
  }
}

function validate(schema, value, root) {
  var out = [];
  check(schema, value, "$", root || schema, out);
  return out;
}

module.exports = { validate: validate, typeOf: typeOf };
