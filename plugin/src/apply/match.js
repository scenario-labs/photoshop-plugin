"use strict";
// Where a split element sits in the image it came from (FLOWS v2, F7).
// Seedream Layerize returns each element cropped to its own bounds and
// redrawn larger, with no position, so the plugin finds it: the element's
// opaque pixels are compared with the original at every position and size
// (its aspect is fixed), coarse first, then refined. Plain arithmetic on
// small reads, so it runs under Node and costs nothing.
//
// Images are { width, height, components (3 or 4), data }.

var COARSE_LONG = 192;
var COARSE_SAMPLES = 200;
// Coarse places refined at full read size; the best refined one wins.
var CANDIDATES = 8;
var FINE_SAMPLES = 320;
var MIN_FRACTION = 0.01;
var MIN_LONG = 6;
var STEP = 1.05;
// Mean difference per channel (0 to 255) above which a match is doubtful.
var DOUBTFUL = 38;
// An element opaque over this share of its image is a backdrop (a sky, a
// sea): it is redrawn whole, without what stood in front of it, so a small
// plain patch of it matches better than its real place. It is searched at
// BACKDROP_MIN of the picture's width or more (live 2026-10-23: a sky landed
// at 84 x 47 px).
var BACKDROP = 0.98;
var BACKDROP_MIN = 0.9;

function at(img, x, y, c) {
  return img.data[(y * img.width + x) * img.components + Math.min(c, img.components - 1)];
}

// The bounds of the element's opaque pixels (alpha at least 128), in its
// own pixels, or null when it has none.
function opaqueBounds(el) {
  var x0 = el.width;
  var y0 = el.height;
  var x1 = -1;
  var y1 = -1;
  for (var y = 0; y < el.height; y++) {
    for (var x = 0; x < el.width; x++) {
      var a = el.components === 4 ? el.data[(y * el.width + x) * 4 + 3] : 255;
      if (a < 128) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// The share of the element's pixels that are opaque (alpha 128 and up).
function opaqueShare(el) {
  if (el.components !== 4) return 1;
  var n = el.width * el.height;
  var k = 0;
  for (var i = 0; i < n; i++) if (el.data[i * 4 + 3] >= 128) k++;
  return n ? k / n : 0;
}

// Up to n samples of the element's solid pixels (alpha 200 and up), spread
// on a grid, as fractions of its opaque bounds plus their color.
function samples(el, b, n) {
  var all = [];
  for (var y = b.top; y < b.top + b.height; y++) {
    for (var x = b.left; x < b.left + b.width; x++) {
      var i = (y * el.width + x) * el.components;
      var a = el.components === 4 ? el.data[i + 3] : 255;
      if (a < 200) continue;
      all.push([(x + 0.5 - b.left) / b.width, (y + 0.5 - b.top) / b.height, el.data[i], el.data[i + 1], el.data[i + 2]]);
    }
  }
  if (all.length <= n) return all;
  var out = [];
  var stride = all.length / n;
  for (var k = 0; k < n; k++) out.push(all[Math.floor(k * stride)]);
  return out;
}

// Box-filter downscale of an RGB(A) image to at most `long` on its long side.
function shrink(img, long) {
  var k = Math.max(img.width, img.height) > long ? long / Math.max(img.width, img.height) : 1;
  if (k === 1) return img;
  var w = Math.max(1, Math.round(img.width * k));
  var h = Math.max(1, Math.round(img.height * k));
  var out = new Uint8Array(w * h * 3);
  for (var y = 0; y < h; y++) {
    var sy0 = Math.floor((y * img.height) / h);
    var sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (var x = 0; x < w; x++) {
      var sx0 = Math.floor((x * img.width) / w);
      var sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / w));
      var r = 0;
      var g = 0;
      var bl = 0;
      var n = 0;
      for (var yy = sy0; yy < sy1; yy++) {
        for (var xx = sx0; xx < sx1; xx++) {
          var i = (yy * img.width + xx) * img.components;
          r += img.data[i];
          g += img.data[i + Math.min(1, img.components - 1)];
          bl += img.data[i + Math.min(2, img.components - 1)];
          n++;
        }
      }
      var o = (y * w + x) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = bl / n;
    }
  }
  return { width: w, height: h, components: 3, data: out };
}

// Mean absolute difference per channel of the samples placed at (x, y) at
// size w x h in img; stops early once above `limit`.
// Candidates are reranked by how much better they match the original than
// the rebuilt background (CONTRAST, capped): see findElement.
var CONTRAST = 0.5;
var CONTRAST_CAP = 60;

function cost(img, pts, x, y, w, h, limit) {
  var sum = 0;
  var cap = limit * pts.length * 3;
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    var px = Math.min(img.width - 1, Math.floor(x + p[0] * w));
    var py = Math.min(img.height - 1, Math.floor(y + p[1] * h));
    var k = py * img.width + px;
    var j = k * img.components;
    sum += Math.abs(img.data[j] - p[2]) + Math.abs(img.data[j + 1] - p[3]) + Math.abs(img.data[j + 2] - p[4]);
    if (sum > cap) return Infinity;
  }
  return sum / (pts.length * 3);
}

// Nearest-neighbour resample (the rebuilt background to the original's size).
function resample(img, w, h) {
  var out = new Uint8Array(w * h * img.components);
  for (var y = 0; y < h; y++) {
    var sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / h));
    for (var x = 0; x < w; x++) {
      var sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / w));
      for (var c = 0; c < img.components; c++) out[(y * w + x) * img.components + c] = img.data[(sy * img.width + sx) * img.components + c];
    }
  }
  return { width: w, height: h, components: img.components, data: out };
}

// The best places for the samples in img at widths from w0 to w1 (aspect
// fixed), positions every `step` px: up to `keep` candidates that do not
// overlap much, best first. Each is { x, y, w, h, score }.
function search(img, pts, aspect, w0, w1, factor, step, around, keep) {
  keep = keep || 1;
  var top = [];
  function worst() {
    return top.length < keep ? Infinity : top[top.length - 1].score;
  }
  function offer(c) {
    for (var i = 0; i < top.length; i++) {
      var t = top[i];
      var ix = Math.max(0, Math.min(t.x + t.w, c.x + c.w) - Math.max(t.x, c.x));
      var iy = Math.max(0, Math.min(t.y + t.h, c.y + c.h) - Math.max(t.y, c.y));
      var inter = ix * iy;
      if (inter > 0.5 * (t.w * t.h + c.w * c.h - inter)) {
        if (c.score < t.score) top.splice(i, 1);
        else return;
        break;
      }
    }
    top.push(c);
    top.sort(function (a, b) {
      return a.score - b.score;
    });
    if (top.length > keep) top.length = keep;
  }
  var w = w0;
  while (w <= w1 + 1e-9) {
    var h = w / aspect;
    if (h <= img.height && w <= img.width) {
      var xs = 0;
      var xe = img.width - w;
      var ys = 0;
      var ye = img.height - h;
      if (around) {
        xs = Math.max(0, around.x - around.r);
        xe = Math.min(img.width - w, around.x + around.r);
        ys = Math.max(0, around.y - around.r);
        ye = Math.min(img.height - h, around.y + around.r);
      }
      for (var y = ys; y <= ye + 1e-9; y += step) {
        for (var x = xs; x <= xe + 1e-9; x += step) {
          var c = cost(img, pts, x, y, w, h, worst());
          if (c < worst()) offer({ x: x, y: y, w: w, h: h, score: c });
        }
      }
    }
    w = factor > 1 ? w * factor : w + Math.abs(factor);
  }
  return top;
}

// Finds an element in the original. original: the image the element was
// split from (any size; 256 to 512 px on the long side is plenty); el: the
// element as read (RGBA); rebuilt (optional): the rebuilt background read
// like the original. Returns { box (original pixels, the element's
// opaque bounds), bounds (those bounds as fractions of the element image),
// score, doubtful } or null when the element has no opaque pixels.
function findElement(original, el, rebuilt) {
  var b = opaqueBounds(el);
  if (!b) return null;
  var aspect = b.width / b.height;
  var coarse = shrink(original, COARSE_LONG);
  var kc = coarse.width / original.width;
  var pc = samples(el, b, COARSE_SAMPLES);
  var minW = Math.max(aspect >= 1 ? MIN_LONG : MIN_LONG * aspect, Math.min(coarse.width, coarse.height * aspect) * MIN_FRACTION);
  var maxW = Math.min(coarse.width, coarse.height * aspect);
  if (opaqueShare(el) >= BACKDROP) minW = Math.max(minW, maxW * BACKDROP_MIN);
  var cands = search(coarse, pc, aspect, minW, maxW, STEP, 1, null, CANDIDATES);
  if (!cands.length) return null;
  var fine = original;
  var back = rebuilt ? (rebuilt.width === fine.width && rebuilt.height === fine.height ? rebuilt : resample(rebuilt, fine.width, fine.height)) : null;
  var pf = samples(el, b, FINE_SAMPLES);
  var f = null;
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i];
    var cw = c.w / kc;
    var got = search(fine, pf, aspect, Math.max(2, cw * 0.88), Math.min(fine.width, fine.height * aspect, cw * 1.12), -Math.max(1, cw * 0.01), 1, { x: Math.round(c.x / kc), y: Math.round(c.y / kc), r: Math.ceil(2 / kc) }, 1)[0];
    if (!got) got = { x: c.x / kc, y: c.y / kc, w: cw, h: c.h / kc, score: cost(fine, pf, c.x / kc, c.y / kc, cw, c.h / kc, Infinity) };
    got.color = got.score;
    // An element was lifted from where the rebuilt background now differs:
    // a place that matches the background as well as the original is a
    // look-alike patch, not the element's home.
    if (back) got.score = got.color - CONTRAST * Math.min(CONTRAST_CAP, cost(back, pf, got.x, got.y, got.w, got.h, Infinity));
    if (!f || got.score < f.score) f = got;
  }
  return {
    box: { left: f.x, top: f.y, width: f.w, height: f.h },
    bounds: { x: b.left / el.width, y: b.top / el.height, w: b.width / el.width, h: b.height / el.height },
    score: Math.round(f.color * 10) / 10,
    doubtful: f.color > DOUBTFUL
  };
}

// Where the whole element image goes in document pixels, from a match made
// on a read of the source box `src` (document pixels) at readW x readH.
// Returns { left, top, width, height, center_x, center_y }.
function placeOf(match, src, readW, readH) {
  var kx = src.width / readW;
  var ky = src.height / readH;
  var ob = { left: src.left + match.box.left * kx, top: src.top + match.box.top * ky, width: match.box.width * kx, height: match.box.height * ky };
  var width = ob.width / match.bounds.w;
  var height = ob.height / match.bounds.h;
  var left = ob.left - match.bounds.x * width;
  var top = ob.top - match.bounds.y * height;
  return { left: left, top: top, width: width, height: height, center_x: left + width / 2, center_y: top + height / 2 };
}

module.exports = { findElement: findElement, placeOf: placeOf, opaqueBounds: opaqueBounds, shrink: shrink, DOUBTFUL: DOUBTFUL };
