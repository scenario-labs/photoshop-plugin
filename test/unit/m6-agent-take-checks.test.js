"use strict";
// M6 agent tools, found by the skills review: inspect_result_previews tells a
// take the model redrew around the edit from a misaligned one (shift_px and
// the takes card's badges); prepare warns when the selection mask is gone
// after a reload and refuses a masked landing whose document is gone; an
// application refused before anything was placed can be applied again.

const test = require("node:test");
const assert = require("node:assert/strict");
const { bootGenerate, FLARE } = require("../helpers/generate-sim.js");
const { createWorld } = require("../helpers/restart-sim.js");
const { waitFor } = require("../helpers/fakes.js");
const png = require("../../plugin/src/util/png.js");

const A = { session: "sess-a", client_name: "claude-code", connected_at: "2026-10-23T10:00:00.000Z" };
const SEL = { left: 768, top: 768, width: 512, height: 512 };
const BOX = { left: 512, top: 512, width: 1024, height: 1024 };

function cost(cu) {
  return { status: 200, body: { creativeUnitsCost: cu, creativeUnitsDiscount: 0, costDetails: { "custom-generation": cu } } };
}

function pngOf(img) {
  return Buffer.from(png.encodePng({ width: img.width, height: img.height, channels: img.components, data: img.data }));
}

// The capture box with a red square over the selection, as a model edit.
function paint(img) {
  const out = { ...img, data: Uint8Array.from(img.data) };
  for (let y = 352; y < 672; y++) for (let x = 352; x < 672; x++) for (let c = 0; c < 3; c++) out.data[(y * img.width + x) * img.components + c] = [200, 40, 30][c];
  return out;
}

// Smooth value noise, so the texture survives the checks' downscale.
function field(n, cell, amp, seed) {
  let s = seed;
  const g = Math.ceil(n / cell) + 2;
  const grid = new Float64Array(g * g);
  for (let i = 0; i < grid.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    grid[i] = ((s >>> 24) / 255) * amp;
  }
  const out = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const gx = x / cell;
      const gy = y / cell;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      const v = (a, b) => grid[b * g + a];
      out[y * n + x] = v(x0, y0) * (1 - fx) * (1 - fy) + v(x0 + 1, y0) * fx * (1 - fy) + v(x0, y0 + 1) * (1 - fx) * fy + v(x0 + 1, y0 + 1) * fx * fy;
    }
  }
  return out;
}

function texturedDoc() {
  const N = 2048;
  const base = field(N, 24, 200, 7);
  const data = new Uint8Array(N * N * 3);
  for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) data[i * 3 + c] = Math.min(255, base[i] + 20 + c * 10);
  return { id: 7, title: "texture.psd", width: N, height: N, selection: SEL, layers: [{ name: "Background", background: true, content: "raster", raster: { width: N, height: N, data } }] };
}

// The same layout with new fine structure around the edit: a re-render.
const REDRAW = field(1024, 20, 90, 11);
function rerender(img) {
  const out = { ...img, data: Uint8Array.from(img.data) };
  for (let p = 0; p < img.width * img.height; p++) for (let c = 0; c < 3; c++) out.data[p * img.components + c] = Math.max(0, Math.min(255, img.data[p * img.components + c] + REDRAW[p] - 45));
  return out;
}

// Everything moved dx pixels to the right: a misaligned take.
function shifted(img, dx) {
  const out = { ...img, data: Uint8Array.from(img.data) };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sx = Math.max(0, x - dx);
      for (let c = 0; c < img.components; c++) out.data[(y * img.width + x) * img.components + c] = img.data[(y * img.width + sx) * img.components + c];
    }
  }
  return out;
}

function cdnFor(takes) {
  return (r) => {
    const m = /Take(\d+)$/.exec(decodeURIComponent(r.path.split("/")[2] || ""));
    if (!m || !takes[Number(m[1]) - 1]) return undefined;
    return { status: 200, body: takes[Number(m[1]) - 1](), headers: { "content-type": "image/png" } };
  };
}

// Capture, upload card, quote, generate, spend card, ready. sim: a booted
// generate-sim or restart-sim instance; key: the idempotency key.
async function runEdit(sim, takes, key) {
  const { app } = sim;
  const h = app.agentTools.handlers;
  await app.settings.setSwitch("agents_may_modify", true);
  const cap = await h.capture_reference({ source: "selection", sample: "all_visible", purpose: "edit", model_id: FLARE }, A);
  const up = await h.upload_reference({ capture_id: cap.capture_id }, A);
  await waitFor(() => app.approvals.showing().some((c) => c.kind === "upload"), { label: "upload card" });
  await app.approvals.approve(app.approvals.showing().find((c) => c.kind === "upload").id);
  for (const id of Object.values(up.reference_ids)) await waitFor(async () => (await h.reference_upload_status({ reference_id: id }, A)).state === "imported", { label: "imported" });
  const params = { prompt: "a red paper lantern", ...cap.parameters };
  const q = await h.estimate_cost({ lane: "edit", model_id: FLARE, capture_id: cap.capture_id, parameters: params, takes }, A);
  const g = await h.generate({ lane: "edit", model_id: FLARE, parameters: params, quote_id: q.quote_id, approved_cost: q.cu_cost_exact, idempotency_key: key }, A);
  await waitFor(() => app.approvals.showing().some((c) => c.kind === "spend"), { label: "spend card" });
  await app.approvals.approve(app.approvals.showing().find((c) => c.kind === "spend").id);
  const done = await waitFor(async () => {
    const w = await h.wait_for_job({ local_id: g.local_id, timeout: 1 }, A);
    return w.status === "ready" ? w : null;
  }, { label: "ready", timeout: 20000 });
  return { h, g, done };
}

async function bootEdit(t, doc, takeFns, key) {
  let ps;
  const ctx = () => ps.composite(7, BOX, 1024, 1024);
  const sim = await bootGenerate(t, { docs: [doc], active: 7, psOpts: { scene: true }, mockOpts: { cdn: cdnFor(takeFns.map((f) => () => pngOf(f(ctx())))), answer: (model) => (model === FLARE ? cost(3) : undefined) } });
  ps = sim.ps;
  return { sim, ...(await runEdit(sim, takeFns.length, key)) };
}

const PLAIN = { id: 7, title: "kite.psd", width: 2048, height: 2048, selection: SEL };

test("inspect_result_previews: a take redrawn around the edit reads seam_ok false with no shift and the badge Re-rendered around the edit; a moved take reads May be misaligned", async (t) => {
  const { h, g } = await bootEdit(t, texturedDoc(), [(c) => paint(rerender(c)), (c) => paint(shifted(c, 4))], "take-checks-1");
  const { takes } = await h.inspect_result_previews({ local_id: g.local_id }, A);
  const [redrawn, moved] = takes;
  assert.equal(redrawn.seam_ok, false);
  assert.ok(redrawn.shift_px < 1, String(redrawn.shift_px));
  assert.ok(redrawn.badges.includes("Re-rendered around the edit"), JSON.stringify(redrawn.badges));
  assert.ok(!redrawn.badges.includes("May be misaligned"));
  assert.ok(moved.shift_px >= 1, String(moved.shift_px));
  assert.ok(moved.badges.includes("May be misaligned"), JSON.stringify(moved.badges));
});

test("prepare warns lands_unmasked when the selection mask is gone (as after a panel reload), and the take lands unmasked", async (t) => {
  const { sim, h, g, done } = await bootEdit(t, PLAIN, [paint], "take-checks-2");
  const first = await h.prepare_result_application({ local_id: g.local_id, expected_revision: done.revision, purpose: "edit_selection" }, A);
  assert.ok(!first.warnings.includes("lands_unmasked"));
  const memo = sim.app.runner.memoFor(g.local_id);
  for (const k of Object.keys(memo)) delete memo[k];
  const prep = await h.prepare_result_application({ local_id: g.local_id, purpose: "edit_selection" }, A);
  assert.ok(prep.warnings.includes("lands_unmasked"), JSON.stringify(prep.warnings));
  assert.match(prep.review, /Unmasked/);
  const ap = await h.apply_result_application({ application_id: prep.application_id }, A);
  assert.equal(ap.outcome, "committed");
  assert.equal(ap.outside_check, null);
  assert.ok(ap.notes.some((n) => /unmasked/i.test(n)), JSON.stringify(ap.notes));
});

test("apply_result_application refused with PhotoshopBusy can be called again with the same application_id", async (t) => {
  const { sim, h, g, done } = await bootEdit(t, PLAIN, [paint], "take-checks-3");
  const prep = await h.prepare_result_application({ local_id: g.local_id, expected_revision: done.revision, purpose: "edit_selection" }, A);
  const real = sim.app.runner.place;
  sim.app.runner.place = async () => {
    const e = new Error("modal state held");
    e.busy = true;
    throw e;
  };
  await assert.rejects(() => h.apply_result_application({ application_id: prep.application_id }, A), (e) => e.type === "PhotoshopBusy");
  sim.app.runner.place = real;
  const ap = await h.apply_result_application({ application_id: prep.application_id }, A);
  assert.equal(ap.outcome, "committed");
  await assert.rejects(() => h.apply_result_application({ application_id: prep.application_id }, A), (e) => e.type === "ApplicationUsed");
});

test("after a restart, an edit whose unsaved document is gone refuses edit_selection with DocumentClosed instead of landing over the document in front; new_document lands it", async (t) => {
  let ps;
  const ctx = () => ps.composite(7, BOX, 1024, 1024);
  const world = await createWorld(t, { mockOpts: { cdn: cdnFor([() => pngOf(paint(ctx()))]), answer: (model) => (model === FLARE ? cost(3) : undefined) } });
  const i1 = await world.boot({ docs: [PLAIN], active: 7, signIn: true, psOpts: { scene: true } });
  ps = i1.ps;
  const { g } = await runEdit(i1, 1, "take-checks-4");
  i1.quit();
  const i2 = await world.boot({ docs: [{ id: 7, title: "Other poster.psd", width: 2048, height: 2048 }], active: 7, psOpts: { scene: true } });
  await i2.app.settings.setSwitch("agents_may_modify", true);
  const h2 = i2.app.agentTools.handlers;
  const js = await h2.job_status({ local_id: g.local_id }, A);
  await assert.rejects(
    () => h2.prepare_result_application({ local_id: g.local_id, expected_revision: js.revision, purpose: "edit_selection" }, A),
    (e) => e.type === "DocumentClosed" && /new_document/.test(e.message)
  );
  const layers = i2.ps.doc(7).layers.length;
  const prep = await h2.prepare_result_application({ local_id: g.local_id, purpose: "new_document" }, A);
  const ap = await h2.apply_result_application({ application_id: prep.application_id }, A);
  assert.equal(ap.outcome, "committed");
  assert.equal(i2.ps.doc(7).layers.length, layers, "the document in front is unchanged");
});
