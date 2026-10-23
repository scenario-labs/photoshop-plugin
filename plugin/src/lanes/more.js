"use strict";
// The creation flows that read one source and send it to a tool model
// (FLOWS v2, F7 to F10): Split into layers, Split text and Remove text,
// Select by description, Formats, Animate, and Frame to layer from a clip.
// Same view shape as lanes/enhance.js: { lane, tool, model_id, blocked,
// source, sizes, notes, controls, request, capture { kind: "source", spec } }.
// Each request names what it lands as in target.kind; apply/more-plan.js and
// host-more.js carry the landing out.
//
// tool: "split" | "text" | "segment" | "reframe" | "video" | "frames".
// The image tools run in the Edit lane (their models are img2img), the clip
// tools in the Video lane.

var common = require("./common.js");
var enhanceMod = require("./enhance.js");

var TEXT = common.TEXT;
var ADJUSTMENTS = enhanceMod.ADJUSTMENTS;
// The long side each tool reads at most: the models' own working sizes.
var READ_LONG = { split: 2048, text: 2048, segment: 2048, reframe: 2048, video: 1536 };
// What each tool reads by default: the layer it splits, or what the person
// sees (selections, formats and clips are about the whole picture).
var DEFAULT_SOURCE = { split: "layer", text: "layer", segment: "visible", reframe: "visible", video: "visible" };
var LANE = { split: "edit", text: "edit", segment: "edit", reframe: "edit", video: "video", frames: "video" };
// Formats (F10): the placements offered, as target pixels at the long side
// the format lands at.
var FORMATS = {
  "1:1": { width: 1080, height: 1080, label: "Square 1:1" },
  "4:5": { width: 1080, height: 1350, label: "Feed 4:5" },
  "9:16": { width: 1080, height: 1920, label: "Story 9:16" },
  "16:9": { width: 1920, height: 1080, label: "Wide 16:9" }
};
var DURATIONS = [5, 10];

function base(tool, schema) {
  return { lane: LANE[tool], tool: tool, model_id: schema.model_id, blocked: null, source: null, sizes: null, notes: [], controls: {}, request: null, capture: null };
}

function blocked(v, text) {
  v.blocked = text;
  v.request = null;
  v.capture = null;
  return v;
}

// The source a tool reads: the active layer (its pixels inside the canvas)
// or all visible. Returns { box, kind, text } or a blocking text.
function sourceOf(ctx, which) {
  var doc = ctx.doc;
  var canvas = { width: doc.width, height: doc.height };
  if (which === "layer") {
    var layer = ctx.layer;
    if (!layer) return { error: TEXT.no_layer };
    if (!layer.visible) return { error: common.hiddenText(layer.name) };
    if (ADJUSTMENTS.indexOf(layer.kind) >= 0) return { error: TEXT.no_pixels };
    var box = common.layerBox(layer, canvas);
    if (!box) return { error: TEXT.layer_empty };
    return { box: box, kind: "layer", text: 'Layer "' + layer.name + '"', layer_id: layer.id };
  }
  return { box: { left: 0, top: 0, width: canvas.width, height: canvas.height }, kind: "visible", text: "All visible", layer_id: null };
}

function readOf(box, long) {
  var k = Math.max(box.width, box.height) > long ? long / Math.max(box.width, box.height) : 1;
  return { width: Math.max(1, Math.round(box.width * k)), height: Math.max(1, Math.round(box.height * k)), scale: k };
}

// o: { source: "layer" (default) | "visible", prompt, mode ("remove" |
//      "split", Split text), format ("9:16"), duration (5), resolution,
//      video_asset (frames), frame_count, read_long }
function toolView(tool, schema, ctx, o) {
  o = o || {};
  var v = base(tool, schema);
  if (!LANE[tool]) return blocked(v, "Unknown tool.");
  if (!ctx || !ctx.doc) return blocked(v, TEXT.no_document);
  var doc = ctx.doc;
  var canvas = { width: doc.width, height: doc.height };
  var params = {};
  var prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";

  // Frame to layer: the clip is already on Scenario; nothing is captured.
  if (tool === "frames") {
    if (!o.video_asset) return blocked(v, "Animate a layer first: Frame to layer reads its clip.");
    var vin = videoInput(schema);
    if (!vin) return blocked(v, "This model takes no clip.");
    params[vin] = o.video_asset;
    var every = common.param(schema, "frameInterval");
    if (every) params.frameInterval = Math.max(1, Math.round(o.frame_interval || 24));
    var lid = ctx.layer ? ctx.layer.id : null;
    v.source = { kind: "clip", text: "The clip of " + (o.clip_name || "the last Animate run") };
    v.request = {
      lane: "video",
      model_id: schema.model_id,
      parameters: params,
      takes: null,
      target: { kind: "frames", document_id: doc.id, box: [0, 0, canvas.width, canvas.height], canvas: [canvas.width, canvas.height], layer_id: lid, lands: "layer", clip_asset: o.video_asset },
      source_size: null,
      references: 0,
      mask: false
    };
    v.capture = null;
    return v;
  }

  var which = o.source === "layer" || o.source === "visible" ? o.source : DEFAULT_SOURCE[tool];
  var src = sourceOf(ctx, which);
  if (src.error) return blocked(v, src.error);
  var box = src.box;
  v.source = { kind: src.kind, text: src.text };
  var capInput = schema.capture_input_name;
  if (!capInput) return blocked(v, TEXT.no_capture);
  var read = readOf(box, Math.min(o.read_long || Infinity, READ_LONG[tool] || 2048));
  if (read.scale < 1) v.notes.push("Read at " + read.width + " x " + read.height + ".");
  var target = { kind: tool, document_id: doc.id, box: common.boxArray(box), canvas: [canvas.width, canvas.height], source: src.kind, layer_id: src.layer_id, read: [read.width, read.height] };

  if (tool === "split") {
    // Seedream Layerize: "what to separate" goes in its prompt; empty asks
    // for the main elements.
    if (prompt && schema.prompt_input) params[schema.prompt_input] = prompt;
    var sz = common.param(schema, "size");
    if (sz && sz.enum && sz.enum.indexOf("auto") >= 0) params.size = "auto";
    target.lands = "group";
    v.notes.push("Lands as a group above the layer: a rebuilt background plus one layer per element. The layer stays, hidden.");
  } else if (tool === "text") {
    var mode = o.mode === "split" ? "split" : "remove";
    target.mode = mode;
    target.lands = mode === "split" ? "group" : "layer";
    v.controls.mode = mode;
  } else if (tool === "segment") {
    if (!prompt) return blocked(v, "Type what to select.");
    var tp = common.param(schema, "imagePromptingText");
    if (!tp) return blocked(v, "This model takes no description.");
    params.imagePromptingText = prompt.slice(0, tp.max_length || 120);
    if (common.param(schema, "applyMask")) params.applyMask = false;
    target.lands = "selection";
    target.text = params.imagePromptingText;
  } else if (tool === "reframe") {
    var key = FORMATS[o.format] ? o.format : "9:16";
    var f = FORMATS[key];
    var wp = common.param(schema, "width");
    var hp = common.param(schema, "height");
    if (!wp || !hp) return blocked(v, "This model takes no target size.");
    params.width = f.width;
    params.height = f.height;
    if (prompt && schema.prompt_input) params[schema.prompt_input] = prompt;
    var td = common.param(schema, "textDensity");
    if (td && td.enum && td.enum.indexOf("SPARSE") >= 0) params.textDensity = "SPARSE";
    // thinkingLevel stays at the model's default: MINIMAL is listed but
    // the job fails with it (live 2026-10-20, 0 CU charged).
    target.format = key;
    target.output = [f.width, f.height];
    target.lands = "artboard";
    v.controls.format = key;
    v.sizes = { output: { width: f.width, height: f.height } };
  } else if (tool === "video") {
    if (!prompt) return blocked(v, "Describe the motion.");
    params.prompt = prompt;
    var dp = common.param(schema, "duration");
    var dur = DURATIONS.indexOf(Number(o.duration)) >= 0 ? Number(o.duration) : 5;
    if (dp) {
      if (typeof dp.min === "number" && dur < dp.min) dur = dp.min;
      if (typeof dp.max === "number" && dur > dp.max) dur = dp.max;
      params.duration = dur;
    }
    var rp = common.param(schema, "resolution");
    if (rp && rp.enum) params.resolution = rp.enum.indexOf(o.resolution) >= 0 ? o.resolution : rp.enum.indexOf("480P") >= 0 ? "480P" : rp.enum[0];
    target.lands = "new_document";
    target.duration = dur;
    v.controls.duration = dur;
  }
  if (!v.sizes) v.sizes = { source: { width: box.width, height: box.height }, read: { width: read.width, height: read.height } };
  v.request = { lane: LANE[tool], model_id: schema.model_id, parameters: params, takes: null, target: target, source_size: { width: read.width, height: read.height }, references: 0, mask: false };
  v.capture = { kind: "source", spec: { document_id: doc.id, document_title: doc.title, layer_id: src.layer_id, box: box, read_long: Math.max(read.width, read.height), capture_input: capInput, jpeg_ok: tool === "video" || common.jpegOk(schema.model_id) } };
  if (tool === "reframe" && src.kind === "visible") v.capture.spec.without_titles = true;
  return v;
}

// The clip input of a frames model (a file input of kind video).
function videoInput(schema) {
  for (var i = 0; i < schema.file_inputs.length; i++) if (schema.file_inputs[i].kind === "video") return schema.file_inputs[i].name;
  return null;
}

module.exports = { toolView: toolView, FORMATS: FORMATS, DURATIONS: DURATIONS, LANE: LANE, READ_LONG: READ_LONG, videoInput: videoInput };
