#!/usr/bin/env node
"use strict";
// M4 live check: the Edit and Enhance lanes against a live Photoshop and the
// live Scenario API, one real take per route. Not part of `npm test`. Run it
// by hand with a development build installed (see AGENTS.md) and the panel
// signed in. It SPENDS Scenario credits unless --price-only is given.
//
// What it does, per route:
// 1. Writes a fixture PNG (a small synthetic landscape) into the plugin's
//    data folder, then a request file `dev-live-run.json`. The development
//    build's live entry (plugin/src/dev/live-run.js) picks it up: it makes
//    its own document from the fixture, sets the selection, prices the run
//    through the lane code the panel uses, generates (the same quote,
//    capture, upload, second price check and paid call), waits for the
//    result to land and for the checks, reads the composite before and
//    after, and closes the documents it made without saving.
// 2. Waits for `dev-live/<route>/result.json`, copies the before and after
//    composites, the first take and the selection mask to --out.
// 3. Writes `m4-live-check.log` (versions, then per route: model, settings,
//    view notes, check results, badges) and, when ImageMagick's `montage` is
//    installed, contact sheets of each route's take beside its mask and
//    check result. With --spend-log, appends one line per paid run there.
//
// This script never talks to Scenario itself, never reads or prints a key,
// and never starts, focuses or quits Photoshop. It touches no document the
// person has open.
//
// Usage: node test/live/m4-live-check.js --out <dir> [--routes a,b]
//        [--price-only] [--ps-major 27] [--spend-log <file>]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const png = require("../../plugin/src/util/png.js");
const manifest = require("../../plugin/manifest.json");

const FLARE = "model_openai-gpt-image-2-5-flare";
const REFRAME = "model_scenario-gemini-reframe";
const PHOTOROOM = "model_photoroom-expand";
const FLUX1 = "model_bfl-flux-1-dev";
const FLUX2 = "model_bfl-flux-2-dev";
const W = 768;
const H = 512;
const DOC = { width: W, height: H, fixture: "dev-live/fixture.png", flatten: true };
// The red ball of the fixture, as an elliptical selection with a small feather.
const BALL = { left: 236, top: 276, width: 120, height: 120, shape: "ellipse", feather: 2 };

const ROUTES = [
  { id: "edit", label: "Edit, selection (GPT Image 2.5 Flare)", selection: BALL, max_cu: 5, run: { tool: "edit", prompt: "a blue glass sphere instead of the red ball, same light", takes: 1 } },
  { id: "expand-mask", label: "Expand, mask route (GPT Image 2.5 Flare)", max_cu: 5, run: { tool: "expand", prompt: "continue the landscape: more sky above, more meadow below", takes: 1, options: { ratio: "1:1", anchor: "center" } } },
  { id: "expand-position", label: "Expand, position route (Reframe)", max_cu: 12, run: { tool: "expand", model_id: REFRAME, prompt: "continue the landscape", options: { ratio: "1:1", anchor: "center" } } },
  { id: "expand-exact", label: "Expand, exact size (Photoroom Expand)", max_cu: 20, run: { tool: "expand", model_id: PHOTOROOM, options: { ratio: "1:1", anchor: "center" } } },
  { id: "upscale", label: "Upscale 2x, new document (Topaz)", max_cu: 15, run: { tool: "upscale", options: { factor: "2x", lands: "new_document" } } },
  { id: "remove-bg", label: "Remove BG, mask on the Background (851 Labs)", max_cu: 3, run: { tool: "remove_background" } },
  { id: "trained-strength", label: "Trained edit, image + strength (FLUX.1 Dev + LoRA)", selection: BALL, max_cu: 40, trained_pick: { type: "flux.1-lora", base: FLUX1 }, run: { tool: "trained_edit", prompt: "a wooden barrel instead of the red ball", takes: 1 } },
  { id: "trained-ref-style", label: "Trained edit, reference route, style LoRA (FLUX.2 Dev)", selection: BALL, max_cu: 40, trained_pick: { type: "flux.2-dev-lora", base: FLUX2 }, run: { tool: "trained_edit", prompt: "replace the red ball with a small stone statue; keep everything else", takes: 1 } },
  { id: "trained-ref-edit", label: "Trained edit, reference route, edit LoRA (FLUX.2 Dev)", selection: BALL, max_cu: 40, trained_pick: { type: "flux.2-dev-edit-lora", base: FLUX2 }, run: { tool: "trained_edit", prompt: "make the red ball golden; keep everything else", takes: 1 } }
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function pluginDataDir(major) {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Adobe", "UXP", "PluginsStorage", "PHSP", major, "External", manifest.id, "PluginData");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Adobe", "UXP", "PluginsStorage", "PHSP", major, "External", manifest.id, "PluginData");
  throw new Error("Photoshop runs on macOS and Windows only");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A synthetic landscape: sky, sun, hills, a tree and a red ball on a meadow,
// with a little deterministic grain.
function fixture() {
  const data = new Uint8Array(W * H * 3);
  let s = 12345;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      const g = ((s >>> 24) % 9) - 4;
      const hill = 300 + 40 * Math.sin(x / 90) + 20 * Math.sin(x / 37);
      let c;
      if (y < hill) c = [120 + (y / hill) * 80, 170 + (y / hill) * 50, 235];
      else c = [70 + ((y - hill) / H) * 60, 150 - ((y - hill) / H) * 40, 60];
      if ((x - 600) ** 2 + (y - 90) ** 2 < 40 ** 2) c = [255, 230, 150];
      if (x > 520 && x < 536 && y > 250 && y < 340) c = [90, 60, 40];
      if ((x - 528) ** 2 + (y - 230) ** 2 < 46 ** 2) c = [40, 110, 50];
      const d = Math.hypot(x - 296, y - 336);
      if (d < 52) {
        const shade = 1 - Math.max(0, (x - 296 + (y - 336)) / 110);
        c = [200 * shade + 40, 30 * shade + 10, 30 * shade + 10];
      }
      for (let k = 0; k < 3; k++) data[(y * W + x) * 3 + k] = Math.max(0, Math.min(255, Math.round(c[k] + g)));
    }
  }
  return png.encodePng({ width: W, height: H, channels: 3, data });
}

function gitCommit(repo) {
  const r = spawnSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  const d = spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
  return (r.stdout || "").trim() + (d.stdout && d.stdout.trim() ? " plus uncommitted M4 changes" : "");
}

function macVersion() {
  if (process.platform !== "darwin") return os.release();
  const r = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" });
  return `macOS ${(r.stdout || "").trim()}`;
}

function copy(dataDir, rel, to) {
  if (!rel) return null;
  const from = path.join(dataDir, rel);
  if (!fs.existsSync(from)) return null;
  fs.copyFileSync(from, to);
  return to;
}

// The standard deviation of an image's pixels (0 to 1) through ImageMagick,
// or null without it: a blank capture reads 0.
function spread(file) {
  if (!file) return null;
  const r = spawnSync("magick", [file, "-alpha", "off", "-format", "%[fx:standard_deviation]", "info:"], { encoding: "utf8" });
  const v = Number((r.stdout || "").trim());
  return r.status === 0 && Number.isFinite(v) ? v : null;
}

function verdict(r) {
  if (!r.ok) return "FAIL";
  if (r.capture_spread !== null && r.capture_spread !== undefined && r.capture_spread < 0.01) return "FAIL (the capture sent is blank)";
  const pl = r.placement || {};
  if (pl.masked && pl.verify && pl.verify.untouched === false) return "FAIL (changed outside)";
  return "PASS";
}

function describe(r, route) {
  const lines = [];
  lines.push(`## ${route.label} [${route.id}]`);
  lines.push(`verdict: ${verdict(r)}; state: ${r.state || "none"}${r.error ? `; error: ${r.error}` : ""}`);
  if (r.trained) lines.push(`trained model: ${r.trained.name} (${r.trained.model_id}, ${r.trained.type}, ${r.trained.kind}, scale ${r.trained.scale})`);
  if (r.view) {
    lines.push(`model: ${r.model_name || r.view.model_id}; route: ${r.view.route || r.view.tool}${r.view.experimental ? " (Experimental)" : ""}`);
    if (r.view.source) lines.push(`source: ${r.view.source.text}`);
    if (r.view.sizes) lines.push(`sizes: ${JSON.stringify(r.view.sizes)}`);
    if (r.view.notes && r.view.notes.length) lines.push(`notes: ${r.view.notes.join(" | ")}`);
  }
  if (r.parameters) {
    const p = { ...r.parameters };
    for (const k of Object.keys(p)) if (typeof p[k] === "string" && /^asset_/.test(p[k])) p[k] = "<upload>";
    if (Array.isArray(p.referenceImages)) p.referenceImages = p.referenceImages.map(() => "<upload>");
    lines.push(`sent: ${JSON.stringify(p)}`);
  }
  if (r.capture) lines.push(`capture: ${r.capture.files.map((f) => `${f.slot} ${f.width} x ${f.height} ${f.format}${f.reduced ? " reduced" : ""}`).join(", ")}${r.capture_spread !== null && r.capture_spread !== undefined ? `; pixel spread ${r.capture_spread.toFixed(3)}` : ""}`);
  if (r.outputs) lines.push(`results: ${r.outputs.map((o) => `${o.width} x ${o.height}`).join(", ")}`);
  const pl = r.placement;
  if (pl) {
    lines.push(`placed: history "${pl.history}", masked ${pl.masked}`);
    if (pl.checks && pl.checks.length) lines.push(`checks: ${JSON.stringify(pl.checks)}`);
    if (pl.verify) lines.push(`outside the mask: ${pl.verify.untouched ? "unchanged" : "CHANGED"} (largest difference ${pl.verify.outside_max})`);
    lines.push(`badges: ${JSON.stringify(pl.badges)}`);
    if (pl.notes && pl.notes.length) lines.push(`placement notes: ${pl.notes.join(" | ")}`);
  }
  return lines.join("\n");
}

function sheets(out, done) {
  const which = spawnSync("which", ["montage"], { encoding: "utf8" });
  if (which.status !== 0) {
    console.log("montage not found: no contact sheet");
    return [];
  }
  const groups = [
    ["m4-sheet-edit.png", done.filter((d) => d.route.id === "edit" || d.route.id.startsWith("trained"))],
    ["m4-sheet-enhance.png", done.filter((d) => !(d.route.id === "edit" || d.route.id.startsWith("trained")))]
  ];
  // ImageMagick may have no default font; use a system one when found.
  const fontFile = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf", "C:\\Windows\\Fonts\\arial.ttf"].find((f) => fs.existsSync(f));
  const font = fontFile ? ["-font", fontFile] : [];
  const made = [];
  for (const [name, list] of groups) {
    if (!list.length) continue;
    const rows = [];
    for (const d of list) {
      const r = d.result;
      const tiles = [];
      const tile = (file, label) => (file ? ["-label", label, file] : ["-label", `${label}: none`, "xc:#dddddd"]);
      tiles.push(...tile(d.files.before, "before"), ...tile(d.files.capture, "capture sent"), ...tile(d.files.mask, "mask"), ...tile(d.files.take, "take 1 as returned"), ...tile(d.files.after, "placed"));
      const badges = r.placement ? (r.placement.badges[0] || []).join(", ") || "no badge" : "";
      const outside = r.placement && r.placement.verify ? ` | outside ${r.placement.verify.untouched ? "unchanged" : "CHANGED"}` : "";
      const title = `${d.route.id}: ${verdict(r)} | ${badges}${outside}`;
      const row = path.join(out, `row-${d.route.id}.png`);
      const m = spawnSync("montage", [...font, ...tiles, "-tile", "5x1", "-geometry", "300x300+6+6", "-size", "300x200", "-background", "white", "-pointsize", "14", "-title", title, row], { encoding: "utf8" });
      if (m.status === 0) rows.push(row);
      else console.log(`montage failed for ${d.route.id}: ${m.stderr}`);
    }
    const sheet = path.join(out, name);
    const all = spawnSync("montage", [...rows, "-tile", "1x", "-geometry", "+0+0", "-background", "white", sheet], { encoding: "utf8" });
    if (all.status === 0) {
      spawnSync("magick", [sheet, "-resize", "1600x1600>", sheet]);
      made.push(sheet);
    }
  }
  return made;
}

async function main() {
  const out = arg("--out", null);
  if (!out) throw new Error("--out <dir> is required");
  const major = arg("--ps-major", "27");
  const priceOnly = process.argv.includes("--price-only");
  const only = arg("--routes", null);
  const spendLog = arg("--spend-log", null);
  const dataDir = pluginDataDir(major);
  const shownDir = dataDir.replace(os.homedir(), "~");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "dev-live"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "dev-live", "fixture.png"), fixture());
  console.log(`fixture written to ${shownDir}/dev-live/fixture.png`);
  const routes = ROUTES.filter((r) => !only || only.split(",").includes(r.id));
  const done = [];
  let photoshop = null;
  for (const route of routes) {
    const id = `${route.id}${priceOnly ? "-price" : ""}`;
    const resultFile = path.join(dataDir, "dev-live", id, "result.json");
    if (fs.existsSync(resultFile)) fs.renameSync(resultFile, `${resultFile}.${Date.now()}.old`);
    const req = { id, route: route.id, document: DOC, selection: route.selection || null, run: route.run, trained_pick: route.trained_pick || null, spend: !priceOnly, max_cu: route.max_cu, timeout_s: 600 };
    fs.writeFileSync(path.join(dataDir, "dev-live-run.json"), JSON.stringify(req));
    console.log(`${route.id}: request written, waiting`);
    const t0 = Date.now();
    while (!fs.existsSync(resultFile)) {
      if (Date.now() - t0 > 12 * 60 * 1000) throw new Error(`${route.id}: no result after 12 minutes`);
      await sleep(2000);
    }
    await sleep(300);
    const r = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    photoshop = photoshop || r.photoshop || null;
    const files = {
      before: copy(dataDir, r.files && r.files.before, path.join(out, `${route.id}-before.png`)),
      after: copy(dataDir, r.files && r.files.after, path.join(out, `${route.id}-after.png`)),
      take: r.outputs && r.outputs[0] ? copy(dataDir, r.outputs[0].path, path.join(out, `${route.id}-take${path.extname(r.outputs[0].path || ".png")}`)) : null,
      mask: r.capture ? copy(dataDir, `captures/${r.capture.id}/mask.png`, path.join(out, `${route.id}-mask.png`)) : null,
      capture: null
    };
    const sent = r.capture && (r.capture.files || []).find((f) => f.slot === "capture");
    if (sent) files.capture = copy(dataDir, `captures/${r.capture.id}/context.${sent.format}`, path.join(out, `${route.id}-capture.${sent.format}`));
    r.capture_spread = spread(files.capture);
    done.push({ route, result: r, files });
    console.log(`${route.id}: ${priceOnly ? r.price_state + (r.quote ? ` ${r.quote.label}` : "") + (r.error ? ` (${r.error})` : "") : verdict(r)}`);
    if (spendLog && !priceOnly && r.local_id && r.state && r.state !== "not_sent") {
      const settings = JSON.stringify(r.parameters || {}).replace(/"asset_[A-Za-z0-9]+"/g, '"<upload>"').replace(/\|/g, "/");
      const line = `| ${new Date().toISOString().slice(0, 10)} | 3 (M4 live check, ${route.id}) | ${r.model_name || r.model_id}${r.trained ? ` + ${r.trained.name}` : ""} | ${settings} | ${r.cu_charged !== null && r.cu_charged !== undefined ? r.cu_charged : r.cu_quoted} | ${route.label}: one real take for the M4 exit (${verdict(r)}) | ${r.job_id || "no job id"}${r.asset_ids && r.asset_ids.filter(Boolean).length ? ` / ${r.asset_ids.filter(Boolean).join(", ")}` : ""} (${r.state}) |\n`;
      fs.appendFileSync(spendLog, line);
    }
  }
  const header = [
    "# M4 live check",
    `date: ${new Date().toISOString()}`,
    `plugin: ${manifest.version} (${gitCommit(path.resolve(__dirname, "..", ".."))})`,
    `photoshop: ${photoshop || "unknown"}`,
    `os: ${macVersion()}`,
    `mode: ${priceOnly ? "price only" : "one real take per route"}`,
    ""
  ];
  const log = header.concat(done.map((d) => describe(d.result, d.route) + "\n")).join("\n");
  fs.writeFileSync(path.join(out, priceOnly ? "m4-price-check.log" : "m4-live-check.log"), log);
  if (!priceOnly) for (const s of sheets(out, done)) console.log(`contact sheet: ${s}`);
  console.log(`log: ${path.join(out, priceOnly ? "m4-price-check.log" : "m4-live-check.log")}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
