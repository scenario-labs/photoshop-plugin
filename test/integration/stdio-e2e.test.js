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
  assert.deepEqual(list.result.tools.map((x) => x.name), ["scenario_status", "document_summary", "layer_detail", "preview_document", "list_models", "model_schema", "recommend_models", "estimate_cost", "job_status", "wait_for_job", "list_local_jobs", "list_generations", "list_assets", "search_assets", "list_collections", "inspect_result_previews", "capture_reference", "upload_reference", "reference_upload_status", "generate", "recover_local_job", "recover_cloud_job", "cancel_prepared_job", "prepare_result_application", "apply_result_application", "select_layers", "set_selection", "remove_scenario_layers", "execute_batchplay"]);
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
  assert.equal(s.helper_version, require("../../helper/package.json").version);
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
  assert.equal(after.plugin_version, require("../../plugin/manifest.json").version);
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

test("the catalog tools through a real helper: list_models, model_schema and estimate_cost answer from the plugin, valid against the catalog", async (t) => {
  const main = require("../../plugin/src/main.js");
  const { createFakeDocument } = require("../helpers/fake-dom.js");
  const { startFixtureScenario } = require("../helpers/fixture-scenario.js");
  const { newKeyPair, projectRecord } = require("../helpers/mock-scenario.js");
  const { fakeHost, uxpWebSocket } = require("../helpers/fakes.js");
  const pair = newKeyPair();
  const mock = await startFixtureScenario({ accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "E2E project" })] }] });
  const port = await freePort();
  const token = newToken();
  const host = fakeHost({ WebSocket: uxpWebSocket({ rewrite: (u) => u.replace(":9890", `:${port}`) }), secure: [["scenario.pairing_token", token]] });
  const doc = createFakeDocument();
  const app = await main.boot({ host, document: doc, console: null, apiBaseUrl: mock.url });
  const h = spawnHelper({ env: helperEnv(port, token, { SCENARIO_NO_SPEND: "1" }) });
  t.after(async () => {
    app.link.stop();
    await h.close();
    await mock.close();
  });
  doc.paste("signin-key", `${pair.key}:${pair.secret}`);
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });
  await h.initialize("e2e-client");
  await statusUntil(h, (x) => x.connected && x.signed_in, "connected and signed in");
  const tools = Object.fromEntries(catalog.tools.map((x) => [x.name, x]));
  async function call(name, args) {
    const r = await h.request("tools/call", { name, arguments: args });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.notEqual(r.result.isError, true, JSON.stringify(r.result));
    const out = r.result.structuredContent;
    assert.deepEqual(schema.validate(tools[name].outputSchema, out), [], `${name} output matches its schema`);
    return out;
  }
  const listed = await call("list_models", { lane: "upscale", limit: 3 });
  assert.equal(listed.models.length, 3);
  assert.equal(listed.models[0].model_id, "model_topaz-image-upscale");
  assert.match(listed.next_cursor, /^o3$/);
  const s = await call("model_schema", { model_id: "model_openai-gpt-image-2-5-flare" });
  assert.equal(s.model_id, "model_openai-gpt-image-2-5-flare");
  const q = await call("estimate_cost", { model_id: "model_openai-gpt-image-2-5-flare", lane: "image", parameters: { prompt: "a lighthouse", quality: "low", width: 1024, height: 1024 }, takes: 1, new_document: { width: 1024, height: 1024 } });
  assert.equal(q.cu_cost_exact, "2");
  assert.equal(q.price_kind, "exact");
  const bad = await h.request("tools/call", { name: "estimate_cost", arguments: { model_id: "model_openai-gpt-image-2-5-flare", lane: "image", parameters: { quality: "low" } } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /InvalidParameter/);
  assert.match(bad.result.content[0].text, /Prompt is required/);
  for (const r of mock.requests.filter((x) => x.path.startsWith("/v1/generate"))) assert.equal(r.search, "?dryRun=true");
  assert.deepEqual(mock.violations, []);
});
