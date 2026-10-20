"use strict";
// Mask growth for Replace inside on models that redraw past the selection
// (GPT Image 2.5: the mask is a hint, the subject can come back larger than
// the selection and is then cut by it). Measured in the mask strategy test
// of 2026-10-20 (research, Plugin changes item 5). On the check-scale reads
// of one take, in document pixels converted with the check scale:
//
// 1. Tone-match the take to the context in the ring 3 to 3 + max(24, 4% of
//    the selection's long side) px outside the selection, on its 60%
//    least-changed pixels (mean and contrast, gain 0.8 to 1.25). Used for
//    the comparison only; the placed pixels are the model's.
// 2. Blur both with sigma 6 px. The take is blurred with the context kept
//    inside the selection, so the edit itself does not bleed into the ring
//    and grow a band all around (a change of this build from the test
//    script, which blurred the whole take).
// 3. Candidates: the mean RGB difference is over 30, outside the selection,
//    closer to it than 0.9 times the capture margin.
// 4. Close 7 px; keep the pieces that touch the selection and are at least
//    0.5% of its area; dilate 4 px; union with the selection; fill holes.
// Growth over 60% of the selection's area is not applied (the take lands
// on the selection) and is reported as capped.
//
// Images are { width, height, components (3 or 4), data }; masks are gray
// { width, height, data } with 255 = inside, all at the check size.

var pixels = require("../capture/pixels.js");
var checks = require("./checks.js");

var RULE = { ring_gap: 3, ring_min: 24, ring_share: 0.04, least_changed: 0.6, gain_min: 0.8, gain_max: 1.25, sigma: 6, threshold: 30, reach: 0.9, close: 7, min_piece: 0.005, dilate: 4, cap: 0.6 };

// A Gaussian blur of this sigma: pixels.boxBlur runs three box passes of
// radius k, whose sigma is about sqrt(k (k + 1)).
function gauss(img, sigma) {
  return pixels.boxBlur(img, Math.max(1, Math.round(sigma - 0.5)) * Math.sqrt(3));
}

function at(v, scale) {
  return Math.max(1, Math.round(v * (scale || 1)));
}

function rgb(img) {
  if (img.components === 3) return img;
  var n = img.width * img.height;
  var out = new Uint8Array(n * 3);
  for (var i = 0; i < n; i++) for (var c = 0; c < 3; c++) out[i * 3 + c] = img.data[i * img.components + c];
  return { width: img.width, height: img.height, components: 3, data: out };
}

// Mean and contrast of the take matched to the context on the ring's least
// changed pixels; returns a Float32Array RGB image.
function toneMatch(context, take, ring) {
  var n = context.width * context.height;
  var idx = [];
  for (var i = 0; i < n; i++) if (ring[i]) idx.push(i);
  var out = Float32Array.from(take.data);
  if (idx.length < 16) return out;
  var change = idx.map(function (k) {
    var s = 0;
    for (var c = 0; c < 3; c++) s += Math.abs(take.data[k * 3 + c] - context.data[k * 3 + c]);
    return s;
  });
  var sorted = change.slice().sort(function (a, b) {
    return a - b;
  });
  var limit = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * RULE.least_changed))];
  var use = idx.filter(function (k, j) {
    return change[j] <= limit;
  });
  if (use.length < 16) use = idx;
  for (var ch = 0; ch < 3; ch++) {
    var mo = 0;
    var mr = 0;
    for (var u = 0; u < use.length; u++) {
      mo += context.data[use[u] * 3 + ch];
      mr += take.data[use[u] * 3 + ch];
    }
    mo /= use.length;
    mr /= use.length;
    var so = 0;
    var sr = 0;
    for (var v = 0; v < use.length; v++) {
      so += Math.pow(context.data[use[v] * 3 + ch] - mo, 2);
      sr += Math.pow(take.data[use[v] * 3 + ch] - mr, 2);
    }
    var g = (Math.sqrt(so / use.length) + 1e-3) / (Math.sqrt(sr / use.length) + 1e-3);
    g = Math.max(RULE.gain_min, Math.min(RULE.gain_max, g));
    for (var p = 0; p < n; p++) out[p * 3 + ch] = Math.max(0, Math.min(255, (take.data[p * 3 + ch] - mr) * g + mo));
  }
  return out;
}

function dilate(w, h, on, r) {
  var d = checks.distanceTo(w, h, function (i) {
    return on[i] === 1;
  });
  var out = new Uint8Array(w * h);
  for (var i = 0; i < out.length; i++) out[i] = d[i] <= r ? 1 : 0;
  return out;
}

function erode(w, h, on, r) {
  var d = checks.distanceTo(w, h, function (i) {
    return on[i] !== 1;
  });
  var out = new Uint8Array(w * h);
  for (var i = 0; i < out.length; i++) out[i] = d[i] > r ? 1 : 0;
  return out;
}

// 8-connected pieces of on: a label per pixel (0 = off) and their count.
function label(w, h, on) {
  var lab = new Int32Array(w * h);
  var next = 0;
  var stack = [];
  for (var s = 0; s < w * h; s++) {
    if (!on[s] || lab[s]) continue;
    next++;
    lab[s] = next;
    stack.push(s);
    while (stack.length) {
      var k = stack.pop();
      var x = k % w;
      var y = (k - x) / w;
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var nx = x + dx;
          var ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var q = ny * w + nx;
          if (on[q] && !lab[q]) {
            lab[q] = next;
            stack.push(q);
          }
        }
      }
    }
  }
  return { lab: lab, count: next };
}

// Pixels of off not reached from the border become on (holes filled).
function fillHoles(w, h, on) {
  var seen = new Uint8Array(w * h);
  var stack = [];
  function seed(k) {
    if (!on[k] && !seen[k]) {
      seen[k] = 1;
      stack.push(k);
    }
  }
  for (var x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (var y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    var k = stack.pop();
    var kx = k % w;
    var ky = (k - kx) / w;
    if (kx > 0) seed(k - 1);
    if (kx < w - 1) seed(k + 1);
    if (ky > 0) seed(k - w);
    if (ky < h - 1) seed(k + w);
  }
  var out = new Uint8Array(w * h);
  for (var i = 0; i < out.length; i++) out[i] = on[i] || !seen[i] ? 1 : 0;
  return out;
}

// context, take: the check-scale reads; sel: the selection at that size.
// o: { scale (check px per document px), margin (capture margin, document
// px), sel_long (the selection's long side, document px) }.
// Returns { mask (gray, 255 = grown selection), grown_pct (whole percent of
// the selection's area added), applied, capped }.
function growMask(context, take, sel, o) {
  o = o || {};
  var w = context.width;
  var h = context.height;
  var n = w * h;
  var scale = o.scale || 1;
  var a = rgb(context);
  var b = rgb(take);
  var inSel = new Uint8Array(n);
  var area = 0;
  for (var i = 0; i < n; i++) {
    inSel[i] = sel.data[i] >= 128 ? 1 : 0;
    area += inSel[i];
  }
  var none = { mask: { width: w, height: h, data: Uint8Array.from(inSel, function (v) { return v ? 255 : 0; }) }, grown_pct: 0, applied: false, capped: false };
  if (!area || area === n) return none;
  var dist = checks.distanceTo(w, h, function (k) {
    return inSel[k] === 1;
  });
  var selLong = o.sel_long || Math.max(w, h) / scale;
  var gap = RULE.ring_gap * scale;
  var ringW = Math.max(RULE.ring_min, RULE.ring_share * selLong) * scale;
  var ring = new Uint8Array(n);
  for (var r = 0; r < n; r++) ring[r] = dist[r] > gap && dist[r] <= gap + ringW ? 1 : 0;
  var tm = toneMatch(a, b, ring);
  // The context kept inside the selection: only changes outside count.
  var kept = new Uint8Array(n * 3);
  for (var p = 0; p < n; p++) for (var c = 0; c < 3; c++) kept[p * 3 + c] = inSel[p] ? a.data[p * 3 + c] : Math.round(tm[p * 3 + c]);
  var sigma = RULE.sigma * scale;
  var ab = gauss(a, sigma);
  var bb = gauss({ width: w, height: h, components: 3, data: kept }, sigma);
  var reach = o.margin ? RULE.reach * o.margin * scale : Infinity;
  var cand = new Uint8Array(n);
  for (var q = 0; q < n; q++) {
    if (inSel[q] || dist[q] >= reach) continue;
    var s = 0;
    for (var cc = 0; cc < 3; cc++) s += Math.abs(bb.data[q * 3 + cc] - ab.data[q * 3 + cc]);
    if (s / 3 > RULE.threshold) cand[q] = 1;
  }
  var cr = at(RULE.close, scale) / 2;
  cand = erode(w, h, dilate(w, h, cand, cr), cr);
  for (var z = 0; z < n; z++) if (inSel[z] || dist[z] >= reach) cand[z] = 0;
  var pieces = label(w, h, cand);
  var size = new Int32Array(pieces.count + 1);
  var touch = new Uint8Array(pieces.count + 1);
  var near = Math.max(1.5, cr + 1);
  for (var t = 0; t < n; t++) {
    var l = pieces.lab[t];
    if (!l) continue;
    size[l]++;
    if (dist[t] <= near) touch[l] = 1;
  }
  var keep = new Uint8Array(n);
  var any = false;
  for (var u = 0; u < n; u++) {
    var lu = pieces.lab[u];
    if (lu && touch[lu] && size[lu] >= RULE.min_piece * area) {
      keep[u] = 1;
      any = true;
    }
  }
  if (!any) return none;
  keep = dilate(w, h, keep, at(RULE.dilate, scale));
  var grown = new Uint8Array(n);
  for (var g = 0; g < n; g++) grown[g] = keep[g] || inSel[g] ? 1 : 0;
  grown = fillHoles(w, h, grown);
  var total = 0;
  for (var m = 0; m < n; m++) total += grown[m];
  var added = (total - area) / area;
  var pct = Math.round(added * 100);
  if (added > RULE.cap) return { mask: none.mask, grown_pct: pct, applied: false, capped: true };
  if (pct < 1) return none;
  var data = new Uint8Array(n);
  for (var e = 0; e < n; e++) data[e] = grown[e] ? 255 : 0;
  return { mask: { width: w, height: h, data: data }, grown_pct: pct, applied: true, capped: false };
}

// A grown check-scale mask as a placement mask over the placement box
// (document px, bilinear), feathered like the selection's, and never less
// than the selection's own placement mask.
function placementOf(grown, base, feather) {
  var w = base.width;
  var h = base.height;
  var sx = grown.width / w;
  var sy = grown.height / h;
  var up = new Uint8Array(w * h);
  for (var y = 0; y < h; y++) {
    var fy = Math.max(0, Math.min(grown.height - 1, (y + 0.5) * sy - 0.5));
    var y0 = Math.floor(fy);
    var y1 = Math.min(grown.height - 1, y0 + 1);
    var wy = fy - y0;
    for (var x = 0; x < w; x++) {
      var fx = Math.max(0, Math.min(grown.width - 1, (x + 0.5) * sx - 0.5));
      var x0 = Math.floor(fx);
      var x1 = Math.min(grown.width - 1, x0 + 1);
      var wx = fx - x0;
      var v = (grown.data[y0 * grown.width + x0] * (1 - wx) + grown.data[y0 * grown.width + x1] * wx) * (1 - wy) + (grown.data[y1 * grown.width + x0] * (1 - wx) + grown.data[y1 * grown.width + x1] * wx) * wy;
      up[y * w + x] = v >= 128 ? 255 : 0;
    }
  }
  var m = { width: w, height: h, components: 1, data: up };
  if (feather > 0) m = pixels.boxBlur(m, feather);
  var out = new Uint8Array(w * h);
  for (var i = 0; i < out.length; i++) out[i] = Math.max(m.data[i], base.data[i]);
  return { left: base.left, top: base.top, width: w, height: h, data: out };
}

module.exports = { RULE: RULE, growMask: growMask, placementOf: placementOf, toneMatch: toneMatch };
