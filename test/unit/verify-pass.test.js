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

test("New layer inside a selection lands cut out and fitted in the selection, never as a box over the layer under it", async (t) => {
  // Live 2026-10-21: a New layer landed as an opaque full-canvas picture and
  // covered the lettering of the sheet under it.
  const FLARE = "model_openai-gpt-image-2-5-flare";
  const cost = { status: 269, body: { creativeUnitsCost: 2, creativeUnitsDiscount: 0, costDetails: {} } };
  const sel = { left: 600, top: 100, width: 300, height: 600 };
  const { app, ps, doc, mock } = await bootGenerate(t, { docs: [{ ...LAYER_DOC, selection: sel }], active: 7, mockOpts: { answer: (model) => (model === FLARE ? cost : undefined) } });
  await show(app, ps);
  const ctl = app.controller;
  ctl.selectAction("new_layer");
  // Before the prompt (no price yet) the line already says where it lands.
  await waitFor(() => /^Lands above .* inside the selection$/.test(ctl.model().ctx.detail), { label: "lands inside before the price" });
  ctl.setPrompt("a paper lantern");
  const ready = () => ctl.state().action === "new_layer" && ctl.state().price.state === "ready" && !ctl.state().sending;
  await waitFor(ready, { label: "New layer priced" });
  assert.match(ctl.model().ctx.detail, /inside the selection, cut out$/);
  const chip = ctl.model().composer.chips.find((c) => c.kind === "bg");
  assert.equal(chip && chip.value, "Cut out");
  // Full frame: the model's own background.
  await ctl.choose("bg", "full");
  await waitFor(() => ready() && ctl.model().composer.chips.find((c) => c.kind === "bg").value === "Full frame", { label: "Full frame priced" });
  assert.match(ctl.model().ctx.detail, /inside the selection$/);
  await ctl.choose("bg", "cutout");
  await waitFor(() => ready() && /cut out$/.test(ctl.model().ctx.detail), { label: "Cut out again" });
  doc.byId("go").click();
  await waitFor(() => app.ledger.all().some((r) => r.state === "applied"), { label: "landed", timeout: 8000 });
  const body = mock.paidCalls[0].body;
  assert.equal(body.background, "transparent");
  assert.ok(body.width < body.height, "sized to the tall selection");
  const d = ps.doc(7);
  const top = d.layers[0];
  const f = (top.layers ? top.layers[0] : top).frame;
  assert.ok(f.left >= sel.left - 1 && f.top >= sel.top - 1 && f.left + f.width <= sel.left + sel.width + 1 && f.top + f.height <= sel.top + sel.height + 1, `inside the selection (${JSON.stringify(f)})`);
  // Live 2026-10-23: GPT Image 2.5 Flare returned an opaque sky although
  // the request asked for a transparent background. The opaque take is cut
  // by Photoshop's Remove Background: a layer mask, the corners hidden. A
  // small layer comes back whole from Remove Background (live 27.11), so
  // the cut runs on the take scaled up to the canvas, then scaled back.
  const layer = top.layers ? top.layers[0] : top;
  const takes = top.layers ? top.layers.length : 1;
  assert.ok(ps.subjectCuts && ps.subjectCuts.length === takes && ps.subjectCuts.every((c) => c.big), "each take cut at canvas size");
  assert.ok(Math.abs(layer.frame.left - f.left) < 1 && Math.abs(layer.frame.width - f.width) < 1, "back in its frame");
  const m = layer.mask;
  assert.ok(m && m.data, "the take carries a mask");
  const at = (x, y) => m.data[(y - m.top) * m.width + (x - m.left)];
  assert.equal(at(m.left + 1, m.top + 1), 0, "the corner, outside the subject, is hidden");
  assert.equal(at(m.left + (m.width >> 1), m.top + (m.height >> 1)), 255, "the subject is kept");
  const rec = app.ledger.all().find((r) => r.state === "applied");
  assert.ok(rec.placement.notes.some((n) => /Remove Background cut it out/.test(n)), rec.placement.notes.join(" | "));
});

test("a blank document (File > New) offers Create image, made at the canvas's size and landing as a layer", async (t) => {
  // Live 2026-10-23: Create image lived only in the no-document context,
  // which Photoshop hides on its Home screen; a new blank document offered
  // Split into layers first.
  const BLANK = { id: 9, title: "Untitled-1", width: 1024, height: 1536, pattern: "blank", layers: [{ name: "Background", background: true }] };
  const FLARE = "model_openai-gpt-image-2-5-flare";
  const cost = { status: 269, body: { creativeUnitsCost: 8, creativeUnitsDiscount: 0, costDetails: {} } };
  const { app, ps, doc, mock } = await bootGenerate(t, { docs: [BLANK], active: 9, mockOpts: { answer: (model) => (model === FLARE ? cost : undefined) } });
  await show(app, ps);
  const ctl = app.controller;
  await waitFor(() => ctl.state().action === "create_canvas", { label: "blank context" });
  const chips = ctl.model().chips.map((c) => c.id || c.act || c.value);
  assert.equal(chips[0], "create_canvas", JSON.stringify(ctl.model().chips[0]));
  ctl.setPrompt("a cliff town at sunset");
  try {
    await waitFor(() => ctl.state().price.state === "ready" && !ctl.state().sending, { label: "priced" });
  } catch (e) {
    throw new Error(JSON.stringify(ctl.state().price) + " " + JSON.stringify(ctl.model().ctx));
  }
  assert.equal(ctl.model().ctx.detail, "Lands above Background at canvas size");
  assert.equal(ctl.model().ctx.title, "Blank canvas 1024 × 1536");
  doc.byId("go").click();
  await waitFor(() => app.ledger.all().some((r) => r.state === "applied"), { label: "landed", timeout: 8000 });
  const body = mock.paidCalls[0].body;
  assert.ok(body.width < body.height, "the canvas's 2:3, not the default square");
  assert.equal(ps.doc(9).layers.length, 2, "a layer above the Background, in the same document");
  assert.equal(ps.app.documents.length, 1, "no new document");
});

test("a flat picture is not blank: its context keeps Split into layers first", async (t) => {
  const FLAT = { id: 9, title: "poster.png", width: 1024, height: 1024, layers: [{ name: "Background", background: true }] };
  const { app, ps } = await bootGenerate(t, { docs: [FLAT], active: 9 });
  await show(app, ps);
  await waitFor(() => app.controller.state().action === "split", { label: "flat context" });
});

test("an opaque take is measured by its alpha: a real cut out is placed as it came", () => {
  const pixels = require("../../plugin/src/capture/pixels.js");
  const rgb = { width: 2, height: 2, components: 3, data: new Uint8Array(12) };
  assert.equal(pixels.opaqueShare(rgb), 1);
  const cut = { width: 2, height: 2, components: 4, data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255]) };
  assert.equal(pixels.opaqueShare(cut), 0.5);
  const veiled = { width: 1, height: 2, components: 4, data: new Uint8Array([9, 9, 9, 235, 9, 9, 9, 240]) };
  assert.equal(pixels.opaqueShare(veiled), 1, "a picture at alpha 0.92 still covers what is under it");
});

test("Formats lays a title out again on each artboard at its place in the frame, inside a margin, smaller only if it would not fit", () => {
  const morePlan = require("../../plugin/src/apply/more-plan.js");
  const src = { width: 1536, height: 1024 };
  // A title across the bottom of a 3:2 poster.
  const title = { left: 368, top: 820, width: 800, height: 140 };
  const inside = (f, r) => f.center_x - f.width / 2 >= r.left && f.center_x + f.width / 2 <= r.left + r.width && f.center_y - f.height / 2 >= r.top && f.center_y + f.height / 2 <= r.top + r.height;
  for (const r of [{ left: 0, top: 0, width: 1080, height: 1920 }, { left: 1180, top: 0, width: 1080, height: 1080 }, { left: 0, top: 0, width: 1920, height: 1080 }]) {
    const f = morePlan.titleFit(title, src, r);
    assert.ok(inside(f, r), `inside ${JSON.stringify(r)}: ${JSON.stringify(f)}`);
    assert.ok(Math.abs(f.center_x - (r.left + r.width / 2)) < 1, "still centered");
    const k = Math.min(r.width / src.width, r.height / src.height);
    assert.ok(Math.abs(f.scale - k) < 1e-9, "scaled like the picture");
    assert.ok(Math.abs(f.center_y - (r.top + r.height * (890 / 1024))) < 1, "at the same height in the frame");
  }
  // A title wider than the frame with its margin shrinks to fit.
  const wide = morePlan.titleFit({ left: 0, top: 10, width: 1536, height: 100 }, src, { left: 0, top: 0, width: 1080, height: 1080 });
  assert.ok(wide.width <= 1080 - 2 * Math.round(0.04 * 1080) + 1e-6);
  // The text box of a Split text mask, in document pixels.
  const mask = { width: 10, height: 5, data: new Uint8Array(50) };
  mask.data[2 * 10 + 3] = 255;
  mask.data[3 * 10 + 6] = 255;
  assert.deepEqual(morePlan.maskBox(mask, { left: 100, top: 50, width: 100, height: 50 }), { left: 130, top: 70, width: 40, height: 20 });
});

test("Formats reads the picture without its titles: they are hidden for the read only", async () => {
  const { createCapture } = require("../../plugin/src/capture/capture.js");
  const reads = [];
  const host = {
    overlayLayers: async () => [{ id: 41, name: "THE KITE KEEPER", kind: "type", box: { left: 0, top: 0, width: 10, height: 10 } }],
    readPixels: async (req) => {
      reads.push(req);
      return { width: 64, height: 32, components: 3, data: new Uint8Array(64 * 32 * 3) };
    },
    encodeJpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    ensureDataDir: async () => {},
    writeDataBinary: async () => {}
  };
  const cap = createCapture({ host });
  const spec = { document_id: 7, layer_id: null, box: { left: 0, top: 0, width: 64, height: 32 }, read_long: 64, capture_input: "image", jpeg_ok: true };
  await cap.source({ ...spec, without_titles: true });
  assert.deepEqual(reads[0].hide_ids, [41]);
  await cap.source(spec);
  assert.equal(reads[1].hide_ids, undefined, "other tools read everything visible");
});

test("Cut out subject keeps the selection's own shape, not only its box", async (t) => {
  const sel = { left: 200, top: 200, width: 400, height: 400, shape: "ellipse" };
  const answer = (model) => (model === "model_851-labs-background-remover" ? { status: 269, body: { creativeUnitsCost: 1, creativeUnitsDiscount: 0, costDetails: {} } } : undefined);
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 1024, selection: sel };
  const { app, ps, mock } = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true }, mockOpts: { answer } });
  await show(app, ps);
  const ctl = app.controller;
  ctl.selectAction("cutout");
  await waitFor(() => ctl.state().action === "cutout" && ctl.state().price.state === "ready", { label: "Cut out priced" });
  ctl.go();
  await waitFor(() => app.ledger.all().some((r) => r.state === "applied"), { label: "landed", timeout: 8000 });
  assert.equal(mock.paidCalls.length, 1);
  const m = ps.doc(7).layers[0].mask;
  const at = (x, y) => m.data[(y - m.top) * m.width + (x - m.left)];
  assert.ok(at(400, 400) > 200, "the middle is kept");
  assert.equal(at(205, 205), 0, "the corner of the box, outside the ellipse, is cut");
  // Photoshop reveals what lies outside a mask's written box: the mask is
  // made Hide All first, so a later Free Transform shows no edge line.
  assert.equal(m.outside, 0, "outside the mask's box stays hidden");
  assert.equal(ps.hideAllMasks, 1);
});

test("a layer's read keeps its mask: a cut-out sends what it shows, not what its mask hides", async (t) => {
  // Live 2026-10-23: New angle on a Cut out subject layer sent the sky and
  // the roof under the mask (getPixels leaves a layer's mask out).
  const mask = { left: 100, top: 100, width: 200, height: 200, data: new Uint8Array(200 * 200).fill(255) };
  const DOC = { id: 7, title: "poster.psd", width: 400, height: 400, layers: [{ name: "Keeper", kind: "smartObject", frame: { left: 0, top: 0, width: 400, height: 400 }, mask }, { name: "Background", background: true }] };
  const { host, ps } = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true } });
  const layer = ps.doc(7).layers[0];
  const alphaAt = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];
  const read = () => host.readPixels({ document_id: 7, layer_id: layer.id, bounds: { left: 0, top: 0, width: 400, height: 400 }, long_side: 200, exact: true });
  layer.mask.outside = 0;
  const hidden = await read();
  assert.deepEqual([hidden.width, hidden.height, hidden.components], [200, 200, 4]);
  assert.equal(alphaAt(hidden, 20, 20), 0, "outside a Hide All mask's box: clear");
  assert.equal(alphaAt(hidden, 100, 100), 255, "inside the mask: kept");
  layer.mask.outside = 255;
  assert.equal(alphaAt(await read(), 20, 20), 255, "outside a Reveal All mask's box: kept");
  layer.mask.enabled = false;
  layer.mask.outside = 0;
  assert.equal(alphaAt(await read(), 20, 20), 255, "a disabled mask is left out, as Photoshop shows the layer");
  assert.ok(ps.maskReads >= 2);
});

test("a Free Transform or a Move refreshes the context: the takes land where the layer is now", async (t) => {
  // Live 2026-10-23: New angle after a Free Transform landed on the layer's
  // old bounds; "transform" was not among the events the panel follows.
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 1024, layers: [{ name: "Keeper", kind: "pixel", frame: { left: 100, top: 100, width: 300, height: 400 } }, { name: "Background", background: true }] };
  const { app, ps } = await bootGenerate(t, { docs: [DOC], active: 7 });
  await show(app, ps);
  const ctl = app.controller;
  await waitFor(() => /\|300x400\|/.test(ctl.state().key), { label: "the first bounds" });
  ps.doc(7).layers[0].frame = { left: 100, top: 100, width: 450, height: 600 };
  ps.fire("transform");
  await waitFor(() => /\|450x600\|/.test(ctl.state().key), { label: "transform refreshes the context" });
  const follows = (name) => ps.notifications.some((n) => n.events.some((e) => e.event === name));
  assert.ok(follows("move") && follows("duplicate") && follows("paste"), "Move, Duplicate and Paste refresh it too");
});

test("Place in current document places a split whose own document is gone, when the canvas matches", async (t) => {
  // Live 2026-10-23: Jobs offered Place in current document on a Split into
  // layers row whose unsaved document had gone, and the place failed with
  // "Open … to place this result there".
  const calls = [];
  const placers = { split: { place: async (rec, ctx) => (calls.push(ctx.document_id), { document_id: ctx.document_id, layer_ids: [1], notes: [] }) } };
  const DOC = { id: 9, title: "copy.psd", width: 1024, height: 1536 };
  const { app } = await bootGenerate(t, { docs: [DOC], active: 9, placers });
  const target = { kind: "split", document_id: 4, document_title: "gone.psd", document_key: null, canvas: [1024, 1536], box: [0, 0, 1024, 1536] };
  const rec = await app.ledger.create({ state: "ready", idempotency_key: "q_split", fingerprint: "f_split", target, outputs: [] });
  await assert.rejects(app.runner.place(rec.local_id), (e) => e.type === "DocumentClosed");
  const done = await app.runner.place(rec.local_id, { current_document: true });
  assert.equal(done.state, "applied");
  assert.deepEqual(calls, [9]);
  // Another canvas size: refused, nothing placed.
  const rec2 = await app.ledger.create({ state: "ready", idempotency_key: "q_split2", fingerprint: "f_split2", target: { ...target, canvas: [800, 600] }, outputs: [] });
  await assert.rejects(app.runner.place(rec2.local_id, { current_document: true }));
  assert.deepEqual(calls, [9]);
});

test("Relight's mask grows past the layer's outline, so the original's soft edge under the take does not show as a line", async () => {
  // Live 2026-10-23: a relit keeper drawn a little narrower than the
  // original left a dull line of the original coat around her.
  const { createCapture } = require("../../plugin/src/capture/capture.js");
  const W = 200;
  const disc = (x, y) => ((x - 100) ** 2 + (y - 100) ** 2 <= 60 ** 2 ? 255 : 0);
  const host = {
    readPixels: async (req) => {
      const n = W * W;
      if (req.layer_id === 5) {
        const d = new Uint8Array(n * 4);
        for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) d[(y * W + x) * 4 + 3] = disc(x, y);
        return { width: W, height: W, components: 4, data: d };
      }
      return { width: W, height: W, components: 3, data: new Uint8Array(n * 3).fill(90) };
    },
    encodeJpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    ensureDataDir: async () => {},
    writeDataBinary: async () => {},
    writeDataText: async () => {}
  };
  const cap = createCapture({ host });
  const box = { left: 0, top: 0, width: W, height: W };
  const got = await cap.edit({ document_id: 7, canvas: { width: W, height: W }, layer_id: null, box, upload: { width: W, height: W }, selection: box, mask_layer_id: 5, capture_input: "image", mask_input: null, jpeg_ok: true });
  const m = got.memo.placement_mask;
  const at = (x, y) => m.data[(y - m.top) * m.width + (x - m.left)];
  assert.equal(at(100, 100), 255);
  assert.equal(at(162, 100), 255, "2 px past the outline: still the take");
  assert.equal(at(100, 40 - 2), 255, "above it too");
  assert.equal(at(170, 100), 0, "well outside: the original layer's own (empty) pixels");
});

test("Formats: the title lands inside each artboard, the second one too, even when the copy does not keep its place", async () => {
  // Live 2026-10-23: the 4:5 artboard, added beside a 9:16 one, got its
  // title outside the artboard and at the top of the stack: Photoshop
  // left the placed layer selected after the make, and the duplicated
  // title did not keep its source place.
  const { webcrypto } = require("node:crypto");
  const hostMod = require("../../plugin/src/host.js");
  const { createMorePlacers } = require("../../plugin/src/host-more.js");
  const { createFakePhotoshop } = require("../helpers/fake-photoshop.js");
  const { solidPng } = require("../helpers/fixture-scenario.js");
  const SRC = { id: 7, title: "keeper.psd", width: 1024, height: 1536, layers: [{ name: "THE KITE KEEPER", kind: "text", frame: { left: 68, top: 1369, width: 890, height: 61 } }, { name: "Key art", kind: "pixel", frame: { left: 0, top: 0, width: 1024, height: 1536 } }] };
  const ps = createFakePhotoshop({ docs: [SRC], active: 7 });
  ps.duplicateShift = { x: 1061, y: -635 };
  const host = hostMod.createHost(ps.require, { setTimeout, clearTimeout, crypto: webcrypto });
  let placers = createMorePlacers(host);
  const rec = (format, w, h) => {
    const path = `Scenario/out/${w}x${h}.png`;
    ps.files.set(path, new Uint8Array(solidPng(w, h)));
    return { local_id: "f" + h, job_id: "job_f", model_id: "model_scenario-smart-reframe", lane: "more", parameters: {}, target: { kind: "reframe", format, output: [w, h], document_id: 7 }, outputs: [{ asset_id: "a" + h, path, width: w, height: h }] };
  };
  const inside = (b, r) => b.left >= r.left && b.top >= r.top && b.right <= r.left + r.width && b.bottom <= r.top + r.height;
  const docs = [];
  for (const [format, w, h] of [["9:16", 1080, 1920], ["4:5", 1080, 1350], ["1:1", 1080, 1080]]) {
    // The plugin reloads before 1:1: the open formats document is found again.
    if (format === "1:1") placers = createMorePlacers(host);
    ps.app.activeDocument = ps.doc(7);
    const done = await placers.reframe.place(rec(format, w, h), { version: "0.7.1" });
    const doc = ps.doc(done.document_id);
    docs.push(doc.id);
    const ab = doc.layers.find((l) => l.id === done.group_id);
    assert.ok(ab && ab.artboard, format + ": the artboard is the group that landed");
    const title = ab.layers.find((l) => l.kind === "text");
    assert.ok(title, format + ": the title is inside its artboard, not at the top of the stack");
    assert.ok(inside(title.bounds, ab.frame), format + ": the title is within the artboard: " + JSON.stringify([title.bounds, ab.frame]));
    assert.ok(title.bounds.top > ab.frame.top + ab.frame.height * 0.8, format + ": near the bottom, where it was on the picture");
  }
  assert.equal(new Set(docs).size, 1, "one formats document, after a reload too");
  const frames = ps.doc(docs[0]).layers.filter((l) => l.artboard).map((l) => l.frame);
  for (const a of frames) for (const b of frames) if (a !== b) assert.ok(a.left + a.width <= b.left || b.left + b.width <= a.left, "the artboards do not overlap");
});
