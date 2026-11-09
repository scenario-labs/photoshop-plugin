"use strict";
// Sign in with Scenario (SPEC 4.6) against a mock identity provider and a
// mock Scenario API: the device sign-in in each outcome, the teams and
// projects of the account (two teams with two projects, a team without one),
// what is stored and where, the Bearer token and the projectId on each
// request, refresh with rotation, a refused refresh, Test connection, sign
// out, and a key project next to a browser sign-in. Tokens are made per test.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccounts, sessionId, browserHash, INDEX_ENTRY, SESSION_ENTRY_PREFIX } = require("../../plugin/src/auth/accounts.js");
const { createAuth, teamsFrom } = require("../../plugin/src/auth/auth.js");
const { createOAuth, createSession, claims, tokensFrom } = require("../../plugin/src/auth/oauth.js");
const { createClient } = require("../../plugin/src/scenario/client.js");
const { createRedactor } = require("../../plugin/src/util/redact.js");
const priceChecks = require("../../plugin/src/scenario/dry-run.js");
const paidMod = require("../../plugin/src/scenario/paid.js");
const API = require("../../shared/scenario-api.json");
const { startMockScenario, newKeyPair, projectRecord, teamsFixture } = require("../helpers/mock-scenario.js");
const { startMockOAuth, jwt, emailOf } = require("../helpers/mock-oauth.js");
const { fakeHost } = require("../helpers/fakes.js");

async function setup(t, { oauth: oauthOpts = {}, teams = teamsFixture(), keyAccounts = [], host, clock } = {}) {
  const idp = await startMockOAuth(oauthOpts);
  const box = { teams };
  const api = await startMockScenario({ accounts: keyAccounts, oauth: { subjectOf: (token) => idp.subjectOf(token), teams: () => box.teams } });
  t.after(async () => {
    await api.close();
    await idp.close();
  });
  const h = host || fakeHost();
  if (clock) h.timers.now = () => clock.now;
  const redactor = createRedactor();
  const oauth = createOAuth({ fetch: globalThis.fetch, AbortController: globalThis.AbortController, timers: h.timers, redactor, target: idp.target, sleep: async () => {} });
  const ended = [];
  const accounts = createAccounts(h, redactor, {
    openSession: (stored, save, onEnd, initial) =>
      createSession({
        oauth,
        refresh_token: stored.refresh_token,
        access_token: initial ? initial.access_token : null,
        expires_at: initial ? initial.expires_at : 0,
        now: h.timers.now,
        save,
        onEnd: () => {
          ended.push(stored.subject);
          return onEnd();
        }
      })
  });
  const client = createClient({ fetch: globalThis.fetch, AbortController: globalThis.AbortController, timers: h.timers, credentials: accounts.credentials, redactor, baseUrl: api.url, sleep: async () => {} });
  const logs = [];
  const opened = [];
  const auth = createAuth({ client, accounts, redactor, log: (l) => logs.push(l), recordError: () => {}, oauth, openPage: async (url) => opened.push(url), now: h.timers.now });
  return { idp, api, box, host: h, redactor, oauth, accounts, client, auth, logs, opened, ended };
}

function codes() {
  const seen = [];
  return { seen, hooks: { onCode: (c) => seen.push(c) } };
}

test("teams: teams and their projects by name whatever the server's order, a team without a project last; records without an id are skipped", () => {
  const teams = teamsFrom({ teams: [...teamsFixture(), { name: "no id" }, { id: "team_x", projects: [{ name: "no id" }, { id: "project_y" }] }] });
  assert.deepEqual(
    teams.map((t) => [t.id, t.name, t.projects.map((p) => `${p.id}:${p.name}`)]),
    [
      ["team_personal", "Personal", ["project_sketches:Sketches", "project_tests:Tests"]],
      ["team_studio", "Studio", ["project_film:Film", "project_poster:Poster"]],
      ["team_x", "team_x", ["project_y:project_y"]],
      ["team_empty", "Empty team", []]
    ]
  );
  assert.deepEqual(teamsFrom(null), []);
  assert.deepEqual(teamsFrom({ teams: "x" }), []);
});

test("token answers: a Bearer token with a subject and a refresh token, or nothing; the ID token gives the email of the same person", () => {
  const access = jwt({ sub: "user_1", exp: 2000000000 });
  const t0 = tokensFrom({ access_token: access, token_type: "Bearer", expires_in: 60, refresh_token: "rt_1", id_token: jwt({ sub: "user_1", email: emailOf("a") }) }, 1000);
  assert.deepEqual(t0, { access_token: access, refresh_token: "rt_1", expires_at: 61000, subject: "user_1", email: emailOf("a") });
  assert.equal(tokensFrom({ access_token: access, token_type: "Bearer", expires_in: 60, refresh_token: "rt_1", id_token: jwt({ sub: "user_2", email: emailOf("a") }) }, 0).email, null, "another person's ID token is ignored");
  assert.equal(tokensFrom({ access_token: access, token_type: "mac", refresh_token: "rt" }, 0), null);
  assert.equal(tokensFrom({ access_token: access, token_type: "Bearer" }, 0), null, "no refresh token: no session");
  assert.equal(tokensFrom({ access_token: "not.a-jwt", token_type: "Bearer", refresh_token: "rt" }, 0), null);
  assert.equal(claims("a.b"), null);
});

test("sign in: the code is shown, the page opens, pending and slow_down are waited out, then the projects to choose from", async (t) => {
  const s = await setup(t, { oauth: { approveAfter: 2, slowDownAt: 2 } });
  await s.accounts.load();
  const { seen, hooks } = codes();
  const out = await s.auth.signInWithBrowser(hooks);
  assert.equal(out.ok, true);
  assert.equal(out.choose, true, "several projects: the panel asks");
  assert.deepEqual(out.teams.map((x) => x.projects.length), [2, 2, 0]);
  assert.equal(seen.length, 1);
  assert.match(seen[0].user_code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.deepEqual(s.opened, [`https://sign-in.example.invalid/device?user_code=${seen[0].user_code}`], "the page with the code in it");
  // The identity provider got form posts with the client id and no secret.
  const device = s.idp.state.requests.filter((r) => r.path === "/oauth/device_authorization");
  assert.equal(device.length, 1);
  assert.equal(device[0].contentType, "application/x-www-form-urlencoded");
  assert.deepEqual(device[0].form, { client_id: s.idp.state.clientId, scope: "openid email profile offline_access" });
  assert.equal(s.idp.state.polls, 3, "two pending answers (one of them slow_down), then the tokens");
  for (const r of s.idp.state.requests) assert.equal(r.authorization, null, "a public client sends no secret");
  // The teams were read with the new token and no project.
  const teamsReq = s.api.requests.filter((r) => r.path === "/v1/teams");
  assert.equal(teamsReq.length, 1);
  assert.match(teamsReq[0].authorization, /^Bearer /);
  assert.equal(teamsReq[0].search, "", "the team list names no project");
  // Nothing is saved until a project is chosen.
  assert.equal(s.auth.current(), null);
  assert.deepEqual([...s.host.secure.keys()], []);

  const chosen = await s.auth.chooseProject("project_sketches");
  assert.equal(chosen.ok, true);
  const c = s.auth.current();
  assert.equal(c.kind, "browser");
  assert.equal(c.project_name, "Sketches");
  assert.equal(c.team_name, "Personal");
  assert.equal(c.project_id, "project_sketches");
  assert.equal(c.email, s.idp.state.email);
  const sid = sessionId(s.idp.origin, s.idp.state.subject);
  assert.equal(c.key_hash, browserHash(s.idp.origin, s.idp.state.subject, "project_sketches"));
  assert.deepEqual(s.auth.status(), { signed_in: true, project_name: "Sketches" });

  // Secure storage: the session entry holds the refresh token; the index
  // holds names and ids, no token. Entry names reveal nothing.
  const names = [...s.host.secure.keys()].sort();
  assert.deepEqual(names, [INDEX_ENTRY, SESSION_ENTRY_PREFIX + sid].sort());
  const stored = JSON.parse(s.host.secure.get(SESSION_ENTRY_PREFIX + sid));
  assert.equal(stored.subject, s.idp.state.subject);
  assert.ok(s.idp.state.refresh.get(stored.refresh_token), "the saved refresh token is the live one");
  const index = s.host.secure.get(INDEX_ENTRY);
  for (const tok of [...s.idp.state.access, ...s.idp.state.refresh.keys()]) {
    assert.ok(!index.includes(tok), "the index holds no token");
    assert.ok(!s.logs.join("\n").includes(tok), "logs hold no token");
  }
  assert.ok(!s.logs.join("\n").includes("Sketches") && !s.logs.join("\n").includes(s.idp.state.email), "logs hold no project name or email");
});

test("requests of a browser sign-in: Bearer to the API only, projectId on each; the price check and the paid request keep their own rules", async (t) => {
  const s = await setup(t, { teams: [{ id: "team_solo", name: "Solo", projects: [{ id: "project_only", name: "Only" }] }] });
  await s.accounts.load();
  const out = await s.auth.signInWithBrowser({});
  assert.equal(out.ok, true);
  assert.ok(out.account && !out.choose, "a single usable project is chosen at once");
  assert.equal(out.account.project_name, "Only");
  s.api.setHandler((r) => (r.path === "/v1/generate/txt2img" ? { status: 200, body: { job: { jobId: "job_1" } } } : undefined));

  const before = s.api.requests.length;
  await s.client.request("GET", API.sign_in.auth_check.path, { query: API.sign_in.auth_check.query });
  await s.client.request("POST", "/generate/txt2img", { body: { prompt: "a kite" }, priceCheck: true, query: priceChecks.DRY_RUN_QUERY });
  await s.client.request("POST", "/generate/txt2img", { body: { prompt: "a kite" }, paid: paidMod.PAID_REQUEST });
  const sent = s.api.requests.slice(before);
  assert.deepEqual(sent.map((r) => r.query.projectId), ["project_only", "project_only", "project_only"]);
  for (const r of sent) assert.match(r.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  const [read, price, paid] = sent;
  assert.equal(read.query.pageSize, "1");
  assert.equal(price.search, `?${Object.keys(priceChecks.DRY_RUN_QUERY)[0]}=${encodeURIComponent(String(Object.values(priceChecks.DRY_RUN_QUERY)[0]))}&projectId=project_only`, "the price check keeps its flag");
  assert.equal(paid.search, "?projectId=project_only", "the paid request carries the project and nothing else");
  // The first requests used the sign-in's own access token: no refresh yet.
  assert.equal(s.idp.state.requests.filter((r) => r.form.grant_type === "refresh_token").length, 0);
  // The paid request still refuses a query from the caller.
  await assert.rejects(s.client.request("POST", "/generate/txt2img", { body: {}, paid: paidMod.PAID_REQUEST, query: { a: "1" } }), (e) => e.beforeSend === true && e.type === "Internal");
});

test("refresh: an access token about to expire is refreshed once for concurrent requests, rotated and saved", async (t) => {
  const clock = { now: Date.now() };
  const s = await setup(t, { clock, teams: [{ id: "team_solo", name: "Solo", projects: [{ id: "project_only", name: "Only" }] }] });
  await s.accounts.load();
  await s.auth.signInWithBrowser({});
  const sid = s.auth.current().session;
  const first = JSON.parse(s.host.secure.get(SESSION_ENTRY_PREFIX + sid)).refresh_token;
  clock.now += 3600 * 1000 - 30 * 1000; // 30 s left, under the 60 s margin
  await Promise.all([s.client.request("GET", "/models"), s.client.request("GET", "/models"), s.client.request("GET", "/models")]);
  const refreshes = s.idp.state.requests.filter((r) => r.form.grant_type === "refresh_token");
  assert.equal(refreshes.length, 1, "one refresh for three requests");
  assert.equal(refreshes[0].form.refresh_token, first);
  const second = JSON.parse(s.host.secure.get(SESSION_ENTRY_PREFIX + sid)).refresh_token;
  assert.notEqual(second, first, "the rotated refresh token is saved");
  assert.equal(s.idp.state.refresh.get(first), false);
  assert.equal(s.idp.state.refresh.get(second), true);
});

test("a new Photoshop start: the saved sign-in is used; its first request refreshes once", async (t) => {
  const s = await setup(t);
  await s.accounts.load();
  await s.auth.signInWithBrowser({});
  await s.auth.chooseProject("project_film");
  // Same secure storage, a new start: no access token was saved.
  const again = createAccounts(s.host, createRedactor(), {
    openSession: (stored, save, onEnd) => createSession({ oauth: s.oauth, refresh_token: stored.refresh_token, save, onEnd })
  });
  const sum = await again.load();
  assert.deepEqual(sum, { signed_in: true, project_name: "Film", count: 1 });
  const client = createClient({ fetch: globalThis.fetch, AbortController: globalThis.AbortController, timers: s.host.timers, credentials: again.credentials, baseUrl: s.api.url, sleep: async () => {} });
  const before = s.idp.state.requests.length;
  await client.request("GET", "/models");
  await client.request("GET", "/models");
  assert.equal(s.idp.state.requests.slice(before).filter((r) => r.form.grant_type === "refresh_token").length, 1);
  assert.equal(s.api.requests.at(-1).query.projectId, "project_film");
});

test("a read answered 401 gets one new token and one more try; a paid request is never tried twice", async (t) => {
  const s = await setup(t, { teams: [{ id: "team_solo", name: "Solo", projects: [{ id: "project_only", name: "Only" }] }] });
  await s.accounts.load();
  await s.auth.signInWithBrowser({});
  s.idp.dropAccessTokens(); // revoked elsewhere
  const res = await s.client.request("GET", "/models");
  assert.equal(res.status, 200);
  assert.equal(s.idp.state.requests.filter((r) => r.form.grant_type === "refresh_token").length, 1);
  s.idp.dropAccessTokens();
  const before = s.api.requests.length;
  await assert.rejects(s.client.request("POST", "/generate/txt2img", { body: {}, paid: paidMod.PAID_REQUEST }), (e) => e.type === "Unauthorized");
  assert.equal(s.api.requests.length - before, 1, "sent once");
});

test("a refused refresh ends the sign-in: its projects are forgotten and nothing is sent", async (t) => {
  const clock = { now: Date.now() };
  const pair = newKeyPair();
  const s = await setup(t, { clock, keyAccounts: [{ ...pair, projects: [projectRecord(pair.key, { id: "project_key", name: "Key project" })] }] });
  await s.accounts.load();
  assert.equal((await s.auth.saveAndTest(pair.key, pair.secret)).ok, true);
  await s.auth.signInWithBrowser({});
  await s.auth.chooseProject("project_film");
  assert.equal(s.auth.list().length, 2);
  for (const k of s.idp.state.refresh.keys()) s.idp.state.refresh.set(k, false); // revoked on Scenario's side
  clock.now += 2 * 3600 * 1000;
  const before = s.api.requests.length;
  await assert.rejects(s.client.request("GET", "/models"), (e) => e.type === "NotSignedIn" && e.beforeSend === true);
  assert.equal(s.api.requests.length, before, "no request without a token");
  assert.deepEqual(s.ended, [s.idp.state.subject]);
  assert.deepEqual(s.auth.list().map((a) => a.project_name), ["Key project"], "the key project stays and becomes current");
  assert.equal(s.auth.current().project_name, "Key project");
  assert.ok(![...s.host.secure.keys()].some((k) => k.startsWith(SESSION_ENTRY_PREFIX)), "the session entry is removed");
});

test("declined, expired and cancelled sign-ins save nothing; a sign-in failure says so", async (t) => {
  const denied = await setup(t, { oauth: { outcome: "deny" } });
  const d = await denied.auth.signInWithBrowser({});
  assert.equal(d.ok, false);
  assert.equal(d.state, "browser_denied");
  const expired = await setup(t, { oauth: { outcome: "expire" } });
  assert.equal((await expired.auth.signInWithBrowser({})).state, "browser_expired");

  const c = await setup(t, { oauth: { approveAfter: 1000 } });
  const running = c.auth.signInWithBrowser({
    onCode: () => setTimeout(() => c.auth.cancelBrowser(), 20)
  });
  const out = await running;
  assert.equal(out.state, "cancelled");
  for (const s of [denied, expired, c]) {
    assert.equal(s.auth.current(), null);
    assert.deepEqual([...s.host.secure.keys()], []);
  }

  const broken = await setup(t, { oauth: { handle: (r) => (r.path === "/oauth/device_authorization" ? { status: 400, body: { error: "unauthorized_client" } } : undefined) } });
  const b = await broken.auth.signInWithBrowser({});
  assert.equal(b.state, "browser_failed");
  assert.match(b.scenario_message, /unauthorized_client/);
});

test("an account with no usable project: 'no_project', and its token is revoked", async (t) => {
  const s = await setup(t, { teams: [{ id: "team_empty", name: "Empty team", projects: [] }] });
  const out = await s.auth.signInWithBrowser({});
  assert.equal(out.state, "no_project");
  assert.equal(s.idp.state.revoked.length, 1);
  assert.deepEqual([...s.host.secure.keys()], []);
});

test("leaving the chooser before choosing revokes the sign-in's token and saves nothing", async (t) => {
  const s = await setup(t);
  const out = await s.auth.signInWithBrowser({});
  assert.equal(out.choose, true);
  assert.equal(s.auth.waiting(), true);
  s.auth.cancelBrowser();
  assert.equal(s.auth.waiting(), false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.idp.state.revoked.length, 1);
  assert.deepEqual([...s.host.secure.keys()], []);
});

test("another project of the same sign-in, Test connection, a project that is gone, and sign out", async (t) => {
  const pair = newKeyPair();
  const s = await setup(t, { keyAccounts: [{ ...pair, projects: [projectRecord(pair.key, { id: "project_key", name: "Key project" })] }] });
  await s.accounts.load();
  await s.auth.saveAndTest(pair.key, pair.secret);
  await s.auth.signInWithBrowser({});
  await s.auth.chooseProject("project_film");

  // Choose another project: the same session, another row; the key stays.
  const listed = await s.auth.listChoices();
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.teams.map((x) => x.id), ["team_personal", "team_studio", "team_empty"]);
  const other = await s.auth.chooseProject("project_tests");
  assert.equal(other.ok, true);
  assert.deepEqual(s.auth.list().map((a) => `${a.kind || "key"}:${a.project_name}:${a.current}`), ["key:Key project:false", "browser:Film:false", "browser:Tests:true"]);
  assert.equal(s.idp.state.requests.filter((r) => r.path === "/oauth/device_authorization").length, 1, "no new sign-in");
  // The rows of one sign-in keep their projects apart.
  const ids = s.auth.list().filter((a) => a.kind === "browser").map((a) => a.id);
  assert.equal(new Set(ids).size, 2);

  // Test connection: the models of the chosen project, then the list.
  const ok = await s.auth.testConnection({});
  assert.equal(ok.ok, true);
  const last2 = s.api.requests.slice(-2);
  assert.deepEqual(last2.map((r) => `${r.path} ${r.query.projectId || "-"}`), ["/v1/models project_tests", "/v1/teams -"]);
  // A renamed project shows its new name.
  s.box.teams = teamsFixture().map((team) => ({ ...team, projects: team.projects.map((p) => (p.id === "project_tests" ? { ...p, name: "Tests 2" } : p)) }));
  await s.auth.testConnection({});
  assert.equal(s.auth.current().project_name, "Tests 2");
  // The project is deleted on Scenario (or the role removed): Phoenix answers 403.
  s.box.teams = teamsFixture().map((team) => ({ ...team, projects: team.projects.filter((p) => p.id !== "project_tests") }));
  const gone = await s.auth.testConnection({});
  assert.equal(gone.ok, false);
  assert.equal(gone.state, "project_gone");

  // Sign out of the browser sign-in: its token is revoked, its rows and
  // entry removed; the key project stays and becomes current.
  const rt = JSON.parse(s.host.secure.get(SESSION_ENTRY_PREFIX + s.auth.current().session)).refresh_token;
  await s.auth.signOut();
  assert.deepEqual(s.idp.state.revoked, [rt]);
  assert.deepEqual(s.auth.list().map((a) => a.project_name), ["Key project"]);
  assert.equal(s.auth.current().project_name, "Key project");
  assert.ok(![...s.host.secure.keys()].some((k) => k.startsWith(SESSION_ENTRY_PREFIX)));
  // The key's requests are Basic again, with no projectId.
  await s.client.request("GET", "/models");
  const last = s.api.requests.at(-1);
  assert.match(last.authorization, /^Basic /);
  assert.equal(last.query.projectId, undefined);
});

test("signing out of a browser project that is not the current one still ends its sign-in at Scenario", async (t) => {
  const pair = newKeyPair();
  const s = await setup(t, { keyAccounts: [{ ...pair, projects: [projectRecord(pair.key, { id: "project_key", name: "Key project" })] }] });
  await s.accounts.load();
  await s.auth.signInWithBrowser({});
  await s.auth.chooseProject("project_film");
  const film = s.auth.current();
  const rt = JSON.parse(s.host.secure.get(SESSION_ENTRY_PREFIX + film.session)).refresh_token;
  await s.auth.saveAndTest(pair.key, pair.secret);
  assert.equal(s.auth.current().project_name, "Key project");
  await s.auth.signOut(film.id);
  assert.deepEqual(s.idp.state.revoked, [rt]);
  assert.deepEqual(s.auth.list().map((a) => a.project_name), ["Key project"]);
  assert.equal(s.auth.current().project_name, "Key project", "the current key stays");
  assert.ok(![...s.host.secure.keys()].some((k) => k.startsWith(SESSION_ENTRY_PREFIX)));
});

test("a key saved for the only project of a browser sign-in ends that sign-in: its entry removed, its token revoked", async (t) => {
  const pair = newKeyPair();
  const s = await setup(t, {
    teams: [{ id: "team_solo", name: "Solo", projects: [{ id: "project_only", name: "Only" }] }],
    keyAccounts: [{ ...pair, projects: [projectRecord(pair.key, { id: "project_only", name: "Only" })] }]
  });
  await s.accounts.load();
  await s.auth.signInWithBrowser({});
  const rt = JSON.parse(s.host.secure.get(SESSION_ENTRY_PREFIX + s.auth.current().session)).refresh_token;
  const saved = await s.auth.saveAndTest(pair.key, pair.secret);
  assert.equal(saved.ok, true);
  assert.deepEqual(s.auth.list().map((a) => `${a.kind || "key"}:${a.project_name}`), ["key:Only"]);
  assert.ok(![...s.host.secure.keys()].some((k) => k.startsWith(SESSION_ENTRY_PREFIX)));
  assert.deepEqual(s.idp.state.revoked, [rt]);
});

test("a key saved for one of a browser sign-in's projects keeps the sign-in for its other projects", async (t) => {
  const pair = newKeyPair();
  const s = await setup(t, { keyAccounts: [{ ...pair, projects: [projectRecord(pair.key, { id: "project_film", name: "Film" })] }] });
  await s.accounts.load();
  await s.auth.signInWithBrowser({});
  await s.auth.chooseProject("project_film");
  await s.auth.listChoices();
  await s.auth.chooseProject("project_tests");
  const sid = s.auth.current().session;
  await s.auth.saveAndTest(pair.key, pair.secret);
  assert.deepEqual(s.auth.list().map((a) => `${a.kind || "key"}:${a.project_name}`).sort(), ["browser:Tests", "key:Film"]);
  assert.ok(s.host.secure.get(SESSION_ENTRY_PREFIX + sid));
  assert.deepEqual(s.idp.state.revoked, []);
});

test("a write answered 401 is not sent again, and the next request already has a new token", async (t) => {
  const s = await setup(t, { teams: [{ id: "team_solo", name: "Solo", projects: [{ id: "project_only", name: "Only" }] }] });
  await s.accounts.load();
  await s.auth.signInWithBrowser({});
  s.idp.dropAccessTokens(); // revoked elsewhere
  const refreshes = () => s.idp.state.requests.filter((r) => r.form.grant_type === "refresh_token").length;
  const before = s.api.requests.length;
  await assert.rejects(s.client.request("POST", "/generate/txt2img", { body: {}, paid: paidMod.PAID_REQUEST }), (e) => e.type === "Unauthorized");
  assert.equal(s.api.requests.length - before, 1, "sent once");
  const r0 = refreshes();
  const next = s.api.requests.length;
  assert.equal((await s.client.request("GET", "/models")).status, 200);
  assert.equal(s.api.requests.length - next, 1, "no request with the refused token");
  assert.equal(refreshes() - r0, 1);
});

test("a stored sign-in damaged or for another person is dropped at load", async (t) => {
  const s = await setup(t, { teams: [{ id: "team_solo", name: "Solo", projects: [{ id: "project_only", name: "Only" }] }] });
  await s.auth.signInWithBrowser({});
  const sid = s.auth.current().session;
  const entry = JSON.parse(s.host.secure.get(SESSION_ENTRY_PREFIX + sid));
  s.host.secure.set(SESSION_ENTRY_PREFIX + sid, JSON.stringify({ ...entry, subject: "user_other" }));
  const again = createAccounts(s.host, createRedactor(), { openSession: () => null });
  const sum = await again.load();
  assert.deepEqual(sum, { signed_in: false, project_name: null, count: 0 });
});

test("a browser sign-in's failures are worded for a sign-in, never a key; a team renamed on Scenario shows its new name", async (t) => {
  const s = await setup(t);
  // The team list refused at sign-in (the application not allowed on the API, say).
  s.api.setHandler((r) => (r.path === "/v1/teams" ? { status: 403, body: { reason: "OAuth client not allowed" } } : undefined));
  const refused = await s.auth.signInWithBrowser({});
  assert.equal(refused.state, "browser_failed");
  assert.equal(refused.scenario_message, "OAuth client not allowed");
  assert.equal(s.idp.state.revoked.length, 1, "the unused sign-in is revoked");
  s.api.setHandler(null);

  await s.auth.signInWithBrowser({});
  await s.auth.chooseProject("project_film");
  s.api.setHandler((r) => (r.path === "/v1/models" ? { status: 500, body: { message: "boom" } } : undefined));
  const broken = await s.auth.testConnection({});
  assert.equal(broken.state, "browser_check_failed");
  s.api.setHandler((r) => (r.path === "/v1/models" ? { destroy: true } : undefined));
  assert.equal((await s.auth.testConnection({})).state, "offline");
  s.api.setHandler(null);
  s.box.teams = teamsFixture().map((team) => (team.id === "team_studio" ? { ...team, name: "Studio 2" } : team));
  assert.equal((await s.auth.testConnection({})).ok, true);
  assert.equal(s.auth.current().team_name, "Studio 2");
  assert.equal(s.auth.current().project_id, "project_film", "the project id never changes");
});

test("a new sign-in while one waits for its project revokes the waiting one's token", async (t) => {
  const s = await setup(t);
  assert.equal((await s.auth.signInWithBrowser({})).choose, true);
  const waitingToken = [...s.idp.state.refresh.keys()][0];
  assert.equal((await s.auth.signInWithBrowser({})).choose, true);
  assert.ok(s.idp.state.revoked.includes(waitingToken));
  assert.equal((await s.auth.chooseProject("project_poster")).ok, true);
  assert.equal(s.auth.list().length, 1);
});
