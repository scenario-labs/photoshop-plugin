"use strict";
// Panel v2 P2 (FLOWS v2, F6 to F10, F13): the later flows' logic without
// Photoshop. The views of the tools (lanes/more.js) and what they send, the
// element finder of Split into layers (apply/match.js), the placement plans
// (apply/more-plan.js), the clip sniffing of the downloader, the new
// contexts and the actions table.

const test = require("node:test");
const MAP = require("../../shared/catalog-map.json");
const assert = require("node:assert/strict");
const schemaMod = require("../../plugin/src/forms/schema.js");
const requests = require("../../plugin/src/forms/requests.js");
const moreLanes = require("../../plugin/src/lanes/more.js");
const editMod = require("../../plugin/src/lanes/edit.js");
const match = require("../../plugin/src/apply/match.js");
const morePlan = require("../../plugin/src/apply/more-plan.js");
const download = require("../../plugin/src/scenario/download.js");
const controller = require("../../plugin/src/panel/controller.js");
const actions = require("../../plugin/src/panel/actions.js");
const xmp = require("../../plugin/src/util/xmp.js");

const file = (name, extra = {}) => ({ name, type: "file", kind: "image", ...extra });
const SCHEMAS = {
  split: { id: "model_bytedance-seedream-5-0-flash-layerize", name: "Seedream 5.0 Flash Layerize", inputs: [file("image", { required: true }), { name: "prompt", type: "string" }, { name: "size", type: "string", allowedValues: ["auto", "1K", "1.5K", "2K"] }] },
  text: { id: "model_ideogram-v3-layerize-text", name: "Ideogram V3 Layerize Text", inputs: [file("image", { required: true }), { name: "prompt", type: "string" }] },
  segment: { id: "model_meta-sam-3-1-image", name: "SAM 3.1 Image", inputs: [file("image", { required: true }), { name: "imagePromptingText", type: "string", maxLength: 120 }, { name: "applyMask", type: "boolean" }] },
  reframe: { id: "model_scenario-smart-reframe", name: "Smart Reframe", inputs: [file("image", { required: true }), { name: "width", type: "number" }, { name: "height", type: "number" }, { name: "prompt", type: "string" }, { name: "textDensity", type: "string", allowedValues: ["SPARSE", "DENSE"] }, { name: "thinkingLevel", type: "string", allowedValues: ["HIGH", "MINIMAL"] }] },
  video: { id: "model_minimax-h3-fast", name: "Minimax H3 Fast", inputs: [{ name: "prompt", type: "string", required: true }, file("firstFrameImage"), file("lastFrameImage"), { name: "duration", type: "number", min: 4, max: 15 }, { name: "resolution", type: "string", allowedValues: ["480P", "768P"] }] },
  frames: { id: "model_scenario-video-to-image-seq", name: "Video to Image Sequence", inputs: [{ name: "video", type: "file", kind: "video", required: true }, { name: "extractAllFrames", type: "boolean" }, { name: "frameInterval", type: "number" }] },
  angle: { id: "model_qwen-edit-multiangle-2511", name: "Qwen Edit Multiangle", inputs: [{ name: "images", type: "file_array", kind: "image", maxLength: 1, costImpact: true }, { name: "horizontalAngle", type: "number", min: 0, max: 360 }, { name: "verticalAngle", type: "number", min: -30, max: 90 }, { name: "zoom", type: "number", min: 0, max: 10 }, { name: "numOutputs", type: "number", min: 1, max: 4 }] }
};
const schemaOf = (k) => schemaMod.normalize(SCHEMAS[k]);
const CTX = { doc: { id: 7, width: 2304, height: 1536, title: "harbor.psd" }, selection: null, selection_raw: null, layer: { id: 3, name: "Harbor", visible: true, kind: "pixel", bounds: { left: 0, top: 0, width: 2304, height: 1536 } } };

test("Split into layers reads the layer, asks for the main elements by default and lands as a group; the request builds in the Edit lane", () => {
  const v = moreLanes.toolView("split", schemaOf("split"), CTX, {});
  assert.equal(v.blocked, null);
  assert.equal(v.lane, "edit");
  assert.deepEqual(v.request.parameters, { size: "auto" }, "no prompt: the model's main elements");
  assert.equal(v.request.target.kind, "split");
  assert.equal(v.request.target.lands, "group");
  assert.equal(v.request.target.layer_id, 3);
  assert.deepEqual(v.request.target.read, [2048, 1365]);
  assert.equal(v.capture.kind, "source");
  assert.equal(v.capture.spec.capture_input, "image");
  const req = requests.build(schemaOf("split"), v.request);
  assert.deepEqual(req.pending, { image: 1 });
  const named = moreLanes.toolView("split", schemaOf("split"), CTX, { prompt: "each boat" });
  assert.equal(named.request.parameters.prompt, "each boat");
});

test("Remove text and Split text: one model, the mode in the target; Split text lands as a group", () => {
  const r = moreLanes.toolView("text", schemaOf("text"), CTX, { mode: "remove" });
  assert.equal(r.request.target.mode, "remove");
  assert.equal(r.request.target.lands, "layer");
  const s = moreLanes.toolView("text", schemaOf("text"), CTX, { mode: "split" });
  assert.equal(s.request.target.lands, "group");
});

test("Select by description sends the words, cut to the model's limit, and lands as a selection; no words, no request", () => {
  const blocked = moreLanes.toolView("segment", schemaOf("segment"), CTX, { prompt: "" });
  assert.equal(blocked.blocked, "Type what to select.");
  const long = "all the boats ".repeat(20);
  const v = moreLanes.toolView("segment", schemaOf("segment"), CTX, { prompt: long });
  assert.equal(v.request.parameters.imagePromptingText.length, 120);
  assert.equal(v.request.parameters.applyMask, false, "one mask per object, not a cut-out");
  assert.equal(v.request.target.lands, "selection");
  assert.equal(v.request.target.source, "visible", "what the person sees");
});

test("Formats: the placement's pixels, sparse text and the default thinking level, lands as an artboard", () => {
  const v = moreLanes.toolView("reframe", schemaOf("reframe"), CTX, { format: "4:5" });
  assert.equal(v.request.parameters.width, 1080);
  assert.equal(v.request.parameters.height, 1350);
  assert.equal(v.request.parameters.textDensity, "SPARSE");
  assert.equal(v.request.parameters.thinkingLevel, undefined);
  assert.equal(v.request.target.lands, "artboard");
  assert.equal(moreLanes.toolView("reframe", schemaOf("reframe"), CTX, {}).request.target.format, "9:16", "9:16 by default");
});

test("Animate: a motion prompt, 5 s at 480P within the model's range, the picture as the first frame, in the panel's Video lane", () => {
  assert.equal(moreLanes.toolView("video", schemaOf("video"), CTX, {}).blocked, "Describe the motion.");
  const v = moreLanes.toolView("video", schemaOf("video"), CTX, { prompt: "water ripples", duration: 10 });
  assert.equal(v.lane, "video");
  assert.equal(v.request.parameters.duration, 10);
  assert.equal(v.request.parameters.resolution, "480P");
  assert.equal(v.capture.spec.capture_input, "firstFrameImage");
  const req = requests.build(schemaOf("video"), v.request);
  assert.deepEqual(req.pending, { firstFrameImage: 1 });
  assert.throws(() => requests.checkLane("video"), /later release|lane must be one of/, "agents still see the v1 lanes only");
});

test("Frame to layer reads the clip already on Scenario: nothing is captured or uploaded", () => {
  assert.match(moreLanes.toolView("frames", schemaOf("frames"), CTX, {}).blocked, /Animate a layer first/);
  const v = moreLanes.toolView("frames", schemaOf("frames"), CTX, { video_asset: "asset_clip1" });
  assert.equal(v.capture, null);
  assert.equal(v.request.parameters.video, "asset_clip1");
  assert.equal(v.request.parameters.frameInterval, 24);
  assert.deepEqual(requests.build(schemaOf("frames"), v.request).pending, {});
});

test("New angle sends the preset's turn, tilt and zoom to the model's own inputs, the layer as its image; no prompt", () => {
  const v = editMod.editView(schemaOf("angle"), CTX, { sample: "layer", takes: 2, extra: { horizontalAngle: 45, verticalAngle: 0, zoom: 5, notAnInput: 1 } });
  assert.equal(v.blocked, null);
  assert.equal(v.request.parameters.horizontalAngle, 45);
  assert.equal(v.request.parameters.zoom, 5);
  assert.equal(v.request.parameters.notAnInput, undefined, "names the schema lacks are left out");
  assert.equal(v.request.parameters.prompt, undefined);
  assert.equal(v.capture.spec.capture_input, "images");
  assert.equal(v.capture.spec.matte, undefined, "an opaque layer goes as it is");
  // Priced before the upload with a blank stand-in at the capture's size:
  // a 256 px stand-in quoted 1 CU where the real capture cost 5 to 14 CU
  // (live 2026-10-21).
  assert.deepEqual(MAP.models["model_qwen-edit-multiangle-2511"].price_inputs.images, { rule: "size" });
  assert.ok(v.request.source_size && v.request.source_size.width > 256 && v.request.source_size.height > 256, JSON.stringify(v.request.source_size));
  assert.deepEqual(requests.build(schemaOf("angle"), v.request).pending, { images: 1 });
});

test("New angle on a cut-out or a split element: the transparent parts go to the model as gray, with a note", () => {
  const v = editMod.editView(schemaOf("angle"), CTX, { sample: "layer", takes: 2, matte: true, extra: { horizontalAngle: 45 } });
  assert.equal(v.capture.spec.matte, 128);
  assert.ok(v.notes.some((n) => /as gray/.test(n)));
  const pixels = require("../../plugin/src/capture/pixels.js");
  const img = { width: 2, height: 1, components: 4, data: new Uint8Array([10, 20, 30, 255, 200, 200, 200, 0]) };
  assert.deepEqual(Array.from(pixels.toRgb(img, 128).data), [10, 20, 30, 128, 128, 128]);
  assert.deepEqual(Array.from(pixels.toRgb(img).data), [10, 20, 30, 255, 255, 255], "white without a matte, as before");
});

// A textured background, the element pasted at a known place; the rebuilt
// background is the texture alone; the element comes back redrawn larger.
function scene() {
  const W = 384;
  const H = 256;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const bg = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const n = Math.floor(rnd() * 30);
    bg[i] = 40 + n + Math.floor(y / 4);
    bg[i + 1] = 60 + n;
    bg[i + 2] = 90 + Math.floor(x / 6);
  }
  const at = { x: 220, y: 120, w: 60, h: 40 };
  const orig = Uint8Array.from(bg);
  const color = (u, v) => [200 - u * 80, 60 + v * 120, 30 + (u * v) * 150];
  for (let y = 0; y < at.h; y++) for (let x = 0; x < at.w; x++) {
    const u = x / at.w;
    const v = y / at.h;
    const inside = (u - 0.5) ** 2 / 0.25 + (v - 0.5) ** 2 / 0.25 <= 1;
    if (!inside) continue;
    const i = ((at.y + y) * W + at.x + x) * 3;
    const c = color(u, v);
    orig[i] = c[0];
    orig[i + 1] = c[1];
    orig[i + 2] = c[2];
  }
  // The element at 2x with a transparent margin of 10 px.
  const ew = at.w * 2 + 20;
  const eh = at.h * 2 + 20;
  const el = new Uint8Array(ew * eh * 4);
  for (let y = 0; y < at.h * 2; y++) for (let x = 0; x < at.w * 2; x++) {
    const u = x / (at.w * 2);
    const v = y / (at.h * 2);
    if ((u - 0.5) ** 2 / 0.25 + (v - 0.5) ** 2 / 0.25 > 1) continue;
    const i = ((y + 10) * ew + x + 10) * 4;
    const c = color(u, v);
    el[i] = c[0];
    el[i + 1] = c[1];
    el[i + 2] = c[2];
    el[i + 3] = 255;
  }
  return { at, original: { width: W, height: H, components: 3, data: orig }, rebuilt: { width: W, height: H, components: 3, data: bg }, element: { width: ew, height: eh, components: 4, data: el } };
}

test("Split into layers finds each element where it was: the element frame lands within 2 px, with its transparent margin", () => {
  const s = scene();
  const m = match.findElement(s.original, s.element, s.rebuilt);
  assert.ok(m, "a match");
  assert.equal(m.doubtful, false);
  // Document pixels at 4x the read.
  const p = match.placeOf(m, { left: 0, top: 0, width: 1536, height: 1024 }, 384, 256);
  const k = 4;
  // The element image is 2x the element plus 10 px each side: 5 px of the
  // read around it, so its frame starts 5 read px before the element.
  assert.ok(Math.abs(p.left - (s.at.x - 5) * k) <= 2 * k, `left ${p.left}`);
  assert.ok(Math.abs(p.top - (s.at.y - 5) * k) <= 2 * k, `top ${p.top}`);
  assert.ok(Math.abs(p.width - (s.at.w + 10) * k) <= 3 * k, `width ${p.width}`);
});

test("a backdrop element (fully opaque, as a sky) spans the picture: it is not matched to a small patch of itself", () => {
  // Live 2026-10-23: Seedream Layerize returned the sky as a 1200 x 670
  // opaque band, redrawn without the keeper and the kite in front of it; it
  // was placed at 84 x 47 px on a patch of plain blue.
  const W = 256;
  const H = 384;
  const SKY = 150;
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const skyAt = (x, y) => [70 + Math.floor(y / 3), 120 + Math.floor(y / 4), 230 - Math.floor(y / 6)];
  const orig = new Uint8Array(W * H * 3);
  const back = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const c = y < SKY ? skyAt(x, y) : [120 + Math.floor(rnd() * 90), 90 + Math.floor(rnd() * 60), 50 + Math.floor(rnd() * 40)];
    back.set(c, i);
    // A figure and a kite in front of the sky.
    const front = (x >= 150 && x < 200 && y >= 60) || (x >= 40 && x < 90 && y >= 20 && y < 60);
    orig.set(y < SKY && front ? [90, 50, 30] : c, i);
  }
  // The sky alone, redrawn at 1.17x, every pixel opaque.
  const ew = Math.round(W * 1.17);
  const eh = Math.round(SKY * 1.17);
  const el = new Uint8Array(ew * eh * 4);
  for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) {
    const i = (y * ew + x) * 4;
    el.set([...skyAt(x / 1.17, y / 1.17), 255], i);
  }
  const m = match.findElement({ width: W, height: H, components: 3, data: orig }, { width: ew, height: eh, components: 4, data: el }, { width: W, height: H, components: 3, data: back });
  assert.ok(m, "a match");
  assert.ok(m.box.width >= W * 0.9, `spans the picture (width ${m.box.width})`);
  assert.ok(m.box.top <= 8, `at the top (top ${m.box.top})`);
});

test("an element with nothing opaque is not placed", () => {
  const blank = { width: 10, height: 10, components: 4, data: new Uint8Array(400) };
  assert.equal(match.findElement(scene().original, blank, null), null);
});

const REC = {
  local_id: "j1",
  job_id: "job_x",
  model_id: "model_bytedance-seedream-5-0-flash-layerize",
  model_name: "Seedream 5.0 Flash Layerize",
  lane: "edit",
  parameters: { size: "auto", prompt: "each boat" },
  cu_quoted: "28",
  cu_charged: "28",
  submitted_at: "2026-10-20T10:00:00Z",
  target: { kind: "split", document_id: 7, box: [0, 0, 2304, 1536], canvas: [2304, 1536], source: "layer", layer_id: 3 },
  outputs: [
    { asset_id: "asset_base", path: "out/b.png", width: 2496, height: 1664 },
    { asset_id: "asset_boat", path: "out/e1.png", width: 900, height: 400 },
    { asset_id: "asset_lamp", path: "out/e2.png", width: 300, height: 900 }
  ]
};

test("the split plan: a group named after the layer, the background at the source box, each element its own named layer; the kinds keep them out of the Takes card", () => {
  const p = morePlan.split(REC, { version: "0.6.2-dev", source_name: "Harbor" });
  assert.equal(p.history_name, "Scenario: Split into layers");
  assert.equal(p.group.name, "Harbor layers each-boat");
  assert.equal(p.base.name, "Background");
  assert.deepEqual(p.elements.map((e) => e.name), ["Element 1", "Element 2"]);
  assert.equal(p.hide_source, true);
  assert.equal(xmp.parse(p.base.xmp).kind, "split-base");
  assert.equal(xmp.parse(p.elements[0].xmp).kind, "split-element");
  assert.equal(xmp.parse(p.elements[0].xmp).assetId, "asset_boat");
  assert.equal(xmp.parse(p.group.xmp).kind, "split");
  assert.equal(controller.takesOf({ id: 1, group: true, name: "g", fields: xmp.parse(p.group.xmp), children: [{ id: 2, fields: xmp.parse(p.elements[0].xmp) }] }), null, "not a takes group");
});

test("Split text: the text is where the source differs from the clean base in solid strokes, grown by two pixels; specks are dropped; masks union into one selection", () => {
  const w = 40;
  const h = 20;
  const src = { width: w, height: h, components: 3, data: new Uint8Array(w * h * 3).fill(100) };
  const base = { width: w, height: h, components: 3, data: new Uint8Array(w * h * 3).fill(100) };
  const on = (x, y) => {
    for (let c = 0; c < 3; c++) src.data[(y * w + x) * 3 + c] = 250;
  };
  // A letter stroke 4 x 8 at (10, 6); a lone speck at (30, 10), as the
  // redrawn base leaves on fine detail.
  for (let y = 6; y < 14; y++) for (let x = 10; x < 14; x++) on(x, y);
  on(30, 10);
  const m = morePlan.textMask(src, base, 32, 2);
  assert.equal(m.data[8 * w + 10], 255);
  assert.equal(m.data[8 * w + 15], 255, "grown");
  assert.equal(m.data[8 * w + 17], 0);
  assert.equal(m.data[10 * w + 30], 0, "the speck is dropped");
  const a = { width: 4, height: 1, components: 1, data: Uint8Array.from([255, 0, 0, 0]) };
  const b = { width: 4, height: 1, components: 1, data: Uint8Array.from([0, 0, 0, 255]) };
  const none = { width: 4, height: 1, components: 1, data: new Uint8Array(4) };
  const u = morePlan.unionMasks([a, b, none]);
  assert.deepEqual(Array.from(u.data), [255, 0, 0, 255]);
  assert.equal(u.objects, 2, "an empty mask is no object");
});

test("the formats, clip and frame plans", () => {
  const f = morePlan.reframe({ ...REC, target: { kind: "reframe", format: "9:16", output: [1080, 1920], document_id: 7 }, outputs: [{ asset_id: "a1", path: "out/f.png", width: 1080, height: 1920 }] }, { title: "harbor.psd" });
  assert.equal(f.document_name, "harbor formats");
  assert.equal(f.artboard_name, "9:16 1080 × 1920");
  assert.equal(xmp.parse(f.layer.xmp).kind, "format");
  const v = morePlan.video({ ...REC, lane: "video", target: { kind: "video" }, outputs: [{ asset_id: "c1", path: "out/c.mp4" }] });
  assert.equal(v.path, "out/c.mp4");
  const fr = morePlan.frames({ ...REC, lane: "video", target: { kind: "frames", layer_id: 3, document_id: 7, box: [0, 0, 2304, 1536] }, outputs: [{ asset_id: "f1", path: "a.png" }, { asset_id: "f2", path: "b.png" }] });
  assert.equal(fr.layer.path, "b.png", "the last frame");
  assert.equal(fr.layer.name, "Frame 2 of the clip");
});

test("clips are sniffed as MP4 with their track size", () => {
  const box = (type, body) => {
    const b = Buffer.alloc(8 + body.length);
    b.writeUInt32BE(8 + body.length, 0);
    b.write(type, 4, "latin1");
    body.copy(b, 8);
    return b;
  };
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(848 * 65536, 76);
  tkhd.writeUInt32BE(480 * 65536, 80);
  const bytes = new Uint8Array(Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov", box("trak", box("tkhd", tkhd)))]));
  const s = download.sniff(bytes);
  assert.equal(s.ext, "mp4");
  assert.equal(s.width, 848);
  assert.equal(s.height, 480);
});

test("contexts: a split element has its own actions; a lone Background is a flat image", () => {
  const doc = { id: 7, width: 100, height: 100, layers: 1 };
  const bg = { id: 1, name: "Background", visible: true, kind: "pixel", background: true, bounds: { left: 0, top: 0, width: 100, height: 100 } };
  assert.equal(controller.classify({ doc, layer: bg }, null).kind, "flat");
  assert.equal(controller.classify({ doc: { ...doc, layers: 2 }, layer: bg }, null).kind, "layer");
  const elLayer = { id: 5, name: "Element 1", visible: true, kind: "smartObject", background: false, bounds: { left: 10, top: 10, width: 20, height: 20 } };
  assert.equal(controller.classify({ doc: { ...doc, layers: 3 }, layer: elLayer }, { id: 5, fields: { kind: "split-element", assetId: "a", jobId: "j" } }).kind, "element");
  assert.deepEqual(actions.chipsFor("element"), ["versions", "relight", "angle", "upscale"]);
  assert.deepEqual(actions.chipsFor("flat"), ["split", "versions", "upscale", "formats"]);
});

test("the actions table: every More entry and chip is an action that runs; tools name a lane and a model", () => {
  for (const kind of Object.keys(actions.CONTEXTS)) {
    for (const id of actions.CONTEXTS[kind]) assert.ok(actions.ACTIONS[id], `${kind}: ${id}`);
    for (const g of actions.MORE[kind] || []) for (const id of g[1]) assert.ok(actions.ACTIONS[id] && (actions.ACTIONS[id].family || actions.ACTIONS[id].grid), `${kind} More: ${id} runs`);
  }
  for (const id of Object.keys(actions.ACTIONS)) {
    const a = actions.ACTIONS[id];
    if (a.family !== "tool") continue;
    assert.ok(moreLanes.LANE[a.tool], `${id}: a tool of lanes/more.js`);
    assert.match(a.model, /^model_/, `${id}: its own model`);
  }
  assert.equal(actions.ACTIONS.sketch.quality, "high", "Render sketch starts at High");
  assert.equal(actions.promptFor("select_desc", "ignored"), null, "the Select… field, not the prompt");
});

const libraryMod = require("../../plugin/src/panel/library.js");
const { bootGenerate } = require("../helpers/generate-sim.js");
const { waitFor } = require("../helpers/fakes.js");

test("the Library grid: images only, never the plugin's own uploads or hidden assets, thumbnails from the CDN only, cached", async () => {
  const CDN = "https://cdn.cloud.scenario.com/x/";
  assert.equal(libraryMod.rowOf({ id: "a1", kind: "video" }), null);
  assert.equal(libraryMod.rowOf({ id: "a2", kind: "image", name: "photoshop-capture-7" }), null);
  assert.equal(libraryMod.rowOf({ id: "a3", kind: "image", metadata: { hide: true } }), null);
  const r = libraryMod.rowOf({ id: "a4", kind: "image", name: "harbor", url: "https://elsewhere.example/a.png", thumbnail: { url: CDN + "t.png" }, metadata: { width: 1024, height: 768 } });
  assert.deepEqual([r.asset_id, r.name, r.thumb, r.width], ["a4", "harbor", CDN + "t.png", 1024]);
  assert.equal(libraryMod.rowOf({ id: "a5", kind: "image", url: "https://elsewhere.example/a.png" }).thumb, null, "no thumbnail from another host");
  let calls = 0;
  const lib = libraryMod.createLibrary({
    client: {
      request: async (method, path, o) => {
        calls++;
        assert.equal(method, "GET");
        assert.equal(path, "/assets");
        assert.equal(o.query.pageSize, "30");
        return { body: { assets: Array.from({ length: 20 }, (_, i) => ({ id: "x" + i, kind: "image", url: CDN + i + ".png" })) } };
      }
    },
    downloader: { download: async (id, folder) => ({ path: folder + "/f.png" }) }
  });
  // M7: one list per asset type of the filter, the grid shows SHOWN tiles.
  assert.equal((await lib.list(false, "generated")).rows.length, 20);
  await lib.list(false, "generated");
  assert.equal(calls, 1, "a second open within a minute reuses the list");
  await lib.list(true, "generated");
  assert.equal(calls, 2);
  assert.equal((await lib.fetch("x1")).path, "Scenario/library/x1/f.png");
});

test("F14: the plan card stays hidden without a plan; with one it lists each step and its price, one total, and the decisions reach the agent", async (t) => {
  const { app, doc, ps } = await bootGenerate(t, { docs: [] });
  ps.entrypoints.panels.scenarioPanel.show();
  await waitFor(() => app.controller.state().active, { label: "panel shown" });
  assert.equal(doc.byId("plan-card").style.display, "none", "no plan request, no card");
  const said = [];
  app.controller.showAgentPlan({
    client_name: "Claude",
    steps: [{ label: "Render sketch", cu: 25 }, { label: "Formats 9:16", cu: 45, state: "approved" }],
    total_cu: 70,
    approve_all: () => said.push("all"),
    step_by_step: () => said.push("steps"),
    decline: () => said.push("decline")
  });
  await waitFor(() => doc.byId("plan-card").style.display !== "none", { label: "plan card shown" });
  assert.equal(doc.text("plan-who"), "Claude plans 2 steps");
  const rows = doc.byId("plan-steps").children.map((r) => r.textContent);
  assert.deepEqual(rows, ["1. Render sketch25 CU", "2. Formats 9:1645 CU · Approved"]);
  assert.equal(doc.text("plan-all-label"), "Approve all · 70 CU");
  doc.byId("plan-all").click();
  doc.byId("plan-steps-btn").click();
  doc.byId("plan-decline").click();
  await waitFor(() => said.length === 3, { label: "three decisions" });
  assert.deepEqual(said, ["all", "steps", "decline"]);
  await waitFor(() => doc.byId("plan-card").style.display === "none", { label: "declined plan hides" });
});
