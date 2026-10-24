"use strict";
// Extend canvas landings (SPEC 5.8): the take is the model's whole new
// frame; it lands above the original with a mask that is white over the new
// area and eases to black across a band inside the original
// (capture/pixels.js blendWidth, expandPlacementMask). Past the band the
// original shows untouched.
//
// Two live runs (2026-10-20, a 16:9 and a 3:2 extend of a lake on GPT Image
// 2.5 Flare) showed the join: the redrawn frame's tone differed from the
// original at the old edge, and a 32 px ramp made it a step. toneMatch
// shifts the take's tone near the old edge to the original's, measured in
// the band, so the gradient carries no tone change; the shift fades out
// across the new area (3 band widths), where the model's own tone stays.
//
// Images are { width, height, components (3 or 4), data }. Boxes are in
// document pixels of the new canvas.

var shapeMod = require("../capture/shape.js");

var GRID_LONG = 256;
var MIN_SHIFT = 1.5;

function smooth(t) {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

// Separable box blur of a float field with n channels, in place of the
// gray helpers (the field holds negative values).
function blurField(f, w, h, n, r) {
  var tmp = new Float32Array(f.length);
  var out = new Float32Array(f.length);
  for (var y = 0; y < h; y++) {
    for (var c = 0; c < n; c++) {
      var acc = 0;
      var cnt = 0;
      for (var x0 = 0; x0 <= Math.min(r, w - 1); x0++) {
        acc += f[(y * w + x0) * n + c];
        cnt++;
      }
      for (var x = 0; x < w; x++) {
        tmp[(y * w + x) * n + c] = acc / cnt;
        var o = x - r;
        var i = x + r + 1;
        if (o >= 0) {
          acc -= f[(y * w + o) * n + c];
          cnt--;
        }
        if (i < w) {
          acc += f[(y * w + i) * n + c];
          cnt++;
        }
      }
    }
  }
  for (var xx = 0; xx < w; xx++) {
    for (var c2 = 0; c2 < n; c2++) {
      var a2 = 0;
      var n2 = 0;
      for (var y0 = 0; y0 <= Math.min(r, h - 1); y0++) {
        a2 += tmp[(y0 * w + xx) * n + c2];
        n2++;
      }
      for (var yy = 0; yy < h; yy++) {
        out[(yy * w + xx) * n + c2] = a2 / n2;
        var o2 = yy - r;
        var i2 = yy + r + 1;
        if (o2 >= 0) {
          a2 -= tmp[(o2 * w + xx) * n + c2];
          n2--;
        }
        if (i2 < h) {
          a2 += tmp[(i2 * w + xx) * n + c2];
          n2++;
        }
      }
    }
  }
  return out;
}

// The pixel of img (covering `box`) at document point (x, y), or null when
// outside it or transparent.
function sampleAt(img, box, x, y) {
  var px = Math.floor(((x - box.left) * img.width) / box.width);
  var py = Math.floor(((y - box.top) * img.height) / box.height);
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
  var k = (py * img.width + px) * img.components;
  if (img.components === 4 && img.data[k + 3] < 128) return null;
  return k;
}

// o: { box (what the take covers), context_box (what the context covers),
// old (the original in the new canvas), sides (the grown sides), blend
// (band width, document px), fade (default 3 blends) }. Returns { image,
// applied, shift (the mean shift in the band, RGB) }; the take is not
// changed when the band shows no tone difference.
function toneMatch(take, context, o) {
  var box = o.box;
  var old = o.old;
  var sides = o.sides;
  var blend = Math.max(1, o.blend);
  var fade = o.fade || blend * 3;
  var tw = take.width;
  var th = take.height;
  var tc = take.components;
  var G = Math.max(1, Math.ceil(Math.max(tw, th) / GRID_LONG));
  var gw = Math.ceil(tw / G);
  var gh = Math.ceil(th / G);
  var sx = box.width / tw;
  var sy = box.height / th;
  var diff = new Float32Array(gw * gh * 3);
  var weight = new Float32Array(gw * gh);
  var sum = [0, 0, 0];
  var count = 0;
  for (var gy = 0; gy < gh; gy++) {
    for (var gx = 0; gx < gw; gx++) {
      var cx = Math.min(tw - 1, gx * G + (G >> 1));
      var cy = Math.min(th - 1, gy * G + (G >> 1));
      var X = box.left + (cx + 0.5) * sx;
      var Y = box.top + (cy + 0.5) * sy;
      var d = shapeMod.insideDistance(X, Y, old, sides);
      if (!(d > 0 && d < blend)) continue;
      var kc = sampleAt(context, o.context_box, X, Y);
      if (kc === null) continue;
      var kt = (cy * tw + cx) * tc;
      var g = gy * gw + gx;
      for (var c = 0; c < 3; c++) {
        var v = context.data[kc + c] - take.data[kt + c];
        diff[g * 3 + c] = v;
        sum[c] += v;
      }
      weight[g] = 1;
      count++;
    }
  }
  if (!count) return { image: take, applied: false, shift: null };
  var shift = sum.map(function (s) {
    return Math.round((s / count) * 100) / 100;
  });
  var r = Math.max(2, Math.round(blend / (G * sx)));
  var bd = blurField(diff, gw, gh, 3, r);
  var bw = blurField(weight, gw, gh, 1, r);
  var field = new Float32Array(gw * gh * 3);
  var valid = new Uint8Array(gw * gh);
  var most = 0;
  for (var i = 0; i < gw * gh; i++) {
    if (bw[i] < 0.02) continue;
    valid[i] = 1;
    for (var c3 = 0; c3 < 3; c3++) {
      field[i * 3 + c3] = bd[i * 3 + c3] / bw[i];
      if (weight[i]) most = Math.max(most, Math.abs(field[i * 3 + c3]));
    }
  }
  if (most < MIN_SHIFT) return { image: take, applied: false, shift: shift };
  var out = new Uint8Array(take.data);
  var h2 = blend / 2;
  var qx0 = old.left + (sides.left > 0 ? h2 : 0);
  var qx1 = old.left + old.width - (sides.right > 0 ? h2 : 0) - 1;
  var qy0 = old.top + (sides.top > 0 ? h2 : 0);
  var qy1 = old.top + old.height - (sides.bottom > 0 ? h2 : 0) - 1;
  var corr = [0, 0, 0];
  for (var y = 0; y < th; y++) {
    var Yd = box.top + (y + 0.5) * sy;
    for (var x = 0; x < tw; x++) {
      var Xd = box.left + (x + 0.5) * sx;
      var dd = shapeMod.insideDistance(Xd, Yd, old, sides);
      if (dd >= blend) continue;
      var w = 1;
      if (dd === 0) {
        var ox = Math.max(old.left - Xd, 0, Xd - (old.left + old.width));
        var oy = Math.max(old.top - Yd, 0, Yd - (old.top + old.height));
        var dOut = Math.sqrt(ox * ox + oy * oy);
        w = 1 - smooth(dOut / fade);
        if (w <= 0) continue;
      }
      // The field at the nearest point of the band.
      var qx = Math.max(qx0, Math.min(qx1, Xd));
      var qy = Math.max(qy0, Math.min(qy1, Yd));
      if (!fieldAt(field, valid, gw, gh, (qx - box.left) / sx / G - 0.5, (qy - box.top) / sy / G - 0.5, corr)) continue;
      var k = (y * tw + x) * tc;
      for (var c4 = 0; c4 < 3; c4++) {
        var nv = Math.round(take.data[k + c4] + w * corr[c4]);
        out[k + c4] = nv < 0 ? 0 : nv > 255 ? 255 : nv;
      }
    }
  }
  return { image: { width: tw, height: th, components: tc, data: out }, applied: true, shift: shift };
}

// Bilinear read of the valid cells around (fx, fy) into out; false when
// none of the four is valid.
function fieldAt(field, valid, gw, gh, fx, fy, out) {
  var x0 = Math.max(0, Math.min(gw - 1, Math.floor(fx)));
  var y0 = Math.max(0, Math.min(gh - 1, Math.floor(fy)));
  var x1 = Math.min(gw - 1, x0 + 1);
  var y1 = Math.min(gh - 1, y0 + 1);
  var ax = Math.max(0, Math.min(1, fx - x0));
  var ay = Math.max(0, Math.min(1, fy - y0));
  var cells = [
    [x0, y0, (1 - ax) * (1 - ay)],
    [x1, y0, ax * (1 - ay)],
    [x0, y1, (1 - ax) * ay],
    [x1, y1, ax * ay]
  ];
  var tot = 0;
  out[0] = out[1] = out[2] = 0;
  for (var i = 0; i < 4; i++) {
    var g = cells[i][1] * gw + cells[i][0];
    if (!valid[g]) continue;
    var wt = cells[i][2] + 1e-6;
    tot += wt;
    for (var c = 0; c < 3; c++) out[c] += field[g * 3 + c] * wt;
  }
  if (!tot) return false;
  for (var c2 = 0; c2 < 3; c2++) out[c2] /= tot;
  return true;
}

module.exports = { toneMatch: toneMatch, MIN_SHIFT: MIN_SHIFT };
