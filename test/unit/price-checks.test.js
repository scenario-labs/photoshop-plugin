"use strict";
// Price checks and quotes (SPEC 6.1, MCP.md section 3) against a mock built
// from the M2.0 raw responses (test/helpers/fixture-scenario.js):
// - the dry-run flag comes from one frozen constant, and every price check
//   any test in this file sends has exactly the query string "?dryRun=true";
// - the M2 exit: exact prices for an Image default, an Edit default with a
//   mask, and Enhance models, with stand-ins by the measured rules;
// - validation before any dry run; the alarm when a price check returns a
//   job; the quote store (single use, 120 s, cost and fingerprint checks).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const main = require("../../plugin/src/main.js");
const priceChecks = require("../../plugin/src/scenario/dry-run.js");
const price = require("../../plugin/src/forms/price.js");
const { startFixtureScenario } = require("../helpers/fixture-scenario.js");
const { newKeyPair, projectRecord } = require("../helpers/mock-scenario.js");
const { fakeHost, uxpWebSocket, freePort, newToken } = require("../helpers/fakes.js");

const ROOT = path.resolve(__dirname, "..", "..");
const FLARE = "model_openai-gpt-image-2-5-flare";
const TOPAZ = "model_topaz-image-upscale";
const REMOVER = "model_851-labs-background-remover";
const QWEN = "model_qwen-image-edit-2511";

// Every mock of this file, so the last test can check every request sent.
const mocks = [];

async function signedIn(t, { docs, active, now } = {}) {
  const pair = newKeyPair();
  const other = newKeyPair();
  const mock = await startFixtureScenario({
    accounts: [
      { ...pair, projects: [projectRecord(pair.key, { name: "Fixture project" })] },
      { ...other, projects: [projectRecord(other.key, { name: "Other project" })] }
    ]
  });
  mocks.push(mock);
  const port = await freePort();
  const host = fakeHost({ WebSocket: uxpWebSocket({ rewrite: (u) => u.replace(":9890", `:${port}`) }), secure: [["scenario.pairing_token", newToken()]], docs, active });
  if (now) host.timers.now = now;
  const app = await main.boot({ host, document: null, console: null, apiBaseUrl: mock.url });
  t.after(async () => {
    app.link.stop();
    await mock.close();
  });
  assert.equal((await app.auth.saveAndTest(pair.key, pair.secret)).ok, true);
  return { app, mock, host, pair, other, tools: app.catalogTools };
}

const imageDefault = { prompt: "a lighthouse", quality: "low", width: 1024, height: 1024 };

test("the flag is one frozen constant, written in one file only", () => {
  assert.ok(Object.isFrozen(priceChecks.DRY_RUN_QUERY));
  assert.deepEqual({ ...priceChecks.DRY_RUN_QUERY }, { dryRun: "true" });
  assert.equal(priceChecks.DRY_RUN_SEARCH, "?dryRun=true");
  const files = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  for (const dir of ["plugin/src", "helper/src", "shared"]) walk(path.join(ROOT, dir));
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
  // The plugin is the only part that talks to Scenario; in it, the flag's name is written once.
  const pluginHits = files.filter((f) => !rel(f).startsWith("helper/") && /dryRun/.test(fs.readFileSync(f, "utf8"))).map(rel);
  assert.deepEqual(pluginHits, ["plugin/src/scenario/dry-run.js"]);
  for (const f of files.filter((x) => rel(x).startsWith("helper/"))) {
    const text = fs.readFileSync(f, "utf8");
    assert.ok(!/api\.cloud\.scenario\.com|generate\/custom|dryRun\s*[:=]\s*["']/.test(text), `${rel(f)} sends nothing to Scenario`);
  }
  // In the bundle UXP loads, the query object is built in exactly one place.
  const code = require("../../plugin/scripts/build.js").bundle({ dev: false }).code;
  assert.equal(code.match(/dryRun/g).length, 1);
});

test("M2 exit, Image default: GPT Image 2.5 Flare, low quality, 1024 x 1024, 1 take: exactly 2 CU, nothing uploaded", async (t) => {
  const { tools, mock } = await signedIn(t);
  const q = await tools.estimate_cost({ model_id: FLARE, lane: "image", parameters: imageDefault, takes: 1, new_document: { width: 1024, height: 1024 } });
  assert.equal(q.cu_cost_exact, "2");
  assert.equal(q.cu_cost, 2);
  assert.equal(q.price_kind, "exact");
  assert.equal(q.cu_cost_max, null);
  assert.deepEqual(q.cost_details, { "custom-generation": 2 });
  assert.equal(q.needs_upload, false);
  assert.equal(q.no_refund, false);
  assert.match(q.quote_id, /^quote_[0-9a-f]{24}$/);
  assert.equal(mock.uploads.length, 0);
  assert.deepEqual(mock.priceChecks.map((c) => c.body), [{ ...imageDefault, numOutputs: 1 }], "only what was set is sent");
});

test("M2 exit, Edit default with a mask: Flare, 2 takes: exactly 3 CU; the capture and the mask are priced without any upload", async (t) => {
  const { tools, mock } = await signedIn(t);
  const q = await tools.estimate_cost({ model_id: FLARE, lane: "edit", parameters: imageDefault, takes: 2 });
  assert.equal(q.cu_cost_exact, "3");
  assert.equal(q.price_kind, "exact");
  assert.equal(q.needs_upload, true, "the capture is a price-affecting input still to upload");
  assert.equal(mock.uploads.length, 0, "the first reference and the mask are free: no stand-in");
  assert.deepEqual(Object.keys(mock.priceChecks[0].body).sort(), ["height", "numOutputs", "prompt", "quality", "width"]);
  // Extra references are priced by count with small stand-ins (measured: two references at 1024, 2 takes = 4 CU).
  const more = await tools.estimate_cost({ model_id: FLARE, lane: "edit", parameters: { ...imageDefault, referenceImages: ["asset_fixtureBlank256"] }, takes: 2 });
  assert.equal(more.cu_cost_exact, "4");
  assert.deepEqual(mock.uploads.map((u) => [u.name, u.width, u.height]), [["photoshop-standin-256x256.png", 256, 256]]);
  assert.deepEqual(mock.priceChecks[1].body.referenceImages, ["asset_fixtureBlank256", mock.uploads[0].id]);
});

test("M2 exit, Enhance: 851 Labs Remove BG 1 CU with one small stand-in, uploaded once per project", async (t) => {
  const { tools, mock, app, other } = await signedIn(t);
  const a = await tools.estimate_cost({ model_id: REMOVER, lane: "remove_background", parameters: {} });
  const b = await tools.estimate_cost({ model_id: REMOVER, lane: "remove_background", parameters: {} });
  assert.equal(a.cu_cost_exact, "1");
  assert.equal(b.cu_cost_exact, "1");
  assert.equal(mock.uploads.length, 1, "the stand-in is reused");
  assert.equal(mock.uploads[0].name, "photoshop-standin-256x256.png");
  assert.notEqual(a.quote_id, b.quote_id);
  // Another project gets its own stand-in.
  assert.equal((await app.auth.saveAndTest(other.key, other.secret)).ok, true);
  await tools.estimate_cost({ model_id: REMOVER, lane: "remove_background", parameters: {} });
  assert.equal(mock.uploads.length, 2);
});

test("M2 exit, Enhance: Topaz prices by source size with a blank stand-in at that size: 10, 40, 60, and 60 above the read cap", async (t) => {
  const docs = [
    { id: 1, title: "a", width: 1024, height: 1024 },
    { id: 2, title: "b", width: 4096, height: 4096 },
    { id: 3, title: "c", width: 6144, height: 6144 },
    { id: 4, title: "d", width: 8000, height: 8000 }
  ];
  const { tools, mock } = await signedIn(t, { docs, active: 1 });
  const prices = [];
  for (const d of docs) prices.push((await tools.estimate_cost({ model_id: TOPAZ, lane: "upscale", parameters: { upscaleFactor: "2x" }, canvas: { document_id: d.id } })).cu_cost_exact);
  assert.deepEqual(prices, ["10", "40", "60", "60"]);
  assert.deepEqual(mock.uploads.map((u) => `${u.width}x${u.height}`), ["1024x1024", "4096x4096", "6144x6144"], "8000 px is read at the 6144 px cap: the 6144 stand-in is reused");
  const six = await tools.estimate_cost({ model_id: TOPAZ, lane: "upscale", parameters: { upscaleFactor: "6x" }, canvas: { document_id: 3 } });
  assert.equal(six.cu_cost_exact, "165");
  const box = await tools.estimate_cost({ model_id: TOPAZ, lane: "upscale", parameters: { upscaleFactor: "2x" }, canvas: { document_id: 3, box: [0, 0, 4096, 4096] } });
  assert.equal(box.cu_cost_exact, "40", "a box prices at the box's size");
});

test("parameters are validated before any price check is sent", async (t) => {
  const { tools, mock } = await signedIn(t);
  const cases = [
    [{ ...imageDefault, fooBar: 1 }, /fooBar is not a parameter of this model/],
    [{ ...imageDefault, quality: "ultra" }, /quality must be one of: auto, low/],
    [{ ...imageDefault, width: 5000 }, /width must be at most 3840/],
    [{ ...imageDefault, width: 1000 }, /width must be a multiple of 16/],
    [{ ...imageDefault, width: "big" }, /width must be a number/],
    [{ quality: "low", width: 1024, height: 1024 }, /Prompt is required by this model/],
    [{ ...imageDefault, ipDetection: true }, /ipDetection is not accepted/],
    [{ ...imageDefault, mask: "asset_fixtureMask1024png" }, /referenceImages is required when mask is given/]
  ];
  for (const [parameters, re] of cases) {
    await assert.rejects(tools.estimate_cost({ model_id: FLARE, lane: "image", parameters, takes: 1 }), (e) => e.type === "InvalidParameter" && re.test(e.message), String(re));
  }
  await assert.rejects(tools.estimate_cost({ model_id: FLARE, lane: "image", parameters: imageDefault, takes: 11 }), (e) => e.type === "InvalidParameter" && /numOutputs must be at most 10/.test(e.message));
  await assert.rejects(tools.estimate_cost({ model_id: FLARE, lane: "vectorize", parameters: imageDefault }), (e) => e.type === "InvalidParameter" && /later release/.test(e.message));
  await assert.rejects(tools.estimate_cost({ model_id: TOPAZ, lane: "edit", parameters: {} }), (e) => e.type === "InvalidParameter" && /does not run in the edit lane/.test(e.message));
  await assert.rejects(tools.estimate_cost({ model_id: FLARE, lane: "image", parameters: imageDefault, capture_id: "cap_1" }), (e) => e.type === "InvalidParameter" && /capture_id is not available/.test(e.message));
  await assert.rejects(tools.estimate_cost({ model_id: "model_fixture-missing", lane: "image", parameters: imageDefault }), (e) => e.type === "ModelUnavailable");
  assert.equal(mock.priceChecks.length, 0, "no price check was sent");
});

test("a price-affecting input no stand-in can price: InvalidParameter, nothing sent (the panel shows 'price after upload')", async (t) => {
  const { tools, mock } = await signedIn(t);
  await assert.rejects(tools.estimate_cost({ model_id: QWEN, lane: "edit", parameters: { prompt: "make it blue" } }), (e) => e.type === "InvalidParameter" && /no blank stand-in can price/.test(e.message) && e.afterUpload === "referenceImages");
  assert.equal(mock.priceChecks.length, 0);
  assert.equal(mock.uploads.length, 0);
});

test("Scenario's refusals of a price check keep their text and type", async (t) => {
  const pair = newKeyPair();
  let answer = null;
  const mock = await startFixtureScenario({ accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "Refusals" })] }], answer: () => answer });
  mocks.push(mock);
  const app = await main.boot({ host: fakeHost({ WebSocket: uxpWebSocket({ rewrite: (u) => u.replace(":9890", ":1") }), secure: [["scenario.pairing_token", newToken()]] }), document: null, console: null, apiBaseUrl: mock.url });
  t.after(async () => {
    app.link.stop();
    await mock.close();
  });
  assert.equal((await app.auth.saveAndTest(pair.key, pair.secret)).ok, true);
  const run = () => app.catalogTools.estimate_cost({ model_id: FLARE, lane: "image", parameters: imageDefault, takes: 1 });
  answer = { status: 400, body: { reason: "Input width must be at most 3840" } };
  await assert.rejects(run(), (e) => e.type === "InvalidParameter" && e.message === "Scenario refused the price check: Input width must be at most 3840");
  answer = { status: 404, body: { reason: `Model ${FLARE} not found` } };
  await assert.rejects(run(), (e) => e.type === "ModelUnavailable");
  answer = { status: 500, body: { reason: "boom" } };
  await assert.rejects(run(), (e) => e.type === "Internal" && /HTTP 500: boom/.test(e.message));
  assert.equal(mock.priceChecks.length, 3, "a price check is never retried");
});

test("a price check that returns a job id raises the alarm and stops price checks for the session", async (t) => {
  const pair = newKeyPair();
  let withJob = true;
  const mock = await startFixtureScenario({
    accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "Alarm" })] }],
    answer: () => (withJob ? { status: 200, body: { job: { jobId: "job_fixtureAlarm", status: "queued" }, creativeUnitsCost: 2 } } : null)
  });
  mocks.push(mock);
  const host = fakeHost({ WebSocket: uxpWebSocket({ rewrite: (u) => u.replace(":9890", ":1") }), secure: [["scenario.pairing_token", newToken()]] });
  const app = await main.boot({ host, document: null, console: null, apiBaseUrl: mock.url });
  t.after(async () => {
    app.link.stop();
    await mock.close();
  });
  assert.equal((await app.auth.saveAndTest(pair.key, pair.secret)).ok, true);
  await assert.rejects(app.catalogTools.estimate_cost({ model_id: FLARE, lane: "image", parameters: imageDefault, takes: 1 }), (e) => e.type === "DryRunCreatedJob" && /created a job/.test(e.message));
  withJob = false;
  await assert.rejects(app.catalogTools.estimate_cost({ model_id: FLARE, lane: "image", parameters: imageDefault, takes: 1 }), (e) => e.type === "DryRunCreatedJob" && /stopped for this session/.test(e.message));
  assert.equal(mock.priceChecks.length, 1, "nothing more is sent after the alarm");
  assert.deepEqual(app.quotes.stopped().job_id, "job_fixtureAlarm");
  assert.match(app.diagnostics.text(), /DryRunCreatedJob/);
  // The classifier: a job key alone also counts; no price is an error.
  assert.throws(() => priceChecks.classify({ status: 269, body: { creativeUnitsCost: 1, job: {} } }), (e) => e.type === "DryRunCreatedJob");
  assert.throws(() => priceChecks.classify({ status: 269, body: { jobId: "job_x", creativeUnitsCost: 1 } }), (e) => e.type === "DryRunCreatedJob");
  assert.throws(() => priceChecks.classify({ status: 200, body: {} }), (e) => e.type === "Internal");
  assert.deepEqual(priceChecks.classify({ status: 269, body: { creativeUnitsCost: 2.5, creativeUnitsDiscount: 0, costDetails: { "custom-generation": 2.5, note: "x" } } }), { cost: 2.5, discount: 0, details: { "custom-generation": 2.5 } });
});

test("quotes: single use, 120 s, approved_cost character for character, bound to the request, the project and the key", async (t) => {
  let clock = Date.parse("2026-10-19T10:00:00Z");
  const { app, other } = await signedIn(t, { now: () => clock });
  const req = { model_id: FLARE, lane: "image", parameters: imageDefault, takes: 1, pending: {}, target: { kind: "new_document", width: 1024, height: 1024 } };
  const q = await app.quotes.estimate(req);
  assert.equal(q.label, "2 CU");
  assert.equal(q.expires_at, "2026-10-19T10:02:00.000Z");
  await assert.rejects(app.quotes.redeem(q.quote_id, "2.0", req), (e) => e.type === "CostMismatch");
  await assert.rejects(app.quotes.redeem(q.quote_id, "2", { ...req, takes: 2 }), (e) => e.type === "QuoteMismatch");
  await assert.rejects(app.quotes.redeem(q.quote_id, "2", { ...req, parameters: { ...imageDefault, prompt: "another" } }), (e) => e.type === "QuoteMismatch");
  await assert.rejects(app.quotes.redeem(q.quote_id, "2", { ...req, target: { kind: "new_document", width: 2048, height: 2048 } }), (e) => e.type === "QuoteMismatch");
  await assert.rejects(app.quotes.redeem("quote_000000000000000000000000", "2", req), (e) => e.type === "QuoteExpired");
  const ok = await app.quotes.redeem(q.quote_id, "2", { ...req, parameters: { height: 1024, width: 1024, quality: "low", prompt: "a lighthouse" } });
  assert.deepEqual({ kind: ok.kind, thousandths: ok.thousandths, max: ok.max }, { kind: "exact", thousandths: 2000, max: null });
  assert.match(ok.fingerprint, /^[0-9a-f]{64}$/);
  await assert.rejects(app.quotes.redeem(q.quote_id, "2", req), (e) => e.type === "QuoteUsed");

  const late = await app.quotes.estimate(req);
  clock += 120000;
  await assert.rejects(app.quotes.redeem(late.quote_id, "2", req), (e) => e.type === "QuoteExpired");

  const fresh = await app.quotes.estimate(req);
  assert.equal((await app.auth.saveAndTest(other.key, other.secret)).ok, true);
  await assert.rejects(app.quotes.redeem(fresh.quote_id, "2", req), (e) => e.type === "QuoteMismatch", "another project or key invalidates it");
});

test("prices: integer thousandths, exact strings without trailing zeros, K and M from 10,000", () => {
  assert.equal(price.toThousandths(2), 2000);
  assert.equal(price.toThousandths(0.1 + 0.2), 300);
  assert.equal(price.exactString(2000), "2");
  assert.equal(price.exactString(2500), "2.5");
  assert.equal(price.exactString(125), "0.125");
  assert.equal(price.exactString(1050), "1.05");
  assert.equal(price.display(9999999), "9999.999");
  assert.equal(price.display(10000000), "10K");
  assert.equal(price.display(12345000), "12.3K");
  assert.equal(price.display(999999000), "1M");
  assert.equal(price.display(1234567000), "1.23M");
  assert.equal(price.label("exact", 2000), "2 CU");
  assert.equal(price.label("range", 2000, 4500), "2 to 4.5 CU");
  assert.equal(price.label("from", 1000), "from 1 CU");
});

test("every price check sent by this file had exactly ?dryRun=true; nothing else reached /generate", () => {
  let checks = 0;
  for (const m of mocks) {
    assert.deepEqual(m.violations, []);
    for (const r of m.requests.filter((x) => x.path.startsWith("/v1/generate"))) {
      assert.equal(r.method, "POST");
      assert.equal(r.search, "?dryRun=true");
      assert.deepEqual(r.query, { dryRun: "true" });
      checks++;
    }
  }
  assert.ok(checks >= 15, `${checks} price checks seen`);
});
