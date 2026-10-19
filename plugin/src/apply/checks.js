"use strict";
// The checks of a placed edit (SPEC 3.9, 5.8, 6.5), on small buffers in plain
// JavaScript. Thresholds were set when the skills toolkit was written, on
// real takes and synthetic defects: two real takes gave bias 6.4 and 7.3,
// residual 3.5 and 3.4; a 3 px shift gave residual 8.8, a 3% scale 6.9, a
// +20/-20 tint bias 20.6.
//
// - edited: the result differs from the context inside the mask (mean >= 3).
// - polarity_suspect: it differs more outside the mask than inside.
// - seam: in a ring just outside the mask (past a small gap), the result,
//   with the context kept inside the mask so the edit cannot blur into the
//   ring, and the context, both blurred: bias is the worst channel's mean
//   tone shift, residual the mean difference once that shift is removed
//   (misalignment, wrong scale). seam_ok: bias < 12 and residual < 6.
// - aspect_ok: the result's aspect within 1% of the shaped capture.
// - verify (after the apply): the composite outside the mask, past the
//   feather, is unchanged (largest difference <= 2).
// A failed check only adds a badge: the result stays placed.
//
// Images are { width, height, components (3 or 4), data }; masks are gray
// { width, height, data } with 255 = inside. All at the same size.

var pixels = require("../capture/pixels.js");

var LIMITS = { seam_bias: 12, seam_residual: 6, edited_mean: 3, untouched_max: 2, aspect: 0.01, ring: 12, gap: 2, blur: 4 };

// Chamfer distance (in pixels) from each pixel to the nearest pixel where
// inside(i) is true; 0 on those pixels.
function distanceTo(width, height, inside) {
  var n = width * height;
  var d = new Float32Array(n);
  var BIG = 1e9;
  for (var i = 0; i < n; i++) d[i] = inside(i) ? 0 : BIG;
  var a = 1;
  var b = Math.SQRT2;
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      var k = y * width + x;
      if (d[k] === 0) continue;
      var v = d[k];
      if (x > 0) v = Math.min(v, d[k - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[k - width] + a);
        if (x > 0) v = Math.min(v, d[k - width - 1] + b);
        if (x < width - 1) v = Math.min(v, d[k - width + 1] + b);
      }
      d[k] = v;
    }
  }
  for (var yy = height - 1; yy >= 0; yy--) {
    for (var xx = width - 1; xx >= 0; xx--) {
      var kk = yy * width + xx;
      if (d[kk] === 0) continue;
      var w = d[kk];
      if (xx < width - 1) w = Math.min(w, d[kk + 1] + a);
      if (yy < height - 1) {
        w = Math.min(w, d[kk + width] + a);
        if (xx < width - 1) w = Math.min(w, d[kk + width + 1] + b);
        if (xx > 0) w = Math.min(w, d[kk + width - 1] + b);
      }
      d[kk] = w;
    }
  }
  return d;
}

function px(img, i, c) {
  return img.data[i * img.components + c];
}

// Mean and largest per-pixel difference (largest channel) inside the mask
// (>= 128) and outside it past `gap` pixels from any masked pixel.
function diffStats(a, b, mask, gap) {
  var n = a.width * a.height;
  var dist = distanceTo(a.width, a.height, function (i) {
    return mask.data[i] > 0;
  });
  var inside = { sum: 0, max: 0, n: 0 };
  var outside = { sum: 0, max: 0, n: 0 };
  for (var i = 0; i < n; i++) {
    var dmax = 0;
    var dsum = 0;
    for (var c = 0; c < 3; c++) {
      var d = Math.abs(px(a, i, c) - px(b, i, c));
      dsum += d;
      if (d > dmax) dmax = d;
    }
    var t = mask.data[i] >= 128 ? inside : dist[i] > gap ? outside : null;
    if (!t) continue;
    t.sum += dsum / 3;
    t.n++;
    if (dmax > t.max) t.max = dmax;
  }
  // Pixels that are not numbers make no measure: no badge says ok on them.
  function done(t) {
    return t.n && isFinite(t.sum) && isFinite(t.max) ? { mean: Math.round((t.sum / t.n) * 100) / 100, max: t.max, n: t.n } : null;
  }
  return { inside: done(inside), outside: done(outside) };
}

// Bias and residual of b against a over the pixels where region(i) holds,
// both blurred by `blur` px.
function toneAndResidual(a, b, region, blur) {
  var ab = pixels.boxBlur(rgbOf(a), blur);
  var bb = pixels.boxBlur(rgbOf(b), blur);
  var n = a.width * a.height;
  var sum = [0, 0, 0];
  var count = 0;
  for (var i = 0; i < n; i++) {
    if (!region(i)) continue;
    count++;
    for (var c = 0; c < 3; c++) sum[c] += bb.data[i * 3 + c] - ab.data[i * 3 + c];
  }
  if (!count) return { bias: null, bias_rgb: null, residual: null, n: 0 };
  var shift = sum.map(function (s) {
    return s / count;
  });
  var res = 0;
  for (var j = 0; j < n; j++) {
    if (!region(j)) continue;
    for (var k = 0; k < 3; k++) res += Math.abs(bb.data[j * 3 + k] - ab.data[j * 3 + k] - shift[k]);
  }
  var worst = Math.max(Math.abs(shift[0]), Math.abs(shift[1]), Math.abs(shift[2]));
  if (!isFinite(worst) || !isFinite(res)) return { bias: null, bias_rgb: null, residual: null, n: 0 };
  return {
    bias: Math.round(worst * 100) / 100,
    bias_rgb: shift.map(function (s) {
      return Math.round(s * 100) / 100;
    }),
    residual: Math.round((res / (count * 3)) * 100) / 100,
    n: count
  };
}

function rgbOf(img) {
  if (img.components === 3) return img;
  var n = img.width * img.height;
  var out = new Uint8Array(n * 3);
  for (var i = 0; i < n; i++) for (var c = 0; c < 3; c++) out[i * 3 + c] = img.data[i * img.components + c];
  return { width: img.width, height: img.height, components: 3, data: out };
}

// The seam ring: outside the mask, between gap and gap + ring pixels.
function seam(context, result, mask, o) {
  var gap = o.gap;
  var ring = o.ring;
  var n = context.width * context.height;
  var dist = distanceTo(context.width, context.height, function (i) {
    return mask.data[i] >= 128;
  });
  var kept = new Uint8Array(n * 3);
  for (var i = 0; i < n; i++) {
    var src = mask.data[i] >= 128 ? context : result;
    for (var c = 0; c < 3; c++) kept[i * 3 + c] = px(src, i, c);
  }
  var b = { width: context.width, height: context.height, components: 3, data: kept };
  var r = toneAndResidual(context, b, function (k) {
    return dist[k] > gap && dist[k] <= gap + ring;
  }, o.blur);
  r.ring = ring;
  r.blur = o.blur;
  return r;
}

// Sizes in check pixels: document-pixel distances times the check scale,
// at least 1.
function scaled(v, scale) {
  return Math.max(1, Math.round(v * (scale || 1)));
}

// o: { context, result, mask, scale (check px per document px), shaped
// {width, height} (what was sent), result_size {width, height} (what came
// back), masked }. Returns the flags and the measures.
// Images the checks can read: numbers for sizes, 1 to 4 components, and
// data of the right length. Anything else throws, so the caller notes that
// the checks did not run instead of showing a badge.
function readable(img, name, gray) {
  var comps = gray && img && img.components === undefined ? 1 : img && img.components;
  var ok = img && img.width > 0 && img.height > 0 && comps >= 1 && comps <= 4 && img.data && img.data.length === img.width * img.height * comps;
  if (!ok) throw new Error("the " + name + " pixels cannot be read");
}

function check(o) {
  readable(o.context, "context");
  readable(o.result, "result");
  readable(o.mask, "mask", true);
  var gap = scaled(LIMITS.gap, o.scale);
  var r = diffStats(o.context, o.result, o.mask, gap);
  var out = { inside: r.inside, outside: r.outside };
  var w = o.shaped ? o.shaped.width : o.context.width;
  var h = o.shaped ? o.shaped.height : o.context.height;
  var bw = o.result_size ? o.result_size.width : w;
  var bh = o.result_size ? o.result_size.height : h;
  out.aspect_ok = Math.abs(bw / bh - w / h) <= LIMITS.aspect * (w / h);
  out.edited = !!(r.inside && r.inside.mean >= LIMITS.edited_mean);
  out.polarity_suspect = !!(r.inside && r.outside && r.outside.mean > r.inside.mean && r.outside.mean >= LIMITS.edited_mean);
  out.seam = o.masked === false ? null : seam(o.context, o.result, o.mask, { gap: gap, ring: scaled(LIMITS.ring, o.scale), blur: scaled(LIMITS.blur, o.scale) });
  out.seam_ok = !out.seam || out.seam.residual === null || (out.seam.bias < LIMITS.seam_bias && out.seam.residual < LIMITS.seam_residual);
  return out;
}

// The seam of an Expand result on the overlap band (inside the original).
function bandCheck(o) {
  readable(o.context, "document");
  readable(o.result, "result");
  readable(o.band, "band", true);
  var r = toneAndResidual(o.context, o.result, function (i) {
    return o.band.data[i] >= 128;
  }, scaled(LIMITS.blur, o.scale));
  return { seam: r, seam_ok: r.residual === null || (r.bias < LIMITS.seam_bias && r.residual < LIMITS.seam_residual) };
}

// After the apply: o: { before, after, mask, feather (document px), scale }.
function verify(o) {
  readable(o.before, "before");
  readable(o.after, "after");
  readable(o.mask, "mask", true);
  var gap = scaled(Math.round((o.feather || 0) * 2) + 2, o.scale) + 1;
  var r = diffStats(o.before, o.after, o.mask, gap);
  return {
    untouched: !r.outside || r.outside.max <= LIMITS.untouched_max,
    outside_max: r.outside ? r.outside.max : null,
    edited: !!(r.inside && r.inside.mean >= LIMITS.edited_mean),
    gap: gap
  };
}

// The badges of SPEC 3.9 for one take. c: a check result (or null); v: the
// verify result (take 1 only); o: { masked }.
function badges(c, v, o) {
  var out = [];
  o = o || {};
  if (c) {
    if (c.seam && c.seam.residual !== null) {
      if (c.seam_ok) out.push("Seam ok");
      if (c.seam.bias >= LIMITS.seam_bias) out.push("Edge tone differs");
    }
    if (o.masked && ((c.seam && c.seam.residual !== null && c.seam.residual >= LIMITS.seam_residual) || c.aspect_ok === false)) out.push("May be misaligned");
    if (o.masked && c.inside && !c.edited) out.push(c.polarity_suspect ? "Unchanged inside: the model may have read the mask inverted" : "Unchanged inside");
  }
  if (v && !v.untouched) out.push("Changed outside");
  return out;
}

module.exports = { LIMITS: LIMITS, distanceTo: distanceTo, diffStats: diffStats, seam: seam, check: check, bandCheck: bandCheck, verify: verify, badges: badges, toneAndResidual: toneAndResidual };
