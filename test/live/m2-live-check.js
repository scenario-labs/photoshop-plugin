#!/usr/bin/env node
"use strict";
// M2 live check: an agent client gets exact prices from a live Photoshop for
// the three model families of the M2 exit. Not part of `npm test`. Run it by
// hand with a development build installed (see AGENTS.md) and the panel
// signed in to Scenario.
//
// What it does:
// 1. Makes a fresh pairing token and writes it as `dev-pairing-token` into the
//    plugin's data folder (a development build adopts it at its next start).
// 2. Starts this checkout's helper with that token and SCENARIO_NO_SPEND=1,
//    and speaks MCP to it over stdio as an agent client would.
// 3. Calls scenario_status until the plugin is connected. If the plugin is not
//    signed in, it stops there: sign in from the panel yourself.
// 4. Calls list_models, then estimate_cost for an Image default (GPT Image 2.5
//    Flare, low, 1024 x 1024, 1 take), an Edit default with a mask (the same
//    model, 2 takes, capture and mask still to upload) and an Enhance model
//    (851 Labs background remover). Each price is a free price check that the
//    plugin sends with its one tested dry-run constant; the 851 Labs check
//    uploads one small blank stand-in to the project, hidden from the Library.
//
// This script never talks to Scenario itself and never reads or prints a key.
// It never starts, focuses or quits Photoshop. The token is never printed.
//
// Usage: node test/live/m2-live-check.js [--ps-major 27] [--timeout 300]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnHelper } = require("../helpers/mcp-client.js");
const manifest = require("../../plugin/manifest.json");

const FLARE = "model_openai-gpt-image-2-5-flare";
const BG = "model_851-labs-background-remover";
const PROMPT = "a lighthouse on a cliff at dusk";
const CHECKS = [
  { label: "Image default", expect: "2", args: { model_id: FLARE, lane: "image", parameters: { prompt: PROMPT, quality: "low", width: 1024, height: 1024 }, takes: 1, new_document: { width: 1024, height: 1024 } } },
  { label: "Edit default, with a mask", expect: "3", args: { model_id: FLARE, lane: "edit", parameters: { prompt: PROMPT, quality: "low", width: 1024, height: 1024 }, takes: 2 } },
  { label: "Enhance, Remove BG", expect: "1", args: { model_id: BG, lane: "remove_background" } }
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function pluginDataDir(major) {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Adobe", "UXP", "PluginsStorage", "PHSP", major, "External", manifest.id, "PluginData");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Adobe", "UXP", "PluginsStorage", "PHSP", major, "External", manifest.id, "PluginData");
  }
  throw new Error("Photoshop runs on macOS and Windows only");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const major = arg("--ps-major", "27");
  const timeoutS = Number(arg("--timeout", "300"));
  const dataDir = pluginDataDir(major);
  const shownDir = dataDir.replace(os.homedir(), "~");
  const token = crypto.randomBytes(32).toString("base64url");

  fs.mkdirSync(dataDir, { recursive: true });
  const tokenFile = path.join(dataDir, "dev-pairing-token");
  fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  console.log(`1. Wrote a new pairing token to ${shownDir}/dev-pairing-token`);

  const helper = spawnHelper({ env: { SCENARIO_PHOTOSHOP_TOKEN: token, SCENARIO_PHOTOSHOP_QUIET: "0", SCENARIO_NO_SPEND: "1" } });
  const stop = async (code) => {
    await helper.close().catch(() => {});
    process.exit(code);
  };
  const init = await helper.initialize("m2-live-check");
  console.log(`2. Helper ${init.result.serverInfo.version} started; waiting for the plugin on port 9890`);

  const deadline = Date.now() + timeoutS * 1000;
  let status = null;
  while (Date.now() < deadline) {
    status = await helper.status();
    if (status.connected) break;
    await sleep(2000);
  }
  if (!status || !status.connected) {
    console.log(`FAILED: not connected after ${timeoutS} s. Last status: ${status ? status.reason : "none"}`);
    console.log(`   dev-pairing-token still present: ${fs.existsSync(tokenFile)}`);
    return stop(1);
  }
  console.log(`3. Connected: plugin ${status.plugin_version}, Photoshop ${status.photoshop_version}, signed_in ${status.signed_in}, no_spend ${status.no_spend}, ${status.open_documents.length} open document(s)`);
  if (!status.signed_in) {
    console.log("STOPPED: the plugin is not signed in. Sign in from the panel, then run this again.");
    return stop(3);
  }

  async function call(name, args) {
    const r = await helper.request("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    if (r.result.isError) return { error: r.result.content[0].text };
    return r.result.structuredContent || JSON.parse(r.result.content[0].text);
  }

  for (const lane of ["image", "edit", "remove_background"]) {
    const t0 = Date.now();
    const listed = await call("list_models", { lane, limit: 5 });
    if (listed.error) {
      console.log(`4. list_models ${lane}: ${listed.error}`);
      return stop(1);
    }
    console.log(`4. list_models ${lane} (${Date.now() - t0} ms): ${listed.models.map((m) => m.model_id).join(", ")}${listed.next_cursor ? ", ..." : ""}`);
  }

  let ok = true;
  for (const c of CHECKS) {
    const t0 = Date.now();
    const q = await call("estimate_cost", c.args);
    if (q.error) {
      ok = false;
      console.log(`5. ${c.label}, ${c.args.model_id}: ${q.error}`);
      continue;
    }
    const same = q.cu_cost_exact === c.expect && q.price_kind === "exact";
    if (!same) ok = false;
    console.log(`5. ${c.label}, ${c.args.model_id}: ${q.cu_cost_exact} CU (${q.price_kind}), needs_upload ${q.needs_upload}, no_refund ${q.no_refund}, ${Date.now() - t0} ms${same ? "" : `, expected ${c.expect} CU exact`}`);
  }

  await sleep(500);
  const pluginLog = path.join(dataDir, "scenario-link.log");
  if (fs.existsSync(pluginLog)) {
    const text = fs.readFileSync(pluginLog, "utf8");
    if (text.includes(token) || text.includes(PROMPT)) {
      console.log("FAILED: the plugin log contains the token or the prompt");
      return stop(1);
    }
  }
  console.log(ok ? "OK: M2 exit, exact prices for the three families from a live Photoshop." : "DIFFERENT: see the lines above.");
  return stop(ok ? 0 : 2);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
