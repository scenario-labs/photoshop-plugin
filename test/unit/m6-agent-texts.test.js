"use strict";
// M6 agent tools, found by the skills review (round 4): what the agent and
// the person read about a landing. job_status.error names the agent's route,
// not a panel button; the proposal card says a take lands unmasked; an
// expand's review and card say where the canvas grows.

const test = require("node:test");
const assert = require("node:assert/strict");
const { bootGenerate, FLARE } = require("../helpers/generate-sim.js");
const { REFRAME } = require("../helpers/reframe-record.js");
const { waitFor } = require("../helpers/fakes.js");
const png = require("../../plugin/src/util/png.js");

const A = { session: "sess-a", client_name: "claude-code", connected_at: "2026-10-23T10:00:00.000Z" };
const SEL = { left: 768, top: 768, width: 512, height: 512 };
const BOX = { left: 512, top: 512, width: 1024, height: 1024 };
const PLAIN = { id: 7, title: "kite.psd", width: 2048, height: 2048, selection: SEL };
const WIDE = { id: 7, title: "wide.psd", width: 1024, height: 768 };

function cost(cu) {
  return { status: 200, body: { creativeUnitsCost: cu, creativeUnitsDiscount: 0, costDetails: { "custom-generation": cu } } };
}

function pngOf(img) {
  return Buffer.from(png.encodePng({ width: img.width, height: img.height, channels: img.components, data: img.data }));
}

function flat(w, h, rgb) {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(rgb, i * 3);
  return { width: w, height: h, components: 3, data };
}

function cdnFor(take) {
  return (r) => (/Take1$/.test(decodeURIComponent(r.path.split("/")[2] || "")) ? { status: 200, body: take(), headers: { "content-type": "image/png" } } : undefined);
}

// Capture, upload card, quote, generate, spend card, ready.
async function run(sim, capArgs, lane, model, key) {
  const { app } = sim;
  const h = app.agentTools.handlers;
  const cap = await h.capture_reference(capArgs, A);
  const up = await h.upload_reference({ capture_id: cap.capture_id }, A);
  await waitFor(() => app.approvals.showing().some((c) => c.kind === "upload"), { label: "upload card" });
  await app.approvals.approve(app.approvals.showing().find((c) => c.kind === "upload").id);
  for (const id of Object.values(up.reference_ids)) await waitFor(async () => (await h.reference_upload_status({ reference_id: id }, A)).state === "imported", { label: "imported" });
  const params = { prompt: "more of the same scene", ...cap.parameters };
  const q = await h.estimate_cost({ lane, model_id: model, capture_id: cap.capture_id, parameters: params, takes: 1 }, A);
  const g = await h.generate({ lane, model_id: model, parameters: params, quote_id: q.quote_id, approved_cost: q.cu_cost_exact, idempotency_key: key }, A);
  await waitFor(() => app.approvals.showing().some((c) => c.kind === "spend"), { label: "spend card" });
  await app.approvals.approve(app.approvals.showing().find((c) => c.kind === "spend").id);
  const done = await waitFor(async () => {
    const w = await h.wait_for_job({ local_id: g.local_id, timeout: 1 }, A);
    return w.status === "ready" ? w : null;
  }, { label: "ready", timeout: 20000 });
  return { h, g, done };
}

async function bootEdit(t, key) {
  let ps;
  const take = () => {
    const img = ps.composite(7, BOX, 1024, 1024);
    return pngOf(img);
  };
  const sim = await bootGenerate(t, { docs: [PLAIN], active: 7, psOpts: { scene: true }, mockOpts: { cdn: cdnFor(take), answer: (model) => (model === FLARE ? cost(3) : undefined) } });
  ps = sim.ps;
  const r = await run(sim, { source: "selection", sample: "all_visible", purpose: "edit", model_id: FLARE }, "edit", FLARE, key);
  return { sim, ...r };
}

test("job_status.error after a canvas change names new_document, not the panel's Place unmasked", async (t) => {
  const { sim, h, g, done } = await bootEdit(t, "agent-texts-1");
  await sim.app.settings.setSwitch("agents_may_modify", true);
  const prep = await h.prepare_result_application({ local_id: g.local_id, expected_revision: done.revision, purpose: "edit_selection" }, A);
  sim.ps.doc(7).width = 2304;
  await assert.rejects(() => h.apply_result_application({ application_id: prep.application_id }, A), (e) => e.type === "DocumentChanged");
  const js = await h.job_status({ local_id: g.local_id }, A);
  assert.ok(js.error, "the job carries the error");
  assert.match(js.error, /new_document/);
  assert.doesNotMatch(js.error, /Place unmasked|Open as document/);
});

test("with the modify switch off, the proposal card says a take lands unmasked after the selection mask is gone", async (t) => {
  const { sim, h, g, done } = await bootEdit(t, "agent-texts-2");
  const memo = sim.app.runner.memoFor(g.local_id);
  for (const k of Object.keys(memo)) delete memo[k];
  const prep = await h.prepare_result_application({ local_id: g.local_id, expected_revision: done.revision, purpose: "edit_selection" }, A);
  assert.ok(prep.warnings.includes("lands_unmasked"));
  const ap = await h.apply_result_application({ application_id: prep.application_id }, A);
  assert.equal(ap.outcome, "pending_approval");
  const card = sim.app.approvals.showing().find((c) => c.kind === "proposal");
  assert.ok(card.lines.some((l) => /Lands unmasked/.test(l)), JSON.stringify(card.lines));
});

test("an expand's review and proposal card say where the canvas grows, so a wrong anchor shows before Apply", async (t) => {
  const sim = await bootGenerate(t, { docs: [WIDE], active: 7, psOpts: { scene: true }, mockOpts: { extraRecords: { [REFRAME.id]: REFRAME }, cdn: cdnFor(() => pngOf(flat(1365, 768, [90, 140, 220]))), answer: () => cost(3) } });
  const { h, g, done } = await run(sim, { purpose: "expand", model_id: REFRAME.id, expand: { aspect: "16:9", anchor: "left" } }, "expand", REFRAME.id, "agent-texts-3");
  const prep = await h.prepare_result_application({ local_id: g.local_id, expected_revision: done.revision, purpose: "expand" }, A);
  assert.match(prep.review, /grows to 1365 x 768: 341 px right\./);
  assert.doesNotMatch(prep.review, /px left/);
  await h.apply_result_application({ application_id: prep.application_id }, A);
  const card = sim.app.approvals.showing().find((c) => c.kind === "proposal");
  assert.ok(card.lines.some((l) => /341 px right/.test(l)), JSON.stringify(card.lines));
});
