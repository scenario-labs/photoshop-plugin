"use strict";
// The batchPlay allow-list check of SPEC 6.6 and MCP.md 4.7. Pure: no
// Photoshop, so every case runs under Node. The plugin calls check() before
// the modal scope, and again inside it right before batchPlay (the document
// ids it reads can change in between).
//
// check(descriptors, ctx) returns the descriptors to play (copies, dialogs
// forced off, agent file paths swapped for the host's file references), or
// throws CommandRefused naming the descriptor's index and the reason.
// ctx: {
//   document_id: the target, which the caller has checked is active,
//   has(cls, id) -> true when a layer, channel or path of that id belongs to
//     the target (contentLayer and adjustmentLayer are layers),
//   file(path) -> { ok: true, ref } | { ok: false, reason }: the caller's
//     check of an agent file path (temp folder, capture of this document in
//     this Photoshop session, no symlink); ref replaces the path value }
//
// strip(result) removes the path values and path-carrying properties from
// get results (rule 6); cap(results) bounds them to 64 KB.

var ALLOW = require("../../../shared/batchplay-allow.json");

var FORMS = ["_id", "_index", "_name", "_offset", "_enum"];
var ELEMENT_KEYS = ["_ref", "_id", "_index", "_name", "_offset", "_enum", "_value", "_property"];
var CODE_KEYS = ["_obj", "_ref", "_class", "_enum", "_value"];
var DIALOG_OK = ["dontDisplay", "silent"];

function has(list, v) {
  return list.indexOf(v) >= 0;
}

function refused(index, reason) {
  var e = new Error("descriptor " + index + ": " + reason);
  e.type = "CommandRefused";
  e.index = index;
  return e;
}

function isPlain(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// An element of a reference chain: an object with _ref or _property and no
// _obj (an _obj object is a descriptor value, not a reference).
function isElement(v) {
  // { _ref: [chain] } is a reference wrapper, not an element.
  if (!isPlain(v) || Object.prototype.hasOwnProperty.call(v, "_obj") || Array.isArray(v._ref)) return false;
  return Object.prototype.hasOwnProperty.call(v, "_ref") || Object.prototype.hasOwnProperty.call(v, "_property");
}

function isChain(v) {
  if (!Array.isArray(v) || !v.length) return false;
  for (var i = 0; i < v.length; i++) if (!isElement(v[i])) return false;
  return true;
}

function copy(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// Rule 2: one reference chain. where: { event, key ("_target", "null" or
// another key), top (the chain sits directly under the descriptor) }.
function checkChain(chain, where, ctx, index) {
  var classes = 0;
  var docs = 0;
  for (var i = 0; i < chain.length; i++) {
    var e = chain[i];
    for (var k in e) {
      if (!Object.prototype.hasOwnProperty.call(e, k)) continue;
      if (k.charAt(0) === "$" || (typeof e[k] === "string" && e[k].charAt(0) === "$")) throw refused(index, "four-character codes are refused: use string ids");
      if (!has(ELEMENT_KEYS, k)) throw refused(index, "reference key " + k + " is not accepted");
    }
    if (Object.prototype.hasOwnProperty.call(e, "_property")) {
      // A property element: _property and at most its class.
      for (var pk in e) if (pk !== "_property" && pk !== "_ref") throw refused(index, "a property element carries only _property and _ref");
      if (typeof e._property !== "string") throw refused(index, "_property must be a string id");
      if (e._ref !== undefined && e._ref !== "property" && !has(ALLOW.classes, e._ref)) throw refused(index, "class " + String(e._ref) + " is not on the list");
      if (e._ref === "document") docs++;
      if (e._ref !== undefined && e._ref !== "property") classes++;
      continue;
    }
    var cls = e._ref;
    if (typeof cls !== "string") throw refused(index, "_ref must be a string id");
    if (!has(ALLOW.classes, cls)) throw refused(index, "class " + cls + " is not on the list");
    classes++;
    var forms = FORMS.filter(function (f) {
      return Object.prototype.hasOwnProperty.call(e, f);
    });
    if (Object.prototype.hasOwnProperty.call(e, "_value") && forms.indexOf("_enum") < 0) throw refused(index, "_value comes only with _enum");
    if (forms.length > 1) throw refused(index, "a reference element has exactly one form key (" + forms.join(" and ") + " given)");
    if (!forms.length) {
      // Adobe's make shape: the class the make creates.
      if (where.event === "make" && where.top && (where.key === "_target" || where.key === "null") && has(ALLOW.make_classes, cls) && chain.length === 1) continue;
      throw refused(index, "a class element with no form key is accepted only as the class a make creates");
    }
    var form = forms[0];
    if (cls === "document") {
      docs++;
      if (form === "_id") {
        if (e._id !== ctx.document_id) throw refused(index, "a document element names only the target document");
      } else if (form === "_enum") {
        if (e._enum !== "ordinal" || (e._value !== undefined && e._value !== "targetEnum")) throw refused(index, "a document element names only the target document");
      } else {
        throw refused(index, "a document by " + form + " can name another document");
      }
      continue;
    }
    if (form === "_id") {
      if (typeof e._id !== "number" || !ctx.has(cls, e._id)) throw refused(index, cls + " " + String(e._id) + " is not in the target document");
    }
  }
  if (!classes) throw refused(index, "a chain of _property elements with no class resolves from the application");
  if (docs > 1) throw refused(index, "a reference names a second document");
  if (where.top && (where.key === "_target" || where.key === "null") && chain[0]._ref === "document" && chain[0]._property === undefined) {
    if (where.event === "select") throw refused(index, "select of a document is refused");
    if (where.event === "make" || where.event === "duplicate" || where.event === "delete" || where.event === "close") throw refused(index, where.event + " of a document is refused");
  }
}

// Every value of a descriptor, depth first.
function walk(value, where, ctx, index, depth) {
  if (depth > 64) throw refused(index, "the descriptor is nested too deeply");
  if (Array.isArray(value)) {
    if (isChain(value)) {
      checkChain(value, where, ctx, index);
      return value;
    }
    var outA = [];
    for (var i = 0; i < value.length; i++) outA.push(walk(value[i], { event: where.event, key: where.key, top: false }, ctx, index, depth + 1));
    return outA;
  }
  if (!isPlain(value)) {
    if (typeof value === "string" && value.charAt(0) === "$" && has(CODE_KEYS, where.key)) throw refused(index, "four-character codes are refused: use string ids");
    return value;
  }
  // A single element, or a reference wrapper { _ref: [chain] }.
  if (isElement(value)) {
    checkChain([value], where, ctx, index);
    return value;
  }
  if (Object.prototype.hasOwnProperty.call(value, "_ref") && Array.isArray(value._ref)) {
    for (var wk in value) if (wk !== "_ref") throw refused(index, "a reference carries only its chain");
    if (!isChain(value._ref)) throw refused(index, "a reference holds only reference elements");
    checkChain(value._ref, where, ctx, index);
    return value;
  }
  var out = {};
  for (var k in value) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
    if (k.charAt(0) === "$") throw refused(index, "four-character codes are refused: use string ids");
    var v = value[k];
    if (has(CODE_KEYS, k) && typeof v === "string" && v.charAt(0) === "$") throw refused(index, "four-character codes are refused: use string ids");
    if (k === "_path") {
      var f = ctx.file ? ctx.file(v) : { ok: false, reason: "file paths are not accepted here" };
      if (!f || !f.ok) throw refused(index, "file path refused: " + ((f && f.reason) || "outside the plugin's capture folder"));
      out[k] = f.ref;
      continue;
    }
    if (k === "_obj" && typeof v === "string" && (has(ALLOW.refused_events, v) || v === "document")) throw refused(index, v + " is always refused");
    if (k === "_class" && v === "document") throw refused(index, "a command that creates a document is refused");
    out[k] = walk(v, { event: where.event, key: k, top: false }, ctx, index, depth + 1);
  }
  return out;
}

function check(descriptors, ctx) {
  if (!Array.isArray(descriptors) || !descriptors.length) throw refused(0, "descriptors must be a non-empty array");
  if (descriptors.length > ALLOW.max_descriptors) throw refused(ALLOW.max_descriptors, "at most " + ALLOW.max_descriptors + " descriptors per call");
  var out = [];
  for (var i = 0; i < descriptors.length; i++) {
    var d = descriptors[i];
    if (!isPlain(d) || typeof d._obj !== "string") throw refused(i, "a descriptor is an object with an _obj event");
    var ev = d._obj;
    if (has(ALLOW.refused_events, ev)) throw refused(i, ev + " is always refused");
    if (ev.charAt(0) === "$" && !has(ALLOW.events, ev)) throw refused(i, "four-character codes are refused: use string ids");
    if (!has(ALLOW.events, ev)) throw refused(i, ev + " is not on the allow-list");
    var body = {};
    for (var k in d) {
      if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
      if (k === "_obj") continue;
      if (k === "_options") {
        var opt = d._options;
        if (!isPlain(opt)) throw refused(i, "_options must be an object");
        for (var ok in opt) {
          if (ok !== "dialogOptions") throw refused(i, "_options accepts only dialogOptions");
          if (!has(DIALOG_OK, opt[ok])) throw refused(i, "dialogs are refused: dialogOptions must be dontDisplay");
        }
        continue;
      }
      if (k === "_isCommand" || k === "interactive") throw refused(i, k + " is refused");
      if (k.charAt(0) === "$") throw refused(i, "four-character codes are refused: use string ids");
      var v = d[k];
      if (has(CODE_KEYS, k) && typeof v === "string" && v.charAt(0) === "$") throw refused(i, "four-character codes are refused: use string ids");
      if ((k === "_target" || k === "null") && !(isChain(v) || isElement(v) || (isPlain(v) && (Array.isArray(v._ref) || Object.prototype.hasOwnProperty.call(v, "_path"))))) {
        throw refused(i, k + " must be a reference");
      }
      body[k] = walk(copy(v), { event: ev, key: k, top: true }, ctx, i, 1);
    }
    // A make whose new object is a document creates one.
    if (ev === "make" && body["new"] && isPlain(body["new"]) && (body["new"]._obj === "document" || body["new"]._class === "document")) throw refused(i, "a command that creates a document is refused");
    var outD = { _obj: ev };
    for (var bk in body) outD[bk] = body[bk];
    outD._options = { dialogOptions: "dontDisplay" };
    out.push(outD);
  }
  return out;
}

// Rule 6: get results lose path values and the properties that can record
// paths, at any depth.
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (!isPlain(value)) return value;
  var out = {};
  for (var k in value) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
    if (has(ALLOW.get_strip, k)) continue;
    out[k] = strip(value[k]);
  }
  return out;
}

// Results capped at 64 KB in total: later results are replaced by a marker.
function cap(results) {
  var out = [];
  var used = 2;
  var cut = false;
  for (var i = 0; i < results.length; i++) {
    var text = JSON.stringify(results[i] === undefined ? null : results[i]);
    if (!cut && used + text.length + 1 <= ALLOW.max_result_bytes) {
      out.push(results[i] === undefined ? null : results[i]);
      used += text.length + 1;
    } else {
      cut = true;
      out.push({ _truncated: true });
    }
  }
  return { results: out, truncated: cut };
}

module.exports = { check: check, strip: strip, cap: cap, ALLOW: ALLOW };
