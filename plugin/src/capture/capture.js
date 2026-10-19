"use strict";
// Captures for the Edit, Trained > Edit, Expand, Upscale and Remove BG lanes
// (SPEC 3.8 steps 3 to 5, 5.5, 5.8, 9.3), taken when the person clicks
// Generate and before anything is spent:
// - the context: the shaped box read as 8-bit sRGB at upload size from all
//   visible layers or the current layer, the part outside the canvas padded
//   with repeated edge pixels;
// - the edit mask from the selection (white = edit), and the mask in the
//   model's polarity when the model takes one;
// - for Expand, the new canvas with the original at its anchor and the new
//   area empty, or the original alone for routes that place it themselves;
// - for Upscale and Remove BG, the source at full resolution up to the cap.
// Opaque captures go as JPEG when the model takes JPEG, others as PNG. Each
// file stays under the upload limit: the capture (and its mask) shrinks in
// 10% steps and carries `reduced`. When the model's output follows its input,
// a reduction changes what the person was shown, so the capture stops with
// InputReduced (reduced_long: the long side that fits) and nothing is spent.
// The files go to captures/<id>/ in the plugin data folder (context, mask,
// model-mask, capture.json); small copies stay in memory for the checks.

var API = require("../../../shared/scenario-api.json");
var errorsMod = require("../scenario/errors.js");
var png = require("../util/png.js");
var pixels = require("./pixels.js");
var shapeMod = require("./shape.js");

var LIMIT = API.uploads.max_file_bytes;
var CHECK_LONG = 512;
var DIR = "captures";

function invalid(text) {
  return new errorsMod.ScenarioError("InvalidParameter", text);
}

function opaque(img) {
  if (img.components !== 4) return true;
  for (var i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return false;
  return true;
}

function rgb(img) {
  if (img.components === 3) return img;
  var n = img.width * img.height;
  var out = new Uint8Array(n * 3);
  for (var i = 0; i < n; i++) for (var c = 0; c < 3; c++) out[i * 3 + c] = img.data[i * img.components + Math.min(c, img.components - 1)];
  return { width: img.width, height: img.height, components: 3, data: out };
}

// The region `box` (document pixels) of a read covering `clip` at its own
// size, as an outW x outH image; outside the read, edge pixels repeat.
function fromRead(read, clip, box, outW, outH, mode) {
  var kx = read.width / clip.width;
  var ky = read.height / clip.height;
  var region = { left: (box.left - clip.left) * kx, top: (box.top - clip.top) * ky, width: box.width * kx, height: box.height * ky };
  return pixels.sampleRegion(read, { x: 0, y: 0 }, region, outW, outH, mode === undefined ? "clamp" : mode);
}

// o: { host, random: {bytes(n)}, log, now, session }
function createCapture(o) {
  var log = o.log || function () {};
  var now =
    o.now ||
    function () {
      return Date.now();
    };
  var seq = 0;

  function newId() {
    seq++;
    var b = o.random ? o.random.bytes(5) : [seq, 0, 0, 0, 0];
    var h = "";
    for (var i = 0; i < b.length; i++) h += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return "cap-" + now().toString(36) + "-" + h;
  }

  async function encode(img, jpegOk) {
    if (jpegOk && opaque(img)) return { bytes: await o.host.encodeJpeg(rgb(img)), ext: "jpg" };
    return { bytes: png.encodePng({ width: img.width, height: img.height, channels: img.components, data: img.data }), ext: "png" };
  }

  // Encodes the image (and its mask, at the same size) under the upload
  // limit, shrinking both in 10% steps.
  async function fit(img, mask, jpegOk, followsInput) {
    var cur = img;
    var curMask = mask;
    for (var step = 0; step <= API.uploads.reduce_steps; step++) {
      var e = await encode(cur, jpegOk);
      var m = curMask ? await encode(curMask, false) : null;
      if (e.bytes.length < LIMIT && (!m || m.bytes.length < LIMIT)) {
        if (step > 0 && followsInput) {
          // The output follows this size, so the price shown may not hold:
          // stop before anything is sent, with the size that fits.
          var r = new errorsMod.ScenarioError("InputReduced", "The source fits Scenario's 4 MB upload limit at " + cur.width + " x " + cur.height + ". Check the new size and price, then click Generate again.");
          r.reduced_long = Math.max(cur.width, cur.height);
          throw r;
        }
        return { image: e, mask: m, width: cur.width, height: cur.height, reduced: step > 0 };
      }
      var w = Math.floor(cur.width * API.uploads.reduce_step);
      var h = Math.floor(cur.height * API.uploads.reduce_step);
      if (Math.max(w, h) < API.uploads.min_long_side_px) break;
      log("capture: " + cur.width + " x " + cur.height + " is over the upload limit, reducing");
      cur = pixels.resize(cur, w, h);
      if (curMask) curMask = pixels.resize(curMask, w, h);
    }
    throw invalid("This capture does not fit Scenario's 4 MB upload limit, even reduced. Use a smaller selection or margin.");
  }

  async function save(id, name, bytes) {
    try {
      await o.host.ensureDataDir(DIR + "/" + id);
      await o.host.writeDataBinary(DIR + "/" + id + "/" + name, bytes);
      return DIR + "/" + id + "/" + name;
    } catch (e) {
      log("capture: a file was not saved (" + ((e && e.message) || e) + ")");
      return null;
    }
  }

  async function record(id, c, extra) {
    var rec = { capture_id: id, kind: c.kind, document_id: c.document_id, document_title: c.document_title || null, session: o.session || null, created_at: new Date(now()).toISOString(), local_id: null };
    for (var k in extra) rec[k] = extra[k];
    try {
      await o.host.ensureDataDir(DIR + "/" + id);
      await o.host.writeDataText(DIR + "/" + id + "/capture.json", JSON.stringify(rec, null, 1));
    } catch (e) {
      log("capture: capture.json not saved");
    }
  }

  async function read(docId, layerId, clip, longSide) {
    return o.host.readPixels({ document_id: docId, layer_id: layerId || null, bounds: clip, long_side: longSide, exact: true });
  }

  // Selection edit or whole-layer edit. c: { document_id, document_title,
  // canvas {width, height}, layer_id (sample: current layer), box (shaped),
  // upload {width, height}, selection (bounds or null), polarity, mask_input
  // (name or null), capture_input (name), feather, jpeg_ok, follows_input }.
  async function edit(c) {
    var id = newId();
    var clip = shapeMod.clip(c.box, c.canvas);
    if (!clip) throw invalid("Selection is outside the canvas.");
    var scale = c.upload.width / c.box.width;
    var longRead = Math.max(1, Math.round(Math.max(clip.width, clip.height) * scale));
    var got = await read(c.document_id, c.layer_id, clip, longRead);
    var context = fromRead(got, clip, c.box, c.upload.width, c.upload.height, "clamp");
    var sel = null;
    if (c.selection) {
      sel = await o.host.readSelectionMask(c.document_id);
      if (!sel) throw invalid("The selection is empty.");
    }
    var editMask = sel ? pixels.maskForBox(sel, c.box, c.upload.width, c.upload.height) : null;
    var modelMask = editMask && c.mask_input ? pixels.inPolarity(editMask, c.polarity || "white") : null;
    var fitted = await fit(context, modelMask, c.jpeg_ok, !!c.follows_input);
    var files = [{ input: c.capture_input, slot: "capture", bytes: fitted.image.bytes, ext: fitted.image.ext, width: fitted.width, height: fitted.height, reduced: fitted.reduced }];
    if (fitted.mask) files.push({ input: c.mask_input, slot: "mask", bytes: fitted.mask.bytes, ext: "png", width: fitted.width, height: fitted.height, reduced: fitted.reduced });
    await save(id, "context." + fitted.image.ext, fitted.image.bytes);
    if (editMask) await save(id, "mask.png", png.encodePng({ width: editMask.width, height: editMask.height, channels: 1, data: editMask.data }));
    if (fitted.mask) await save(id, "model-mask.png", fitted.mask.bytes);
    // Small copies for the checks, over the part of the box inside the canvas.
    var cs = pixels.fitLong(clip.width, clip.height, CHECK_LONG);
    var check = {
      region: clip,
      width: cs.width,
      height: cs.height,
      scale: cs.width / clip.width,
      context: rgb(fromRead(got, clip, clip, cs.width, cs.height, "clamp")),
      mask: sel ? pixels.maskForBox(sel, clip, cs.width, cs.height) : { width: cs.width, height: cs.height, components: 1, data: new Uint8Array(cs.width * cs.height).fill(255) }
    };
    var placeMask = sel ? pixels.placementMask(sel, clip, c.feather || 0) : null;
    await record(id, c, { box: [c.box.left, c.box.top, c.box.width, c.box.height], upload: [fitted.width, fitted.height], masked: !!sel });
    return { id: id, files: files, reduced: fitted.reduced, memo: { check: check, placement_mask: placeMask } };
  }

  // Expand. c: { document_id, canvas {width, height}, expand {width, height,
  // offset, sides}, box (shaped, new-canvas pixels), upload, route,
  // overlap, polarity, mask_input, capture_input, jpeg_ok, input_long }.
  async function expand(c) {
    var id = newId();
    var e = c.expand;
    var old = { left: e.offset.x, top: e.offset.y, width: c.canvas.width, height: c.canvas.height };
    var whole = { left: 0, top: 0, width: c.canvas.width, height: c.canvas.height };
    var files = [];
    var reduced = false;
    if (c.route === "mask") {
      var scale = c.upload.width / c.box.width;
      var got = await read(c.document_id, null, whole, Math.max(1, Math.round(Math.max(whole.width, whole.height) * scale)));
      var input = pixels.expandInput(got, old, c.box, c.upload.width, c.upload.height);
      var edit = pixels.expandEditMask(c.box, c.upload.width, c.upload.height, old, e.sides, c.overlap);
      var mm = c.mask_input ? pixels.inPolarity(edit, c.polarity || "white") : null;
      var f = await fit(input, mm, false, false);
      reduced = f.reduced;
      files.push({ input: c.capture_input, slot: "capture", bytes: f.image.bytes, ext: f.image.ext, width: f.width, height: f.height, reduced: f.reduced });
      if (f.mask) files.push({ input: c.mask_input, slot: "mask", bytes: f.mask.bytes, ext: "png", width: f.width, height: f.height, reduced: f.reduced });
      await save(id, "context." + f.image.ext, f.image.bytes);
      await save(id, "mask.png", png.encodePng({ width: edit.width, height: edit.height, channels: 1, data: edit.data }));
      if (f.mask) await save(id, "model-mask.png", f.mask.bytes);
    } else {
      var src = await read(c.document_id, null, whole, Math.min(Math.max(whole.width, whole.height), c.input_long || 2048));
      var g = await fit(src, null, c.jpeg_ok, false);
      reduced = g.reduced;
      files.push({ input: c.capture_input, slot: "capture", bytes: g.image.bytes, ext: g.image.ext, width: g.width, height: g.height, reduced: g.reduced });
      await save(id, "context." + g.image.ext, g.image.bytes);
    }
    var cs = pixels.fitLong(old.width, old.height, CHECK_LONG);
    var check = {
      old: old,
      width: cs.width,
      height: cs.height,
      scale: cs.width / old.width,
      band: pixels.expandBand(old, cs.width, cs.height, old, e.sides, c.overlap)
    };
    await record(id, c, { expand: { width: e.width, height: e.height, offset: [e.offset.x, e.offset.y] }, route: c.route });
    return { id: id, files: files, reduced: reduced, memo: { check: check } };
  }

  // Upscale and Remove BG sources. c: { document_id, layer_id, box (the
  // source in document pixels), read_long, capture_input, jpeg_ok }.
  async function source(c) {
    var id = newId();
    var got = await read(c.document_id, c.layer_id, c.box, c.read_long);
    var f;
    try {
      f = await fit(got, null, c.jpeg_ok, true);
    } catch (e) {
      if (!e || e.type !== "InputReduced") throw e;
      // The size the person prices next must fit when read at that size, so
      // read again at it, smaller in 10% steps until the read itself fits.
      var long = e.reduced_long;
      for (var i = 0; i < API.uploads.reduce_steps && long >= API.uploads.min_long_side_px; i++) {
        var again = await read(c.document_id, c.layer_id, c.box, long);
        var enc = await encode(again, c.jpeg_ok);
        if (enc.bytes.length < LIMIT) {
          e.reduced_long = long;
          e.message = "The source fits Scenario's 4 MB upload limit at " + again.width + " x " + again.height + ". Check the new size and price, then click Generate again.";
          throw e;
        }
        long = Math.floor(long * API.uploads.reduce_step);
      }
      throw invalid("This source does not fit Scenario's 4 MB upload limit, even reduced. Use a smaller source.");
    }
    var path = await save(id, "context." + f.image.ext, f.image.bytes);
    await record(id, c, { box: [c.box.left, c.box.top, c.box.width, c.box.height], read: [f.width, f.height] });
    return { id: id, files: [{ input: c.capture_input, slot: "capture", bytes: f.image.bytes, ext: f.image.ext, width: f.width, height: f.height, reduced: false }], reduced: false, memo: { source_path: path } };
  }

  // Links a capture to its job (SPEC 9.3: capture.json records the local_id).
  async function link(id, localId) {
    try {
      var text = await o.host.readDataText(DIR + "/" + id + "/capture.json");
      var rec = text ? JSON.parse(text) : {};
      rec.local_id = localId;
      await o.host.writeDataText(DIR + "/" + id + "/capture.json", JSON.stringify(rec, null, 1));
    } catch (e) {
      log("capture: capture.json not linked");
    }
  }

  return { edit: edit, expand: expand, source: source, link: link };
}

module.exports = { createCapture: createCapture, fromRead: fromRead, CHECK_LONG: CHECK_LONG, DIR: DIR };
