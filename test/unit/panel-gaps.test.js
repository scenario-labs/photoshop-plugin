"use strict";
// The creation panel's gaps to the approved prototype (FLOWS v2): Suggest
// in the prompt (Prompt Spark, sent only when its price check says 0 CU),
// the Change amount on every edit model with a strength input, the model
// menu's letters and prices, and Flare's first reference priced at Medium.
// The plugin source on the fake Photoshop modules, against the fixture mock.

const test = require("node:test");
const assert = require("node:assert/strict");
const ctlMod = require("../../plugin/src/panel/controller.js");
const schemaMod = require("../../plugin/src/forms/schema.js");
const editMod = require("../../plugin/src/lanes/edit.js");
const spark = require("../../plugin/src/scenario/spark.js");
const catalogMap = require("../../shared/catalog-map.json");
const { records } = require("../helpers/fixture-scenario.js");
const { bootGenerate, FLARE } = require("../helpers/generate-sim.js");
const { waitFor, sleep } = require("../helpers/fakes.js");

const POSTER = { id: 7, title: "poster.psd", width: 1024, height: 1024 };

function attached(doc, el) {
  for (let n = el; n; n = n.parentNode) if (n.id && doc.els.get(n.id) === n) return true;
  return false;
}
function findAll(doc, attr, value) {
  return doc.all.filter((e) => e.getAttribute(attr) !== null && (value === undefined || e.getAttribute(attr) === String(value)) && attached(doc, e));
}
function inPop(doc, e) {
  for (let n = e; n; n = n.parentNode) if (n === doc.byId("pop")) return true;
  return false;
}
async function shown(app, ps, doc) {
  ps.entrypoints.panels.scenarioPanel.show();
  await waitFor(() => app.controller.state().active, { label: "panel shown" });
  await waitFor(() => doc.text("ctx-title").startsWith("Background"), { label: "layer context" });
}
async function openPop(doc, kind) {
  const [chip] = findAll(doc, "data-pop", kind);
  assert.ok(chip, `a ${kind} control`);
  chip.click();
  await waitFor(() => doc.byId("pop").getAttribute("data-menu") === kind && doc.byId("pop").style.display !== "none", { label: `${kind} open` });
}
const texts = (doc) => doc.byId("pop").textContent;
function flarePrice() {
  return (model, body) => (model !== FLARE ? null : { status: 269, body: { creativeUnitsCost: 1 + (Number(body.numOutputs) || 1), creativeUnitsDiscount: 0, costDetails: {} } });
}

test("Suggest from a short prompt: price-checked first, sent at 0 CU, three proposals without dashes; picking one replaces the prompt and the run keeps the short prompt as its name", async (t) => {
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [POSTER], active: 7, mockOpts: { answer: flarePrice() } });
  await shown(app, ps, doc);
  doc.type("prompt", "a red fox");
  await sleep(ctlMod.DEBOUNCE_MS + 100);
  await openPop(doc, "suggest");
  await waitFor(() => findAll(doc, "data-sug").filter((e) => inPop(doc, e)).length === 3, { label: "three proposals", timeout: 5000 });
  assert.ok(texts(doc).includes("Free"), "the menu says it is free");
  const checks = mock.priceChecks.filter((c) => c.model === "prompt");
  assert.equal(checks.length, 1, "one price check");
  assert.equal(checks[0].search, "?dryRun=true");
  assert.equal(mock.sparkCalls.length, 1, "sent once, after the check");
  const sent = mock.sparkCalls[0].body;
  assert.deepEqual({ ...sent, prompt: undefined }, { mode: "contextual-v2", modelId: FLARE, numResults: 3, prompt: undefined });
  const [mine, rules] = sent.prompt.split("\n\nConstraints: ");
  assert.equal(mine, "a red fox", "the person's prompt, then the constraints paragraph");
  assert.match(rules, /^The result fills 1024 x 1024 px \(square\); do not propose another size\./, "the document size");
  assert.match(rules, /Keep the style and medium of the picture/, "no restyle against the Style chip");
  assert.match(rules, /Leave out sizes, resolution and quality settings\.$/);
  assert.doesNotMatch(rules, /cut-out/, "not a cut-out");
  const items = findAll(doc, "data-sug").map((e) => e.getAttribute("title"));
  for (const s of items) assert.ok(!/[\u2014\u2013]/.test(s), "no em or en dash in a proposal");
  assert.equal(app.ledger.all().length, 0, "Suggest keeps no job record");
  findAll(doc, "data-sug", 0)[0].click();
  assert.equal(doc.byId("pop").style.display, "none");
  await waitFor(() => doc.byId("prompt").value === items[0], { label: "prompt replaced" });
  await waitFor(() => doc.byId("go").getAttribute("aria-disabled") === "false", { label: "priced", timeout: 5000 });
  doc.byId("go").click();
  await waitFor(() => app.ledger.all().some((r) => r.state === "applied"), { label: "landed", timeout: 8000 });
  assert.equal(mock.paidCalls[0].body.prompt, items[0], "the run sends the picked prompt");
  assert.equal(app.ledger.all()[0].name, "a red fox", "and keeps the short prompt as its name");
});

test("Suggest with a price is not sent: the menu says the price; an empty prompt describes the active layer from a small picture", async (t) => {
  let cu = 3;
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [POSTER], active: 7, mockOpts: { answer: flarePrice(), sparkPrice: () => ({ status: 269, body: { creativeUnitsCost: cu, creativeUnitsDiscount: 0, costDetails: {} } }) } });
  await shown(app, ps, doc);
  doc.type("prompt", "a red fox");
  await sleep(ctlMod.DEBOUNCE_MS + 100);
  await openPop(doc, "suggest");
  await waitFor(() => texts(doc).includes("nothing was sent"), { label: "priced", timeout: 5000 });
  assert.ok(texts(doc).includes("3 CU"));
  assert.ok(!texts(doc).includes("Prompt Spark · Free"), "the title does not say free at a price");
  assert.equal(mock.sparkCalls.length, 0, "nothing sent at a price");
  doc.byId("pop-scrim").click();

  cu = 0;
  doc.type("prompt", "");
  await sleep(ctlMod.DEBOUNCE_MS + 100);
  await openPop(doc, "suggest");
  await waitFor(() => mock.sparkCalls.length === 1, { label: "described", timeout: 5000 });
  const body = mock.sparkCalls[0].body;
  assert.ok(body.prompt.startsWith(spark.DESCRIBE + "\n\nConstraints: "), "no prompt of the person's: a description is asked for, with the constraints");
  assert.equal(body.images.length, 1);
  assert.ok(body.images[0].startsWith("data:image/"), "the layer as a data link, nothing uploaded");
  await waitFor(() => texts(doc).includes("describes the Background layer"), { label: "says what it describes", timeout: 5000 });
});

test("spark.clean turns dashes into commas; bodyFor needs a prompt or a picture and caps the count at 5", () => {
  assert.equal(spark.clean("A fox \u2014 red\u2013orange  fur"), "A fox, red, orange fur");
  assert.throws(() => spark.bodyFor({ model_id: FLARE, prompt: " " }));
  assert.equal(spark.bodyFor({ model_id: FLARE, prompt: "x", n: 9 }).numResults, 5);
  assert.equal(spark.bodyFor({ model_id: FLARE, prompt: "x" }).prompt, "x", "no constraints, the prompt as typed");
  const cut = spark.bodyFor({ model_id: FLARE, prompt: "a knight", constraints: ["The subject is a cut-out on a transparent background; do not add a background.", " "] });
  assert.equal(cut.prompt, "a knight\n\nConstraints: The subject is a cut-out on a transparent background; do not add a background.");
  assert.equal(spark.bodyFor({ model_id: FLARE, prompt: "y".repeat(2500), constraints: ["Keep it."] }).prompt.length, 2000, "the constraints survive the length cap");
  assert.ok(spark.bodyFor({ model_id: FLARE, prompt: "y".repeat(2500), constraints: ["Keep it."] }).prompt.endsWith("Constraints: Keep it."));
  assert.equal(spark.clean("A knight in armor.\n\nConstraints: no background."), "A knight in armor.", "an echoed constraints paragraph is dropped");
});

test("Change amount on every edit model with a strength input: Subtle to Free map onto the model's own range; none for a model without one", () => {
  const ctx = { doc: { id: 7, width: 1024, height: 1024, title: "poster.psd" }, selection: null, selection_raw: null, layer: { id: 1, name: "Background", visible: true, bounds: { left: 0, top: 0, width: 1024, height: 1024 }, kind: "pixel", background: true, locked: false, has_mask: false } };
  const S = (id) => schemaMod.normalize(records[id]);
  const z = editMod.editView(S("model_z-image"), ctx, { change: 0.55, prompt: "x" });
  assert.equal(z.request.parameters.strength, 0.55);
  assert.equal(z.controls.change_amount.value, 0.55);
  const flux = editMod.editView(S("model_bfl-flux-1-dev"), ctx, { change: 0.15, prompt: "x" });
  assert.equal(flux.request.parameters.strength, 0.16, "0.01 to 1, at 15 %");
  const flare = editMod.editView(S("model_openai-gpt-image-2-5-flare"), ctx, { change: 0.55, prompt: "x" });
  assert.equal(flare.request.parameters.strength, undefined);
  assert.ok(!flare.controls.change_amount);
  assert.equal(editMod.strengthAt({ min: 0, max: 1 }, 2), 1, "clamped");
});

test("Flare prices its first reference except at Low quality (measured 2026-10-20)", () => {
  const rule = catalogMap.models[FLARE].price_inputs.referenceImages;
  assert.equal(rule.free, 1);
  assert.deepEqual(rule.free_when, { quality: ["low"] });
});

test("model menu: each model shows its letters, and its price once its free price check answers", async (t) => {
  const any = (model, body) => ({ status: 269, body: { creativeUnitsCost: model === FLARE ? 1 + (Number(body.numOutputs) || 1) : 4, creativeUnitsDiscount: 0, costDetails: {} } });
  const { app, doc, ps } = await bootGenerate(t, { docs: [POSTER], active: 7, mockOpts: { answer: any } });
  await shown(app, ps, doc);
  await sleep(ctlMod.DEBOUNCE_MS + 100);
  await openPop(doc, "model");
  const rows = () => findAll(doc, "data-value").filter((e) => inPop(doc, e));
  assert.ok(rows().length >= 1);
  for (const r of rows()) {
    const letters = r.all ? null : (r.children || []).flatMap((c) => [c, ...(c.children || [])]).find((c) => /\b(mono|tm)\b/.test(c.className || ""));
    assert.ok(letters && letters.textContent.trim().length > 0, "a model shows its letters");
  }
  const right = (e) => (e.children.find((c) => c.className === "r") || { textContent: "" }).textContent;
  const flare = () => rows().find((e) => e.textContent.includes("GPT Image 2.5 Flare"));
  await waitFor(() => /^\d+ CU$/.test(right(flare())), { label: "Flare priced", timeout: 5000 });
  const z = () => rows().find((e) => e.getAttribute("data-value") === "model_z-image");
  await waitFor(() => right(z()) === "4 CU", { label: "another model priced by its own check", timeout: 5000 });
});

test("Suggest on a cut-out: Add background asks for the background only; Make versions asks for no background", async (t) => {
  const DOC = { ...POSTER, layers: [{ name: "Bottle", kind: "pixel", frame: { left: 300, top: 200, width: 400, height: 600 } }, { name: "Background", background: true }] };
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [DOC], active: 7, mockOpts: { answer: flarePrice() } });
  ps.entrypoints.panels.scenarioPanel.show();
  await waitFor(() => doc.text("ctx-title").startsWith("Bottle"), { label: "cut-out context" });
  assert.equal(app.controller.state().action, "background");
  doc.type("prompt", "a marble counter");
  await sleep(ctlMod.DEBOUNCE_MS + 100);
  await openPop(doc, "suggest");
  await waitFor(() => mock.sparkCalls.length === 1, { label: "sent", timeout: 5000 });
  assert.match(mock.sparkCalls[0].body.prompt, /^a marble counter\n\nConstraints: The result fills 1024 x 1024 px/);
  assert.match(mock.sparkCalls[0].body.prompt, /describe only the new background behind it/);
  doc.byId("pop-scrim").click();
  findAll(doc, "data-act", "versions")[0].click();
  await sleep(ctlMod.DEBOUNCE_MS + 100);
  await openPop(doc, "suggest");
  await waitFor(() => mock.sparkCalls.length === 2, { label: "sent again", timeout: 5000 });
  assert.match(mock.sparkCalls[1].body.prompt, /cut-out on a transparent background; do not add a background/);
});
