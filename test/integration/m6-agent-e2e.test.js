"use strict";
// M6 end to end under Node: a real helper process speaking MCP over stdio,
// the whole plugin (main.js boot on host.js over the fake Photoshop), the
// fixture Scenario. An agent reads the document, makes a selection, prices
// and asks to spend; the panel's own approve path sends it; the result lands
// through prepare and apply as one History state with the Scenario metadata;
// a second request is declined and spends nothing.

const test = require("node:test");
const assert = require("node:assert/strict");
const xmp = require("../../plugin/src/util/xmp.js");
const { spawnHelper } = require("../helpers/mcp-client.js");
const { bootGenerate, FLARE } = require("../helpers/generate-sim.js");
const { waitFor } = require("../helpers/fakes.js");

const POSTER = { id: 7, title: "poster.psd", width: 1024, height: 1024 };

function flarePrice() {
  return (model, body) => (model !== FLARE ? null : { status: 269, body: { creativeUnitsCost: 1 + (Number(body.numOutputs) || 1), creativeUnitsDiscount: 0, costDetails: { "custom-generation": 2 } } });
}

test("an agent session through a real helper: read, select, price, approval card, approve, land in one History state; a declined request spends nothing", async (t) => {
  const w = await bootGenerate(t, { docs: [POSTER], active: 7, mockOpts: { answer: flarePrice() } });
  const { app, ps, mock } = w;
  await app.settings.setSwitch("agents_may_modify", true);
  const h = spawnHelper({ env: { SCENARIO_PHOTOSHOP_PORT: String(w.port), SCENARIO_PHOTOSHOP_TOKEN: w.token } });
  t.after(async () => h.close());
  await h.initialize("claude-code");
  await waitFor(async () => (await h.status()).connected, { label: "linked", timeout: 8000, interval: 100 });
  async function call(name, args) {
    const r = await h.request("tools/call", { name, arguments: args });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    return r.result;
  }
  async function ok(name, args) {
    const r = await call(name, args);
    assert.notEqual(r.isError, true, `${name}: ${JSON.stringify(r.content)}`);
    return r.structuredContent;
  }
  const s = await ok("document_summary", {});
  assert.equal(s.document.title, "poster.psd");
  const p = await call("preview_document", { max_px: 200 });
  assert.equal(p.content[0].type, "image");
  assert.equal(p.content[0].mimeType, "image/jpeg");
  assert.equal(p.structuredContent._images, undefined);
  const sel = await ok("set_selection", { rect: [100, 100, 300, 200] });
  assert.deepEqual(sel.selection.bounds, [100, 100, 300, 200]);
  const params = { prompt: "a red kite", numOutputs: 1 };
  const q = await ok("estimate_cost", { model_id: FLARE, lane: "image", parameters: params, canvas: { document_id: 7 } });
  const g = await ok("generate", { lane: "image", model_id: FLARE, quote_id: q.quote_id, approved_cost: q.cu_cost_exact, parameters: params, idempotency_key: "e2e-key-0001" });
  assert.equal(g.status, "awaiting_approval");
  // The card shows in the panel with the client's name; the panel approves.
  await waitFor(() => app.controller.model().composer.agent, { label: "F5 card" });
  assert.equal(app.controller.model().composer.agent.client_name, "claude-code");
  assert.equal(mock.paidCalls.length, 0);
  app.controller.agentDecision(true);
  const done = await ok("wait_for_job", { local_id: g.local_id, timeout: 20 });
  assert.equal(done.status, "ready");
  assert.equal(mock.paidCalls.length, 1);
  const prep = await ok("prepare_result_application", { local_id: g.local_id, expected_revision: done.revision, purpose: "new_layer", target: { document_id: 7 } });
  const history = ps.history.length;
  const applied = await ok("apply_result_application", { application_id: prep.application_id });
  assert.equal(applied.outcome, "committed");
  assert.equal(ps.history.length, history + 1, "one History state");
  assert.match(ps.history[ps.history.length - 1].name, /^Scenario agent: /);
  const layer = ps.doc(7).layers.find((l) => applied.layer_ids.includes(l.id));
  assert.ok(xmp.parse(layer.xmp).assetId, "layer XMP carries the asset id");
  // Declined: nothing spent, and the agent reads why.
  const params2 = { prompt: "a blue kite", numOutputs: 1 };
  const q2 = await ok("estimate_cost", { model_id: FLARE, lane: "image", parameters: params2, canvas: { document_id: 7 } });
  const g2 = await ok("generate", { lane: "image", model_id: FLARE, quote_id: q2.quote_id, approved_cost: q2.cu_cost_exact, parameters: params2, idempotency_key: "e2e-key-0002" });
  await waitFor(() => app.controller.model().composer.agent, { label: "second card" });
  app.controller.agentDecision(false);
  const st = await ok("wait_for_job", { local_id: g2.local_id, timeout: 10 });
  assert.equal(st.status, "not_sent");
  assert.match(st.error, /^SpendDeclined/);
  assert.equal(mock.paidCalls.length, 1, "the declined request spent nothing");
  // Errors travel as one line.
  const off = await call("execute_batchplay", { descriptors: [{ _obj: "invert" }] });
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /^SwitchOff: /);
});

test("an edit through a real helper: capture the selection, the upload card, price the capture, approve, land masked in the selection as one History state", async (t) => {
  const w = await bootGenerate(t, { docs: [{ ...POSTER, selection: { left: 256, top: 256, width: 256, height: 256 } }], active: 7, mockOpts: { answer: flarePrice() } });
  const { app, ps, mock } = w;
  await app.settings.setSwitch("agents_may_modify", true);
  const h = spawnHelper({ env: { SCENARIO_PHOTOSHOP_PORT: String(w.port), SCENARIO_PHOTOSHOP_TOKEN: w.token } });
  t.after(async () => h.close());
  await h.initialize("claude-code");
  await waitFor(async () => (await h.status()).connected, { label: "linked", timeout: 8000, interval: 100 });
  async function ok(name, args) {
    const r = await h.request("tools/call", { name, arguments: args });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.notEqual(r.result.isError, true, `${name}: ${JSON.stringify(r.result.content)}`);
    return r.result.structuredContent;
  }
  const cap = await ok("capture_reference", { purpose: "edit", source: "selection", model_id: FLARE });
  assert.ok(cap.capture_id);
  assert.ok(cap.parts.includes("context"));
  const up = await ok("upload_reference", { capture_id: cap.capture_id });
  assert.equal(up.state, "awaiting_approval");
  await waitFor(() => app.approvals.showing().some((c) => c.kind === "upload"), { label: "upload card" });
  await app.approvals.approve(app.approvals.showing().find((c) => c.kind === "upload").id);
  const refs = Object.values(up.reference_ids);
  await waitFor(async () => {
    for (const id of refs) if ((await ok("reference_upload_status", { reference_id: id })).state !== "imported") return false;
    return true;
  }, { label: "imported", timeout: 8000, interval: 100 });
  const q = await ok("estimate_cost", { model_id: FLARE, lane: "edit", capture_id: cap.capture_id, parameters: { prompt: "a blue glass sphere" }, takes: 1 });
  assert.equal(q.needs_upload, false, JSON.stringify(q));
  const g = await ok("generate", { lane: "edit", model_id: FLARE, quote_id: q.quote_id, approved_cost: q.cu_cost_exact, parameters: { prompt: "a blue glass sphere" }, idempotency_key: "e2e-edit-0001" });
  assert.equal(g.status, "awaiting_approval");
  await waitFor(() => app.controller.model().composer.agent, { label: "F5 card" });
  app.controller.agentDecision(true);
  const done = await ok("wait_for_job", { local_id: g.local_id, timeout: 20 });
  assert.equal(done.status, "ready", JSON.stringify(done));
  assert.equal(mock.paidCalls.length, 1);
  assert.ok(mock.paidCalls[0].body.mask || mock.paidCalls[0].body.image, "an edit with the capture");
  const prep = await ok("prepare_result_application", { local_id: g.local_id, expected_revision: done.revision, purpose: "edit_selection" });
  const history = ps.history.length;
  const applied = await ok("apply_result_application", { application_id: prep.application_id });
  assert.equal(applied.outcome, "committed", JSON.stringify(applied));
  assert.equal(ps.history.length, history + 1);
  const layer = ps.doc(7).layers.find((l) => applied.layer_ids.includes(l.id));
  assert.ok(layer.mask || (layer.layers && layer.layers.every((x) => x.mask)), "masked to the selection");
  assert.equal(xmp.parse(layer.xmp).kind, "edit");
});
