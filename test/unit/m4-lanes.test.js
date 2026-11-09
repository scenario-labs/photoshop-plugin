"use strict";
// M4, the Edit and Enhance lanes end to end without the panel: the plugin
// source (main.js, lanes/flow.js) on the real host adapter over the fake
// Photoshop in scene mode (real pixels: composites, layer reads, masks,
// canvas growth), against the fixture mock with paid generation on. Each
// paid path: the price shown, the capture and mask uploaded, the second price
// check, one paid call, the result placed in one History state, the checks
// on the placed pixels. Takes are built from the document itself, so the
// checks see a real edit; defective takes show that a failed check only adds
// a badge and never removes a paid result.

const test = require("node:test");
const assert = require("node:assert/strict");
const png = require("../../plugin/src/util/png.js");
const results = require("../../plugin/src/lanes/results.js");
const { bootGenerate, FLARE } = require("../helpers/generate-sim.js");
const { waitFor } = require("../helpers/fakes.js");
const { records } = require("../helpers/fixture-scenario.js");

const PROMPT = "a brass lantern";

function costAnswer(cu) {
  return { status: 200, body: { creativeUnitsCost: cu, creativeUnitsDiscount: 0, costDetails: { "custom-generation": cu } } };
}

function pngOf(img) {
  return Buffer.from(png.encodePng({ width: img.width, height: img.height, channels: img.components, data: img.data }));
}

// A CDN answering each take with the PNG takes[i] (by the asset id's take
// number), straight away.
function cdnFor(takes) {
  return (r) => {
    const id = decodeURIComponent(r.path.split("/")[2] || "");
    const m = /Take(\d+)$/.exec(id);
    if (!m || !takes[Number(m[1]) - 1]) return undefined;
    return { status: 200, body: takes[Number(m[1]) - 1](), headers: { "content-type": "image/png" } };
  };
}

// Paints a rectangle (in image pixels) of img with rgb.
function paint(img, x0, y0, w, h, rgb) {
  const out = { ...img, data: Uint8Array.from(img.data) };
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) for (let c = 0; c < 3; c++) out.data[(y * img.width + x) * img.components + c] = rgb[c];
  return out;
}

function shiftAll(img, d) {
  const out = { ...img, data: Uint8Array.from(img.data) };
  for (let i = 0; i < out.data.length; i++) if (img.components !== 4 || i % 4 !== 3) out.data[i] = Math.max(0, Math.min(255, out.data[i] + d));
  return out;
}

const recOf = (app) => app.ledger.all()[0];
async function settled(app, states = ["applied"]) {
  return waitFor(() => {
    const r = recOf(app);
    return r && states.includes(r.state) ? r : null;
  }, { label: `job ${states.join(" or ")}`, timeout: 8000 });
}

function cleanMock(mock) {
  assert.deepEqual(mock.violations, []);
  for (const r of mock.requests.filter((x) => x.path.startsWith("/v1/generate") && x.search !== "")) assert.equal(r.search, "?dryRun=true");
}

test("Edit, selection on GPT Image 2.5 Flare: measured price, capture and mask uploaded, one paid call, masked placement, seam and outside checks pass", async (t) => {
  const DOC = { id: 7, title: "poster.psd", width: 2048, height: 2048, selection: { left: 768, top: 768, width: 512, height: 512 } };
  let ps;
  const take = (tint) => () => {
    // The context the plugin reads (box 512..1536 at 1024 px), changed inside
    // the selection only (take coordinates 256..768).
    const ctx = ps.composite(7, { left: 512, top: 512, width: 1024, height: 1024 }, 1024, 1024);
    // A new object with the surface around it, as a clean edit leaves it (a
    // flat fill over the whole selection is a patch at its edge).
    const edited = paint(ctx, 352, 352, 320, 320, [200, 40, 30]);
    return pngOf(tint ? shiftAll(edited, tint) : edited);
  };
  const sim = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true }, mockOpts: { cdn: cdnFor([take(0), take(25)]) } });
  ps = sim.ps;
  const { app, mock } = sim;

  const p = await app.flow.price({ tool: "edit", prompt: PROMPT });
  assert.equal(p.state, "ready", p.reason);
  assert.equal(p.quote.label, "3 CU", "the measured price of a 1024 x 1024 edit, 2 takes, low");
  assert.equal(p.view.source.text, "Selection 512 x 512");
  assert.deepEqual(p.view.sizes.upload, { width: 1024, height: 1024 });
  assert.deepEqual(p.req.target.box, [512, 512, 1024, 1024]);
  assert.equal(p.view.mask, true);
  assert.equal(mock.paidCalls.length, 0, "nothing paid at the price check");

  const out = await app.flow.generate({ tool: "edit", prompt: PROMPT }, p.quote);
  assert.equal(out.state, "queued");
  const rec = await settled(app);
  cleanMock(mock);

  // Uploads: the context (JPEG, Flare takes it) and the mask in alpha polarity.
  const ups = mock.uploads.filter((u) => /^photoshop-(capture|mask)-/.test(u.name));
  assert.deepEqual(ups.map((u) => [u.name.split("-")[1], u.width, u.height, u.mime]), [["capture", 1024, 1024, "image/jpeg"], ["mask", 1024, 1024, "image/png"]]);
  assert.equal(mock.paidCalls.length, 1);
  const body = mock.paidCalls[0].body;
  assert.deepEqual(body.referenceImages, [ups[0].id], "the capture is the first reference");
  assert.equal(body.mask, ups[1].id);
  assert.deepEqual([body.width, body.height, body.numOutputs, body.quality], [1024, 1024, 2, "low"]);
  const second = mock.priceChecks.filter((c) => c.body.referenceImages);
  assert.equal(second.length, 1, "one price check after upload, with the real asset ids");
  assert.equal(second[0].matched, true);

  // Placement: one History state, two takes in a group, the mask on the group.
  assert.deepEqual(ps.history, [{ document_id: 7, name: "Scenario: Place edit" }]);
  const group = ps.doc(7).layers[0];
  assert.equal(group.kind, "group");
  assert.ok(group.mask && group.mask.data, "the selection mask is on the group");
  assert.equal(rec.placement.masked, true);
  // Checks: take 1 is a clean edit; take 2 has its edge tone off.
  assert.ok(rec.placement.badges[0].includes("Seam ok"), JSON.stringify(rec.placement.badges));
  assert.ok(!rec.placement.badges[0].includes("Changed outside"));
  assert.equal(rec.placement.verify.untouched, true);
  assert.ok(rec.placement.checks[0].edited);
  assert.ok(rec.placement.badges[1].includes("Edge tone differs"), JSON.stringify(rec.placement.badges));
  // Outside the selection, past the feather, the document is as it was.
  const before = { left: 0, top: 0, width: 2048, height: 700 };
  const now = ps.composite(7, before, 512, 175);
  ps.doc(7).layers[0].visible = false;
  const without = ps.composite(7, before, 512, 175);
  assert.deepEqual(Buffer.from(now.data), Buffer.from(without.data));
  if (process.env.M4_DEBUG) console.log(JSON.stringify(rec.placement, null, 1));
  const card = results.card(rec);
  assert.equal(card.title, "Edit");
  assert.equal(card.actions.undo, false);
  // The capture is linked to its job (SPEC 9.3).
  const capId = rec.inputs.capture.id;
  assert.equal(JSON.parse(ps.files.get(`captures/${capId}/capture.json`)).local_id, rec.local_id);
  assert.ok(ps.files.get(`captures/${capId}/mask.png`));
});

async function doneRec(app, localId, states = ["applied"]) {
  return waitFor(() => {
    const r = app.ledger.get(localId);
    return r && states.includes(r.state) ? r : null;
  }, { label: `job ${states.join(" or ")}`, timeout: 8000 });
}

test("a failed check never removes a paid result: Changed outside is a badge with Undo; Undo steps back Scenario's own History state and the result stays saved", async (t) => {
  const DOC = { id: 7, title: "poster.psd", width: 2048, height: 2048, selection: { left: 768, top: 768, width: 512, height: 512 } };
  let ps;
  // A take changed everywhere, and a mask Photoshop does not apply.
  const take = () => () => pngOf(shiftAll(paint(ps.composite(7, { left: 512, top: 512, width: 1024, height: 1024 }, 1024, 1024), 256, 256, 512, 512, [10, 200, 10]), 40));
  const sim = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true, maskBroken: true }, mockOpts: { cdn: cdnFor([take(), take()]) } });
  ps = sim.ps;
  const { app, mock } = sim;
  const p = await app.flow.price({ tool: "edit", prompt: PROMPT });
  const out = await app.flow.generate({ tool: "edit", prompt: PROMPT }, p.quote);
  const rec = await doneRec(app, out.record.local_id);
  assert.equal(rec.state, "applied", "placed, whatever the checks say");
  assert.ok(rec.placement.badges[0].includes("Changed outside"), JSON.stringify(rec.placement.badges));
  assert.ok(rec.placement.badges[0].includes("Edge tone differs"));
  assert.equal(rec.placement.verify.untouched, false);
  const card = results.card(rec);
  assert.equal(card.actions.undo, true);
  assert.match(card.notes[0], /Undo puts the document back/);
  assert.equal(ps.doc(7).layers.length, 2, "the group and the Background");

  const undone = await app.runner.undo(rec.local_id);
  assert.equal(undone.state, "ready");
  assert.equal(undone.placement.undone, true);
  assert.deepEqual(ps.undone, [{ document_id: 7, name: "Scenario: Place edit" }]);
  assert.deepEqual(ps.doc(7).layers.map((l) => l.name), ["Background"], "the document is as it was");
  assert.ok(rec.outputs.every((o) => ps.files.get(o.path)), "the results stay saved");
  assert.equal(results.card(app.ledger.get(rec.local_id)).actions.undo, false);
  // The saved result places again (no new spend).
  await app.runner.place(rec.local_id);
  assert.equal(app.ledger.get(rec.local_id).state, "applied");
  assert.equal(mock.paidCalls.length, 1);
});

test("Edit with no selection: the whole canvas, no mask input filled, lands unmasked, no alignment badges", async (t) => {
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 1024 };
  const { app, mock, ps } = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true } });
  const p = await app.flow.price({ tool: "edit", prompt: PROMPT });
  assert.equal(p.state, "ready", p.reason);
  assert.equal(p.quote.label, "3 CU");
  assert.equal(p.view.source.text, "All visible");
  assert.equal(p.view.mask, false);
  assert.deepEqual(p.view.notes, ["No selection: edits the whole canvas, lands unmasked."]);
  const out = await app.flow.generate({ tool: "edit", prompt: PROMPT }, p.quote);
  const rec = await doneRec(app, out.record.local_id);
  cleanMock(mock);
  const body = mock.paidCalls[0].body;
  assert.equal(body.mask, undefined, "no mask sent");
  assert.equal(body.referenceImages.length, 1);
  assert.equal(rec.placement.masked, false);
  assert.equal(ps.doc(7).layers[0].mask, null);
  for (const b of rec.placement.badges) assert.ok(!b.includes("May be misaligned") && !b.includes("Unchanged inside"), JSON.stringify(b));
});

test("Trained edit, reference route: FLUX.2 Dev with a LoRA, the capture as the first reference, no mask input, masked by Photoshop; ledger keeps base and trained ids", async (t) => {
  const LORA = "model_JJ54CEwcWD5upeaCuLD83Ddh";
  const BASE = "model_bfl-flux-2-dev";
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 1024, selection: { left: 384, top: 384, width: 256, height: 256, shape: "ellipse", feather: 4 } };
  let ps;
  const take = () => () => pngOf(paint(ps.composite(7, { left: 256, top: 256, width: 512, height: 512 }, 512, 512), 160, 160, 192, 192, [230, 180, 40]));
  const sim = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true }, mockOpts: { answer: (model) => (model === BASE ? costAnswer(9) : undefined), cdn: cdnFor([take(), take()]) } });
  ps = sim.ps;
  const { app, mock } = sim;
  const a = { tool: "trained_edit", model_id: BASE, trained: { model_id: LORA, kind: "lora", scale: 0.8 }, prompt: PROMPT };
  const p = await app.flow.price(a);
  assert.equal(p.state, "ready", p.reason);
  assert.equal(p.view.route, "reference");
  assert.equal(p.view.experimental, true);
  assert.equal(p.view.prompt_hint, "Say what to change and what to keep");
  assert.equal(p.view.mask, false, "FLUX.2 Dev takes no mask");
  assert.deepEqual(p.view.sizes.upload, { width: 512, height: 512 });
  const out = await app.flow.generate(a, p.quote);
  const rec = await doneRec(app, out.record.local_id);
  cleanMock(mock);
  const body = mock.paidCalls[0].body;
  const cap = mock.uploads.find((u) => u.name.startsWith("photoshop-capture-"));
  assert.deepEqual(body.referenceImages, [cap.id]);
  assert.deepEqual(body.loras, [LORA]);
  assert.deepEqual(body.lorasScale, [0.8]);
  assert.equal(body.mask, undefined);
  assert.deepEqual([body.width, body.height], [512, 512]);
  assert.equal(rec.model_id, BASE);
  assert.deepEqual(rec.trained_model_ids, [LORA]);
  assert.equal(rec.placement.masked, true, "Photoshop's mask keeps the change inside the selection");
  assert.ok(rec.placement.badges[0].includes("Seam ok"), JSON.stringify(rec.placement.badges));
  assert.equal(rec.placement.verify.untouched, true);
  assert.equal(results.card(rec).title, "Trained edit");
});

test("Trained edit, image and strength route: Z-Image with a LoRA, the capture as image, Change amount from the schema", async (t) => {
  const LORA = "model_fixtureZimageLora";
  const BASE = "model_z-image";
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 1024, selection: { left: 384, top: 384, width: 256, height: 256 } };
  let ps;
  const take = () => () => pngOf(paint(ps.composite(7, { left: 256, top: 256, width: 512, height: 512 }, 512, 512), 176, 176, 160, 160, [90, 60, 200]));
  const sim = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true }, mockOpts: { answer: (model) => (model === BASE ? costAnswer(4) : undefined), cdn: cdnFor([take(), take()]) } });
  ps = sim.ps;
  const { app, mock } = sim;
  const a = { tool: "trained_edit", model_id: BASE, trained: { model_id: LORA, kind: "lora", scale: 0.75 }, prompt: PROMPT, takes: 1 };
  const p = await app.flow.price(a);
  assert.equal(p.state, "ready", p.reason);
  assert.equal(p.view.route, "image_strength");
  assert.equal(p.view.controls.change_amount.value, 0.6);
  const out = await app.flow.generate(a, p.quote);
  const rec = await doneRec(app, out.record.local_id);
  cleanMock(mock);
  const body = mock.paidCalls[0].body;
  const cap = mock.uploads.find((u) => u.name.startsWith("photoshop-capture-"));
  assert.equal(body.image, cap.id);
  assert.equal(body.strength, 0.6);
  assert.equal(body.numOutputs, 1, "one take, not the base's default of 4");
  assert.deepEqual(rec.trained_model_ids, [LORA]);
  assert.ok(rec.placement.badges[0].includes("Seam ok"), JSON.stringify(rec.placement.badges));
});

// The new canvas with the original at (ox, oy) and the new area painted.
function expandedTake(ps, w, h, ow, oh, ox, oy, fill, tint = 0) {
  const ctx = ps.composite(7, { left: 0, top: 0, width: ow, height: oh }, ow, oh);
  const out = { width: w, height: h, components: 3, data: new Uint8Array(w * h * 3) };
  for (let i = 0; i < w * h; i++) out.data.set(fill, i * 3);
  for (let y = 0; y < oh; y++) out.data.set(ctx.data.subarray(y * ow * 3, (y + 1) * ow * 3), ((y + oy) * w + ox) * 3);
  return tint ? shiftAll(out, tint) : out;
}

test("Expand, mask route on Flare: the new canvas at its own size, original at the anchor, new area clear, mask over the new area; canvas growth and placement in one History state", async (t) => {
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 768 };
  let ps;
  const sim = await bootGenerate(t, {
    docs: [DOC],
    active: 7,
    psOpts: { scene: true },
    mockOpts: { answer: (model, body) => (model === FLARE && body.mask ? costAnswer(2) : undefined), cdn: cdnFor([() => pngOf(expandedTake(ps, 1024, 1024, 1024, 768, 0, 128, [120, 150, 190]))]) }
  });
  ps = sim.ps;
  const { app, mock } = sim;
  // Flare is no longer the Extend default (Reframe, 2026-10-21); its mask
  // route is still offered, picked here by model.
  const a = { tool: "expand", model_id: FLARE, prompt: PROMPT, options: { ratio: "1:1", quality: "low" } };
  const p = await app.flow.price(a);
  assert.equal(p.state, "ready", p.reason);
  assert.equal(p.quote.label, "2 CU", "measured: 1024 x 1024, 1 take, low");
  assert.equal(p.view.sizes.text, "1024 x 768 to 1024 x 1024");
  assert.deepEqual(p.req.target.expand, { width: 1024, height: 1024, offset: [0, 128], sides: { left: 0, top: 128, right: 0, bottom: 128 } });
  const out = await app.flow.generate(a, p.quote);
  const rec = await doneRec(app, out.record.local_id);
  cleanMock(mock);
  const ups = mock.uploads.filter((u) => /^photoshop-(capture|mask)-/.test(u.name));
  assert.deepEqual(ups.map((u) => [u.width, u.height, u.mime]), [[1024, 1024, "image/png"], [1024, 1024, "image/png"]], "the capture has a clear new area, so PNG");
  const body = mock.paidCalls[0].body;
  assert.deepEqual(body.referenceImages, [ups[0].id]);
  assert.equal(body.mask, ups[1].id);
  assert.deepEqual(ps.resized.map((r) => [r.width, r.height]), [[1024, 896], [1024, 1024]], "left and top first, then right and bottom");
  assert.deepEqual(ps.history, [{ document_id: 7, name: "Scenario: Expand" }]);
  const d = ps.doc(7);
  assert.deepEqual([d.width, d.height], [1024, 1024]);
  assert.ok(d.layers[0].mask && d.layers[0].mask.data, "masked to the new area plus the overlap");
  assert.equal(rec.placement.masked, true);
  // The fixture paints the new area one flat color: the band lines up, and
  // the old edge shows a step (the check across the edge, 2026-10-21).
  assert.ok(rec.placement.badges[0].includes("Step at the old edge"), JSON.stringify(rec.placement.badges));
  assert.equal(rec.placement.verify.untouched, true, "the original stays authoritative inside");
  // The original's pixels, moved by the offset, are unchanged.
  const inside = ps.composite(7, { left: 100, top: 300, width: 800, height: 400 }, 200, 100);
  d.layers[0].visible = false;
  assert.deepEqual(Buffer.from(inside.data), Buffer.from(ps.composite(7, { left: 100, top: 300, width: 800, height: 400 }, 200, 100).data));
});

test("Expand, mask route on Flare: a redrawn frame 30 levels lighter is tone matched along the old edge; the matched copy lands, the take stays as it came", async (t) => {
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 768 };
  let ps;
  const sim = await bootGenerate(t, {
    docs: [DOC],
    active: 7,
    psOpts: { scene: true },
    mockOpts: { answer: (model, body) => (model === FLARE && body.mask ? costAnswer(2) : undefined), cdn: cdnFor([() => pngOf(expandedTake(ps, 1024, 1024, 1024, 768, 0, 128, [120, 150, 190], 30))]) }
  });
  ps = sim.ps;
  const { app } = sim;
  // Flare is no longer the Extend default (Reframe, 2026-10-21); its mask
  // route is still offered, picked here by model.
  const a = { tool: "expand", model_id: FLARE, prompt: PROMPT, options: { ratio: "1:1", quality: "low" } };
  const p = await app.flow.price(a);
  const out = await app.flow.generate(a, p.quote);
  const rec = await doneRec(app, out.record.local_id);
  assert.equal(rec.state, "applied");
  assert.equal(rec.placement.masked, true);
  assert.ok(rec.placement.notes.includes("Matched the new area's tone to the original along the old edge."), JSON.stringify(rec.placement.notes));
  assert.ok(rec.placement.checks[0].seam.bias < 4, "matched in the band: " + JSON.stringify(rec.placement.checks[0]));
  assert.ok(!/-landed\.png$/.test(rec.outputs[0].path), "the downloaded take is kept as it came");
  assert.equal(rec.placement.verify.untouched, true, "the original stays untouched past the band");
});

const { REFRAME } = require("../helpers/reframe-record.js");

test("Expand, position route (Reframe): the original and the anchor as position; a result that lines up lands masked, one that does not lands unmasked for manual alignment", async (t) => {
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 768 };
  let ps;
  let tint = 0;
  const sim = await bootGenerate(t, {
    docs: [DOC],
    active: 7,
    psOpts: { scene: true },
    mockOpts: { extraRecords: { [REFRAME.id]: REFRAME }, answer: (model) => (model === REFRAME.id ? costAnswer(6) : undefined), cdn: cdnFor([() => pngOf(expandedTake(ps, 1024, 1024, 1024, 768, 0, 0, [90, 140, 120], tint))]) }
  });
  ps = sim.ps;
  const { app, mock } = sim;
  const a = { tool: "expand", model_id: REFRAME.id, prompt: PROMPT, options: { ratio: "1:1", anchor: "top" } };
  const p = await app.flow.price(a);
  assert.equal(p.state, "ready", p.reason);
  // Reframe is the Extend default: its preset pins 2K (the measured price).
  assert.deepEqual(p.req.parameters, { aspectRatio: "1:1", resolution: "2K", position: "top", prompt: PROMPT });
  assert.equal(p.view.controls.sides_enabled, false);
  const out = await app.flow.generate(a, p.quote);
  const rec = await doneRec(app, out.record.local_id);
  cleanMock(mock);
  const cap = mock.uploads.find((u) => u.name.startsWith("photoshop-capture-"));
  assert.deepEqual([cap.width, cap.height], [1024, 768], "the original image, not a padded canvas");
  assert.equal(mock.paidCalls[0].body.image, cap.id);
  assert.equal(rec.placement.masked, true);
  // The fixture paints the new area one flat color: the band lines up, and
  // the old edge shows a step (the check across the edge, 2026-10-21).
  assert.ok(rec.placement.badges[0].includes("Step at the old edge"), JSON.stringify(rec.placement.badges));

  // A second run whose result does not match the original on the overlap.
  tint = 40;
  // Undo the first Expand so the canvas is the original again.
  await app.runner.undo(rec.local_id);
  const p2 = await app.flow.price(a);
  const out2 = await app.flow.generate(a, p2.quote);
  const rec2 = await doneRec(app, out2.record.local_id);
  assert.equal(rec2.state, "applied");
  assert.equal(rec2.placement.masked, false);
  assert.ok(rec2.placement.notes.some((n) => /Placed unmasked for manual alignment/.test(n)), JSON.stringify(rec2.placement.notes));
  assert.ok(rec2.placement.badges[0].includes("Edge tone differs"));
});

test("Expand, exact-size route (Photoroom): center only, the new size scaled to the model's maximum, no prompt; lands in a copy of the document", async (t) => {
  const PHOTOROOM = "model_photoroom-expand";
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 768 };
  let ps;
  const sim = await bootGenerate(t, {
    docs: [DOC],
    active: 7,
    psOpts: { scene: true },
    mockOpts: { answer: (model) => (model === PHOTOROOM ? costAnswer(15) : undefined), resultSize: (body) => ({ width: body.outputWidth || 1024, height: body.outputHeight || 1024 }), cdn: cdnFor([() => pngOf(expandedTake(ps, 1024, 1024, 1024, 768, 0, 128, [150, 120, 90]))]) }
  });
  ps = sim.ps;
  const { app, mock } = sim;
  const a = { tool: "expand", model_id: PHOTOROOM, options: { ratio: "1:1", anchor: "top", lands: "copy" } };
  const p = await app.flow.price(a);
  assert.equal(p.state, "ready", p.reason);
  assert.ok(p.view.notes.includes("This model expands around the center."));
  assert.equal(p.view.controls.anchor, "center");
  assert.deepEqual(p.req.parameters, { outputWidth: 1024, outputHeight: 1024 });
  const out = await app.flow.generate(a, p.quote);
  const rec = await doneRec(app, out.record.local_id);
  cleanMock(mock);
  assert.deepEqual(Object.keys(mock.paidCalls[0].body).sort(), ["image", "outputHeight", "outputWidth"]);
  const copyId = rec.placement.document_id;
  assert.notEqual(copyId, 7, "landed in a copy");
  assert.deepEqual([ps.doc(7).width, ps.doc(7).height], [1024, 768], "the original document is untouched");
  assert.deepEqual([ps.doc(copyId).width, ps.doc(copyId).height], [1024, 1024]);
  assert.deepEqual(ps.history, [{ document_id: copyId, name: "Scenario: Expand" }]);
  assert.equal(rec.placement.masked, true);
  // The fixture paints the new area one flat color: the band lines up, and
  // the old edge shows a step (the check across the edge, 2026-10-21).
  assert.ok(rec.placement.badges[0].includes("Step at the old edge"), JSON.stringify(rec.placement.badges));
});

test("Upscale on Topaz: lands as a new document, as a layer in this document, and over a selection box", async (t) => {
  const TOPAZ = "model_topaz-image-upscale";
  const DOC = { id: 7, title: "poster.psd", width: 512, height: 384 };
  // The size the mock's result has: the read times the factor.
  let next = { width: 1024, height: 768 };
  const sim = await bootGenerate(t, {
    docs: [DOC],
    active: 7,
    psOpts: { scene: true },
    mockOpts: { answer: (model) => (model === TOPAZ ? costAnswer(10) : undefined), resultSize: () => next }
  });
  const { app, mock, ps } = sim;

  const a1 = { tool: "upscale" };
  const p1 = await app.flow.price(a1);
  assert.equal(p1.state, "ready", p1.reason);
  assert.equal(p1.view.sizes.output_text, "Output 1024 x 768");
  assert.equal(p1.view.controls.lands, "new_document");
  const r1 = await doneRec(app, (await app.flow.generate(a1, p1.quote)).record.local_id);
  const cap = mock.uploads.find((u) => u.name.startsWith("photoshop-capture-"));
  assert.deepEqual([cap.width, cap.height, cap.mime], [512, 384, "image/png"]);
  assert.deepEqual(mock.paidCalls[0].body, { image: cap.id, upscaleFactor: "2x" });
  const newDoc = ps.doc(r1.placement.document_id);
  assert.notEqual(newDoc.id, 7);
  assert.deepEqual([newDoc.width, newDoc.height], [1024, 768]);
  assert.deepEqual(ps.history.at(-1), { document_id: newDoc.id, name: "Scenario: Place upscale" });

  ps.setActive(7);
  const a2 = { tool: "upscale", options: { lands: "layer" } };
  const p2 = await app.flow.price(a2);
  const r2 = await doneRec(app, (await app.flow.generate(a2, p2.quote)).record.local_id);
  assert.equal(r2.placement.document_id, 7);
  const l2 = ps.doc(7).layers[0];
  assert.deepEqual(l2.frame, { left: 0, top: 0, width: 512, height: 384 }, "the larger pixels in a smart object scaled to the source");
  assert.deepEqual(ps.history.at(-1), { document_id: 7, name: "Scenario: Place upscale" });

  ps.doc(7).selection = { left: 100, top: 80, width: 200, height: 150 };
  next = { width: 400, height: 300 };
  const a3 = { tool: "upscale", options: { source: "selection" } };
  const p3 = await app.flow.price(a3);
  assert.equal(p3.view.controls.lands, "box", "from a selection box, Layer over the box by default");
  const r3 = await doneRec(app, (await app.flow.generate(a3, p3.quote)).record.local_id);
  assert.deepEqual(ps.doc(7).layers[0].frame, { left: 100, top: 80, width: 200, height: 150 });
  assert.equal(r3.placement.masked, false);
  cleanMock(mock);
  assert.equal(mock.paidCalls.length, 3);
});

// An RGBA PNG: a disc of radius r at the centre, clear around it.
function discPng(w, h, r) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data.set([200, 120, 60], i);
      data[i + 3] = (x + 0.5 - w / 2) ** 2 + (y + 0.5 - h / 2) ** 2 <= r * r ? 255 : 0;
    }
  }
  return Buffer.from(png.encodePng({ width: w, height: h, channels: 4, data }));
}

test("Remove BG on 851 Labs: a mask on the Background (made a normal layer in the same History state); a new cutout layer when the layer already has a mask", async (t) => {
  const BG = "model_851-labs-background-remover";
  const DOCS = [
    { id: 7, title: "poster.psd", width: 512, height: 512 },
    {
      id: 8,
      title: "masked.psd",
      width: 512,
      height: 512,
      layers: [
        { name: "Subject", content: "solid", fill: [30, 160, 90], frame: { left: 64, top: 64, width: 384, height: 384 }, mask: { left: 64, top: 64, width: 384, height: 384, data: new Uint8Array(384 * 384).fill(255) } },
        { name: "Background", background: true }
      ]
    }
  ];
  let size = 512;
  const sim = await bootGenerate(t, { docs: DOCS, active: 7, psOpts: { scene: true }, mockOpts: { answer: (model) => (model === BG ? costAnswer(1) : undefined), cdn: cdnFor([() => discPng(size, size, size * 0.3)]) } });
  const { app, mock, ps } = sim;
  const p = await app.flow.price({ tool: "remove_background" });
  assert.equal(p.state, "ready", p.reason);
  assert.equal(p.view.controls.lands, "mask");
  assert.ok(p.view.notes.some((n) => /Background layer becomes a normal layer/.test(n)));
  const r1 = await doneRec(app, (await app.flow.generate({ tool: "remove_background" }, p.quote)).record.local_id);
  const d = ps.doc(7);
  assert.equal(d.layers.length, 1, "the result was read and removed; nothing else added");
  assert.equal(d.layers[0].name, "Layer 0");
  assert.equal(d.layers[0].isBackgroundLayer, false);
  assert.ok(d.layers[0].mask.data);
  assert.equal(d.layers[0].xmp, null, "no metadata on the person's own layer");
  assert.deepEqual(ps.history, [{ document_id: 7, name: "Scenario: Place cutout" }]);
  const corner = ps.composite(7, { left: 0, top: 0, width: 8, height: 8 }, 1, 1).data;
  assert.deepEqual([...corner], [255, 255, 255], "outside the cutout: hidden");
  assert.equal(r1.placement.masked, true);

  ps.setActive(8);
  size = 384;
  const p2 = await app.flow.price({ tool: "remove_background", options: { lands: "mask" } });
  assert.equal(p2.view.controls.lands, "new_layer", "a layer with a mask keeps it; only a new cutout layer");
  assert.deepEqual(p2.view.controls.lands_choices, ["new_layer"]);
  const r2 = await doneRec(app, (await app.flow.generate({ tool: "remove_background", options: { lands: "mask" } }, p2.quote)).record.local_id);
  const d8 = ps.doc(8);
  assert.equal(d8.layers.length, 3);
  assert.match(d8.layers[0].name, /^Scenario cutout /);
  assert.ok(d8.layers[0].mask.data && d8.layers[0].xmp);
  assert.equal(d8.layers[1].name, "Subject");
  assert.ok(d8.layers[1].mask.data.every((v) => v === 255), "the person's own mask is left as it is");
  assert.deepEqual(d8.layers[0].frame, { left: 64, top: 64, width: 384, height: 384 }, "a copy of the source pixels over the source");
  assert.ok(r2.inputs.capture.source_path);
  cleanMock(mock);
});

test("InputReduced: an Upscale source over the upload limit stops before anything is sent; priced again at the size that fits, it runs", async (t) => {
  const TOPAZ = "model_topaz-image-upscale";
  const N = 1300;
  const noise = new Uint8Array(N * N * 3);
  let s = 7;
  for (let i = 0; i < noise.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    noise[i] = s >>> 24;
  }
  const DOC = { id: 7, title: "noise.psd", width: N, height: N, layers: [{ name: "Background", background: true, content: "raster", raster: { width: N, height: N, data: noise } }] };
  const { app, mock } = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true }, mockOpts: { answer: (model) => (model === TOPAZ ? costAnswer(10) : undefined) } });
  const p = await app.flow.price({ tool: "upscale" });
  assert.equal(p.state, "ready", p.reason);
  let reduced = null;
  await assert.rejects(app.flow.generate({ tool: "upscale" }, p.quote), (e) => {
    reduced = e.reduced_long;
    return e.type === "InputReduced";
  });
  assert.ok(reduced < N && reduced >= 1000, String(reduced));
  assert.equal(mock.paidCalls.length, 0);
  assert.equal(app.ledger.all().length, 0, "no job: nothing was spent or recorded");
  assert.equal(mock.uploads.filter((u) => u.name.startsWith("photoshop-capture-")).length, 0, "nothing uploaded");
  const again = await app.flow.price({ tool: "upscale", options: { read_long: reduced } });
  assert.deepEqual(again.view.sizes.read, { width: reduced, height: reduced });
  assert.notEqual(again.quote.quote_id, p.quote.quote_id);
  const out = await app.flow.generate({ tool: "upscale", options: { read_long: reduced } }, again.quote);
  assert.equal(out.state, "queued");
  assert.equal(mock.uploads.find((u) => u.name.startsWith("photoshop-capture-")).width, reduced);
});

test("Edit capture over the upload limit shrinks with its mask and carries Input reduced", async (t) => {
  const DOC = { id: 7, title: "poster.psd", width: 2048, height: 2048, selection: { left: 768, top: 768, width: 512, height: 512 } };
  const { app, mock } = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true, jpegBytesPerPixel: 5 }, mockOpts: { answer: (model, body) => (model === FLARE && body.referenceImages ? costAnswer(3) : undefined) } });
  const p = await app.flow.price({ tool: "edit", prompt: PROMPT });
  const out = await app.flow.generate({ tool: "edit", prompt: PROMPT }, p.quote);
  const rec = await doneRec(app, out.record.local_id);
  const ups = mock.uploads.filter((u) => /^photoshop-(capture|mask)-/.test(u.name));
  assert.deepEqual(ups.map((u) => [u.width, u.height]), [[828, 828], [828, 828]]);
  assert.equal(rec.inputs.capture.reduced, true);
  assert.deepEqual(mock.paidCalls[0].body.width, 1024, "the size sent stays the shaped one");
  const card = results.card(rec);
  assert.ok(card.badges[0].includes("Input reduced (828 x 828)"), JSON.stringify(card.badges));
});

test("Canvas changed before the result lands: masked placement is refused, Place unmasked lands it", async (t) => {
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 1024, selection: { left: 384, top: 384, width: 256, height: 256 } };
  const { app, ps } = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true }, mockOpts: { answer: (model) => (model === FLARE ? costAnswer(3) : undefined) } });
  const p = await app.flow.price({ tool: "edit", prompt: PROMPT });
  const out = await app.flow.generate({ tool: "edit", prompt: PROMPT }, p.quote);
  ps.doc(7).width = 1100;
  const rec = await doneRec(app, out.record.local_id, ["ready"]);
  await assert.rejects(app.runner.place(rec.local_id), (e) => e.type === "CanvasChanged");
  const card = results.card(app.ledger.get(rec.local_id));
  assert.equal(card.actions.place_unmasked, true);
  await app.runner.place(rec.local_id, { unmasked: true });
  const placed = app.ledger.get(rec.local_id);
  assert.equal(placed.state, "applied");
  assert.equal(placed.placement.masked, false);
  assert.ok(placed.placement.notes.includes("Placed unmasked: the canvas changed since this edit started."));
});

test("host reads for captures: sizes taken before dispose, and bounds at a pyramid level read back in document pixels", async (t) => {
  // Both found live on 27.11: after dispose() the image data's width and
  // components are error objects; with targetSize, sourceBounds come in the
  // pyramid level's pixels (halved at level 1).
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 768 };
  const { host, ps } = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true } });
  const full = await host.readPixels({ document_id: 7, layer_id: null, bounds: { left: 160, top: 200, width: 272, height: 272 }, long_side: 272, exact: true });
  assert.equal(full.components, 3);
  assert.equal(full.width, 272);
  assert.equal(full.data.length, 272 * 272 * 3);
  const half = await host.readPixels({ document_id: 7, layer_id: null, bounds: { left: 160, top: 200, width: 272, height: 272 }, long_side: 100, exact: true });
  assert.deepEqual([half.width, half.height, half.components], [100, 100, 3]);
  const direct = ps.composite(7, { left: 160, top: 200, width: 272, height: 272 }, 100, 100);
  let worst = 0;
  for (let i = 0; i < half.data.length; i++) worst = Math.max(worst, Math.abs(half.data[i] - direct.data[i]));
  assert.ok(worst <= 2, `a level-1 read lands where the area is (largest difference ${worst})`);
});
