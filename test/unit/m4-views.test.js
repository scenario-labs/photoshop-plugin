"use strict";
// M4 lane views without Photoshop or the network: what the Edit, Trained >
// Edit, Upscale, Expand and Remove BG views read, send and say, from the
// recorded model schemas (test/fixtures/m2.0), and the job card data.

const test = require("node:test");
const assert = require("node:assert/strict");
const schemaMod = require("../../plugin/src/forms/schema.js");
const editMod = require("../../plugin/src/lanes/edit.js");
const enhance = require("../../plugin/src/lanes/enhance.js");
const results = require("../../plugin/src/lanes/results.js");
const common = require("../../plugin/src/lanes/common.js");
const { records } = require("../helpers/fixture-scenario.js");

const S = (id) => schemaMod.normalize(records[id]);
const FLARE = S("model_openai-gpt-image-2-5-flare");
const TOPAZ = S("model_topaz-image-upscale");
const BG = S("model_851-labs-background-remover");
const PHOTOROOM = S("model_photoroom-expand");
const T = common.TEXT;

function ctx(w, h, extra = {}) {
  const layer = extra.layer === undefined ? { id: 1, name: "Background", visible: true, bounds: { left: 0, top: 0, width: w, height: h }, kind: "pixel", background: true, locked: false, has_mask: false } : extra.layer;
  return { doc: { id: 7, width: w, height: h, title: "poster.psd" }, selection: extra.selection || null, selection_raw: extra.selection_raw || extra.selection || null, layer };
}

test("Edit view: blocked texts before anything is priced", () => {
  assert.equal(editMod.editView(FLARE, { doc: null }, {}).blocked, T.no_document);
  assert.equal(editMod.editView(FLARE, ctx(1024, 1024, { selection_raw: { left: 2000, top: 0, width: 50, height: 50 } }), {}).blocked, T.outside);
  assert.equal(editMod.editView(FLARE, ctx(1024, 1024, { selection: { left: 10, top: 10, width: 12, height: 40 } }), {}).blocked, T.too_small);
  const hidden = ctx(1024, 1024, { layer: { id: 3, name: "Sky", visible: false, bounds: { left: 0, top: 0, width: 1024, height: 1024 }, kind: "pixel" } });
  assert.equal(editMod.editView(FLARE, hidden, { sample: "layer" }).blocked, 'Layer "Sky" is hidden. Show it to use it as the source.');
  assert.equal(editMod.editView(TOPAZ, ctx(1024, 1024), { trained: { model_id: "model_x", kind: "lora" } }).blocked, T.no_edit_route);
  const noImage = { ...FLARE, model_id: "model_fixture", capture_input_name: null };
  assert.equal(editMod.editView(noImage, ctx(1024, 1024), {}).blocked, T.no_capture);
});

test("Edit view: margin, shaping and the generated-size note; the target and capture agree", () => {
  const v = editMod.editView(FLARE, ctx(6000, 4000, { selection: { left: 1000, top: 1000, width: 3000, height: 2000 } }), { prompt: "p", margin: "64" });
  assert.equal(v.blocked, null);
  assert.equal(v.source.text, "Selection 3000 x 2000");
  assert.deepEqual(v.sizes.context, { width: 3128, height: 2128 });
  assert.ok(v.notes.includes("Generated at about 65% of this area's resolution."), JSON.stringify(v.notes));
  assert.equal(v.request.parameters.width % 16, 0);
  assert.deepEqual(v.capture.spec.upload, { width: v.request.parameters.width, height: v.request.parameters.height });
  assert.equal(v.request.takes, 2, "Edit defaults to 2 takes");
  assert.equal(v.capture.spec.polarity, "alpha");
  assert.equal(v.capture.spec.mask_input, "mask");
  assert.equal(v.capture.spec.jpeg_ok, true);
  const layerEdit = editMod.editView(FLARE, ctx(1024, 1024, { layer: { id: 5, name: "Paint", visible: true, bounds: { left: 100, top: 100, width: 300, height: 200 }, kind: "pixel" } }), { sample: "layer" });
  assert.equal(layerEdit.source.text, 'Layer "Paint"');
  assert.deepEqual(layerEdit.notes[0], T.no_selection_layer_note);
  assert.equal(layerEdit.request.target.layer_id, 5);
  assert.equal(layerEdit.request.target.sample, "layer");
});

test("Trained > Edit view: a base with only a mask input edits through the mask route; LoRA and composition parameters", () => {
  // No recorded base uses this route yet: a constructed base that takes an
  // image and a mask, with no strength and no reference input.
  const maskBase = {
    ...FLARE,
    model_id: "model_fixture-mask-base",
    capture_input: "image",
    capture_input_name: "image",
    file_inputs: [{ name: "image", kind: "image", role: "image", multiple: false, max: 1, required: true, required_with: [] }, { name: "mask", kind: "image", role: "mask", multiple: false, max: 1, required: false, required_with: [] }],
    parameters: [...FLARE.parameters, { name: "modelId", model_types: ["fixture-lora"] }]
  };
  const sel = { left: 200, top: 200, width: 200, height: 200 };
  const lora = editMod.trainedView(maskBase, ctx(1024, 1024, { selection: sel }), { model_id: "model_t1", kind: "lora", scale: 0.7 }, { prompt: "p" });
  assert.equal(lora.blocked, null);
  assert.equal(lora.route, "mask");
  assert.equal(lora.experimental, true);
  assert.equal(lora.tool, "trained_edit");
  assert.equal(lora.mask, true);
  assert.equal(lora.capture.spec.mask_input, "mask");
  assert.equal(lora.capture.spec.capture_input, "image");
  assert.deepEqual(lora.request.parameters.loras, ["model_t1"]);
  assert.deepEqual(lora.request.parameters.lorasScale, [0.7]);
  assert.equal(lora.request.trained, true);
  assert.equal(lora.controls.change_amount, null, "no strength on the mask route");
  const comp = editMod.trainedView(maskBase, ctx(1024, 1024, { selection: sel }), { model_id: "model_c1", kind: "composition" }, {});
  assert.equal(comp.request.parameters.modelId, "model_c1");
  assert.equal(comp.request.parameters.loras, undefined);
});

test("Expand view: sizes and the resolution note; routes switch off what they cannot honor", () => {
  const v = enhance.expandView(FLARE, ctx(3000, 2000), { ratio: "4:5" });
  assert.equal(v.sizes.text, "3000 x 2000 to 3000 x 3750");
  assert.ok(!v.notes.some((n) => /New area at about/.test(n)), "the default model generates 3000 x 3750 at full size");
  const big = enhance.expandView(FLARE, ctx(6000, 4000), { ratio: "4:5" });
  assert.ok(big.notes.includes("New area at about 51% of this document's resolution. Upscale it after, if needed."), JSON.stringify(big.notes));
  const sides = enhance.expandView(FLARE, ctx(1000, 1000), { mode: "sides", sides: { left: 100, right: 0, top: 0, bottom: 50 } });
  assert.deepEqual(sides.request.target.expand.offset, [100, 0]);
  assert.equal(sides.request.mask, true);
  assert.equal(enhance.expandView(PHOTOROOM, ctx(1000, 1000), { mode: "sides", sides: { left: 100 } }).blocked, T.center_only);
  assert.equal(enhance.expandView(FLARE, ctx(1000, 1000), { ratio: "1:1" }).blocked, T.nothing_grows);
  assert.equal(enhance.expandView(TOPAZ, ctx(1000, 1000), { ratio: "4:5" }).blocked, T.not_expand);
  const reframe = { ...FLARE, model_id: "model_scenario-gemini-reframe", expand_route: "position", parameters: [{ name: "position", enum: ["top_left", "top", "center"] }, { name: "aspectRatio", enum: ["16:9", "1:1", "auto"] }, { name: "resolution", enum: ["1K", "2K"] }], capture_input_name: "image", file_inputs: [{ name: "image", role: "image" }] };
  assert.equal(enhance.expandView(reframe, ctx(1000, 800), { mode: "sides", sides: { left: 10 } }).blocked, T.ratio_only);
  assert.equal(enhance.expandView(reframe, ctx(1000, 800), { ratio: "1:1", anchor: "bottom-right" }).blocked, T.no_position);
  const r = enhance.expandView(reframe, ctx(1000, 800), { ratio: "4:5", anchor: "top-left" });
  assert.equal(r.request.parameters.aspectRatio, "1:1", "Custom maps to the nearest ratio the model allows");
  assert.equal(r.request.parameters.position, "top_left");
  assert.ok(r.notes.includes("This model's nearest ratio is 1:1."));
});

test("Upscale view: the output from the read and the factor, capped; nothing to gain is blocked", () => {
  const v = enhance.upscaleView(TOPAZ, ctx(3000, 2000), {});
  assert.equal(v.sizes.output_text, "Output 4096 x 2731");
  assert.ok(v.notes.includes("Capped at this model's largest output, 4096 px."));
  assert.equal(enhance.upscaleView(TOPAZ, ctx(4096, 4096), {}).blocked, T.too_big_for_model);
  assert.equal(enhance.upscaleView(TOPAZ, ctx(8000, 6000), { factor: "2x" }).blocked, T.too_big_for_model, "read at 6144, capped at 4096: smaller than the source");
  const big = enhance.upscaleView({ ...TOPAZ, output_max_px: null }, ctx(8000, 6000), { factor: "2x" });
  assert.deepEqual(big.sizes.read, { width: 6144, height: 4608 });
  assert.equal(big.sizes.output_text, "Output 12288 x 9216, 1.5x of this document");
  assert.equal(enhance.upscaleView(TOPAZ, ctx(1000, 1000), { source: "selection" }).blocked, T.no_selection_box);
  const sel = enhance.upscaleView(TOPAZ, ctx(1000, 1000, { selection: { left: 10, top: 10, width: 200, height: 100 } }), { source: "selection" });
  assert.equal(sel.controls.lands, "box");
  assert.deepEqual(sel.controls.lands_choices, ["box", "new_document"]);
});

test("Remove BG view: where the cutout can land for each kind of layer", () => {
  const L = (o) => ({ id: 4, name: "L", visible: true, bounds: { left: 0, top: 0, width: 500, height: 500 }, kind: "pixel", background: false, locked: false, has_mask: false, ...o });
  assert.equal(enhance.cutoutView(BG, ctx(500, 500, { layer: L({}) }), {}).controls.lands, "mask");
  assert.equal(enhance.cutoutView(BG, ctx(500, 500, { layer: L({ kind: "smartObject" }) }), {}).controls.lands, "mask");
  for (const o of [{ has_mask: true }, { locked: true }, { kind: "text" }, { kind: "group" }]) {
    const v = enhance.cutoutView(BG, ctx(500, 500, { layer: L(o) }), { lands: "mask" });
    assert.equal(v.controls.lands, "new_layer", JSON.stringify(o));
    assert.ok(v.notes.includes(T.cutout_new_layer_only));
  }
  assert.equal(enhance.cutoutView(BG, ctx(500, 500, { layer: L({ locked: true, background: true }) }), {}).controls.lands, "mask", "the Background aside");
  assert.equal(enhance.cutoutView(BG, ctx(500, 500, { layer: L({ kind: "curves" }) }), {}).blocked, T.no_pixels);
  const sel = enhance.cutoutView(BG, ctx(500, 500, { layer: L({}), selection: { left: 50, top: 50, width: 100, height: 100 } }), { source: "selection" });
  assert.ok(sel.notes.includes(T.selection_hides));
  assert.deepEqual(sel.request.target.mask_box, [0, 0, 500, 500]);
  const big = enhance.cutoutView(BG, ctx(4000, 4000, { layer: L({ bounds: { left: 0, top: 0, width: 4000, height: 4000 } }) }), {});
  assert.ok(big.notes.includes("Mask at 51% of the layer's resolution."), "851 Labs returns at most 2048 px");
});

test("Job cards: upload words, Trained edit, Input reduced, Undo and Place unmasked only where they apply", () => {
  const base = { local_id: "j1", lane: "edit", state: "uploading_inputs", target: { kind: "selection" }, inputs: { capture: { id: "c", reduced: false, files: [] } }, outputs: [] };
  assert.equal(results.card(base).uploading, "Uploading selection");
  assert.equal(results.card({ ...base, lane: "upscale", target: { kind: "upscale" } }).uploading, "Uploading source");
  assert.equal(results.card({ ...base, lane: "image" }), null, "the Image lane keeps its own texts");
  assert.equal(results.card({ ...base, trained_model_ids: ["model_t"] }).title, "Trained edit");
  const applied = { ...base, state: "applied", outputs: [{}, {}], placement: { badges: [["Seam ok", "Changed outside"], []], notes: [], checks: [], masked: true, undone: false } };
  assert.equal(results.card(applied).actions.undo, true);
  assert.equal(results.card({ ...applied, placement: { ...applied.placement, undone: true } }).actions.undo, false);
  const reduced = { ...applied, inputs: { capture: { id: "c", reduced: true, files: [{ width: 828, height: 828 }] } } };
  assert.deepEqual(results.badges(reduced), [["Seam ok", "Changed outside", "Input reduced (828 x 828)"], ["Input reduced (828 x 828)"]]);
  const changed = { ...base, state: "ready", error: "The canvas changed since this edit started. Use Place unmasked or Open as document." };
  assert.equal(results.card(changed).actions.place_unmasked, true);
  assert.equal(results.card({ ...changed, lane: "expand" }).actions.place_unmasked, false);
  const small = { ...applied, placement: { ...applied.placement, badges: [["Result is 512 px for the 1024 px area"], []] } };
  assert.deepEqual(results.card(small).actions.upscale_take, [0]);
  // Records written before 0.7.1 read "for an": still offered the upscale.
  const older = { ...applied, placement: { ...applied.placement, badges: [[], ["Result is 512 px for an 1024 px area"]] } };
  assert.deepEqual(results.card(older).actions.upscale_take, [1]);
});
