"use strict";
// The lanes and the picker in a DOM built from the real index.html, booted
// through main.js against the M2.0 fixture mock: the price on the Generate
// button for the three families (M2 exit), the button's other labels, the
// 400 ms debounce, the picker (tabs, chips, search, favorites, choosing a
// model), and the button staying disabled in this build.

const test = require("node:test");
const assert = require("node:assert/strict");
const main = require("../../plugin/src/main.js");
const lanesMod = require("../../plugin/src/ui/lanes.js");
const pickerMod = require("../../plugin/src/ui/picker.js");
const catalogMod = require("../../plugin/src/catalog/catalog.js");
const { createFakeDocument } = require("../helpers/fake-dom.js");
const { startFixtureScenario, catalogRows, records } = require("../helpers/fixture-scenario.js");
const { newKeyPair, projectRecord } = require("../helpers/mock-scenario.js");
const { fakeHost, uxpWebSocket, freePort, newToken, waitFor, sleep } = require("../helpers/fakes.js");

const T = lanesMod.TEXT;

async function bootPanel(t, { docs, active, mockOpts = {} } = {}) {
  const pair = newKeyPair();
  const mock = await startFixtureScenario({ accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "Panel project" })] }], ...mockOpts });
  const port = await freePort();
  const host = fakeHost({ WebSocket: uxpWebSocket({ rewrite: (u) => u.replace(":9890", `:${port}`) }), secure: [["scenario.pairing_token", newToken()]], docs, active });
  const doc = createFakeDocument();
  const app = await main.boot({ host, document: doc, console: null, apiBaseUrl: mock.url });
  t.after(async () => {
    app.link.stop();
    await mock.close();
  });
  doc.paste("signin-key", `${pair.key}:${pair.secret}`);
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });
  return { app, host, doc, mock, pair };
}

const button = (doc) => doc.text("generate");
const lane = (doc, id) => doc.lanes.find((b) => b.getAttribute("data-lane") === id);
async function priced(doc, label) {
  await waitFor(() => button(doc) === label, { label: `button reads ${label}`, timeout: 4000 });
}

test("no price check before the panel is shown or used; the Generate button is disabled with the build note", async (t) => {
  const { doc, mock, host } = await bootPanel(t);
  await sleep(lanesMod.DEBOUNCE_MS + 150);
  assert.equal(mock.requests.filter((r) => r.path !== "/v1/models" || r.query.pageSize !== "1").filter((r) => r.path !== "/v1/projects").length, 0, "only the sign-in reads");
  assert.equal(button(doc), "Generate");
  assert.equal(doc.byId("generate").getAttribute("disabled"), "");
  assert.equal(doc.text("generate-note"), T.not_built);
  assert.equal(doc.byId("prompt").value, T.sample_prompt, "first run: a sample prompt");
  host.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
});

test("M2 exit on the button: Image default 2 CU, Edit default (capture and mask pending) 3 CU, Remove BG 1 CU, Upscale by size", async (t) => {
  const docs = [
    { id: 101, title: "square.psd", width: 1024, height: 1024 },
    { id: 102, title: "large.psd", width: 4096, height: 4096 }
  ];
  const { doc, host, mock, app } = await bootPanel(t, { docs, active: 101 });
  host.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
  assert.equal(doc.text("model-name"), "GPT Image 2.5 Flare");
  assert.equal(doc.text("lane-source"), "Target: canvas 1024 x 1024");
  assert.equal(doc.byId("size-select").value, "1024x1024", "the preset nearest the canvas aspect, smallest first");
  assert.equal(doc.byId("takes-select").value, "1");
  assert.ok(doc.shown("size-row") && doc.shown("takes-row"));

  lane(doc, "edit").click();
  await priced(doc, "Generate (3 CU)");
  assert.equal(doc.byId("takes-select").value, "2", "Edit defaults to 2 takes");
  assert.equal(doc.text("lane-source"), "Source: canvas 1024 x 1024, sent at 1024 x 1024");
  assert.equal(mock.uploads.length, 0, "the capture and the mask are priced without any upload");
  assert.match(doc.text("model-badges"), /Mask input/);

  lane(doc, "enhance").click();
  assert.ok(doc.shown("enhance-tools"));
  await priced(doc, "Generate (10 CU)");
  assert.equal(doc.text("model-name"), "Topaz Image Upscale");
  assert.equal(doc.byId("factor-select").value, "2x");
  assert.equal(doc.text("lane-output"), "Output 2048 x 2048");
  assert.ok(!doc.shown("takes-row"));

  doc.byId("tool-remove_background").click();
  await priced(doc, "Generate (1 CU)");
  assert.deepEqual(mock.uploads.map((u) => u.name), ["photoshop-standin-1024x1024.png", "photoshop-standin-256x256.png"]);

  host.active = 102;
  doc.byId("tool-upscale").click();
  await priced(doc, "Generate (40 CU)");
  assert.equal(doc.text("lane-output"), "Output 4096 x 4096 (this model's largest output)");
  doc.byId("tool-remove_background").click();
  await priced(doc, "Generate (1 CU)");
  assert.equal(doc.text("lane-output"), "Mask at 50% of the layer's resolution");
  assert.equal(mock.uploads.length, 3, "the small stand-in is reused at any size");
  assert.equal(doc.byId("generate").getAttribute("disabled"), "", "still disabled: generation comes next");
  assert.deepEqual(mock.violations, []);
  for (const r of mock.requests.filter((x) => x.path.startsWith("/v1/generate"))) assert.equal(r.search, "?dryRun=true");
  assert.equal(app.lanes.state().price.quote.cu_cost_exact, "1");
});

test("the other labels: Expand and Trained show why there is no price, Library has no prompt bar, no document blocks Edit", async (t) => {
  const { doc, host } = await bootPanel(t);
  host.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
  lane(doc, "enhance").click();
  doc.byId("tool-expand").click();
  await priced(doc, "Price unavailable");
  assert.equal(doc.text("generate-reason"), T.expand_later);
  lane(doc, "trained").click();
  assert.equal(button(doc), "Price unavailable");
  assert.equal(doc.text("generate-reason"), T.trained_later);
  lane(doc, "library").click();
  assert.ok(!doc.shown("prompt-bar"));
  assert.equal(doc.text("lane-note"), T.library_later);
  host.docs = [];
  host.active = null;
  lane(doc, "edit").click();
  await priced(doc, "Price unavailable");
  assert.equal(doc.text("generate-reason"), T.no_document);
  lane(doc, "image").click();
  await priced(doc, "Generate (2 CU)");
  assert.equal(doc.text("lane-source"), "Target: a new document");
});

test("the form: an empty prompt has no price; takes and the 400 ms debounce; one price check per pause", async (t) => {
  const { doc, host, mock } = await bootPanel(t);
  host.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
  doc.type("prompt", "");
  await priced(doc, "Price unavailable");
  assert.equal(doc.text("generate-reason"), "Prompt is required by this model.");
  const before = mock.priceChecks.length;
  for (const text of ["a", "a c", "a ca", "a cat"]) {
    doc.type("prompt", text);
    await sleep(50);
  }
  await priced(doc, "Generate (2 CU)");
  await sleep(lanesMod.DEBOUNCE_MS);
  assert.equal(mock.priceChecks.length, before + 1, "typing quickly sends one price check");
  doc.byId("takes-select").value = "2";
  doc.byId("takes-select").dispatch("change");
  await priced(doc, "Generate (3 CU)");
  assert.equal(mock.priceChecks.at(-1).body.numOutputs, 2);
});

test("picker: the lane's tab and tool chip, search, favorites kept on disk, choosing a model; trained rows browse only", async (t) => {
  const { doc, host, app } = await bootPanel(t);
  host.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
  lane(doc, "enhance").click();
  await priced(doc, "Generate (10 CU)");
  doc.byId("model-change").click();
  assert.ok(doc.shown("view-picker") && !doc.shown("lane-body") && !doc.shown("prompt-bar"));
  await waitFor(() => doc.byId("picker-list").children.length > 0, { label: "rows" });
  assert.equal(doc.byId("picker-tab-enhance").getAttribute("selected"), "");
  const chips = doc.byId("picker-chips").children;
  assert.deepEqual(chips.map((c) => c.textContent), ["All", "Favorites", "Recommended", "Upscale", "Expand", "Remove BG"]);
  assert.equal(chips.find((c) => c.getAttribute("selected") === "").textContent, "Upscale");
  const rowIds = () => doc.byId("picker-list").children.map((r) => r.getAttribute("data-model"));
  assert.equal(rowIds()[0], "model_topaz-image-upscale");
  assert.ok(rowIds().every((id) => ["model_topaz-image-upscale", "model_sc-upscale-flux", "model_recraft-crisp-upscale", "model_p-image-upscale"].includes(id)));
  const tags = doc.byId("picker-tags").children.map((o) => o.getAttribute("value"));
  assert.equal(tags[0], "");
  assert.ok(!tags.some((x) => x.startsWith("sc:")));

  // Favorites: the star, kept in the data folder, listed first.
  const recraft = () => doc.byId("picker-list").children.find((r) => r.getAttribute("data-model") === "model_recraft-crisp-upscale");
  recraft().children[0].children[1].click();
  assert.equal(rowIds()[0], "model_recraft-crisp-upscale");
  assert.deepEqual(JSON.parse(host.files.get(pickerMod.FAVORITES_FILE)).ids, ["model_recraft-crisp-upscale"]);

  // Search across the tab; then choose 851 Labs from the Remove BG tool.
  chips.find((c) => c.textContent === "All").click();
  doc.type("picker-search", "851");
  assert.deepEqual(rowIds(), ["model_851-labs-background-remover"]);
  doc.byId("picker-list").children[0].children[0].children[0].click();
  assert.ok(!doc.shown("view-picker") && doc.shown("lane-body") && doc.shown("prompt-bar"));
  await priced(doc, "Generate (1 CU)");
  assert.equal(doc.byId("tool-remove_background").getAttribute("selected"), "", "the tool follows the chosen model");
  assert.equal(app.lanes.state().model_id, "model_851-labs-background-remover");

  // Trained: rows show their kind and base once the bases are read; Use is disabled.
  doc.byId("model-change").click();
  doc.byId("picker-clear").click();
  doc.byId("picker-tab-trained").click();
  await waitFor(() => doc.byId("picker-list").children.some((r) => /via/.test(r.children[2] ? r.children[2].textContent : "")), { label: "trained badges" });
  const lowPoly = doc.byId("picker-list").children.find((r) => r.getAttribute("data-model") === "model_JJ54CEwcWD5upeaCuLD83Ddh");
  assert.match(lowPoly.children[2].textContent, /^LoRA via .+ · Public · Edit: Experimental$/);
  assert.equal(lowPoly.children[0].children[0].getAttribute("disabled"), "");
  assert.equal(lowPoly.children.at(-1).textContent, pickerMod.TEXT.use);
  assert.equal(lowPoly.children.at(-1).getAttribute("disabled"), "");
  doc.byId("picker-back").click();
  assert.ok(doc.shown("lane-body"));
});

test("a model that disables refunds says so under the button; a price check that returns a job stops price checks", async (t) => {
  const noRefund = { ...records["model_851-labs-background-remover"], id: "model_fixture-norefund", name: "No refund remover", disableRefund: true };
  let withJob = false;
  const { doc, host, app, mock } = await bootPanel(t, {
    mockOpts: {
      extraRecords: { [noRefund.id]: noRefund },
      answer: (model) => (withJob ? { status: 200, body: { job: { jobId: "job_fixtureAlarm" }, creativeUnitsCost: 1 } } : model === noRefund.id ? { status: 269, body: { creativeUnitsCost: 1, creativeUnitsDiscount: 0, costDetails: { "custom-generation": 1 } } } : null)
    }
  });
  host.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
  lane(doc, "enhance").click();
  doc.byId("tool-remove_background").click();
  await priced(doc, "Generate (1 CU)");
  app.picker.open("enhance", "remove_background");
  assert.equal(app.lanes.choose(catalogMod.displayRow(noRefund, false)), "enhance");
  app.picker.close();
  await waitFor(() => doc.text("model-name") === "No refund remover" && button(doc) === "Generate (1 CU)", { label: "no-refund model priced" });
  assert.equal(doc.text("generate-refund"), T.no_refund);
  withJob = true;
  lane(doc, "image").click();
  await priced(doc, "Price unavailable");
  assert.equal(doc.text("generate-reason"), T.alarm);
  const sent = mock.priceChecks.length;
  lane(doc, "edit").click();
  await priced(doc, "Price unavailable");
  await sleep(lanesMod.DEBOUNCE_MS + 100);
  assert.equal(mock.priceChecks.length, sent, "no price check after the alarm");
  assert.equal(doc.text("generate-reason"), T.alarm);
});

test("sizes and shaping helpers", () => {
  const sizes = [
    { width: 1024, height: 1024 },
    { width: 2048, height: 2048 },
    { width: 1536, height: 1024 },
    { width: 1024, height: 1536 }
  ];
  assert.deepEqual(lanesMod.nearestSize(sizes, { width: 3000, height: 3000 }), { width: 1024, height: 1024 });
  assert.deepEqual(lanesMod.nearestSize(sizes, { width: 3000, height: 2000 }), { width: 1536, height: 1024 });
  const grid = { kind: "grid", step: 16, min: 16, max: 3840 };
  assert.deepEqual(lanesMod.shapeBox({ width: 1000, height: 1000 }, grid), { width: 1008, height: 1008 }, "rounded up to the grid");
  assert.deepEqual(lanesMod.shapeBox({ width: 6000, height: 4000 }, grid), { width: 2048, height: 1376 }, "read at 2048 on the long side");
  assert.equal(catalogRows.length > 40, true);
});
