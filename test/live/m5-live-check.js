#!/usr/bin/env node
"use strict";
// M5 live check: restart recovery (SPEC 12.2 item 9) against a live
// Photoshop and the live Scenario API. Photoshop quits at each of the six
// points of item 9 and starts again; each job must come back in the state
// SPEC 6.4 gives it, without a second charge, and its paid result must land
// in its own document once that document is open again. Not part of
// `npm test`. Run it by hand with a development build installed (see
// AGENTS.md) and the panel signed in. It SPENDS Scenario credits: one job
// per case at the cheapest settings (four cases reach a paid call).
//
// Per case:
// 1. Checks that Photoshop has no document open (it never quits Photoshop
//    over a document it did not make) and writes a `restart` request. The
//    development build's live entry (plugin/src/dev/live-run.js) makes its
//    own document, saves it in the plugin's data folder, arms the test hook
//    of that point, generates, and once the point is reached closes its
//    document and writes result.json.
// 2. Quits Photoshop (AppleScript `quit`), waits for it to exit, reads the
//    job record on disk, and starts Photoshop again in the background
//    (`open -g`), without bringing it to the front.
// 3. Waits for the plugin to start, reads the record recovery left, then
//    writes a `check` request: the live entry resolves an Unknown job,
//    waits for the result, tries Place while the document is closed,
//    reopens the saved document and places, then closes it.
// 4. Writes `m5-live-check.log` (versions, then per case the states before
//    the quit, on disk, after recovery, and each step) and, with
//    --spend-log, one line per case there.
//
// This script never talks to Scenario itself and never reads or prints a
// key. macOS only (AppleScript and `open`).
//
// Usage: node test/live/m5-live-check.js --out <dir> [--cases a,b]
//        [--app "Adobe Photoshop 2026"] [--ps-major 27] [--spend-log <file>]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const png = require("../../plugin/src/util/png.js");
const manifest = require("../../plugin/manifest.json");

const W = 768;
const H = 512;
const DOC = { width: W, height: H, fixture: "dev-live/fixture.png", flatten: true };
const BALL = { left: 236, top: 276, width: 120, height: 120, shape: "ellipse", feather: 2 };
const CUTOUT = { tool: "remove_background" };
const EDIT = { tool: "edit", prompt: "a blue glass sphere instead of the red ball, same light", takes: 1 };

const CASES = [
  { id: "restart-upload", point: "upload", label: "Quit during upload (Remove BG, 851 Labs)", run: CUTOUT, max_cu: 3, expect: "not_sent", from: ["uploading_inputs"] },
  { id: "restart-submitting", point: "paid_answer", label: "Quit while submitting: the paid answer is held (Remove BG, 851 Labs)", run: CUTOUT, max_cu: 3, expect: "applied", from: ["submitting"] },
  { id: "restart-approval", point: "price_after_upload", add: 1000, label: "Quit while awaiting approval: a price change after upload (Remove BG, 851 Labs)", run: CUTOUT, max_cu: 3, expect: "not_sent", from: ["awaiting_approval"] },
  { id: "restart-generating", point: "poll", label: "Quit while generating (Edit, GPT Image 2.5 Flare, quality low)", selection: BALL, run: EDIT, max_cu: 5, expect: "applied", from: ["queued", "generating"] },
  { id: "restart-downloading", point: "download_part", label: "Quit while downloading: a .part file is on disk (Remove BG, 851 Labs)", run: CUTOUT, max_cu: 3, expect: "applied", from: ["succeeded", "downloading"] },
  { id: "restart-placing", point: "place", label: "Quit while placing: the record reads applying (Edit, GPT Image 2.5 Flare, quality low)", selection: BALL, run: EDIT, max_cu: 5, expect: "applied", from: ["applying"] }
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function pluginDataDir(major) {
  return path.join(os.homedir(), "Library", "Application Support", "Adobe", "UXP", "PluginsStorage", "PHSP", major, "External", manifest.id, "PluginData");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The M4 fixture: sky, sun, hills, a tree and a red ball on a meadow.
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
  return (r.stdout || "").trim() + (d.stdout && d.stdout.trim() ? " plus uncommitted changes" : "");
}

function macVersion() {
  const r = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" });
  return `macOS ${(r.stdout || "").trim()}`;
}

function running(app) {
  return spawnSync("pgrep", ["-x", app]).status === 0;
}

// Open documents, asked only while Photoshop runs (AppleScript would start
// it otherwise). null when it cannot be read.
function openDocuments(app) {
  if (!running(app)) return 0;
  const r = spawnSync("osascript", ["-e", `tell application "${app}" to count documents`], { encoding: "utf8", timeout: 60000 });
  const n = Number((r.stdout || "").trim());
  return r.status === 0 && Number.isFinite(n) ? n : null;
}

async function quit(app) {
  spawnSync("osascript", ["-e", `tell application "${app}" to quit`], { encoding: "utf8", timeout: 120000 });
  const t0 = Date.now();
  while (running(app)) {
    if (Date.now() - t0 > 180000) throw new Error("Photoshop did not quit within 3 minutes");
    await sleep(1000);
  }
  // Let the system release the plugin's files.
  await sleep(3000);
}

function readLog(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, "scenario-link.log"), "utf8");
  } catch {
    return "";
  }
}

// Starts Photoshop in the background and waits for this build to start and
// read its job records.
async function relaunch(app, dataDir) {
  const since = Date.now();
  const r = spawnSync("open", ["-g", "-a", app], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`open failed: ${r.stderr}`);
  const want = `plugin ${manifest.version} (dev) starting`;
  while (Date.now() - since < 6 * 60 * 1000) {
    const text = readLog(dataDir);
    const lines = text.split("\n").filter((l) => {
      const t = Date.parse(l.slice(0, 24));
      return Number.isFinite(t) && t >= since - 1000;
    });
    if (lines.some((l) => l.includes(want)) && lines.some((l) => / record\(s\) read/.test(l))) {
      await sleep(4000);
      return { seconds: Math.round((Date.now() - since) / 1000), lines: readLog(dataDir).split("\n").filter((l) => Date.parse(l.slice(0, 24)) >= since - 1000) };
    }
    await sleep(2000);
  }
  throw new Error("the plugin did not start within 6 minutes of the relaunch");
}

function record(dataDir, localId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "jobs", `${localId}.json`), "utf8"));
  } catch {
    return null;
  }
}

function brief(rec) {
  if (!rec) return "no record";
  return `${rec.state}${rec.recovered_from ? ` (recovered from ${rec.recovered_from})` : ""}${rec.job_id ? `, job ${rec.job_id}` : ""}${rec.error ? `, "${rec.error}"` : ""}`;
}

async function request(dataDir, id, req, minutes) {
  const resultFile = path.join(dataDir, "dev-live", id, "result.json");
  if (fs.existsSync(resultFile)) fs.renameSync(resultFile, `${resultFile}.${Date.now()}.old`);
  fs.writeFileSync(path.join(dataDir, "dev-live-run.json"), JSON.stringify({ id, ...req }));
  const t0 = Date.now();
  while (!fs.existsSync(resultFile)) {
    if (Date.now() - t0 > minutes * 60 * 1000) throw new Error(`${id}: no result after ${minutes} minutes`);
    await sleep(2000);
  }
  await sleep(500);
  return JSON.parse(fs.readFileSync(resultFile, "utf8"));
}

function stepOf(r, name) {
  return ((r && r.steps) || []).find((s) => s.step === name) || null;
}

// The case's verdict and the reasons it failed.
function verdict(c, held, onDisk, recovered, checked, partSeen, partAfter) {
  const why = [];
  if (!held || !held.ok) why.push(`not held: ${held ? held.error : "no result"}`);
  if (!checked || !checked.ok) why.push(`check: ${checked ? checked.error || checked.state : "no result"}`);
  const after = stepOf(checked, "after_restart");
  const rec = after ? after.record : null;
  if (!recovered || !c.from.includes(recovered.recovered_from)) why.push(`recovered_from ${recovered ? recovered.recovered_from : "none"}, expected ${c.from.join(" or ")}`);
  if (c.expect === "not_sent") {
    if (!rec || rec.state !== "not_sent" || rec.error !== "Not sent: Interrupted by a restart." || rec.cu_charged !== "0") why.push(`after restart: ${rec ? `${rec.state}, ${rec.error}, charged ${rec.cu_charged}` : "none"}`);
  } else {
    const closed = stepOf(checked, "place_while_closed");
    if (!closed || closed.placed !== false || !/^DocumentClosed:/.test(closed.error || "")) why.push("Place with the document closed was not held");
    const reopened = stepOf(checked, "reopened");
    if (!reopened || reopened.state !== "ready") why.push(`something landed by itself after the reopen (${reopened ? reopened.state : "no step"})`);
    const placed = stepOf(checked, "placed");
    if (!placed || !placed.in_reopened_document || placed.record.state !== "applied") why.push("not placed in the reopened document");
    if (placed && placed.record && placed.record.cu_charged !== null && held && held.quote && Number(placed.record.cu_charged) > Number(held.quote.cu)) why.push(`charged ${placed.record.cu_charged} for a quote of ${held.quote.cu}`);
    if (c.point === "paid_answer") {
      const res = stepOf(checked, "resolve");
      if (!res || res.candidates.filter((x) => x.exact).length !== 1) why.push("resolution did not find exactly one exact match");
    }
    if (c.point === "download_part") {
      if (!partSeen) why.push("no .part file on disk before the quit");
      if (partAfter) why.push("the .part file is still on disk after the download");
    }
    if (c.point === "place" && placed && placed.layers_with_job_metadata !== 1) why.push(`${placed.layers_with_job_metadata} layers carry the job's metadata (expected 1)`);
  }
  if (onDisk && held && held.before_quit && onDisk.state !== held.before_quit.state) why.push(`on disk after the quit: ${onDisk.state}, held at ${held.before_quit.state}`);
  return { pass: why.length === 0, why };
}

function describe(d) {
  const { c, held, onDisk, recovered, checked, boot, partSeen, partAfter } = d;
  const v = d.verdict;
  const lines = [`## ${c.label} [${c.id}]`, `verdict: ${v.pass ? "PASS" : "FAIL"}${v.why.length ? ` (${v.why.join("; ")})` : ""}`];
  if (d.error) lines.push(`stopped: ${d.error}`);
  if (held) {
    lines.push(`hook point: ${c.point}; quote ${held.quote ? held.quote.label : "none"}; model ${held.before_quit ? held.before_quit.model_name || held.before_quit.model_id : "none"}`);
    lines.push(`held at: ${held.before_quit ? brief(held.before_quit) : held.error}`);
    if (held.hook && held.hook.part) lines.push(`part file: ${held.hook.part} (${partSeen ? "on disk before the quit" : "NOT on disk"}; ${partAfter ? "STILL on disk after" : "gone after the download"})`);
  }
  lines.push(`on disk after the quit: ${brief(onDisk)}`);
  if (boot) {
    lines.push(`relaunch to plugin ready: ${boot.seconds} s`);
    for (const l of boot.lines.filter((x) => /starting|record\(s\) read|jobs: restart:|resum/.test(x))) lines.push(`  log: ${l}`);
  }
  lines.push(`on disk after recovery: ${brief(recovered)}`);
  for (const s of (checked && checked.steps) || []) {
    const parts = [];
    if (s.record) parts.push(brief(s.record));
    if (s.row) parts.push(`Jobs row: ${s.row.status}; "${s.row.detail}"; actions ${s.row.actions.join(", ")}`);
    if (s.candidates) parts.push(`check ${s.complete ? "complete" : "incomplete"}; ${s.candidates.length} candidate(s): ${s.candidates.map((x) => `${x.job_id} ${x.label}${x.exact ? " (exact)" : ""} ${x.status}`).join(", ") || "none"}; preselected ${s.selected || "none"}${s.note ? `; "${s.note}"` : ""}`);
    if (s.step === "place_while_closed") parts.push(s.placed ? "PLACED" : `held: ${s.error}`);
    if (s.step === "reopened") parts.push(`document reopened; state ${s.state}; found by ${s.where ? s.where.how : "none"}`);
    if (s.step === "placed") parts.push(`in the reopened document: ${s.in_reopened_document}; layers with the job's metadata: ${s.layers_with_job_metadata}; History: ${s.history_state}; charged ${s.record.cu_charged}`);
    lines.push(`step ${s.step}: ${parts.join(" | ")}`);
  }
  return lines.join("\n");
}

async function main() {
  if (process.platform !== "darwin") throw new Error("the M5 live check runs on macOS");
  const out = arg("--out", null);
  if (!out) throw new Error("--out <dir> is required");
  const app = arg("--app", "Adobe Photoshop 2026");
  const major = arg("--ps-major", "27");
  const only = arg("--cases", null);
  const spendLog = arg("--spend-log", null);
  const dataDir = pluginDataDir(major);
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "dev-live"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "dev-live", "fixture.png"), fixture());
  const cases = CASES.filter((c) => !only || only.split(",").includes(c.id));
  const started = new Date().toISOString();
  const done = [];
  let photoshop = null;
  for (const c of cases) {
    const d = { c, held: null, onDisk: null, recovered: null, checked: null, boot: null, partSeen: false, partAfter: false, error: null };
    done.push(d);
    try {
      if (!running(app)) throw new Error("Photoshop is not running");
      const n = openDocuments(app);
      if (n !== 0) throw new Error(`Photoshop has ${n === null ? "an unknown number of" : n} document(s) open; not quitting it`);
      console.log(`${c.id}: holding at ${c.point}`);
      d.held = await request(dataDir, c.id, { restart: { point: c.point, add: c.add }, document: DOC, selection: c.selection || null, run: c.run, max_cu: c.max_cu, timeout_s: 300 }, 8);
      photoshop = photoshop || d.held.photoshop || null;
      if (!d.held.ok) throw new Error(`not held: ${d.held.error}`);
      if (d.held.hook && d.held.hook.part) d.partSeen = fs.existsSync(path.join(dataDir, d.held.hook.part));
      const m = openDocuments(app);
      if (m !== 0) throw new Error(`Photoshop has ${m === null ? "an unknown number of" : m} document(s) open after the hold; not quitting it`);
      fs.writeFileSync(path.join(out, `${c.id}-before-quit.log`), readLog(dataDir));
      console.log(`${c.id}: held (${d.held.before_quit.state}); quitting Photoshop`);
      await quit(app);
      d.onDisk = record(dataDir, d.held.local_id);
      console.log(`${c.id}: on disk ${brief(d.onDisk)}; starting Photoshop`);
      d.boot = await relaunch(app, dataDir);
      d.recovered = record(dataDir, d.held.local_id);
      console.log(`${c.id}: recovered ${brief(d.recovered)}; checking`);
      d.checked = await request(dataDir, `${c.id}-check`, { check: { local_id: d.held.local_id, point: c.point, psd: d.held.psd }, timeout_s: 420 }, 10);
      if (d.held.hook && d.held.hook.part) d.partAfter = fs.existsSync(path.join(dataDir, d.held.hook.part));
      fs.writeFileSync(path.join(out, `${c.id}-after-restart.log`), readLog(dataDir));
      const after = d.checked.files && d.checked.files.after;
      if (after && fs.existsSync(path.join(dataDir, after))) fs.copyFileSync(path.join(dataDir, after), path.join(out, `${c.id}-after.png`));
    } catch (e) {
      d.error = e.message;
    }
    d.verdict = verdict(c, d.held, d.onDisk, d.recovered, d.checked, d.partSeen, d.partAfter);
    if (d.error) d.verdict = { pass: false, why: [d.error].concat(d.verdict.why) };
    console.log(`${c.id}: ${d.verdict.pass ? "PASS" : `FAIL (${d.verdict.why.join("; ")})`}`);
    if (spendLog && d.held && d.held.local_id) {
      const placed = stepOf(d.checked, "placed");
      const last = (placed && placed.record) || (stepOf(d.checked, "after_restart") || {}).record || d.held.before_quit || {};
      const paid = !(last.state === "not_sent" && last.cu_charged === "0");
      const settings = JSON.stringify(d.held.parameters || {}).replace(/"asset_[A-Za-z0-9]+"/g, '"<upload>"').replace(/\|/g, "/");
      const outs = (last.outputs || []).map((x) => x.asset_id).filter(Boolean);
      const line = `| ${new Date().toISOString().slice(0, 10)} | 3 (M5 live check, ${c.id}) | ${last.model_name || last.model_id || "unknown"} | plugin ${manifest.version} dev entry; ${settings} | ${paid ? (last.cu_charged !== null && last.cu_charged !== undefined ? last.cu_charged : d.held.quote ? d.held.quote.cu : "unknown") : "0"} | M5 exit, ${c.label}: ${paid ? "one paid job" : "no paid call (Not sent)"} (${d.verdict.pass ? "PASS" : "FAIL"}) | ${last.job_id || "no job"}${outs.length ? ` / ${outs.join(", ")}` : ""} (${last.state || "none"}) |\n`;
      fs.appendFileSync(spendLog, line);
    }
    if (d.error && /document\(s\) open|not running|did not quit|did not start/.test(d.error)) {
      console.log("stopping: the remaining cases need Photoshop with no document open");
      break;
    }
  }
  const header = [
    "# M5 live check: restart recovery (SPEC 12.2 item 9)",
    `date: ${started}`,
    `plugin: ${manifest.version} (${gitCommit(path.resolve(__dirname, "..", ".."))})`,
    `photoshop: ${photoshop || "unknown"}`,
    `os: ${macVersion()}`,
    `cases: ${done.length} of ${cases.length} run, ${done.filter((d) => d.verdict.pass).length} pass`,
    ""
  ];
  const text = header.concat(done.map((d) => describe(d) + "\n")).join("\n");
  fs.writeFileSync(path.join(out, "m5-live-check.log"), text);
  console.log(`log: ${path.join(out, "m5-live-check.log")}`);
  if (done.some((d) => !d.verdict.pass) || done.length < cases.length) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
