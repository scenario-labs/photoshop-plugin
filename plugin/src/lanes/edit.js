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
//   mask_layer: true: no selection needed, the active layer's outline is
//            the mask (Relight to scene),
//   extra: { name: value } for the model's own inputs that the action
//            sets (New angle: horizontalAngle, verticalAngle, zoom); names
//            the schema lacks are left out,
//   change: 0..1, the Change amount (Subtle to Free) for a model with a
//            strength input, mapped onto that input's range,
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
var MATTE = 128;

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

// A Change amount (0..1) as a value of the model's strength input: its
// range when the schema gives one, else 0 to 1; two decimals.
function strengthAt(p, at) {
  var lo = typeof p.min === "number" ? p.min : 0;
  var hi = typeof p.max === "number" ? p.max : 1;
  var v = lo + Math.max(0, Math.min(1, at)) * (hi - lo);
  return Math.round(v * 100) / 100;
}

// The trained models of a run as the base's inputs (SPEC 3.4): a
// composition as modelId, LoRAs as loras with their weights in lorasScale.
// trained: { model_id, kind, scale } for one model, or { loras: [{ model_id,
// scale }] } for several stacked on one base (a trained style and a
// trained model picked in the Model menu).
function loraParams(params, trained) {
  if (!trained) return params;
  if (Array.isArray(trained.loras) && trained.loras.length) {
    params.loras = trained.loras.map(function (l) {
      return l.model_id;
    });
    var scales = trained.loras.map(function (l) {
      return typeof l.scale === "number" ? l.scale : null;
    });
    if (scales.every(function (x) {
      return x !== null;
    })) params.lorasScale = scales;
    return params;
  }
  if (trained.kind === "composition") params.modelId = trained.model_id;
  else {
    params.loras = [trained.model_id];
    if (typeof trained.scale === "number") params.lorasScale = [trained.scale];
  }
  return params;
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
  // Relight to scene (FLOWS v2, F13): the layer's own outline is the mask,
  // read from its transparency at Generate, and the model sees the scene
  // around it.
  var maskLayer = null;
  if (o.mask_layer && !sel) {
    if (!ctx.layer) return blockedView(view, TEXT.no_layer);
    if (!ctx.layer.visible) return blockedView(view, common.hiddenText(ctx.layer.name));
    sel = common.layerBox(ctx.layer, canvas);
    if (!sel) return blockedView(view, TEXT.layer_empty);
    maskLayer = ctx.layer.id;
  }
  if (ctx.selection_raw && !sel) return blockedView(view, TEXT.outside);
  if (sel && (sel.width < common.MIN_SELECTION || sel.height < common.MIN_SELECTION)) return blockedView(view, TEXT.too_small);
  var kind = sel ? "selection" : sample === "layer" ? "layer" : "canvas";
  view.source = { kind: kind, text: maskLayer ? 'Outline of "' + ctx.layer.name + '"' : sourceText(kind, ctx, sel), sample: sample === "layer" ? "Current layer" : "All visible" };
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
  if (o.extra) for (var xk in o.extra) if (common.param(schema, xk) && o.extra[xk] !== undefined && o.extra[xk] !== null) params[xk] = o.extra[xk];
  if (trained) {
    loraParams(params, trained);
    view.controls.style_strength = typeof params.lorasScale === "object" && params.lorasScale ? params.lorasScale[0] : null;
    if (view.route === "image_strength") {
      var sp = common.param(schema, "strength");
      var amount = typeof trained.strength === "number" ? trained.strength : sp && typeof sp.default === "number" ? sp.default : null;
      if (amount !== null) params.strength = amount;
      view.controls.change_amount = { value: amount, min: sp ? sp.min : null, max: sp ? sp.max : null, default: sp ? sp.default : null, note: TEXT.change_amount };
    }
  }
  // Change amount on any edit model with a strength input (the trained
  // image + strength route above sets its own).
  var sp0 = common.param(schema, "strength");
  if (!trained && sp0 && typeof o.change === "number") {
    var amount0 = strengthAt(sp0, o.change);
    params.strength = amount0;
    view.controls.change_amount = { value: amount0, min: sp0.min, max: sp0.max, default: sp0.default, note: TEXT.change_amount };
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
  if (maskLayer) target.mask_layer_id = maskLayer;
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
      mask_layer_id: maskLayer,
      polarity: common.polarity(schema),
      mask_input: view.mask ? mask : null,
      capture_input: captureInput,
      feather: feather,
      jpeg_ok: common.jpegOk(schema.model_id),
      follows_input: shaped.kind === "none"
    }
  };
  // New angle on a cut-out or a split element: the model takes no
  // transparency, so the empty parts go to it as gray and the takes land on
  // gray (live 2026-10-20: sent transparent, they came back on black).
  if (o.matte && sample === "layer") {
    view.capture.spec.matte = MATTE;
    view.notes.push(TEXT.matte_note);
  }
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

module.exports = { editView: editView, trainedView: trainedView, strengthAt: strengthAt, loraParams: loraParams, TEXT: TEXT };
