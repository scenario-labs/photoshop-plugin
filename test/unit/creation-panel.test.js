"use strict";
// The creation panel (FLOWS v2, SPEC 3) end to end: the plugin source on the
// real host adapter over the fake Photoshop modules, against the fixture
// mock with paid generation on, driven through the panel's own elements
// (index.html). The context card and its actions for each context, the
// prices on the button, Generate at the shown price, the results model
// (group, take 1 visible, Show and Keep as one History state each, the
// takes reopened from layer metadata), document references in the
// document's metadata, More and pins, the confirm limit, price changes
// after upload, not-sent and Unknown answers, and Jobs.

const test = require("node:test");
const assert = require("node:assert/strict");
const xmp = require("../../plugin/src/util/xmp.js");
const ctlMod = require("../../plugin/src/panel/controller.js");
const actions = require("../../plugin/src/panel/actions.js");
const { bootGenerate, FLARE } = require("../helpers/generate-sim.js");
const { waitFor, sleep } = require("../helpers/fakes.js");

const POSTER = { id: 7, title: "poster.psd", width: 1024, height: 1024 };

// The created elements still attached under an element of index.html.
function attached(doc, el) {
  for (let n = el; n; n = n.parentNode) if (n.id && doc.els.get(n.id) === n) return true;
  return false;
}
function findAll(doc, attr, value) {
  return doc.all.filter((e) => e.getAttribute(attr) !== null && (value === undefined || e.getAttribute(attr) === String(value)) && attached(doc, e));
}
function find(doc, attr, value) {
  const list = findAll(doc, attr, value);
  assert.ok(list.length, `an element with ${attr}=${value}`);
  return list[0];
}
const chips = (doc) => doc.byId("acts").children.map((c) => c.getAttribute("data-act"));
const onChip = (doc) => doc.byId("acts").children.filter((c) => /\bon\b/.test(c.className)).map((c) => c.getAttribute("data-act"));
const go = (doc) => doc.text("go-label") + (doc.text("go-cu") ? " " + doc.text("go-cu") : "");
async function button(doc, text, timeout = 5000) {
  await waitFor(() => go(doc) === text, { label: `the button reads ${text} (now ${go(doc)})`, timeout });
}
const goOn = (doc) => doc.byId("go").getAttribute("aria-disabled") === "false";
async function show(app, ps) {
  ps.entrypoints.panels.scenarioPanel.show();
  await waitFor(() => app.controller.state().active, { label: "panel shown" });
}
async function ctxTitle(doc, text) {
  await waitFor(() => doc.text("ctx-title") === text, { label: `context reads ${text} (now ${doc.text("ctx-title")})`, timeout: 4000 });
}
async function popOpen(doc, kind) {
  const chip = find(doc, "data-pop", kind);
  chip.click();
  await waitFor(() => doc.byId("pop").getAttribute("data-menu") === kind && doc.byId("pop").style.display !== "none", { label: `${kind} menu open` });
  return doc.byId("pop");
}
function menuValues(doc) {
  return findAll(doc, "data-value").filter((e) => {
    for (let n = e; n; n = n.parentNode) if (n === doc.byId("pop")) return true;
    return false;
  });
}
function fire(ps) {
  ps.fire("set");
}
// The header's Jobs opens the short list (prototype); its "All jobs" row
// opens the full Jobs view.
async function openJobs(doc) {
  doc.byId("jobs").click();
  await waitFor(() => doc.byId("pop").getAttribute("data-menu") === "jobs" && doc.byId("pop").style.display !== "none", { label: "jobs popover open" });
  const rows = findAll(doc, "data-job").filter((e) => attached(doc, e) && e.parentNode === doc.byId("pop"));
  const all = menuValues(doc).find((e) => e.getAttribute("data-value") === "all");
  assert.ok(all, "the popover offers All jobs");
  return {
    rows,
    all: () => {
      all.click();
      assert.ok(doc.shown("view-jobs"));
    }
  };
}

test("no document: Create image leads, Open from Library beside it; an empty prompt says how to see the price; no price check before the panel shows", async (t) => {
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [] });
  await sleep(ctlMod.DEBOUNCE_MS + 100);
  const before = mock.requests.filter((r) => r.path.startsWith("/v1/generate")).length;
  assert.equal(before, 0, "nothing priced at launch");
  await show(app, ps);
  await ctxTitle(doc, "No document open");
  assert.deepEqual(chips(doc), ["create", "library"], "Create image, then Open from Library");
  assert.deepEqual(onChip(doc), ["create"]);
  assert.equal(doc.text("ctx-detail"), "Opens as a new document");
  assert.equal(go(doc), "Fill in the prompt to see the price");
  assert.equal(goOn(doc), false);
  assert.equal(doc.byId("prompt").getAttribute("placeholder"), "Describe the image");
  // The chips show their values: Size, Style, Model, Takes.
  const cc = doc.byId("cchips").children.map((c) => c.getAttribute("data-pop"));
  assert.deepEqual(cc, ["size", "style", "model", "takes"]);
  for (const c of doc.byId("cchips").children) assert.ok(c.textContent.trim().length > 0, "a chip shows its value");
  await sleep(ctlMod.DEBOUNCE_MS + 100);
  assert.equal(mock.requests.filter((r) => r.path.startsWith("/v1/generate")).length, 0, "no price without a prompt");
});

// A price for any Flare request: 1 CU plus 1 per take (the measured table
// answers only some sizes).
// Replace inside and Remove default to Ideogram 4.5 Precise Edit and
// Ideogram 4.5 (mask strategy test of 2026-10-20): priced here like Flare.
const PRECISE = "model_ideogram-v4-5-precise-edit";
const IDEOGRAM = "model_ideogram-v4-5";
function flarePrice(extra) {
  return (model, body) => {
    if (model !== FLARE && model !== PRECISE && model !== IDEOGRAM) return null;
    const n = 1 + (Number(body.numOutputs) || 1) + (extra ? extra(body) : 0);
    return { status: 269, body: { creativeUnitsCost: n, creativeUnitsDiscount: 0, costDetails: { "custom-generation": n } } };
  };
}
async function pick(doc, kind, value) {
  await popOpen(doc, kind);
  const item = menuValues(doc).find((e) => e.getAttribute("data-value") === String(value));
  assert.ok(item, `${kind} menu has ${value}`);
  item.click();
  assert.equal(doc.byId("pop").style.display, "none", "choosing closes the menu");
}
const tiles = (doc) => findAll(doc, "data-take");
async function landed(app, n = 1) {
  await waitFor(() => app.ledger.all().filter((r) => r.state === "applied").length >= n, { label: `${n} run(s) applied`, timeout: 8000 });
}

test("F3 Create image with no document: Size and Takes chips, the price on the button, one paid call, a new document with the takes as a group, one History state; the Takes card shows and keeps a take", async (t) => {
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [], mockOpts: { answer: flarePrice() } });
  await show(app, ps);
  await pick(doc, "size", "1:1");
  await pick(doc, "takes", 2);
  assert.equal(find(doc, "data-pop", "takes").textContent.includes("2 takes"), true, "the Takes chip shows its value");
  doc.type("prompt", "A lighthouse on a rocky coast");
  await button(doc, "Create image · 3 CU");
  assert.equal(goOn(doc), true);
  // The Takes menu prices each count with free price checks.
  await popOpen(doc, "takes");
  const right = (v) => (menuValues(doc).find((e) => e.getAttribute("data-value") === String(v)).children.find((c) => c.className === "r") || { textContent: "" }).textContent;
  assert.deepEqual([1, 2, 3, 4].map(right), ["2 CU", "3 CU", "4 CU", "5 CU"]);
  doc.byId("pop-scrim").click();
  assert.equal(mock.paidCalls.length, 0);
  assert.equal(doc.text("ctx-detail"), "Opens as a new document 1024 × 1024");
  assert.equal(mock.paidCalls.length, 0, "nothing paid before the click");
  doc.byId("go").click();
  await landed(app);
  assert.equal(mock.paidCalls.length, 1);
  // Quality Medium unless Advanced says otherwise (FLOWS v2, review 9).
  assert.deepEqual(mock.paidCalls[0].body, { prompt: "A lighthouse on a rocky coast", quality: "medium", width: 1024, height: 1024, numOutputs: 2 });
  assert.deepEqual(mock.violations, []);
  assert.equal(ps.app.documents.length, 1, "a new document");
  const nd = ps.app.documents[0];
  assert.equal(nd.width, 1024);
  const group = nd.layers[0];
  assert.equal(group.kind, "group");
  assert.equal(group.name, "Scenario image lighthouse-rocky-coast (2 takes)");
  assert.deepEqual(group.layers.map((l) => l.visible), [true, false], "take 1 visible");
  const rec = app.ledger.all()[0];
  assert.equal(xmp.parse(group.xmp).jobId, rec.job_id);
  assert.equal(xmp.parse(group.layers[1].xmp).take, "2");
  assert.equal(ps.history.filter((h) => h.document_id === nd.id).length, 1, "one History state");
  for (const o of rec.outputs) assert.ok(ps.binary(o.path) instanceof Uint8Array, "the file is in the output folder");

  // The new document is active: its group is the takes context, the card shows its two takes.
  await waitFor(() => app.controller.state().kind === "takes", { label: "takes context", timeout: 4000 });
  assert.deepEqual(chips(doc), ["compare", "more_like", "refine", "upscale_kept", "more"], "More holds Animate");
  assert.equal(doc.text("ctx-title"), "2 takes · A lighthouse on a rocky coast");
  assert.equal(doc.text("ctx-count"), "2");
  await waitFor(() => tiles(doc).length === 2, { label: "two tiles" });
  // Each tile draws its picture, and drawing pictures leaves the composer
  // alone (a second function named cover once hid the prompt instead).
  for (const tile of tiles(doc)) assert.ok(tile.children.some((c) => c.tagName === "IMG" || (c.children || []).some((k) => k.tagName === "IMG")), "the tile has its picture");
  assert.equal(doc.byId("composer").className, "composer", "no popover open, the composer is not covered");
  // A layer the person put in the takes group is not a take, nor is a
  // Scenario layer of another run dragged into it: Show take and Keep leave
  // them as they are.
  const mine = { ...group.layers[0], id: 990001, name: "My shadow", xmp: null, visible: true, parent: group };
  assert.ok(group.layers[0].xmp.includes(rec.job_id), "the take's metadata names its job");
  const other = { ...group.layers[0], id: 990002, name: "Scenario image other run", xmp: group.layers[0].xmp.split(rec.job_id).join("job_otherrun0001"), visible: true, parent: group };
  const copy = { ...group.layers[0], id: 990003, name: group.layers[0].name + " copy", visible: true, parent: group };
  group.layers.push(mine, other, copy);
  const before = ps.history.length;
  tiles(doc)[1].click();
  await waitFor(() => group.layers[1].visible && !group.layers[0].visible, { label: "take 2 shows" });
  assert.equal(mine.visible, true, "Show take leaves the person's layer visible");
  assert.equal(other.visible, true, "Show take leaves another run's layer visible");
  assert.equal(copy.visible, true, "Show take leaves the person's copy of a take visible");
  assert.equal(ps.history.length, before + 1, "Show take is one History state");
  assert.equal(ps.history.at(-1).name, "Scenario: Show take");
  await waitFor(() => /\bon\b/.test(tiles(doc)[1].className), { label: "tile 2 marked" });
  const keepBtn = find(doc, "data-btn", "keep");
  assert.equal(keepBtn.textContent, "Keep take 2");
  keepBtn.click();
  await waitFor(() => group.layers.length === 4, { label: "kept" });
  assert.equal(xmp.parse(group.layers[0].xmp).take, "2");
  assert.equal(group.layers[1].name, "My shadow", "the person's own layer stays");
  assert.equal(group.layers[2].name, "Scenario image other run", "another run's layer stays");
  assert.equal(group.layers[3].id, 990003, "the person's copy of a take stays");
  assert.equal(ps.history.length, before + 2, "Keep is one History state");
  await ctxTitle(doc, "Kept take · A lighthouse on a rocky coast");
});

test("F1 a selection: Replace inside lands masked as a group above the layer; Refine keeps the shown take, loads the selection back from the mask and starts from it", async (t) => {
  const sel = { left: 100, top: 200, width: 512, height: 512 };
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [{ ...POSTER, selection: sel }], active: 7, mockOpts: { answer: flarePrice() } });
  await show(app, ps);
  await ctxTitle(doc, "Selection 512 × 512 on Background");
  assert.deepEqual(chips(doc), ["replace", "remove", "versions_sel", "cutout", "new_layer"], "no More: every selection action is a chip");
  assert.deepEqual(onChip(doc), ["replace"]);
  assert.equal(doc.text("ctx-detail"), "Lands inside the selection, masked");
  assert.equal(doc.byId("prompt").getAttribute("placeholder"), "Describe what goes inside the selection");
  assert.equal(go(doc), "Fill in the prompt to see the price");
  // Cut out subject puts the subject on a new layer; the layer stays as it is.
  find(doc, "data-act", "cutout").click();
  await waitFor(() => doc.text("ctx-detail") === "Lands as a new layer above Background, which stays untouched", { label: "cut out lands as a new layer" });
  find(doc, "data-act", "replace").click();
  doc.type("prompt", "A red kite");
  await button(doc, "Replace inside · 3 CU");
  doc.byId("go").click();
  await landed(app);
  assert.equal(mock.paidCalls.length, 1);
  assert.equal(mock.paidCalls[0].model, PRECISE, "Replace inside runs Precise Edit");
  assert.equal(app.ledger.all()[0].target.edit_mode, "inside", "the record keeps how the edit lands");
  assert.equal(mock.paidCalls[0].body.prompt, "A red kite");
  assert.equal(mock.paidCalls[0].body.numOutputs, 2);
  assert.ok(mock.paidCalls[0].body.mask, "a masked edit");
  const d = ps.doc(7);
  const group = d.layers[0];
  assert.equal(group.kind, "group");
  assert.match(group.name, /^Scenario edit .+ \(2 takes\)$/);
  assert.ok(group.mask || group.layers.every((l) => l.mask), "the result is masked to the selection");
  assert.equal(ps.history.filter((h) => h.document_id === 7).length, 1, "one History state");
  assert.equal(xmp.parse(group.xmp).kind, "edit");
  // Placing drops the selection in Photoshop; the masked edit loads it back
  // from its mask, so the person can run again on the same area.
  assert.equal(d.selection && d.selection.from_mask, group.id, "the selection is back after the edit lands");
  assert.ok(d.selection.cut_to, "cut to the capture box: Photoshop reveals everything outside a mask's pixels");

  // The card shows in the selection context too, until closed.
  await waitFor(() => tiles(doc).length === 2, { label: "the run's takes in the card" });
  // The tiles show the selection, not the whole capture around it.
  const tw0 = tiles(doc)[0].children[0];
  const img0 = tw0.children.find((c) => c.className === "cov");
  assert.ok(parseInt(img0.style.width, 10) > parseInt(tw0.style.width, 10), "the take is cropped to the selection in its tile");
  tiles(doc)[1].click();
  await waitFor(() => group.layers[1].visible, { label: "take 2 shows" });
  d.selection = null;
  find(doc, "data-btn", "refine").click();
  await waitFor(() => group.layers.length === 1, { label: "refine keeps the shown take" });
  // The fake loads a mask's box as the selection; Photoshop loads its pixels.
  await waitFor(() => d.selection && d.selection.from_mask === group.id, { label: "the selection is back from the run's mask", timeout: 4000 });
  await waitFor(() => app.controller.state().action === "replace" && doc.text("ctx-detail") === "Starting from take 2 · lands inside the selection", { label: "starts from take 2" });
  assert.equal(doc.byId("prompt").value, "", "an empty prompt to refine");
});

test("F1 references: Replace inside on Precise Edit shows the + Reference row above the prompt; a layer reference goes to referenceImages beside the capture and the mask; three at most with a selection", async (t) => {
  const sel = { left: 100, top: 200, width: 512, height: 512 };
  const DOC = { ...POSTER, selection: sel, layers: [{ name: "Boat", kind: "pixel", frame: { left: 0, top: 0, width: 1024, height: 1024 } }, { name: "Background", background: true }] };
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [DOC], active: 7, mockOpts: { answer: flarePrice() } });
  await show(app, ps);
  await ctxTitle(doc, "Selection 512 × 512 on Boat");
  assert.deepEqual(onChip(doc), ["replace"]);
  // The row shows before the price (the schema decides) and reads as the prototype.
  await waitFor(() => findAll(doc, "data-pop", "addref").length === 1, { label: "the add tile" });
  assert.ok(doc.shown("refs"), "the refs row shows");
  const html = require("node:fs").readFileSync(require.resolve("../../plugin/index.html"), "utf8");
  assert.ok(html.indexOf('id="refs"') > 0 && html.indexOf('id="refs"') < html.indexOf('id="pbox"'), "the refs row sits above the prompt");
  assert.equal(find(doc, "data-pop", "addref").textContent, "Reference");
  const hint = () => doc.byId("refs").children.filter((e) => e.className === "hint").map((e) => e.textContent).join("");
  assert.equal(hint(), "Selection, layer or file");
  assert.equal(doc.shown("refs-note"), false, "no note before a reference is attached");
  await popOpen(doc, "addref");
  menuValues(doc).find((e) => e.getAttribute("data-value") === "layer").click();
  await waitFor(() => findAll(doc, "data-ref").length === 1, { label: "layer reference added" });
  // One short line under the row: a whole-scene reference is copied in.
  await waitFor(() => doc.shown("refs-note"), { label: "the reference note shows" });
  assert.equal(doc.text("refs-note"), "Use an object or a style as the reference. A whole scene can be copied in.");
  const htmlNote = html.indexOf('id="refs-note"');
  assert.ok(htmlNote > html.indexOf('id="refs"') && htmlNote < html.indexOf('id="pbox"'), "the note sits under the refs row, above the prompt");
  doc.type("prompt", "A red sail");
  await button(doc, "Replace inside · 3 CU");
  doc.byId("go").click();
  await landed(app);
  assert.equal(mock.paidCalls.length, 1);
  const body = mock.paidCalls[0].body;
  assert.equal(mock.paidCalls[0].model, PRECISE);
  assert.equal(typeof body.image, "string", "the capture goes to image");
  assert.ok(body.mask, "the selection's mask goes too");
  assert.ok(Array.isArray(body.referenceImages) && body.referenceImages.length === 1, "the layer reference goes to referenceImages");
  assert.notEqual(body.referenceImages[0], body.image);
  // Precise Edit takes 4 references, 3 with a mask: the add tile goes at 3.
  for (let i = 0; i < 2; i++) {
    await popOpen(doc, "addref");
    menuValues(doc).find((e) => e.getAttribute("data-value") === "layer").click();
    await waitFor(() => findAll(doc, "data-ref").length === i + 2, { label: `reference ${i + 2}` });
  }
  await waitFor(() => findAll(doc, "data-pop", "addref").length === 0, { label: "no add tile at the model's limit" });
});

test("pendingFor: an edit model with its own reference input counts the references there; a mask lowers Precise Edit's limit to 3", () => {
  const schemaMod = require("../../plugin/src/forms/schema.js");
  const requests = require("../../plugin/src/forms/requests.js");
  const { records } = require("../helpers/fixture-scenario.js");
  const s = schemaMod.normalize(records[PRECISE]);
  assert.equal(requests.separateReferenceInput(s).name, "referenceImages");
  assert.deepEqual(requests.pendingFor("edit", s, {}, 2, {}), { image: 1, mask: 1, referenceImages: 2 });
  assert.deepEqual(requests.pendingFor("edit", s, {}, 4, { mask: false }), { image: 1, referenceImages: 4 });
  assert.throws(() => requests.pendingFor("edit", s, {}, 4, {}), /at most 3 reference images with a selection/);
  const flare = schemaMod.normalize(records[FLARE]);
  assert.equal(requests.separateReferenceInput(flare), null, "Flare takes references with its capture");
});

test("F2 a layer: Make versions with the built-in prompt when empty, a group above the layer; context chips and More with pins kept on disk", async (t) => {
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [POSTER], active: 7, mockOpts: { answer: flarePrice() } });
  await show(app, ps);
  await ctxTitle(doc, "Background · Layer 1024 × 1024");
  // The context card shows the layer's picture, read once at 96 px.
  await waitFor(() => String(doc.byId("ctx-img").getAttribute("src") || "").startsWith("blob:"), { label: "layer thumbnail" });
  assert.deepEqual(chips(doc), ["versions", "extend", "upscale", "remove_bg", "new_layer", "more"]);
  assert.deepEqual(onChip(doc), ["versions"]);
  assert.equal(doc.text("ctx-detail"), "Lands above Background as a group");
  // An optional prompt: the price shows with the field empty.
  await pick(doc, "takes", 2);
  await button(doc, "Make versions · 3 CU");
  assert.equal(doc.text("ctx-detail"), "Lands above Background as a group");

  // More: grouped, pin one to the chips (kept on disk), then unpin.
  await popOpen(doc, "more");
  const pinOf = (id) => find(doc, "data-pin", id);
  assert.deepEqual(findAll(doc, "data-pick").map((e) => e.getAttribute("data-pick")), ["remove_text", "formats", "upscale_layer", "cutout_layer", "split", "split_text", "library_place", "sketch", "angle", "relight", "animate"]);
  // Each entry shows its own price (free price checks with its default model).
  const rightOf = (id) => (find(doc, "data-pick", id).children[0].children.find((c) => c.className === "r") || { textContent: "" }).textContent;
  assert.deepEqual([rightOf("upscale_layer"), rightOf("cutout_layer")], ["10 CU", "1 CU"]);
  pinOf("cutout_layer").click();
  await waitFor(() => chips(doc).includes("cutout_layer"), { label: "pinned" });
  assert.deepEqual(chips(doc), ["versions", "extend", "upscale", "remove_bg", "new_layer", "cutout_layer", "more"]);
  assert.deepEqual(JSON.parse(ps.files.get("panel-pins.json")).layer, ["cutout_layer"]);
  doc.byId("pop-scrim").click();
  assert.equal(doc.byId("pop").style.display, "none");

  find(doc, "data-act", "versions").click();
  await button(doc, "Make versions · 3 CU");
  doc.byId("go").click();
  await landed(app);
  const body = mock.paidCalls[0].body;
  assert.equal(body.prompt, actions.BUILTIN.variations, "the built-in prompt for an empty field");
  assert.equal(body.numOutputs, 2);
  const d = ps.doc(7);
  assert.equal(d.layers[0].kind, "group");
  assert.equal(d.layers[1].name, "Background", "lands above the layer");
  assert.equal(ps.history.filter((h) => h.document_id === 7).length, 1);
  // The new group is selected, so the next action works on the takes.
  await waitFor(() => app.controller.state().kind === "takes", { label: "the group is the takes context", timeout: 4000 });
  assert.deepEqual(chips(doc), ["compare", "more_like", "refine", "upscale_kept", "more"], "More holds Animate");
  assert.equal(ps.history.filter((h) => h.document_id === 7).length, 1, "selecting the group adds no History state");
});

test("Recent comes back after the panel reloads while Photoshop runs: runs in a document that was never saved are found again from their layers' metadata", async (t) => {
  const { app, doc, ps } = await bootGenerate(t, { docs: [POSTER], active: 7, mockOpts: { answer: flarePrice() } });
  await show(app, ps);
  await ctxTitle(doc, "Background · Layer 1024 × 1024");
  await pick(doc, "takes", 1);
  await button(doc, "Make versions · 2 CU");
  doc.byId("go").click();
  await landed(app);
  const d = ps.doc(7);
  // Back on the Background: the run is in Recent of this panel session.
  await waitFor(() => app.controller.state().kind === "takes", { label: "the result selected", timeout: 4000 });
  d.activeLayers = [d.layers[d.layers.length - 1]];
  await app.controller.refresh();
  app.controller.closeCard();
  await app.controller.refresh();
  const rec = app.ledger.all()[0];
  assert.equal(rec.state, "applied");
  assert.deepEqual(app.controller.model().recent.map((r) => r.local_id), [rec.local_id], "Recent lists the run");
  // A reloaded panel has a new session marker, its runner too; the
  // document was never saved, so no file matches it.
  const opts = { host: app.host, catalog: app.catalog, quotes: app.quotes, flow: app.flow, runner: null, ledger: app.ledger, references: app.references, settings: app.settings };
  const reloaded = ctlMod.createController({ ...opts, session: "reloaded" });
  await reloaded.activate();
  assert.deepEqual(reloaded.model().recent.map((r) => r.local_id), [rec.local_id], "Recent comes back after the reload");
  // A layer that no longer carries the run's metadata is not claimed.
  const layer = d.layers[0];
  const saved = layer.xmp;
  layer.xmp = "";
  for (const k of layer.layers || []) k.xmp = "";
  const other = ctlMod.createController({ ...opts, session: "another" });
  await other.activate();
  assert.deepEqual(other.model().recent, [], "no Recent row without the run's layer");
  layer.xmp = saved;
});

test("F4 one-click actions: Upscale opens a new document at the shown size; Remove background lands as a mask on the layer; no prompt field for either", async (t) => {
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [POSTER], active: 7, psOpts: { scene: true }, mockOpts: { answer: (model) => (model === "model_851-labs-background-remover" ? { status: 269, body: { creativeUnitsCost: 1, creativeUnitsDiscount: 0, costDetails: {} } } : null) } });
  await show(app, ps);
  await ctxTitle(doc, "Background · Layer 1024 × 1024");
  find(doc, "data-act", "upscale").click();
  await button(doc, "Upscale ×2 · 10 CU");
  assert.equal(doc.byId("prompt").style.display, "none", "no prompt field");
  assert.equal(doc.text("noprompt-text"), "Adds detail at the larger size. No prompt needed.");
  assert.equal(doc.text("ctx-detail"), "Opens as a new document 2048 × 2048");
  assert.deepEqual(doc.byId("cchips").children.map((c) => c.getAttribute("data-pop")), ["upsize", "model"]);
  doc.byId("go").click();
  await landed(app);
  assert.equal(mock.paidCalls.length, 1);
  assert.equal(mock.paidCalls[0].body.upscaleFactor, "2x");
  assert.equal(ps.app.documents.length, 2, "Upscale opens a new document");
  const up = ps.app.documents[1];
  assert.equal(ps.history.filter((h) => h.document_id === up.id).length, 1);
  assert.ok(xmp.parse(up.layers[0].xmp).jobId, "the result layer carries its metadata");
  assert.equal(ps.doc(7).layers.length, 1, "the source document is untouched");

  // Back on the poster: Remove background.
  ps.setActive(7);
  fire(ps);
  await ctxTitle(doc, "Background · Layer 1024 × 1024");
  // A lone Background is a flat image: Split into layers leads, Remove
  // background is in More.
  assert.deepEqual(chips(doc), ["split", "versions", "upscale", "formats", "more"]);
  await popOpen(doc, "more");
  find(doc, "data-pick", "remove_bg").children[0].click();
  await button(doc, "Remove background · 1 CU");
  assert.equal(doc.text("ctx-detail"), "Lands as a mask on Background");
  doc.byId("go").click();
  await landed(app, 2);
  const d = ps.doc(7);
  assert.ok(d.layers[0].mask && d.layers[0].mask.data, "a mask on the layer");
  assert.deepEqual(ps.history.filter((h) => h.document_id === 7), [{ document_id: 7, name: "Scenario: Place cutout" }]);
});

test("the takes come back from the layers' metadata after a restart: the group is the takes context, a click shows a take", async (t) => {
  const group = xmp.build({ schema: "1", jobId: "job_before", kind: "image", prompt: "a quiet harbor", modelName: "GPT Image 2.5 Flare" });
  const take = (n, asset) => xmp.build({ schema: "1", jobId: "job_before", kind: "image", take: String(n), assetId: asset, prompt: "a quiet harbor" });
  const DOC = {
    ...POSTER,
    layers: [
      { name: "Scenario image a-quiet-harbor (2 takes)", kind: "group", xmp: group, layers: [{ name: "Take 1 aaaaaa", kind: "smartObject", xmp: take(1, "asset_beforeaaaaaa") }, { name: "Take 2 bbbbbb", kind: "smartObject", visible: false, xmp: take(2, "asset_beforebbbbbb") }] },
      { name: "Background", background: true }
    ]
  };
  const { app, doc, ps } = await bootGenerate(t, { docs: [DOC], active: 7 });
  const d = ps.doc(7);
  d.activeLayers = [d.layers[0]];
  await show(app, ps);
  await ctxTitle(doc, "2 takes · a quiet harbor");
  assert.deepEqual(chips(doc), ["compare", "more_like", "refine", "upscale_kept", "more"], "More holds Animate");
  assert.equal(doc.text("ctx-detail"), "Showing take 1 · click a take to compare");
  assert.equal(doc.text("c-note-text"), "Click a take above to show it in the document, then Keep it.");
  await waitFor(() => tiles(doc).length === 2, { label: "two tiles" });
  tiles(doc)[1].click();
  await waitFor(() => d.layers[0].layers[1].visible && !d.layers[0].layers[0].visible, { label: "take 2 shows" });
  assert.deepEqual(ps.history, [{ document_id: 7, name: "Scenario: Show take" }]);
  await waitFor(() => doc.text("ctx-detail") === "Showing take 2 · click a take to compare", { label: "the context follows" });
  // Keep take: the group no longer counts takes it does not hold.
  await app.controller.keep();
  await waitFor(() => d.layers[0].layers.length === 1, { label: "kept" });
  assert.equal(d.layers[0].name, "Scenario image a-quiet-harbor");
});

const cost = (n) => ({ status: 269, body: { creativeUnitsCost: n, creativeUnitsDiscount: 0, costDetails: { "custom-generation": n } } });
const shownEl = (doc, id) => doc.byId(id).style.display !== "none" && doc.byId(id).style.display !== undefined && doc.byId(id).style.display !== "";

test("the confirm limit: above it the button asks first; Cancel sends nothing; the card's button sends once", async (t) => {
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [], mockOpts: { answer: (model) => (model === FLARE ? cost(150) : null), charge: () => 150 } });
  await show(app, ps);
  doc.type("prompt", "A lighthouse");
  await button(doc, "Create image · 150 CU");
  doc.byId("go").click();
  await waitFor(() => shownEl(doc, "confirm-card"), { label: "the confirm card" });
  assert.equal(doc.text("confirm-text"), "This costs 150 CU, above your confirm limit of 100 CU.");
  assert.equal(doc.text("confirm-ok-label"), "Create image · 150 CU");
  assert.equal(goOn(doc), false, "the button waits for the card");
  doc.byId("confirm-cancel").click();
  await waitFor(() => !shownEl(doc, "confirm-card"), { label: "card closed" });
  await sleep(100);
  assert.equal(mock.paidCalls.length, 0, "Cancel sends nothing");
  doc.byId("go").click();
  await waitFor(() => shownEl(doc, "confirm-card"), { label: "the card again" });
  doc.byId("confirm-ok").click();
  await landed(app);
  assert.equal(mock.paidCalls.length, 1);
});

test("a reference and a different price after upload: the run waits for approval; Approve sends it at the new price; Decline sends nothing", async (t) => {
  // At Medium the reference is priced with a 256 px stand-in (3 CU); the
  // uploaded picture prices 5, so the run waits for approval.
  let fx = null;
  const refPrice = (body) => (!body.referenceImages ? 2 : body.referenceImages.some((id) => (fx.assets.get(id) || {}).width !== 256) ? 5 : 3);
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [POSTER], active: 7, mockOpts: { answer: (model, body) => (model === FLARE ? cost(refPrice(body)) : null) } });
  fx = mock;
  await show(app, ps);
  find(doc, "data-act", "new_layer").click();
  assert.equal(doc.byId("prompt").getAttribute("placeholder"), "Describe the new layer");
  // The refs row: the add tile and its hint; the menu lists the sources and the document-reference roles.
  await waitFor(() => findAll(doc, "data-pop", "addref").length === 1, { label: "the add tile" });
  await popOpen(doc, "addref");
  assert.deepEqual(menuValues(doc).map((e) => e.getAttribute("data-value")), ["layer", "visible", "file", "library", "pin:Character", "pin:Set", "pin:Style", "pin:Product"]);
  menuValues(doc).find((e) => e.getAttribute("data-value") === "visible").click();
  await waitFor(() => findAll(doc, "data-ref").length === 1, { label: "reference added" });
  assert.equal(app.controller.state().refs, 1);
  doc.type("prompt", "A paper kite");
  await waitFor(() => app.controller.state().price.state === "ready" && go(doc) === "New layer · 3 CU", { label: `priced (now ${go(doc)})`, timeout: 4000 });
  // Only the blank stand-in that priced the reference is uploaded before the click.
  assert.deepEqual(mock.uploads.map((u) => [u.width, u.height, /^photoshop-standin-/.test(u.name)]), [[256, 256, true]]);
  doc.byId("go").click();
  await waitFor(() => shownEl(doc, "confirm-card"), { label: "the price-changed card" });
  assert.match(doc.text("confirm-text"), /^Price changed after upload\. Now 5 CU \(was 3 CU\)\. Nothing was spent\.$/);
  assert.equal(doc.text("confirm-ok-label"), "Approve · 5 CU");
  assert.equal(mock.paidCalls.length, 0);
  assert.equal(mock.uploads.length, 2);
  assert.equal(app.ledger.all()[0].state, "awaiting_approval");
  // The run card shows the price waiting for approval, not the first quote
  // (live on New angle: the card kept 1 CU after the price changed to 6).
  await waitFor(() => app.controller.model().card && /5 CU/.test(app.controller.model().card.sub), { label: `the run card at the new price (now ${JSON.stringify(app.controller.model().card)})` });
  doc.byId("confirm-ok").click();
  await landed(app);
  assert.equal(mock.paidCalls.length, 1);
  assert.deepEqual(mock.paidCalls[0].body.referenceImages, [mock.uploads[1].id]);
  assert.equal(app.ledger.all()[0].cu_quoted, "5");
  await waitFor(() => app.controller.model().card && app.controller.model().card.sub === "GPT Image 2.5 Flare · " + app.ledger.all()[0].cu_charged + " CU", { label: `the takes card at the charged price (now ${JSON.stringify((app.controller.model().card || {}).sub)})` });
  const d = ps.doc(7);
  assert.equal(d.layers[d.layers.length - 1].name, "Background");
  assert.equal(d.layers[0].kind, "group", "two takes above the layer");
  // An unmasked run: the new group is selected once it lands, so the next
  // chip works on the takes (FLOWS v2, changes after review 13).
  await waitFor(() => d.activeLayers.length === 1 && d.activeLayers[0] === d.layers[0], { label: "the new group selected" });
  await ctxTitle(doc, "2 takes · A paper kite");

  // Again, declined this time, from the Background layer.
  d.activeLayers = [d.layers[d.layers.length - 1]];
  fire(ps);
  await ctxTitle(doc, "Background · Layer 1024 × 1024");
  find(doc, "data-act", "new_layer").click();
  doc.type("prompt", "A paper boat");
  await waitFor(() => app.controller.state().price.state === "ready" && go(doc) === "New layer · 3 CU", { label: "priced again", timeout: 4000 });
  doc.byId("go").click();
  await waitFor(() => shownEl(doc, "confirm-card"), { label: "the card again" });
  doc.byId("confirm-cancel").click();
  await waitFor(() => app.ledger.all()[0].state === "not_sent", { label: "declined" });
  assert.equal(app.ledger.all()[0].error, "Not sent: Declined.");
  assert.equal(mock.paidCalls.length, 1);
});

test("Unknown on a 503: never retried, the header's Jobs count turns to attention, the same request waits until marked not sent in Jobs", async (t) => {
  let fail = true;
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [], mockOpts: { answer: flarePrice(), paid: () => (fail ? { status: 503, body: { message: "Service Unavailable" } } : undefined) } });
  await show(app, ps);
  await pick(doc, "takes", 1);
  doc.type("prompt", "A lighthouse");
  await button(doc, "Create image · 2 CU");
  doc.byId("go").click();
  await waitFor(() => app.ledger.all()[0] && app.ledger.all()[0].state === "uncertain", { label: "Unknown" });
  assert.equal(mock.paidCalls.length, 1, "a 503 on the paid call is never retried");
  await waitFor(() => doc.byId("jobs-badge").className === "n attention", { label: "attention" });
  assert.equal(doc.text("jobs-badge"), "1");
  assert.equal(doc.byId("jobs").getAttribute("title"), "Jobs: 1 waiting for you");

  await button(doc, "Create image · 2 CU");
  doc.byId("go").click();
  await waitFor(() => doc.text("c-message-text") === "A matching request may already be running. Resolve it in Jobs first.", { label: `in flight (now ${doc.text("c-message-text")})` });
  assert.equal(mock.paidCalls.length, 1);

  const jp = await openJobs(doc);
  assert.equal(jp.rows.length, 1);
  assert.match(jp.rows[0].className, /attention/);
  assert.equal(doc.text("pop").includes("Every file stays in the output folder, kept or not."), true);
  jp.all();
  const row = () => doc.byId("jobs-list").children[0];
  const action = (name) => rowActions(row()).find((b) => b.getAttribute("data-action") === name);
  action("mark_not_sent").click();
  action("mark_not_sent").click();
  await waitFor(() => app.ledger.all()[0].state === "not_sent", { label: "marked not sent" });
  doc.byId("jobs-back").click();
  assert.ok(doc.shown("view-main"));
  fail = false;
  doc.type("prompt", "A lighthouse at dusk");
  await button(doc, "Create image · 2 CU");
  doc.byId("go").click();
  await landed(app);
  assert.equal(mock.paidCalls.length, 2);
});

test("402 and 429 are not sent: the composer says so, nothing is charged, and a 429 pauses the button", async (t) => {
  let answer = { status: 402, body: { message: "Payment Required" } };
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [], mockOpts: { answer: flarePrice(), paid: () => answer } });
  await show(app, ps);
  await pick(doc, "takes", 1);
  doc.type("prompt", "A lighthouse");
  await button(doc, "Create image · 2 CU");
  doc.byId("go").click();
  await waitFor(() => doc.text("c-message-text") === "Not enough CU for this job. Nothing was sent.", { label: `402 (now ${doc.text("c-message-text")})` });
  assert.equal(app.ledger.all()[0].state, "not_sent");
  assert.equal(app.ledger.all()[0].cu_charged, "0");
  answer = { status: 429, body: { message: "Too Many Requests" }, headers: { "retry-after": "30" } };
  await button(doc, "Create image · 2 CU");
  doc.byId("go").click();
  await waitFor(() => /^Not sent: Scenario asked to wait (29|30) s\.$/.test(doc.text("go-reason-text")), { label: `paused (now ${doc.text("go-reason-text")})` });
  assert.equal(goOn(doc), false);
  assert.equal(mock.paidCalls.length, 2);
});

// A Jobs row: [picture, [head: [title, status], meta, detail?, actions?]].
function rowActions(row) {
  const main = row.children[1];
  const last = main.children[main.children.length - 1];
  return last && last.getAttribute("class") === "actions" ? last.children : [];
}

test("document references: pinning a layer with a role writes the document's XMP, shows first in the refs row, and comes back from the document", async (t) => {
  const DOC = { ...POSTER, layers: [{ name: "Hero", kind: "pixel", frame: { left: 0, top: 0, width: 1024, height: 1024 } }, { name: "Background", background: true }] };
  const { app, doc, ps } = await bootGenerate(t, { docs: [DOC], active: 7 });
  await show(app, ps);
  await ctxTitle(doc, "Hero · Layer 1024 × 1024");
  await waitFor(() => findAll(doc, "data-pop", "addref").length === 1, { label: "the add tile" });
  await popOpen(doc, "addref");
  menuValues(doc).find((e) => e.getAttribute("data-value") === "pin:Character").click();
  await waitFor(() => findAll(doc, "data-dref").length === 1, { label: "the document reference shows" });
  const d = ps.doc(7);
  const hero = d.layers[0];
  assert.match(d.xmp, /scenario:references="/);
  const docRefs = require("../../plugin/src/panel/doc-refs.js");
  assert.deepEqual(docRefs.read(d.xmp), [{ role: "Character", layer_id: hero.id, name: "Hero" }]);
  assert.equal(find(doc, "data-dref", hero.id).textContent.includes("Character"), true);
  // Left out of one run with a click; still in the document.
  find(doc, "data-dref", hero.id).click();
  await waitFor(() => /\boff\b/.test(find(doc, "data-dref", hero.id).className), { label: "left out" });
  assert.equal(docRefs.read(d.xmp).length, 1);
  // Another panel session reads them back from the document.
  const fresh = ctlMod.createController({ host: app.host, catalog: app.catalog, quotes: app.quotes, flow: app.flow, runner: null, ledger: app.ledger, references: app.references, settings: app.settings });
  await fresh.activate();
  assert.deepEqual(fresh.state().drefs, [{ role: "Character", layer_id: hero.id, name: "Hero" }]);
});

test("Style: No style, Match an image with a picture from the document (any model, sent last with a line in the prompt); the Model menu shows each model's price; Quality in Advanced follows the price", async (t) => {
  // Flare: 1 CU a take at Low, 2 at Medium, 4 at High.
  const per = { low: 1, medium: 2, high: 4 };
  const answer = (model, body) => (model === FLARE ? cost((per[body.quality] || 3) * (Number(body.numOutputs) || 1)) : null);
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [POSTER], active: 7, mockOpts: { answer } });
  await show(app, ps);
  await ctxTitle(doc, "Background · Layer 1024 × 1024");
  await pick(doc, "takes", 2);
  await button(doc, "Make versions · 4 CU");
  await popOpen(doc, "style");
  assert.deepEqual(menuValues(doc).slice(0, 2).map((e) => e.getAttribute("data-value")), ["", "match"]);
  assert.match(doc.text("pop"), /Match an image uses a picture as the style reference, with any model\./);
  menuValues(doc).find((e) => e.getAttribute("data-value") === "match").click();
  // The picture comes next, from the same chip.
  await waitFor(() => doc.byId("pop").getAttribute("data-menu") === "stylesrc", { label: "the picture menu" });
  assert.deepEqual(menuValues(doc).map((e) => e.getAttribute("data-value")), ["layer", "visible", "file"]);
  menuValues(doc).find((e) => e.getAttribute("data-value") === "visible").click();
  await waitFor(() => find(doc, "data-pop", "style").textContent.includes("Match an image"), { label: "the Style chip on Match an image" });
  const sref = findAll(doc, "data-ref").find((e) => /\bsref\b/.test(e.className));
  assert.ok(sref, "the style picture in the refs row");
  assert.ok(sref.textContent.includes("Style"));
  assert.equal(find(doc, "data-pop", "model").textContent.includes("GPT Image 2.5 Flare"), true, "any model: the Model chip stays");
  await button(doc, "Make versions · 4 CU");

  // The Model menu: each model with its price for these settings.
  await popOpen(doc, "model");
  const rec = menuValues(doc).find((e) => e.getAttribute("data-value") === "");
  assert.equal((rec.children.find((c) => c.className === "r") || {}).textContent, "4 CU");
  doc.byId("pop-scrim").click();

  // Advanced: Quality, Medium by default; High reprices.
  doc.byId("gear").click();
  await waitFor(() => doc.byId("pop").getAttribute("data-menu") === "adv", { label: "Advanced open" });
  assert.ok(find(doc, "data-adv", "quality:medium").className.includes("on"));
  find(doc, "data-adv", "quality:high").click();
  doc.byId("pop-scrim").click();
  await button(doc, "Make versions · 8 CU");

  doc.byId("go").click();
  await landed(app);
  const body = mock.paidCalls[0].body;
  assert.equal(body.quality, "high");
  assert.equal(body.referenceImages.length, 2, "the layer, then the style picture");
  assert.match(body.prompt, /Use the last reference image for its style only \(colors, rendering, texture\), not for its content\.$/);
  // Removing the picture puts the Style chip back on No style.
  const d = ps.doc(7);
  d.activeLayers = [d.layers[d.layers.length - 1]];
  fire(ps);
  await ctxTitle(doc, "Background · Layer 1024 × 1024");
  const x = findAll(doc, "data-ref").find((e) => /\bsref\b/.test(e.className)).children.find((c) => c.className === "sx");
  x.click();
  await waitFor(() => find(doc, "data-pop", "style").textContent.includes("No style"), { label: "No style again" });
});

test("an open popover hides the prompt field behind a stand-in of the same text (UXP draws text fields above popovers), and closing it puts the field back", async (t) => {
  const { app, doc, ps } = await bootGenerate(t, { docs: [POSTER], active: 7, mockOpts: { answer: flarePrice() } });
  await show(app, ps);
  await waitFor(() => doc.byId("prompt").style.display === "block", { label: "the prompt shows" });
  doc.type("prompt", "a red kite");
  find(doc, "data-pop", "takes").click();
  await waitFor(() => doc.byId("pop").style.display !== "none" && doc.byId("pop").style.display !== "", { label: "the Takes menu opens" });
  assert.equal(doc.byId("prompt").style.display, "none", "the field is hidden while the menu is open");
  assert.equal(doc.byId("prompt-ghost").style.display, "block");
  assert.equal(doc.byId("prompt-ghost").textContent, "a red kite", "the stand-in shows the prompt");
  doc.byId("pop-scrim").click();
  await waitFor(() => doc.byId("prompt").style.display === "block", { label: "the field is back" });
  assert.equal(doc.byId("prompt-ghost").style.display, "none");
});

test("Replace inside: the Edit chip reads Inside selection on Precise Edit; Bolder switches to Flare and its price, the Model menu sets the chip, the choice stays with Replace inside", async (t) => {
  const sel = { left: 100, top: 200, width: 512, height: 512 };
  const answer = (model, body) => {
    const n = Number(body.numOutputs) || 1;
    if (model === PRECISE) return cost(4 * n);
    if (model === FLARE) return cost(1 + n);
    if (model === IDEOGRAM) return cost(5 * n);
    return null;
  };
  const { app, doc, ps } = await bootGenerate(t, { docs: [{ ...POSTER, selection: sel }], active: 7, mockOpts: { answer } });
  await show(app, ps);
  await ctxTitle(doc, "Selection 512 × 512 on Background");
  doc.type("prompt", "A red kite");
  await button(doc, "Replace inside · 8 CU");
  const chipText = () => find(doc, "data-pop", "edit").textContent;
  assert.match(chipText(), /Edit\s*Inside selection/);
  const pop = await popOpen(doc, "edit");
  await waitFor(() => /3 CU/.test(pop.textContent) && /8 CU/.test(pop.textContent), { label: `each choice priced (now ${pop.textContent})` });
  assert.match(pop.textContent, /Everything outside stays as it is/);
  assert.match(pop.textContent, /may reach past the selection/);
  assert.ok(!/\u2014/.test(pop.textContent), "no em dash");
  const bolder = menuValues(doc).find((e) => e.getAttribute("data-value") === "bolder");
  bolder.click();
  await button(doc, "Replace inside · 3 CU");
  assert.match(chipText(), /Bolder/);
  assert.equal(app.controller.state().models.replace, FLARE);
  // Remove keeps its own model: Ideogram 4.5.
  find(doc, "data-act", "remove").click();
  await button(doc, "Remove · 10 CU");
  assert.equal(findAll(doc, "data-pop", "edit").length, 0, "Remove has no Edit chip");
  find(doc, "data-act", "replace").click();
  doc.type("prompt", "A red kite");
  await button(doc, "Replace inside · 3 CU");
  assert.match(chipText(), /Bolder/, "the choice is kept for Replace inside");
  // A model without mask growth picked in the Model menu reads Inside selection.
  app.controller.choose("model", IDEOGRAM);
  await button(doc, "Replace inside · 10 CU");
  assert.match(chipText(), /Inside selection/);
  app.controller.choose("edit", "inside");
  await button(doc, "Replace inside · 10 CU");
  app.controller.choose("edit", "bolder");
  await button(doc, "Replace inside · 3 CU");
  app.controller.choose("edit", "inside");
  await button(doc, "Replace inside · 8 CU");
  assert.equal(app.controller.state().models.replace, undefined, "back on the recommended model");
});

test("Remove on a selection: the job records that the selection should be cleared, so the checks measure how much of it came back unchanged", async (t) => {
  const sel = { left: 100, top: 200, width: 512, height: 512 };
  const { app, doc, ps } = await bootGenerate(t, { docs: [{ ...POSTER, selection: sel }], active: 7, mockOpts: { answer: flarePrice() } });
  await show(app, ps);
  await ctxTitle(doc, "Selection 512 × 512 on Background");
  find(doc, "data-act", "remove").click();
  await waitFor(() => /^Remove · \d/.test(go(doc)), { label: "Remove is priced without a prompt" });
  doc.byId("go").click();
  await landed(app);
  const rec = app.ledger.all()[0];
  assert.equal(rec.target.expect, "cleared", "the record keeps the expectation");
  const checks = rec.placement && rec.placement.checks && rec.placement.checks[0];
  assert.ok(checks && typeof checks.kept_share === "number", "the checks measured the share left unchanged");
  // The run goes by its action, not by the text of the built-in prompt.
  assert.match(ps.doc(7).layers[0].name, /^Scenario edit remove( |$)/);
  await waitFor(() => app.controller.model().card && app.controller.model().card.title === "Remove", { label: "the card reads Remove" });
});

test("Cut out subject on a selection: a new layer above, the layer untouched, the selection dropped in the same History state; the new layer is selected and the context becomes the cut-out, led by Add background", async (t) => {
  const sel = { left: 200, top: 200, width: 400, height: 400 };
  // The measured table has 851 Labs at other sizes: 1 CU at any size here.
  const answer = (model) => (model === "model_851-labs-background-remover" ? cost(1) : null);
  const { app, doc, ps } = await bootGenerate(t, { docs: [{ ...POSTER, selection: sel }], active: 7, mockOpts: { answer } });
  await show(app, ps);
  await ctxTitle(doc, "Selection 400 × 400 on Background");
  find(doc, "data-act", "cutout").click();
  await button(doc, "Cut out subject · 1 CU");
  doc.byId("go").click();
  await landed(app);
  const d = ps.doc(7);
  assert.equal(d.layers.length, 2, "a new layer above the Background");
  assert.ok(d.layers[0].mask && d.layers[0].mask.data, "the new layer is masked to the subject");
  assert.ok(!d.layers[1].mask, "the Background stays untouched");
  assert.equal(d.selection, null, "the selection is dropped");
  assert.deepEqual(ps.history.filter((h) => h.document_id === 7), [{ document_id: 7, name: "Scenario: Place cutout" }], "one History state");
  await waitFor(() => d.activeLayers.length === 1 && d.activeLayers[0] === d.layers[0], { label: "the new layer selected" });
  await waitFor(() => chips(doc)[0] === "background", { label: `the cut-out context (now ${chips(doc).join(",")})` });
  assert.deepEqual(onChip(doc), ["background"]);
});

test("contexts: a cut-out layer offers Add background first; a pixel layer that covers the canvas is a plain layer; the agent card shows only for a request", async (t) => {
  const DOC = { ...POSTER, layers: [{ name: "Bottle", kind: "pixel", frame: { left: 300, top: 200, width: 400, height: 600 } }, { name: "Background", background: true }] };
  const { app, doc, ps } = await bootGenerate(t, { docs: [DOC], active: 7 });
  await show(app, ps);
  await ctxTitle(doc, "Bottle · Layer 400 × 600");
  assert.deepEqual(chips(doc), ["background", "relight", "versions", "upscale", "extend", "more"]);
  assert.equal(doc.byId("ctx-thumb").className, "ctx-thumb chk", "a checkerboard behind a cut-out");
  assert.equal(doc.text("ctx-detail"), "Lands below Bottle at canvas size");
  await waitFor(() => findAll(doc, "data-ref", "auto").length === 1, { label: "the automatic reference" });
  // What the reference is shows in the row's hint while the pointer is on
  // it, never as a native tooltip over the prompt.
  const auto = find(doc, "data-ref", "auto");
  assert.equal(auto.getAttribute("title"), null, "no tooltip over the prompt");
  const hint = () => doc.byId("refs").children.filter((e) => e.className === "hint").map((e) => e.textContent).join("");
  const before = hint();
  auto.dispatch("mouseenter");
  assert.equal(hint(), "Bottle, for light and perspective", "the layer goes as a reference, not removable");
  auto.dispatch("mouseleave");
  assert.equal(hint(), before);
  assert.equal(find(doc, "data-ref", "auto").children.some((c) => c.className === "rx"), false);
  ps.doc(7).activeLayers = [ps.doc(7).layers[1]];
  fire(ps);
  await ctxTitle(doc, "Background · Layer 1024 × 1024");
  assert.deepEqual(onChip(doc), ["versions"]);

  // F5: no card until an agent asks; Decline tells the agent and spends nothing.
  assert.equal(doc.byId("agent-card").style.display, "none");
  let declined = 0;
  app.controller.showAgentRequest({ client_name: "Claude", what: "Make versions", prompt: "warmer light", model_name: "GPT Image 2.5 Flare", cu: "3 CU", approve: () => {}, decline: () => declined++ });
  await waitFor(() => doc.byId("agent-card").style.display !== "none", { label: "the agent card" });
  assert.match(doc.text("agent-who"), /Claude/);
  doc.byId("agent-decline").click();
  assert.equal(declined, 1);
  await waitFor(() => doc.byId("agent-card").style.display === "none", { label: "card gone" });
  assert.equal(doc.text("declined"), ctlMod.TEXT.declined);
  assert.equal(doc.byId("declined").style.display, "block");
});

test("view-model helpers: classify, takesOf, isCutout, badgeOf, needsConfirm; the actions table: chips, More, pins, built-in prompts", () => {
  const D = { id: 1, width: 1000, height: 1000 };
  assert.equal(ctlMod.classify({ doc: null }).kind, "none");
  assert.equal(ctlMod.classify({ doc: D, selection: { width: 1 } }).kind, "selection");
  assert.equal(ctlMod.classify({ doc: D, selection: null, selection_raw: { width: 1 } }).kind, "selection", "a feathered selection is a selection");
  const L = { id: 2, kind: "pixel", bounds: { left: 0, top: 0, width: 1000, height: 1000 } };
  assert.equal(ctlMod.classify({ doc: D, layer: L }, null).kind, "layer");
  assert.equal(ctlMod.classify({ doc: D, layer: { ...L, has_mask: true } }, null).kind, "cutout");
  assert.equal(ctlMod.classify({ doc: D, layer: { ...L, bounds: { left: 0, top: 0, width: 500, height: 1000 } } }, null).kind, "cutout");
  assert.equal(ctlMod.classify({ doc: D, layer: { ...L, background: true, has_mask: true } }, null).kind, "layer");
  assert.equal(ctlMod.classify({ doc: D, layer: { ...L, kind: "text", has_mask: true } }, null).kind, "layer");
  const group = { id: 9, group: true, name: "G", fields: { jobId: "j", kind: "image", prompt: "p" }, children: [{ id: 10, name: "Take 1", visible: true, fields: { jobId: "j", assetId: "a", take: "1" } }] };
  assert.equal(ctlMod.classify({ doc: D, layer: L }, group).kind, "takes");
  assert.equal(ctlMod.takesOf({ ...group, children: [{ id: 11, name: "Scenario image other", visible: true, fields: { jobId: "k", assetId: "b", take: "1" } }] }), null, "another run's layer in the group is not one of its takes");
  const named = { ...group, children: [{ id: 12, name: "Take 1 a copy", visible: true, fields: { jobId: "j", assetId: "a", take: "1" } }] };
  assert.equal(ctlMod.takesOf(named), null, "a copy named after its take is the person's layer, also once the take is gone");
  const renamed = { ...group, children: [{ id: 13, name: "my favourite", visible: true, fields: { jobId: "j", assetId: "a", take: "1" } }] };
  assert.equal(ctlMod.takesOf(renamed).children.length, 1, "a take the person renamed is still a take");
  assert.equal(ctlMod.takesOf({ ...group, fields: { jobId: "j", kind: "cutout" } }), null, "a cut-out is no takes run");
  assert.equal(ctlMod.takesOf({ ...group, children: [] }), null);
  const single = ctlMod.takesOf({ id: 3, name: "Scenario image x", fields: { jobId: "j", assetId: "a", kind: "image" } });
  assert.equal(single.layer_id, 3);
  assert.equal(ctlMod.takesOf({ id: 3, parent: 9, fields: { jobId: "j", assetId: "a", kind: "image" } }), null, "a take inside a group reads through its group");
  assert.equal(ctlMod.isCutout({ ...L, has_mask: true }, D, { fields: { assetId: "a" } }), false, "a Scenario result is not a cut-out");
  assert.deepEqual(ctlMod.badgeOf(["Seam ok"]), { tone: "ok", text: "Edges ok" });
  assert.deepEqual(ctlMod.badgeOf(["May be misaligned"]), { tone: "warn", text: "May not line up" });
  assert.equal(ctlMod.badgeOf([]), null);
  assert.equal(ctlMod.needsConfirm({ price_kind: "exact", cu_cost: 100 }, 100000), false, "at the limit: no card");
  assert.equal(ctlMod.needsConfirm({ price_kind: "exact", cu_cost: 100.5 }, 100000), true);
  assert.equal(ctlMod.needsConfirm({ price_kind: "from", cu_cost: 1 }, 100000), true, "a from price always asks");
  assert.equal(ctlMod.needsConfirm({ price_kind: "range", cu_cost: 50, cu_cost_max: 120 }, 100000), true, "a range compares its top");

  for (const kind of Object.keys(actions.CONTEXTS)) {
    const list = actions.chipsFor(kind, {});
    assert.ok(list.length <= actions.MAX_CHIPS);
    for (const id of list) assert.ok(actions.ACTIONS[id], `${kind}: ${id} exists`);
    for (const g of actions.moreFor(kind, {}, null)) for (const it of g.items) assert.ok(actions.ACTIONS[it.id].family || actions.ACTIONS[it.id].grid, `More lists only actions that run: ${it.id}`);
  }
  let pins = actions.togglePin({}, "layer", "upscale_layer");
  assert.deepEqual(pins.layer, ["upscale_layer"]);
  pins = actions.togglePin(pins, "layer", "cutout_layer");
  assert.deepEqual(actions.chipsFor("layer", pins), ["versions", "extend", "upscale", "remove_bg", "new_layer", "upscale_layer"], "at most six chips");
  assert.deepEqual(pins.layer, ["upscale_layer"], "a seventh pin is refused");
  assert.deepEqual(actions.togglePin(pins, "layer", "upscale_layer").layer, []);
  assert.deepEqual(actions.togglePin({}, "layer", "replace").layer, [], "only More's actions pin");
  assert.equal(actions.promptFor("versions", ""), actions.BUILTIN.variations);
  assert.equal(actions.promptFor("versions", " warmer "), "warmer");
  assert.equal(actions.promptFor("replace", ""), null, "a needed prompt has no stand-in");
  assert.equal(actions.promptFor("remove", "ignored"), actions.BUILTIN.remove);
  assert.equal(actions.promptFor("upscale", "x"), null);
  assert.equal(actions.factorLabel({ factor: "4x" }), "×4");
  assert.equal(actions.plural(1, "take"), "1 take");
});

test("document references in the XMP packet: read, write keeping the other fields, clean", () => {
  const docRefs = require("../../plugin/src/panel/doc-refs.js");
  const list = [{ role: "Character", layer_id: 4, name: 'Hero "A" & co' }];
  const packet = docRefs.write(null, list);
  assert.deepEqual(docRefs.read(packet), list);
  const other = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="image/vnd.adobe.photoshop"/></rdf:RDF></x:xmpmeta>';
  const both = docRefs.write(other, list);
  assert.match(both, /dc:format="image\/vnd.adobe.photoshop"/, "other fields kept");
  assert.deepEqual(docRefs.read(both), list);
  const again = docRefs.write(both, [{ role: "Set", layer_id: 5, name: "Room" }]);
  assert.deepEqual(docRefs.read(again), [{ role: "Set", layer_id: 5, name: "Room" }], "rewritten in place");
  assert.equal((again.match(/scenario:references=/g) || []).length, 1);
  assert.doesNotMatch(docRefs.write(again, []), /scenario:references=/, "an empty list removes the field");
  assert.deepEqual(docRefs.clean([{ role: "Villain", layer_id: 1 }, { role: "Set", layer_id: 0 }, { role: "Set", layer_id: 2 }, { role: "Style", layer_id: 2 }]), [{ role: "Set", layer_id: 2, name: "Layer" }]);
  assert.deepEqual(docRefs.read("<x:xmpmeta/>"), []);
  assert.deepEqual(docRefs.read('<rdf:Description scenario:references="not json"/>'), []);
});

test("a failed job is refunded: the card says what Scenario answered; the context card shows the progress while it runs", async (t) => {
  const { app, doc, ps } = await bootGenerate(t, { docs: [POSTER], active: 7, pollMs: 60, mockOpts: { answer: flarePrice(), jobPlan: () => ["in-progress", "in-progress", "failure"] } });
  await show(app, ps);
  find(doc, "data-act", "new_layer").click();
  doc.type("prompt", "A paper kite");
  await button(doc, "New layer · 3 CU");
  doc.byId("go").click();
  await waitFor(() => doc.byId("ctx-prog").style.display === "block", { label: "progress in the context card" });
  assert.match(doc.text("ctx-detail"), /^(Sending to Scenario|Queued on Scenario|Generating 2 takes)$/);
  await waitFor(() => app.ledger.all()[0] && app.ledger.all()[0].state === "failed", { label: "failed" });
  const rec = app.ledger.all()[0];
  assert.equal(rec.cu_charged, "0");
  assert.equal(rec.refunded, true);
  await waitFor(() => findAll(doc, "data-card", "single").length === 1, { label: "the run's card" });
  assert.match(find(doc, "data-card", "single").textContent, /Failed: Ensure that both width and height/);
  await waitFor(() => doc.byId("ctx-prog").style.display === "none", { label: "progress gone" });
});

test("restart: submitting becomes Unknown, uploading becomes not sent, a queued job resumes polling and waits in Jobs to be placed", async (t) => {
  const id = (n) => `0000000${n}-0000-4000-8000-000000000000`;
  const base = { origin: { kind: "person" }, lane: "image", model_id: FLARE, model_name: "GPT Image 2.5 Flare", parameters: { prompt: "a quiet harbor", width: 1024, height: 1024, quality: "low", numOutputs: 1 }, inputs: { references: [], asset_ids: [] }, target: { kind: "canvas", document_id: 7, document_title: "poster.psd", box: [0, 0, 1024, 1024], session: "previous" }, session: "previous", cu_quoted: "2", outputs: [], revision: 3, created_at: "2026-10-19T08:00:00.000Z" };
  const files = new Map([
    [`jobs/${id(1)}.json`, JSON.stringify({ ...base, local_id: id(1), state: "submitting", idempotency_key: "quote_a", fingerprint: "a" })],
    [`jobs/${id(2)}.json`, JSON.stringify({ ...base, local_id: id(2), state: "uploading_inputs", idempotency_key: "quote_b", fingerprint: "b" })],
    [`jobs/${id(3)}.json`, JSON.stringify({ ...base, local_id: id(3), state: "queued", job_id: "job_mock1", idempotency_key: "quote_c", fingerprint: "c", submitted_at: "2026-10-19T08:00:01.000Z" })]
  ]);
  const { app, ps, mock, doc } = await bootGenerate(t, { docs: [POSTER], active: 7, psOpts: { files } });
  mock.jobs.set("job_mock1", { id: "job_mock1", model: FLARE, body: base.parameters, polls: 0, charge: 2, plan: ["success"] });
  const get = (n) => app.ledger.get(id(n));
  assert.equal(get(1).state, "uncertain");
  assert.equal(get(2).state, "not_sent");
  await waitFor(() => get(3).state === "ready", { label: "resumed", timeout: 6000 });
  await sleep(200);
  assert.equal(ps.history.length, 0, "nothing lands by itself after a restart");
  await waitFor(() => doc.text("jobs-badge") === "3", { label: "the header counts the jobs" });
  const jp3 = await openJobs(doc);
  assert.equal(jp3.rows.length, 3);
  jp3.all();
  const row3 = doc.byId("jobs-list").children.find((r) => r.getAttribute("data-job") === id(3));
  assert.deepEqual(rowActions(row3).map((b) => b.getAttribute("data-action")), ["place", "open"]);
  rowActions(row3)[0].click();
  await waitFor(() => get(3).state === "applied", { label: "placed from Jobs" });
  assert.deepEqual(ps.history, [{ document_id: 7, name: "Scenario: Place image" }]);
});
