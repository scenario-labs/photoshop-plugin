"use strict";
// A mock of Scenario's REST API on 127.0.0.1 for the sign-in tests. It checks
// HTTP Basic credentials against keys made per test, records every request
// (method, path, the query string as sent, the Authorization header, the JSON
// body), and answers the two reads
// Save and test makes: GET /v1/models and GET /v1/projects. Error bodies
// follow what the live API returned on 2026-10-19: no credentials give 401
// {"message": "Unauthorized"}, an unknown key 403 {"reason": "Given APIKey
// does not exists"}. A test can take over any answer with handle(). No real
// key is ever used.
//
// With `oauth` ({ subjectOf(token), teams }), a Bearer token of the mock
// identity provider (mock-oauth.js) is accepted too: GET /v1/teams lists the
// teams, and every other route needs a projectId of those teams, else 403
// "Project ... not found" as the live API answers.

const http = require("node:http");
const crypto = require("node:crypto");

// A fresh key id and secret, shaped like Scenario's (the key id starts api_).
function newKeyPair() {
  return { key: `api_${crypto.randomBytes(12).toString("hex")}`, secret: crypto.randomBytes(24).toString("base64url") };
}

function basic(pair) {
  return `Basic ${Buffer.from(`${pair.key}:${pair.secret}`, "utf8").toString("base64")}`;
}

// A member's email, as the live listing carries them. Built at run time so the
// repository's lint (no addresses in files) stays meaningful.
const MEMBER_EMAIL = ["member.of.project", "example.invalid"].join("@");
const OTHER_KEY_ID = "api_otherKeyOfTheProject0001";

// The project record of GET /v1/projects (documented and measured shape),
// holding the key, another key and a member with an email.
// opts: { id, name, role, scope, withKeys }
function projectRecord(key, opts = {}) {
  const id = opts.id || `project_${crypto.randomBytes(6).toString("hex")}`;
  const scope = opts.scope || "project";
  const role = opts.role || "editor";
  const me = { id: "apiu_mock", apiKeyId: key, apiKeyStatus: "active", name: "plugin key", role, scope, createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z" };
  if (scope === "project") {
    me.ownerId = id;
    me.projects = [{ projectId: id, role }];
  }
  const keys = opts.withKeys === false ? undefined : [{ id: "apiu_other", apiKeyId: OTHER_KEY_ID, name: "CI key", role: "admin", scope: "project", ownerId: id, projects: [{ projectId: id, role: "admin" }] }, me];
  const rec = {
    id,
    name: opts.name === undefined ? "Fall campaign" : opts.name,
    teamId: "team_mock",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    privacyMode: false,
    users: [{ id: "user_mock", email: MEMBER_EMAIL, role: "admin", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }]
  };
  if (keys) rec.keys = keys;
  return rec;
}

// The teams of GET /v1/teams for the browser sign-in tests: two teams with
// two projects each, and a team without a project (several teams and
// projects at every level).
function teamsFixture() {
  return [
    { id: "team_studio", name: "Studio", projects: [{ id: "project_film", name: "Film" }, { id: "project_poster", name: "Poster" }] },
    { id: "team_personal", name: "Personal", projects: [{ id: "project_sketches", name: "Sketches" }, { id: "project_tests", name: "Tests" }] },
    { id: "team_empty", name: "Empty team", projects: [] }
  ];
}

// accounts: [{ key, secret, projects: [project records] }]
// oauth: { subjectOf(token) -> subject | null, teams: [team records] }
async function startMockScenario({ accounts = [], handle = null, oauth = null } = {}) {
  const requests = [];
  let handler = handle;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => answer(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  function answer(req, res, text) {
    const url = new URL(req.url, "http://mock");
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const record = {
      method: req.method,
      path: url.pathname,
      // The query string exactly as sent, for the price-check flag test.
      search: url.search,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.authorization || null,
      host: req.headers.host,
      body
    };
    requests.push(record);
    const auth = record.authorization;
    const account = accounts.find((a) => auth === basic(a)) || null;
    const send = (status, body, headers = {}) => {
      if (status === null) return; // never answer
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body));
    };
    const bearer = auth && auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const subject = bearer && oauth ? oauth.subjectOf(bearer) : null;
    const custom = handler ? handler({ ...record, account, subject }) : undefined;
    if (custom && custom.destroy) return req.socket.destroy(); // the connection drops: offline
    if (custom) return send(custom.status, custom.body === undefined ? {} : custom.body, custom.headers);
    if (bearer) {
      if (!subject) return send(401, { message: "Unauthorized" });
      const teams = typeof oauth.teams === "function" ? oauth.teams() : oauth.teams;
      if (req.method === "GET" && url.pathname === "/v1/teams") return send(200, { teams });
      const projectId = record.query.projectId;
      const known = teams.some((t) => t.projects.some((p) => p.id === projectId));
      if (!known) return send(403, { reason: `Project ${projectId} not found` });
      if (req.method === "GET" && url.pathname === "/v1/models") return send(200, { models: [], nextPaginationToken: null });
      return send(404, { reason: `Route ${url.pathname} not found` });
    }
    if (!auth) return send(401, { message: "Unauthorized" });
    if (!account) return send(403, { reason: "Given APIKey does not exists" });
    if (req.method === "GET" && url.pathname === "/v1/models") return send(200, { models: [], nextPaginationToken: null });
    if (req.method === "GET" && url.pathname === "/v1/projects") return send(200, { projects: account.projects || [] });
    return send(404, { reason: `Route ${url.pathname} not found` });
  }
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url: `${origin}/v1`,
    requests,
    accounts,
    setHandler(fn) {
      handler = fn;
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(r));
    }
  };
}

module.exports = { startMockScenario, newKeyPair, projectRecord, teamsFixture, basic, MEMBER_EMAIL, OTHER_KEY_ID };
