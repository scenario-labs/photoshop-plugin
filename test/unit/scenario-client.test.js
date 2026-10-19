"use strict";
// The REST client (plugin/src/scenario/client.js) against a mock Scenario API:
// HTTP Basic to the API only, never through a redirect, read retries, timeouts,
// offline, and the error classification of SPEC 3.13.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const clientMod = require("../../plugin/src/scenario/client.js");
const errorsMod = require("../../plugin/src/scenario/errors.js");
const API = require("../../shared/scenario-api.json");
const errorsJson = require("../../shared/errors.json");
const { createRedactor } = require("../../plugin/src/util/redact.js");
const { startMockScenario, newKeyPair, basic } = require("../helpers/mock-scenario.js");
const { freePort } = require("../helpers/fakes.js");

function client(mock, pair, extra = {}) {
  const waits = [];
  const c = clientMod.createClient({
    fetch: globalThis.fetch,
    AbortController: globalThis.AbortController,
    credentials: () => pair,
    baseUrl: mock ? mock.url : extra.baseUrl,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...extra
  });
  return { c, waits };
}

test("the production base URL is Scenario's API over HTTPS", () => {
  assert.equal(API.base_url, "https://api.cloud.scenario.com/v1");
  assert.equal(clientMod.originOf(API.base_url), "https://api.cloud.scenario.com");
  const c = clientMod.createClient({ fetch: () => Promise.reject(new Error("no network in this test")) });
  assert.equal(c.baseUrl, API.base_url);
  for (const e of API.known_errors.texts) {
    assert.ok(errorsJson.types[e.type], `${e.type} is an error type`);
    assert.equal(typeof e.status, "number");
    assert.ok(e.text.length > 3);
  }
});

test("requests carry HTTP Basic with key:secret, and only to the API", async (t) => {
  const pair = newKeyPair();
  const mock = await startMockScenario({ accounts: [{ ...pair, projects: [] }] });
  t.after(() => mock.close());
  const { c } = client(mock, pair);
  const r = await c.request("GET", "/models", { query: { pageSize: "1", empty: null } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { models: [], nextPaginationToken: null });
  assert.equal(mock.requests[0].authorization, basic(pair));
  assert.equal(mock.requests[0].path, "/v1/models");
  assert.deepEqual(mock.requests[0].query, { pageSize: "1" });
  for (const bad of ["https://elsewhere.example/x", "//elsewhere.example/x", "models", "/a/../b", "/a?x=1", "/a\\b"]) {
    await assert.rejects(c.request("GET", bad), (e) => e.type === "Internal" && /relative/.test(e.message), bad);
  }
  assert.equal(mock.requests.length, 1, "no refused path reached the network");
});

test("a redirect is never followed, so the key never reaches another host", async (t) => {
  const pair = newKeyPair();
  const seenElsewhere = [];
  const other = http.createServer((req, res) => {
    seenElsewhere.push(req.headers.authorization || null);
    res.end("{}");
  });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => other.close(r)));
  const target = `http://127.0.0.1:${other.address().port}/v1/models`;
  const mock = await startMockScenario({ accounts: [{ ...pair }], handle: () => ({ status: 302, body: "", headers: { location: target } }) });
  t.after(() => mock.close());
  const { c } = client(mock, pair);
  await assert.rejects(c.request("GET", "/models"), (e) => e.type === "Internal" && /redirect/.test(e.message));
  assert.deepEqual(seenElsewhere, [], "the other host received nothing");
});

test("reads retry after 429 (Retry-After) and 503; other errors and paid calls do not retry", async (t) => {
  const pair = newKeyPair();
  let n = 0;
  const mock = await startMockScenario({
    accounts: [{ ...pair }],
    handle: ({ path }) => {
      n++;
      if (path === "/v1/models" && n === 1) return { status: 429, body: { code: "rate_limited", message: "slow down" }, headers: { "retry-after": "7" } };
      if (path === "/v1/models" && n === 2) return { status: 503, body: { message: "busy" } };
      if (path === "/v1/projects") return { status: 500, body: { message: "boom" } };
      if (path === "/v1/generate") return { status: 429, body: {} };
      return undefined;
    }
  });
  t.after(() => mock.close());
  const seen = [];
  const { c, waits } = client(mock, pair);
  const r = await c.request("GET", "/models", { onWait: (s) => seen.push(s) });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, [7, 1]);
  assert.deepEqual(waits, [7000, 1000]);
  await assert.rejects(c.request("GET", "/projects"), (e) => e.type === "Internal" && e.status === 500 && /HTTP 500: boom/.test(e.message));
  assert.equal(mock.requests.filter((q) => q.path === "/v1/projects").length, 1, "500 is not retried");
  await assert.rejects(c.request("POST", "/generate", { body: { a: 1 }, paid: true }), (e) => e.type === "RateLimited");
  assert.equal(mock.requests.filter((q) => q.path === "/v1/generate").length, 1, "a paid call is never retried");
  // Retry-After as an HTTP date, and the cap.
  assert.equal(errorsMod.retryAfter({ get: () => new Date(Date.now() + 9000).toUTCString() }) >= 8, true);
  mock.setHandler(() => ({ status: 429, body: {}, headers: { "retry-after": "999" } }));
  const capped = [];
  await assert.rejects(c.request("GET", "/models", { onWait: (s) => capped.push(s) }), (e) => e.type === "RateLimited");
  assert.deepEqual(capped, [API.reads.rate_limit_max_wait_s, API.reads.rate_limit_max_wait_s]);
});

test("no answer in time and no server both read as Offline", async (t) => {
  const pair = newKeyPair();
  const mock = await startMockScenario({ accounts: [{ ...pair }], handle: () => ({ status: null }) });
  t.after(() => mock.close());
  const { c } = client(mock, pair);
  await assert.rejects(c.request("GET", "/models", { timeoutMs: 150 }), (e) => e.type === "Offline" && /did not answer/.test(e.message));
  const port = await freePort();
  const { c: down } = client(null, pair, { baseUrl: `http://127.0.0.1:${port}/v1` });
  await assert.rejects(down.request("GET", "/models"), (e) => e.type === "Offline" && e.message === "No connection to Scenario.");
  const { c: none } = client(null, null, { baseUrl: `http://127.0.0.1:${port}/v1` });
  await assert.rejects(none.request("GET", "/models"), (e) => e.type === "NotSignedIn");
});

test("errors: status and listed body codes classify; Scenario's message is one line with secrets removed", async (t) => {
  const pair = newKeyPair();
  const mock = await startMockScenario({
    accounts: [{ ...pair }],
    handle: ({ path }) => {
      if (path === "/v1/a") return { status: 403, body: { reason: `Key ${pair.key} with\nsecret ${pair.secret} refused` } };
      if (path === "/v1/b") return { status: 401, body: { message: "Unauthorized" } };
      if (path === "/v1/c") return { status: 402, body: "not json at all" };
      if (path === "/v1/d") return { status: 403, body: { reason: "Given APIKey does not exists" } };
      if (path === "/v1/e") return { status: 404, body: { reason: "Given APIKey does not exists" } };
      if (path === "/v1/f") return { status: 400, body: { status: 400, code: "bad", message: "Odd shape" } };
      return undefined;
    }
  });
  t.after(() => mock.close());
  const redactor = createRedactor();
  const { c } = client(mock, pair, { redactor });
  await assert.rejects(c.request("GET", "/a"), (e) => {
    assert.equal(e.type, "Forbidden");
    assert.equal(e.code, null, "Scenario's bodies carry no code");
    assert.ok(!e.message.includes(pair.key) && !e.message.includes(pair.secret), "the key and secret are removed");
    assert.ok(!e.scenarioMessage.includes("\n"));
    assert.match(e.scenarioMessage, /^Key \[redacted\] with secret \[redacted\] refused$/);
    assert.equal(String(e), `Forbidden: ${e.message}`);
    return true;
  });
  // An unknown key answers 403 with a known reason: the key is refused, as on 401.
  await assert.rejects(c.request("GET", "/d"), (e) => e.type === "Unauthorized" && e.scenarioMessage === "Given APIKey does not exists");
  await assert.rejects(c.request("GET", "/e"), (e) => e.type === "Internal", "a known text counts only at its status");
  await assert.rejects(c.request("GET", "/b"), (e) => e.type === "Unauthorized" && e.scenarioMessage === "Unauthorized");
  await assert.rejects(c.request("GET", "/f"), (e) => e.type === "Internal" && e.code === "bad" && /Odd shape \(bad\)/.test(e.message));
  API.known_errors.texts.push({ status: 403, text: "refused", type: "NoApiAccess" });
  try {
    await assert.rejects(c.request("GET", "/a"), (e) => e.type === "NoApiAccess", "texts are data");
  } finally {
    API.known_errors.texts.pop();
  }
  await assert.rejects(c.request("GET", "/c"), (e) => e.type === "Internal" && /HTTP 402: not json at all/.test(e.message));
  const long = errorsMod.fromResponse(400, { message: "x".repeat(1000) });
  assert.ok(long.scenarioMessage.length <= 300);
});

test("the Basic header is standard base64 of the UTF-8 pair", () => {
  for (const pair of [newKeyPair(), { key: "hello", secret: "world" }, { key: "kéy", secret: "s\u{1F600}" }]) {
    assert.equal(`Basic ${clientMod.basicToken(pair)}`, basic(pair));
  }
  assert.equal(clientMod.basicToken({ key: "hello", secret: "world" }), "aGVsbG86d29ybGQ=");
});
