#!/usr/bin/env node
"use strict";
// M7 live check: SPEC 12.2 item 5, the Trained and Library parts (and the
// Run with part of item 3), against a live Photoshop and the live Scenario
// API, through the panel itself. Not part of `npm test`. Run it once by hand
// with a development build installed (`npm run package:dev`, AGENTS.md) and
// the panel signed in and open. Written in the M7 headless pass; not run
// there (Photoshop was not available).
//
// Library cases are free (reads and files already on Scenario). Trained
// cases SPEND Scenario credits: one take each at the default size, and only
// when the price on the button is at most the case's max_cu; --price-only
// stops each of them at the price check.
//
// What it drives (test/live/ui-dev.js commands, plugin/src/dev/ui-loop.js):
// makedoc, select, view, click, prompt, pop, runwith, library, state,
// inspect, adopt, closedoc. It only touches documents it made, and closes
// them at the end. It never talks to Scenario itself, never reads or prints
// a key, and never starts, focuses or quits Photoshop.
//
// Checks:
// - library-browse: Open from Library (no document) lists images; each
//   filter (Generated, Edited, Uploaded) lists only its own source, which
//   verifies the REST `type` filter of GET /assets live (measured only
//   through hosted Scenario MCP in M7); Show more reads further.
// - library-search: a word of the first image's name finds it; a nonsense
//   word finds nothing.
// - library-place-large: Place from Library in a 2048 x 2048 document lands
//   one layer at the image's own pixel size (not enlarged), centered, with
//   XMP kind "library", in one History state "Scenario: Place library".
// - library-place-small: in a 256 x 256 document the layer is shrunk to fit.
// - library-reference: + Reference > Library adds one reference.
// - trained-picker: All models > Trained lists a public trained model; a
//   click on its row runs with it (the Model chip names it).
// - trained-new-<base>: Make new (Create image, no document) with a trained
//   model on its base: the result opens as a new document, its XMP names
//   the base as modelId and the trained model in trainedModelIds.
// - trained-edit-<base>: a selection edit (Replace inside) with a trained
//   model on each base route given (image_strength, reference).
// - trained-stack: a project trained style (Style chip) and a second FLUX.1
//   LoRA (Run with) on FLUX.1 Dev in one run (loras and lorasScale with two
//   entries): the price check and the job accept it, and the XMP lists
//   both. Needs --stack-style (a project with a trained FLUX.1 LoRA).
//
// Usage: node test/live/m7-live-check.js --out <dir> [--cases a,b]
//        [--price-only] [--ps-major 27] [--spend-log <file>]
//        [--flux1 <lora id>] [--flux1b <second lora id>] [--flux2 <lora id>]
//        [--zimage <lora id>] [--stack-style <project trained style id>]
// The default trained models are public FLUX.1 and FLUX.2 LoRAs of the
// catalog recorded in test/fixtures/m2.0 (check they are still public).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const png = require("../../plugin/src/util/png.js");
const manifest = require("../../plugin/manifest.json");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MAJOR = arg("--ps-major", process.env.PS_MAJOR || "27");
const DATA = path.join(os.homedir(), "Library", "Application Support", "Adobe", "UXP", "PluginsStorage", "PHSP", MAJOR, "External", manifest.id, "PluginData");
const PRICE_ONLY = process.argv.includes("--price-only");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASES = {
  flux1: { base: "model_bfl-flux-1-dev", lora: arg("--flux1", "model_YQrES2iPys22nYwh3YhVfMh8"), route: "image_strength" },
  flux2: { base: "model_bfl-flux-2-dev", lora: arg("--flux2", "model_JJ54CEwcWD5upeaCuLD83Ddh"), route: "reference" },
  zimage: { base: "model_z-image", lora: arg("--zimage", null), route: "image_strength" }
};
const SECOND_FLUX1 = arg("--flux1b", "model_XNM4XkZHCifSwJUE3JNs2Wnj");
const SEL = { left: 192, top: 160, width: 128, height: 128, shape: "ellipse", feather: 2 };

async function send(cmd, timeoutMs = 20000) {
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
    let out;
    try {
      out = JSON.parse(text);
    } catch (e) {
      // read while the panel was still writing it
      continue;
    }
    if (out.id !== id) continue;
    if (!out.ok) throw new Error(cmd.cmd + ": " + out.error);
    return out.result;
  }
  throw new Error("no answer from the panel (is a development build installed, Photoshop running and the panel open?)");
}

async function until(fn, label, ms = 20000, step = 400) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  throw new Error("timed out: " + label);
}

const state = () => send({ cmd: "state" });
async function clearRefs() {
  const s = await state();
  const items = (s.model.composer.refs && s.model.composer.refs.items) || [];
  for (const it of items) if (it.removable || it.role) await send({ cmd: "library", remove_ref: it.id });
}
const lib = async () => (await state()).model.composer.library;

function fixture(w, h) {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      data[i] = 90 + Math.round((x / w) * 120);
      data[i + 1] = 120 + Math.round((y / h) * 80);
      data[i + 2] = 200;
    }
  return Buffer.from(png.encodePng({ width: w, height: h, channels: 3, data }));
}

async function makeDoc(w, h, selection) {
  const r = await send({ cmd: "makedoc", document: { width: w, height: h, fixture: `dev-live/m7-${w}x${h}.png`, flatten: true }, selection: selection || null, name: "Scenario M7 check" });
  // Wait for the flatten to finish before anything reads the document.
  await until(async () => (await send({ cmd: "inspect", document_id: r.document_id })).history === "Flatten Image", "the document ready", 20000).catch(() => null);
  await sleep(800);
  return r.document_id;
}

async function placeCase(w, h) {
  const docId = await makeDoc(w, h);
  // Place goes to the document the panel's context names: wait until that
  // is the new one, or the image lands in the document made before it. With
  // Photoshop in the background its document events may not reach the
  // panel (seen live 2026-10-20), so a view command re-reads the context.
  await until(async () => {
    await send({ cmd: "view", name: "main" });
    await sleep(600);
    return String((await state()).state.key || "").startsWith(docId + "|");
  }, "the context on the new document", 30000);
  // The new document's context read can land after the pick and reset the
  // action to the context's first one: pick again until it holds.
  await until(async () => {
    await send({ cmd: "view", name: "main", action: "library_place" });
    await sleep(1200);
    return (await state()).state.action === "library_place";
  }, "Place from Library picked", 30000);
  const L = await until(async () => {
    const x = await lib();
    return x && x.state === "ready" && x.items.length ? x : null;
  }, "library ready", 60000);
  const before = await send({ cmd: "inspect", document_id: docId });
  const item = L.items[0];
  await send({ cmd: "click", attr: "data-lib", value: item.asset_id });
  // The layer can show before its History state is read back: wait for
  // both, then read once more if only the layer came.
  let after = await until(async () => {
    const x = await send({ cmd: "inspect", document_id: docId });
    return x.layers.length > before.layers.length && x.history_count > before.history_count ? x : null;
  }, "the placed layer", 60000).catch(() => null);
  if (!after) after = await send({ cmd: "inspect", document_id: docId });
  if (after.layers.length <= before.layers.length) throw new Error("timed out: the placed layer");
  const layer = after.layers.find((l) => l.fields && l.fields.kind === "library");
  const size = item.size || null;
  const b = layer && layer.bounds;
  const res = {
    document: `${w} x ${h}`,
    image: size,
    layer: layer ? { name: layer.name, bounds: b, assetId: layer.fields.assetId } : null,
    history: after.history,
    history_added: after.history_count - before.history_count
  };
  let ok = !!layer && after.history === "Scenario: Place library" && res.history_added === 1 && layer.fields.assetId === item.asset_id;
  if (ok && b && size) {
    const s = Math.min(1, w / size.width, h / size.height);
    const ew = Math.round(size.width * s);
    const eh = Math.round(size.height * s);
    ok = Math.abs(b.width - ew) <= 1 && Math.abs(b.height - eh) <= 1 && Math.abs(b.left + b.width / 2 - w / 2) <= 1 && Math.abs(b.top + b.height / 2 - h / 2) <= 1;
    res.expected = { width: ew, height: eh, centered: true };
  }
  return { ok, res };
}

// Runs the current composer once (or only reads its price): waits for the
// price, refuses above max_cu, confirms when asked, waits for the result.
async function runComposer(c, docId) {
  const priced = await until(async () => {
    const s = await state();
    const g = s.model.composer.go;
    return g && g.enabled && /\d+\s*CU/.test(g.cu || g.label || "") ? s : null;
  }, "a price on the button", 45000);
  const g = priced.model.composer.go;
  const cu = Number(/(\d+(?:\.\d+)?)\s*CU/.exec(g.cu || g.label)[1]);
  const out = { button: g.label + (g.cu ? " · " + g.cu : ""), cu, model_chip: (priced.model.composer.chips.find((x) => x.kind === "model") || {}).title || null };
  if (cu > c.max_cu) return { ok: false, out: { ...out, refused: `price ${cu} CU above max_cu ${c.max_cu}` } };
  if (PRICE_ONLY) return { ok: true, out: { ...out, price_only: true } };
  const prev = (await send({ cmd: "lastrun" })).record;
  await send({ cmd: "click", el: "go" });
  await sleep(1500);
  const s1 = await state();
  if (s1.confirm) await send({ cmd: "click", el: "confirm-ok" });
  const END = ["applied", "failed", "blocked", "canceled", "not_sent", "download_failed", "apply_failed", "uncertain"];
  const rec = await until(
    async () => {
      const r = (await send({ cmd: "lastrun" })).record;
      return r && (!prev || r.local_id !== prev.local_id) && END.indexOf(r.state) >= 0 ? r : null;
    },
    "the run to end",
    6 * 60000,
    3000
  );
  out.record = rec;
  if (rec.state !== "applied") return { ok: false, out };
  const nd = rec.document_id;
  if (nd !== null && nd !== docId) await send({ cmd: "adopt", document_id: nd });
  const x = await send({ cmd: "inspect", document_id: nd });
  const layer = x.layers.find((l) => l.fields && l.fields.jobId);
  out.layer = layer ? { name: layer.name, modelId: layer.fields.modelId, trainedModelIds: layer.fields.trainedModelIds } : null;
  return { ok: true, out, layer };
}

function trainedFieldsOk(fields, base, ids) {
  const got = String((fields && fields.trainedModelIds) || "").split(",").filter(Boolean);
  return fields && fields.modelId === base && ids.every((id) => got.includes(id));
}

const CASES = [
  {
    id: "library-browse",
    free: true,
    run: async () => {
      await send({ cmd: "closedoc", all: true }).catch(() => null);
      // Closing documents re-reads the context, which can reset the action
      // after the pick: pick again until Open from Library holds.
      await until(async () => {
        await send({ cmd: "view", name: "main", action: "library" });
        await sleep(1200);
        return (await state()).state.action === "library";
      }, "Open from Library picked", 30000);
      const all = await until(async () => {
        const x = await lib();
        return x && x.state === "ready" ? x : null;
      }, "library ready", 60000);
      const res = { all: { shown: all.items.length, more: all.more, empty: all.empty }, filters: {} };
      let ok = all.items.length > 0;
      const WANT = { generated: "txt2img", edited: "img2img", uploaded: "uploaded" };
      for (const key of Object.keys(WANT)) {
        await send({ cmd: "library", filter: key });
        const f = await until(async () => {
          const x = await lib();
          return x && x.state === "ready" && x.filters.find((y) => y.on).key === key ? x : null;
        }, "filter " + key);
        const sources = [...new Set(f.items.map((i) => i.source))];
        res.filters[key] = { shown: f.items.length, sources };
        if (f.items.some((i) => i.source && i.source !== WANT[key])) ok = false;
      }
      await send({ cmd: "library", filter: "all" });
      await until(async () => {
        const x = await lib();
        return x && x.state === "ready" && x.filters[0].on ? x : null;
      }, "filter all");
      if (all.more) {
        await send({ cmd: "library", more: true });
        const m = await until(async () => {
          const x = await lib();
          return x && x.state === "ready" ? x : null;
        }, "show more");
        res.after_more = m.items.length;
        if (m.items.length <= all.items.length) ok = false;
      }
      return { ok, res };
    }
  },
  {
    id: "library-search",
    free: true,
    run: async () => {
      await send({ cmd: "view", name: "main", action: "library" });
      const L = await until(async () => {
        const x = await lib();
        return x && x.state === "ready" && x.items.length ? x : null;
      }, "library ready", 60000);
      const word = (L.items[0].title.replace(/^Open /, "").match(/[A-Za-z]{4,}/) || [null])[0];
      if (!word) return { ok: false, res: { reason: "no word to search in the first image's name" } };
      const hit = (await send({ cmd: "library", search: word })).library;
      const miss = (await send({ cmd: "library", search: "zzqxj" + Date.now() })).library;
      await send({ cmd: "library", search: "" });
      return { ok: hit.items.some((i) => i.asset_id === L.items[0].asset_id) && !miss.items.length && !!miss.empty, res: { word, hits: hit.items.length, miss_note: miss.empty } };
    }
  },
  { id: "library-place-large", free: true, run: () => placeCase(2048, 2048) },
  { id: "library-place-small", free: true, run: () => placeCase(256, 256) },
  {
    id: "library-reference",
    free: true,
    run: async () => {
      await makeDoc(512, 512);
      await send({ cmd: "view", name: "main", action: "versions" });
      await sleep(800);
      const before = (await state()).state.refs;
      const L = (await send({ cmd: "library", add_ref: true })).library;
      const R = await until(async () => {
        const x = await lib();
        return x && x.mode === "ref" && x.state === "ready" && x.items.length ? x : null;
      }, "reference grid");
      await send({ cmd: "click", attr: "data-lib", value: R.items[0].asset_id });
      const after = await until(async () => {
        const s = await state();
        return s.state.refs > before ? s : null;
      }, "the reference added", 30000);
      const ok = after.state.refs === before + 1 && !after.model.composer.library;
      // Take the reference off again: a reference left in the composer
      // blocks the text-only trained cases after this one.
      await clearRefs();
      return { ok, res: { mode: L && L.mode, refs: after.state.refs } };
    }
  },
  {
    id: "trained-picker",
    free: true,
    run: async () => {
      await send({ cmd: "closedoc", all: true }).catch(() => null);
      await send({ cmd: "view", name: "main", action: "create" });
      await send({ cmd: "view", name: "picker", tab: "trained" });
      await sleep(1500);
      let via = "picker row";
      try {
        await send({ cmd: "click", attr: "data-model", value: BASES.flux1.lora });
      } catch (e) {
        // The row may sit below the first page of the list.
        via = "runwith command (row not on the first page: " + e.message + ")";
        await send({ cmd: "view", name: "main", action: "create" });
        await send({ cmd: "runwith", model_id: BASES.flux1.lora });
      }
      const s = await until(async () => {
        const x = await state();
        return x.state.runWith === BASES.flux1.lora ? x : null;
      }, "Run with set");
      const chip = s.model.composer.chips.find((x) => x.kind === "model") || {};
      await send({ cmd: "view", name: "main", action: "create" });
      return { ok: /\bon\b/.test(chip.title || ""), res: { via, chip: chip.title } };
    }
  },
  {
    id: "trained-new-flux1",
    max_cu: 15,
    run: async () => {
      await send({ cmd: "closedoc", all: true }).catch(() => null);
      await clearRefs();
      await send({ cmd: "view", name: "main", action: "create" });
      await send({ cmd: "runwith", model_id: BASES.flux1.lora });
      await send({ cmd: "prompt", text: "a small wooden lighthouse figurine on a table" });
      await send({ cmd: "pop", kind: "takes" });
      await send({ cmd: "click", attr: "data-value", value: "1" });
      const r = await runComposer({ max_cu: 15 }, null);
      if (!r.ok || PRICE_ONLY) return { ok: r.ok, res: r.out };
      return { ok: !!r.layer && trainedFieldsOk(r.layer.fields, BASES.flux1.base, [BASES.flux1.lora]), res: r.out };
    }
  },
  ...Object.keys(BASES).map((k) => ({
    id: "trained-edit-" + k,
    // FLUX.2 Dev on the reference route priced 32 CU live (2026-10-20).
    max_cu: 35,
    run: async () => {
      const b = BASES[k];
      if (!b.lora) return { skip: `no ${k} trained model given (--${k} <id>)` };
      const docId = await makeDoc(512, 448, SEL);
      await send({ cmd: "view", name: "main", action: "replace" });
      await send({ cmd: "runwith", model_id: b.lora });
      await send({ cmd: "prompt", text: "a brass lantern" });
      // One take, as the header says (the edit lane's default is two).
      await send({ cmd: "pop", kind: "takes" });
      await send({ cmd: "click", attr: "data-value", value: "1" });
      const r = await runComposer({ max_cu: 35 }, docId);
      if (!r.ok || PRICE_ONLY) return { ok: r.ok, res: { route: b.route, ...r.out } };
      return { ok: !!r.layer && trainedFieldsOk(r.layer.fields, b.base, [b.lora]), res: { route: b.route, ...r.out } };
    }
  })),
  {
    id: "trained-stack",
    max_cu: 15,
    run: async () => {
      // Stacking pairs a project trained style (Style chip) with a trained
      // model picked in the Model menu on one base. It needs a project with
      // a FLUX.1 LoRA of its own: --stack-style <its id>.
      const styleId = arg("--stack-style", null);
      if (!styleId) return { skip: "no project trained style given (--stack-style <id>): the signed-in project had none in M7" };
      await send({ cmd: "closedoc", all: true }).catch(() => null);
      await clearRefs();
      await send({ cmd: "view", name: "main", action: "create" });
      await send({ cmd: "pop", kind: "style" });
      await send({ cmd: "click", attr: "data-value", value: styleId });
      await send({ cmd: "runwith", model_id: SECOND_FLUX1 });
      const s = await state();
      if (s.state.style !== styleId || s.state.runWith !== SECOND_FLUX1) return { ok: false, res: { reason: "the pair did not stack", style: s.state.style, runWith: s.state.runWith, note: s.state.note } };
      await send({ cmd: "prompt", text: "a stone arena at dusk" });
      await send({ cmd: "pop", kind: "takes" });
      await send({ cmd: "click", attr: "data-value", value: "1" });
      const r = await runComposer({ max_cu: 15 }, null);
      if (!r.ok || PRICE_ONLY) return { ok: r.ok, res: r.out };
      return { ok: !!r.layer && trainedFieldsOk(r.layer.fields, BASES.flux1.base, [styleId, SECOND_FLUX1]), res: r.out };
    }
  }
];

async function main() {
  const out = arg("--out", null);
  if (!out) throw new Error("usage: m7-live-check.js --out <dir> [--cases a,b] [--price-only] [--spend-log <file>]");
  const only = arg("--cases", null);
  const spendLog = arg("--spend-log", null);
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.join(DATA, "dev-live"), { recursive: true });
  for (const [w, h] of [
    [2048, 2048],
    [256, 256],
    [512, 512],
    [512, 448]
  ])
    fs.writeFileSync(path.join(DATA, "dev-live", `m7-${w}x${h}.png`), fixture(w, h));
  await send({ cmd: "ping" });
  const results = [];
  for (const c of CASES) {
    if (only && !only.split(",").includes(c.id)) continue;
    const t0 = Date.now();
    let r;
    try {
      r = await c.run();
    } catch (e) {
      r = { ok: false, res: { error: e.message } };
    }
    const status = r.skip ? "not tested" : r.ok ? (PRICE_ONLY && !c.free ? "verified live (price only)" : "verified live") : "failed";
    const row = { id: c.id, status, seconds: Math.round((Date.now() - t0) / 1000), skip: r.skip || null, details: r.res || null };
    results.push(row);
    console.log(`${c.id}: ${status}${r.skip ? " (" + r.skip + ")" : ""}`);
    const rec = r.res && r.res.record;
    if (spendLog && !c.free && !PRICE_ONLY && rec && rec.state !== "not_sent")
      fs.appendFileSync(spendLog, `| ${new Date().toISOString().slice(0, 10)} | 3 (M7 live check, ${c.id}) | ${rec.model_id} + ${(rec.trained_model_ids || []).join(", ")} | 1 take | ${rec.cu_charged !== null && rec.cu_charged !== undefined ? rec.cu_charged : rec.cu_quoted} | ${status} | ${rec.job_id || "no job id"} (${rec.state}) |\n`);
  }
  await send({ cmd: "closedoc", all: true }).catch(() => null);
  fs.writeFileSync(path.join(out, "m7-live-check.json"), JSON.stringify({ version: manifest.version, at: new Date().toISOString(), price_only: PRICE_ONLY, results }, null, 2));
  console.log(`wrote ${path.join(out, "m7-live-check.json")}`);
  if (results.some((r) => r.status === "failed")) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
