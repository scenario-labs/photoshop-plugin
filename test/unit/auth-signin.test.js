"use strict";
// Sign-in against a mock Scenario API (SPEC 4.2, 4.5, 3.13, 3.14): Save and
// test in every state, what is stored and where, persistence, the project
// switch for a second key, Test connection and Sign out. Keys are made per
// test; no real key is used.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccounts, keyHash, INDEX_ENTRY, KEY_ENTRY_PREFIX } = require("../../plugin/src/auth/accounts.js");
const { createAuth } = require("../../plugin/src/auth/auth.js");
const { createClient } = require("../../plugin/src/scenario/client.js");
const { createRedactor } = require("../../plugin/src/util/redact.js");
const API = require("../../shared/scenario-api.json");
const { startMockScenario, newKeyPair, projectRecord, MEMBER_EMAIL, OTHER_KEY_ID } = require("../helpers/mock-scenario.js");
const { fakeHost, freePort } = require("../helpers/fakes.js");

function setup(baseUrl, over = {}) {
  const host = over.host || fakeHost(over);
  const redactor = createRedactor();
  const accounts = createAccounts(host, redactor);
  const client = createClient({ fetch: globalThis.fetch, AbortController: globalThis.AbortController, timers: host.timers, credentials: accounts.credentials, redactor, baseUrl, sleep: async () => {} });
  const logs = [];
  const errors = [];
  const auth = createAuth({ client, accounts, redactor, log: (t) => logs.push(t), recordError: (t) => errors.push(t) });
  return { host, accounts, auth, logs, errors, redactor };
}

async function mockWith(t, accounts, handle) {
  const mock = await startMockScenario({ accounts, handle });
  t.after(() => mock.close());
  return mock;
}

function steps() {
  const seen = [];
  return { seen, hooks: { onStep: (s, n) => seen.push(`${s}/${n}`), onWait: (s) => seen.push(`wait ${s}`) } };
}

test("Save and test: two free reads, then the pair is saved under a hashed entry name", async (t) => {
  const pair = newKeyPair();
  const mock = await mockWith(t, [{ ...pair, projects: [projectRecord(pair.key, { id: "project_fall", name: "Fall campaign" })] }]);
  const s = setup(mock.url);
  await s.accounts.load();
  assert.deepEqual(s.auth.status(), { signed_in: false, project_name: null });
  const { seen, hooks } = steps();
  const out = await s.auth.saveAndTest(`  ${pair.key} `, pair.secret, hooks);
  assert.equal(out.ok, true);
  assert.deepEqual(seen, ["1/2", "2/2"]);
  assert.equal(out.account.project_name, "Fall campaign");
  assert.equal(out.account.key_last4, pair.key.slice(-4));
  assert.equal(out.account.key_hash, keyHash(pair.key));
  assert.deepEqual(s.auth.status(), { signed_in: true, project_name: "Fall campaign" });
  assert.deepEqual(mock.requests.map((r) => `${r.method} ${r.path}`), ["GET /v1/models", "GET /v1/projects"]);
  assert.deepEqual(mock.requests[0].query, API.sign_in.auth_check.query);
  assert.equal(mock.requests[1].query.pageSize, "100");

  const names = [...s.host.secure.keys()].sort();
  const entry = `${KEY_ENTRY_PREFIX}${keyHash(pair.key).slice(0, 32)}`;
  assert.deepEqual(names, [INDEX_ENTRY, entry].sort());
  for (const name of names) {
    assert.ok(!name.includes(pair.key) && !name.includes(pair.secret) && !name.includes("Fall"), `entry name ${name} reveals nothing`);
  }
  const index = JSON.parse(s.host.secure.get(INDEX_ENTRY));
  assert.equal(index.current, keyHash(pair.key).slice(0, 32));
  assert.ok(!JSON.stringify(index).includes(pair.key) && !JSON.stringify(index).includes(pair.secret), "the index holds no key or secret");
  assert.deepEqual(JSON.parse(s.host.secure.get(entry)), { v: 1, key: pair.key, secret: pair.secret });
  assert.ok(s.logs.some((l) => /key saved \(1 project\(s\) saved\)/.test(l)));
  assert.ok(!s.logs.join("\n").includes("Fall campaign"), "logs hold no project name");

  // Persistence: a new start reads the same secure storage.
  const again = setup(mock.url, { host: s.host });
  const sum = await again.accounts.load();
  assert.deepEqual(sum, { signed_in: true, project_name: "Fall campaign", count: 1 });
  assert.deepEqual(again.accounts.credentials(), pair);
});

test("a wrong key or secret: 'Scenario did not accept this key and secret.', nothing saved", async (t) => {
  const pair = newKeyPair();
  const mock = await mockWith(t, [{ ...pair, projects: [] }]);
  const s = setup(mock.url);
  await s.accounts.load();
  // The live API answers an unknown key with 403 "Given APIKey does not exists".
  const out = await s.auth.saveAndTest(pair.key, "wrong-secret");
  assert.deepEqual({ ok: out.ok, state: out.state, type: out.type }, { ok: false, state: "key_refused", type: "Unauthorized" });
  assert.equal(s.host.secure.size, 0, "nothing stored");
  assert.deepEqual(s.errors, ["Unauthorized"]);
  assert.equal(mock.requests.length, 1, "the check stops at the first refusal");
  // And with 401.
  mock.setHandler(() => ({ status: 401, body: { message: "Unauthorized" } }));
  assert.equal((await s.auth.saveAndTest(pair.key, pair.secret)).state, "key_refused");
  mock.setHandler(null);

  // A 401 on the second read also refuses the key.
  mock.setHandler(({ path }) => (path === "/v1/projects" ? { status: 401, body: { message: "Invalid credentials" } } : undefined));
  const second = await s.auth.saveAndTest(pair.key, pair.secret);
  assert.equal(second.state, "key_refused");
  assert.equal(s.host.secure.size, 0);
});

test("missing key or secret: refused before any request", async (t) => {
  const mock = await mockWith(t, []);
  const s = setup(mock.url);
  for (const [k, sec] of [["", "x"], ["api_x", ""], ["two words", "x"], [null, undefined]]) {
    const out = await s.auth.saveAndTest(k, sec);
    assert.equal(out.state, "missing");
  }
  assert.equal(mock.requests.length, 0);
});

test("offline: no server, or the connection drops on the second read", async (t) => {
  const pair = newKeyPair();
  const port = await freePort();
  const s = setup(`http://127.0.0.1:${port}/v1`);
  const out = await s.auth.saveAndTest(pair.key, pair.secret);
  assert.deepEqual([out.state, out.type], ["offline", "Offline"]);
  const mock = await mockWith(t, [{ ...pair, projects: [] }], ({ path }) => (path === "/v1/projects" ? { destroy: true } : undefined));
  const s2 = setup(mock.url);
  const out2 = await s2.auth.saveAndTest(pair.key, pair.secret);
  assert.equal(out2.state, "offline");
  assert.equal(s2.host.secure.size, 0);
});

test("Team key and Reader key, where the project listing shows them: refused, nothing saved", async (t) => {
  const team = newKeyPair();
  const reader = newKeyPair();
  const teamForbidden = newKeyPair();
  const mock = await mockWith(
    t,
    [
      { ...team, projects: [projectRecord(team.key, { scope: "team", role: "admin" })] },
      { ...reader, projects: [projectRecord(reader.key, { role: "reader" })] },
      { ...teamForbidden, projects: [projectRecord(teamForbidden.key, { scope: "team", role: "admin" })] }
    ],
    ({ path, account }) => (account && account.key === teamForbidden.key && path === "/v1/models" ? { status: 403, body: { message: "No generation scope" } } : undefined)
  );
  const s = setup(mock.url);
  const a = await s.auth.saveAndTest(team.key, team.secret);
  assert.deepEqual([a.state, a.type], ["team_key", "KeyCannotGenerate"]);
  const b = await s.auth.saveAndTest(reader.key, reader.secret);
  assert.deepEqual([b.state, b.type, b.role], ["cannot_generate", "KeyCannotGenerate", "reader"]);
  const c = await s.auth.saveAndTest(teamForbidden.key, teamForbidden.secret);
  assert.equal(c.state, "team_key", "a 403 on the first read still reads the listing to name a Team key");
  assert.equal(s.host.secure.size, 0);
});

test("a 403 on the authenticated read: 'This key can't run models.' with Scenario's message", async (t) => {
  const pair = newKeyPair();
  const mock = await mockWith(t, [{ ...pair, projects: [] }], ({ path }) => {
    if (path === "/v1/models") return { status: 403, body: { status: 403, code: "forbidden", message: "Missing scope models:read" } };
    if (path === "/v1/projects") return { status: 403, body: { message: "nope" } };
    return undefined;
  });
  const s = setup(mock.url);
  const out = await s.auth.saveAndTest(pair.key, pair.secret);
  assert.deepEqual([out.state, out.type, out.scenario_message], ["cannot_generate", "KeyCannotGenerate", "Missing scope models:read"]);
  assert.equal(s.host.secure.size, 0);
});

test("no project name readable: saved, and the header falls back to the key's last 4 characters", async (t) => {
  const pair = newKeyPair();
  const mock = await mockWith(t, [{ ...pair }], ({ path }) => (path === "/v1/projects" ? { status: 403, body: {} } : undefined));
  const s = setup(mock.url);
  const out = await s.auth.saveAndTest(pair.key, pair.secret);
  assert.equal(out.ok, true);
  assert.equal(out.account.project_name, null);
  assert.deepEqual(s.auth.status(), { signed_in: true, project_name: null });
  // Odd shapes are not fatal either.
  for (const body of [{ projects: "x" }, {}, [1, 2]]) {
    mock.setHandler(({ path }) => (path === "/v1/projects" ? { status: 200, body } : undefined));
    assert.equal((await s.auth.saveAndTest(pair.key, pair.secret)).ok, true);
  }
});

test("the listing without key details: one project names the key's project", async (t) => {
  const pair = newKeyPair();
  const mock = await mockWith(t, [{ ...pair, projects: [projectRecord(pair.key, { name: "Solo", withKeys: false })] }]);
  const s = setup(mock.url);
  const out = await s.auth.saveAndTest(pair.key, pair.secret);
  assert.equal(out.account.project_name, "Solo");
});

test("the listing is paged: the plugin follows nextPaginationToken until it finds the key", async (t) => {
  const pair = newKeyPair();
  const mine = projectRecord(pair.key, { id: "p_mine", name: "Second page" });
  const mock = await mockWith(t, [{ ...pair }], ({ path, query }) => {
    if (path !== "/v1/projects") return undefined;
    if (!query.paginationToken) return { status: 200, body: { projects: [projectRecord("api_x", { id: "p1", name: "A" }), projectRecord("api_y", { id: "p2", name: "B" })], nextPaginationToken: "page2" } };
    if (query.paginationToken === "page2") return { status: 200, body: { projects: [mine], nextPaginationToken: "page3" } };
    return { status: 500, body: {} };
  });
  const s = setup(mock.url);
  const out = await s.auth.saveAndTest(pair.key, pair.secret);
  assert.equal(out.account.project_name, "Second page");
  assert.equal(mock.requests.filter((r) => r.path === "/v1/projects").length, 2, "stops once the key is found");
});

test("texts listed as data: no API access and a CU limit get their SPEC states", async (t) => {
  const pair = newKeyPair();
  const mock = await mockWith(t, [{ ...pair, projects: [] }], ({ path }) => (path === "/v1/models" ? { status: 403, body: { reason: "Some future plan text" } } : undefined));
  const s = setup(mock.url);
  const entry = { status: 403, text: "future plan text", type: "NoApiAccess" };
  API.known_errors.texts.push(entry);
  try {
    assert.equal((await s.auth.saveAndTest(pair.key, pair.secret)).state, "no_api_access");
    entry.type = "PlanLimit";
    assert.equal((await s.auth.saveAndTest(pair.key, pair.secret)).state, "plan_limit");
    entry.type = "KeyCannotGenerate";
    assert.equal((await s.auth.saveAndTest(pair.key, pair.secret)).state, "cannot_generate");
  } finally {
    API.known_errors.texts.pop();
  }
  assert.equal(s.host.secure.size, 0);
});

test("busy (429 after the retries) and a server error: their own states, nothing saved", async (t) => {
  const pair = newKeyPair();
  const mock = await mockWith(t, [{ ...pair }], () => ({ status: 429, body: {}, headers: { "retry-after": "2" } }));
  const s = setup(mock.url);
  const { seen, hooks } = steps();
  const out = await s.auth.saveAndTest(pair.key, pair.secret, hooks);
  assert.equal(out.state, "busy");
  assert.deepEqual(seen, ["1/2", "wait 2", "wait 2"]);
  mock.setHandler(() => ({ status: 500, body: { message: "Internal error" } }));
  const failed = await s.auth.saveAndTest(pair.key, pair.secret);
  assert.deepEqual([failed.state, failed.scenario_message], ["failed", "Internal error"]);
  assert.equal(s.host.secure.size, 0);
});

test("secure storage refusing the key: storage_failed, and no half-saved entry", async (t) => {
  const pair = newKeyPair();
  const mock = await mockWith(t, [{ ...pair, projects: [projectRecord(pair.key)] }]);
  const s = setup(mock.url, { secureSetFails: (name) => name === INDEX_ENTRY });
  const out = await s.auth.saveAndTest(pair.key, pair.secret);
  assert.equal(out.state, "storage_failed");
  assert.equal(s.host.secure.size, 0, "the key entry written first is removed again");
  assert.deepEqual(s.auth.status(), { signed_in: false, project_name: null });
});

test("one test at a time", async (t) => {
  const pair = newKeyPair();
  const mock = await mockWith(t, [{ ...pair, projects: [] }]);
  const s = setup(mock.url);
  const [a, b] = await Promise.all([s.auth.saveAndTest(pair.key, pair.secret), s.auth.saveAndTest(pair.key, pair.secret)]);
  assert.equal(a.ok, true);
  assert.equal(b.state, "in_progress");
});

test("a second project's key, the switch, one key per project, and Sign out", async (t) => {
  const one = newKeyPair();
  const two = newKeyPair();
  const twoAgain = newKeyPair();
  const mock = await mockWith(t, [
    { ...one, projects: [projectRecord(one.key, { id: "p_one", name: "Fall campaign" })] },
    { ...two, projects: [projectRecord(two.key, { id: "p_two", name: "Mascot training" })] },
    { ...twoAgain, projects: [projectRecord(twoAgain.key, { id: "p_two", name: "Mascot training" })] }
  ]);
  const s = setup(mock.url);
  await s.accounts.load();
  await s.auth.saveAndTest(one.key, one.secret);
  await s.auth.saveAndTest(two.key, two.secret);
  assert.deepEqual(s.auth.status(), { signed_in: true, project_name: "Mascot training" }, "the new key becomes current");
  const list = s.auth.list();
  assert.deepEqual(list.map((a) => [a.project_name, a.key_last4, a.current]), [
    ["Fall campaign", one.key.slice(-4), false],
    ["Mascot training", two.key.slice(-4), true]
  ]);
  assert.ok(list.every((a) => Object.keys(a).sort().join() === "current,id,key_last4,project_name"), "lists carry no key, secret or project id");

  await s.auth.switchTo(list[0].id);
  assert.deepEqual(s.auth.status(), { signed_in: true, project_name: "Fall campaign" });
  assert.deepEqual(s.accounts.credentials(), one);

  // A new key for a project that has one replaces it.
  await s.auth.saveAndTest(twoAgain.key, twoAgain.secret);
  assert.equal(s.auth.list().length, 2);
  assert.ok(!s.host.secure.has(`${KEY_ENTRY_PREFIX}${keyHash(two.key).slice(0, 32)}`), "the old key of that project is removed");

  // Sign out of the current project: the other saved project becomes current.
  await s.auth.signOut();
  assert.deepEqual(s.auth.status(), { signed_in: true, project_name: "Fall campaign" });
  assert.ok(!s.host.secure.has(`${KEY_ENTRY_PREFIX}${keyHash(twoAgain.key).slice(0, 32)}`));
  await s.auth.signOut();
  assert.deepEqual(s.auth.status(), { signed_in: false, project_name: null });
  assert.equal(s.accounts.credentials(), null);
  assert.deepEqual([...s.host.secure.keys()], [INDEX_ENTRY], "only the empty index is left");
  assert.deepEqual(JSON.parse(s.host.secure.get(INDEX_ENTRY)).accounts, []);
  const after = setup(mock.url, { host: s.host });
  assert.equal((await after.accounts.load()).signed_in, false, "still signed out after a restart");
});

test("Test connection: refreshes the name, reports a revoked key, keeps the saved key", async (t) => {
  const pair = newKeyPair();
  const rec = projectRecord(pair.key, { id: "p1", name: "Old name" });
  const mock = await mockWith(t, [{ ...pair, projects: [rec] }]);
  const s = setup(mock.url);
  assert.equal((await s.auth.testConnection()).state, "not_signed_in");
  await s.auth.saveAndTest(pair.key, pair.secret);
  rec.name = "New name";
  const ok = await s.auth.testConnection();
  assert.equal(ok.ok, true);
  assert.equal(ok.account.project_name, "New name");
  assert.deepEqual(s.auth.status(), { signed_in: true, project_name: "New name" });
  mock.setHandler(() => ({ status: 401, body: { message: "revoked" } }));
  const refused = await s.auth.testConnection();
  assert.equal(refused.state, "key_refused");
  assert.equal(s.auth.status().signed_in, true, "the saved key stays until the person signs out or replaces it");
});

test("damaged storage: a broken index means signed out; an unreadable key entry is dropped", async (t) => {
  const pair = newKeyPair();
  const mock = await mockWith(t, [{ ...pair, projects: [projectRecord(pair.key)] }]);
  const s = setup(mock.url);
  await s.auth.saveAndTest(pair.key, pair.secret);
  const entry = `${KEY_ENTRY_PREFIX}${keyHash(pair.key).slice(0, 32)}`;

  s.host.secure.set(entry, "");
  const a = setup(mock.url, { host: s.host });
  assert.equal((await a.accounts.load()).signed_in, false);
  assert.deepEqual(JSON.parse(s.host.secure.get(INDEX_ENTRY)).accounts, [], "the unreadable entry left the list");

  s.host.secure.set(INDEX_ENTRY, "{not json");
  const b = setup(mock.url, { host: s.host });
  assert.equal((await b.accounts.load()).signed_in, false);

  // An entry whose key does not match the hash it is filed under is refused.
  await s.auth.saveAndTest(pair.key, pair.secret);
  s.host.secure.set(entry, JSON.stringify({ v: 1, key: "api_other", secret: "x" }));
  const c = setup(mock.url, { host: s.host });
  assert.equal((await c.accounts.load()).signed_in, false);
});

test("project names from the API are kept as one line of at most 100 characters", async (t) => {
  const pair = newKeyPair();
  const mock = await mockWith(t, [{ ...pair, projects: [projectRecord(pair.key, { name: `  Line one\nline\ttwo ${"x".repeat(200)}` })] }]);
  const s = setup(mock.url);
  const out = await s.auth.saveAndTest(pair.key, pair.secret);
  assert.ok(out.account.project_name.startsWith("Line one line two x"));
  assert.ok(out.account.project_name.length <= 100);
  assert.ok(!/[\n\t]/.test(out.account.project_name));
});

test("the project listing's member emails and other key ids never reach logs, status, storage or errors", async (t) => {
  const pair = newKeyPair();
  const rec = projectRecord(pair.key, { id: "p_list", name: "Listed" });
  assert.ok(JSON.stringify(rec).includes(MEMBER_EMAIL) && JSON.stringify(rec).includes(OTHER_KEY_ID), "the fixture carries both, as the live answer does");
  const mock = await mockWith(t, [{ ...pair, projects: [rec] }]);
  const s = setup(mock.url);
  await s.accounts.load();
  const out = await s.auth.saveAndTest(pair.key, pair.secret);
  assert.equal(out.ok, true);
  const tested = await s.auth.testConnection();
  // A failure whose text would carry them is not echoed either: Scenario's
  // text is shown only for errors, and the listing is never an error body.
  mock.setHandler(() => ({ status: 500, body: { reason: "Internal error" } }));
  const failed = await s.auth.testConnection();
  const sinks = {
    logs: s.logs.join("\n"),
    status: JSON.stringify(s.auth.status()),
    list: JSON.stringify(s.auth.list()),
    current: JSON.stringify(s.auth.current()),
    outcomes: JSON.stringify([out, tested, failed]),
    errors: JSON.stringify(s.errors),
    storage_names: JSON.stringify([...s.host.secure.keys()]),
    storage_values: JSON.stringify([...s.host.secure.values()]),
    files: JSON.stringify([...s.host.files.entries()])
  };
  for (const [where, text] of Object.entries(sinks)) {
    assert.ok(!text.includes(MEMBER_EMAIL), `no member email in ${where}`);
    assert.ok(!text.includes(OTHER_KEY_ID), `no other key id in ${where}`);
    assert.ok(!text.includes("user_mock") && !text.includes("apiu_"), `no member or key member id in ${where}`);
  }
  // What is kept: the project name and id in the encrypted index, nothing else from the listing.
  const index = JSON.parse(s.host.secure.get(INDEX_ENTRY));
  assert.deepEqual(Object.keys(index.accounts[0]).sort(), ["id", "key_hash", "key_last4", "project_id", "project_name", "saved_at"]);
  assert.deepEqual([index.accounts[0].project_name, index.accounts[0].project_id], ["Listed", "p_list"]);
});
