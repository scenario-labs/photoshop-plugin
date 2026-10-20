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
// - shift_px: how far the result moved against the context, in document
//   px: the median shift of textured 32 px blocks (check scale, luminance
//   standard deviation at least 6) lying more than 20 document px outside
//   the mask, each found by block matching on zero-mean luminance with a
//   parabola for the sub-pixel part (the mask strategy test of 2026-10-20
//   used phase correlation for the same measure). GPT Image 2.5 re-renders
//   the whole picture: its ring residual is high at shifts of 0.01 to 0.25
//   px, so a high residual alone is "Re-rendered around the edit"; "May be
//   misaligned" needs a shift of 1 document px or more, or a wrong aspect.
// - aspect_ok: the result's aspect within 1% of the shaped capture.
// - kept_share (Remove only, o.cleared): the share of the masked area whose
//   16 px cells look as before (both blurred, the inside's tone shift
//   removed, mean difference under the seam residual limit, 6). From 0.3,
//   part of what was to go may still be there, as in a review where a
//   Remove kept one of four selected boats.
// - verify (after the apply): the composite outside the mask, past the
//   feather, is unchanged (largest difference <= 2).
// A failed check only adds a badge: the result stays placed.
//
// Images are { width, height, components (3 or 4), data }; masks are gray
// { width, height, data } with 255 = inside. All at the same size.

var pixels = require("../capture/pixels.js");

var LIMITS = { seam_bias: 12, seam_residual: 6, edited_mean: 3, untouched_max: 2, aspect: 0.01, ring: 12, gap: 2, blur: 4, cell: 16, kept_share: 0.3, shift_px: 1, shift_block: 32, shift_texture: 6, shift_away: 20, shift_search: 4, shift_blocks: 48 };

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

// The share (0 to 1) of the masked pixels in cells that look unchanged, or
// null when nothing is masked. Cells less than half masked are skipped.
function keptShare(context, result, mask, scale) {
  var blur = scaled(LIMITS.blur, scale);
  var ab = pixels.boxBlur(rgbOf(context), blur);
  var bb = pixels.boxBlur(rgbOf(result), blur);
  var w = context.width;
  var h = context.height;
  var sum = [0, 0, 0];
  var n = 0;
  for (var i = 0; i < w * h; i++) {
    if (mask.data[i] < 128) continue;
    n++;
    for (var c = 0; c < 3; c++) sum[c] += bb.data[i * 3 + c] - ab.data[i * 3 + c];
  }
  if (!n) return null;
  var shift = sum.map(function (s) {
    return s / n;
  });
  var size = LIMITS.cell;
  var kept = 0;
  for (var cy = 0; cy < h; cy += size) {
    for (var cx = 0; cx < w; cx += size) {
      var m = 0;
      var r = 0;
      var area = Math.min(size, w - cx) * Math.min(size, h - cy);
      for (var y = cy; y < Math.min(h, cy + size); y++) {
        for (var x = cx; x < Math.min(w, cx + size); x++) {
          var k = y * w + x;
          if (mask.data[k] < 128) continue;
          m++;
          for (var cc = 0; cc < 3; cc++) r += Math.abs(bb.data[k * 3 + cc] - ab.data[k * 3 + cc] - shift[cc]);
        }
      }
      if (m * 2 < area) continue;
      if (r / (m * 3) < LIMITS.seam_residual) kept += m;
    }
  }
  if (!isFinite(kept)) return null;
  return Math.round((kept / n) * 100) / 100;
}

function luma(img) {
  var n = img.width * img.height;
  var out = new Float32Array(n);
  var k = img.components;
  for (var i = 0; i < n; i++) {
    if (k < 3) out[i] = img.data[i * k];
    else out[i] = 0.299 * img.data[i * k] + 0.587 * img.data[i * k + 1] + 0.114 * img.data[i * k + 2];
  }
  return out;
}

function median(list) {
  var s = list.slice().sort(function (a, b) {
    return a - b;
  });
  var m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The parabola's minimum through three costs around the best one.
function subPixel(l, c, r) {
  var den = l - 2 * c + r;
  if (!(den > 0)) return 0;
  return Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den)));
}

// One block's shift [dx, dy] in check px, or null when the match says
// nothing: best on the search edge, or not clearly better than the rest (a
// flat or repeating block).
function blockShift(a, b, w, x0, y0, mean, B, R) {
  var size = 2 * R + 1;
  var cost = new Float64Array(size * size);
  var best = -1;
  var total = 0;
  for (var dy = -R; dy <= R; dy++) {
    for (var dx = -R; dx <= R; dx++) {
      var mb = 0;
      for (var by = y0; by < y0 + B; by++) for (var bx = x0; bx < x0 + B; bx++) mb += b[(by + dy) * w + bx + dx];
      mb /= B * B;
      var ssd = 0;
      for (var cy = y0; cy < y0 + B; cy++) {
        for (var cx = x0; cx < x0 + B; cx++) {
          var d = b[(cy + dy) * w + cx + dx] - mb - (a[cy * w + cx] - mean);
          ssd += d * d;
        }
      }
      var k = (dy + R) * size + dx + R;
      cost[k] = ssd;
      total += ssd;
      if (best < 0 || ssd < cost[best]) best = k;
    }
  }
  var bxk = (best % size) - R;
  var byk = Math.floor(best / size) - R;
  if (Math.abs(bxk) === R || Math.abs(byk) === R) return null;
  if (cost[best] > 0.5 * (total / cost.length)) return null;
  return [bxk + subPixel(cost[best - 1], cost[best], cost[best + 1]), byk + subPixel(cost[best - size], cost[best], cost[best + size])];
}

// shift_px of the header, or null when no block qualifies.
function shiftOf(context, result, mask, scale) {
  var w = context.width;
  var h = context.height;
  var B = LIMITS.shift_block;
  var R = LIMITS.shift_search;
  if (w < B + 2 * R || h < B + 2 * R) return null;
  var a = luma(context);
  var b = luma(result);
  var dist = distanceTo(w, h, function (i) {
    return mask.data[i] >= 128;
  });
  var away = LIMITS.shift_away * (scale || 1);
  var blocks = [];
  for (var y0 = R; y0 + B + R <= h; y0 += B / 2) {
    for (var x0 = R; x0 + B + R <= w; x0 += B / 2) {
      var far = true;
      var mean = 0;
      for (var y = y0; y < y0 + B && far; y++) {
        for (var x = x0; x < x0 + B; x++) {
          if (dist[y * w + x] <= away) {
            far = false;
            break;
          }
          mean += a[y * w + x];
        }
      }
      if (!far) continue;
      mean /= B * B;
      var sd = 0;
      for (var yy = y0; yy < y0 + B; yy++) for (var xx = x0; xx < x0 + B; xx++) sd += Math.pow(a[yy * w + xx] - mean, 2);
      if (Math.sqrt(sd / (B * B)) >= LIMITS.shift_texture) blocks.push([x0, y0, mean]);
    }
  }
  // At most 48 blocks, spread over the picture, keep the check quick.
  var step = Math.max(1, blocks.length / LIMITS.shift_blocks);
  var dxs = [];
  var dys = [];
  for (var f = 0; f < blocks.length; f += step) {
    var bk = blocks[Math.floor(f)];
    var m = blockShift(a, b, w, bk[0], bk[1], bk[2], B, R);
    if (m) {
      dxs.push(m[0]);
      dys.push(m[1]);
    }
  }
  if (!dxs.length) return null;
  var sh = Math.sqrt(Math.pow(median(dxs), 2) + Math.pow(median(dys), 2)) / (scale || 1);
  return Math.round(sh * 100) / 100;
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
  out.shift_px = o.masked === false ? null : shiftOf(o.context, o.result, o.mask, o.scale);
  out.kept_share = o.cleared ? keptShare(o.context, o.result, o.mask, o.scale) : null;
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
    // A high ring residual is a misalignment only when the blocks away from
    // the edit moved (shift_px); measured without a shift, it is a re-render.
    var rough = !!(c.seam && c.seam.residual !== null && c.seam.residual >= LIMITS.seam_residual);
    var hasShift = typeof c.shift_px === "number";
    var moved = hasShift ? c.shift_px >= LIMITS.shift_px : rough;
    if (o.masked && (moved || c.aspect_ok === false)) out.push("May be misaligned");
    else if (o.masked && rough && hasShift) out.push("Re-rendered around the edit");
    // c is a check result or the runner's summary of one (inside_mean).
    var measured = !!c.inside || (c.inside_mean !== null && c.inside_mean !== undefined);
    if (o.masked && measured && !c.edited) out.push(c.polarity_suspect ? "Unchanged inside: the model may have read the mask inverted" : "Unchanged inside");
    else if (o.masked && c.kept_share !== null && c.kept_share !== undefined && c.kept_share >= LIMITS.kept_share) out.push("Part of the selection may be unchanged");
  }
  if (v && !v.untouched) out.push("Changed outside");
  return out;
}

module.exports = { LIMITS: LIMITS, distanceTo: distanceTo, diffStats: diffStats, seam: seam, keptShare: keptShare, shiftOf: shiftOf, check: check, bandCheck: bandCheck, verify: verify, badges: badges, toneAndResidual: toneAndResidual };
