"use strict";
// The mask strategy of 2026-10-20 (research: Mask Strategy Test, Plugin
// changes): Replace inside on Ideogram 4.5 Precise Edit, Remove on Ideogram
// 4.5 with aspectRatio auto and no size sent, GPT Image 2.5 as the Bolder
// choice with mask growth, and the shift measure that keeps a re-render
// from reading as misaligned. Synthetic pixels with known overflow and
// known shifts; schemas from the recorded model records.

const test = require("node:test");
const assert = require("node:assert/strict");
const grow = require("../../plugin/src/apply/grow.js");
const checks = require("../../plugin/src/apply/checks.js");
const map = require("../../plugin/src/catalog/map.js");
const schemaMod = require("../../plugin/src/forms/schema.js");
const editMod = require("../../plugin/src/lanes/edit.js");
const common = require("../../plugin/src/lanes/common.js");
const xmp = require("../../plugin/src/util/xmp.js");
const { records } = require("../helpers/fixture-scenario.js");

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

function noisy(img, amp, seed = 7) {
  let s = seed;
  const data = Uint8Array.from(img.data, (v) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return Math.max(0, Math.min(255, v + ((s >>> 16) % (2 * amp + 1)) - amp));
  });
  return { ...img, data };
}

function square(l, t, r, b) {
  const data = new Uint8Array(W * H);
  for (let y = t; y < b; y++) for (let x = l; x < r; x++) data[y * W + x] = 255;
  return { width: W, height: H, data };
}

function paint(img, inside, color) {
  const data = Uint8Array.from(img.data);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x, y)) data.set(color, (y * W + x) * 3);
  return { ...img, data };
}

const SEL = square(64, 64, 192, 192);
const inSel = (x, y) => x >= 64 && x < 192 && y >= 64 && y < 192;
const count = (m) => m.data.reduce((n, v) => n + (v >= 128 ? 1 : 0), 0);

test("grow: a subject drawn past the selection grows the mask over it, connected to the selection", () => {
  const context = scene();
  // The new subject: a red disc of radius 80 around the selection's center,
  // so four caps (16 px deep) fall outside the square selection.
  const take = noisy(paint(context, (x, y) => (x - 128) ** 2 + (y - 128) ** 2 <= 80 * 80, [210, 30, 30]), 3);
  const g = grow.growMask(context, take, SEL, { scale: 1, margin: 96, sel_long: 128 });
  assert.equal(g.applied, true);
  assert.equal(g.capped, false);
  assert.ok(g.grown_pct >= 15 && g.grown_pct <= 60, `grown ${g.grown_pct}%`);
  // The cap below the selection is inside the grown mask; the selection
  // stays whole; a far corner is not taken.
  assert.equal(g.mask.data[(128 + 74) * W + 128], 255, "cap covered");
  for (const [x, y] of [[64, 64], [191, 191], [128, 128]]) assert.equal(g.mask.data[y * W + x], 255);
  assert.equal(g.mask.data[10 * W + 10], 0, "far corner kept out");
  assert.ok(count(g.mask) > count(SEL));
});

test("grow: a take shifted by 3 px with an edit inside does not grow; a re-render with noise does not either", () => {
  const shifted = paint(scene((x) => x + 3), inSel, [30, 160, 60]);
  const a = grow.growMask(scene(), shifted, SEL, { scale: 1, margin: 96, sel_long: 128 });
  assert.equal(a.applied, false);
  assert.equal(a.grown_pct, 0);
  const rerender = noisy(paint(scene(undefined, undefined, [6, -4, 3]), inSel, [30, 160, 60]), 5);
  const b = grow.growMask(scene(), rerender, SEL, { scale: 1, margin: 96, sel_long: 128 });
  assert.equal(b.applied, false);
  assert.deepEqual(b.mask.data, Uint8Array.from(SEL.data));
});

test("grow: growth over 60% of the selection is capped and not applied", () => {
  const context = scene();
  // A band across the whole picture: the selection's height, every column.
  const take = paint(context, (x, y) => y >= 64 && y < 192, [220, 220, 20]);
  const g = grow.growMask(context, take, SEL, { scale: 1, margin: 120, sel_long: 128 });
  assert.equal(g.capped, true);
  assert.equal(g.applied, false);
  assert.ok(g.grown_pct > 60, `grown ${g.grown_pct}%`);
  assert.deepEqual(g.mask.data, Uint8Array.from(SEL.data), "the take lands on the selection");
});

test("grow: the placement mask follows the grown mask at document size and keeps the selection's", () => {
  const grown = square(48, 48, 208, 208);
  const base = { left: 100, top: 50, width: 512, height: 512, data: new Uint8Array(512 * 512) };
  for (let y = 128; y < 384; y++) for (let x = 128; x < 384; x++) base.data[y * 512 + x] = 255;
  const p = grow.placementOf(grown, base, 2);
  assert.equal(p.left, 100);
  assert.equal(p.width, 512);
  assert.equal(p.data[110 * 512 + 256], 255, "grown part, at twice the check size");
  assert.equal(p.data[20 * 512 + 20], 0);
  assert.equal(p.data[200 * 512 + 200], 255);
});

test("shift: a 3 px shift measures about 3 px; a re-render with no shift measures under 1 px", () => {
  const context = scene();
  const sel = square(100, 100, 156, 156);
  const shifted = checks.shiftOf(context, scene((x) => x + 3), sel, 1);
  assert.ok(shifted >= 2.5 && shifted <= 3.5, `shift ${shifted}`);
  const rerender = checks.shiftOf(context, noisy(scene(undefined, undefined, [8, -6, 4]), 6), sel, 1);
  assert.ok(rerender !== null && rerender < 1, `shift ${rerender}`);
  // At a check scale of 0.5, 3 check px are 6 document px.
  assert.ok(Math.abs(checks.shiftOf(context, scene((x) => x + 3), sel, 0.5) - 6) <= 1);
  // Nothing textured far from the mask: no measure.
  const flat = { width: W, height: H, components: 3, data: new Uint8Array(W * H * 3).fill(120) };
  assert.equal(checks.shiftOf(flat, flat, sel, 1), null);
});

test("badges: a high ring residual without a shift is Re-rendered around the edit, never May be misaligned", () => {
  const rough = { edited: true, inside_mean: 40, seam: { bias: 3, residual: 9 }, seam_ok: false, aspect_ok: true, shift_px: 0.2 };
  assert.deepEqual(checks.badges(rough, null, { masked: true }), ["Re-rendered around the edit"]);
  assert.ok(checks.badges({ ...rough, shift_px: 1.4 }, null, { masked: true }).includes("May be misaligned"));
  assert.ok(checks.badges({ ...rough, shift_px: 0.2, aspect_ok: false }, null, { masked: true }).includes("May be misaligned"));
  // No measure (nothing textured): the residual decides, as before.
  assert.ok(checks.badges({ ...rough, shift_px: null }, null, { masked: true }).includes("May be misaligned"));
  // A full check on a shifted take still says misaligned.
  const context = scene();
  const sel = square(100, 100, 156, 156);
  const c = checks.check({ context, result: paint(scene((x) => x + 3), (x, y) => x >= 100 && x < 156 && y >= 100 && y < 156, [30, 160, 60]), mask: sel, scale: 1, masked: true });
  assert.ok(c.shift_px >= 2.5, `shift ${c.shift_px}`);
  assert.ok(checks.badges(c, null, { masked: true }).includes("May be misaligned"));
});

test("defaults: Replace inside on Precise Edit, Remove on Ideogram 4.5 with aspectRatio auto, unmasked edits stay on Flare", () => {
  assert.deepEqual(map.defaults("replace"), { model_id: "model_ideogram-v4-5-precise-edit", preset: { quality: "medium" }, takes: 2 });
  assert.deepEqual(map.defaults("remove"), { model_id: "model_ideogram-v4-5", preset: { quality: "medium", aspectRatio: "auto" }, takes: 2 });
  assert.equal(map.defaults("edit").model_id, "model_openai-gpt-image-2-5-flare");
  assert.equal(common.defaultModel("replace"), "model_ideogram-v4-5-precise-edit");
  assert.deepEqual(common.presetFor("remove", "model_ideogram-v4-5"), { quality: "medium", aspectRatio: "auto" });
  assert.equal(schemaMod.modelFacts("model_openai-gpt-image-2-5-flare").mask_growth, true);
  assert.equal(!!schemaMod.modelFacts("model_ideogram-v4-5-precise-edit").mask_growth, false);
});

test("schemas: Precise Edit edits in place; Ideogram 4.5 follows its input, white masks, no size sent", () => {
  const pe = schemaMod.normalize(records["model_ideogram-v4-5-precise-edit"]);
  assert.equal(pe.capture_input_name, "image");
  assert.equal(pe.mask_polarity.value, "white");
  assert.equal(pe.size_inputs.kind, "none");
  const i45 = schemaMod.normalize(records["model_ideogram-v4-5"]);
  assert.equal(i45.capture_input_name, "referenceImages");
  assert.equal(i45.mask_polarity.value, "white");
  assert.equal(i45.size_inputs.kind, "none", "follows_input: no aspect ratio from the shape");
  assert.deepEqual(i45.masked_params, { aspectRatio: "auto" });
});

function ctx(w, h, selection) {
  const layer = { id: 1, name: "Background", visible: true, bounds: { left: 0, top: 0, width: w, height: h }, kind: "pixel", background: true, locked: false, has_mask: false };
  return { doc: { id: 7, width: w, height: h, title: "harbor.psd" }, selection, selection_raw: selection, layer };
}

test("edit view: Remove on Ideogram 4.5 sends the mask with aspectRatio auto and no resolution or size", () => {
  const i45 = schemaMod.normalize(records["model_ideogram-v4-5"]);
  const v = editMod.editView(i45, ctx(1600, 1067, { left: 600, top: 400, width: 300, height: 200 }), { prompt: "remove", quality: "medium", expect: "cleared", model_lane: "remove", takes: 2 });
  assert.equal(v.blocked, null);
  assert.equal(v.mask, true);
  assert.equal(v.request.parameters.aspectRatio, "auto");
  assert.equal(v.request.parameters.quality, "medium");
  assert.equal(v.request.parameters.width, undefined);
  assert.equal(v.request.parameters.resolution, undefined);
  assert.equal(v.capture.spec.follows_input, true);
  assert.equal(v.capture.spec.polarity, "white");
  assert.equal(v.request.takes, 2);
  // Unmasked (no selection), no masked params are added beyond the preset.
  const whole = editMod.editView(i45, ctx(1600, 1067, null), { prompt: "p" });
  assert.equal(whole.mask, false);
  assert.equal(whole.request.parameters.aspectRatio, undefined);
});

test("edit view: Replace inside on Precise Edit takes the replace preset and a white mask", () => {
  const pe = schemaMod.normalize(records["model_ideogram-v4-5-precise-edit"]);
  const v = editMod.editView(pe, ctx(1600, 1067, { left: 600, top: 400, width: 300, height: 200 }), { prompt: "a red boat", model_lane: "replace", takes: 2 });
  assert.equal(v.blocked, null);
  assert.equal(v.request.parameters.quality, "medium");
  assert.equal(v.capture.spec.mask_input, "mask");
  assert.equal(v.capture.spec.capture_input, "image");
});

test("xmp: the grown share of a take is recorded per layer", () => {
  const packet = xmp.build({ schema: "1", take: "1", maskGrownPct: "24" });
  assert.equal(xmp.parse(packet).maskGrownPct, "24");
});

test("placing Bolder takes: each take gets its own grown mask, none on the group, the person's selection comes back, the metadata records the growth, one History state", async () => {
  const { webcrypto } = require("node:crypto");
  const hostMod = require("../../plugin/src/host.js");
  const { createFakePhotoshop } = require("../helpers/fake-photoshop.js");
  const { solidPng } = require("../helpers/fixture-scenario.js");
  const ps = createFakePhotoshop({ docs: [{ id: 7, width: 1024, height: 1024, selection: { left: 300, top: 300, width: 200, height: 200 } }], active: 7 });
  const host = hostMod.createHost(ps.require, { setTimeout, clearTimeout, crypto: webcrypto });
  ps.files.set("Scenario/edit/a.png", new Uint8Array(solidPng(1024, 1024)));
  ps.files.set("Scenario/edit/b.png", new Uint8Array(solidPng(1024, 1024)));
  const take = (path, i) => ({ path, asset_id: `asset_t${i}`, name: `Take ${i}`, xmp: xmp.build({ schema: "1", assetId: `asset_t${i}`, take: String(i) }), visible: i === 1, width: 1024, height: 1024, fit: { scale_pct: 100, center_x: 512, center_y: 512, width: 1024, height: 1024 } });
  const sel = { left: 0, top: 0, width: 1024, height: 1024, data: new Uint8Array(1024 * 1024) };
  const grown1 = { left: 0, top: 0, width: 1024, height: 1024, data: new Uint8Array(1024 * 1024).fill(255) };
  const plan = { history_name: "Scenario: Place edit", kind: "edit", document_id: 7, new_document: null, box: { left: 0, top: 0, width: 1024, height: 1024 }, group: { name: "G", xmp: xmp.build({ schema: "1" }) }, mask: sel, takes: [take("Scenario/edit/a.png", 1), take("Scenario/edit/b.png", 2)] };
  const packet = xmp.build({ schema: "1", assetId: "asset_t1", take: "1", maskGrownPct: "24" });
  let asked = 0;
  const out = await host.placeResults(plan, {
    decide: () => {
      asked++;
      return { masks: [grown1, sel], xmp: [packet, null], note: "Kept the new subject whole: the mask grew by 24% past the selection." };
    }
  });
  assert.equal(asked, 1);
  assert.equal(out.masked, true);
  assert.deepEqual(out.notes, ["Kept the new subject whole: the mask grew by 24% past the selection."]);
  const d = ps.doc(7);
  const group = d.layers[0];
  assert.equal(group.kind, "group");
  assert.ok(!group.mask, "no mask on the group: the takes differ");
  assert.equal(group.layers[0].mask.data[0], 255, "take 1 carries its grown mask");
  assert.equal(group.layers[1].mask.data[0], 0, "take 2 keeps the selection's mask");
  assert.equal(xmp.parse(group.layers[0].xmp).maskGrownPct, "24");
  assert.equal(xmp.parse(group.layers[1].xmp).maskGrownPct, undefined);
  assert.ok(d.selection && d.selection.from_mask === group.layers[0].id, "the selection is read back with the selection's mask");
  assert.deepEqual(ps.history, [{ document_id: 7, name: "Scenario: Place edit" }]);
});
