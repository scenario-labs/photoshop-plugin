#!/usr/bin/env node
"use strict";
// The panel's look, without restarting Photoshop: drives the development
// build's UI loop (plugin/src/dev/ui-loop.js). Not part of `npm test`. macOS.
//
//   node test/live/ui-dev.js push              build the dev bundle, copy index.html,
//                                              styles.css and dist/main.js into the
//                                              installed plugin folder, reload the panel
//   node test/live/ui-dev.js view '{"name":"settings"}'
//   node test/live/ui-dev.js metrics
//   node test/live/ui-dev.js width '{"px":400,"shift":120}'
//   node test/live/ui-dev.js capture out.png   silent capture of Photoshop's main
//                                              window (needs uv; never activates it)
//   node test/live/ui-dev.js demo '{"what":"failure"}'
//                                              sample states of the account views and
//                                              Jobs rows (plugin/src/dev/ui-demo.js);
//                                              each {"file": path} is sent as base64
//   node test/live/ui-dev.js makedoc|select|click|prompt|pop|state|inspect|adopt|closedoc '{...}'
//                                              drives the creation panel on documents
//                                              the loop makes (AGENTS.md, Panel UI)
//
// Any other first argument is sent as a command with the JSON that follows
// (see ui-loop.js for the list). The loop exists only in development builds;
// the installed plugin must be one (`npm run package:dev`, AGENTS.md).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const manifest = require("../../plugin/manifest.json");
const { build } = require("../../plugin/scripts/build.js");

const MAJOR = process.env.PS_MAJOR || "27";
const ADOBE = path.join(os.homedir(), "Library", "Application Support", "Adobe", "UXP");
const DATA = path.join(ADOBE, "PluginsStorage", "PHSP", MAJOR, "External", manifest.id, "PluginData");
const PLUGINS = path.join(ADOBE, "Plugins", "External");
const PLUGIN_SRC = path.resolve(__dirname, "..", "..", "plugin");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installedFolder() {
  const dirs = fs.readdirSync(PLUGINS).filter((d) => d.startsWith(manifest.id + "_"));
  if (dirs.length !== 1) throw new Error(`expected one installed ${manifest.id} folder, found ${dirs.length}`);
  return path.join(PLUGINS, dirs[0]);
}

async function send(cmd, timeoutMs = 8000) {
  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const result = path.join(DATA, "dev-ui-result.json");
  try {
    fs.unlinkSync(result);
  } catch (e) {
    // no earlier result
  }
  fs.writeFileSync(path.join(DATA, "dev-ui-command.json"), JSON.stringify({ ...cmd, id }));
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(150);
    let text = null;
    try {
      text = fs.readFileSync(result, "utf8");
    } catch (e) {
      continue;
    }
    let out = null;
    try {
      out = JSON.parse(text);
    } catch (e) {
      continue; // read while the panel was still writing it
    }
    if (out.id === id) return out;
  }
  throw new Error("no answer from the panel (is a development build installed and Photoshop running?)");
}

function windowId() {
  const code = [
    "import Quartz",
    // All windows, not only on-screen ones: the capture works while another
    // app covers Photoshop or another Space shows.
    "ws = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID)",
    // The main window is titled after the active document, or "Adobe
    // Photoshop 2026" with none open: take the largest titled window.
    "ws = [w for w in ws if str(w.get('kCGWindowOwnerName', '')).startswith('Adobe Photoshop') and str(w.get('kCGWindowName', '')) and int(w.get('kCGWindowLayer', 0)) == 0]",
    "ws.sort(key=lambda w: -int(w['kCGWindowBounds']['Width']) * int(w['kCGWindowBounds']['Height']))",
    "print(int(ws[0]['kCGWindowNumber']) if ws else '')"
  ].join("\n");
  const out = execFileSync("uv", ["run", "-q", "--with", "pyobjc-framework-Quartz", "python", "-c", code], { encoding: "utf8" }).trim();
  if (!out) throw new Error("no Photoshop main window found");
  return out;
}

// Replaces each { file: path } in a demo's arguments with the file's bytes
// as base64, its type and the width and height given (sample pictures).
function embed(v) {
  if (Array.isArray(v)) return v.map(embed);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = embed(x);
  if (typeof v.file === "string") {
    out.b64 = fs.readFileSync(path.resolve(v.file)).toString("base64");
    out.mime = /\.jpe?g$/i.test(v.file) ? "image/jpeg" : "image/png";
    delete out.file;
  }
  return out;
}

async function main() {
  const [what, json] = process.argv.slice(2);
  if (!what) throw new Error("usage: ui-dev.js <push|capture|command> [json]");
  if (what === "push") {
    const dest = installedFolder();
    const built = build({ dev: true, outFile: path.join(dest, "dist", "main.js") });
    for (const f of ["index.html", "styles.css"]) fs.copyFileSync(path.join(PLUGIN_SRC, f), path.join(dest, f));
    console.log(`pushed ${built.files.length} modules to the installed ${path.basename(dest)}`);
    console.log(JSON.stringify(await send({ cmd: "reload" })));
    return;
  }
  if (what === "capture") {
    const out = path.resolve(json || "panel-window.png");
    execFileSync("screencapture", ["-x", "-o", "-l", windowId(), out]);
    console.log(out);
    return;
  }
  const res = await send(embed({ cmd: what, ...(json ? JSON.parse(json) : {}) }), Number(process.env.UI_DEV_WAIT_MS) || 20000);
  console.log(JSON.stringify(res, null, what === "metrics" ? 0 : 2));
  if (!res.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
