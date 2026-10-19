"use strict";
// Capture geometry (SPEC 3.8, 5.5, 5.8), as plain arithmetic so it is tested
// under Node:
// - the margin around a selection (auto: half the long side, at least 64 px;
//   or 64 px; or none) and the context box, clipped to the canvas;
// - shaping the box to the model's size inputs: a grid (each axis rounded up
//   at upload scale), a ratio enum (the nearest ratio, one axis grown, then
//   the smallest resolution that covers the box), a fixed list of sizes, or
//   none. The box grows evenly around its center, shifts to stay inside the
//   canvas, and only when the canvas is too small is the excess padded;
// - Expand: the new canvas from an aspect preset or per-side pixels and an
//   anchor, and the bands the mask route edits.
// Boxes are { left, top, width, height } in document pixels.

var MIN_MARGIN = 64;
var ANCHORS = ["top-left", "top", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom", "bottom-right"];
var PRESETS = ["1:1", "4:5", "3:2", "2:3", "16:9", "9:16"];

function marginPx(sel, mode) {
  if (mode === "none") return 0;
  if (mode === "64") return MIN_MARGIN;
  return Math.max(MIN_MARGIN, Math.round(Math.max(sel.width, sel.height) / 2));
}

function clip(box, canvas) {
  var left = Math.max(0, box.left);
  var top = Math.max(0, box.top);
  var right = Math.min(canvas.width, box.left + box.width);
  var bottom = Math.min(canvas.height, box.top + box.height);
  if (right <= left || bottom <= top) return null;
  return { left: left, top: top, width: right - left, height: bottom - top };
}

// The selection plus the margin on each side, within the canvas.
function contextBox(sel, margin, canvas) {
  return clip({ left: sel.left - margin, top: sel.top - margin, width: sel.width + 2 * margin, height: sel.height + 2 * margin }, canvas);
}

// One axis of growBox: a span [start, start + size) grown to `want` evenly
// around its center, shifted inside [0, limit), centered on the canvas when
// the canvas is shorter than `want` (the excess is padded).
function growAxis(start, size, want, limit) {
  if (want <= size) return start;
  if (want >= limit) return -Math.floor((want - limit) / 2);
  var s = start - Math.floor((want - size) / 2);
  if (s < 0) s = 0;
  if (s + want > limit) s = limit - want;
  return s;
}

function growBox(box, width, height, canvas) {
  return { left: growAxis(box.left, box.width, width, canvas.width), top: growAxis(box.top, box.height, height, canvas.height), width: width, height: height };
}

// The parts of a box outside the canvas, in document pixels.
function padOf(box, canvas) {
  return {
    left: Math.max(0, -box.left),
    top: Math.max(0, -box.top),
    right: Math.max(0, box.left + box.width - canvas.width),
    bottom: Math.max(0, box.top + box.height - canvas.height)
  };
}

function parseRatio(v) {
  var m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(v));
  if (!m) return null;
  var r = Number(m[1]) / Number(m[2]);
  return r > 0 && isFinite(r) ? r : null;
}

// "1K" = 1024 px on the long side; plain numbers are pixels.
function parseResolution(v) {
  var s = String(v);
  var k = /^(\d+(?:\.\d+)?)K$/i.exec(s);
  if (k) return Math.round(Number(k[1]) * 1024);
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

function nearestRatio(ratios, width, height) {
  var want = Math.log(width / height);
  var best = null;
  for (var i = 0; i < ratios.length; i++) {
    var r = parseRatio(ratios[i]);
    if (!r) continue;
    var d = Math.abs(Math.log(r) - want);
    if (!best || d < best.d - 1e-9) best = { d: d, value: ratios[i], ratio: r };
  }
  return best;
}

// Shapes a box to a model's size inputs (forms/schema.js size_inputs).
// o: { max_long (the capture's long side cap), resolutions (the values of a
// `resolution` enum, ratio models) }. Returns { kind, box, upload: {width,
// height} (pixels sent), scale (upload px per document px), params (the size
// inputs to send), pad }.
function shape(box, canvas, si, o) {
  o = o || {};
  var cap = o.max_long || 2048;
  var long = Math.max(box.width, box.height);
  var kind = si && si.kind ? si.kind : "none";
  var out;
  if (kind === "grid") {
    if (si.max) cap = Math.min(cap, si.max);
    var s = long > cap ? cap / long : 1;
    var step = si.step || 1;
    var axis = function (v) {
      var n = Math.ceil(Math.max(1, Math.round(v * s * 1000) / 1000) / step) * step;
      if (si.max) while (n > si.max) n -= step;
      if (si.min && n < si.min) n = Math.ceil(si.min / step) * step;
      return n;
    };
    var uw = axis(box.width);
    var uh = axis(box.height);
    var bw = Math.max(box.width, Math.round(uw / s));
    var bh = Math.max(box.height, Math.round(uh / s));
    var grown = growBox(box, bw, bh, canvas);
    var params = {};
    params[si.width_input] = uw;
    params[si.height_input] = uh;
    out = { kind: "grid", box: grown, upload: { width: uw, height: uh }, params: params };
  } else if (kind === "ratio_enum" && si.ratios && si.ratios.length) {
    var pick = nearestRatio(si.ratios, box.width, box.height);
    if (!pick) return shape(box, canvas, { kind: "none" }, o);
    var w = box.width;
    var h = box.height;
    if (pick.ratio > w / h) w = Math.round(h * pick.ratio);
    else h = Math.round(w / pick.ratio);
    var g = growBox(box, w, h, canvas);
    var p2 = { aspectRatio: pick.value };
    var target = Math.min(Math.max(w, h), cap);
    var resList = (o.resolutions || [])
      .map(function (v) {
        return { value: v, px: parseResolution(v) };
      })
      .filter(function (x) {
        return x.px;
      })
      .sort(function (a, b) {
        return a.px - b.px;
      });
    var longSide = Math.min(Math.max(w, h), cap);
    if (resList.length) {
      var res = resList[resList.length - 1];
      for (var i = 0; i < resList.length; i++) {
        if (resList[i].px >= target) {
          res = resList[i];
          break;
        }
      }
      p2.resolution = res.value;
      longSide = res.px;
    }
    var k = longSide / Math.max(w, h);
    out = { kind: "ratio_enum", box: g, upload: { width: Math.round(w * k), height: Math.round(h * k) }, params: p2 };
  } else if (si && si.sizes && si.sizes.length) {
    var best = null;
    var want = Math.log(box.width / box.height);
    for (var j = 0; j < si.sizes.length; j++) {
      var z = si.sizes[j];
      var d = Math.abs(Math.log(z.width / z.height) - want);
      if (!best || d < best.d - 1e-9) best = { d: d, list: [z] };
      else if (Math.abs(d - best.d) <= 1e-9) best.list.push(z);
    }
    best.list.sort(function (a, b) {
      return a.width * a.height - b.width * b.height;
    });
    var sz = best.list[best.list.length - 1];
    for (var q = 0; q < best.list.length; q++) {
      if (Math.max(best.list[q].width, best.list[q].height) >= Math.min(long, cap)) {
        sz = best.list[q];
        break;
      }
    }
    var fw = box.width;
    var fh = box.height;
    if (sz.width / sz.height > fw / fh) fw = Math.round(fh * (sz.width / sz.height));
    else fh = Math.round(fw / (sz.width / sz.height));
    out = { kind: "sizes", box: growBox(box, fw, fh, canvas), upload: { width: sz.width, height: sz.height }, params: {} };
    if (si.width_input) {
      out.params[si.width_input] = sz.width;
      out.params[si.height_input] = sz.height;
    }
  } else {
    var s3 = long > cap ? cap / long : 1;
    out = { kind: "none", box: { left: box.left, top: box.top, width: box.width, height: box.height }, upload: { width: Math.max(1, Math.round(box.width * s3)), height: Math.max(1, Math.round(box.height * s3)) }, params: {} };
  }
  out.scale = out.upload.width / out.box.width;
  out.pad = padOf(out.box, canvas);
  return out;
}

// The context of a selection edit: margin, context box, shaped box.
// sel: the selection bounds (clipped to the canvas by the caller).
function editCapture(sel, canvas, si, o) {
  var margin = marginPx(sel, o.margin);
  var ctx = contextBox(sel, margin, canvas);
  var shaped = shape(ctx, canvas, si, o);
  return { margin: margin, context: ctx, shaped: shaped };
}

// ---- Expand ----

function anchorOffset(anchor, oldSize, newSize) {
  var a = ANCHORS.indexOf(anchor) >= 0 ? anchor : "center";
  var col = /left$/.test(a) ? 0 : /right$/.test(a) ? 2 : 1;
  var row = /^top/.test(a) ? 0 : /^bottom/.test(a) ? 2 : 1;
  var fx = [0, 0.5, 1][col];
  var fy = [0, 0.5, 1][row];
  return { x: Math.round((newSize.width - oldSize.width) * fx), y: Math.round((newSize.height - oldSize.height) * fy) };
}

// The new canvas. o: { mode: "aspect" | "sides", ratio: "4:5" or {width,
// height} (Custom), anchor, sides: {left, top, right, bottom} }. The aspect
// mode grows one axis and never shrinks. Returns { width, height, offset:
// {x, y} (where the current image sits), sides } or null when nothing grows.
function expandCanvas(doc, o) {
  var w = doc.width;
  var h = doc.height;
  if (o.mode === "sides") {
    var sd = o.sides || {};
    var l = Math.max(0, Math.round(sd.left || 0));
    var t = Math.max(0, Math.round(sd.top || 0));
    var r = Math.max(0, Math.round(sd.right || 0));
    var b = Math.max(0, Math.round(sd.bottom || 0));
    if (!(l || t || r || b)) return null;
    return { width: w + l + r, height: h + t + b, offset: { x: l, y: t }, sides: { left: l, top: t, right: r, bottom: b } };
  }
  var ratio = typeof o.ratio === "object" && o.ratio ? o.ratio.width / o.ratio.height : parseRatio(o.ratio);
  if (!ratio) return null;
  var W = w;
  var H = h;
  if (ratio > w / h) W = Math.round(h * ratio);
  else H = Math.round(w / ratio);
  if (W === w && H === h) return null;
  var off = anchorOffset(o.anchor, { width: w, height: h }, { width: W, height: H });
  return { width: W, height: H, offset: off, sides: { left: off.x, top: off.y, right: W - w - off.x, bottom: H - h - off.y } };
}

// For a pixel (x, y) of the new canvas: 0 when it is in the new area, else
// its distance inside the original from the nearest expanded edge (Infinity
// when no expanded side is near).
function insideDistance(x, y, old, sides) {
  if (x < old.left || y < old.top || x >= old.left + old.width || y >= old.top + old.height) return 0;
  var d = Infinity;
  if (sides.left > 0) d = Math.min(d, x - old.left + 0.5);
  if (sides.top > 0) d = Math.min(d, y - old.top + 0.5);
  if (sides.right > 0) d = Math.min(d, old.left + old.width - x - 0.5);
  if (sides.bottom > 0) d = Math.min(d, old.top + old.height - y - 0.5);
  return d;
}

module.exports = {
  marginPx: marginPx,
  clip: clip,
  contextBox: contextBox,
  growBox: growBox,
  padOf: padOf,
  parseRatio: parseRatio,
  parseResolution: parseResolution,
  nearestRatio: nearestRatio,
  shape: shape,
  editCapture: editCapture,
  anchorOffset: anchorOffset,
  expandCanvas: expandCanvas,
  insideDistance: insideDistance,
  ANCHORS: ANCHORS,
  PRESETS: PRESETS,
  MIN_MARGIN: MIN_MARGIN
};
