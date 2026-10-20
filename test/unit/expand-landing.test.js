"use strict";
// Extend canvas landings and their checks on synthetic pictures that copy
// the two live findings of 2026-10-20: a step where the old edge was, and
// the sun drawn again past it. The band check alone (inside the original)
// called both fine.

const test = require("node:test");
const assert = require("node:assert/strict");
const pixels = require("../../plugin/src/capture/pixels.js");
const checks = require("../../plugin/src/apply/checks.js");
const blend = require("../../plugin/src/apply/expand-blend.js");

const OW = 300;
const OH = 200;
const TW = 400; // the original extended by 100 px on the right
const SIDES = { left: 0, top: 0, right: 100, bottom: 0 };
const OLD = { left: 0, top: 0, width: OW, height: OH };
const BOX = { left: 0, top: 0, width: TW, height: OH };

function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) & 255) / 255 - 0.5;
}

// A lake at sunset: a sky gradient, a sun, a textured shore below y 140.
function lake(w, opts = {}) {
  const suns = opts.suns || [[260, 50]];
  const data = new Uint8Array(w * OH * 3);
  for (let y = 0; y < OH; y++) {
    for (let x = 0; x < w; x++) {
      const seed = x >= OW ? opts.seed || 1 : 1;
      let px;
      if (y < 140) px = [90 + 0.4 * y, 140 + 0.3 * y, 220 - 0.2 * y].map((v) => v + 4 * hash(x, y, seed));
      else px = [70, 60, 40].map((v, c) => v + 30 * hash(x, y, seed + c));
      for (const [sx, sy] of suns) if ((x - sx) ** 2 + (y - sy) ** 2 < 14 * 14) px = [255, 235, 170];
      if (x >= OW && opts.step) px = px.map((v) => v + opts.step);
      for (let c = 0; c < 3; c++) data[(y * w + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(px[c])));
    }
  }
  return { width: w, height: OH, components: 3, data };
}

const ORIGINAL = lake(OW);
const BLEND = pixels.blendWidth(OLD, 32);

function edges(take) {
  return checks.expandEdges({ original: ORIGINAL, take, offset: [0, 0], sides: SIDES, blend: BLEND });
}

function bandOf() {
  return pixels.expandBand(OLD, OW, OH, OLD, SIDES, 32);
}

function crop(img, w) {
  const out = new Uint8Array(w * img.height * 3);
  for (let y = 0; y < img.height; y++) out.set(img.data.subarray(y * img.width * 3, (y * img.width + w) * 3), y * w * 3);
  return { width: w, height: img.height, components: 3, data: out };
}

// What the person sees: the take over the original through the landing mask.
function composite(take, mask) {
  const out = new Uint8Array(TW * OH * 3);
  for (let y = 0; y < OH; y++) {
    for (let x = 0; x < TW; x++) {
      const m = mask.data[y * TW + x] / 255;
      for (let c = 0; c < 3; c++) {
        const t = take.data[(y * TW + x) * 3 + c];
        const o = x < OW ? ORIGINAL.data[(y * OW + x) * 3 + c] : t;
        out[(y * TW + x) * 3 + c] = Math.round(m * t + (1 - m) * o);
      }
    }
  }
  return out;
}

test("extend: the band check alone misses the step and the doubled sun (the live finding)", () => {
  for (const take of [lake(TW, { step: 28, seed: 2 }), lake(TW, { suns: [[260, 50], [345, 50]], seed: 2 })]) {
    const b = checks.bandCheck({ context: ORIGINAL, result: crop(take, OW), band: bandOf(), scale: 1 });
    assert.equal(b.seam_ok, true, "inside the original the take matches");
  }
});

test("extend edges: a good extension passes; a step at the old edge and a doubled sun are flagged", () => {
  const good = edges(lake(TW, { seed: 2 }));
  assert.equal(good.step_ok, true, JSON.stringify(good));
  assert.equal(good.repeated, false, JSON.stringify(good));
  const stepped = edges(lake(TW, { step: 28, seed: 2 }));
  assert.equal(stepped.step_ok, false, JSON.stringify(stepped));
  assert.ok(stepped.step > 20, "the step's height: " + stepped.step);
  const twice = edges(lake(TW, { suns: [[260, 50], [345, 50]], seed: 2 }));
  assert.equal(twice.repeated, true, JSON.stringify(twice));
  assert.ok(twice.repeat_at.every((r) => r.at[0] >= OW), "found past the old edge");
  const badges = checks.badges({ ...stepped, ...twice, step_ok: false, seam: null }, null, { masked: true });
  assert.ok(badges.includes("Step at the old edge") && badges.includes("Repeated detail past the old edge"), JSON.stringify(badges));
});

test("extend edges: a horizon and a repeating texture crossing the old edge are not repeats", () => {
  const stripes = (w) => {
    const img = lake(w, { seed: 2, suns: [] });
    for (let y = 0; y < OH; y++) for (let x = 0; x < w; x++) if (Math.floor(x / 10) % 2 === 0 && y > 150) img.data.set([200, 200, 200], (y * w + x) * 3);
    return img;
  };
  const o = checks.expandEdges({ original: stripes(OW), take: stripes(TW), offset: [0, 0], sides: SIDES, blend: BLEND });
  assert.equal(o.repeated, false, JSON.stringify(o));
  assert.equal(o.step_ok, true, JSON.stringify(o));
});

test("extend landing: a feathered band wider than the overlap, eased; the original untouched past it", () => {
  assert.equal(pixels.blendWidth({ width: 1536, height: 1024 }, 32), 61, "6% of the short side");
  assert.equal(pixels.blendWidth({ width: 200, height: 200 }, 32), 32, "never under the overlap");
  const m = pixels.expandPlacementMask(BOX, OLD, SIDES, 32, BLEND);
  assert.equal(m.data[100 * TW + 350], 255, "new area");
  assert.equal(m.data[100 * TW + OW - 1 - BLEND], 0, "past the band");
  const near = m.data[100 * TW + OW - 3];
  const far = m.data[100 * TW + OW - BLEND + 2];
  assert.ok(near > 240 && far < 15 && far > 0, near + " " + far);
});

test("extend landing: tone matching hides a step at the old edge; pixels past the band stay the original's", () => {
  // The redrawn frame is 28 levels lighter everywhere (the model's tone).
  const take = lake(TW, { seed: 2 });
  for (let i = 0; i < take.data.length; i++) take.data[i] = Math.min(255, take.data[i] + 28);
  const mask = pixels.expandPlacementMask(BOX, OLD, SIDES, 32, BLEND);
  const before = edges(take);
  assert.equal(before.step_ok, false, "untreated, the join shows: " + before.step);
  const tm = blend.toneMatch(take, ORIGINAL, { box: BOX, context_box: OLD, old: OLD, sides: SIDES, blend: BLEND });
  assert.equal(tm.applied, true);
  assert.ok(Math.abs(tm.shift[0] + 28) < 3, JSON.stringify(tm.shift));
  const after = edges(tm.image);
  assert.equal(after.step_ok, true, "matched, the join is hidden: " + after.step);
  // The composite: no step across the old edge in the sky.
  const c = composite(tm.image, mask);
  const at = (x, y) => c[(y * TW + x) * 3];
  const jump = Math.abs(at(OW + 2, 60) - at(OW - 3, 60));
  assert.ok(jump < 8, "jump at the edge " + jump);
  // Far out in the new area the model's own tone stays.
  assert.equal(tm.image.data[(60 * TW + 399) * 3], take.data[(60 * TW + 399) * 3]);
  // Past the band the composite is the original, unchanged.
  for (const x of [0, 100, OW - BLEND - 2]) for (const y of [10, 60, 170]) assert.equal(c[(y * TW + x) * 3 + 1], ORIGINAL.data[(y * OW + x) * 3 + 1]);
});

test("extend landing: a take that already matches is left as it is", () => {
  const take = lake(TW, { seed: 2 });
  const tm = blend.toneMatch(take, ORIGINAL, { box: BOX, context_box: OLD, old: OLD, sides: SIDES, blend: BLEND });
  assert.equal(tm.applied, false);
  assert.equal(tm.image, take);
});
