"use strict";
// Pixels for the fake Photoshop's scene mode (fake-photoshop.js, opts.scene):
// what each layer shows at a document pixel, and the composite, so the M4
// tests can capture, place, mask and check on real numbers. A model, not a
// measurement:
// - a "pattern" layer (the Background by default) is a smooth gradient in its
//   own frame; a "solid" layer is one colour over its frame; a "raster" layer
//   holds an RGB buffer at document size (flattenImage); a smart object shows
//   its PNG scaled into its frame (nearest pixel);
// - a layer mask multiplies the layer's alpha; outside the mask's rectangle
//   it hides the layer (the plugin always sends masks covering the area);
// - groups composite their visible children, then apply their own mask;
// - the composite is over white, 8-bit RGB.

const zlib = require("node:zlib");

// PNG decode (8-bit gray, gray+alpha, RGB, RGBA), enough for the files the
// plugin and the mock write.
function decodePng(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("fake scene: not a PNG");
  let p = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error("fake scene: 8-bit PNGs only");
      type = data[9];
    } else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`fake scene: PNG colour type ${type}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width: w, height: h, channels, data: out };
}

// The smooth Background of a scene, at layer-local coordinates.
function pattern(x, y, w, h) {
  const u = x / Math.max(1, w);
  const v = y / Math.max(1, h);
  return [Math.round(60 + 120 * u), Math.round(90 + 100 * v), Math.round(170 - 60 * u + 30 * v)];
}

function createScene(opts) {
  const decoded = new Map();
  function image(path) {
    if (decoded.has(path)) return decoded.get(path);
    const bytes = opts.files.get(path);
    let img = null;
    if (bytes instanceof Uint8Array && bytes[0] === 0x89) img = decodePng(bytes);
    decoded.set(path, img);
    return img;
  }

  // [r, g, b, a] of one layer at document pixel (x, y) (pixel centres).
  function layerAt(layer, x, y, doc) {
    if (layer.kind === "group") {
      let acc = null;
      const kids = (layer.layers || []).filter((l) => l.visible);
      for (let i = kids.length - 1; i >= 0; i--) {
        const c = layerAt(kids[i], x, y, doc);
        if (!c || c[3] === 0) continue;
        acc = over(c, acc);
      }
      if (!acc) return null;
      return applyMask(layer, acc, x, y);
    }
    const f = layer.frame;
    const cx = x + 0.5;
    const cy = y + 0.5;
    if (cx < f.left || cy < f.top || cx >= f.left + f.width || cy >= f.top + f.height) return null;
    let px;
    if (layer.content === "solid") px = [...layer.fill, 255];
    else if (layer.content === "raster") {
      const r = layer.raster;
      const i = (Math.min(r.height - 1, Math.max(0, Math.floor(cy - f.top))) * r.width + Math.min(r.width - 1, Math.max(0, Math.floor(cx - f.left)))) * 3;
      px = [r.data[i], r.data[i + 1], r.data[i + 2], 255];
    } else if (layer.content === "file") {
      const img = image(layer.path);
      if (!img) px = [128, 128, 128, 255];
      else {
        const ix = Math.min(img.width - 1, Math.max(0, Math.floor(((cx - f.left) / f.width) * img.width)));
        const iy = Math.min(img.height - 1, Math.max(0, Math.floor(((cy - f.top) / f.height) * img.height)));
        const i = (iy * img.width + ix) * img.channels;
        if (img.channels >= 3) px = [img.data[i], img.data[i + 1], img.data[i + 2], img.channels === 4 ? img.data[i + 3] : 255];
        else px = [img.data[i], img.data[i], img.data[i], img.channels === 2 ? img.data[i + 1] : 255];
      }
    } else px = [...pattern(cx - f.left, cy - f.top, f.width, f.height), 255];
    return applyMask(layer, px, x, y);
  }

  function applyMask(layer, px, x, y) {
    const m = layer.mask;
    if (!m || !m.data) return px;
    const mx = x - Math.round(m.left);
    const my = y - Math.round(m.top);
    const v = mx >= 0 && my >= 0 && mx < m.width && my < m.height ? m.data[my * m.width + mx] : 0;
    return [px[0], px[1], px[2], Math.round((px[3] * v) / 255)];
  }

  function over(top, under) {
    const a = top[3] / 255;
    if (!under) return top.slice();
    const b = under[3] / 255;
    const outA = a + b * (1 - a);
    if (outA <= 0) return [0, 0, 0, 0];
    const mix = (c) => Math.round((top[c] * a + under[c] * b * (1 - a)) / outA);
    return [mix(0), mix(1), mix(2), Math.round(outA * 255)];
  }

  function compositeAt(doc, x, y) {
    let acc = [255, 255, 255, 255];
    const vis = doc.layers.filter((l) => l.visible);
    for (let i = vis.length - 1; i >= 0; i--) {
      const c = layerAt(vis[i], x, y, doc);
      if (c && c[3] > 0) acc = over(c, acc);
    }
    return acc;
  }

  // Reads `bounds` (document pixels) at w x h: the composite (RGB) or one
  // layer (RGBA).
  function read(doc, layer, bounds, w, h) {
    const comps = layer ? 4 : 3;
    const out = new Uint8Array(w * h * comps);
    const kx = (bounds.right - bounds.left) / w;
    const ky = (bounds.bottom - bounds.top) / h;
    for (let j = 0; j < h; j++) {
      const y = Math.floor(bounds.top + (j + 0.5) * ky);
      for (let i = 0; i < w; i++) {
        const x = Math.floor(bounds.left + (i + 0.5) * kx);
        const px = layer ? layerAt(layer, x, y, doc) || [0, 0, 0, 0] : compositeAt(doc, x, y);
        const o = (j * w + i) * comps;
        for (let c = 0; c < comps; c++) out[o + c] = px[c];
      }
    }
    return out;
  }

  return { read, compositeAt, layerAt, image, decodePng };
}

// The selection as gray pixels over its bounds: a rectangle or an ellipse,
// blurred by the feather radius (three box passes). Returns { left, top,
// width, height, data } in document pixels.
function selectionMask(sel, canvas) {
  const r = Math.round(sel.feather || 0);
  const left = Math.max(0, sel.left - r * 2);
  const top = Math.max(0, sel.top - r * 2);
  const right = Math.min(canvas.width, sel.left + sel.width + r * 2);
  const bottom = Math.min(canvas.height, sel.top + sel.height + r * 2);
  const w = right - left;
  const h = bottom - top;
  let data = new Float32Array(w * h);
  const cx = sel.left + sel.width / 2;
  const cy = sel.top + sel.height / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = left + x + 0.5;
      const py = top + y + 0.5;
      let inside;
      if (sel.shape === "ellipse") inside = ((px - cx) / (sel.width / 2)) ** 2 + ((py - cy) / (sel.height / 2)) ** 2 <= 1;
      else inside = px >= sel.left && px < sel.left + sel.width && py >= sel.top && py < sel.top + sel.height;
      data[y * w + x] = inside ? 255 : 0;
    }
  }
  if (r > 0) {
    for (let pass = 0; pass < 3; pass++) {
      const tmp = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let s = 0;
          let n = 0;
          for (let k = -r; k <= r; k++) {
            const xx = x + k;
            if (xx < 0 || xx >= w) continue;
            s += data[y * w + xx];
            n++;
          }
          tmp[y * w + x] = s / n;
        }
      }
      const tmp2 = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let s = 0;
          let n = 0;
          for (let k = -r; k <= r; k++) {
            const yy = y + k;
            if (yy < 0 || yy >= h) continue;
            s += tmp[yy * w + x];
            n++;
          }
          tmp2[y * w + x] = s / n;
        }
      }
      data = tmp2;
    }
  }
  const bytes = new Uint8Array(w * h);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(data[i]);
  return { left, top, width: w, height: h, data: bytes };
}

module.exports = { createScene, decodePng, selectionMask, pattern };
