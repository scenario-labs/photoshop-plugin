"use strict";
// M6 agent tools on the fake Photoshop, through main.js boot (the same
// wiring as the plugin): the money contract (approval card, decline spends
// nothing, allowance, a `from` price always asks, a charge above the quote
// ends the allowance, idempotency replay and conflict, No-spend), document
// scope (DocumentNotActive, DocumentNotAllowed, SwitchOff, a document
// switch between the call start and the modal scope), the upload card once
// per document per session, one pending card per session, session end,
// NotYourJob, the proposal card, and execute_batchplay's single History
// state with rollback.

const test = require("node:test");
const assert = require("node:assert/strict");
const xmp = require("../../plugin/src/util/xmp.js");
const { bootGenerate, FLARE } = require("../helpers/generate-sim.js");
const { waitFor, sleep } = require("../helpers/fakes.js");

const POSTER = { id: 7, title: "poster.psd", width: 1024, height: 1024 };
const OTHER = { id: 8, title: "other.psd", width: 512, height: 512 };
const A = { session: "sess-a", client_name: "claude-code", connected_at: "2026-10-20T10:00:00.000Z" };
const B = { session: "sess-b", client_name: "codex", connected_at: "2026-10-20T10:01:00.000Z" };

function flarePrice(extra) {
  return (model, body) => {
    if (model !== FLARE) return null;
    const n = 1 + (Number(body.numOutputs) || 1) + (extra ? extra(body) : 0);
    return { status: 269, body: { creativeUnitsCost: n, creativeUnitsDiscount: 0, costDetails: { "custom-generation": n } } };
  };
}

async function boot(t, opts = {}) {
  const w = await bootGenerate(t, { docs: opts.docs || [POSTER, OTHER], active: opts.active || 7, mockOpts: { answer: flarePrice(), ...(opts.mockOpts || {}) }, psOpts: opts.psOpts });
  assert.ok(w.app.agentTools, "agent tools are wired");
  return { ...w, h: w.app.agentTools.handlers };
}

async function quote(h, ctx, extra = {}) {
  return h.estimate_cost({ model_id: FLARE, lane: "image", parameters: { prompt: "a red kite", numOutputs: 1 }, canvas: { document_id: 7 }, ...extra }, ctx);
}

async function gen(h, ctx, q, extra = {}) {
  return h.generate({ lane: "image", model_id: FLARE, quote_id: q.quote_id, approved_cost: q.cu_cost_exact, parameters: { prompt: "a red kite", numOutputs: 1 }, ...extra }, ctx);
}

async function rejects(fn, type) {
  await assert.rejects(async () => fn(), (e) => {
    assert.equal(e.type, type, `${type} (got ${e.type}: ${e.message})`);
    return true;
  });
}

test("document reads: summary, layer detail and preview of any open document; scope switch limits them to the active one", async (t) => {
  const { app, h } = await boot(t);
  const s = await h.document_summary({}, A);
  assert.equal(s.document.id, 7);
  assert.equal(s.document.width, 1024);
  assert.ok(Array.isArray(s.layers) && s.layers.length >= 1);
  const other = await h.document_summary({ document_id: 8 }, A);
  assert.equal(other.document.id, 8);
  const p = await h.preview_document({ max_px: 256 }, A);
  assert.equal(p._images.length, 1);
  assert.ok(p.width <= 256 && p.height <= 256);
  assert.ok(app.approvals.activity().some((x) => /preview/i.test(x.what)), "the preview read is in the activity log");
  await app.settings.setSwitch("active_document_only", true);
  await rejects(() => h.document_summary({ document_id: 8 }, A), "DocumentNotAllowed");
  await assert.rejects(async () => h.document_summary({ document_id: 8 }, A), (e) => !/other\.psd/.test(e.message));
});

test("generate: Ask each time holds the job behind one card; Approve sends it once; Decline spends nothing", async (t) => {
  const { app, h, mock, doc } = await boot(t);
  const q = await quote(h, A);
  assert.equal(q.price_kind, "exact");
  const r = await gen(h, A, q);
  assert.equal(r.status, "awaiting_approval");
  assert.equal(mock.paidCalls.length, 0, "nothing sent before approval");
  const cards = app.approvals.showing();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "spend");
  assert.equal(cards[0].client_name, "claude-code");
  // The F5 card above the composer carries it.
  const m = app.controller.model();
  assert.ok(m.composer.agent, "F5 card shows");
  assert.equal(m.composer.agent.cu, "2");
  app.controller.agentDecision(true);
  await waitFor(() => mock.paidCalls.length === 1, { label: "sent once after approval" });
  // Agent results wait in ready: the agent lands them with
  // prepare_result_application and apply_result_application.
  await waitFor(() => app.ledger.get(r.local_id).state === "ready", { label: "result saved", timeout: 8000 });
  const rec = app.ledger.get(r.local_id);
  assert.match(cards[0].lines[0], /^Create image with .+, 1 take, for poster\.psd$/);
  assert.equal(rec.origin.kind, "agent");
  assert.equal(rec.approval.state, "approved");

  // A second request, declined: nothing is sent and the agent learns why.
  const q2 = await quote(h, A);
  const r2 = await gen(h, A, q2, { idempotency_key: "second-request-1" });
  assert.equal(r2.status, "awaiting_approval");
  await app.approvals.decline(app.approvals.showing()[0].id);
  await waitFor(() => app.ledger.get(r2.local_id).state === "not_sent", { label: "declined is not_sent" });
  assert.match(app.ledger.get(r2.local_id).error, /^SpendDeclined/);
  assert.equal(mock.paidCalls.length, 1, "the declined request spent nothing");
  const st = await h.job_status({ local_id: r2.local_id }, A);
  assert.equal(st.status, "not_sent");
  assert.equal(st.approval.state, "declined");
  assert.ok(doc, "panel present");
});

test("generate: idempotency replays the same job; another request under the same key conflicts; quote checks run first", async (t) => {
  const { app, h, mock } = await boot(t);
  const q = await quote(h, A);
  const r = await gen(h, A, q, { idempotency_key: "key-aaaaaaaa" });
  const again = await gen(h, A, q, { idempotency_key: "key-aaaaaaaa" });
  assert.equal(again.local_id, r.local_id);
  assert.equal(again.replayed, true);
  await rejects(() => gen(h, A, q, { idempotency_key: "key-aaaaaaaa", parameters: { prompt: "another", numOutputs: 1 } }), "IdempotencyConflict");
  await rejects(() => gen(h, A, { quote_id: "q_nope", cu_cost_exact: "2" }, { idempotency_key: "key-bbbbbbbb" }), "QuoteExpired");
  // The same request again is in flight while the first waits for approval.
  const q1 = await quote(h, A);
  await rejects(() => gen(h, A, q1, { idempotency_key: "key-dddddddd" }), "RequestInFlight");
  const blue = { prompt: "a blue kite", numOutputs: 1 };
  const q2 = await quote(h, A, { parameters: blue });
  await rejects(() => gen(h, A, q2, { idempotency_key: "key-cccccccc", approved_cost: "2.0", parameters: blue }), "CostMismatch");
  await rejects(() => gen(h, A, q2, { idempotency_key: "key-eeeeeeee", parameters: { prompt: "a green kite", numOutputs: 1 } }), "QuoteMismatch");
  await rejects(() => h.generate({ lane: "image", model_id: FLARE, quote_id: q2.quote_id, approved_cost: q2.cu_cost_exact, parameters: blue, idempotency_key: "short" }, A), "InvalidParameter");
  assert.equal(mock.paidCalls.length, 0);
  assert.equal(app.approvals.showing().length, 1, "one card for the held job");
});

test("generate: No-spend refuses after the quote checks; nothing is held or sent", async (t) => {
  const { app, h, mock } = await boot(t);
  await app.settings.setNoSpend(true);
  const q = await quote(h, A);
  await rejects(() => gen(h, A, q), "NoSpend");
  assert.equal(app.approvals.showing().length, 0);
  assert.equal(mock.paidCalls.length, 0);
});

test("allowance: Allow without asking spends without a card within the limits; a charge above its quote ends it; a from price always asks", async (t) => {
  const { app, h, mock } = await boot(t, { mockOpts: { answer: flarePrice() } });
  app.settings._grant(A, 3000);
  app.settings.grant(A, "5", "3");
  let sp = app.settings.spending();
  assert.equal(sp.mode, "allow");
  assert.equal(sp.client.session, A.session);
  const q = await quote(h, A);
  const r = await gen(h, A, q);
  assert.equal(r.status === "awaiting_approval", false, "no card under the allowance");
  assert.equal(app.approvals.showing().length, 0);
  await waitFor(() => mock.paidCalls.length === 1, { label: "sent" });
  await waitFor(() => app.ledger.get(r.local_id).state === "ready", { label: "result saved", timeout: 8000 });
  sp = app.settings.spending();
  assert.equal(sp.remaining, "1");
  // Another client gets cards whatever the allowance.
  const pb = { prompt: "a kite for B", numOutputs: 1 };
  const qb = await quote(h, B, { parameters: pb });
  const rb = await gen(h, B, qb, { parameters: pb });
  assert.equal(rb.status, "awaiting_approval");
  // Over what is left (2 CU asked, 1 left): a card.
  const p2 = { prompt: "a second kite", numOutputs: 1 };
  const q2 = await quote(h, A, { parameters: p2 });
  const r2 = await gen(h, A, q2, { idempotency_key: "allow-over-1", parameters: p2 });
  assert.equal(r2.status, "awaiting_approval");
  assert.equal(app.settings.spending().remaining, "1", "a held request deducts nothing");
  // settle: a charge above the quote ends the allowance.
  assert.equal(app.settings.settle(A.session, 1000, 2000), "above");
  assert.equal(app.settings.spending().mode, "ask");
});

test("one card per session at a time; Decline all; session end expires cards and withdraws held jobs", async (t) => {
  const { app, h, mock } = await boot(t);
  const q1 = await quote(h, A);
  const r1 = await gen(h, A, q1, { idempotency_key: "one-card-1" });
  const q2 = await quote(h, A, { parameters: { prompt: "a blue kite", numOutputs: 1 } });
  const r2 = await h.generate({ lane: "image", model_id: FLARE, quote_id: q2.quote_id, approved_cost: q2.cu_cost_exact, parameters: { prompt: "a blue kite", numOutputs: 1 }, idempotency_key: "one-card-2" }, A);
  const showing = app.approvals.showing();
  assert.equal(showing.length, 1, "one card for the session");
  assert.equal(showing[0].waiting, 1, "the second waits behind it");
  await app.approvals.declineAll(A.session);
  await waitFor(() => app.ledger.get(r1.local_id).state === "not_sent" && app.ledger.get(r2.local_id).state === "not_sent", { label: "both not sent" });
  // Session end.
  const q3 = await quote(h, B);
  const r3 = await gen(h, B, q3, { idempotency_key: "session-end-1" });
  assert.equal(r3.status, "awaiting_approval");
  app.agentTools.endSessions([B.session]);
  await waitFor(() => app.ledger.get(r3.local_id).state === "not_sent", { label: "session end withdraws" });
  assert.equal(app.approvals.showing().length, 0);
  assert.equal(mock.paidCalls.length, 0);
});

test("cancel_prepared_job: only the session that asked; NotYourJob for others", async (t) => {
  const { app, h } = await boot(t);
  const q = await quote(h, A);
  const r = await gen(h, A, q, { idempotency_key: "cancel-own-1" });
  await rejects(() => h.cancel_prepared_job({ local_id: r.local_id }, B), "NotYourJob");
  const c = await h.cancel_prepared_job({ local_id: r.local_id }, A);
  assert.equal(c.status, "not_sent");
  assert.equal(app.approvals.showing().length, 0);
});

test("document changes: SwitchOff, DocumentNotActive, a switch between the call start and the modal scope; set_selection is one History state", async (t) => {
  const { app, h, ps } = await boot(t);
  await rejects(() => h.set_selection({ rect: [0, 0, 100, 100] }, A), "SwitchOff");
  await app.settings.setSwitch("agents_may_modify", true);
  await rejects(() => h.set_selection({ rect: [0, 0, 100, 100], document_id: 8 }, A), "DocumentNotActive");
  const before = ps.history.length;
  const s = await h.set_selection({ rect: [10, 20, 100, 50] }, A);
  assert.deepEqual(s.selection.bounds, [10, 20, 100, 50]);
  assert.equal(ps.history.length, before + 1);
  assert.equal(ps.history[ps.history.length - 1].name, "Scenario agent: Select");
  // The person brings another document forward while the call waits for the modal scope.
  ps.beforeModal = () => {
    ps.setActive(8);
    ps.beforeModal = null;
  };
  await rejects(() => h.set_selection({ rect: [0, 0, 10, 10], document_id: 7 }, A), "DocumentNotActive");
  await rejects(() => h.execute_batchplay({ descriptors: [{ _obj: "invert" }], document_id: 7 }, A), "SwitchOff");
});

// The descriptors the batchPlay tests play on the fake (make a layer, read
// its name, an error).
function extraPlay(d, { doc, makeLayer }) {
  if (d._obj === "make" && d._target && d._target[0]._ref === "layer") {
    const l = makeLayer(doc, { name: "Layer " + (doc.layers.length + 1) });
    doc.layers.unshift(l);
    doc.activeLayers = [l];
    return {};
  }
  if (d._obj === "get" && d._target && d._target[0]._property === "name") return { name: doc.activeLayers[0] ? doc.activeLayers[0].name : null, _path: "/Volumes/Work/secret.psd" };
  if (d._obj === "invert") throw new Error("fake: invert failed");
  return undefined;
}

test("execute_batchplay: one History state, rollback on an error, refusals before anything runs", async (t) => {
  const { app, h, ps } = await boot(t, { psOpts: { extraPlay } });
  await app.settings.setSwitch("agents_may_modify", true);
  await app.settings.setSwitch("agents_may_run_commands", true);
  const before = ps.history.length;
  const ok = await h.execute_batchplay({ descriptors: [{ _obj: "make", _target: [{ _ref: "layer" }] }, { _obj: "get", _target: [{ _property: "name" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], label: "Two steps" }, A);
  assert.equal(ok.outcome, "committed");
  assert.equal(ok.history_state, "Scenario agent: Two steps");
  assert.equal(ps.history.length, before + 1, "one History state");
  assert.equal(ok.results[1].name, "Layer 2");
  assert.equal(ok.results[1]._path, undefined, "paths are stripped from get results");
  const layers = ps.doc(7).layers.length;
  // An error in any descriptor rolls the whole call back.
  const bad = await h.execute_batchplay({ descriptors: [{ _obj: "make", _target: [{ _ref: "layer" }] }, { _obj: "invert" }] }, A).catch((e) => e);
  assert.ok(bad.outcome === "rolled_back" || bad.type, "rolled back");
  assert.equal(ps.doc(7).layers.length, layers, "nothing stays");
  assert.equal(ps.history.length, before + 1, "no second History state");
  await rejects(() => h.execute_batchplay({ descriptors: [{ _obj: "make", _target: [{ _ref: "layer" }] }, { _obj: "save" }] }, A), "CommandRefused");
  assert.equal(ps.doc(7).layers.length, layers, "a refusal runs nothing");
  await rejects(() => h.execute_batchplay({ descriptors: [{ _obj: "select", _target: [{ _ref: "document", _id: 8 }] }] }, A), "CommandRefused");
  // Turning the first switch off turns commands off.
  await app.settings.setSwitch("agents_may_modify", false);
  assert.equal(app.settings.switches().agents_may_run_commands, false);
});

test("apply with the switch off: a proposal card; Apply lands one History state with the Scenario metadata", async (t) => {
  const { app, h, ps } = await boot(t);
  app.settings._grant(A, 50000);
  app.settings.grant(A, "10", "50");
  const q = await quote(h, A);
  const r = await gen(h, A, q, { idempotency_key: "proposal-1" });
  await waitFor(() => ["applied", "ready"].includes(app.ledger.get(r.local_id).state), { label: "result in", timeout: 8000 });
  const prep = await h.prepare_result_application({ local_id: r.local_id, purpose: "new_layer", target: { document_id: 7 } }, A);
  assert.ok(prep.application_id);
  const before = ps.history.length;
  const res = await h.apply_result_application({ application_id: prep.application_id }, A);
  assert.equal(res.outcome, "pending_approval");
  const card = app.approvals.showing().find((c) => c.kind === "proposal");
  assert.ok(card, "a proposal card shows");
  await app.approvals.approve(card.id);
  await waitFor(() => ps.history.length === before + 1, { label: "applied in one state" });
  assert.match(ps.history[ps.history.length - 1].name, /^Scenario agent: /);
  const top = ps.doc(7).layers[0];
  assert.ok(xmp.parse(top.xmp).assetId, "the layer carries the Scenario metadata");
  await rejects(() => h.apply_result_application({ application_id: prep.application_id }, A), "ApplicationUsed");
});

test("upload_reference: one card per document per session; declined spends nothing and says so", async (t) => {
  const { app, h, mock } = await boot(t);
  const cap = await h.capture_reference({ purpose: "reference", source: "all_visible", max_px: 256 }, A);
  assert.ok(cap.capture_id);
  const up = h.upload_reference({ capture_id: cap.capture_id }, A);
  await waitFor(() => app.approvals.showing().some((c) => c.kind === "upload"), { label: "upload card" });
  const card = app.approvals.showing().find((c) => c.kind === "upload");
  assert.equal(card.title, "claude-code asks to upload");
  assert.equal(card.lines[0], "Allow claude-code to send pixels from poster.psd to Scenario for this session?");
  await app.approvals.approve(card.id);
  const out = await up;
  const ref = out.reference_ids[0] || Object.values(out.reference_ids)[0];
  await waitFor(async () => (await h.reference_upload_status({ reference_id: ref }, A)).state === "imported", { label: "imported" });
  const n = mock.uploads.length;
  // A second capture of the same document: no card.
  const cap2 = await h.capture_reference({ purpose: "reference", source: "all_visible", max_px: 200 }, A);
  await h.upload_reference({ capture_id: cap2.capture_id }, A);
  assert.equal(app.approvals.showing().filter((c) => c.kind === "upload").length, 0, "no second card for the same document");
  await waitFor(() => mock.uploads.length === n + 1, { label: "second upload" });
  // Another client asks again; declining spends nothing.
  const cap3 = await h.capture_reference({ purpose: "reference", source: "all_visible", max_px: 128 }, B);
  const up3 = h.upload_reference({ capture_id: cap3.capture_id }, B);
  await waitFor(() => app.approvals.showing().some((c) => c.kind === "upload"), { label: "card for B" });
  await app.approvals.decline(app.approvals.showing().find((c) => c.kind === "upload").id);
  const r3 = await up3;
  assert.equal(r3.state, "awaiting_approval", "upload_reference answers at once; the card decides later");
  const ref3 = r3.reference_ids[0] || Object.values(r3.reference_ids)[0];
  const st3 = await h.reference_upload_status({ reference_id: ref3 }, B);
  assert.equal(st3.state, "declined");
  assert.match(st3.error, /^UploadDeclined/);
  await sleep(50);
  assert.equal(mock.uploads.length, n + 1, "nothing uploaded");
});

test("allowance: a price with no upper bound (from) always asks, and deducts nothing", async (t) => {
  const { app, h, mock } = await boot(t);
  app.settings.grant(A, "50", "300");
  // The quote reads as a from price (a model whose charge has no upper bound).
  const peek = app.quotes.peek;
  app.quotes.peek = async (...a) => ({ ...(await peek(...a)), kind: "from" });
  const q = await quote(h, A);
  const r = await gen(h, A, q, { idempotency_key: "from-price-1" });
  assert.equal(r.status, "awaiting_approval");
  assert.equal(app.settings.spending().remaining, "300");
  assert.equal(app.approvals.showing()[0].kind, "spend");
  assert.equal(mock.paidCalls.length, 0);
});
