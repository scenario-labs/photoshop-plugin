"use strict";
// The model catalog (SPEC 3.3, 3.4) on the scrubbed M2.0 listing: tab rules
// from shared/catalog-map.json with the measured strings, Scenario picks,
// search, chips and order; the cache (24 h, per project, paged reads);
// schemas as model_schema returns them; trained bases derived from the
// bases' schemas; list_models through the plugin's handler.

const test = require("node:test");
const assert = require("node:assert/strict");
const map = require("../../plugin/src/catalog/map.js");
const catalogMod = require("../../plugin/src/catalog/catalog.js");
const trained = require("../../plugin/src/catalog/trained.js");
const schemaMod = require("../../plugin/src/forms/schema.js");
const validate = require("../../plugin/src/forms/validate.js");
const main = require("../../plugin/src/main.js");
const { startFixtureScenario, catalogRows, records } = require("../helpers/fixture-scenario.js");
const { newKeyPair, projectRecord } = require("../helpers/mock-scenario.js");
const { fakeHost, uxpWebSocket, newToken } = require("../helpers/fakes.js");

const rows = catalogRows.map((m) => catalogMod.displayRow(m, false));
const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
const schemaOf = (id) => {
  const s = schemaMod.normalize(records[id]);
  s.row = catalogMod.displayRow(records[id], false);
  return s;
};

test("tab rules: measured capability and tag strings; Enhance by tag; trained by type; deprecated, video, audio and 3D hidden", () => {
  assert.deepEqual(map.tabsOf(byId["model_openai-gpt-image-2-5-flare"]), ["image", "edit", "enhance"]);
  assert.deepEqual(map.toolsOf(byId["model_openai-gpt-image-2-5-flare"]), ["expand"], "listed in the mapping as a mask-route Expand model");
  assert.deepEqual(map.tabsOf(byId["model_topaz-image-upscale"]), ["enhance"], "Enhance tags keep it out of Edit");
  assert.deepEqual(map.toolsOf(byId["model_topaz-image-upscale"]), ["upscale"]);
  assert.deepEqual(map.toolsOf(byId["model_851-labs-background-remover"]), ["remove_background"]);
  assert.deepEqual(map.toolsOf(byId["model_photoroom-expand"]), ["expand"]);
  assert.deepEqual(map.tabsOf(byId["model_qwen-image-edit-2511"]), ["edit"]);
  assert.deepEqual(map.tabsOf(byId["model_pruna-p-image-ideogram"]), ["image"]);
  for (const hidden of ["model_qwen-image", "model_bfl-flux-1-1-pro", "model_bytedance-seedance-2-5", "model_tripo-v3-1-image-to-3d", "model_lyria-3-5", "model_pixelcut-video-background-removal"]) {
    assert.deepEqual(map.tabsOf(byId[hidden]), [], hidden);
  }
  for (const r of rows.filter((x) => x.type !== "custom")) assert.deepEqual(map.tabsOf(r), ["trained"], r.id);
  assert.deepEqual(map.lanesOf(byId["model_openai-gpt-image-2-5-flare"]), ["image", "edit", "expand"]);
  // Every Enhance model is also img2img; none of them lands in Edit.
  for (const r of rows.filter((x) => map.toolsOf(x).length && x.id !== "model_openai-gpt-image-2-5-flare")) assert.ok(!map.tabsOf(r).includes("edit"), r.id);
});

test("Scenario picks: the lane defaults, then the tab's featured models, newest first, six at most", () => {
  const image = map.picks(rows, "image");
  assert.equal(image[0], "model_openai-gpt-image-2-5-flare");
  assert.equal(image.length, 6);
  assert.deepEqual(image.slice(1, 3), ["model_ideogram-v4-5", "model_xai-grok-imagine-image-2-0"]);
  assert.ok(!image.includes("model_lyria-3-5") && !image.includes("model_bytedance-seedance-2-5"), "featured models of other kinds stay out");
  assert.deepEqual(map.picks(rows, "enhance"), ["model_topaz-image-upscale", "model_scenario-gemini-reframe", "model_openai-gpt-image-2-5-flare", "model_851-labs-background-remover"]);
  assert.deepEqual(map.picks(rows, "trained"), []);
});

test("picker selection: chips, search, tags, favorites first, picks next, then the newest; trained: the project's first", () => {
  const all = map.select(rows, { tab: "image" });
  assert.equal(all[0].id, "model_openai-gpt-image-2-5-flare");
  const fav = map.select(rows, { tab: "image", favorites: ["model_bfl-flux-1-dev"] });
  assert.equal(fav[0].id, "model_bfl-flux-1-dev", "a favorite comes first");
  assert.deepEqual(map.select(rows, { tab: "image", chip: "favorites", favorites: ["model_bfl-flux-1-dev"] }).map((r) => r.id), ["model_bfl-flux-1-dev"]);
  assert.equal(map.select(rows, { tab: "image", chip: "recommended" }).length, 6);
  assert.deepEqual(map.select(rows, { tab: "enhance", chip: "upscale" }).map((r) => r.id).sort(), ["model_p-image-upscale", "model_recraft-crisp-upscale", "model_sc-upscale-flux", "model_topaz-image-upscale"]);
  assert.deepEqual(map.select(rows, { tab: "enhance", chip: "remove_background" }).map((r) => r.id).sort(), ["model_851-labs-background-remover", "model_photoroom-background-removal"]);
  assert.deepEqual(map.select(rows, { tab: "image", query: "klein base" }).map((r) => r.id).sort(), ["model_bfl-flux-2-klein-4b-base", "model_bfl-flux-2-klein-9b-base"]);
  assert.ok(map.select(rows, { tab: "image", tag: "black forest labs" }).every((r) => r.tags.some((t) => t.toLowerCase() === "black forest labs")));
  const flare = schemaOf("model_openai-gpt-image-2-5-flare");
  assert.ok(map.select(rows, { tab: "edit", chip: "mask", schemas: { [flare.model_id]: flare } }).some((r) => r.id === flare.model_id), "Mask input from the schema once read");
  const mixed = rows.map((r) => (r.id === "model_EEDXdL4VrRjC5CDXbSddKqj3" ? { ...r, project: true } : r));
  const t = map.select(mixed, { tab: "trained" });
  assert.equal(t[0].id, "model_EEDXdL4VrRjC5CDXbSddKqj3", "the project's trained models come first");
  assert.deepEqual(map.select(mixed, { tab: "trained", chip: "project" }).map((r) => r.id), ["model_EEDXdL4VrRjC5CDXbSddKqj3"]);
  const menu = map.tagMenu(rows, "image");
  assert.ok(menu.length > 5);
  assert.ok(menu.every((m) => !m.tag.toLowerCase().startsWith("sc:")), "Scenario's internal tags are not listed");
  for (let i = 1; i < menu.length; i++) assert.ok(menu[i - 1].count >= menu[i].count, "most common first");
});

test("schemas: GPT Image 2.5 Flare, Topaz, 851 Labs and Photoroom Expand as model_schema gives them", () => {
  const flare = schemaOf("model_openai-gpt-image-2-5-flare");
  assert.deepEqual(flare.mask_polarity, { value: "alpha", source: "schema" });
  assert.equal(flare.capture_input, "reference", "the first reference receives the capture (catalog-map)");
  assert.deepEqual(flare.price_affecting, ["referenceImages", "numOutputs", "width", "height", "quality"]);
  assert.equal(flare.size_inputs.kind, "grid");
  assert.equal(flare.size_inputs.step, 16);
  assert.equal(flare.size_inputs.max, 3840);
  assert.ok(flare.size_inputs.sizes.some((s) => s.width === 1024 && s.height === 1024));
  assert.equal(flare.takes_input, "numOutputs");
  assert.equal(flare.expand_route, "mask");
  assert.deepEqual(flare.file_inputs.map((f) => [f.name, f.role, f.price_affecting]), [["referenceImages", "reference", true], ["mask", "mask", false]]);
  const topaz = schemaOf("model_topaz-image-upscale");
  assert.equal(topaz.capture_input, "image");
  assert.equal(topaz.takes_input, null);
  assert.equal(topaz.output_max_px, 4096);
  assert.equal(schemaOf("model_851-labs-background-remover").output_max_px, 2048);
  assert.equal(schemaOf("model_photoroom-expand").expand_route, "exact_size");
  const agents = schemaMod.forAgents(flare);
  assert.deepEqual(Object.keys(agents).sort(), ["capture_input", "expand_route", "file_inputs", "mask_polarity", "model_id", "name", "no_refund", "parameters", "price_affecting", "size_inputs", "takes_loras", "variable_charge"]);
  const flux2 = schemaMod.forAgents(schemaOf("model_bfl-flux-2-dev"));
  assert.deepEqual(flux2.takes_loras, { max: 6, scale_min: 0, scale_max: 2, types: ["flux.2-dev-lora", "flux.2-dev-edit-lora"] });
});

test("validation: types, enums, ranges, integer steps, list limits and required inputs", () => {
  const flare = schemaOf("model_openai-gpt-image-2-5-flare");
  const ok = { prompt: "x", quality: "low", width: 1024, height: 1024, numOutputs: 1 };
  assert.deepEqual(validate.problems(flare, ok), []);
  assert.deepEqual(validate.problems(flare, { ...ok, numOutputs: 1.5 }), ["numOutputs must be a whole number."]);
  assert.deepEqual(validate.problems(flare, { ...ok, background: "auto", seed: null }), [], "null means omitted");
  assert.deepEqual(validate.problems(flare, { ...ok, referenceImages: "asset_x" }), ["referenceImages must be a list of asset ids."]);
  assert.deepEqual(validate.problems(flare, { ...ok, referenceImages: new Array(11).fill("asset_x") }), ["referenceImages takes at most 10 images."]);
  assert.deepEqual(validate.problems(flare, { ...ok, mask: "asset_m" }, { referenceImages: 1 }), [], "the capture fills the reference the mask needs");
  const remover = schemaOf("model_851-labs-background-remover");
  assert.deepEqual(validate.problems(remover, {}), ["image is required by this model."]);
  assert.deepEqual(validate.problems(remover, {}, { image: 1 }), []);
  assert.deepEqual(validate.problems(remover, { threshold: 0.333 }, { image: 1 }), [], "fractional steps are not checked");
  const flux2 = schemaOf("model_bfl-flux-2-dev");
  assert.deepEqual(validate.problems(flux2, { prompt: "x", loras: ["model_JJ54CEwcWD5upeaCuLD83Ddh"], lorasScale: [2.5] }), ["lorasScale[0] must be at most 2."]);
  assert.deepEqual(validate.problems(flux2, { prompt: "x", loras: ["not a model"] }), ["loras must be a list of model ids."]);
});

test("trained models: bases from the bases' modelTypes; LoRA or composition; routes and make_new from the first base", () => {
  const bases = ["model_bfl-flux-2-dev", "model_bfl-flux-1-dev", "model_z-image", "model_qwen-image-edit-2511"].map(schemaOf);
  const lora = trained.derive(byId["model_JJ54CEwcWD5upeaCuLD83Ddh"], bases);
  assert.equal(lora.trained_kind, "lora");
  assert.deepEqual(lora.base_model_ids, ["model_bfl-flux-2-dev"]);
  assert.equal(lora.default_scale, 0.8, "the record's own concepts scale");
  assert.equal(lora.make_new, true);
  assert.equal(lora.edit_route, "reference");
  assert.equal(lora.max_loras, 6);
  assert.equal(trained.kindLabel(lora), `LoRA via ${records["model_bfl-flux-2-dev"].name}`);
  const comp = trained.derive(byId["model_MYqiLuoTmgR2F1hzXPX3BBgY"], bases);
  assert.equal(comp.trained_kind, "composition", "only modelId lists flux.1-composition");
  assert.deepEqual(comp.base_model_ids, ["model_bfl-flux-1-dev"]);
  assert.equal(comp.edit_route, "image_strength");
  const flux1 = trained.derive(byId["model_YQrES2iPys22nYwh3YhVfMh8"], bases);
  assert.equal(flux1.trained_kind, "lora");
  const kontext = trained.derive(byId["model_hFh8M6nQbqGFSKJdP536GXhE"], bases);
  assert.equal(kontext.supported, false, "no probed base takes flux.1-kontext-lora here: grayed, nothing guessed");
  assert.equal(trained.kindLabel(kontext), "This trained model type isn't supported by this version of the plugin.");
  const qwenLora = trained.derive({ ...byId["model_JJ54CEwcWD5upeaCuLD83Ddh"], type: "qwen-image-edit-2511-lora", concepts: [] }, bases);
  assert.equal(qwenLora.make_new, "needs_reference");
  assert.equal(qwenLora.default_scale, 0.75);
  const zl = trained.derive({ ...byId["model_JJ54CEwcWD5upeaCuLD83Ddh"], type: "zimage-lora" }, bases);
  assert.equal(zl.edit_route, "image_strength");
});

async function bootSignedIn(t, mockOpts = {}) {
  const pair = newKeyPair();
  const mock = await startFixtureScenario({ accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "Catalog" })] }], ...mockOpts });
  let clock = Date.parse("2026-10-19T10:00:00Z");
  const host = fakeHost({ WebSocket: uxpWebSocket({ rewrite: (u) => u.replace(":9890", ":1") }), secure: [["scenario.pairing_token", newToken()]] });
  host.timers.now = () => clock;
  const app = await main.boot({ host, document: null, console: null, apiBaseUrl: mock.url });
  t.after(async () => {
    app.link.stop();
    await mock.close();
  });
  assert.equal((await app.auth.saveAndTest(pair.key, pair.secret)).ok, true);
  mock.requests.length = 0;
  return { app, mock, host, pair, tick: (ms) => (clock += ms) };
}

test("catalog cache: the project's models then public ones, paged, kept 24 h in the data folder, display fields only", async (t) => {
  const own = { ...catalogRows[4], id: "model_projectOwnModel01", name: "Our style", privacy: "private" };
  const { app, mock, host, tick } = await bootSignedIn(t, { pageSize: 20, project: [own] });
  const got = await app.catalog.ensure();
  assert.equal(got.length, catalogRows.length + 1);
  assert.equal(got[0].id, own.id);
  assert.equal(got[0].project, true);
  const listing = mock.requests.filter((r) => r.path === "/v1/models");
  assert.deepEqual(listing.map((r) => [r.query.privacy || "project", r.query.paginationToken || "-"]), [["project", "-"], ["public", "-"], ["public", "p20"], ["public", "p40"]]);
  assert.ok(listing.every((r) => r.query.pageSize === "500"));
  const file = JSON.parse(host.files.get(catalogMod.FILE));
  assert.equal(file.rows.length, got.length);
  assert.deepEqual(Object.keys(file.rows[0]).sort(), ["capabilities", "compliant", "concepts", "created_at", "description", "id", "images", "name", "no_refund", "privacy", "project", "tags", "thumb", "trigger", "type"]);
  assert.ok(!JSON.stringify(file).includes("inputs"), "no schemas in the cache");
  mock.requests.length = 0;
  await app.catalog.ensure();
  assert.equal(mock.requests.length, 0, "fresh cache: no read");
  tick(25 * 3600 * 1000);
  await app.catalog.ensure();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(mock.requests.filter((r) => r.path === "/v1/models").length >= 2, "older than 24 h: refreshed in the background");
});

test("list_models: lanes, sources, query, paging; trained rows carry their bases", async (t) => {
  const { app } = await bootSignedIn(t);
  const up = await app.catalogTools.list_models({ lane: "upscale" });
  assert.equal(up.models[0].model_id, "model_topaz-image-upscale", "the pick first");
  assert.ok(up.models.every((m) => m.lanes.includes("upscale")));
  const page1 = await app.catalogTools.list_models({ lane: "image", limit: 5 });
  assert.equal(page1.models.length, 5);
  assert.equal(page1.next_cursor, "o5");
  const page2 = await app.catalogTools.list_models({ lane: "image", limit: 5, cursor: page1.next_cursor });
  assert.ok(!page2.models.some((m) => page1.models.some((x) => x.model_id === m.model_id)));
  const cat = await app.catalogTools.list_models({ source: "catalog", limit: 40 });
  assert.ok(cat.models.every((m) => m.trained === undefined));
  const tr = await app.catalogTools.list_models({ source: "trained", limit: 40 });
  assert.ok(tr.models.length >= 10);
  const low = tr.models.find((m) => m.model_id === "model_JJ54CEwcWD5upeaCuLD83Ddh");
  assert.deepEqual([low.trained_kind, low.base_model_ids[0], low.default_scale, low.make_new, low.edit_route, low.supported, low.public, low.experimental], ["lora", "model_bfl-flux-2-dev", 0.8, true, "reference", true, true, true]);
  const kontext = tr.models.find((m) => m.trained_type === "flux.1-kontext-lora");
  assert.equal(kontext.supported, false);
  assert.deepEqual((await app.catalogTools.list_models({ query: "topaz" })).models.map((m) => m.model_id), ["model_topaz-image-upscale"]);
  await assert.rejects(app.catalogTools.list_models({ cursor: "bogus" }), (e) => e.type === "InvalidParameter");
  await assert.rejects(app.catalogTools.list_models({ lane: "video" }), (e) => e.type === "InvalidParameter");
});

test("model pictures: the thumbnail of a trained model, else the first example image, from the public thumbnail path", () => {
  const thumbs = require("../../plugin/src/ui/thumbs.js");
  const base = { id: "model_abc", name: "A" };
  const trained = catalogMod.displayRow({ ...base, thumbnail: { assetId: "asset_T1", url: "https://cdn.cloud.scenario.com/assets-transform/asset_T1?sig" }, exampleAssetIds: ["asset_E1"] });
  assert.equal(trained.thumb, "asset_T1");
  assert.equal(catalogMod.displayRow({ ...base, exampleAssetIds: ["asset_E1", "asset_E2"] }).thumb, "asset_E1");
  assert.equal(catalogMod.displayRow({ ...base, exampleAssetIds: ["../x"] }).thumb, null);
  assert.equal(catalogMod.displayRow(base).thumb, null);
  // No signed link is kept: the picture comes from the file host's public path, without a key.
  assert.equal(thumbs.modelThumb(trained), "https://cdn.cloud.scenario.com/thumbnails/asset_T1");
  assert.equal(thumbs.modelThumb({ thumb: "javascript:alert(1)" }), null);
  assert.equal(thumbs.resultThumb("Scenario/image/20261019/a-take1.png"), "plugin-data:/Scenario/image/20261019/a-take1.png");
  for (const bad of ["/etc/passwd", "../x.png", "file:///x.png", "", null, "Scenario/video/20261020/a-clip.mp4"]) assert.equal(thumbs.resultThumb(bad), null);
});
