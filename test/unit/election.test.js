"use strict";
// Port election: the first helper owns the port, later ones relay as peers,
// a new owner is elected when the owner exits, and a program without the token
// on the port blocks agents (PortInUse) without ever reaching the plugin.

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { LinkManager } = require("../../helper/src/link/manager.js");
const { startFakePlugin } = require("../helpers/plugin-sim.js");
const { freePort, newToken, waitFor, hasIpv6, sleep } = require("../helpers/fakes.js");

function manager(port, token, extra = {}) {
  const m = new LinkManager({ port, tokenText: token, version: "0.1.0", retryMs: 200, ...extra });
  return m;
}

async function stopAll(list) {
  for (const x of list) {
    if (x && typeof x.stop === "function") await x.stop();
  }
}

function tcpSquatter(port, host) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const s = net.createServer((sock) => {
      sockets.add(sock);
      sock.on("error", () => {});
      sock.on("close", () => sockets.delete(sock));
    });
    s.once("error", reject);
    s.listen({ port, host, exclusive: true, ipv6Only: host.includes(":") }, () =>
      resolve({
        close: () =>
          new Promise((r) => {
            for (const sock of sockets) sock.destroy();
            s.close(() => r());
          })
      })
    );
  });
}

test("first helper owns the port, the next ones relay as peers with their own sessions and names", async (t) => {
  const port = await freePort();
  const token = newToken();
  const a = manager(port, token);
  const b = manager(port, token);
  const c = manager(port, token);
  const plugin = startFakePlugin({ port, token });
  t.after(() => stopAll([plugin, c, b, a]));
  a.setClientName("Claude Code");
  await a.start();
  assert.equal(a.role(), "owner");
  if (await hasIpv6()) assert.deepEqual(a.owner.addresses.sort(), ["127.0.0.1", "::1"]);
  else assert.deepEqual(a.owner.addresses, ["127.0.0.1"]);
  await b.start();
  b.setClientName("Codex");
  await c.start();
  assert.equal(b.role(), "peer");
  assert.equal(c.role(), "peer");
  await waitFor(() => a.owner.pluginInfo(), { label: "plugin linked" });
  const [ra, rb, rc] = await Promise.all([a.call("scenario_status", {}), b.call("scenario_status", {}), c.call("scenario_status", {})]);
  for (const r of [ra, rb, rc]) assert.equal(r.photoshop_version, "27.11.0");
  await waitFor(() => plugin.link.state().clients.length === 3 && plugin.link.state().clients.some((x) => x.client_name === "Codex"), {
    label: "three sessions and their names reach the plugin"
  });
  const names = plugin.link.state().clients.map((x) => x.client_name);
  assert.deepEqual([...names].sort(), ["Claude Code", "Codex", null].sort(), "c has not initialized, so it has no name yet");
  const sessions = new Set(plugin.link.state().clients.map((x) => x.session));
  assert.equal(sessions.size, 3);
  // A name is set once: a later initialize changes nothing, on the owner or a peer.
  a.setClientName("Renamed A");
  b.setClientName("Renamed B");
  await sleep(150);
  assert.deepEqual([...plugin.link.state().clients.map((x) => x.client_name)].sort(), ["Claude Code", "Codex", null].sort());
});

test("owner exit: exactly one peer becomes the owner, the other relays through it, the plugin relinks", async (t) => {
  const port = await freePort();
  const token = newToken();
  const a = manager(port, token);
  const b = manager(port, token);
  const c = manager(port, token);
  const plugin = startFakePlugin({ port, token });
  t.after(() => stopAll([plugin, c, b, a]));
  await a.start();
  await b.start();
  await c.start();
  await waitFor(() => a.owner && a.owner.pluginInfo(), { label: "linked to a" });
  await a.stop();
  await waitFor(() => [b, c].filter((m) => m.role() === "owner").length === 1 && [b, c].every((m) => m.role() !== "none"), {
    label: "re-election",
    timeout: 8000
  });
  const newOwner = b.role() === "owner" ? b : c;
  const other = newOwner === b ? c : b;
  assert.equal(other.role(), "peer");
  await waitFor(() => newOwner.owner.pluginInfo(), { label: "plugin relinked", timeout: 5000 });
  const r = await other.call("scenario_status", {});
  assert.equal(r.plugin_version, "0.1.0");
});

test("helpers started at the same moment end with one owner and the rest as peers", async (t) => {
  const port = await freePort();
  const token = newToken();
  const list = Array.from({ length: 5 }, () => manager(port, token));
  t.after(() => stopAll(list));
  await Promise.all(list.map((m) => m.start()));
  await waitFor(() => list.every((m) => m.role() !== "none"), { label: "all placed", timeout: 8000 });
  assert.equal(list.filter((m) => m.role() === "owner").length, 1);
  assert.equal(list.filter((m) => m.role() === "peer").length, 4);
});

test("a program holding 127.0.0.1 on the port blocks agents with PortInUse and never sees the token", async (t) => {
  const port = await freePort();
  const sq = await tcpSquatter(port, "127.0.0.1");
  const m = manager(port, newToken(), { limits: { handshake_ms: 300 } });
  t.after(async () => {
    await m.stop();
    await sq.close();
  });
  await m.start();
  assert.equal(m.role(), "none");
  await assert.rejects(m.call("scenario_status", {}), (e) => e.type === "PortInUse" && /not the Scenario helper/.test(e.message));
});

test("a program holding only ::1 on the port: no owner can exist, so nothing relays", async (t) => {
  if (!(await hasIpv6())) return t.skip("no IPv6 loopback on this machine");
  const port = await freePort();
  const sq = await tcpSquatter(port, "::1");
  const m = manager(port, newToken());
  t.after(async () => {
    await m.stop();
    await sq.close();
  });
  await m.start();
  assert.equal(m.role(), "none");
  await assert.rejects(m.call("scenario_status", {}), (e) => e.type === "PortInUse");
  await assert.rejects(new Promise((resolve, reject) => {
    const s = net.connect({ port, host: "127.0.0.1" }, () => {
      s.destroy();
      resolve();
    });
    s.on("error", reject);
  }), /ECONNREFUSED/, "127.0.0.1 stays unbound: the helper released it");
});

test("a helper with another token cannot join (PairingFailed); the owner keeps serving its plugin", async (t) => {
  const port = await freePort();
  const token = newToken();
  const a = manager(port, token);
  const stranger = manager(port, newToken());
  const plugin = startFakePlugin({ port, token });
  t.after(() => stopAll([plugin, stranger, a]));
  await a.start();
  await stranger.start();
  assert.equal(stranger.role(), "none");
  await assert.rejects(stranger.call("scenario_status", {}), (e) => e.type === "PairingFailed" && /run the setup command again/.test(e.message));
  await waitFor(() => a.owner.pluginInfo(), { label: "owner still serves" });
  assert.equal((await a.call("scenario_status", {})).signed_in, false);
});

test("when the squatter leaves, the blocked helper takes the port", async (t) => {
  const port = await freePort();
  const token = newToken();
  const sq = await tcpSquatter(port, "127.0.0.1");
  const m = manager(port, token, { limits: { handshake_ms: 200 } });
  t.after(() => m.stop());
  await m.start();
  assert.equal(m.role(), "none");
  await sq.close();
  await waitFor(() => m.role() === "owner", { label: "takeover", timeout: 5000 });
});

test("without a valid token the helper never binds the port and says why", async (t) => {
  const port = await freePort();
  const missing = manager(port, undefined);
  const bad = manager(port, "not-a-token");
  t.after(() => stopAll([missing, bad]));
  await missing.start();
  await bad.start();
  assert.equal(missing.role(), "none");
  await assert.rejects(missing.call("scenario_status", {}), (e) => e.type === "PairingFailed" && /is not set/.test(e.message));
  await assert.rejects(bad.call("scenario_status", {}), (e) => e.type === "PairingFailed" && /not a valid pairing token/.test(e.message));
  const owner = manager(port, newToken());
  t.after(() => owner.stop());
  await owner.start();
  assert.equal(owner.role(), "owner", "the port stayed free");
  await sleep(10);
});

test("after a token reset, a rewritten token file reconnects the running helpers without a restart", async (t) => {
  const port = await freePort();
  const oldToken = newToken();
  const newTok = newToken();
  let fileText = oldToken;
  const fromFile = () => ({ text: fileText, source: "file", shown: "~/.config/scenario-photoshop/token" });
  const a = manager(port, undefined, { loadToken: fromFile });
  const b = manager(port, undefined, { loadToken: fromFile });
  const plugin = startFakePlugin({ port, token: oldToken });
  t.after(() => stopAll([plugin, b, a]));
  await a.start();
  await b.start();
  assert.equal(a.role(), "owner");
  assert.equal(b.role(), "peer");
  await waitFor(() => a.owner.pluginInfo(), { label: "linked with the old token" });

  // The person clicks Reset in the panel: the plugin now holds the new token.
  plugin.setToken(newTok);
  plugin.link.restart("Pairing token reset.");
  await waitFor(() => plugin.phase() === "pairing_failed", { label: "helpers hold the old token" });
  await assert.rejects(a.call("scenario_status", {}), (e) => e.type === "PairingFailed");

  // The person runs the setup command again: the token file holds the new token.
  fileText = newTok;
  await waitFor(() => a.owner && a.owner.pluginInfo(), { label: "owner relinked with the new token", timeout: 8000 });
  await waitFor(() => b.role() === "peer" && b.peer && b.peer.ready, { label: "peer rejoined with the new token", timeout: 8000 });
  assert.equal((await b.call("scenario_status", {})).plugin_version, "0.1.0");
});

test("no token yet: the helper waits, then starts as soon as the token file appears", async (t) => {
  const port = await freePort();
  let fileText;
  const m = manager(port, undefined, { loadToken: () => (fileText ? { text: fileText, source: "file" } : { source: "file", missing: true, shown: "~/.config/scenario-photoshop/token" }) });
  t.after(() => m.stop());
  await m.start();
  assert.equal(m.role(), "none");
  await assert.rejects(m.call("scenario_status", {}), (e) => e.type === "PairingFailed" && /~\/\.config\/scenario-photoshop\/token does not exist/.test(e.message));
  fileText = newToken();
  await waitFor(() => m.role() === "owner", { label: "owner once the file exists", timeout: 3000 });
});
