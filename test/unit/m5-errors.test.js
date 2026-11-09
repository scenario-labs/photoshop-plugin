"use strict";
// M5, the error paths of SPEC 12.2 item 10, on the plugin source against the
// fixture mock. Error bodies are the ones measured live on 2026-10-19
// (M2.0): 401 {"message":"Unauthorized"}, 403 {"reason":"Given APIKey does
// not exists"}, 403 {"reason":"Project <id> not found"}, 400 {"reason":
// "Input quality must be one of ..."}, 404 {"reason":"Model <id> not found"},
// 413 {"message":"Request Too Long"}, the CDN's 403 for a link without a
// valid signature, and the failed job record (metadata.error and hint).
// Not measured, so assumed here and marked: a 429's Retry-After, a 402 for
// too few CU or a key's CU cap, and a content-policy refusal's text.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorld } = require("../helpers/restart-sim.js");
const { solidPng } = require("../helpers/fixture-scenario.js");
const { waitFor, sleep } = require("../helpers/fakes.js");

const FLARE = "model_openai-gpt-image-2-5-flare";
const BG = "model_851-labs-background-remover";
const POSTER = { id: 7, title: "poster.psd", width: 1024, height: 1024, path: "D:/art/poster.psd" };

async function startImage(app, prompt = "a quiet harbor at dawn") {
  const req = { model_id: FLARE, lane: "image", parameters: { prompt, width: 1024, height: 1024, quality: "low" }, takes: 1, pending: {}, target: { kind: "canvas", document_id: 7, box: [0, 0, 1024, 1024] } };
  const q = await app.quotes.estimate(req);
  return app.runner.start({ req, quote: q, refs: [], model_name: "GPT Image 2.5 Flare", document_title: "poster.psd" });
}

const settle = (app, id, states, label, timeout = 8000) => waitFor(() => states.includes(app.ledger.get(id).state) && app.ledger.get(id), { label, timeout });

async function world(t, mockOpts, bootOpts = {}) {
  const w = await createWorld(t, { mockOpts });
  const s = await w.boot({ docs: [POSTER], active: 7, signIn: true, ...bootOpts });
  // Results wait in Jobs, so each test reads the state it checks.
  s.ps.setActive(null);
  return { ...w, ...s };
}

test("401 and 403 on a status read: the job is kept and shows why; reads go on and it continues once the key works", async (t) => {
  let refuse = null;
  const w = await world(t, { jobPlan: () => ["in-progress", "in-progress", "success"], jobRead: () => refuse });
  refuse = { status: 401, body: { message: "Unauthorized" } };
  const out = await startImage(w.app);
  const id = out.record.local_id;
  await waitFor(() => w.app.runner.waitingFor(id), { label: "waiting after 401" });
  assert.equal(w.app.runner.waitingFor(id), "Scenario refused the current key. It continues once the key works again.");
  assert.equal(w.app.ledger.get(id).state, "queued", "nothing written off");
  assert.equal(w.app.jobsModel.row(w.app.ledger.get(id)).attention, true);
  assert.equal(w.app.jobsModel.row(w.app.ledger.get(id)).detail, "Scenario refused the current key. It continues once the key works again.");

  refuse = { status: 403, body: { reason: "Given APIKey does not exists" } };
  await sleep(80);
  assert.equal(w.app.runner.waitingFor(id), "Scenario refused the current key. It continues once the key works again.");
  assert.equal(w.app.ledger.get(id).state, "queued");

  refuse = null;
  const rec = await settle(w.app, id, ["ready"], "continued");
  assert.equal(rec.cu_charged, "2");
  assert.equal(w.app.runner.waitingFor(id), null);
});

test("403 at the paid call: Not sent with the key or project message; nothing charged", async (t) => {
  let answer = { status: 403, body: { reason: "Given APIKey does not exists" } };
  const w = await world(t, { paid: () => answer });
  const a = await startImage(w.app);
  assert.equal(a.state, "not_sent");
  assert.equal(a.record.error, "Not sent. Scenario did not accept this key and secret.");
  assert.equal(a.record.cu_charged, "0");
  answer = { status: 403, body: { reason: "Project proj_notARealProject0000000 not found" } };
  const b = await startImage(w.app, "a red bicycle");
  assert.equal(b.state, "not_sent");
  assert.equal(b.record.error, "Not sent. Scenario refused this request: Project proj_notARealProject0000000 not found. The key may not have access to this model or action.");
  const row = w.app.jobsModel.row(b.record);
  assert.equal(row.price, "Nothing charged");
  assert.deepEqual(row.actions.map((x) => x.name), ["details", "copy_error"]);
});

test("400, 404 and 413: refused before any job; Scenario's reason is shown", async (t) => {
  let answer = { status: 400, body: { reason: "Input quality must be one of the following values: auto, low, medium, high, xhigh, max" } };
  const w = await world(t, { paid: () => answer });
  const a = await startImage(w.app);
  assert.equal(a.state, "not_sent");
  assert.equal(a.record.error, "Not sent: Input quality must be one of the following values: auto, low, medium, high, xhigh, max");
  answer = { status: 404, body: { reason: `Model ${FLARE} not found` } };
  const b = await startImage(w.app, "a red bicycle");
  assert.equal(b.state, "not_sent");
  assert.equal(b.record.error, `Not sent: Model ${FLARE} not found`);
  assert.equal(w.app.ledger.all().filter((r) => r.cu_charged !== "0").length, 0);
});

test("413 on an upload: the job is Not sent before the paid call", async (t) => {
  const w = await createWorld(t, { mockOpts: { answer: (m) => (m === BG ? { status: 200, body: { creativeUnitsCost: 1, creativeUnitsDiscount: 0, costDetails: {} } } : undefined) } });
  const s = await w.boot({ docs: [POSTER], active: 7, signIn: true, psOpts: { scene: true } });
  const p = await s.app.flow.price({ tool: "remove_background" });
  assert.equal(p.state, "ready", p.reason);
  w.mock.setHandler((r) => (r.method === "POST" && r.path === "/v1/assets" ? { status: 413, body: { message: "Request Too Long" } } : undefined));
  const out = await s.app.flow.generate({ tool: "remove_background" }, p.quote);
  assert.equal(out.state, "not_sent");
  assert.equal(out.record.error, "Not sent: an input did not upload. Scenario refused the upload as too large (413).");
  assert.equal(w.mock.paidCalls.length, 0);
});

test("429 at the paid call: Not sent, and Generate pauses for Retry-After (assumed)", async (t) => {
  const paid = { status: 429, body: { message: "Too Many Requests" }, headers: { "retry-after": "30" } };
  const w = await world(t, { paid: () => paid });
  const a = await startImage(w.app);
  assert.equal(a.state, "not_sent");
  assert.match(a.record.error, /^Not sent: Scenario asked to wait (29|30) s\.$/);
  assert.ok(w.app.runner.pausedFor() > 25);
  await assert.rejects(startImage(w.app, "another prompt"), (e) => e.type === "RateLimited");
  assert.equal(w.mock.paidCalls.length, 1, "nothing is sent during the pause");
});

test("429 on a status read: the reads wait for Retry-After, then the job continues", async (t) => {
  let reads = 0;
  const w = await world(t, { jobPlan: () => ["in-progress", "success"], jobRead: () => (reads++ < 3 ? { status: 429, body: { message: "Too Many Requests" }, headers: { "retry-after": "1" } } : undefined) });
  const out = await startImage(w.app);
  const id = out.record.local_id;
  await waitFor(() => w.app.runner.waitingFor(id) === "Scenario asked to wait 1 s.", { label: "rate limited", timeout: 6000 });
  const rec = await settle(w.app, id, ["ready"], "continued after the wait");
  assert.equal(rec.cu_charged, "2");
});

test("offline: a paid call with no answer is Unknown; a status read offline pauses and resumes when the connection returns", async (t) => {
  let drop = true;
  const w = await world(t, { paid: () => (drop ? { destroy: true } : undefined) });
  const a = await startImage(w.app);
  assert.equal(a.state, "uncertain");
  assert.match(a.record.error, /^Unknown: No connection to Scenario\. A job may exist\.$/);
  assert.equal(w.mock.paidCalls.length, 1, "never retried");

  drop = false;
  let offline = true;
  const w2 = await world(t, { jobPlan: () => ["in-progress", "success"], jobRead: () => (offline ? { destroy: true } : undefined) });
  const out = await startImage(w2.app);
  const id = out.record.local_id;
  await waitFor(() => w2.app.runner.waitingFor(id), { label: "offline" });
  assert.equal(w2.app.runner.waitingFor(id), "Offline. Checking again when the connection returns.");
  assert.equal(w2.app.ledger.get(id).state, "queued");
  offline = false;
  const rec = await settle(w2.app, id, ["ready"], "resumed after the connection returned");
  assert.equal(rec.cu_charged, "2");
});

test("partial download: a cut transfer is retried from zero; the saved file is whole", async (t) => {
  let cut = 1;
  const w = await world(t, {
    cdn: (r) => {
      if (r.query.hop === "2" && cut-- > 0) {
        const full = solidPng(1024, 1024);
        return { status: 200, body: full.subarray(0, 200), headers: { "content-type": "image/png", "content-length": String(full.length) } };
      }
      return undefined;
    }
  });
  const out = await startImage(w.app);
  const rec = await settle(w.app, out.record.local_id, ["ready", "download_failed"], "downloaded");
  assert.equal(rec.state, "ready");
  const bytes = w.files.get(rec.outputs[0].path);
  assert.equal(Buffer.from(bytes).equals(solidPng(1024, 1024)), true);
  assert.ok(![...w.files.keys()].some((k) => k.endsWith(".part")), "no part file left");
});

test("expired link: the CDN's 403 makes the next attempt ask Scenario for a fresh signed link", async (t) => {
  let expired = 1;
  const w = await world(t, { cdn: () => (expired-- > 0 ? { status: 403, body: "<Error><Code>AccessDenied</Code></Error>", headers: { "content-type": "text/xml" } } : undefined) });
  const out = await startImage(w.app);
  const rec = await settle(w.app, out.record.local_id, ["ready", "download_failed"], "downloaded");
  assert.equal(rec.state, "ready");
  assert.equal(w.mock.requests.filter((r) => r.path === `/v1/assets/${rec.outputs[0].asset_id}`).length, 2, "two signed links, one per attempt");
});

test("a result gone from Scenario: download stopped (ResultExpired), Open on Scenario instead of Resume", async (t) => {
  const w = await world(t, { assetRead: (r, id) => (/^asset_mockJob/.test(id) ? { status: 404, body: { reason: `Asset ${id} not found` } } : undefined) });
  const out = await startImage(w.app);
  const rec = await settle(w.app, out.record.local_id, ["download_failed"], "expired");
  assert.equal(rec.download_error_type, "ResultExpired");
  assert.equal(rec.cu_charged, "2", "the charge stays on record");
  assert.deepEqual(w.app.jobsModel.row(rec).actions.map((a) => a.name), ["open_on_scenario", "details", "copy_error"]);
  assert.equal(await w.app.jobsModel.act(rec.local_id, "open_on_scenario"), "");
  assert.deepEqual(w.ps.opened, ["https://app.scenario.com/"]);
});

test("Blocked (texts assumed): a failed job naming the content policy is Blocked and refunded; a refusal at submit is Blocked with nothing charged", async (t) => {
  let refuse = false;
  const w = await world(
    t,
    {
      jobPlan: (job) => {
        job.error = "Request rejected by the provider's content policy.";
        job.hint = "";
        return ["in-progress", "failure"];
      },
      paid: () => (refuse ? { status: 400, body: { reason: "Prompt rejected by content policy" } } : undefined)
    },
    { blockedTexts: ["content policy"] }
  );
  const out = await startImage(w.app);
  const rec = await settle(w.app, out.record.local_id, ["blocked", "failed"], "blocked");
  assert.equal(rec.state, "blocked");
  assert.equal(rec.error, "Blocked: Scenario blocked this request (content policy).");
  assert.equal(rec.cu_charged, "0");
  assert.equal(rec.refunded, true);
  const row = w.app.jobsModel.row(rec);
  assert.equal(row.status, "Blocked");
  assert.equal(row.tone, "error");
  assert.equal(row.price, "Refunded by Scenario");

  refuse = true;
  const b = await startImage(w.app, "a red bicycle");
  assert.equal(b.state, "blocked");
  assert.equal(b.record.error, "Blocked: Scenario refused this request (content policy). Prompt rejected by content policy");
  assert.equal(b.record.cu_charged, "0");
  assert.equal(b.record.refunded, false);
  assert.equal(b.record.job_id, null);
});

test("a failed job is shown as refunded; a disableRefund job as charged, and only it counts in This document", async (t) => {
  let noRefund = false;
  const w = await world(t, {
    jobPlan: (job) => {
      job.disableRefund = noRefund;
      return ["in-progress", "failure"];
    }
  });
  w.ps.setActive(7);
  const a = await startImage(w.app);
  const r1 = await settle(w.app, a.record.local_id, ["failed"], "failed");
  assert.equal(r1.cu_charged, "0");
  assert.equal(r1.refunded, true);
  assert.match(r1.error, /^Failed: Ensure that both width and height/, "the hint says what to fix");
  assert.equal(w.app.jobsModel.row(r1).price, "Refunded by Scenario");
  noRefund = true;
  const b = await startImage(w.app, "a red bicycle");
  const r2 = await settle(w.app, b.record.local_id, ["failed"], "failed, no refund");
  assert.equal(r2.cu_charged, "2");
  assert.equal(r2.no_refund, true);
  assert.equal(w.app.jobsModel.row(r2).price, "Charged 2 CU, no refund on failure");
  const docView = w.app.jobsModel.list("document");
  assert.equal(docView.rows.length, 2);
  assert.equal(docView.document.charged, "2");
  assert.equal(docView.document.title, "poster.psd");
});

test("a key with a CU cap below the price (assumed 402): Not sent, nothing charged", async (t) => {
  const w = await world(t, { paid: () => ({ status: 402, body: { message: "Payment Required" } }) });
  const a = await startImage(w.app);
  assert.equal(a.state, "not_sent");
  assert.equal(a.record.error, "Not enough CU for this job. Nothing was sent.");
  assert.equal(a.record.cu_charged, "0");
  assert.equal(w.app.jobsModel.row(a.record).price, "Nothing charged");
});

test("no cancel on model jobs: running jobs offer Details only, and the plugin never asks Scenario to cancel", async (t) => {
  const w = await world(t, { jobPlan: () => ["in-progress", "in-progress", "in-progress", "success"] });
  const out = await startImage(w.app);
  await waitFor(() => w.app.ledger.get(out.record.local_id).state === "generating", { label: "generating" });
  assert.deepEqual(w.app.jobsModel.row(w.app.ledger.get(out.record.local_id)).actions.map((a) => a.name), ["details"]);
  await settle(w.app, out.record.local_id, ["ready"], "ready");
  assert.ok(!w.mock.requests.some((r) => /cancel/i.test(r.path)));
});
