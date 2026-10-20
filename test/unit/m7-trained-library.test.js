"use strict";
// M7 Trained and Library (SPEC 3.4, 3.5, 5.2, 9): the project's trained
// styles and characters in the Style chip and the Model menu, with their
// thumbnails and trigger words; Run with a trained model on its base;
// two LoRAs stacked on one base with their own weights; a composition
// alone; the Library lane's filters, search, Show more, Place from Library
// as a layer with Scenario XMP, and + Reference > Library. Headless: the
// plugin source over the fake Photoshop and the fixture mock (price checks
// only, nothing paid).

const test = require("node:test");
const assert = require("node:assert/strict");
const xmp = require("../../plugin/src/util/xmp.js");
const png = require("../../plugin/src/util/png.js");
const trainedMod = require("../../plugin/src/catalog/trained.js");
const trainedPanel = require("../../plugin/src/panel/trained.js");
const editMod = require("../../plugin/src/lanes/edit.js");
const libraryMod = require("../../plugin/src/panel/library.js");
const actions = require("../../plugin/src/panel/actions.js");
const { bootGenerate } = require("../helpers/generate-sim.js");
const { waitFor } = require("../helpers/fakes.js");
const { catalogRows } = require("../helpers/fixture-scenario.js");

const FLUX1 = "model_bfl-flux-1-dev";
const CDN = "https://cdn.cloud.scenario.com/";

function costAnswer(cu) {
  return { status: 200, body: { creativeUnitsCost: cu, creativeUnitsDiscount: 0, costDetails: { "custom-generation": cu } } };
}

// Project trained models shaped like the records hosted Scenario MCP showed
// on 2026-10-20 (conceptPrompt empty, the trigger in every sample prompt),
// built from a public FLUX.1 LoRA row of the fixture catalog. Names are
// invented.
const LORA_ROW = catalogRows.find((r) => r.type === "flux.1-lora");
function trainedRow(id, name, o = {}) {
  return {
    ...LORA_ROW,
    id,
    name,
    privacy: "private",
    tags: o.tags || [],
    thumbnail: o.thumb ? { assetId: "asset_thumb" + id.slice(-4), url: CDN + "thumbs/" + id + ".jpg" } : undefined,
    trainingImagesNumber: o.images || 0,
    parameters: { conceptPrompt: "", samplePrompts: (o.samples || []).slice() },
    concepts: [{ modelId: id, scale: o.scale || 0.8 }]
  };
}
const INK = trainedRow("model_m7InkWashStyle01", "Ink Wash", { images: 32, thumb: true, scale: 0.9, samples: ["a harbor at dawn, INKWSH style", "INKWSH style, a lighthouse on rocks", "a fishing boat INKWSH style"] });
const KNIGHT = trainedRow("model_m7KnightCharact01", "Sir Bram character", { images: 20, samples: ["BRAMKN standing in a hall", "BRAMKN riding a horse"] });

test("trigger words and roles come from the trained model's own record", () => {
  assert.equal(trainedMod.triggerOf(INK), "INKWSH", "the all-caps token of every sample prompt");
  assert.equal(trainedMod.triggerOf({ parameters: { conceptPrompt: "mytok", samplePrompts: ["A B"] } }), "mytok", "the concept prompt wins");
  assert.equal(trainedMod.triggerOf({ parameters: { samplePrompts: ["a cat", "a DOG"] } }), null, "no token common to every sample");
  assert.equal(trainedMod.triggerOf({ parameters: {} }), null);
  assert.equal(trainedMod.roleOf(KNIGHT), "character");
  assert.equal(trainedMod.roleOf(INK), "style");
  assert.equal(trainedMod.roleOf({ name: "Hero pack", tags: [] }), "character");
});

test("stacking: two LoRAs on one base with their weights; a composition runs alone; triggers before the prompt unless turned off", () => {
  // A base as catalog.baseSchemas() gives it: the fields commonBase reads.
  const bases = [{ model_id: FLUX1, name: "FLUX.1 Dev", takes_loras: { max: 6, scale_min: 0, scale_max: 2 }, file_inputs: [{ name: "image", role: "image", required: false }], parameters: [{ name: "strength" }] }];
  const ink = { id: "a", name: "Ink", kind: "lora", scale: 0.9, bases: [FLUX1], base_names: ["FLUX.1 Dev"], lanes: ["edit", "image"], trigger: "INKWSH", role: "style", images: 32 };
  const bram = { id: "b", name: "Bram", kind: "lora", scale: 0.8, bases: [FLUX1], base_names: ["FLUX.1 Dev"], lanes: ["edit", "image"], trigger: "BRAMKN", role: "character", images: 20 };
  const comp = { id: "c", name: "Comp", kind: "composition", scale: 1, bases: [FLUX1], base_names: ["FLUX.1 Dev"], lanes: ["edit", "image"], trigger: null, role: "style" };
  const create = actions.ACTIONS.create;
  assert.equal(trainedPanel.familyOf(create), "image");
  assert.equal(trainedPanel.familyOf(actions.ACTIONS.replace), "edit");
  assert.equal(trainedPanel.familyOf(actions.ACTIONS.upscale), null);
  const sb = (x) => bases.map((b) => ({ ...b, ...x }));
  const r = trainedPanel.resolve(create, ink, bram, sb({}));
  assert.equal(r.base_model_id, FLUX1);
  const arg = trainedPanel.argOf(r, { "w:b": 1.25 });
  assert.deepEqual(arg.loras, [
    { model_id: "a", scale: 0.9 },
    { model_id: "b", scale: 1.25 }
  ]);
  const params = {};
  editMod.loraParams(params, arg);
  assert.deepEqual(params, { loras: ["a", "b"], lorasScale: [0.9, 1.25] });
  assert.equal(trainedPanel.withTriggers("a knight in the rain", r, {}), "INKWSH, BRAMKN, a knight in the rain");
  assert.equal(trainedPanel.withTriggers("BRAMKN in the rain", r, {}), "INKWSH, BRAMKN in the rain", "a trigger already there is not added twice");
  assert.equal(trainedPanel.withTriggers("a knight", r, { trigger: "off" }), "a knight");
  const rows = trainedPanel.advancedRows(r, {});
  assert.deepEqual(
    rows.map((x) => x.name),
    ["w:a", "w:b", "trigger"]
  );
  assert.ok(rows[0].options.some((o) => o[0] === 0.9 && /its own/.test(o[1])), "its own weight is offered");
  assert.equal(rows[2].label, "Trigger words · INKWSH, BRAMKN");
  // A composition replaces LoRAs on the base: it never stacks.
  const rc = trainedPanel.resolve(create, ink, comp, sb({}));
  assert.equal(rc.base_model_id, null);
  assert.match(trainedPanel.clash(create, ink, comp, sb({})), /composition runs alone/);
  const one = {};
  editMod.loraParams(one, trainedPanel.argOf(trainedPanel.resolve(create, comp, null, sb({})), {}));
  assert.deepEqual(one, { modelId: "c" });
  // A base that takes one LoRA cannot run two.
  assert.match(trainedPanel.resolve(create, ink, bram, sb({ takes_loras: { max: 1, scale_min: 0, scale_max: 2 } })).reason, /no base model in common/);
});

async function bootPanel(t, opts = {}) {
  const sim = await bootGenerate(t, {
    docs: opts.docs || [],
    active: opts.active,
    mockOpts: { project: [INK, KNIGHT], answer: (model) => (model === FLUX1 ? costAnswer(5) : undefined), ...(opts.mockOpts || {}) }
  });
  sim.ps.entrypoints.panels.scenarioPanel.show();
  await waitFor(() => sim.app.controller.state().active, { label: "panel shown" });
  return sim;
}

const lastCheck = (mock, model) => mock.priceChecks.filter((p) => p.model === model).at(-1);

test("Create image: the Style chip lists the project's trained styles with thumbnail and trigger; the Model menu lists trained characters; Run with stacks both on FLUX.1 Dev", async (t) => {
  const { app, mock } = await bootPanel(t);
  const ctl = app.controller;
  assert.equal(ctl.state().action, "create");
  ctl.setPrompt("a knight on the quay");
  const style = await ctl.menu("style");
  const tg = style.groups.find((g) => g.title === "Trained styles");
  assert.ok(tg, "a Trained styles group on Create image");
  assert.deepEqual(
    tg.items.map((i) => i.label),
    ["Ink Wash"]
  );
  assert.equal(tg.items[0].sub, "Trained style · 32 images · FLUX.1 Dev");
  assert.match(tg.items[0].title, /Trigger: INKWSH/);
  assert.ok(String(tg.items[0].thumb).startsWith("https://"), "the trained model's thumbnail");
  ctl.choose("style", tg.items[0].value);
  await waitFor(() => lastCheck(mock, FLUX1), { label: "a price check on the base" });
  let body = lastCheck(mock, FLUX1).body;
  assert.deepEqual(body.loras, [INK.id]);
  assert.equal(body.prompt, "INKWSH, a knight on the quay");

  // The Model menu under a trained style: its base, then the trained
  // models that stack with it on that base.
  const mm = await ctl.menu("model");
  assert.equal(mm.groups[0].title, "Trained style base");
  assert.equal(mm.groups[0].items[0].value, "t:-");
  const stack = mm.groups.find((g) => g.title === "Run with Ink Wash");
  assert.ok(stack, "Run with group");
  assert.deepEqual(
    stack.items.map((i) => [i.value, i.label]),
    [["t:" + KNIGHT.id, "Sir Bram character"]]
  );
  const n0 = mock.priceChecks.length;
  ctl.choose("model", "t:" + KNIGHT.id);
  await waitFor(() => mock.priceChecks.length > n0 && lastCheck(mock, FLUX1).body.loras.length === 2, { label: "a price check with two LoRAs" });
  body = lastCheck(mock, FLUX1).body;
  assert.deepEqual(body.loras, [INK.id, KNIGHT.id]);
  assert.deepEqual(body.lorasScale, [0.9, 0.8], "each at its own weight");
  assert.equal(body.prompt, "INKWSH, BRAMKN, a knight on the quay");
  assert.equal(body.quality, undefined, "no quality under a trained model");

  // Advanced: a weight per LoRA and the trigger words.
  const adv = await ctl.menu("adv");
  const names = adv.rows.map((r) => r.name);
  assert.ok(names.includes("w:" + KNIGHT.id) && names.includes("trigger"), names.join(","));
  const n1 = mock.priceChecks.length;
  ctl.choose("adv", { name: "w:" + KNIGHT.id, value: 1.25 });
  ctl.choose("adv", { name: "trigger", value: "off" });
  await waitFor(() => mock.priceChecks.length > n1 && lastCheck(mock, FLUX1).body.prompt === "a knight on the quay", { label: "weights and triggers in the request" });
  assert.deepEqual(lastCheck(mock, FLUX1).body.lorasScale, [0.9, 1.25]);

  // Back to the base alone: the style stays, the character goes.
  ctl.choose("model", "t:-");
  await waitFor(() => lastCheck(mock, FLUX1).body.loras.length === 1, { label: "the style alone" });
  assert.equal(ctl.state().style, INK.id);
  assert.ok(mock.paidCalls.length === 0, "nothing paid");
});

test("Run with a trained character from the main Model menu with no style; a catalog model clears it", async (t) => {
  const { app, mock } = await bootPanel(t);
  const ctl = app.controller;
  ctl.setPrompt("on a horse");
  const mm = await ctl.menu("model");
  const yours = mm.groups.find((g) => g.title === "Your trained models");
  assert.ok(yours, "Your trained models group");
  assert.deepEqual(
    yours.items.map((i) => i.label),
    ["Sir Bram character", "Ink Wash"],
    "characters first"
  );
  assert.equal(yours.items[0].sub, "Trained character · 20 images · FLUX.1 Dev");
  ctl.choose("model", "t:" + KNIGHT.id);
  await waitFor(() => lastCheck(mock, FLUX1) && lastCheck(mock, FLUX1).body.prompt === "BRAMKN, on a horse", { label: "Run with on the base" });
  assert.deepEqual(lastCheck(mock, FLUX1).body.loras, [KNIGHT.id]);
  const m = ctl.model();
  const chip = m.composer.chips.find((c) => c.kind === "model");
  assert.match(chip.value + " " + chip.title, /Sir Bram/);
  // Picking a catalog model ends Run with.
  const mm2 = await ctl.menu("model");
  const cat = mm2.groups.flatMap((g) => g.items).find((i) => typeof i.value === "string" && i.value.startsWith("model_") && i.value !== FLUX1);
  assert.ok(cat, "a catalog model in the menu");
  ctl.choose("model", cat.value);
  assert.equal(ctl.state().runWith, null);
});

test("Make versions on a layer: a trained style plus a trained character run as one trained edit on FLUX.1 Dev, both LoRAs in the request", async (t) => {
  const DOC = { id: 7, title: "poster.psd", width: 512, height: 512 };
  const { app, mock } = await bootPanel(t, { docs: [DOC], active: 7 });
  const ctl = app.controller;
  await waitFor(() => ctl.state().kind === "layer", { label: "a layer context" });
  ctl.selectAction("versions");
  ctl.setPrompt("in winter");
  const style = await ctl.menu("style");
  const ink = style.groups.find((g) => g.title === "Trained styles").items[0];
  ctl.choose("style", ink.value);
  ctl.choose("model", "t:" + KNIGHT.id);
  await waitFor(() => lastCheck(mock, FLUX1) && (lastCheck(mock, FLUX1).body.loras || []).length === 2, { label: "an edit price check with two LoRAs", timeout: 8000 });
  const body = lastCheck(mock, FLUX1).body;
  assert.deepEqual(body.loras, [INK.id, KNIGHT.id]);
  // The price check runs before any upload; the strength shows the image
  // and strength route of FLUX.1 Dev.
  assert.equal(typeof body.strength, "number");
  assert.equal(body.prompt, "INKWSH, BRAMKN, in winter");
  assert.equal(mock.paidCalls.length, 0);
});

// ---- Library ----

function asset(id, o = {}) {
  return {
    id,
    kind: o.kind || "image",
    name: o.name || "",
    source: o.source || "txt2img",
    description: o.description || "",
    tags: o.tags || [],
    createdAt: o.createdAt,
    url: CDN + "assets/" + id + ".png",
    thumbnail: { url: CDN + "thumbs/" + id + ".png" },
    metadata: { width: o.width || 1024, height: o.height || 1024, prompt: o.prompt || "", modelId: o.modelId || FLUX1 }
  };
}

function libraryMock(lists, calls) {
  return (r) => {
    calls.push({ type: r.query.type, token: r.query.paginationToken || null, pageSize: r.query.pageSize });
    const all = lists[r.query.type] || [];
    const start = r.query.paginationToken ? Number(r.query.paginationToken.slice(1)) : 0;
    const size = Number(r.query.pageSize) || 30;
    const next = start + size < all.length ? "p" + (start + size) : null;
    return { status: 200, body: { assets: all.slice(start, start + size), nextPaginationToken: next } };
  };
}

test("Library rows: description, prompt (never a text asset id), source, tags; search over all of them", () => {
  const r = libraryMod.rowOf(asset("asset_a", { name: "", prompt: "asset_textPrompt01", description: "A lighthouse on a cliff at dawn", tags: ["coast"] }));
  assert.equal(r.prompt, null, "a prompt kept as a text asset is not shown");
  assert.equal(r.name, "A lighthouse on a cliff at dawn");
  assert.equal(r.source, "txt2img");
  assert.equal(r.model_id, FLUX1);
  const rows = [r, libraryMod.rowOf(asset("asset_b", { prompt: "a red boat", tags: ["harbor"] }))];
  assert.deepEqual(
    libraryMod.search(rows, "coast LIGHT").map((x) => x.asset_id),
    ["asset_a"]
  );
  assert.deepEqual(
    libraryMod.search(rows, "harbor").map((x) => x.asset_id),
    ["asset_b"]
  );
  assert.equal(libraryMod.search(rows, "").length, 2);
  assert.equal(libraryMod.rowOf(asset("asset_c", { kind: "3d" })), null);
});

test("Library place plan: a layer at the image's own size, shrunk to fit a smaller canvas, centered, above the active layer, Scenario XMP of kind library", () => {
  const row = libraryMod.rowOf(asset("asset_m7PlaceAbc123", { name: "Harbor", prompt: "a harbor at dusk", width: 800, height: 600, createdAt: "2026-10-20T08:00:00Z" }));
  const p = libraryMod.placePlan(row, { path: "Scenario/library/x.png", width: 800, height: 600 }, { id: 7, width: 1024, height: 1024 }, { layer_id: 3, version: "0.7.0" });
  assert.equal(p.history_name, "Scenario: Place library");
  assert.deepEqual(p.insert, { layer_id: 3 });
  assert.deepEqual(p.takes[0].fit, { center_x: 512, center_y: 512, width: 800, height: 600 }, "never enlarged");
  assert.equal(p.takes[0].name, "Scenario library harbor Abc123");
  const f = xmp.parse(p.takes[0].xmp);
  assert.equal(f.kind, "library");
  assert.equal(f.assetId, "asset_m7PlaceAbc123");
  assert.equal(f.prompt, "a harbor at dusk");
  assert.equal(f.modelId, FLUX1);
  assert.equal(f.pluginVersion, "0.7.0");
  assert.equal(f.origin, "person");
  const small = libraryMod.placePlan(row, { path: "x", width: 800, height: 600 }, { id: 7, width: 400, height: 400 }, {});
  assert.deepEqual(small.takes[0].fit, { center_x: 200, center_y: 200, width: 400, height: 300 });
  assert.equal(small.scaled, true);
  const quiet = libraryMod.placePlan(row, { path: "x", width: 8, height: 6 }, { id: 7, width: 40, height: 40 }, { leave_prompts: true });
  assert.equal(xmp.parse(quiet.takes[0].xmp).prompt, undefined);
  assert.equal(quiet.takes[0].name, "Scenario library Abc123");
});

test("Library lane: All merges the image types newest first, filters read one type, search and Show more read the next page", async (t) => {
  const calls = [];
  const gen = Array.from({ length: 35 }, (_, i) => asset("asset_gen" + String(i).padStart(2, "0"), { prompt: i === 3 ? "a red lantern" : "a harbor " + i, createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - i * 120000).toISOString() }));
  const edited = [asset("asset_edit01", { source: "img2img", prompt: "the quay at night", createdAt: "2026-10-20T11:59:00.000Z" })];
  const up = [asset("asset_up01", { source: "uploaded", name: "moodboard.png", createdAt: "2026-10-19T09:00:00.000Z" })];
  const { app } = await bootPanel(t, { mockOpts: { assetsList: libraryMock({ txt2img: gen, img2img: edited, uploaded: up }, calls) } });
  const ctl = app.controller;
  ctl.selectAction("library");
  await waitFor(() => ctl.model().composer.library && ctl.model().composer.library.state === "ready", { label: "library ready" });
  let lib = ctl.model().composer.library;
  assert.deepEqual(calls.map((c) => c.type).sort(), ["img2img", "txt2img", "uploaded"], "one list per image type");
  assert.ok(calls.every((c) => c.pageSize === "30"));
  assert.equal(lib.items.length, libraryMod.SHOWN);
  assert.deepEqual(
    lib.items.slice(0, 2).map((i) => i.asset_id),
    ["asset_gen00", "asset_edit01"],
    "merged newest first"
  );
  assert.ok(lib.more, "Show more");
  assert.deepEqual(
    lib.filters.map((f) => [f.key, f.on]),
    [
      ["all", true],
      ["generated", false],
      ["edited", false],
      ["uploaded", false]
    ]
  );
  assert.match(lib.items[0].title, /^Open .*1024 × 1024$/);

  ctl.librarySearch("lantern");
  lib = ctl.model().composer.library;
  assert.deepEqual(
    lib.items.map((i) => i.asset_id),
    ["asset_gen03"]
  );
  ctl.librarySearch("no such thing");
  assert.match(ctl.model().composer.library.empty, /No image matches "no such thing" in the 32 newest/);
  ctl.librarySearch("");

  // Show more: the next tiles from what is read, then the next page.
  await ctl.libraryMore();
  await ctl.libraryMore();
  await waitFor(() => ctl.model().composer.library.state === "ready", { label: "page 2" });
  assert.ok(calls.some((c) => c.type === "txt2img" && c.token === "p30"), "the next txt2img page");
  assert.ok(!calls.some((c) => c.token && c.type !== "txt2img"), "complete lists are not read again");
  assert.equal(ctl.model().composer.library.items.length, 3 * libraryMod.SHOWN, "37 read, 36 shown");

  calls.length = 0;
  ctl.libraryFilter("uploaded");
  await waitFor(() => ctl.model().composer.library.state === "ready" && ctl.model().composer.library.items.length === 1, { label: "uploaded filter" });
  assert.deepEqual(
    calls.map((c) => c.type),
    ["uploaded"]
  );
  assert.equal(ctl.model().composer.library.items[0].asset_id, "asset_up01");
  ctl.libraryFilter("edited");
  await waitFor(() => ctl.model().composer.library.state === "ready" && ctl.model().composer.library.items[0] && ctl.model().composer.library.items[0].asset_id === "asset_edit01", { label: "edited filter" });
});

function solid(w, h) {
  const data = Buffer.alloc(w * h * 4, 200);
  return Buffer.from(png.encodePng({ width: w, height: h, channels: 4, data }));
}

test("Place from Library: More > Layers, a click places the image as a new layer above the active one with XMP, one History state; + Reference > Library adds it to the refs row", async (t) => {
  const calls = [];
  const IMG = asset("asset_m7PlacePix001", { name: "Harbor", prompt: "a harbor at dusk", width: 64, height: 48, createdAt: "2026-10-20T08:00:00Z" });
  const DOC = { id: 7, title: "poster.psd", width: 128, height: 128 };
  let origin = null;
  const sim = await bootPanel(t, {
    docs: [DOC],
    active: 7,
    mockOpts: {
      assetsList: libraryMock({ txt2img: [IMG] }, calls),
      // The file itself comes from the mock's CDN path, like a result.
      assetRead: (r, id) => (id === IMG.id ? { status: 200, body: { asset: { ...IMG, url: origin + "/assets/" + id + "?Key-Pair-Id=k&Policy=p&Signature=s", mimeType: "image/png" } } } : undefined),
      cdn: (r) => (r.path.includes(IMG.id) ? { status: 200, body: solid(64, 48), headers: { "content-type": "image/png" } } : undefined)
    }
  });
  origin = sim.mock.origin;
  const { app, ps } = sim;
  const ctl = app.controller;
  await waitFor(() => ctl.model().ctx && ctl.model().ctx.kind !== "none", { label: "a document context" });
  const more = await ctl.menu("more");
  const items = more.groups.flatMap((g) => g.items.map((i) => i.id));
  assert.ok(items.includes("library_place"), items.join(","));
  ctl.selectAction("library_place");
  await waitFor(() => ctl.model().composer.library && ctl.model().composer.library.state === "ready", { label: "library ready" });
  const lib = ctl.model().composer.library;
  assert.equal(lib.mode, "place");
  assert.match(lib.items[0].title, /^Place Harbor/);
  const layersBefore = ps.doc(7).layers.length;
  const hist = ps.history.length;
  await ctl.libraryPick(IMG.id);
  const msg = ctl.model().composer.message || "";
  assert.match(msg, /placed as a new layer/, msg);
  const placed = ps.doc(7).layers.find((l) => /^Scenario library harbor/.test(l.name));
  assert.ok(placed, "a new layer: " + ps.doc(7).layers.map((l) => l.name).join(","));
  assert.equal(ps.doc(7).layers.length, layersBefore + 1);
  const f = xmp.parse(placed.xmp);
  assert.equal(f.kind, "library");
  assert.equal(f.assetId, IMG.id);
  assert.equal(ps.history.length, hist + 1, "one History state");
  assert.equal(ps.history.at(-1).name, "Scenario: Place library");

  // + Reference > Library on an action with references.
  ctl.selectAction("versions");
  await ctl.addRef("library");
  await waitFor(() => ctl.model().composer.library && ctl.model().composer.library.mode === "ref" && ctl.model().composer.library.state === "ready", { label: "the grid as a reference picker" });
  assert.match(ctl.model().composer.library.items[0].title, /^Add Harbor/);
  await ctl.libraryPick(IMG.id);
  assert.equal(ctl.model().composer.library, null, "the grid closes");
  assert.equal(ctl.state().refs, 1);
  assert.equal(ps.doc(7).layers.length, layersBefore + 1, "a reference places nothing");
});
