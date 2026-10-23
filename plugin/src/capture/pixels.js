"use strict";
// Pixel work on small buffers (SPEC 5.5, 5.6, 5.8), plain JavaScript so it is
// tested under Node: area resampling of a region with edge repeat or a fill,
// masks in each model polarity, feathering, the Expand inputs and masks, and
// a cutout's alpha as a mask. Images are { width, height, components, data }
// with 8-bit chunky data.

var shapeMod = require("./shape.js");

// Taps of one axis: for each output index, the source indices and weights
// covering [start + i * step, start + (i + 1) * step). Indices outside
// [0, size) are kept as -1 (fill) or clamped (edge repeat).
function taps(start, span, outN, size, clamp) {
  var step = span / outN;
  var out = new Array(outN);
  for (var i = 0; i < outN; i++) {
    var a = start + i * step;
    var b = a + step;
    var list = [];
    if (step <= 1) {
      // Upscaling or same size: the source pixel under the center.
      var c = Math.floor(a + step / 2);
      list.push({ i: c, w: 1 });
    } else {
      for (var s = Math.floor(a); s < b; s++) {
        var w = Math.min(b, s + 1) - Math.max(a, s);
        if (w > 1e-9) list.push({ i: s, w: w / step });
      }
    }
    for (var k = 0; k < list.length; k++) {
      var idx = list[k].i;
      if (idx < 0 || idx >= size) list[k].i = clamp ? Math.min(size - 1, Math.max(0, idx)) : -1;
    }
    out[i] = list;
  }
  return out;
}

// Reads `region` (in the source's coordinates offset by origin) of src into
// an outW x outH image. mode: "clamp" (edge pixels repeat) or a number (the
// fill for every component outside the source).
function sampleRegion(src, origin, region, outW, outH, mode) {
  var comps = src.components;
  var clamp = mode === "clamp";
  var fill = typeof mode === "number" ? mode : 0;
  var tx = taps(region.left - origin.x, region.width, outW, src.width, clamp);
  var ty = taps(region.top - origin.y, region.height, outH, src.height, clamp);
  // Horizontal pass into floats, then vertical.
  var mid = new Float32Array(outW * src.height * comps);
  for (var y = 0; y < src.height; y++) {
    var row = y * src.width * comps;
    for (var x = 0; x < outW; x++) {
      var t = tx[x];
      for (var c = 0; c < comps; c++) {
        var acc = 0;
        for (var k = 0; k < t.length; k++) acc += (t[k].i < 0 ? fill : src.data[row + t[k].i * comps + c]) * t[k].w;
        mid[(y * outW + x) * comps + c] = acc;
      }
    }
  }
  var out = new Uint8Array(outW * outH * comps);
  for (var oy = 0; oy < outH; oy++) {
    var tv = ty[oy];
    for (var ox = 0; ox < outW; ox++) {
      for (var cc = 0; cc < comps; cc++) {
        var v = 0;
        for (var j = 0; j < tv.length; j++) v += (tv[j].i < 0 ? fill : mid[(tv[j].i * outW + ox) * comps + cc]) * tv[j].w;
        out[(oy * outW + ox) * comps + cc] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return { width: outW, height: outH, components: comps, data: out };
}

function resize(src, outW, outH) {
  return sampleRegion(src, { x: 0, y: 0 }, { left: 0, top: 0, width: src.width, height: src.height }, outW, outH, "clamp");
}

// Size that fits a box within long_side, keeping its aspect.
function fitLong(width, height, longSide) {
  var long = Math.max(width, height);
  if (long <= longSide) return { width: width, height: height };
  var k = longSide / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

// matte: the gray level transparent pixels take (0 to 255), white when
// omitted.
function toRgb(img, matte) {
  if (img.components === 3) return img;
  var bg = typeof matte === "number" ? matte : 255;
  var n = img.width * img.height;
  var out = new Uint8Array(n * 3);
  for (var i = 0; i < n; i++) {
    if (img.components === 1) {
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = img.data[i];
    } else {
      var a = img.components === 4 ? img.data[i * 4 + 3] / 255 : 1;
      // Transparent pixels read as white (as an RGB file would show them)
      // or as the matte.
      for (var c = 0; c < 3; c++) out[i * 3 + c] = Math.round(img.data[i * img.components + c] * a + bg * (1 - a));
    }
  }
  return { width: img.width, height: img.height, components: 3, data: out };
}

function hasTransparency(img) {
  if (img.components !== 4) return false;
  for (var i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return true;
  return false;
}

// The selection mask (document pixels at sel.left, sel.top) over a box, at
// outW x outH; 0 outside the selection's bounds.
function maskForBox(sel, box, outW, outH) {
  var src = { width: sel.width, height: sel.height, components: 1, data: sel.data };
  return sampleRegion(src, { x: sel.left, y: sel.top }, box, outW, outH, 0);
}

function invert(gray) {
  var out = new Uint8Array(gray.data.length);
  for (var i = 0; i < out.length; i++) out[i] = 255 - gray.data[i];
  return { width: gray.width, height: gray.height, components: 1, data: out };
}

// A gray edit mask (white = edit) in a model's polarity (SPEC 5.6):
// white = edit, black = edit (inverted), alpha = transparent where edited.
function inPolarity(gray, polarity) {
  if (polarity === "black") return invert(gray);
  if (polarity === "alpha") {
    var n = gray.width * gray.height;
    var out = new Uint8Array(n * 4);
    for (var i = 0; i < n; i++) {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
      out[i * 4 + 3] = 255 - gray.data[i];
    }
    return { width: gray.width, height: gray.height, components: 4, data: out };
  }
  return gray;
}

// Three box blurs of radius r approximate a Gaussian (any component count).
function boxBlur(img, r) {
  if (!(r > 0)) return img;
  var w = img.width;
  var h = img.height;
  var comps = img.components;
  var cur = Float32Array.from(img.data);
  var tmp = new Float32Array(cur.length);
  var rad = Math.max(1, Math.round(r / Math.sqrt(3)));
  for (var pass = 0; pass < 3; pass++) {
    for (var y = 0; y < h; y++) {
      for (var c = 0; c < comps; c++) {
        var acc = 0;
        var n = 0;
        for (var x0 = -rad; x0 <= rad; x0++) {
          if (x0 >= 0 && x0 < w) {
            acc += cur[(y * w + x0) * comps + c];
            n++;
          }
        }
        for (var x = 0; x < w; x++) {
          tmp[(y * w + x) * comps + c] = acc / n;
          var out = x - rad;
          var inn = x + rad + 1;
          if (out >= 0) {
            acc -= cur[(y * w + out) * comps + c];
            n--;
          }
          if (inn < w) {
            acc += cur[(y * w + inn) * comps + c];
            n++;
          }
        }
      }
    }
    for (var xx = 0; xx < w; xx++) {
      for (var c2 = 0; c2 < comps; c2++) {
        var acc2 = 0;
        var n2 = 0;
        for (var y0 = -rad; y0 <= rad; y0++) {
          if (y0 >= 0 && y0 < h) {
            acc2 += tmp[(y0 * w + xx) * comps + c2];
            n2++;
          }
        }
        for (var yy = 0; yy < h; yy++) {
          cur[(yy * w + xx) * comps + c2] = acc2 / n2;
          var o2 = yy - rad;
          var i2 = yy + rad + 1;
          if (o2 >= 0) {
            acc2 -= tmp[(o2 * w + xx) * comps + c2];
            n2--;
          }
          if (i2 < h) {
            acc2 += tmp[(i2 * w + xx) * comps + c2];
            n2++;
          }
        }
      }
    }
  }
  var data = new Uint8Array(cur.length);
  for (var i = 0; i < cur.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(cur[i])));
  return { width: w, height: h, components: comps, data: data };
}

// The layer mask a selection edit lands with (SPEC 5.7): the selection over
// the box at document resolution, feathered by `feather` px. Box pixels
// outside the selection are 0, so the mask covers the whole placed layer.
function placementMask(sel, box, feather) {
  var w = Math.round(box.width);
  var h = Math.round(box.height);
  var m = maskForBox(sel, { left: box.left, top: box.top, width: w, height: h }, w, h);
  if (feather > 0) m = boxBlur(m, feather);
  return { left: Math.round(box.left), top: Math.round(box.top), width: w, height: h, data: m.data };
}

// ---- Expand (SPEC 5.8, mask route) ----

// Gray image of the new canvas region `box` at outW x outH: for each pixel,
// fn(distance inside the original, or 0 in the new area) -> 0..255.
function expandField(box, outW, outH, old, sides, fn) {
  var out = new Uint8Array(outW * outH);
  var sx = box.width / outW;
  var sy = box.height / outH;
  for (var y = 0; y < outH; y++) {
    for (var x = 0; x < outW; x++) {
      var d = shapeMod.insideDistance(box.left + (x + 0.5) * sx, box.top + (y + 0.5) * sy, old, sides);
      out[y * outW + x] = fn(d, sx);
    }
  }
  return { width: outW, height: outH, components: 1, data: out };
}

// The edit mask (white = edit): the new area plus the overlap band.
function expandEditMask(box, outW, outH, old, sides, overlap) {
  return expandField(box, outW, outH, old, sides, function (d) {
    return d < overlap ? 255 : 0;
  });
}

// How far the redrawn frame shows through inside the original, in document
// px: the overlap, and at least 6% of the original's short side (at most a
// quarter of it). Two live runs (2026-10-20) with a 32 px ramp on a 1536 px
// image showed a step where the old edge was.
function blendWidth(old, overlap) {
  var short = Math.min(old.width, old.height);
  var w = Math.max(overlap || 0, Math.round(short * 0.06));
  return Math.max(1, Math.min(w, Math.round(short / 4)));
}

// 1 at the old edge to 0 at `blend` px inside, eased at both ends so the
// gradient has no visible start or end.
function blendRamp(d, blend) {
  if (d === 0) return 1;
  if (d >= blend) return 0;
  var t = d / blend;
  return 1 - t * t * (3 - 2 * t);
}

// The placement mask: the new area, then an eased ramp across the blend
// band inside the original (blend defaults to the overlap). The original
// is untouched past the band: the mask there is 0.
function expandPlacementMask(box, old, sides, overlap, blend) {
  var b = blend || overlap;
  var w = Math.round(box.width);
  var h = Math.round(box.height);
  var f = expandField({ left: box.left, top: box.top, width: w, height: h }, w, h, old, sides, function (d) {
    return Math.round(255 * blendRamp(d, b));
  });
  return { left: Math.round(box.left), top: Math.round(box.top), width: w, height: h, data: f.data };
}

// The band where the seam check runs: inside the original, within
// `overlap` px of the old edge (the runner passes the blend width).
function expandBand(box, outW, outH, old, sides, overlap) {
  return expandField(box, outW, outH, old, sides, function (d) {
    return d > 0 && d < overlap ? 255 : 0;
  });
}

// The model's input for the mask route: the original (read at
// `original`'s own size, covering `old` in document pixels) on an empty,
// transparent canvas covering `box` at outW x outH.
function expandInput(original, old, box, outW, outH) {
  var rgba = original.components === 4 ? original : addAlpha(original);
  var region = { left: box.left - old.left, top: box.top - old.top, width: box.width, height: box.height };
  var scaleX = original.width / old.width;
  var scaleY = original.height / old.height;
  var src = { left: region.left * scaleX, top: region.top * scaleY, width: region.width * scaleX, height: region.height * scaleY };
  var out = sampleRegion(rgba, { x: 0, y: 0 }, src, outW, outH, 0);
  return out;
}

function addAlpha(img) {
  var n = img.width * img.height;
  var out = new Uint8Array(n * 4);
  for (var i = 0; i < n; i++) {
    for (var c = 0; c < 3; c++) out[i * 4 + c] = img.data[i * img.components + Math.min(c, img.components - 1)];
    out[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, components: 4, data: out };
}

// A cutout's alpha as a gray mask; an opaque result gives an all-white mask.
function alphaMask(img) {
  var n = img.width * img.height;
  var out = new Uint8Array(n);
  for (var i = 0; i < n; i++) out[i] = img.components === 4 ? img.data[i * 4 + 3] : 255;
  return { width: img.width, height: img.height, components: 1, data: out };
}

// True when every pixel is within tol of the first on each color channel
// (a blank canvas).
function uniform(img, tol) {
  var n = img.width * img.height;
  var c = Math.min(3, img.components);
  if (!n) return false;
  for (var i = 1; i < n; i++) for (var k = 0; k < c; k++) if (Math.abs(img.data[i * img.components + k] - img.data[k]) > tol) return false;
  return true;
}

// The share of pixels that cover what is under them, alpha 128 or more (1
// for an image without alpha). GPT Image's "transparent" background came
// back at alpha 232 to 250 everywhere (live 2026-10-23).
function opaqueShare(img) {
  if (img.components !== 4 && img.components !== 2) return 1;
  var n = img.width * img.height;
  var a = img.components - 1;
  var k = 0;
  for (var i = 0; i < n; i++) if (img.data[i * img.components + a] >= 128) k++;
  return n ? k / n : 1;
}

// Copies a gray image into a larger zero mask at (x, y): for cutouts from a
// selection box, the mask hides everything outside the box.
function placeInto(gray, width, height, x, y) {
  var out = new Uint8Array(width * height);
  for (var r = 0; r < gray.height; r++) {
    var ty = r + y;
    if (ty < 0 || ty >= height) continue;
    for (var c = 0; c < gray.width; c++) {
      var tx = c + x;
      if (tx < 0 || tx >= width) continue;
      out[ty * width + tx] = gray.data[r * gray.width + c];
    }
  }
  return { width: width, height: height, components: 1, data: out };
}

module.exports = {
  sampleRegion: sampleRegion,
  resize: resize,
  fitLong: fitLong,
  toRgb: toRgb,
  hasTransparency: hasTransparency,
  maskForBox: maskForBox,
  invert: invert,
  inPolarity: inPolarity,
  boxBlur: boxBlur,
  placementMask: placementMask,
  expandEditMask: expandEditMask,
  expandPlacementMask: expandPlacementMask,
  blendWidth: blendWidth,
  blendRamp: blendRamp,
  expandBand: expandBand,
  expandInput: expandInput,
  addAlpha: addAlpha,
  alphaMask: alphaMask,
  opaqueShare: opaqueShare,
  uniform: uniform,
  placeInto: placeInto
};
