"use strict";
// The paid request (SPEC 6.1 items 8 and 9) against the mock API: every
// status and error path is classified as queued, not_sent or uncertain, the
// request goes exactly once (never retried, a timeout included), carries no
// query string and never the price-check flag. The 200 and 400 answers are
// the measured ones (test/fixtures/m2.0/jobs.json); the other statuses follow
// the SPEC table, since M2.0 could not provoke them on a live key.

const test = require("node:test");
const assert = require("node:assert/strict");
const clientMod = require("../../plugin/src/scenario/client.js");
const paid = require("../../plugin/src/scenario/paid.js");
const priceChecks = require("../../plugin/src/scenario/dry-run.js");
const API = require("../../shared/scenario-api.json");
const { startMockScenario, newKeyPair } = require("../helpers/mock-scenario.js");
const { jobsFixture } = require("../helpers/fixture-scenario.js");

const MODEL = "model_openai-gpt-image-2-5-flare";
const BODY = { prompt: "a lighthouse", width: 1024, height: 1024, quality: "low", numOutputs: 1 };

async function setup(t, answer, clientOpts = {}) {
  const pair = newKeyPair();
  const mock = await startMockScenario({
    accounts: [pair],
    handle: (r) => (r.path.startsWith("/v1/generate") ? answer(r) : undefined)
  });
  t.after(() => mock.close());
  const client = clientMod.createClient({ fetch: globalThis.fetch, AbortController: globalThis.AbortController, credentials: () => pair, baseUrl: mock.url, ...clientOpts });
  const sent = () => mock.requests.filter((r) => r.path.startsWith("/v1/generate"));
  return { mock, client, sent, pair };
}

function noFlag(r) {
  assert.equal(r.search, "", "no query string at all");
  for (const k of Object.keys(r.body || {})) assert.notEqual(k.toLowerCase(), Object.keys(priceChecks.DRY_RUN_QUERY)[0].toLowerCase());
}

const CASES = [
  ["measured 200 with a job", () => jobsFixture.submit_image, { status: "queued", job_id: "job_fx1" }],
  ["a 2xx shaped like a price check (269, no job)", () => ({ status: 269, body: { creativeUnitsCost: 2, creativeUnitsDiscount: 0, costDetails: {} } }), { status: "uncertain", alarm: true }],
  ["a 200 without a job", () => ({ status: 200, body: {} }), { status: "uncertain", alarm: true }],
  ["a 200 whose job has no id", () => ({ status: 200, body: { job: { status: "queued" } } }), { status: "uncertain", alarm: false }],
  ["a 200 that is not JSON", () => ({ status: 200, body: "<html>gateway</html>", headers: { "content-type": "text/html" } }), { status: "uncertain", alarm: false }],
  ["measured 400 (bad enum)", () => jobsFixture.paid_bad_enum, { status: "not_sent", type: "InvalidParameter", reason: /^Not sent: Input quality must be one of/ }],
  ["404 unknown model", () => ({ status: 404, body: { reason: "Model model_x not found" } }), { status: "not_sent", type: "ModelUnavailable" }],
  ["409", () => ({ status: 409, body: { reason: "Conflict" } }), { status: "not_sent", type: "InvalidParameter" }],
  ["413", () => ({ status: 413, body: { message: "Request Entity Too Large" } }), { status: "not_sent", type: "InvalidParameter" }],
  ["422", () => ({ status: 422, body: { reason: "Unprocessable" } }), { status: "not_sent", type: "InvalidParameter" }],
  ["401", () => ({ status: 401, body: { message: "Unauthorized" } }), { status: "not_sent", type: "Unauthorized" }],
  ["403", () => ({ status: 403, body: { reason: "Forbidden resource" } }), { status: "not_sent", type: "Forbidden" }],
  ["402", () => ({ status: 402, body: { message: "Payment Required" } }), { status: "not_sent", type: "InsufficientCredits", reason: "Not enough CU for this job. Nothing was sent." }],
  ["429 with Retry-After", () => ({ status: 429, body: {}, headers: { "retry-after": "7" } }), { status: "not_sent", type: "RateLimited", pause_s: 7 }],
  ["429 without Retry-After", () => ({ status: 429, body: {} }), { status: "not_sent", type: "RateLimited", pause_s: API.paid.pause_default_s }],
  ["500", () => ({ status: 500, body: { message: "Internal" } }), { status: "uncertain" }],
  ["502", () => ({ status: 502, body: "Bad Gateway", headers: { "content-type": "text/plain" } }), { status: "uncertain" }],
  ["503 (reads retry it; the paid call does not)", () => ({ status: 503, body: { message: "Service Unavailable" } }), { status: "uncertain" }],
  ["504", () => ({ status: 504, body: {} }), { status: "uncertain" }],
  ["a redirect", () => ({ status: 302, body: "", headers: { location: "/v1/elsewhere" } }), { status: "uncertain" }],
  ["any other status (418)", () => ({ status: 418, body: {} }), { status: "uncertain" }],
  ["the connection drops", () => ({ destroy: true }), { status: "uncertain" }]
];

for (const [label, answer, want] of CASES) {
  test(`paid call, ${label}: ${want.status}${want.type ? ` (${want.type})` : ""}, sent once, no flag`, async (t) => {
    const { client, sent } = await setup(t, answer);
    const out = await paid.submit(client, MODEL, BODY);
    assert.equal(out.status, want.status);
    if (want.job_id) assert.equal(out.job_id, want.job_id);
    if ("alarm" in want) assert.equal(!!out.alarm, want.alarm);
    if (want.type) assert.equal(out.error.type, want.type);
    if (want.pause_s) assert.equal(out.pause_s, want.pause_s);
    if (want.reason instanceof RegExp) assert.match(out.reason, want.reason);
    else if (want.reason) assert.equal(out.reason, want.reason);
    if (want.status === "uncertain") assert.match(out.reason, /A job may exist\.$/);
    assert.equal(sent().length, 1, "exactly one request");
    noFlag(sent()[0]);
    assert.deepEqual(sent()[0].body, BODY);
    assert.equal(sent()[0].method, "POST");
    assert.equal(sent()[0].path, `/v1/generate/custom/${MODEL}`);
  });
}

test("paid call: no answer within 60 s is uncertain, and the timeout is never retried", async (t) => {
  const asked = [];
  const timers = {
    // The 60 s timer runs in 50 ms here; the value asked for is recorded.
    setTimeout: (fn, ms) => {
      asked.push(ms);
      return setTimeout(fn, ms === API.paid.timeout_ms ? 50 : ms);
    },
    clearTimeout: (h) => clearTimeout(h)
  };
  const { client, sent } = await setup(t, () => ({ status: null }), { timers });
  const out = await paid.submit(client, MODEL, BODY);
  assert.equal(out.status, "uncertain");
  assert.equal(out.reason, "Scenario did not answer within 60 s. A job may exist.");
  assert.ok(asked.includes(60000), "the paid timeout is 60 s");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent().length, 1, "never retried");
  noFlag(sent()[0]);
});

test("a paid call never carries the price-check flag: a flagged body or a query is refused before anything is sent", async (t) => {
  const { client, sent } = await setup(t, () => jobsFixture.submit_image);
  const flag = Object.keys(priceChecks.DRY_RUN_QUERY)[0];
  for (const body of [{ ...BODY, [flag]: true }, { ...BODY, [flag.toUpperCase()]: "true" }]) {
    await assert.rejects(paid.submit(client, MODEL, body), (e) => e.type === "Internal" && e.message === "A paid request never carries the price-check flag.");
  }
  await assert.rejects(client.request("POST", `/generate/custom/${MODEL}`, { body: BODY, paid: paid.PAID_REQUEST, query: priceChecks.DRY_RUN_QUERY }), (e) => e.beforeSend === true);
  await assert.rejects(client.request("POST", `/generate/custom/${MODEL}`, { body: BODY, paid: paid.PAID_REQUEST, query: {} }), (e) => e.beforeSend === true);
  await assert.rejects(client.request("POST", `/generate/custom/${MODEL}`, { body: BODY, paid: paid.PAID_REQUEST, priceCheck: true }), (e) => e.beforeSend === true);
  await assert.rejects(paid.submit(client, MODEL, null), (e) => e.type === "Internal");
  assert.equal(sent().length, 0, "nothing left the plugin");
  // The one accepted shape.
  const out = await paid.submit(client, MODEL, BODY);
  assert.equal(out.status, "queued");
  assert.equal(sent().length, 1);
  noFlag(sent()[0]);
});

test("the paid module names the flag only through the price-check constant", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "../../plugin/src/scenario/paid.js"), "utf8");
  assert.ok(!/dryrun/i.test(src.replace(/DRY_RUN_QUERY/g, "")), "paid.js never spells the flag");
  assert.equal(Object.isFrozen(paid.PAID_REQUEST), true);
});
