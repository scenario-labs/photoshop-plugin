"use strict";
// M6 agent tools: a canvas size change between an edit's capture and its
// landing. The masked landings refuse with DocumentChanged and name the route
// that still lands the paid result, and that route (new_document) lands it.

const test = require("node:test");
const assert = require("node:assert/strict");
const { bootGenerate, FLARE } = require("../helpers/generate-sim.js");
const { waitFor } = require("../helpers/fakes.js");
const png = require("../../plugin/src/util/png.js");

const DOC = { id: 7, title: "kite.psd", width: 1024, height: 1024, selection: { left: 384, top: 384, width: 256, height: 256 } };
const A = { session: "sess-a", client_name: "claude-code", connected_at: "2026-10-23T10:00:00.000Z" };

function cost(cu) {
  return { status: 200, body: { creativeUnitsCost: cu, creativeUnitsDiscount: 0, costDetails: { "custom-generation": cu } } };
}

async function readyEdit(t) {
  let ps;
  const take = () => {
    const img = ps.composite(7, { left: 256, top: 256, width: 512, height: 512 }, 512, 512);
    return Buffer.from(png.encodePng({ width: img.width, height: img.height, channels: img.components, data: img.data }));
  };
  const cdn = (r) => (/Take1$/.test(decodeURIComponent(r.path.split("/")[2] || "")) ? { status: 200, body: take(), headers: { "content-type": "image/png" } } : undefined);
  const sim = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true }, mockOpts: { cdn, answer: (model) => (model === FLARE ? cost(3) : undefined) } });
  ps = sim.ps;
  const { app } = sim;
  const h = app.agentTools.handlers;
  await app.settings.setSwitch("agents_may_modify", true);
  const cap = await h.capture_reference({ source: "selection", sample: "all_visible", purpose: "edit", model_id: FLARE }, A);
  const up = await h.upload_reference({ capture_id: cap.capture_id }, A);
  await waitFor(() => app.approvals.showing().some((c) => c.kind === "upload"), { label: "upload card" });
  await app.approvals.approve(app.approvals.showing().find((c) => c.kind === "upload").id);
  for (const id of Object.values(up.reference_ids)) await waitFor(async () => (await h.reference_upload_status({ reference_id: id }, A)).state === "imported", { label: "imported" });
  const params = { prompt: "a red paper lantern", ...cap.parameters };
  const q = await h.estimate_cost({ lane: "edit", model_id: FLARE, capture_id: cap.capture_id, parameters: params, takes: 1 }, A);
  const g = await h.generate({ lane: "edit", model_id: FLARE, parameters: params, quote_id: q.quote_id, approved_cost: q.cu_cost_exact, idempotency_key: "canvas-change-1" }, A);
  await waitFor(() => app.approvals.showing().some((c) => c.kind === "spend"), { label: "spend card" });
  await app.approvals.approve(app.approvals.showing().find((c) => c.kind === "spend").id);
  const done = await waitFor(async () => { const w = await h.wait_for_job({ local_id: g.local_id, timeout: 1 }, A); return w.status === "ready" ? w : null; }, { label: "ready", timeout: 10000 });
  return { sim, h, g, done };
}

test("after a canvas size change, edit_selection refuses with DocumentChanged and points to new_document, which lands the result", async (t) => {
  const { sim, h, g, done } = await readyEdit(t);
  sim.ps.doc(7).width = 1152;
  await assert.rejects(
    () => h.prepare_result_application({ local_id: g.local_id, expected_revision: done.revision, purpose: "edit_selection" }, A),
    (e) => e.type === "DocumentChanged" && /new_document/.test(e.message) && !/new_layer/.test(e.message)
  );
  const prep = await h.prepare_result_application({ local_id: g.local_id, purpose: "new_document" }, A);
  const ap = await h.apply_result_application({ application_id: prep.application_id }, A);
  assert.equal(ap.outcome, "committed");
});
