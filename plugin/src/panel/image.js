"use strict";
// The Image lane as a view, like lanes/edit.js: Create image (no document,
// the result opens as a new document at the Size chip's preset), New layer
// from prompt (a canvas-sized layer above the active layer) and Background
// behind it (the same, below the active layer, with that layer as an
// automatic reference). Nothing here reads Photoshop.
//
// imageView(schema, ctx, o) -> { lane: "image", blocked, sizes, size_key,
// out {width, height}, request, refs_max }. o: { action, size (a preset
// key such as "3:2"), prompt (as sent), takes, references (how many),
// insert: "above" | "below", quality: "low" | "medium" | "high" for models
// with a quality input }.

var map = require("../catalog/map.js");
var requests = require("../forms/requests.js");
var commonMod = require("../lanes/common.js");

var ORDER = ["1:1", "3:2", "16:9", "9:16", "2:3", "4:3", "3:4", "4:5", "5:4", "21:9", "9:21"];
var TAKES = [1, 2, 3, 4];
var DEFAULT_SIZE = "3:2";

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

function ratioKey(w, h) {
  var g = gcd(w, h);
  return w / g + ":" + h / g;
}

// The model's size presets, one per aspect (the smallest), in a fixed
// order: [{ key, label, width, height }].
function presets(schema) {
  var si = schema.size_inputs || {};
  if (si.kind !== "grid" || !si.sizes || !si.sizes.length) return [];
  var best = {};
  for (var i = 0; i < si.sizes.length; i++) {
    var s = si.sizes[i];
    if ((si.min && (s.width < si.min || s.height < si.min)) || (si.max && (s.width > si.max || s.height > si.max))) continue;
    var m = /^(\d+:\d+)/.exec(String(s.label || ""));
    var key = m ? m[1] : ratioKey(s.width, s.height);
    if (!best[key] || s.width * s.height < best[key].width * best[key].height) best[key] = { key: key, width: s.width, height: s.height };
  }
  var out = [];
  var keys = Object.keys(best).sort(function (a, b) {
    var ia = ORDER.indexOf(a);
    var ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (var k = 0; k < keys.length; k++) {
    var p = best[keys[k]];
    out.push({ key: p.key, label: p.width + " × " + p.height, width: p.width, height: p.height });
  }
  return out;
}

// The preset nearest in aspect to a box, the smallest first.
function nearest(list, w, h) {
  var want = Math.log(w / h);
  var best = null;
  for (var i = 0; i < list.length; i++) {
    var d = Math.abs(Math.log(list[i].width / list[i].height) - want);
    if (!best || d < best.d - 1e-9) best = { d: d, p: list[i] };
  }
  return best ? best.p : null;
}

function takesFor(schema, wanted) {
  if (!schema.takes_input) return null;
  var max = schema.takes_max || 1;
  return Math.max(1, Math.min(wanted || 1, max, TAKES[TAKES.length - 1]));
}

function imageView(schema, ctx, o) {
  o = o || {};
  var v = { lane: "image", blocked: null, sizes: presets(schema), size_key: null, out: null, request: null, refs_max: null };
  var ref = requests.referenceInput(schema);
  v.refs_max = ref ? (ref.multiple ? ref.max || 10 : 1) : 0;
  var doc = ctx && ctx.doc;
  var params = {};
  var d = map.defaults("image");
  if (d && d.model_id === schema.model_id) for (var k in d.preset) params[k] = d.preset[k];
  if (schema.prompt_input && o.prompt) params[schema.prompt_input] = o.prompt;
  var qp = commonMod.param(schema, "quality");
  if (o.quality && qp && qp.enum && qp.enum.indexOf(o.quality) >= 0) params.quality = o.quality;
  var si = schema.size_inputs || {};
  var target;
  var pick = null;
  if (o.action === "create" || !doc) {
    pick = null;
    for (var i = 0; i < v.sizes.length; i++) if (v.sizes[i].key === (o.size || DEFAULT_SIZE)) pick = v.sizes[i];
    if (!pick) pick = v.sizes[0] || { key: "1:1", width: 1024, height: 1024 };
    target = { kind: "new_document", width: pick.width, height: pick.height };
  } else {
    if (!ctx.layer && o.insert) {
      v.blocked = "Select a layer first.";
      return v;
    }
    pick = nearest(v.sizes, doc.width, doc.height) || { key: "1:1", width: 1024, height: 1024 };
    target = { kind: "canvas", document_id: doc.id, box: [0, 0, doc.width, doc.height] };
    if (ctx.layer && o.insert) {
      target.layer_id = ctx.layer.id;
      target.insert = o.insert;
    }
  }
  v.size_key = pick.key;
  if (si.kind === "grid") {
    params[si.width_input] = pick.width;
    params[si.height_input] = pick.height;
  }
  v.out = target.kind === "new_document" ? { width: pick.width, height: pick.height } : { width: doc.width, height: doc.height };
  if (o.references && v.refs_max === 0) {
    v.blocked = "This model takes no reference images.";
    return v;
  }
  v.request = { lane: "image", model_id: schema.model_id, parameters: params, takes: takesFor(schema, o.takes), target: target, source_size: null, references: o.references || 0 };
  return v;
}

module.exports = { imageView: imageView, presets: presets, nearest: nearest, takesFor: takesFor, DEFAULT_SIZE: DEFAULT_SIZE, TAKES: TAKES };
