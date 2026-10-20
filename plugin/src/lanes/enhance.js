"use strict";
// The Enhance tools as view-models (SPEC 3.6, 5.5, 5.8): Upscale, Expand and
// Remove BG. Each view says what the tool reads, what it sends, what comes
// back and where it lands, and carries the request the price check prices
// and the capture taken at Generate. Same shape as lanes/edit.js:
// { lane, tool, model_id, blocked, source, sizes, notes, controls, request,
//   capture { kind: "expand" | "source", spec } }.

var shapeMod = require("../capture/shape.js");
var common = require("./common.js");

var TEXT = common.TEXT;
var FACTOR = /^(\d+(?:\.\d+)?)x$/;
// UXP layer kinds without pixels of their own (adjustment layers).
var ADJUSTMENTS = ["brightnessContrast", "levels", "curves", "exposure", "vibrance", "hueSaturation", "colorBalance", "blackAndWhite", "photoFilter", "channelMixer", "colorLookup", "invert", "posterize", "threshold", "gradientMap", "selectiveColor"];
var MASKABLE = ["pixel", "smartObject"];
// The read of the original image sent by the position and exact-size Expand
// routes (SPEC 5.5: the capture's default long side).
var EXPAND_INPUT_LONG = 2048;

function base(lane, tool, schema) {
  return { lane: lane, tool: tool, model_id: schema.model_id, blocked: null, source: null, sizes: null, notes: [], controls: {}, request: null, capture: null };
}

function blocked(v, text) {
  v.blocked = text;
  v.request = null;
  v.capture = null;
  return v;
}

function factors(schema) {
  var p = common.param(schema, "upscaleFactor");
  if (!p || !p.enum) return null;
  return {
    param: p,
    values: p.enum.filter(function (v) {
      return FACTOR.test(v);
    })
  };
}

// ---- Upscale ----

// o: { source: "visible" (default) | "layer" | "selection", factor ("2x"),
//      lands: "new_document" | "layer" | "box", read_long (a smaller read,
//      after InputReduced) }
function upscaleView(schema, ctx, o) {
  o = o || {};
  var v = base("upscale", "upscale", schema);
  var source = o.source === "layer" || o.source === "selection" ? o.source : "visible";
  v.controls.source = source;
  if (!ctx || !ctx.doc) return blocked(v, TEXT.no_document);
  var doc = ctx.doc;
  var canvas = { width: doc.width, height: doc.height };
  var box;
  if (source === "selection") {
    if (!ctx.selection) return blocked(v, ctx.selection_raw ? TEXT.outside : TEXT.no_selection_box);
    box = ctx.selection;
    v.source = { kind: "selection", text: "Selection box " + box.width + " x " + box.height };
  } else if (source === "layer") {
    if (!ctx.layer) return blocked(v, TEXT.no_layer);
    if (!ctx.layer.visible) return blocked(v, common.hiddenText(ctx.layer.name));
    if (ADJUSTMENTS.indexOf(ctx.layer.kind) >= 0) return blocked(v, TEXT.no_pixels);
    box = common.layerBox(ctx.layer, canvas);
    if (!box) return blocked(v, TEXT.layer_empty);
    v.source = { kind: "layer", text: 'Layer "' + ctx.layer.name + '"' };
  } else {
    box = { left: 0, top: 0, width: canvas.width, height: canvas.height };
    v.source = { kind: "visible", text: "All visible" };
  }
  var read = common.readSize(box, o.read_long);
  var params = common.presetFor("upscale", schema.model_id);
  var f = factors(schema);
  var factor = null;
  if (f && f.values.length) {
    var chosen = o.factor && f.values.indexOf(o.factor) >= 0 ? o.factor : params.upscaleFactor && f.values.indexOf(params.upscaleFactor) >= 0 ? params.upscaleFactor : f.param.default && f.values.indexOf(f.param.default) >= 0 ? f.param.default : f.values[0];
    params.upscaleFactor = chosen;
    factor = Number(FACTOR.exec(chosen)[1]);
    v.controls.factor = chosen;
    v.controls.factors = f.values.slice();
  }
  var out = null;
  if (factor) {
    out = { width: Math.round(read.width * factor), height: Math.round(read.height * factor) };
    var omax = schema.output_max_px;
    if (omax && Math.max(out.width, out.height) > omax) {
      var k = omax / Math.max(out.width, out.height);
      out = { width: Math.round(out.width * k), height: Math.round(out.height * k) };
      v.notes.push("Capped at this model's largest output, " + omax + " px.");
    }
    // Never send a source whose capped output is no larger than it.
    if (Math.max(out.width, out.height) <= Math.max(read.width, read.height)) return blocked(v, TEXT.too_big_for_model);
  }
  var lands = source === "selection" ? (o.lands === "new_document" ? "new_document" : "box") : o.lands === "layer" ? "layer" : "new_document";
  v.controls.lands = lands;
  v.controls.lands_choices = source === "selection" ? ["box", "new_document"] : ["new_document", "layer"];
  v.sizes = { source: { width: box.width, height: box.height }, read: { width: read.width, height: read.height }, output: out };
  if (out) {
    var line = "Output " + out.width + " x " + out.height;
    if (read.scale < 1) line += ", " + Math.round((out.width / box.width) * 10) / 10 + "x of this document";
    v.sizes.output_text = line;
  }
  if (read.scale < 1) v.notes.push("Read at " + read.width + " x " + read.height + ", the largest source this lane sends.");
  var capInput = schema.capture_input_name;
  if (!capInput) return blocked(v, TEXT.no_capture);
  var target = {
    kind: "upscale",
    document_id: doc.id,
    box: common.boxArray(box),
    canvas: [canvas.width, canvas.height],
    source: source,
    layer_id: source === "layer" ? ctx.layer.id : null,
    lands: lands,
    read: [read.width, read.height],
    output: out ? [out.width, out.height] : null
  };
  v.request = { lane: "upscale", model_id: schema.model_id, parameters: params, takes: null, target: target, source_size: { width: read.width, height: read.height }, references: 0 };
  v.capture = { kind: "source", spec: { document_id: doc.id, document_title: doc.title, layer_id: target.layer_id, box: box, read_long: Math.max(read.width, read.height), capture_input: capInput, jpeg_ok: common.jpegOk(schema.model_id) } };
  return v;
}

// ---- Remove BG ----

// o: { source: "layer" (default) | "selection", lands: "mask" | "new_layer",
//      read_long }
function cutoutView(schema, ctx, o) {
  o = o || {};
  var v = base("remove_background", "remove_background", schema);
  var source = o.source === "selection" ? "selection" : "layer";
  v.controls.source = source;
  if (!ctx || !ctx.doc) return blocked(v, TEXT.no_document);
  var doc = ctx.doc;
  var canvas = { width: doc.width, height: doc.height };
  var layer = ctx.layer;
  if (!layer) return blocked(v, TEXT.no_layer);
  if (!layer.visible) return blocked(v, common.hiddenText(layer.name));
  if (ADJUSTMENTS.indexOf(layer.kind) >= 0) return blocked(v, TEXT.no_pixels);
  var area = common.layerBox(layer, canvas);
  if (!area) return blocked(v, TEXT.layer_empty);
  var box;
  if (source === "selection") {
    if (!ctx.selection) return blocked(v, ctx.selection_raw ? TEXT.outside : TEXT.no_selection_box);
    box = shapeMod.clip(ctx.selection, { width: canvas.width, height: canvas.height });
    v.source = { kind: "selection", text: "Selection box " + box.width + " x " + box.height + ' of layer "' + layer.name + '"' };
  } else {
    box = area;
    v.source = { kind: "layer", text: 'Layer "' + layer.name + '"' };
  }
  var maskable = MASKABLE.indexOf(layer.kind) >= 0 && !layer.has_mask && (!layer.locked || layer.background);
  var lands = maskable && o.lands !== "new_layer" ? "mask" : "new_layer";
  if (!maskable && o.lands === "mask") v.notes.push(TEXT.cutout_new_layer_only);
  v.controls.lands = lands;
  v.controls.lands_choices = maskable ? ["mask", "new_layer"] : ["new_layer"];
  if (lands === "mask" && layer.background) v.notes.push("The Background layer becomes a normal layer, in the same History step.");
  if (lands === "mask" && source === "selection") v.notes.push(TEXT.selection_hides);
  var read = common.readSize(box, Math.min(o.read_long || Infinity, schema.output_max_px || Infinity));
  if (read.scale < 1) v.notes.push("Mask at " + Math.round(read.scale * 100) + "% of the layer's resolution.");
  v.sizes = { source: { width: box.width, height: box.height }, read: { width: read.width, height: read.height } };
  var capInput = schema.capture_input_name;
  if (!capInput) return blocked(v, TEXT.no_capture);
  var maskBox = lands === "mask" ? area : box;
  var target = {
    kind: "cutout",
    document_id: doc.id,
    box: common.boxArray(box),
    canvas: [canvas.width, canvas.height],
    source: source,
    layer_id: layer.id,
    background: !!layer.background,
    lands: lands,
    mask_box: common.boxArray(maskBox),
    read: [read.width, read.height]
  };
  v.request = { lane: "remove_background", model_id: schema.model_id, parameters: common.presetFor("remove_background", schema.model_id), takes: null, target: target, source_size: { width: read.width, height: read.height }, references: 0 };
  v.capture = { kind: "source", spec: { document_id: doc.id, document_title: doc.title, layer_id: layer.id, box: box, read_long: Math.max(read.width, read.height), capture_input: capInput, jpeg_ok: false } };
  return v;
}

// ---- Expand ----

function norm(s) {
  return String(s).toLowerCase().replace(/middle/g, "center").replace(/centre/g, "center").replace(/[^a-z]/g, "");
}

// The schema's position value for an anchor, or null.
function positionFor(schema, anchor) {
  var p = common.param(schema, "position");
  if (!p || !p.enum) return null;
  var want = norm(anchor);
  var alt = want === "center" ? ["center", "centercenter"] : [want, want.replace(/^center/, "")];
  for (var i = 0; i < p.enum.length; i++) if (alt.indexOf(norm(p.enum[i])) >= 0) return p.enum[i];
  return null;
}

function ratioText(r) {
  return typeof r === "object" && r ? r.width + ":" + r.height : String(r);
}

// o: { mode: "aspect" (default) | "sides", ratio ("4:5", or {width, height}
//      for Custom), anchor (shape.ANCHORS, default "center"), sides {left,
//      top, right, bottom}, lands: "document" (default) | "copy", overlap
//      (default 32), prompt, takes, quality (models with a quality input) }
function expandView(schema, ctx, o) {
  o = o || {};
  var v = base("expand", "expand", schema);
  var route = schema.expand_route;
  var mode = o.mode === "sides" ? "sides" : "aspect";
  var anchor = shapeMod.ANCHORS.indexOf(o.anchor) >= 0 ? o.anchor : "center";
  var overlap = typeof o.overlap === "number" && o.overlap >= 0 ? Math.round(o.overlap) : common.DEFAULT_OVERLAP;
  var lands = o.lands === "copy" ? "copy" : "document";
  v.route = route;
  v.controls = { mode: mode, ratio: o.ratio || "1:1", anchor: anchor, sides: o.sides || null, overlap: overlap, lands: lands, anchors_enabled: route !== "exact_size", sides_enabled: route === "mask", prompt: !!schema.prompt_input };
  if (!route) return blocked(v, TEXT.not_expand);
  if (!ctx || !ctx.doc) return blocked(v, TEXT.no_document);
  var doc = ctx.doc;
  var canvas = { width: doc.width, height: doc.height };
  var params = common.presetFor("expand", schema.model_id);
  var qp = common.param(schema, "quality");
  if (o.quality && qp && qp.enum && qp.enum.indexOf(o.quality) >= 0) params.quality = o.quality;
  var ratio = o.ratio || "1:1";
  if (route === "exact_size") {
    if (mode === "sides" || anchor !== "center") {
      v.notes.push(TEXT.center_only);
      if (mode === "sides") return blocked(v, TEXT.center_only);
    }
    anchor = "center";
    v.controls.anchor = anchor;
  }
  var position = null;
  if (route === "position") {
    if (mode === "sides") return blocked(v, TEXT.ratio_only);
    var rp = common.param(schema, "aspectRatio");
    var allowed = rp && rp.enum ? rp.enum.filter(function (x) { return shapeMod.parseRatio(x); }) : [];
    var r = typeof ratio === "object" ? ratio : { width: shapeMod.parseRatio(ratio) || 1, height: 1 };
    var pick = shapeMod.nearestRatio(allowed, r.width, r.height);
    if (!pick) return blocked(v, TEXT.not_expand);
    if (pick.value !== ratioText(ratio)) v.notes.push("This model's nearest ratio is " + pick.value + ".");
    ratio = pick.value;
    position = positionFor(schema, anchor);
    if (!position) return blocked(v, TEXT.no_position);
  }
  var e = shapeMod.expandCanvas(canvas, { mode: mode, ratio: ratio, anchor: anchor, sides: o.sides });
  if (!e) return blocked(v, TEXT.nothing_grows);
  var newCanvas = { width: e.width, height: e.height };
  var whole = { left: 0, top: 0, width: e.width, height: e.height };
  var shaped;
  var inputLong = Math.min(Math.max(canvas.width, canvas.height), EXPAND_INPUT_LONG);
  var si = schema.size_inputs || { kind: "none" };
  if (route === "mask") {
    shaped = shapeMod.shape(whole, newCanvas, si, { max_long: common.maxOutput(schema) || 2048 });
    for (var k in shaped.params) params[k] = shaped.params[k];
  } else if (route === "exact_size") {
    shaped = shapeMod.shape(whole, newCanvas, si, { max_long: common.maxOutput(schema) || 4096 });
    for (var k2 in shaped.params) params[k2] = shaped.params[k2];
  } else {
    var resP = common.param(schema, "resolution");
    shaped = shapeMod.shape(whole, newCanvas, { kind: "ratio_enum", ratios: [ratio] }, { max_long: 4096, resolutions: resP && resP.enum ? resP.enum : [] });
    params.aspectRatio = ratio;
    if (shaped.params.resolution) params.resolution = shaped.params.resolution;
    params.position = position;
  }
  if (schema.prompt_input && o.prompt) params[schema.prompt_input] = o.prompt;
  var scaleNew = shaped.upload.width / e.width;
  v.sizes = { from: { width: canvas.width, height: canvas.height }, to: { width: e.width, height: e.height }, generated: { width: shaped.upload.width, height: shaped.upload.height }, text: canvas.width + " x " + canvas.height + " to " + e.width + " x " + e.height };
  if (route !== "mask") v.notes.push("Generates about " + shaped.upload.width + " x " + shaped.upload.height + ", scaled to the new canvas.");
  if (scaleNew < 0.995) v.notes.push("New area at about " + Math.round(scaleNew * 100) + "% of this document's resolution. Upscale it after, if needed.");
  var capInput = schema.capture_input_name;
  if (!capInput) return blocked(v, TEXT.no_capture);
  var mask = route === "mask" ? common.maskInput(schema) : null;
  var takes = common.takesFor(schema, "expand", o.takes);
  var target = {
    kind: "expand",
    document_id: doc.id,
    box: common.boxArray(route === "mask" ? shaped.box : whole),
    canvas: [canvas.width, canvas.height],
    expand: { width: e.width, height: e.height, offset: [e.offset.x, e.offset.y], sides: e.sides },
    route: route,
    overlap: overlap,
    anchor: anchor,
    upload: [shaped.upload.width, shaped.upload.height],
    lands: lands
  };
  var readSize = common.readSize(canvas, inputLong);
  v.request = {
    lane: "expand",
    model_id: schema.model_id,
    parameters: params,
    takes: takes,
    target: target,
    source_size: route === "mask" ? { width: shaped.upload.width, height: shaped.upload.height } : { width: readSize.width, height: readSize.height },
    references: 0,
    mask: !!mask
  };
  v.capture = {
    kind: "expand",
    spec: {
      document_id: doc.id,
      document_title: doc.title,
      canvas: canvas,
      expand: { width: e.width, height: e.height, offset: { x: e.offset.x, y: e.offset.y }, sides: e.sides },
      box: route === "mask" ? shaped.box : whole,
      upload: shaped.upload,
      route: route,
      overlap: overlap,
      polarity: common.polarity(schema),
      mask_input: mask,
      capture_input: capInput,
      jpeg_ok: common.jpegOk(schema.model_id),
      input_long: inputLong
    }
  };
  return v;
}

module.exports = { upscaleView: upscaleView, cutoutView: cutoutView, expandView: expandView, positionFor: positionFor, ADJUSTMENTS: ADJUSTMENTS, TEXT: TEXT };
