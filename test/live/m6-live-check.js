#!/usr/bin/env node
"use strict";
// M6 live check (SPEC 12.2 item 11, SPEC 12.1 allow-list rows): against a
// live Photoshop with a development build installed and signed in. Not part
// of `npm test`. macOS only. It never starts, focuses, clicks or quits
// Photoshop, and touches only the documents its requests make.
//
// Before anything, it takes the shared lock file (--lock) and refuses to
// run if another name holds it; it checks the free disk space (8 GB at
// least). It saves the installed plugin's index.html, styles.css and
// dist/main.js, pushes this checkout's development bundle into the
// installed folder (the dev loop's push, no reinstall), and on exit puts
// the saved files back and reloads the panel, so the installed build is as
// it was. Then the lock is released.
//
//   --phase measure   The open SPEC items flagged M6, measured once:
//                     a reference chain without a document element,
//                     select_layers and History, Select Subject (its
//                     processing preference and the descriptor), then the
//                     allow-list live: every listed event once on a
//                     document of its own, the refused cases, and the
//                     target-not-active cases with two documents.
//                     Spends nothing.
//   --phase session   The exit: a fresh pairing token goes to the plugin
//                     (dev-pairing-token, adopted at the panel reload) and
//                     to the helper through the setup command (stdin, never
//                     an argument), which writes the token file and an MCP
//                     config without the token. Claude Code runs headless
//                     (claude -p) with that config only, a scoped tool
//                     list and a prompt that drives one document the dev
//                     entry made: read, select, capture, upload (its card
//                     approved), price, generate (the spend card approved
//                     through the panel's own approve path), land, then a
//                     second request the dev entry declines. SPENDS one
//                     paid job at the smallest settings.
//
// Usage: node test/live/m6-live-check.js --phase measure|session --out <dir>
//        --lock <file> [--name "m6 agents"] [--cwd <empty dir for claude -p>]
//
// Writes <out>/m6-<phase>.json (every step's outcome) and, for the session,
// <out>/claude-session.jsonl (the transcript) and <out>/claude-session.txt
// (its final text). Prints no token and no key.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const manifest = require("../../plugin/manifest.json");
const { build } = require("../../plugin/scripts/build.js");
const png = require("../../plugin/src/util/png.js");

const MAJOR = process.env.PS_MAJOR || "27";
const ADOBE = path.join(os.homedir(), "Library", "Application Support", "Adobe", "UXP");
const DATA = path.join(ADOBE, "PluginsStorage", "PHSP", MAJOR, "External", manifest.id, "PluginData");
const PLUGINS = path.join(ADOBE, "Plugins", "External");
const PLUGIN_SRC = path.resolve(__dirname, "..", "..", "plugin");
const REPO = path.resolve(__dirname, "..", "..");
const FLARE = "model_openai-gpt-image-2-5-flare";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const PHASE = arg("--phase");
const OUT = path.resolve(arg("--out", "m6-live"));
const LOCK = arg("--lock");
const NAME = arg("--name", "m6 agents");

function log(text) {
  const line = `${new Date().toISOString()} ${text}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT, "m6-live-check.log"), line + "\n");
}

function takeLock() {
  if (!LOCK) throw new Error("--lock <file> is required");
  try {
    const held = fs.readFileSync(LOCK, "utf8").trim();
    if (held && !held.includes(NAME)) throw new Error(`the lock is held: ${held}`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const hm = new Date().toTimeString().slice(0, 5);
  fs.writeFileSync(LOCK, `photoshop ${NAME} ${hm}\n`);
}

// A Photoshop alert or dialog (a window with the AXDialog subrole), read
// through System Events without activating Photoshop. Returns its text, or
// null. Never presses anything.
let blocked = null;
function alertText() {
  const script = [
    'tell application "System Events" to tell process "Adobe Photoshop 2026"',
    'set out to ""',
    "repeat with w in windows",
    'if subrole of w is "AXDialog" then',
    "repeat with e in (static texts of w)",
    "try",
    "set out to out & (value of e as text) & \" \"",
    "end try",
    "end repeat",
    'if out is "" then set out to "(a dialog with no text)"',
    "end if",
    "end repeat",
    "return out",
    "end tell"
  ];
  const r = spawnSync("osascript", script.flatMap((l) => ["-e", l]), { encoding: "utf8", timeout: 15000 });
  const t = (r.stdout || "").trim();
  return t || null;
}

function checkAlert() {
  const t = alertText();
  if (t) {
    blocked = t;
    throw new Error("BLOCKED: " + t);
  }
}

function releaseLock() {
  if (blocked) {
    fs.writeFileSync(LOCK, `photoshop ${NAME} ${new Date().toTimeString().slice(0, 5)} BLOCKED: a Photoshop alert is open: "${blocked}". A person must dismiss it.\n`);
    return;
  }
  try {
    const held = fs.readFileSync(LOCK, "utf8");
    if (held.includes(NAME)) fs.renameSync(LOCK, `${LOCK}.released-m6-${new Date().toTimeString().slice(0, 5).replace(":", "")}`);
  } catch (e) {
    // nothing held
  }
}

function freeGb() {
  const out = execFileSync("df", ["-k", "/"], { encoding: "utf8" }).trim().split("\n").pop().split(/\s+/);
  return Number(out[3]) / 1024 / 1024;
}

function installedFolder() {
  const dirs = fs.readdirSync(PLUGINS).filter((d) => d.startsWith(manifest.id + "_"));
  if (dirs.length !== 1) throw new Error(`expected one installed ${manifest.id} folder, found ${dirs.length}`);
  return path.join(PLUGINS, dirs[0]);
}

async function uiSend(cmd, timeoutMs = 10000) {
  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const result = path.join(DATA, "dev-ui-result.json");
  try {
    fs.unlinkSync(result);
  } catch (e) {
    // none
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
      continue; // still being written
    }
    if (out.id === id) return out;
  }
  throw new Error("no answer from the panel's dev loop");
}

async function waitPing(label, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await uiSend({ cmd: "ping" }, 3000);
      if (r && r.ok !== false) return;
    } catch (e) {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`the panel did not answer after ${label}`);
}

// The dev entry's agent steps (plugin/src/dev/live-run.js).
async function agent(id, steps, timeoutMs = 120000) {
  const dir = path.join(DATA, "dev-live", id);
  try {
    fs.renameSync(path.join(dir, "result.json"), path.join(dir, `result.${Date.now()}.json`));
  } catch (e) {
    // first run
  }
  fs.writeFileSync(path.join(DATA, "dev-live-run.json"), JSON.stringify({ id, agent: { steps } }));
  const until = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < until) {
    await sleep(500);
    if (++n % 8 === 0) checkAlert();
    let text = null;
    try {
      text = fs.readFileSync(path.join(dir, "result.json"), "utf8");
      return JSON.parse(text);
    } catch (e) {
      continue; // not there yet, or still being written
    }
  }
  throw new Error(`no result for ${id}`);
}

function fixture(file, w, h) {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const sky = y < h * 0.6;
      data[i] = sky ? 120 + Math.round((60 * y) / h) : 70;
      data[i + 1] = sky ? 160 + Math.round((40 * y) / h) : 110;
      data[i + 2] = sky ? 220 : 60;
      const dx = x - w * 0.42;
      const dy = y - h * 0.62;
      if (dx * dx + dy * dy < (h * 0.13) ** 2) {
        data[i] = 210;
        data[i + 1] = 40;
        data[i + 2] = 40;
      }
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(png.encodePng({ width: w, height: h, channels: 3, data })));
}

const SAVED = ["index.html", "styles.css", path.join("dist", "main.js")];

async function pushOwn(dest, keep) {
  fs.mkdirSync(keep, { recursive: true });
  for (const f of SAVED) fs.copyFileSync(path.join(dest, f), path.join(keep, path.basename(f)));
  build({ dev: true, outFile: path.join(dest, "dist", "main.js") });
  for (const f of ["index.html", "styles.css"]) fs.copyFileSync(path.join(PLUGIN_SRC, f), path.join(dest, f));
  await uiSend({ cmd: "reload" });
  await sleep(1500);
  await waitPing("the push");
  log(`pushed this checkout's development bundle into ${path.basename(dest)}`);
}

async function restore(dest, keep) {
  for (const f of SAVED) fs.copyFileSync(path.join(keep, path.basename(f)), path.join(dest, f));
  if (blocked) {
    log("restored the installed files; no reload while an alert is open");
    return;
  }
  try {
    await uiSend({ cmd: "reload" });
    await sleep(1500);
    await waitPing("the restore");
    log("restored the installed bundle and reloaded the panel");
  } catch (e) {
    log(`restored the installed files; the reload did not answer (${e.message})`);
  }
}

// ---- measure ----

const PX = (v) => ({ _unit: "pixelsUnit", _value: v });
const LAYER = [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }];
const SEL = [{ _ref: "channel", _property: "selection" }];
// One live descriptor per listed event, on a document of the check's own
// with a pixel layer active and a selection where the event needs one.
const EVENT_CASES = {
  get: [{ _obj: "get", _target: [{ _property: "name" }, LAYER[0]] }],
  make: [{ _obj: "make", _target: [{ _ref: "layer" }] }],
  set: [{ _obj: "set", _target: LAYER, to: { _obj: "layer", name: "m6 renamed" } }],
  select: [{ _obj: "select", _target: LAYER, makeVisible: false }],
  duplicate: [{ _obj: "duplicate", _target: LAYER }],
  delete: [{ _obj: "duplicate", _target: LAYER }, { _obj: "delete", _target: LAYER }],
  move: [{ _obj: "duplicate", _target: LAYER }, { _obj: "move", _target: LAYER, to: { _ref: "layer", _enum: "ordinal", _value: "previous" } }],
  transform: [{ _obj: "transform", _target: LAYER, freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" }, width: { _unit: "percentUnit", _value: 90 }, height: { _unit: "percentUnit", _value: 90 } }],
  show: [{ _obj: "show", null: LAYER }],
  hide: [{ _obj: "hide", null: LAYER }],
  fill: [{ _obj: "fill", using: { _enum: "fillContents", _value: "color" }, color: { _obj: "RGBColor", red: 20, grain: 120, blue: 200 }, opacity: { _unit: "percentUnit", _value: 50 }, mode: { _enum: "blendMode", _value: "normal" } }],
  newPlacedLayer: [{ _obj: "newPlacedLayer" }],
  rasterizeLayer: [{ _obj: "newPlacedLayer" }, { _obj: "rasterizeLayer", _target: LAYER }],
  placedLayerReplaceContents: null,
  mergeVisible: [{ _obj: "mergeVisible", duplicate: true }],
  mergeLayersNew: [{ _obj: "duplicate", _target: LAYER }, { _obj: "select", _target: [{ _ref: "layer", _enum: "ordinal", _value: "backwardEnum" }], selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" } }, { _obj: "mergeLayersNew" }],
  canvasSize: [{ _obj: "canvasSize", width: PX(520), height: PX(392), horizontal: { _enum: "horizontalLocation", _value: "center" }, vertical: { _enum: "verticalLocation", _value: "center" } }],
  imageSize: [{ _obj: "imageSize", width: PX(500), constrainProportions: true, interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "automaticInterpolation" } }],
  crop: [{ _obj: "crop", delete: true }],
  autoCutout: [{ _obj: "autoCutout", sampleAllLayers: true }],
  colorRange: [{ _obj: "colorRange", fuzziness: 40, minimum: { _obj: "labColor", luminance: 30, a: 40, b: 20 }, maximum: { _obj: "labColor", luminance: 60, a: 80, b: 60 }, colorModel: 0 }],
  expand: [{ _obj: "expand", by: PX(4), selectionModifyEffectAtCanvasBounds: false }],
  contract: [{ _obj: "contract", by: PX(4), selectionModifyEffectAtCanvasBounds: false }],
  feather: [{ _obj: "feather", radius: PX(3), selectionModifyEffectAtCanvasBounds: false }],
  smoothness: [{ _obj: "smoothness", radius: PX(3), selectionModifyEffectAtCanvasBounds: false }],
  intersectWith: [{ _obj: "intersectWith", _target: SEL, to: { _obj: "rectangle", top: PX(0), left: PX(0), bottom: PX(300), right: PX(300) } }],
  addTo: [{ _obj: "addTo", _target: SEL, to: { _obj: "rectangle", top: PX(10), left: PX(10), bottom: PX(40), right: PX(40) } }],
  subtractFrom: [{ _obj: "subtractFrom", _target: SEL, to: { _obj: "rectangle", top: PX(10), left: PX(10), bottom: PX(20), right: PX(20) } }],
  inverse: [{ _obj: "inverse" }, { _obj: "inverse" }],
  align: [{ _obj: "align", _target: LAYER, using: { _enum: "alignDistributeSelector", _value: "ADSCentersH" }, alignToCanvas: true }],
  applyImage: [{ _obj: "applyImage", with: { _obj: "calculation", to: { _ref: [{ _ref: "channel", _enum: "channel", _value: "RGB" }, { _ref: "layer", _name: "Background" }] }, calculation: { _enum: "calculationType", _value: "multiply" }, opacity: { _unit: "percentUnit", _value: 20 } } }],
  minimum: [{ _obj: "minimum", radius: PX(1) }],
  maximum: [{ _obj: "maximum", radius: PX(1) }],
  displace: null,
  curves: [{ _obj: "curves", presetKind: { _enum: "presetKindType", _value: "presetKindCustom" }, adjustment: [{ _obj: "curvesAdjustment", channel: { _ref: "channel", _enum: "channel", _value: "composite" }, curve: [{ _obj: "paint", horizontal: 0, vertical: 0 }, { _obj: "paint", horizontal: 128, vertical: 140 }, { _obj: "paint", horizontal: 255, vertical: 255 }] }] }],
  levels: [{ _obj: "levels", presetKind: { _enum: "presetKindType", _value: "presetKindCustom" }, adjustment: [{ _obj: "levelsAdjustment", channel: { _ref: "channel", _enum: "channel", _value: "composite" }, gamma: 1.1 }] }],
  hueSaturation: [{ _obj: "hueSaturation", presetKind: { _enum: "presetKindType", _value: "presetKindCustom" }, colorize: false, adjustment: [{ _obj: "hueSatAdjustmentV2", hue: 5, saturation: 5, lightness: 0 }] }],
  colorBalance: [{ _obj: "colorBalance", midtoneLevels: [5, 0, -5], preserveLuminosity: true }],
  channelMixer: [{ _obj: "channelMixer", presetKind: { _enum: "presetKindType", _value: "presetKindCustom" }, red: { _obj: "channelMatrix", red: { _unit: "percentUnit", _value: 100 } }, monochromatic: false }],
  invert: [{ _obj: "invert" }],
  desaturate: [{ _obj: "desaturate" }],
  equalize: [{ _obj: "equalize" }],
  gaussianBlur: [{ _obj: "gaussianBlur", radius: PX(1.5) }],
  highPass: [{ _obj: "highPass", radius: PX(4) }],
  median: [{ _obj: "median", radius: PX(1) }],
  addNoise: [{ _obj: "addNoise", distort: { _enum: "distort", _value: "uniformDistribution" }, noise: { _unit: "percentUnit", _value: 2 }, monochromatic: true, $FlRs: 1 }],
  unsharpMask: [{ _obj: "unsharpMask", amount: { _unit: "percentUnit", _value: 50 }, radius: PX(1), threshold: 0 }],
  smartSharpen: [{ _obj: "smartSharpen", amount: { _unit: "percentUnit", _value: 50 }, radius: PX(1), noiseReduction: { _unit: "percentUnit", _value: 0 } }],
  offset: [{ _obj: "offset", horizontal: 4, vertical: 4, fill: { _enum: "fillMode", _value: "wrap" } }]
};
// addNoise as Photoshop records it carries a $ key, which the list refuses:
// the case without it is what agents send.
EVENT_CASES.addNoise = [{ _obj: "addNoise", distort: { _enum: "distort", _value: "uniformDistribution" }, noise: { _unit: "percentUnit", _value: 2 }, monochromatic: true }];
EVENT_CASES.fill[0].color = { _obj: "RGBColor", red: 20, grain: 120, blue: 200 };

const REFUSED_LIVE = [
  ["save", [{ _obj: "save", as: { _obj: "photoshop35Format" }, in: { _path: "/tmp/m6.psd" } }]],
  ["close", [{ _obj: "close", saving: { _enum: "yesNo", _value: "no" } }]],
  ["make of a document", [{ _obj: "make", new: { _obj: "document", width: PX(64), height: PX(64) } }]],
  ["select of a document", [{ _obj: "select", _target: [{ _ref: "document", _offset: 1 }] }]],
  ["a History state", [{ _obj: "select", _target: [{ _ref: "historyState", _offset: -1 }] }]],
  ["a dialog", [{ _obj: "gaussianBlur", radius: PX(2), _options: { dialogOptions: "display" } }]],
  ["$Dcmn", [{ _obj: "get", _target: [{ _ref: "$Dcmn", _index: 1 }] }]],
  ["a play", [{ _obj: "play", _target: [{ _ref: "action", _name: "Vignette (selection)" }, { _ref: "actionSet", _name: "Default Actions" }] }]],
  ["syntheticFill", [{ _obj: "syntheticFill", _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }], prompt: "x" }]],
  ["paste", [{ _obj: "paste" }]],
  ["a temp path", [{ _obj: "placedLayerReplaceContents", null: { _path: "captures/../jobs/x.json" } }]]
];

// SPEC 12.1 "allow-list, target active", live: A is the target and in
// front, B is the other document. [label, descriptors, runs (else refused)].
function targetActive(a, b, layerB) {
  const docRef = (form) => ({ _ref: "document", ...form });
  const getDoc = (form) => [{ _obj: "get", _target: [{ _property: "title" }, docRef(form)] }];
  const applyFrom = (el) => [{ _obj: "applyImage", with: { _obj: "calculation", to: { _ref: [{ _ref: "channel", _enum: "channel", _value: "RGB" }, el] }, opacity: { _unit: "percentUnit", _value: 1 } } }];
  const rows = [];
  for (const [name, form] of [["_index", { _index: 2 }], ["_name", { _name: "Scenario M6 measure B" }], ["_offset", { _offset: 1 }], ["another _id", { _id: b }], ["first", { _enum: "ordinal", _value: "first" }], ["last", { _enum: "ordinal", _value: "last" }], ["front", { _enum: "ordinal", _value: "front" }]]) {
    rows.push([`document by ${name} in get`, getDoc(form)]);
    rows.push([`document by ${name} in Apply Image's source`, applyFrom(docRef(form))]);
    rows.push([`document by ${name} as _target`, [{ _obj: "hide", _target: [{ _ref: "layer", _index: 1 }, docRef(form)] }]]);
    rows.push([`document by ${name} under null`, [{ _obj: "hide", null: [{ _ref: "layer", _index: 1 }, docRef(form)] }]]);
  }
  rows.push(["document _id with a lone _enum", getDoc({ _id: a, _enum: "ordinal" })]);
  rows.push(["a layer _id only in B", [{ _obj: "hide", _target: [{ _ref: "layer", _id: layerB }] }]]);
  rows.push(["class form {_ref: document}", [{ _obj: "get", _target: [{ _property: "title" }, { _ref: "document" }] }]]);
  rows.push(["class form outside make", [{ _obj: "hide", _target: [{ _ref: "layer" }] }]]);
  rows.push(["duplicate of a layer to B", [{ _obj: "duplicate", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: docRef({ _id: b }) }]]);
  rows.push(["Load Selection from B's channel", [{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _ref: [{ _ref: "channel", _enum: "channel", _value: "transparencyEnum" }, { _ref: "layer", _id: layerB }, docRef({ _id: b })] } }]]);
  rows.push(["$Dcmn in select", [{ _obj: "select", _target: [{ _ref: "$Dcmn", _offset: 1 }] }]]);
  rows.push(["$Dcmn in Apply Image's source", applyFrom({ _ref: "$Dcmn", _id: b })]);
  rows.push(["$capp", [{ _obj: "get", _target: [{ _ref: "$capp", _enum: "ordinal", _value: "targetEnum" }] }]]);
  rows.push(["$HstS", [{ _obj: "select", _target: [{ _ref: "$HstS", _offset: -1 }] }]]);
  rows.push(["$SnpS", [{ _obj: "select", _target: [{ _ref: "$SnpS", _index: 1 }] }]]);
  rows.push(["two form keys", [{ _obj: "hide", _target: [{ _ref: "layer", _index: 1, _name: "m6 top A" }] }]]);
  rows.push(["an unlisted class", [{ _obj: "get", _target: [{ _ref: "brush", _index: 1 }] }]]);
  rows.push(["a chain of _property only", [{ _obj: "get", _target: [{ _property: "name" }] }]]);
  rows.push(["an application element", [{ _obj: "get", _target: [{ _property: "name" }, { _ref: "application", _enum: "ordinal", _value: "targetEnum" }] }]]);
  rows.push(["accepted: the target's _id", getDoc({ _id: a }), true]);
  rows.push(["accepted: the ordinal with _value", getDoc({ _enum: "ordinal", _value: "targetEnum" }), true]);
  rows.push(["accepted: the ordinal without _value", getDoc({ _enum: "ordinal" }), true]);
  rows.push(["accepted: {_ref: adjustmentLayer} in make", [{ _obj: "make", _target: [{ _ref: "adjustmentLayer" }], using: { _obj: "adjustmentLayer", type: { _obj: "invert" } } }], true]);
  rows.push(["accepted: the selection reference", [{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _obj: "rectangle", top: PX(10), left: PX(10), bottom: PX(50), right: PX(50) } }], true]);
  rows.push(["accepted: the target under null", [{ _obj: "show", null: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }, docRef({ _id: a })] }], true]);
  return rows;
}

let partial = null; // what a phase recorded so far, kept when it stops

async function measure() {
  const out = (partial = { phase: "measure", started_at: new Date().toISOString(), steps: {} });
  fixture(path.join(DATA, "dev-live", "m6-fixture.png"), 512, 384);
  const docA = { width: 512, height: 384, fixture: "dev-live/m6-fixture.png", flatten: true };
  const r1 = await agent("m6-measure-1", [
    { do: "switches", set: { agents_may_modify: true, agents_may_run_commands: true, active_document_only: false } },
    { do: "open", document: docA, name: "Scenario M6 measure A", layers: ["m6 lower A", "m6 top A"] },
    { do: "open", document: { width: 256, height: 256 }, name: "Scenario M6 measure B", layers: ["m6 top B"] },
    { do: "probe", what: "chain" },
    { do: "front", index: 0 },
    { do: "probe", what: "select_history", index: 0 },
    { do: "probe", what: "subject_pref" },
    { do: "call", tool: "set_selection", args: { document_id: "$doc0", none: true } },
    { do: "inspect", index: 0 },
    { do: "call", tool: "set_selection", args: { document_id: "$doc0", subject: { sample_all_layers: true } }, label: "Select Subject" },
    { do: "call", tool: "document_summary", args: { document_id: "$doc0", layer_limit: 10 } },
    { do: "inspect", index: 0 }
  ], 180000);
  out.steps.measure = r1;
  log(`measure: ${r1.steps.map((s) => `${s.do}${s.tool ? ":" + s.tool : ""}=${s.error ? "ERR " + s.error : "ok"}`).join(", ")}`);
  // Target not active: B in front, every call on A refused before running.
  const notActive = [
    [{ _obj: "invert" }],
    [{ _obj: "hide", _target: [{ _ref: "layer", _index: 1 }] }],
    [{ _obj: "get", _target: [{ _property: "title" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }] }]
  ];
  const r2 = await agent("m6-measure-2", [
    { do: "front", index: 1 },
    { do: "inspect", index: 0 },
    ...notActive.map((d) => ({ do: "call", tool: "execute_batchplay", args: { document_id: "$doc0", descriptors: d }, expect_error: "DocumentNotActive" })),
    { do: "call", tool: "set_selection", args: { document_id: "$doc0", rect: [0, 0, 10, 10] }, expect_error: "DocumentNotActive" },
    { do: "inspect", index: 0 },
    { do: "front", index: 0 }
  ]);
  out.steps.not_active = r2;
  log(`not active: ${r2.steps.map((s) => (s.expected ? "refused as expected" : s.error ? "ERR " + s.error : "ok")).join(", ")}`);
  // Each listed event once (on A, in front), then the refusals.
  // Each case starts on a pixel layer of its own ("m6 pixels", a copy of
  // the Background): a new layer is empty, and a transform or a filter on
  // an empty layer is an error (the first run met it as a modal alert).
  const events = [];
  // A fresh, visible pixel layer per case: earlier cases hide, merge or
  // rename layers.
  const onPixels = { _obj: "duplicate", _target: [{ _ref: "layer", _name: "Background" }] };
  for (const [ev, descs] of Object.entries(EVENT_CASES)) {
    if (!descs) continue;
    events.push({ do: "call", tool: "execute_batchplay", args: { document_id: "$doc0", descriptors: [...(["make", "mergeVisible", "get"].includes(ev) ? [] : [onPixels]), ...(["expand", "contract", "feather", "smoothness", "intersectWith", "subtractFrom", "inverse", "crop", "fill"].includes(ev) ? [{ _obj: "set", _target: SEL, to: { _obj: "rectangle", top: PX(60), left: PX(60), bottom: PX(300), right: PX(380) } }] : []), ...descs], label: "m6 " + ev }, label: ev, max_chars: 600 });
  }
  const r3 = await agent("m6-measure-3", [{ do: "front", index: 0 }, ...events, { do: "inspect", index: 0 }], 300000);
  out.steps.events = r3;
  const evRows = r3.steps.filter((s) => s.do === "call").map((s) => ({ event: s.label, outcome: s.error ? "error: " + s.error : s.out.result.outcome || ((/"outcome":"(\w+)"/.exec(s.out.result.head || "") || [])[1]), history: s.out ? s.out.result.history_state : null, detail: s.out && s.out.result.error ? s.out.result.error : null }));
  out.events = evRows;
  log(`events: ${evRows.filter((r) => r.outcome === "committed").length} committed of ${evRows.length}; not committed: ${evRows.filter((r) => r.outcome !== "committed").map((r) => r.event).join(", ") || "none"}`);
  // The target-active rows of SPEC 12.1, with B's real ids, A in front.
  const docAId = r1.steps[1].out.document_id;
  const docBId = r1.steps[2].out.document_id;
  const layerB = r1.steps[2].out.layers[0].id;
  const cases = [...REFUSED_LIVE, ...targetActive(docAId, docBId, layerB)];
  const r4 = await agent("m6-measure-4", [
    { do: "front", index: 1 },
    { do: "inspect", index: 1 },
    { do: "front", index: 0 },
    { do: "inspect", index: 0 },
    ...cases.map(([label, d, ok]) => ({ do: "call", tool: "execute_batchplay", args: { document_id: "$doc0", descriptors: d, label: "m6 " + label }, label, expect_error: ok ? null : "CommandRefused", max_chars: 400 })),
    { do: "inspect", index: 0 },
    { do: "front", index: 1 },
    { do: "inspect", index: 1 },
    { do: "front", index: 0 },
    { do: "activity" }
  ], 240000);
  out.steps.refused = r4;
  out.cases = r4.steps.filter((s) => s.do === "call").map((s) => ({ case: s.label, expected: s.expect_error ? "refused" : "runs", outcome: s.error ? s.error.split(":")[0] : s.out && s.out.result ? s.out.result.outcome || "ran" : "ran", ok: s.expect_error ? !!s.expected : !s.error }));
  const ins = r4.steps.filter((s) => s.do === "inspect");
  const h = (k) => (ins[k] && ins[k].out ? ins[k].out.history_detail : null);
  out.history_unchanged = { a: [h(1), h(2)], b: [h(0), h(3)], b_unchanged: JSON.stringify(h(0)) === JSON.stringify(h(3)) && !!h(0) };
  log(`cases: ${out.cases.filter((c) => c.ok).length} as expected of ${out.cases.length}; not as expected: ${out.cases.filter((c) => !c.ok).map((c) => c.case + "=" + c.outcome).join(", ") || "none"}; B History unchanged: ${out.history_unchanged.b_unchanged}`);
  const r5 = await agent("m6-measure-5", [{ do: "switches", set: { agents_may_modify: false } }, { do: "close" }]);
  out.steps.close = r5;
  out.finished_at = new Date().toISOString();
  return out;
}

// ---- session ----

// Built-in tools a restricted headless session still lists, all refused.
const BUILTINS = ["Task", "Agent", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit", "EnterWorktree", "ExitWorktree", "Glob", "Grep", "ListAgents", "NotebookEdit", "PublishPlugin", "PushNotification", "Read", "ReportFindings", "ScheduleWakeup", "SendMessage", "ShareOnboardingGuide", "Skill", "TaskStop", "ToolSearch", "WebSearch", "WebFetch", "Write", "Bash"];

const SESSION_TOOLS = [
  "scenario_status",
  "document_summary",
  "preview_document",
  "set_selection",
  "capture_reference",
  "upload_reference",
  "reference_upload_status",
  "model_schema",
  "estimate_cost",
  "generate",
  "job_status",
  "wait_for_job",
  "prepare_result_application",
  "apply_result_application",
  "list_local_jobs"
];

function declinePrompt(docId, stamp) {
  return [
    "You are checking the Scenario plugin for Photoshop through the scenario-photoshop tools. A test harness approves and declines the cards in the panel for the person; do not wait for a human in any other way.",
    `Work only on Photoshop document ${docId} (title "Scenario M6 decline"), which is in front. Use exactly these steps, one tool call at a time:`,
    "0. scenario_status. If it does not report the plugin as linked, call it again, up to 5 times, until it does.",
    `1. set_selection on document ${docId} with ellipse [150, 170, 132, 132].`,
    `2. capture_reference with document_id ${docId}, purpose "edit", source "selection", model_id "${FLARE}".`,
    "3. upload_reference with that capture_id, then poll reference_upload_status for each reference_id every few seconds until every part is imported (stop after 5 minutes).",
    `4. estimate_cost with model_id "${FLARE}", lane "edit", the capture_id, parameters {"prompt": "a green cube instead of the red ball", "quality": "low"}, takes 1.`,
    `5. generate with lane "edit", the same model_id and parameters, the quote_id, approved_cost equal to cu_cost_exact exactly, idempotency_key "m6-exit-c-${stamp}". This request is expected to be declined.`,
    "6. wait_for_job with timeout 60 until the status is final, then job_status for that local_id. Report the final status, the error and cu_charged.",
    "Do not call any tool outside these steps."
  ].join("\n");
}

function prompt(docId, stamp) {
  return [
    "You are checking the Scenario plugin for Photoshop through the scenario-photoshop tools. A test harness approves and declines the cards in the panel for the person; do not wait for a human in any other way.",
    `Work only on Photoshop document ${docId} (title "Scenario M6 session"), which is in front. Use exactly these steps, one tool call at a time:`,
    "1. scenario_status, then document_summary for that document.",
    `2. set_selection on document ${docId} with ellipse [150, 170, 132, 132] (the red ball).`,
    `3. capture_reference with document_id ${docId}, purpose "edit", source "selection", model_id "${FLARE}".`,
    "4. upload_reference with that capture_id. It waits for the person's upload card: poll reference_upload_status for each reference_id every few seconds until every part is imported (stop after 5 minutes).",
    `5. estimate_cost with model_id "${FLARE}", lane "edit", the capture_id, parameters {"prompt": "a blue glass sphere instead of the red ball, same light", "quality": "low"}, takes 1. Say the price and its kind.`,
    `6. generate with lane "edit", the same model_id and parameters, the quote_id, approved_cost equal to cu_cost_exact exactly, idempotency_key "m6-exit-a-${stamp}". It waits for the person's approval card.`,
    "7. wait_for_job with timeout 170 until the status is ready (call again if still_running).",
    `8. prepare_result_application with that local_id, its revision as expected_revision, purpose "edit_selection", then apply_result_application with the application_id. Report outcome, layer_ids and history_state.`,
    `9. estimate_cost again with the same capture_id and parameters {"prompt": "a green cube instead of the red ball", "quality": "low"}, takes 1, then generate with idempotency_key "m6-exit-b-${stamp}". Then wait_for_job with timeout 170 and report the final status and error: this request is expected to be declined, which spends nothing.`,
    "10. End with a short summary: each local_id, its final status, the CU quoted, and the History state name. Do not call any tool outside these steps."
  ].join("\n");
}

async function session(decline) {
  const P = decline ? "m6-decline" : "m6-session";
  const out = (partial = { phase: "session", started_at: new Date().toISOString() });
  const stamp = Date.now().toString(36);
  const work = path.join(OUT, "session-config");
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  const mcpConfig = path.join(work, "mcp.json");
  // 1. A fresh pairing token, held only in this process: to the plugin
  // through dev-pairing-token (adopted at the reload), to the helper
  // through the setup command's stdin.
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenPath = path.join(DATA, "dev-pairing-token");
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  const setup = spawnSync(process.execPath, [path.join(REPO, "helper", "bin", "scenario-photoshop.js"), "setup", "claude-code", "--local", "--config", mcpConfig, "--token-stdin"], { input: token, encoding: "utf8", env: { ...process.env, SCENARIO_PHOTOSHOP_TOKEN: "" } });
  out.setup = { status: setup.status, stdout: setup.stdout.trim().split("\n"), stderr: setup.stderr.trim() };
  if (setup.status !== 0) throw new Error("setup failed: " + setup.stderr.trim());
  const tokenFile = path.join(os.homedir(), ".config", "scenario-photoshop", "token");
  const st = fs.statSync(tokenFile);
  const dirSt = fs.statSync(path.dirname(tokenFile));
  const cfgText = fs.readFileSync(mcpConfig, "utf8");
  out.token_file = { mode: (st.mode & 0o777).toString(8), dir_mode: (dirSt.mode & 0o777).toString(8), config_mode: (fs.statSync(mcpConfig).mode & 0o777).toString(8), config_holds_token: cfgText.includes(token) || /SCENARIO_PHOTOSHOP_TOKEN/.test(cfgText), config_servers: Object.keys(JSON.parse(cfgText).mcpServers) };
  log(`setup: token file mode ${out.token_file.mode} (folder ${out.token_file.dir_mode}), config mode ${out.token_file.config_mode}, token in config: ${out.token_file.config_holds_token}`);
  await uiSend({ cmd: "reload" });
  await sleep(1500);
  await waitPing("the token reload");
  if (fs.existsSync(tokenPath)) throw new Error("the plugin did not adopt dev-pairing-token");
  // 2. The document, the switches.
  fixture(path.join(DATA, "dev-live", "m6-fixture.png"), 512, 384);
  const r1 = await agent(`${P}-1`, [
    { do: "switches", set: { agents_may_modify: true, agents_may_run_commands: false, active_document_only: true }, no_spend: false },
    { do: "open", document: { width: 512, height: 384, fixture: "dev-live/m6-fixture.png", flatten: true }, name: decline ? "Scenario M6 decline" : "Scenario M6 session" },
    { do: "inspect" }
  ]);
  out.prepare = r1;
  const docId = r1.steps[1].out.document_id;
  log(`session document ${docId}`);
  // 3. The decisions, through the dev entry, while Claude Code runs.
  const decisions = decline
    ? [{ do: "decide", action: "approve", kind: "upload", wait_s: 600, label: "upload card" }, { do: "decide", action: "decline", kind: "spend", wait_s: 600, label: "spend card (declined)" }]
    : [{ do: "decide", action: "approve", kind: "upload", wait_s: 600, label: "upload card" }, { do: "decide", action: "approve", kind: "spend", wait_s: 600, label: "spend card 1" }, { do: "decide", action: "decline", kind: "spend", wait_s: 900, label: "spend card 2" }];
  fs.writeFileSync(path.join(DATA, "dev-live-run.json"), JSON.stringify({ id: `${P}-2`, agent: { steps: decisions } }));
  const allowed = SESSION_TOOLS.map((t) => `mcp__scenario-photoshop__${t}`);
  const transcript = path.join(OUT, decline ? "claude-decline.jsonl" : "claude-session.jsonl");
  const claudeArgs = ["-p", decline ? declinePrompt(docId, stamp) : prompt(docId, stamp), "--mcp-config", mcpConfig, "--restricted", "--strict-mcp-config", "--allowedTools", allowed.join(","), "--disallowedTools", BUILTINS.join(","), "--output-format", "stream-json", "--verbose", "--max-turns", "60"];
  out.claude = { args: claudeArgs.filter((a, i) => i !== 1).join(" ").slice(0, 2000), allowed_tools: SESSION_TOOLS };
  log("claude -p starts");
  const env = { ...process.env };
  delete env.SCENARIO_PHOTOSHOP_TOKEN;
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const c = spawn("claude", claudeArgs, { cwd: arg("--cwd", os.tmpdir()), env, stdio: ["ignore", fs.openSync(transcript, "w"), fs.openSync(path.join(OUT, decline ? "claude-decline.stderr.txt" : "claude-session.stderr.txt"), "w")] });
    const kill = setTimeout(() => c.kill("SIGTERM"), 25 * 60 * 1000);
    const watch = setInterval(() => {
      const t = alertText();
      if (t) {
        blocked = t;
        c.kill("SIGTERM");
      }
    }, 10000);
    c.on("exit", (n) => {
      clearTimeout(kill);
      clearInterval(watch);
      resolve(n);
    });
  });
  out.claude.exit = code;
  if (blocked) throw new Error("BLOCKED: " + blocked);
  out.claude.seconds = Math.round((Date.now() - t0) / 1000);
  const lines = fs.readFileSync(transcript, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const final = lines.filter((l) => l.type === "result").pop();
  fs.writeFileSync(path.join(OUT, decline ? "claude-decline.txt" : "claude-session.txt"), (final && final.result) || "(no result line)");
  out.claude.tool_calls = lines.filter((l) => l.type === "assistant").flatMap((l) => (l.message.content || []).filter((c) => c.type === "tool_use").map((c) => c.name.replace("mcp__scenario-photoshop__", "")));
  log(`claude -p exit ${code} after ${out.claude.seconds} s; ${out.claude.tool_calls.length} tool calls`);
  // 4. The decisions' outcome, the document, then close.
  const dir = path.join(DATA, "dev-live", `${P}-2`);
  let decided = null;
  for (let i = 0; i < 120 && !decided; i++) {
    try {
      decided = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
    } catch (e) {
      await sleep(1000);
    }
  }
  out.decisions = decided;
  const r3 = await agent(`${P}-3`, [{ do: "inspect" }, { do: "call", tool: "list_local_jobs", args: { filter: "agents", limit: 5 }, session: "m6-check", client_name: "m6 check" }, { do: "activity" }]);
  out.after = r3;
  const r4 = await agent(`${P}-4`, [{ do: "switches", set: { agents_may_modify: false, active_document_only: false } }, { do: "close" }]);
  out.close = r4;
  out.finished_at = new Date().toISOString();
  return out;
}

// Extras of SPEC 12.2 item 11 the dev entry can run, free: a proposal card
// (modify off) answered through the approvals module, and No-spend.
async function extras() {
  const out = (partial = { phase: "extras", started_at: new Date().toISOString() });
  const job = arg("--job");
  const steps = [
    { do: "switches", set: { agents_may_modify: false, agents_may_run_commands: false, active_document_only: false }, no_spend: false },
    { do: "open", document: { width: 512, height: 384 }, name: "Scenario M6 extras" },
    { do: "call", tool: "job_status", args: { local_id: job }, label: "job", max_chars: 1500 }
  ];
  const r0 = await agent("m6-extras-0", steps);
  const jr = r0.steps[2].out ? r0.steps[2].out.result : {};
  const rev = jr.revision !== undefined ? jr.revision : Number((/"revision":(\d+)/.exec(jr.head || "") || [])[1]);
  out.job = { status: jr.status || (/"status":"(\w+)"/.exec(jr.head || "") || [])[1], revision: rev };
  const r1 = await agent("m6-extras-1", [
    { do: "call", tool: "prepare_result_application", args: { local_id: job, expected_revision: rev, purpose: "new_layer", target: { document_id: r0.steps[1].out.document_id } }, label: "prepare", max_chars: 1500 },
    { do: "inspect" }
  ]);
  const app = r1.steps[0].out ? r1.steps[0].out.result.application_id : null;
  const r2 = await agent("m6-extras-2", [
    { do: "call", tool: "apply_result_application", args: { application_id: app }, label: "apply with modify off", max_chars: 1500 },
    { do: "cards" },
    { do: "decide", action: "approve", kind: "proposal", wait_s: 30, label: "proposal card" },
    { do: "inspect" },
    { do: "switches", set: {}, no_spend: true },
    { do: "call", tool: "estimate_cost", args: { model_id: FLARE, lane: "image", parameters: { prompt: "a red ball", quality: "low" }, takes: 1 }, label: "quote", max_chars: 1500 }
  ]);
  const q = r2.steps[5].out ? r2.steps[5].out.result : {};
  const r3 = await agent("m6-extras-3", [
    { do: "call", tool: "generate", args: { lane: "image", model_id: FLARE, quote_id: q.quote_id, approved_cost: q.cu_cost_exact, parameters: { prompt: "a red ball", quality: "low" } }, label: "generate under No-spend", expect_error: "NoSpend" },
    { do: "cards" },
    { do: "switches", set: {}, no_spend: false },
    { do: "activity" },
    { do: "close" }
  ]);
  Object.assign(out, { r0, r1, r2, r3 });
  log(`extras: apply=${JSON.stringify(r2.steps[0].out || r2.steps[0].error).slice(0, 200)}; proposal=${JSON.stringify(r2.steps[2].out || r2.steps[2].error).slice(0, 200)}; after=${r2.steps[3].out ? r2.steps[3].out.history : "?"}; no-spend=${r3.steps[0].expected ? "refused" : JSON.stringify(r3.steps[0].out || r3.steps[0].error).slice(0, 200)}; cards after=${JSON.stringify(r3.steps[1].out)}`);
  return out;
}

async function main() {
  if (!["measure", "session", "decline", "extras"].includes(PHASE)) throw new Error("--phase measure|session|decline|extras");
  fs.mkdirSync(OUT, { recursive: true });
  const gb = freeGb();
  if (gb < 8) throw new Error(`only ${gb.toFixed(1)} GB free; live work stops under 8 GB`);
  if (spawnSync("pgrep", ["-x", "Adobe Photoshop 2026"]).status !== 0) throw new Error("Photoshop is not running");
  takeLock();
  const dest = installedFolder();
  const keep = path.join(os.tmpdir(), `scenario-m6-installed-${Date.now()}`); // outside the evidence folder
  let result = null;
  try {
    log(`${PHASE}: ${gb.toFixed(1)} GB free; installed ${path.basename(dest)}`);
    await waitPing("the start");
    await pushOwn(dest, keep);
    result = PHASE === "measure" ? await measure() : PHASE === "extras" ? await extras() : await session(PHASE === "decline");
  } catch (e) {
    log(`${PHASE} stopped: ${e.message}`);
    result = { ...(partial || {}), error: e.message };
    process.exitCode = 1;
    if (!blocked) {
      try {
        await agent("m6-cleanup-" + Date.now().toString(36), [{ do: "switches", set: { agents_may_modify: false, agents_may_run_commands: false, active_document_only: false } }, { do: "close" }], 60000);
        log("closed the documents this run opened");
      } catch (e2) {
        log(`cleanup did not answer: ${e2.message}`);
      }
    }
  } finally {
    await restore(dest, keep);
    releaseLock();
    fs.writeFileSync(path.join(OUT, `m6-${PHASE}.json`), JSON.stringify(result, null, 1));
    log(`${PHASE}: wrote m6-${PHASE}.json; lock released`);
  }
}

main().catch((e) => {
  console.error(e.message);
  releaseLock();
  process.exitCode = 1;
});
