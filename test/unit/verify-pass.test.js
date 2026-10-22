"use strict";
// Findings of the real-click verification pass of 2026-10-22 (Photoshop
// 27.11, every control pressed with real macOS mouse events), each held
// here through the panel's own code:
// - a redraw under a pressed button replaced the node, so the click was
//   lost: a redraw now waits for the release;
// - a menu opened at the last menu's scroll (Model opened on its last rows);
// - the Model menu of Make versions offered models the panel cannot give the
//   layer to (Gemini 3.1, Seedream 5.0 Pro, Grok Imagine), which then
//   blocked the button;
// - an approved agent spend came back with live buttons, and Decline said
//   nothing was spent while the charge went on;
// - the Library kept another project's images after a switch, and an error
//   stayed until another filter was clicked.

const test = require("node:test");
const assert = require("node:assert/strict");
const map = require("../../plugin/src/catalog/map.js");
const libraryMod = require("../../plugin/src/panel/library.js");
const { bootGenerate } = require("../helpers/generate-sim.js");
const { waitFor } = require("../helpers/fakes.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAYER_DOC = { id: 7, title: "poster.psd", width: 1024, height: 1024, layers: [{ name: "Hero", kind: "pixel", frame: { left: 0, top: 0, width: 1024, height: 1024 } }, { name: "Background", background: true }] };

function attached(doc, el) {
  for (let n = el; n; n = n.parentNode) if (n.id && doc.els.get(n.id) === n) return true;
  return false;
}
function findAll(doc, attr, value) {
  return doc.all.filter((e) => e.getAttribute(attr) !== null && (value === undefined || e.getAttribute(attr) === String(value)) && attached(doc, e));
}
async function show(app, ps) {
  ps.entrypoints.panels.scenarioPanel.show();
  await waitFor(() => app.controller.state().active, { label: "panel shown" });
}

test("a redraw waits while the mouse button is down, so the pressed chip is still the one in the panel at the click", async (t) => {
  const { app, ps, doc } = await bootGenerate(t, { docs: [] });
  await show(app, ps);
  const v = app.createView;
  await sleep(50);
  const chip = findAll(doc, "data-act", "library")[0];
  assert.ok(chip, "the Open from Library chip");
  const before = v.renders();
  doc.fire("mousedown");
  app.controller.selectAction("library");
  assert.equal(v.renders(), before, "no redraw under the pressed button");
  assert.ok(attached(doc, chip), "the pressed chip is still in the panel");
  doc.fire("mouseup");
  await waitFor(() => v.renders() > before, { label: "the held redraw after the release" });
  assert.equal(app.controller.state().action, "library");
});

test("a release the panel never sees ends the hold", async (t) => {
  const { app, ps, doc } = await bootGenerate(t, { docs: [] });
  await show(app, ps);
  const v = app.createView;
  await sleep(50);
  const before = v.renders();
  doc.fire("mousedown");
  app.controller.selectAction("library");
  assert.equal(v.renders(), before);
  await waitFor(() => v.renders() > before, { label: "the redraw after the hold ran out", timeout: 4000 });
});

test("a menu opens at its top, not at the last menu's scroll", async (t) => {
  const { app, ps, doc } = await bootGenerate(t, { docs: [] });
  await show(app, ps);
  await app.createView.openPop("takes");
  const p = doc.byId("pop");
  assert.equal(app.createView.popKind(), "takes");
  p.scrollTop = 404;
  app.createView.closePop();
  await app.createView.openPop("takes");
  assert.equal(p.scrollTop, 0);
});

test("the Model menu of an action on the layer lists only models that can take the layer; All models refuses the others", async (t) => {
  const { app, ps } = await bootGenerate(t, { docs: [LAYER_DOC], active: 7 });
  await show(app, ps);
  const ctl = app.controller;
  ctl.selectAction("versions");
  await waitFor(() => ctl.state().action === "versions", { label: "Make versions" });
  await app.catalog.ensure();
  const mm = await ctl.menu("model");
  const cat = mm.groups.filter((g) => /^Catalog/.test(g.title || "")).flatMap((g) => g.items);
  assert.ok(cat.length > 0, "catalog models are offered");
  for (const it of cat) {
    const s = await app.catalog.schema(it.value);
    assert.ok(s && s.capture_input_name, it.value + " takes the layer");
  }
  // One of them as a model with no input the plugin can fill (as Gemini
  // 3.1, Seedream 5.0 Pro and Grok Imagine read live): no longer offered.
  const victim = cat[0].value;
  const realSchema = app.catalog.schema;
  app.catalog.schema = async (id) => (id === victim ? { ...(await realSchema(id)), capture_input_name: null } : realSchema(id));
  const mm2 = await ctl.menu("model");
  const cat2 = mm2.groups.filter((g) => /^Catalog/.test(g.title || "")).flatMap((g) => g.items);
  assert.ok(!cat2.some((i) => i.value === victim), "not offered in the menu");
  const refused = app.catalog.find(victim);
  const ok = await ctl.chooseModel(refused);
  assert.equal(ok, false);
  assert.equal(ctl.state().models["edit"], undefined, "the Model chip did not change");
  assert.match(ctl.state().note, /can't take the layer/);
});

test("an approved agent spend keeps its card without buttons; Decline cannot claim nothing was spent", async (t) => {
  const { app, ps, doc } = await bootGenerate(t, { docs: [] });
  await show(app, ps);
  const ctl = app.controller;
  let declined = 0;
  ctl.showAgentRequest({ client_name: "Codex", what: "make an image", cu: 5, busy: true, approve() {}, decline: () => declined++ });
  await sleep(20);
  assert.equal(doc.byId("agent-card").style.display, "flex");
  assert.equal(doc.text("agent-approve-label"), "Approved, sending");
  assert.equal(doc.byId("agent-decline").style.display, "none");
  ctl.agentDecision(false);
  assert.equal(declined, 0, "a busy request is not declined");
  assert.notEqual(ctl.state().note, ctl.TEXT.declined);
  assert.equal(doc.byId("agent-card").style.display, "flex", "the card stays until the approval ends");
});

test("the Library reads each project's own images, and its error has Try again", async (t) => {
  // The list cache is per project.
  let acct = { id: "acct_a" };
  let reads = 0;
  const lib = libraryMod.createLibrary({
    client: { request: async () => (reads++, { status: 200, body: { assets: [] } }) },
    account: () => acct
  });
  await lib.list(false, "all");
  await lib.list(false, "all");
  const one = reads;
  acct = { id: "acct_b" };
  await lib.list(false, "all");
  assert.ok(reads > one, "another project reads its own list");

  // Try again after an error.
  const { app, ps, doc } = await bootGenerate(t, { docs: [] });
  await show(app, ps);
  app.library.list = async () => {
    throw Object.assign(new Error("offline"), { type: "Network" });
  };
  app.controller.selectAction("library");
  await waitFor(() => findAll(doc, "data-lib-retry", "1").length === 1, { label: "Try again under the error" });
  app.library.list = async () => ({ rows: [], more: false });
  findAll(doc, "data-lib-retry", "1")[0].click();
  await waitFor(() => app.controller.model().composer.library.state === "ready", { label: "the list read again" });
  app.controller.resetLibrary();
  assert.equal(app.controller.model().composer.library.state !== "error", true);
});

test("Upscale on a model with no factor setting shows no factor: the last one chosen on another model does not carry over", async (t) => {
  // P-Image Upscale and Recraft Crisp Upscale have no upscaleFactor; after
  // Topaz at ×6 the chip and the button still read ×6 and the menu offered ×2.
  const { app, ps, doc } = await bootGenerate(t, { docs: [{ id: 7, title: "poster.psd", width: 1024, height: 1024 }], active: 7 });
  await show(app, ps);
  const ctl = app.controller;
  const realSchema = app.catalog.schema;
  app.catalog.schema = async (id) => {
    const s = await realSchema(id);
    return s && id === "model_topaz-image-upscale" ? { ...s, parameters: s.parameters.filter((x) => x.name !== "upscaleFactor") } : s;
  };
  ctl.selectAction("upscale");
  await waitFor(() => ctl.state().action === "upscale", { label: "Upscale" });
  ctl.choose("upsize", "6x");
  const go = () => doc.text("go-label");
  await waitFor(() => { const pr = ctl.state().price; return pr && pr.view && pr.view.lane === "upscale" && pr.view.sizes; }, { label: "the Upscale view built" });
  await sleep(50);
  assert.ok(!/×/.test(go()), "no factor on the button: " + go());
  assert.deepEqual(doc.byId("cchips").children.map((c) => c.getAttribute("data-pop")), ["model"], "no factor chip");
});

test("Extend canvas leaves out the ratio the canvas already has; choosing it moves to the next target", async (t) => {
  // A 3:2 document was offered 3:2, and choosing it blocked the button
  // ("Already 3:2, pick another target").
  const { app, ps } = await bootGenerate(t, { docs: [LAYER_DOC], active: 7 });
  await show(app, ps);
  const ctl = app.controller;
  ctl.selectAction("extend");
  await waitFor(() => ctl.state().action === "extend", { label: "Extend canvas" });
  const mm = await ctl.menu("target");
  const keys = mm.items.map((i) => i.value);
  assert.ok(!keys.includes("1:1"), "a square canvas is not offered 1:1: " + keys.join(","));
  assert.ok(keys.includes("16:9"));
  ctl.choose("target", "1:1");
  const chip = () => ctl.model().composer.chips.find((c) => c.kind === "target");
  await waitFor(() => chip() && chip().value === "16:9", { label: "the chip moves to 16:9 (now " + (chip() && chip().value) + ")" });
});

test("Extend canvas: +20% each side moves to a ratio on a model that cannot extend per side", async (t) => {
  // After +20% on one model, switching to Photoroom Expand (center only)
  // blocked the button: "This model expands around the center."
  const { app, ps } = await bootGenerate(t, { docs: [LAYER_DOC], active: 7 });
  await show(app, ps);
  const ctl = app.controller;
  ctl.selectAction("extend");
  await waitFor(() => ctl.state().action === "extend", { label: "Extend canvas" });
  await app.catalog.ensure();
  ctl.choose("target", "+20");
  const ok = await ctl.chooseModel(app.catalog.find("model_photoroom-expand"));
  assert.notEqual(ok, false);
  const chip = () => ctl.model().composer.chips.find((c) => c.kind === "target");
  await waitFor(() => chip() && chip().value === "16:9", { label: "the chip moves to 16:9 (now " + (chip() && chip().value) + ")" });
  await waitFor(() => ctl.state().price.state !== "checking" && ctl.state().price.state !== "idle", { label: "priced" });
  assert.notEqual(ctl.state().price.reason, "This model expands around the center.");
});

test("Upscale on a source over the upload limit: the second Generate runs at the size that fits", async (t) => {
  // The panel kept no reduced size, so every Generate said "click Generate
  // again" and stopped again; the run never started.
  const TOPAZ = "model_topaz-image-upscale";
  const N = 1300;
  const noise = new Uint8Array(N * N * 3);
  let s = 7;
  for (let i = 0; i < noise.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    noise[i] = s >>> 24;
  }
  const DOC = { id: 7, title: "noise.psd", width: N, height: N, layers: [{ name: "Background", background: true, content: "raster", raster: { width: N, height: N, data: noise } }] };
  const cost = { status: 269, body: { creativeUnitsCost: 10, creativeUnitsDiscount: 0, costDetails: {} } };
  const { app, ps, doc, mock } = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true }, mockOpts: { answer: (model) => (model === TOPAZ ? cost : undefined) } });
  await show(app, ps);
  const ctl = app.controller;
  ctl.selectAction("upscale");
  const ready = () => ctl.state().action === "upscale" && ctl.state().price.state === "ready" && !ctl.state().sending;
  await waitFor(ready, { label: "Upscale priced" });
  doc.byId("go").click();
  await waitFor(() => /upload limit at/.test(ctl.state().note || ""), { label: "the reduced-size note" });
  assert.equal(mock.paidCalls.length, 0, "nothing spent on the first click");
  await waitFor(ready, { label: "priced again at the size that fits" });
  assert.ok(ctl.state().price.view.sizes.read.width < N, "the price is for the reduced read");
  doc.byId("go").click();
  await waitFor(() => mock.paidCalls.length === 1, { label: "the second Generate runs", timeout: 8000 });
  const up = mock.uploads.find((u) => u.name.startsWith("photoshop-capture-"));
  assert.ok(up && up.width < N, "uploaded at the reduced size");
});
