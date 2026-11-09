"use strict";
// Replace inside, Inside selection (2026-10-20 live finding): the model
// lightened the surface all over the elliptical selection, the mask kept
// the original outside, and a lighter oval showed with no badge. The seam
// ring lies outside the mask, where the composite is the original, so the
// check called the edge fine; the Takes card also had no badge for the
// tone it did report. Synthetic pictures copy the case.

const test = require("node:test");
const assert = require("node:assert/strict");
const checks = require("../../plugin/src/apply/checks.js");
const ctlMod = require("../../plugin/src/panel/controller.js");

const W = 256;
const H = 256;

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) & 255) / 255 - 0.5;
}

// A wooden table: a warm gradient with grain.
function table() {
  const data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) [120 + 0.2 * x, 80 + 0.1 * y, 50].forEach((v, c) => (data[(y * W + x) * 3 + c] = Math.round(v + 12 * hash(x + c, y))));
  return { width: W, height: H, components: 3, data };
}

const inEllipse = (x, y) => ((x - 128) / 80) ** 2 + ((y - 128) / 60) ** 2 <= 1;
const MASK = { width: W, height: H, data: Uint8Array.from({ length: W * H }, (_, i) => (inEllipse(i % W, Math.floor(i / W)) ? 255 : 0)) };

// The take: a glass in the middle; `lift` on the surface inside the
// selection; outside the selection the original (Precise Edit).
function take(ctx, lift, glass = (x, y) => Math.abs(x - 128) < 18 && Math.abs(y - 128) < 30) {
  const out = Uint8Array.from(ctx.data);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inEllipse(x, y)) continue;
      const k = (y * W + x) * 3;
      if (glass(x, y)) out.set([210, 220, 150], k);
      else for (let c = 0; c < 3; c++) out[k + c] = Math.min(255, ctx.data[k + c] + lift);
    }
  }
  return { width: W, height: H, components: 3, data: out };
}

function run(result, ctx) {
  const c = checks.check({ context: ctx, result, mask: MASK, scale: 1, masked: true });
  return { c, badges: checks.badges(c, null, { masked: true }) };
}

test("Inside selection: a lighter patch all around the selection edge is flagged, and the Takes card shows it", () => {
  const ctx = table();
  const { c, badges } = run(take(ctx, 26), ctx);
  assert.equal(c.seam.bias, 0, "outside the mask the take is the original, as live");
  assert.equal(c.halo.flag, true, JSON.stringify(c.halo));
  assert.ok(c.halo.tone > 20);
  assert.equal(c.seam_ok, false);
  assert.ok(badges.includes("Lighter patch at the selection edge"), JSON.stringify(badges));
  assert.ok(!badges.includes("Seam ok"));
  assert.deepEqual(ctlMod.badgeOf(badges), { tone: "warn", text: "Edge may show" });
});

test("Inside selection: a clean replacement keeps Edges ok; an object reaching one side of the edge is not a halo", () => {
  const ctx = table();
  const clean = run(take(ctx, 0), ctx);
  assert.equal(clean.c.halo.flag, false, JSON.stringify(clean.c.halo));
  assert.deepEqual(ctlMod.badgeOf(clean.badges), { tone: "ok", text: "Edges ok" });
  // A wide object that reaches the left end of the ellipse only.
  const wide = run(take(ctx, 0, (x, y) => x < 110 && Math.abs(y - 128) < 25), ctx);
  assert.equal(wide.c.halo.flag, false, JSON.stringify(wide.c.halo));
  // A darker patch is named as such.
  const dark = run(take(ctx, -30), ctx);
  assert.ok(dark.badges.includes("Darker patch at the selection edge"), JSON.stringify(dark.badges));
});

test("Takes card: the Extend edge badges show as a warning too", () => {
  assert.deepEqual(ctlMod.badgeOf(["Step at the old edge"]), { tone: "warn", text: "Edge may show" });
  assert.deepEqual(ctlMod.badgeOf(["Repeated detail past the old edge"]), { tone: "warn", text: "Edge may show" });
});
