"use strict";
// The M4 building blocks with no I/O: capture shaping (SPEC 5.8), the pixel
// helpers (masks in each polarity, feathering, Expand fields) and the checks
// of SPEC 3.9 on synthetic pixels with known defects: an aligned take, a
// 3 px shift, a 3% scale, a +20/-20 tint, a darkened take, a mask read
// inverted, and a change outside the mask after the apply.

const test = require("node:test");
const assert = require("node:assert/strict");
const shape = require("../../plugin/src/capture/shape.js");
const pixels = require("../../plugin/src/capture/pixels.js");
const checks = require("../../plugin/src/apply/checks.js");

const GRID = { kind: "grid", width_input: "width", height_input: "height", step: 16, min: 16, max: 3840, ratios: [], sizes: [] };

test("margin: auto is half the long side, at least 64 px; 64; none", () => {
  assert.equal(shape.marginPx({ width: 928, height: 600 }, "auto"), 464);
  assert.equal(shape.marginPx({ width: 50, height: 20 }, "auto"), 64);
  assert.equal(shape.marginPx({ width: 928, height: 600 }, "64"), 64);
  assert.equal(shape.marginPx({ width: 928, height: 600 }, "none"), 0);
});

test("grid shaping rounds each axis up at upload scale and grows the box evenly", () => {
  const canvas = { width: 3000, height: 2000 };
  const s = shape.shape({ left: 1000, top: 500, width: 1000, height: 1000 }, canvas, GRID, { max_long: 2048 });
  assert.deepEqual(s.upload, { width: 1008, height: 1008 });
  assert.deepEqual(s.params, { width: 1008, height: 1008 });
  assert.deepEqual(s.box, { left: 996, top: 496, width: 1008, height: 1008 });
  assert.equal(s.scale, 1);
  assert.deepEqual(s.pad, { left: 0, top: 0, right: 0, bottom: 0 });
});

test("grid shaping at a reduced upload scale keeps the box covering the selection", () => {
  const canvas = { width: 6000, height: 4000 };
  const s = shape.shape({ left: 100, top: 100, width: 4000, height: 3000 }, canvas, GRID, { max_long: 2048 });
  assert.equal(s.upload.width % 16, 0);
  assert.equal(s.upload.height % 16, 0);
  assert.ok(s.upload.width <= 2048 && s.upload.width >= 2048 - 16);
  assert.ok(s.box.width >= 4000 && s.box.height >= 3000);
  assert.ok(Math.abs(s.upload.width / s.upload.height - s.box.width / s.box.height) < 0.01);
});

test("a box that would leave the canvas shifts inside it; a canvas too small is padded", () => {
  const shifted = shape.growBox({ left: 0, top: 0, width: 100, height: 100 }, 130, 100, { width: 500, height: 500 });
  assert.deepEqual(shifted, { left: 0, top: 0, width: 130, height: 100 });
  const right = shape.growBox({ left: 400, top: 0, width: 100, height: 100 }, 130, 100, { width: 500, height: 500 });
  assert.equal(right.left, 370);
  const s = shape.shape({ left: 0, top: 0, width: 1000, height: 1000 }, { width: 1000, height: 1000 }, GRID, { max_long: 2048 });
  assert.deepEqual(s.box, { left: -4, top: -4, width: 1008, height: 1008 });
  assert.deepEqual(s.pad, { left: 4, top: 4, right: 4, bottom: 4 });
});

test("ratio enum: the nearest ratio, one axis grown, the smallest resolution that covers", () => {
  const si = { kind: "ratio_enum", ratios: ["1:1", "4:3", "16:9", "auto"], sizes: [] };
  const s = shape.shape({ left: 100, top: 100, width: 1500, height: 1000 }, { width: 4000, height: 4000 }, si, { max_long: 2048, resolutions: ["1K", "2K", "4K"] });
  assert.equal(s.params.aspectRatio, "4:3");
  assert.equal(s.params.resolution, "2K");
  assert.equal(s.box.width, 1500);
  assert.equal(s.box.height, 1125);
  assert.equal(s.box.top, 100 - 62);
  assert.equal(Math.max(s.upload.width, s.upload.height), 2048);
});

test("fixed sizes: nearest in ratio, then the smallest that covers; none keeps the box", () => {
  const si = { kind: "none", width_input: null, sizes: [{ width: 512, height: 512 }, { width: 1024, height: 1024 }, { width: 1536, height: 1024 }] };
  const s = shape.shape({ left: 0, top: 0, width: 900, height: 880 }, { width: 2000, height: 2000 }, si, { max_long: 2048 });
  assert.deepEqual(s.upload, { width: 1024, height: 1024 });
  assert.equal(s.box.width, 900);
  assert.equal(s.box.height, 900);
  const n = shape.shape({ left: 0, top: 0, width: 4096, height: 1024 }, { width: 5000, height: 2000 }, { kind: "none", sizes: [] }, { max_long: 2048 });
  assert.deepEqual(n.upload, { width: 2048, height: 512 });
  assert.deepEqual(n.box, { left: 0, top: 0, width: 4096, height: 1024 });
});

test("expand canvas: aspect presets grow one axis at the anchor; per side adds pixels", () => {
  const c = shape.expandCanvas({ width: 3000, height: 2000 }, { mode: "aspect", ratio: "4:5", anchor: "center" });
  assert.deepEqual([c.width, c.height], [3000, 3750]);
  assert.deepEqual(c.offset, { x: 0, y: 875 });
  const top = shape.expandCanvas({ width: 3000, height: 2000 }, { mode: "aspect", ratio: "4:5", anchor: "bottom" });
  assert.deepEqual(top.offset, { x: 0, y: 1750 });
  const wide = shape.expandCanvas({ width: 1000, height: 1000 }, { mode: "aspect", ratio: "16:9", anchor: "top-left" });
  assert.deepEqual([wide.width, wide.height, wide.offset.x], [1778, 1000, 0]);
  const sides = shape.expandCanvas({ width: 100, height: 100 }, { mode: "sides", sides: { left: 10, top: 0, right: 30, bottom: 5 } });
  assert.deepEqual([sides.width, sides.height, sides.offset.x, sides.offset.y], [140, 105, 10, 0]);
  assert.equal(shape.expandCanvas({ width: 100, height: 100 }, { mode: "aspect", ratio: "1:1" }), null);
});

test("masks: polarity white, black and alpha; feathered placement mask covers the box", () => {
  const sel = { left: 10, top: 10, width: 4, height: 4, data: new Uint8Array(16).fill(255) };
  const m = pixels.maskForBox(sel, { left: 8, top: 8, width: 8, height: 8 }, 8, 8);
  assert.equal(m.data[0], 0);
  assert.equal(m.data[2 * 8 + 2], 255);
  assert.equal(pixels.inPolarity(m, "black").data[2 * 8 + 2], 0);
  const a = pixels.inPolarity(m, "alpha");
  assert.equal(a.components, 4);
  assert.equal(a.data[(2 * 8 + 2) * 4 + 3], 0, "transparent where edited");
  assert.equal(a.data[3], 255);
  const big = { left: 6, top: 6, width: 12, height: 12, data: new Uint8Array(144).fill(255) };
  const p = pixels.placementMask(big, { left: 0, top: 0, width: 24, height: 24 }, 2);
  assert.equal(p.width, 24);
  assert.equal(p.data[0], 0);
  assert.equal(p.data[12 * 24 + 12], 255);
  assert.ok(p.data[12 * 24 + 6] > 0 && p.data[12 * 24 + 6] < 255, "feathered edge");
});

test("expand fields: edit mask = new area plus overlap; placement ramps across the overlap", () => {
  const old = { left: 0, top: 100, width: 200, height: 200 };
  const sides = { left: 0, top: 100, right: 0, bottom: 100 };
  const box = { left: 0, top: 0, width: 200, height: 400 };
  const edit = pixels.expandEditMask(box, 200, 400, old, sides, 32);
  assert.equal(edit.data[50 * 200 + 50], 255);
  assert.equal(edit.data[120 * 200 + 50], 255, "inside the overlap");
  assert.equal(edit.data[200 * 200 + 50], 0);
  const place = pixels.expandPlacementMask(box, old, sides, 32);
  assert.equal(place.data[50 * 200 + 50], 255);
  const mid = place.data[116 * 200 + 50];
  assert.ok(mid > 0 && mid < 255);
  assert.equal(place.data[200 * 200 + 50], 0);
  const input = pixels.expandInput({ width: 100, height: 100, components: 3, data: new Uint8Array(30000).fill(200) }, old, box, 100, 200);
  assert.equal(input.components, 4);
  assert.equal(input.data[(10 * 100 + 10) * 4 + 3], 0, "new area transparent");
  assert.equal(input.data[(100 * 100 + 10) * 4 + 3], 255);
  assert.equal(input.data[(100 * 100 + 10) * 4], 200);
});

// ---- checks on synthetic pixels ----

const W = 256;
const H = 256;

function scene(fx = (x) => x, fy = (y) => y, tint = [0, 0, 0]) {
  const data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = fx(x, y);
      const v = fy(y, x);
      for (let c = 0; c < 3; c++) {
        const val = 128 + 55 * Math.sin(u / (4 + c) + c) + 45 * Math.cos(v / (5 + c) - c) + tint[c];
        data[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(val)));
      }
    }
  }
  return { width: W, height: H, components: 3, data };
}

function circle(r) {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - 128) ** 2 + (y - 128) ** 2 <= r * r) data[y * W + x] = 255;
  return { width: W, height: H, data };
}

// The result: `outside` everywhere, a flat edit inside the mask.
function take(outside, mask, color = [30, 160, 60]) {
  const data = Uint8Array.from(outside.data);
  for (let i = 0; i < W * H; i++) if (mask.data[i] >= 128) data.set(color, i * 3);
  return { width: W, height: H, components: 3, data };
}

function noisy(img, amp, seed = 3) {
  let s = seed;
  const data = Uint8Array.from(img.data, (v) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return Math.max(0, Math.min(255, v + ((s >>> 16) % (2 * amp + 1)) - amp));
  });
  return { ...img, data };
}

const context = scene();
const mask = circle(60);
const shaped = { width: W, height: H };

function run(result, extra = {}) {
  return checks.check({ context, result, mask, scale: 1, shaped, result_size: shaped, masked: true, ...extra });
}

test("checks: an aligned real-like take passes (Seam ok, edited)", () => {
  const c = run(take(noisy(context, 4), mask));
  assert.equal(c.edited, true);
  assert.equal(c.polarity_suspect, false);
  assert.equal(c.aspect_ok, true);
  assert.ok(c.seam.bias < 2, `bias ${c.seam.bias}`);
  assert.ok(c.seam.residual < 2, `residual ${c.seam.residual}`);
  assert.equal(c.seam_ok, true);
  assert.deepEqual(checks.badges(c, { untouched: true }, { masked: true }), ["Seam ok"]);
});

test("checks: a 3 px shift is May be misaligned", () => {
  const c = run(take(scene((x) => x + 3), mask));
  assert.ok(c.seam.residual >= 6, `residual ${c.seam.residual}`);
  assert.equal(c.seam_ok, false);
  assert.ok(checks.badges(c, null, { masked: true }).includes("May be misaligned"));
});

test("checks: a 3% scale is May be misaligned", () => {
  const c = run(take(scene((x) => 128 + (x - 128) * 1.03, (y) => 128 + (y - 128) * 1.03), mask));
  assert.ok(c.seam.residual >= 6, `residual ${c.seam.residual}`);
  assert.ok(checks.badges(c, null, { masked: true }).includes("May be misaligned"));
});

test("checks: a +20/-20 tint and a darkened take are Edge tone differs", () => {
  const tinted = run(take(scene(undefined, undefined, [20, -20, 0]), mask));
  assert.ok(tinted.seam.bias >= 12, `bias ${tinted.seam.bias}`);
  assert.ok(tinted.seam.residual < 6, `residual ${tinted.seam.residual}`);
  assert.deepEqual(checks.badges(tinted, null, { masked: true }), ["Edge tone differs"]);
  const dark = run(take(scene(undefined, undefined, [-15, -15, -15]), mask));
  assert.ok(dark.seam.bias >= 12);
  assert.equal(dark.seam_ok, false);
});

test("checks: a mask read inverted is Unchanged inside, polarity suspect", () => {
  // The model changed everything outside the mask and kept the inside.
  const flat = { width: W, height: H, components: 3, data: new Uint8Array(W * H * 3).fill(90) };
  const result = take(flat, { width: W, height: H, data: Uint8Array.from(mask.data, (v) => 255 - v) }, [90, 90, 90]);
  for (let i = 0; i < W * H; i++) if (mask.data[i] >= 128) result.data.set(context.data.subarray(i * 3, i * 3 + 3), i * 3);
  const c = run(result);
  assert.equal(c.edited, false);
  assert.equal(c.polarity_suspect, true);
  assert.ok(checks.badges(c, null, { masked: true }).includes("Unchanged inside: the model may have read the mask inverted"));
});

test("checks: an off-aspect result is flagged against the shaped box, never the raw selection", () => {
  const c = run(take(context, mask), { result_size: { width: 1024, height: 1000 }, shaped: { width: 1008, height: 1008 } });
  assert.equal(c.aspect_ok, false);
  assert.ok(checks.badges(c, null, { masked: true }).includes("May be misaligned"));
  const ok = run(take(context, mask), { result_size: { width: 992, height: 992 }, shaped: { width: 1008, height: 1008 } });
  assert.equal(ok.aspect_ok, true);
  assert.equal(checks.badges(ok, null, { masked: false }).includes("May be misaligned"), false, "not shown unmasked");
});

test("verify: unchanged outside past the feather passes; a change outside fails", () => {
  const before = context;
  const feathered = pixels.boxBlur({ width: W, height: H, components: 1, data: mask.data }, 2);
  const after = { ...before, data: Uint8Array.from(before.data) };
  const placed = take(context, mask);
  for (let i = 0; i < W * H; i++) {
    const a = feathered.data[i] / 255;
    for (let c = 0; c < 3; c++) after.data[i * 3 + c] = Math.round(before.data[i * 3 + c] * (1 - a) + placed.data[i * 3 + c] * a);
  }
  const ok = checks.verify({ before, after, mask, feather: 2, scale: 1 });
  assert.equal(ok.untouched, true, `outside max ${ok.outside_max}`);
  assert.equal(ok.edited, true);
  const bad = { ...after, data: Uint8Array.from(after.data) };
  for (let i = 0; i < 40 * 3; i++) bad.data[i] = 255 - bad.data[i];
  const v = checks.verify({ before, after: bad, mask, feather: 2, scale: 1 });
  assert.equal(v.untouched, false);
  assert.deepEqual(checks.badges(null, v), ["Changed outside"]);
});

test("band check on an Expand overlap: aligned passes, shifted fails", () => {
  const band = { width: W, height: H, data: new Uint8Array(W * H) };
  for (let y = 100; y < 132; y++) for (let x = 0; x < W; x++) band.data[y * W + x] = 255;
  assert.equal(checks.bandCheck({ context, result: noisy(context, 3), band, scale: 1 }).seam_ok, true);
  assert.equal(checks.bandCheck({ context, result: scene((x) => x + 4), band, scale: 1 }).seam_ok, false);
});

test("checks on pixels that cannot be read throw (the caller notes that the checks did not run); never Seam ok", () => {
  // Found live: image data read after dispose() gave sizes and components
  // that were not numbers, and the checks said Seam ok on them.
  const broken = { width: W, height: H, components: { code: "5" }, data: new Uint8Array(W * H * 3) };
  assert.throws(() => checks.check({ context: broken, result: context, mask, scale: 1 }), /context pixels cannot be read/);
  assert.throws(() => checks.verify({ before: context, after: { ...context, data: new Uint8Array(5) }, mask, feather: 2, scale: 1 }), /after pixels cannot be read/);
  assert.throws(() => checks.bandCheck({ context, result: { ...context, width: NaN }, band: mask, scale: 1 }), /result pixels cannot be read/);
});
