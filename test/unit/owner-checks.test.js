"use strict";
// The port owner's checks, driven by raw WebSocket clients that play the
// plugin, a peer, a browser page or an intruder. Real sockets on loopback.

const test = require("node:test");
const assert = require("node:assert/strict");
const WS = require("ws");
const { Owner } = require("../../helper/src/link/owner.js");
const hp = require("../../helper/src/link/crypto.js");
const { freePort, newToken, waitFor, UXP_ORIGIN, UXP_AGENT } = require("../helpers/fakes.js");

const CLOSE = hp.P.close_codes;
const schema = require("../../shared/schema-check.js");
const SESSION_ID = /^[A-Za-z0-9_-]{22}$/;

// Reads sealed messages until one of type `t` arrives.
async function nextOfType(h, t) {
  for (;;) {
    const msg = h.channel.open(Buffer.from(await h.ws.next()));
    if (msg.t === t) return msg;
  }
}

async function startOwner(limits = {}, token = newToken()) {
  const port = await freePort();
  const logs = [];
  const owner = new Owner({ port, token: hp.parseToken(token), version: "0.1.0", limits, log: (m) => logs.push(m) });
  const r = await owner.bind();
  assert.equal(r.ok, true);
  return { owner, port, token, logs };
}

// A raw client. as: "plugin" (UXP headers), "peer" (no Origin), or custom headers.
function connect(port, { as = "plugin", origin, agent, host, path = "/" } = {}) {
  const headers = {};
  const options = { perMessageDeflate: false, headers };
  if (as === "plugin") {
    options.origin = origin === undefined ? UXP_ORIGIN : origin;
    headers["User-Agent"] = agent === undefined ? UXP_AGENT : agent;
  } else if (origin !== undefined) {
    options.origin = origin;
  }
  if (as !== "plugin" && agent !== undefined) headers["User-Agent"] = agent;
  if (host !== undefined) headers.Host = host;
  const ws = new WS(`ws://127.0.0.1:${port}${path}`, options);
  const inbox = [];
  const waiters = [];
  ws.on("message", (data) => {
    const text = data.toString("utf8");
    const w = waiters.shift();
    if (w) w(text);
    else inbox.push(text);
  });
  ws.closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.refused = new Promise((resolve) => {
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.on("error", () => {});
  });
  ws.opened = new Promise((resolve) => ws.on("open", resolve));
  ws.next = (timeout = 2000) =>
    new Promise((resolve, reject) => {
      if (inbox.length) return resolve(inbox.shift());
      const t = setTimeout(() => reject(new Error("no message")), timeout);
      waiters.push((text) => {
        clearTimeout(t);
        resolve(text);
      });
    });
  return ws;
}

// Full handshake as `role`. Returns { ws, channel, challenge, proofMsg, hello }.
async function handshake(port, token, role = "plugin", opts = {}) {
  const ws = connect(port, { as: role === "plugin" ? "plugin" : "peer", ...opts });
  const challenge = JSON.parse(await ws.next());
  assert.equal(challenge.t, "challenge");
  assert.equal(challenge.role, "owner");
  const t = hp.parseToken(token);
  const nc = hp.nonce();
  const proofMsg = { t: "proof", role, nonce_c: nc, proof: hp.connectProof(t, role, challenge.nonce_o, nc) };
  ws.send(JSON.stringify(proofMsg));
  const op = JSON.parse(await ws.next());
  assert.equal(op.t, "owner_proof");
  assert.equal(hp.proofMatches(hp.ownerProof(t, challenge.nonce_o, nc), op.proof_o), true, "the owner proves the token back");
  const channel = new hp.Channel(hp.sessionKey(t, challenge.nonce_o, nc), "c2o", "o2c");
  const hello = channel.open(Buffer.from(await ws.next()));
  return { ws, channel, challenge, proofMsg, hello };
}

async function linkPlugin(port, token) {
  const h = await handshake(port, token, "plugin");
  h.ws.send(h.channel.seal({ t: "welcome", plugin_version: "0.1.0", photoshop_version: "27.11.0", os: "test", catalog_hash: "x", switches: {} }));
  return h;
}

test("a plugin with the right token links: owner speaks first, proofs go both ways, then hello and welcome", async (t) => {
  const { owner, port, token, logs } = await startOwner();
  t.after(() => owner.close());
  const h = await linkPlugin(port, token);
  assert.equal(h.hello.t, "hello");
  assert.equal(h.hello.helper_version, "0.1.0");
  assert.deepEqual(schema.validate(hp.P.messages.hello, h.hello, hp.P), []);
  assert.equal(h.hello.clients.length, 1, "the owner's own client is listed");
  assert.equal(h.hello.clients[0].session, owner.own.session);
  await waitFor(() => owner.pluginInfo(), { label: "welcome" });
  assert.equal(owner.pluginInfo().photoshop_version, "27.11.0");
  // A call reaches the plugin under the caller's session, with no client name, and the answer comes back.
  const call = owner.callOwn("scenario_status", {});
  const msg = h.channel.open(Buffer.from(await h.ws.next()));
  assert.equal(msg.t, "call");
  assert.equal(msg.session, owner.own.session);
  assert.equal("client_name" in msg, false, "names travel only in the clients list");
  assert.deepEqual(schema.validate(hp.P.messages.call, msg, hp.P), []);
  h.ws.send(h.channel.seal({ t: "result", id: msg.id, ok: true, result: { fine: true } }));
  assert.deepEqual(await call, { fine: true });
  assert.ok(
    logs.some((l) => l === `plugin connection: Host 127.0.0.1:${port}, Origin file://, User-Agent WebSocket++/0.8.2`),
    "the Host, Origin and User-Agent of plugin connections are logged (M1)"
  );
  assert.ok(!logs.join("\n").includes(token), "the token is never logged");
  h.ws.close();
});

test("refused before any protocol byte: wrong Host, Origin, User-Agent or path", async (t) => {
  const { owner, port } = await startOwner();
  t.after(() => owner.close());
  const cases = [
    [{ as: "plugin", origin: "null" }, 403, "Origin null (browser file page or sandbox)"],
    [{ as: "plugin", origin: "http://localhost:3000" }, 403, "web page origin"],
    [{ as: "plugin", origin: "https://example.com" }, 403, "remote web page"],
    [{ as: "plugin", agent: "Mozilla/5.0" }, 403, "file:// origin with a browser User-Agent"],
    [{ as: "plugin", agent: "" }, 403, "file:// origin without a User-Agent"],
    [{ as: "peer", host: "attacker.example:" + port }, 403, "DNS rebinding Host"],
    [{ as: "peer", host: "localhost:1" }, 403, "Host with another port"],
    [{ as: "peer", path: "/plugin" }, 404, "another path"]
  ];
  for (const [opts, status, label] of cases) {
    const ws = connect(port, opts);
    assert.equal(await ws.refused, status, label);
  }
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
    const ws = connect(port, { as: "peer", host });
    const first = JSON.parse(await ws.next());
    assert.equal(first.t, "challenge", `Host ${host} is accepted`);
    ws.close();
  }
});

test("wrong token: the owner says pairing_failed, closes with 4001, and its client hears PairingFailed", async (t) => {
  const { owner, port } = await startOwner();
  t.after(() => owner.close());
  let failures = 0;
  owner.on("plugin_pairing_failed", () => (failures += 1));
  const ws = connect(port, { as: "plugin" });
  const ch = JSON.parse(await ws.next());
  const other = hp.parseToken(newToken());
  const nc = hp.nonce();
  ws.send(JSON.stringify({ t: "proof", role: "plugin", nonce_c: nc, proof: hp.connectProof(other, "plugin", ch.nonce_o, nc) }));
  assert.deepEqual(JSON.parse(await ws.next()), { t: "pairing_failed" });
  assert.equal((await ws.closed).code, CLOSE.pairing_failed);
  assert.equal(failures, 1);
  await assert.rejects(
    owner.callOwn("scenario_status", {}),
    (e) => e.type === "PairingFailed" && /token differs from the plugin's: run the setup command again/.test(e.message)
  );
});

test("the declared role must match the headers", async (t) => {
  const { owner, port, token } = await startOwner();
  t.after(() => owner.close());
  const tk = hp.parseToken(token);
  for (const [as, role] of [
    ["plugin", "peer"],
    ["peer", "plugin"]
  ]) {
    const ws = connect(port, { as });
    const ch = JSON.parse(await ws.next());
    const nc = hp.nonce();
    ws.send(JSON.stringify({ t: "proof", role, nonce_c: nc, proof: hp.connectProof(tk, role, ch.nonce_o, nc) }));
    assert.equal(JSON.parse(await ws.next()).t, "pairing_failed");
    assert.equal((await ws.closed).code, CLOSE.pairing_failed, `${as} connection declaring ${role}`);
  }
  assert.equal(owner.pluginInfo(), null);
});

test("a proof recorded on one connection is useless on the next (fresh nonce)", async (t) => {
  const { owner, port, token } = await startOwner();
  t.after(() => owner.close());
  const first = await handshake(port, token, "peer");
  first.ws.close();
  const ws = connect(port, { as: "peer" });
  await ws.next();
  ws.send(JSON.stringify(first.proofMsg));
  assert.equal((await ws.closed).code, CLOSE.pairing_failed);
});

test("handshake limits: silence, oversized, malformed, binary and unknown fields", async (t) => {
  const { owner, port, token } = await startOwner({ handshake_ms: 300 });
  t.after(() => owner.close());
  const silent = connect(port, { as: "peer" });
  await silent.next();
  assert.equal((await silent.closed).code, CLOSE.handshake_timeout);

  const big = connect(port, { as: "peer" });
  await big.next();
  big.send("x".repeat(5000));
  assert.equal((await big.closed).code, CLOSE.bad_message);

  const malformed = connect(port, { as: "peer" });
  await malformed.next();
  malformed.send(JSON.stringify({ t: "proof", role: "peer", nonce_c: "abc", proof: "def" }));
  assert.equal((await malformed.closed).code, CLOSE.bad_message);

  const binary = connect(port, { as: "peer" });
  await binary.next();
  binary.send(Buffer.from([1, 2, 3]));
  assert.equal((await binary.closed).code, CLOSE.bad_message);

  // A right proof wrapped in a message with fields the protocol does not define.
  const extra = connect(port, { as: "peer" });
  const ch = JSON.parse(await extra.next());
  const nc = hp.nonce();
  extra.send(JSON.stringify({ t: "proof", protocol: 2, role: "peer", nonce_c: nc, proof: hp.connectProof(hp.parseToken(token), "peer", ch.nonce_o, nc) }));
  assert.equal((await extra.closed).code, CLOSE.bad_message);
});

test("after the proofs: a bad MAC, a replayed counter or a message over 10 MiB closes the link", async (t) => {
  const { owner, port, token } = await startOwner();
  t.after(() => owner.close());

  const a = await linkPlugin(port, token);
  await waitFor(() => owner.pluginInfo(), { label: "welcome" });
  const sealed = a.channel.seal({ t: "ping" });
  a.ws.send(sealed.slice(0, sealed.lastIndexOf("{")) + JSON.stringify({ t: "result", id: 1, ok: true, result: "forged" }));
  assert.equal((await a.ws.closed).code, CLOSE.bad_message);
  await waitFor(() => owner.pluginInfo() === null, { label: "plugin dropped" });

  const b = await linkPlugin(port, token);
  await waitFor(() => owner.pluginInfo(), { label: "welcome" });
  const ping = b.channel.seal({ t: "ping" });
  b.ws.send(ping);
  b.ws.send(ping);
  const closedB = await b.ws.closed;
  assert.equal(closedB.code, CLOSE.bad_message);

  const c = await linkPlugin(port, token);
  await waitFor(() => owner.pluginInfo(), { label: "welcome" });
  c.ws.send("x".repeat(10 * 1024 * 1024 + 1));
  assert.equal((await c.ws.closed).code, 1009, "ws closes with 1009 (message too big)");
});

test("peers: at most max_peers, idle ones are closed, and a peer cannot pose as the plugin", async (t) => {
  const { owner, port, token } = await startOwner({ max_peers: 2, idle_ms: 400 });
  t.after(() => owner.close());
  const p1 = await handshake(port, token, "peer");
  const p2 = await handshake(port, token, "peer");
  assert.equal("session" in p1.hello || "clients" in p1.hello, false, "a peer's hello carries no session and no client list");
  const sessions = owner.clients().map((c) => c.session);
  assert.equal(sessions.length, 3);
  assert.equal(new Set(sessions).size, 3, "every client has its own session");
  const ws3 = connect(port, { as: "peer" });
  const ch = JSON.parse(await ws3.next());
  const nc = hp.nonce();
  ws3.send(JSON.stringify({ t: "proof", role: "peer", nonce_c: nc, proof: hp.connectProof(hp.parseToken(token), "peer", ch.nonce_o, nc) }));
  assert.equal((await ws3.closed).code, CLOSE.too_many_peers);

  // A peer sending a plugin's welcome changes nothing.
  p1.ws.send(p1.channel.seal({ t: "welcome", plugin_version: "9", photoshop_version: "9", os: "x", catalog_hash: "x", switches: {} }));
  // Keep p1 alive with pings; p2 stays silent and must be closed as idle.
  const keep = setInterval(() => p1.ws.send(p1.channel.seal({ t: "ping" })), 100);
  t.after(() => clearInterval(keep));
  assert.equal((await p2.ws.closed).code, CLOSE.idle);
  assert.equal(owner.pluginInfo(), null, "a peer cannot become the plugin");
  assert.equal(owner.peers.size, 1);
  clearInterval(keep);
  p1.ws.close();
});

test("a peer's calls are relayed to the plugin under the session the owner gave it", async (t) => {
  const { owner, port, token } = await startOwner();
  t.after(() => owner.close());
  const plugin = await linkPlugin(port, token);
  await waitFor(() => owner.pluginInfo(), { label: "welcome" });
  const peer = await handshake(port, token, "peer");
  const peerSession = owner.clients()[1].session;
  peer.ws.send(peer.channel.seal({ t: "client_info", client_name: "Codex" }));
  peer.ws.send(peer.channel.seal({ t: "call", id: 7, tool: "scenario_status", args: {} }));
  const msg = await nextOfType(plugin, "call");
  assert.equal(msg.session, peerSession);
  assert.equal("client_name" in msg, false);
  plugin.ws.send(plugin.channel.seal({ t: "result", id: msg.id, ok: false, error: "VersionMismatch: test" }));
  const res = peer.channel.open(Buffer.from(await peer.ws.next()));
  assert.deepEqual(res, { t: "result", id: 7, ok: false, error: "VersionMismatch: test" });
  plugin.ws.close();
  peer.ws.close();
});

test("a second plugin link is refused with plugin_busy and the first one stays; pending handshakes are capped", async (t) => {
  const { owner, port, token, logs } = await startOwner({ max_pending_handshakes: 2 });
  t.after(() => owner.close());
  const first = await linkPlugin(port, token);
  await waitFor(() => owner.pluginInfo(), { label: "first" });
  // The second Photoshop proves the token, then is refused before owner_proof.
  const ws = connect(port, { as: "plugin" });
  const ch = JSON.parse(await ws.next());
  const nc = hp.nonce();
  ws.send(JSON.stringify({ t: "proof", role: "plugin", nonce_c: nc, proof: hp.connectProof(hp.parseToken(token), "plugin", ch.nonce_o, nc) }));
  const closed = await ws.closed;
  assert.equal(closed.code, CLOSE.plugin_busy);
  assert.equal(closed.reason, "plugin_busy");
  assert.ok(logs.some((l) => /plugin_busy/.test(l)));
  // The first link still works.
  assert.ok(owner.pluginInfo(), "the first plugin is still linked");
  const call = owner.callOwn("scenario_status", {});
  const msg = await nextOfType(first, "call");
  first.ws.send(first.channel.seal({ t: "result", id: msg.id, ok: true, result: { still: "first" } }));
  assert.deepEqual(await call, { still: "first" });
  first.ws.close();

  const a = connect(port, { as: "peer" });
  const b = connect(port, { as: "peer" });
  await a.next();
  await b.next();
  const c = connect(port, { as: "peer" });
  assert.equal(await c.refused, 503);
  a.close();
  b.close();
});

test("closing the owner frees the port and tells every link it is shutting down", async () => {
  const { owner, port, token } = await startOwner();
  const plugin = await linkPlugin(port, token);
  const peer = await handshake(port, token, "peer");
  await owner.close();
  assert.equal((await plugin.ws.closed).code, CLOSE.shutting_down);
  assert.equal((await peer.ws.closed).code, CLOSE.shutting_down);
  const again = new Owner({ port, token: hp.parseToken(token), version: "0.1.0" });
  assert.equal((await again.bind()).ok, true, "the port can be bound again at once");
  await again.close();
});

test("a new pairing token closes every link made with the old one; new handshakes need the new token", async (t) => {
  const { owner, port, token } = await startOwner();
  t.after(() => owner.close());
  const peer = await handshake(port, token, "peer");
  const fresh = newToken();
  assert.equal(owner.setToken(hp.parseToken(fresh)), true);
  assert.equal(owner.setToken(hp.parseToken(fresh)), false, "the same token changes nothing");
  assert.equal((await peer.ws.closed).code, CLOSE.pairing_failed);
  const stale = connect(port, { as: "peer" });
  const ch = JSON.parse(await stale.next());
  const nc = hp.nonce();
  stale.send(JSON.stringify({ t: "proof", role: "peer", nonce_c: nc, proof: hp.connectProof(hp.parseToken(token), "peer", ch.nonce_o, nc) }));
  assert.equal(JSON.parse(await stale.next()).t, "pairing_failed");
  const ok = await handshake(port, fresh, "peer");
  assert.equal(ok.hello.t, "hello");
  ok.ws.close();
});

test("client sessions: 16 random bytes, unique, connected_at in the list, new ids for every client each time a plugin link opens", async (t) => {
  const { owner, port, token } = await startOwner();
  t.after(() => owner.close());
  const peer = await handshake(port, token, "peer");
  owner.setOwnClientName("Claude Code");
  peer.ws.send(peer.channel.seal({ t: "client_info", client_name: "Codex" }));
  await waitFor(() => owner.clients()[1].client_name === "Codex", { label: "peer named" });

  const one = await linkPlugin(port, token);
  const listed = one.hello.clients;
  assert.deepEqual(listed.map((c) => c.client_name), ["Claude Code", "Codex"]);
  for (const c of listed) {
    assert.match(c.session, SESSION_ID);
    assert.equal(Buffer.from(c.session, "base64url").length, 16);
    assert.ok(!Number.isNaN(Date.parse(c.connected_at)) && new Date(c.connected_at).toISOString() === c.connected_at, "connected_at is an ISO 8601 time");
  }
  await waitFor(() => owner.pluginInfo(), { label: "first link" });
  one.ws.close();
  await waitFor(() => owner.pluginInfo() === null, { label: "first link closed" });

  const two = await linkPlugin(port, token);
  const relisted = two.hello.clients;
  assert.deepEqual(relisted.map((c) => c.client_name), ["Claude Code", "Codex"], "same clients, same names");
  assert.deepEqual(relisted.map((c) => c.connected_at), listed.map((c) => c.connected_at), "connection times are kept");
  for (let i = 0; i < relisted.length; i++) assert.notEqual(relisted[i].session, listed[i].session, "a new plugin link gets new session ids");
  const all = new Set([...listed, ...relisted].map((c) => c.session));
  assert.equal(all.size, 4, "an id is never reused");
  // The relayed calls use the new id.
  await waitFor(() => owner.pluginInfo(), { label: "second link" });
  peer.ws.send(peer.channel.seal({ t: "call", id: 1, tool: "scenario_status", args: {} }));
  const call = await nextOfType(two, "call");
  assert.equal(call.session, relisted[1].session);
  two.ws.close();
  peer.ws.close();
});

test("client names: set once at the first initialize, cut to 64 characters, never updated", async (t) => {
  const { owner, port, token } = await startOwner();
  t.after(() => owner.close());
  const plugin = await linkPlugin(port, token);
  await waitFor(() => owner.pluginInfo(), { label: "welcome" });
  assert.equal(owner.clients()[0].client_name, null, "no name before initialize");

  owner.setOwnClientName("N".repeat(70));
  const listed = await nextOfType(plugin, "clients");
  assert.deepEqual(schema.validate(hp.P.messages.clients, listed, hp.P), []);
  assert.equal(listed.clients[0].client_name, "N".repeat(64));
  owner.setOwnClientName("Renamed");
  assert.equal(owner.clients()[0].client_name, "N".repeat(64), "a second initialize changes nothing");

  const peer = await handshake(port, token, "peer");
  await nextOfType(plugin, "clients"); // the peer joined
  // 63 characters then an emoji (two UTF-16 units): the cut never splits it.
  peer.ws.send(peer.channel.seal({ t: "client_info", client_name: "c".repeat(63) + "\u{1F600}" }));
  const named = await nextOfType(plugin, "clients");
  assert.equal(named.clients[1].client_name, "c".repeat(63));
  peer.ws.send(peer.channel.seal({ t: "client_info", client_name: "Other" }));
  peer.ws.send(peer.channel.seal({ t: "ping" }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(owner.clients()[1].client_name, "c".repeat(63), "a peer cannot rename itself");

  // A peer that leaves leaves the list.
  peer.ws.close();
  const left = await nextOfType(plugin, "clients");
  assert.equal(left.clients.length, 1);
  plugin.ws.close();
});

test("a client that joins while the plugin is still answering hello is on the list before its first call", async (t) => {
  const { owner, port, token } = await startOwner();
  t.after(() => owner.close());
  const plugin = await handshake(port, token, "plugin"); // hello received, no welcome yet
  const peer = await handshake(port, token, "peer");
  const listed = await nextOfType(plugin, "clients");
  assert.equal(listed.clients.length, 2, "the list reaches the plugin before its welcome");
  plugin.ws.send(plugin.channel.seal({ t: "welcome", plugin_version: "0.1.0", photoshop_version: "27.11.0", os: "test", catalog_hash: "x", switches: {} }));
  await waitFor(() => owner.pluginInfo(), { label: "welcome" });
  peer.ws.send(peer.channel.seal({ t: "call", id: 3, tool: "scenario_status", args: {} }));
  const call = await nextOfType(plugin, "call");
  assert.equal(call.session, listed.clients[1].session);
  plugin.ws.close();
  peer.ws.close();
});
