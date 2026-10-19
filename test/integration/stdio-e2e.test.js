"use strict";
// End to end under Node: real helper processes speaking MCP over stdio, the
// plugin's own link code as a fake plugin, real WebSockets on loopback. Each
// test uses its own port (SCENARIO_PHOTOSHOP_PORT, test-only) and its own HOME.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { spawnHelper, BIN } = require("../helpers/mcp-client.js");
const { startFakePlugin } = require("../helpers/plugin-sim.js");
const { freePort, newToken, waitFor } = require("../helpers/fakes.js");
const catalog = require("../../shared/catalog.json");
const schema = require("../../shared/schema-check.js");

const outputSchema = catalog.tools[0].outputSchema;

function helperEnv(port, token, extra = {}) {
  const env = { SCENARIO_PHOTOSHOP_PORT: String(port), ...extra };
  if (token) env.SCENARIO_PHOTOSHOP_TOKEN = token;
  return env;
}

async function statusUntil(h, pred, label, timeout = 8000) {
  let last;
  await waitFor(
    async () => {
      last = await h.status();
      return pred(last);
    },
    { label, timeout, interval: 100 }
  );
  return last;
}

test("one client, no Photoshop: initialize, tools/list, and a status that says why", async (t) => {
  const port = await freePort();
  const h = spawnHelper({ env: helperEnv(port, newToken()) });
  t.after(() => h.close());
  const init = await h.initialize("e2e-client");
  assert.equal(init.result.serverInfo.name, "scenario-photoshop");
  const list = await h.request("tools/list", {});
  assert.deepEqual(list.result.tools.map((x) => x.name), ["scenario_status"]);
  const s = await h.status();
  assert.equal(s.connected, false);
  assert.equal(s.helper_role, "owner");
  assert.match(s.reason, /^NotConnected: open Photoshop with the Scenario plugin installed/);
  assert.deepEqual(schema.validate(outputSchema, s), []);
});

test("one client and the plugin: scenario_status from the fake Photoshop, client name shown in the panel", async (t) => {
  const port = await freePort();
  const token = newToken();
  const h = spawnHelper({ env: helperEnv(port, token, { SCENARIO_NO_SPEND: "1" }) });
  const plugin = startFakePlugin({ port, token });
  t.after(async () => {
    plugin.stop();
    await h.close();
  });
  await h.initialize("e2e-client");
  const s = await statusUntil(h, (x) => x.connected, "connected");
  assert.equal(s.photoshop_version, "27.11.0");
  assert.equal(s.helper_version, "0.1.0");
  assert.equal(s.no_spend, true, "SCENARIO_NO_SPEND reaches the status");
  assert.equal(s.uncertain_jobs, 0);
  assert.deepEqual(s.open_documents, [
    { id: 101, title: "poster.psd" },
    { id: 102, title: "Untitled-1" }
  ]);
  assert.deepEqual(schema.validate(outputSchema, s), []);
  await waitFor(() => plugin.link.state().clients.some((c) => c.client_name === "e2e-client"), { label: "client name in the panel" });
});

test("two clients: the second helper relays as a peer; when the first exits, the second takes the port", async (t) => {
  const port = await freePort();
  const token = newToken();
  const a = spawnHelper({ env: helperEnv(port, token) });
  await a.initialize("client-a");
  await statusUntil(a, (x) => x.helper_role === "owner", "a owns the port");
  const b = spawnHelper({ env: helperEnv(port, token) });
  const plugin = startFakePlugin({ port, token });
  t.after(async () => {
    plugin.stop();
    await b.close();
    await a.close().catch(() => {});
  });
  await b.initialize("client-b");
  const viaPeer = await statusUntil(b, (x) => x.connected, "b connected through a");
  assert.equal(viaPeer.helper_role, "peer");
  await waitFor(() => plugin.link.state().clients.length === 2, { label: "both clients in the panel" });

  const exit = await a.close();
  assert.equal(exit.code, 0, "the helper exits cleanly when its client closes stdin");
  const after = await statusUntil(b, (x) => x.connected && x.helper_role === "owner", "b took the port and the plugin relinked", 10000);
  assert.equal(after.plugin_version, "0.1.0");
  assert.deepEqual(
    plugin.link.state().clients.map((c) => c.client_name),
    ["client-b"]
  );
});

test("a helper with another token: PairingFailed for its client, old-token message in the panel", async (t) => {
  const port = await freePort();
  const h = spawnHelper({ env: helperEnv(port, newToken()) });
  const plugin = startFakePlugin({ port, token: newToken() });
  t.after(async () => {
    plugin.stop();
    await h.close();
  });
  await h.initialize("stale-client");
  const s = await statusUntil(h, (x) => /^PairingFailed/.test(x.reason || ""), "PairingFailed");
  assert.equal(s.connected, false);
  assert.match(s.reason, /token differs from the plugin's: run the setup command again/);
  await waitFor(() => plugin.phase() === "pairing_failed", { label: "panel shows the old token" });
});

test("no token anywhere: the helper never binds the port and says how to pair", async (t) => {
  const port = await freePort();
  const h = spawnHelper({ env: helperEnv(port, null) });
  t.after(() => h.close());
  await h.initialize("unpaired");
  const s = await h.status();
  assert.equal(s.connected, false);
  assert.equal(s.helper_role, "none");
  assert.match(s.reason, /^PairingFailed: no pairing token: SCENARIO_PHOTOSHOP_TOKEN is not set and ~\/\.config\/scenario-photoshop\/token does not exist/);
});

test("setup writes the token file; a helper started without the variable pairs from it", async (t) => {
  if (process.platform === "win32") return t.skip("token file path differs on Windows; covered by unit tests");
  const port = await freePort();
  const token = newToken();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-ps-home-"));
  const setup = spawnSync(process.execPath, [BIN, "setup", "cursor"], {
    env: { PATH: process.env.PATH, HOME: home, SCENARIO_PHOTOSHOP_TOKEN: token },
    encoding: "utf8"
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.ok(!setup.stdout.includes(token) && !setup.stderr.includes(token), "setup never prints the token");
  const cursorConfig = fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8");
  assert.ok(!cursorConfig.includes(token), "the client config holds no token");

  const h = spawnHelper({ env: helperEnv(port, null), home });
  const plugin = startFakePlugin({ port, token });
  t.after(async () => {
    plugin.stop();
    await h.close();
  });
  await h.initialize("from-file");
  const s = await statusUntil(h, (x) => x.connected, "paired from the token file");
  assert.equal(s.helper_role, "owner");
});
