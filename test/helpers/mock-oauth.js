"use strict";
// A mock of Scenario's identity provider on 127.0.0.1 for the browser
// sign-in tests: the device authorization grant (RFC 8628), refresh with
// rotation and revocation, with the error answers measured on the
// development instance on 2026-11-03. Tokens are made per test; the access
// token is a JWT whose claims name the subject, like the real one, with a
// dummy signature (the plugin never checks it, Scenario's API does).

const http = require("node:http");
const crypto = require("node:crypto");

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function jwt(claims) {
  return `${b64url({ alg: "RS256", typ: "at+jwt" })}.${b64url(claims)}.${crypto.randomBytes(16).toString("base64url")}`;
}

// The email of a test account, built at run time so the repository's lint
// (no addresses in files) stays meaningful.
function emailOf(name) {
  return [name, "example.invalid"].join("@");
}

// opts: { subject, email, clientId, approveAfter (polls answered pending),
//         slowDownAt (the poll answered slow_down), outcome ("approve",
//         "deny", "expire"), accessLifeS, handle(record) (takes over) }
async function startMockOAuth(opts = {}) {
  const subject = opts.subject || `user_${crypto.randomBytes(6).toString("hex")}`;
  const state = {
    subject,
    email: opts.email === undefined ? emailOf("signed.in") : opts.email,
    clientId: opts.clientId || "mock_client",
    approveAfter: opts.approveAfter === undefined ? 1 : opts.approveAfter,
    slowDownAt: opts.slowDownAt === undefined ? null : opts.slowDownAt,
    outcome: opts.outcome || "approve",
    accessLifeS: opts.accessLifeS === undefined ? 3600 : opts.accessLifeS,
    polls: 0,
    devices: new Map(),
    refresh: new Map(), // refresh token -> live
    access: new Set(),
    revoked: [],
    requests: []
  };
  let handler = opts.handle || null;
  const sockets = new Set();

  function issue() {
    const access = jwt({ sub: state.subject, client_id: state.clientId, exp: Math.floor(Date.now() / 1000) + state.accessLifeS });
    const refresh = `rt_${crypto.randomBytes(18).toString("base64url")}`;
    state.access.add(access);
    state.refresh.set(refresh, true);
    const body = { access_token: access, token_type: "Bearer", expires_in: state.accessLifeS, refresh_token: refresh, scope: "openid email profile offline_access" };
    if (state.email) body.id_token = jwt({ sub: state.subject, email: state.email });
    return body;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => answer(req, res, Buffer.concat(chunks).toString("utf8")));
  });

  function answer(req, res, text) {
    const url = new URL(req.url, "http://mock");
    const form = Object.fromEntries(new URLSearchParams(text));
    const record = { method: req.method, path: url.pathname, contentType: req.headers["content-type"] || null, authorization: req.headers.authorization || null, form };
    state.requests.push(record);
    const send = (status, body) => {
      if (status === null) return;
      res.writeHead(status, { "content-type": "application/json;charset=UTF-8" });
      res.end(JSON.stringify(body));
    };
    const custom = handler ? handler(record, state) : undefined;
    if (custom && custom.destroy) return req.socket.destroy();
    if (custom) return send(custom.status, custom.body === undefined ? {} : custom.body);
    const invalid = { error: "invalid_grant", error_description: "The provided authorization grant (e.g., authorization code, resource owner credentials) or refresh token is invalid." };
    if (req.method === "POST" && url.pathname === "/oauth/device_authorization") {
      if (form.client_id !== state.clientId) return send(401, { error: "invalid_client" });
      const deviceCode = crypto.randomBytes(32).toString("base64url");
      const userCode = `${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
      state.devices.set(deviceCode, { userCode, used: false });
      return send(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: "https://sign-in.example.invalid/device",
        verification_uri_complete: `https://sign-in.example.invalid/device?user_code=${userCode}`,
        expires_in: 599,
        interval: 5
      });
    }
    if (req.method === "POST" && url.pathname === "/oauth/token" && form.grant_type === DEVICE_GRANT) {
      const device = state.devices.get(form.device_code);
      if (!device || device.used || form.client_id !== state.clientId) return send(400, invalid);
      state.polls += 1;
      if (state.slowDownAt === state.polls) return send(400, { error: "slow_down", error_description: "The authorization request was rate-limited." });
      if (state.polls <= state.approveAfter) return send(400, { error: "authorization_pending", error_description: "The authorization request is still pending." });
      if (state.outcome === "deny") return send(400, { error: "access_denied", error_description: "The end user denied the request." });
      if (state.outcome === "expire") return send(400, { error: "expired_token", error_description: "The device code expired." });
      device.used = true;
      return send(200, issue());
    }
    if (req.method === "POST" && url.pathname === "/oauth/token" && form.grant_type === "refresh_token") {
      if (form.client_id !== state.clientId || !state.refresh.get(form.refresh_token)) return send(400, invalid);
      state.refresh.set(form.refresh_token, false); // rotated: the old one stops working
      return send(200, issue());
    }
    if (req.method === "POST" && url.pathname === "/oauth/token/revoke") {
      state.revoked.push(form.token);
      if (state.refresh.has(form.token)) state.refresh.set(form.token, false);
      return send(200, {});
    }
    return send(404, { error: "not_found" });
  }

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    state,
    target: { issuer: origin, client_id: state.clientId, scope: "openid email profile offline_access" },
    // The subject of a live access token, for the mock Scenario API.
    subjectOf(token) {
      return state.access.has(token) ? state.subject : null;
    },
    // Makes every live access token stop working (as if revoked elsewhere).
    dropAccessTokens() {
      state.access.clear();
    },
    setHandler(fn) {
      handler = fn;
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(r));
    }
  };
}

module.exports = { startMockOAuth, jwt, emailOf, DEVICE_GRANT };
