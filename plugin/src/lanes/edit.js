"use strict";
// The Edit lane and Trained > Edit as view-models (SPEC 3.4, 3.8, 5.8): what
// the lane will read, how the box is shaped for the model, what it sends and
// what the price check prices. The panel draws a view; the flow
// (lanes/flow.js) prices and runs it. Nothing here reads Photoshop: the
// context comes from lanes/context.js.
//
// editView(schema, ctx, o) -> view. o: {
//   prompt, takes,
//   margin: "auto" (default) | "64" | "none",
//   sample: "visible" (default) | "layer",
//   quality: "low" | "medium" | "high" (models with a quality input),
//   expect: "cleared" (Remove: the checks look for parts left unchanged),
//   feather: px of the placed mask's edge (default 2),
//   trained: null | { model_id, kind: "lora" | "composition", scale,
//            strength (Change amount, image + strength route) } }
// view: {
//   lane: "edit", tool: "edit" | "trained_edit", model_id, blocked (text or
//   null), experimental, route (trained: "image_strength" | "reference" |
//   "mask"), source { kind: "selection" | "canvas" | "layer", text },
//   sizes { context {width, height}, upload {width, height}, scale },
//   notes [text], prompt_hint, controls { margin, sample, feather, takes,
//   takes_max, change_amount, style_strength },
//   request (for forms/requests.build), capture { kind: "edit", spec (for
//   capture.edit) }, mask (a mask input is filled) }

var shapeMod = require("../capture/shape.js");
var trainedMod = require("../catalog/trained.js");
var common = require("./common.js");

var TEXT = common.TEXT;

function blockedView(base, text) {
  base.blocked = text;
  base.request = null;
  base.capture = null;
  return base;
}

function sourceText(kind, ctx, sel) {
  if (kind === "selection") return "Selection " + sel.width + " x " + sel.height;
  if (kind === "layer") return 'Layer "' + (ctx.layer ? ctx.layer.name : "") + '"';
  return "All visible";
}

function qualityOk(schema, q) {
  var p = common.param(schema, "quality");
  return !!(p && p.enum && p.enum.indexOf(q) >= 0);
}

function editView(schema, ctx, o) {
  o = o || {};
  var trained = o.trained || null;
  var sample = o.sample === "layer" ? "layer" : "visible";
  var margin = o.margin === "64" || o.margin === "none" ? o.margin : "auto";
  var feather = typeof o.feather === "number" && o.feather >= 0 ? o.feather : common.DEFAULT_FEATHER;
  var view = {
    lane: "edit",
    tool: trained ? "trained_edit" : "edit",
    model_id: schema.model_id,
    blocked: null,
    experimental: !!trained,
    route: null,
    source: null,
    sizes: null,
    notes: [],
    prompt_hint: null,
    controls: { margin: margin, sample: sample, feather: feather, takes: null, takes_max: schema.takes_max || 1, change_amount: null, style_strength: null },
    request: null,
    capture: null,
    mask: false
  };
  if (trained) {
    view.route = trainedMod.editRoute(schema);
    if (!view.route) return blockedView(view, TEXT.no_edit_route);
    if (view.route === "reference") view.prompt_hint = TEXT.reference_hint;
  }
  if (!ctx || !ctx.doc) return blockedView(view, TEXT.no_document);
  var doc = ctx.doc;
  var canvas = { width: doc.width, height: doc.height };
  if (sample === "layer") {
    if (!ctx.layer) return blockedView(view, TEXT.no_layer);
    if (!ctx.layer.visible) return blockedView(view, common.hiddenText(ctx.layer.name));
  }
  var captureInput = schema.capture_input_name;
  if (!captureInput) return blockedView(view, TEXT.no_capture);
  var sel = ctx.selection;
  if (ctx.selection_raw && !sel) return blockedView(view, TEXT.outside);
  if (sel && (sel.width < common.MIN_SELECTION || sel.height < common.MIN_SELECTION)) return blockedView(view, TEXT.too_small);
  var kind = sel ? "selection" : sample === "layer" ? "layer" : "canvas";
  view.source = { kind: kind, text: sourceText(kind, ctx, sel), sample: sample === "layer" ? "Current layer" : "All visible" };
  var si = schema.size_inputs || { kind: "none" };
  var resParam = common.param(schema, "resolution");
  var so = { max_long: 2048, resolutions: resParam && resParam.enum ? resParam.enum : [], margin: margin };
  var shaped;
  var marginPx = 0;
  var contextBox;
  if (sel) {
    var ec = shapeMod.editCapture(sel, canvas, si, so);
    shaped = ec.shaped;
    marginPx = ec.margin;
    contextBox = ec.context;
  } else {
    var area = sample === "layer" ? common.layerBox(ctx.layer, canvas) : { left: 0, top: 0, width: canvas.width, height: canvas.height };
    if (!area) return blockedView(view, TEXT.layer_empty);
    shaped = shapeMod.shape(area, canvas, si, so);
    contextBox = area;
    view.notes.push(sample === "layer" ? TEXT.no_selection_layer_note : TEXT.no_selection_note);
  }
  view.sizes = { context: { width: contextBox.width, height: contextBox.height }, upload: { width: shaped.upload.width, height: shaped.upload.height }, scale: Math.round(shaped.scale * 1000) / 1000 };
  if (shaped.scale < 0.995) view.notes.push("Generated at about " + Math.round(shaped.scale * 100) + "% of this area's resolution.");
  var pad = shaped.pad;
  if (pad.left || pad.top || pad.right || pad.bottom) view.notes.push(TEXT.pad_note);

  var params = common.presetFor("edit", schema.model_id);
  for (var k in shaped.params) params[k] = shaped.params[k];
  if (schema.prompt_input && o.prompt) params[schema.prompt_input] = o.prompt;
  // Quality (Advanced): Low, Medium or High, for models that have the input.
  if (o.quality && !trained && qualityOk(schema, o.quality)) params.quality = o.quality;
  if (trained) {
    if (trained.kind === "composition") params.modelId = trained.model_id;
    else {
      var scale = typeof trained.scale === "number" ? trained.scale : null;
      params.loras = [trained.model_id];
      if (scale !== null) params.lorasScale = [scale];
      view.controls.style_strength = scale;
    }
    if (view.route === "image_strength") {
      var sp = common.param(schema, "strength");
      var amount = typeof trained.strength === "number" ? trained.strength : sp && typeof sp.default === "number" ? sp.default : null;
      if (amount !== null) params.strength = amount;
      view.controls.change_amount = { value: amount, min: sp ? sp.min : null, max: sp ? sp.max : null, default: sp ? sp.default : null, note: TEXT.change_amount };
    }
  }
  var takes = common.takesFor(schema, "edit", o.takes);
  view.controls.takes = takes;

  var mask = common.maskInput(schema);
  view.mask = !!(sel && mask);
  var target = {
    kind: kind === "layer" ? "canvas" : kind,
    document_id: doc.id,
    box: common.boxArray(shaped.box),
    canvas: [canvas.width, canvas.height],
    upload: [shaped.upload.width, shaped.upload.height],
    sample: sample,
    layer_id: sample === "layer" ? ctx.layer.id : null,
    selection: sel ? common.boxArray(sel) : null,
    margin: marginPx,
    feather: feather
  };
  // Remove: the check also looks for parts of the selection left as they were.
  if (o.expect === "cleared" && sel) target.expect = "cleared";
  view.request = {
    lane: "edit",
    model_id: schema.model_id,
    parameters: params,
    takes: takes,
    target: target,
    source_size: { width: shaped.upload.width, height: shaped.upload.height },
    references: 0,
    mask: view.mask,
    trained: !!trained
  };
  view.capture = {
    kind: "edit",
    spec: {
      document_id: doc.id,
      document_title: doc.title,
      canvas: canvas,
      layer_id: sample === "layer" ? ctx.layer.id : null,
      box: shaped.box,
      upload: shaped.upload,
      selection: !!sel,
      polarity: common.polarity(schema),
      mask_input: view.mask ? mask : null,
      capture_input: captureInput,
      feather: feather,
      jpeg_ok: common.jpegOk(schema.model_id),
      follows_input: shaped.kind === "none"
    }
  };
  return view;
}

// Trained > Edit: the Edit lane on the trained model's base. trained: {
// model_id, kind, scale, strength }. The base's schema decides the route.
function trainedView(baseSchema, ctx, trained, o) {
  var opts = {};
  for (var k in o || {}) opts[k] = o[k];
  opts.trained = trained;
  return editView(baseSchema, ctx, opts);
}

module.exports = { editView: editView, trainedView: trainedView, TEXT: TEXT };
