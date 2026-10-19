#!/usr/bin/env node
"use strict";
// M1 live check: an agent client sees scenario_status from a live Photoshop.
// Not part of `npm test`. Run it by hand, with a development build installed
// (`npm run package:dev`, then install the .ccx; see AGENTS.md).
//
// What it does:
// 1. Makes a fresh pairing token and writes it as `dev-pairing-token` into the
//    plugin's data folder. A development build adopts it at its next start and
//    removes the file (release builds ignore it).
// 2. Starts this checkout's helper on port 9890 with the token in its
//    environment, and speaks MCP to it over stdio as an agent client would.
// 3. Calls scenario_status until the plugin is connected, then prints the
//    status, the Host/Origin/User-Agent the plugin's WebSocket sent (logged by
//    the helper), and the end of the plugin's own log.
//
// It never starts, focuses or quits Photoshop: start or restart Photoshop
// yourself once the token file is written. The token is never printed.
//
// Usage: node test/live/m1-live-check.js [--ps-major 27] [--timeout 180] [--show-titles]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnHelper } = require("../helpers/mcp-client.js");
const manifest = require("../../plugin/manifest.json");

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
  const timeoutS = Number(arg("--timeout", "180"));
  const showTitles = process.argv.includes("--show-titles");
  const dataDir = pluginDataDir(major);
  const shownDir = dataDir.replace(os.homedir(), "~");
  const token = crypto.randomBytes(32).toString("base64url");

  fs.mkdirSync(dataDir, { recursive: true });
  const tokenFile = path.join(dataDir, "dev-pairing-token");
  fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  console.log(`1. Wrote a new pairing token to ${shownDir}/dev-pairing-token`);
  console.log("   Start or restart Photoshop now (development build of the plugin installed).");

  const helper = spawnHelper({ env: { SCENARIO_PHOTOSHOP_TOKEN: token, SCENARIO_PHOTOSHOP_QUIET: "0" } });
  const stop = async (code) => {
    await helper.close().catch(() => {});
    process.exit(code);
  };
  const init = await helper.initialize("m1-live-check");
  console.log(`2. Helper ${init.result.serverInfo.version} started (MCP ${init.result.protocolVersion}); waiting for the plugin on port 9890`);

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
    console.log(helper.stderr().split("\n").slice(-15).join("\n"));
    return stop(1);
  }

  const shown = { ...status };
  if (!showTitles) shown.open_documents = status.open_documents.map((d) => ({ id: d.id, title: `<${d.title.length} characters>` }));
  console.log("3. scenario_status from the live Photoshop:");
  console.log(JSON.stringify(shown, null, 2));
  console.log(`   dev-pairing-token removed by the plugin: ${!fs.existsSync(tokenFile)}`);
  const headers = helper.stderr().split("\n").filter((l) => l.includes("plugin connection:"));
  console.log("4. What the UXP WebSocket sent (helper log):");
  for (const l of headers.slice(-2)) console.log(`   ${l}`);
  const pluginLog = path.join(dataDir, "scenario-link.log");
  if (fs.existsSync(pluginLog)) {
    const text = fs.readFileSync(pluginLog, "utf8");
    if (text.includes(token)) {
      console.log("FAILED: the plugin log contains the token");
      return stop(1);
    }
    console.log("5. End of the plugin log:");
    for (const l of text.trim().split("\n").slice(-8)) console.log(`   ${l}`);
  }
  console.log("OK: M1 exit, an agent client sees scenario_status from a live Photoshop.");
  return stop(0);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
