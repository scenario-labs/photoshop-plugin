"use strict";
// What the later flows' placements do, as plain data (FLOWS v2, F7 to F10),
// so they are tested under Node; host-more.js carries them out in
// Photoshop, one History state each.
//
// - Split into layers: a group "<source> layers" above the source: the
//   rebuilt background at the source's box, then one layer per element at
//   the place it was found (apply/match.js), the source hidden.
// - Remove text: the clean base as a new layer above the source.
// - Split text: a group "<source> text" above the source: a "Text" layer
//   (a copy of the source masked to where the text was) over the clean
//   base, the source hidden.
// - Select by description: the masks become the document's selection.
// - Formats: the reframed image as an artboard of a "<title> formats"
//   document.
// - Animate: the clip opened as a new document.
// - Frame to layer: the last frame as a layer above the source.
//
// Every layer carries the scenario XMP packet (schema 1); the kind says
// which part it is: "split" (the group), "split-base", "split-element",
// "text-removed", "text", "format", "frame". They are not takes, so the
// Takes card never opens on them; a "split-element" layer has its own
// context in the panel.

var canonical = require("../util/canonical-json.js");
var slugMod = require("../util/slug.js");
var xmp = require("../util/xmp.js");

var HISTORY = {
  split: "Scenario: Split into layers",
  text_remove: "Scenario: Remove text",
  text_split: "Scenario: Split text",
  segment: "Scenario: Select by description",
  reframe: "Scenario: Formats",
  video: "Scenario: Open clip",
  frames: "Scenario: Frame to layer"
};

// The long side the source and the rebuilt background are read at to find
// the elements, and the elements themselves.
var MATCH_READ = 768;
var ELEMENT_READ = 192;
// Split text: a pixel whose color differs from the clean base by more than
// this (mean of the channels, 0 to 255) was text.
var TEXT_DIFF = 32;

function saved(rec) {
  return (rec.outputs || []).filter(function (x) {
    return x && x.path;
  });
}

function boxOf(rec) {
  var t = rec.target || {};
  if (t.box && t.box.length === 4) return { left: t.box[0], top: t.box[1], width: t.box[2], height: t.box[3] };
  var c = t.canvas || [0, 0];
  return { left: 0, top: 0, width: c[0], height: c[1] };
}

// The packet of one layer: the job's facts and the part it is.
function packet(rec, o, kind, extra) {
  var box = boxOf(rec);
  var f = {
    schema: "1",
    jobId: rec.job_id,
    modelId: rec.model_id,
    modelName: rec.model_name,
    prompt: rec.parameters && typeof rec.parameters.prompt === "string" ? rec.parameters.prompt : null,
    parameters: canonical.stringify(rec.parameters || {}),
    inputAssetIds: (rec.inputs && rec.inputs.asset_ids ? rec.inputs.asset_ids : []).join(","),
    cuQuoted: rec.cu_quoted,
    cuCharged: rec.cu_charged,
    createdAt: rec.submitted_at || rec.created_at,
    kind: kind,
    captureBox: [box.left, box.top, box.width, box.height].map(Math.round).join(","),
    origin: rec.origin && rec.origin.kind === "agent" ? ("agent:" + (rec.origin.client_name || "")).slice(0, 64) : "person",
    pluginVersion: (o && o.version) || null
  };
  for (var k in extra || {}) f[k] = extra[k];
  return xmp.build(f);
}

function layerOf(rec, o, out, name, kind, extra) {
  var e = { assetId: out.asset_id };
  for (var k in extra || {}) e[k] = extra[k];
  return { path: out.path, asset_id: out.asset_id, width: out.width || null, height: out.height || null, name: name, xmp: packet(rec, o, kind, e) };
}

// o: { version, source_name (the source layer's name, or null for all
// visible) }
function split(rec, o) {
  o = o || {};
  var outs = saved(rec);
  if (!outs.length) throw new Error("no saved results to place");
  var t = rec.target || {};
  var src = o.source_name || "Image";
  var prompt = rec.parameters && rec.parameters.prompt;
  var label = prompt ? slugMod.slug(prompt) : "";
  var elements = [];
  for (var i = 1; i < outs.length; i++) elements.push(layerOf(rec, o, outs[i], "Element " + i, "split-element", { take: String(i) }));
  return {
    kind: "split",
    history_name: HISTORY.split,
    document_id: t.document_id,
    box: boxOf(rec),
    source_layer_id: t.source === "layer" ? t.layer_id : null,
    hide_source: t.source === "layer" && !!t.layer_id,
    match_read: MATCH_READ,
    element_read: ELEMENT_READ,
    group: { name: src + " layers" + (label ? " " + label : ""), xmp: packet(rec, o, "split", {}) },
    base: layerOf(rec, o, outs[0], "Background", "split-base", {}),
    elements: elements
  };
}

// Remove text and Split text (Ideogram Layerize Text returns the clean base).
function text(rec, o) {
  o = o || {};
  var outs = saved(rec);
  if (!outs.length) throw new Error("no saved results to place");
  var t = rec.target || {};
  var src = o.source_name || "Image";
  var mode = t.mode === "split" ? "split" : "remove";
  var p = {
    kind: "text",
    mode: mode,
    history_name: mode === "split" ? HISTORY.text_split : HISTORY.text_remove,
    document_id: t.document_id,
    box: boxOf(rec),
    source_layer_id: t.source === "layer" ? t.layer_id : null,
    base: layerOf(rec, o, outs[0], mode === "split" ? "Background" : src + " no text", "text-removed", {}),
    hide_source: false
  };
  if (mode === "split") {
    p.group = { name: src + " text", xmp: packet(rec, o, "split", {}) };
    p.text = { name: "Text", xmp: packet(rec, o, "text", {}), threshold: TEXT_DIFF, read: MATCH_READ * 2 };
    p.hide_source = !!p.source_layer_id;
    if (!p.source_layer_id) throw new Error("Split text needs the layer it was read from");
  }
  return p;
}

// The masks (one gray PNG per object, white inside) made one selection.
function segment(rec) {
  var outs = saved(rec);
  var t = rec.target || {};
  return { kind: "segment", history_name: HISTORY.segment, document_id: t.document_id, box: boxOf(rec), masks: outs.map(function (x) { return { path: x.path, width: x.width, height: x.height }; }), text: t.text || "", read: MATCH_READ * 2 };
}

// o: { version, title (the source document's title), formats_document_id
// (an earlier formats document still open) }
function reframe(rec, o) {
  o = o || {};
  var outs = saved(rec);
  if (!outs.length) throw new Error("no saved results to place");
  var t = rec.target || {};
  var out = outs[0];
  var w = out.width || (t.output ? t.output[0] : 0);
  var h = out.height || (t.output ? t.output[1] : 0);
  var title = String(o.title || "Image").replace(/\.[A-Za-z0-9]{2,4}$/, "");
  return {
    kind: "reframe",
    history_name: HISTORY.reframe,
    format: t.format || null,
    size: { width: w, height: h },
    document_name: title + " formats",
    formats_document_id: o.formats_document_id || null,
    artboard_name: (t.format || w + "x" + h) + " " + w + " × " + h,
    layer: layerOf(rec, o, out, title + " " + (t.format || ""), "format", {}),
    gap: 100
  };
}

function video(rec) {
  var outs = saved(rec);
  if (!outs.length) throw new Error("no saved clip to open");
  return { kind: "video", history_name: HISTORY.video, path: outs[0].path, asset_id: outs[0].asset_id, width: outs[0].width || null, height: outs[0].height || null };
}

// The last frame of the clip, over the canvas, above the layer it came
// from.
function frames(rec, o) {
  var outs = saved(rec);
  if (!outs.length) throw new Error("no saved frames to place");
  var t = rec.target || {};
  var last = outs[outs.length - 1];
  return {
    kind: "frames",
    history_name: HISTORY.frames,
    document_id: t.document_id,
    box: boxOf(rec),
    insert_layer_id: t.layer_id || null,
    count: outs.length,
    layer: layerOf(rec, o, last, "Frame " + outs.length + " of the clip", "frame", { take: String(outs.length) })
  };
}

// A w x h image contained in the box, centered (the fit placeFile takes).
function contain(w, h, box) {
  if (!(w > 0 && h > 0)) return { center_x: box.left + box.width / 2, center_y: box.top + box.height / 2, width: box.width, height: box.height };
  var s = Math.min(box.width / w, box.height / h);
  return { center_x: box.left + box.width / 2, center_y: box.top + box.height / 2, width: w * s, height: h * s };
}

// The same, covering the box.
function cover(w, h, box) {
  if (!(w > 0 && h > 0)) return contain(w, h, box);
  var s = Math.max(box.width / w, box.height / h);
  return { center_x: box.left + box.width / 2, center_y: box.top + box.height / 2, width: w * s, height: h * s };
}

// The read size of a box at most `long` on its long side.
function readSize(box, long) {
  var k = Math.min(1, long / Math.max(box.width, box.height));
  return { width: Math.max(1, Math.round(box.width * k)), height: Math.max(1, Math.round(box.height * k)) };
}

// Split text: where the source differs from the clean base, as a gray mask
// (255: text), spread by `grow` pixels so the letters' edges stay.
function textMask(source, base, threshold, grow) {
  var w = source.width;
  var h = source.height;
  var raw = new Uint8Array(w * h);
  for (var i = 0; i < w * h; i++) {
    var a = i * source.components;
    var b = i * base.components;
    var alpha = source.components === 4 ? source.data[a + 3] : 255;
    if (alpha < 128) continue;
    var d = (Math.abs(source.data[a] - base.data[b]) + Math.abs(source.data[a + 1] - base.data[b + 1]) + Math.abs(source.data[a + 2] - base.data[b + 2])) / 3;
    if (d > threshold) raw[i] = 255;
  }
  var out = raw;
  for (var g = 0; g < (grow || 0); g++) {
    var next = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var k = y * w + x;
        if (out[k] || (x > 0 && out[k - 1]) || (x < w - 1 && out[k + 1]) || (y > 0 && out[k - w]) || (y < h - 1 && out[k + w])) next[k] = 255;
      }
    }
    out = next;
  }
  var on = 0;
  for (var j = 0; j < out.length; j++) if (out[j]) on++;
  return { width: w, height: h, components: 1, data: out, fraction: on / (w * h) };
}

// Select by description: the union of the masks read back (gray or RGB,
// white inside), as one gray mask and the number of masks that hold
// anything.
function unionMasks(reads) {
  if (!reads.length) return null;
  var w = reads[0].width;
  var h = reads[0].height;
  var out = new Uint8Array(w * h);
  var objects = 0;
  for (var r = 0; r < reads.length; r++) {
    var m = reads[r];
    var any = false;
    for (var i = 0; i < w * h; i++) {
      var j = i * m.components;
      var v = m.components >= 3 ? Math.round((m.data[j] + m.data[j + 1] + m.data[j + 2]) / 3) : m.data[j];
      if (m.components === 4 || m.components === 2) v = Math.round((v * m.data[j + m.components - 1]) / 255);
      if (v > out[i]) out[i] = v;
      if (v > 127) any = true;
    }
    if (any) objects++;
  }
  return { width: w, height: h, components: 1, data: out, objects: objects };
}

module.exports = {
  split: split,
  text: text,
  segment: segment,
  reframe: reframe,
  video: video,
  frames: frames,
  contain: contain,
  cover: cover,
  readSize: readSize,
  textMask: textMask,
  unionMasks: unionMasks,
  packet: packet,
  HISTORY: HISTORY,
  MATCH_READ: MATCH_READ,
  ELEMENT_READ: ELEMENT_READ
};
