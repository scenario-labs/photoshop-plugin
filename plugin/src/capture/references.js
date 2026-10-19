"use strict";
// References for the Image lane (SPEC 3.2, 5.2, 5.5): captured when the
// person adds them, uploaded when they click Generate.
//
// - Sources: the selection's box from all visible layers (unmasked), the
//   active layer, all visible, or a PNG or JPEG file the person chooses.
// - Captures are read as 8-bit sRGB at most at the model's input size
//   (2048 px on the long side by default). Opaque pixels go as JPEG when the
//   model takes JPEG (encoded by Photoshop), others as PNG (encoded here).
// - Uploads go through the base64 route only, so each file must stay under
//   4,000,000 bytes: a capture that does not fit is read again with the long
//   side 10% smaller until it does, and carries `reduced` for the Input
//   reduced badge. A chosen file is sent as it is, minus its metadata (EXIF,
//   XMP, IPTC, text chunks), and refused when it is still too large: it is
//   never decoded here.

var API = require("../../../shared/scenario-api.json");
var MAP = require("../../../shared/catalog-map.json");
var errorsMod = require("../scenario/errors.js");
var png = require("../util/png.js");
var jpeg = require("../util/jpeg.js");

var LIMIT = API.uploads.max_file_bytes;

function invalid(text) {
  return new errorsMod.ScenarioError("InvalidParameter", text);
}

function mb(bytes) {
  return (Math.round((bytes / 1000000) * 10) / 10).toFixed(1) + " MB";
}

function opaque(px) {
  if (px.components !== 4) return true;
  var d = px.data;
  for (var i = 3; i < d.length; i += 4) if (d[i] !== 255) return false;
  return true;
}

function dropAlpha(px) {
  if (px.components === 3) return px;
  var n = px.width * px.height;
  var out = new Uint8Array(n * 3);
  for (var i = 0, j = 0; i < n; i++, j += 3) {
    out[j] = px.data[i * 4];
    out[j + 1] = px.data[i * 4 + 1];
    out[j + 2] = px.data[i * 4 + 2];
  }
  return { width: px.width, height: px.height, components: 3, data: out };
}

// Which formats a model takes for image inputs (shared/catalog-map.json,
// models.*.input_formats); PNG only when nothing is recorded.
function acceptsJpeg(modelId) {
  var facts = Object.prototype.hasOwnProperty.call(MAP.models, modelId) ? MAP.models[modelId] : null;
  return !!(facts && Array.isArray(facts.input_formats) && facts.input_formats.indexOf("jpeg") >= 0);
}

// o: { host: { readPixels(req), encodeJpeg(px), activeLayerInfo(docId),
//      selectionBounds(docId), documentSize(docId), chooseImageFile() },
//      random: {bytes(n)}, log }
function createReferences(o) {
  var log = o.log || function () {};
  var seq = 0;

  function newId() {
    seq++;
    var b = o.random ? o.random.bytes(3) : [seq & 255, 0, 0];
    var h = "";
    for (var i = 0; i < b.length; i++) h += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return "ref" + seq + "-" + h;
  }

  // Reads and encodes until the file fits. req: { document_id, layer_id,
  // bounds: {left, top, width, height} } (no layer: all visible).
  async function encodeFitting(req, sourceLong, maxLong, jpegOk) {
    var long = Math.min(maxLong, sourceLong);
    var first = long;
    for (var step = 0; step <= API.uploads.reduce_steps; step++) {
      var px = await o.host.readPixels({ document_id: req.document_id, layer_id: req.layer_id || null, bounds: req.bounds || null, long_side: long });
      var bytes;
      var ext;
      if (jpegOk && opaque(px)) {
        bytes = await o.host.encodeJpeg(dropAlpha(px));
        ext = "jpg";
      } else {
        bytes = png.encodePng({ width: px.width, height: px.height, channels: px.components, data: px.data });
        ext = "png";
      }
      if (bytes.length < LIMIT) {
        return { bytes: bytes, ext: ext, mime: ext === "jpg" ? "image/jpeg" : "image/png", width: px.width, height: px.height, reduced: long < first, alpha: ext === "png" && px.components === 4 };
      }
      var next = Math.floor(long * API.uploads.reduce_step);
      if (next < API.uploads.min_long_side_px) break;
      log("reference: " + px.width + " x " + px.height + " is " + mb(bytes.length) + ", reading at " + next + " px");
      long = next;
    }
    throw invalid("This reference does not fit Scenario's 4 MB upload limit, even reduced.");
  }

  // source: "selection" | "layer" | "visible". modelId picks the encoding,
  // maxLong the input size, layerId a layer other than the active one (a
  // document reference). Resolves a reference.
  async function capture(source, docId, modelId, maxLong, layerId) {
    var size = o.host.documentSize(docId);
    if (!size) throw invalid("Open or create a document to add a reference from it.");
    maxLong = maxLong || MAP.capture.default_long_side_px;
    var req = { document_id: size.id };
    var label;
    var w = size.width;
    var h = size.height;
    if (source === "selection") {
      var sel = await o.host.selectionBounds(size.id);
      if (!sel) throw invalid("There is no selection. Select an area first, or add the layer or all visible.");
      var left = Math.max(0, sel.left);
      var top = Math.max(0, sel.top);
      var right = Math.min(size.width, sel.left + sel.width);
      var bottom = Math.min(size.height, sel.top + sel.height);
      if (right - left < 1 || bottom - top < 1) throw invalid("Selection is outside the canvas.");
      req.bounds = { left: left, top: top, width: right - left, height: bottom - top };
      w = req.bounds.width;
      h = req.bounds.height;
      label = "Selection " + w + " x " + h;
    } else if (source === "layer") {
      var layer = layerId && typeof o.host.layerInfo === "function" ? await o.host.layerInfo(size.id, layerId) : await o.host.activeLayerInfo(size.id);
      if (!layer) throw invalid(layerId ? "The reference layer is gone from this document." : "Select a layer first.");
      if (layer.visible === false) throw invalid('Layer "' + layer.name + '" is hidden. Show it to use it as the source.');
      req.layer_id = layer.id;
      if (layer.bounds && layer.bounds.width > 0 && layer.bounds.height > 0) {
        w = layer.bounds.width;
        h = layer.bounds.height;
      }
      label = 'Layer "' + layer.name + '"';
    } else if (source === "visible") {
      label = "All visible";
    } else {
      throw invalid("Unknown reference source.");
    }
    var out = await encodeFitting(req, Math.max(w, h), maxLong, acceptsJpeg(modelId));
    out.id = newId();
    out.source = source;
    out.label = label;
    out.document_id = size.id;
    return out;
  }

  // A PNG or JPEG the person chooses; null when they cancel the dialog.
  async function chooseFile(modelId) {
    var file = await o.host.chooseImageFile();
    if (!file) return null;
    var bytes = file.bytes;
    var out;
    if (png.isPng(bytes)) {
      var p = png.stripPng(bytes);
      var info = png.pngInfo(p.bytes);
      out = { bytes: p.bytes, ext: "png", mime: "image/png", width: info.width, height: info.height, alpha: info.alpha, stripped: p.dropped };
    } else if (jpeg.isJpeg(bytes)) {
      if (!acceptsJpeg(modelId)) throw invalid("This model takes PNG files only.");
      var j = jpeg.stripJpeg(bytes);
      var jinfo = jpeg.jpegInfo(j.bytes);
      out = { bytes: j.bytes, ext: "jpg", mime: "image/jpeg", width: jinfo.width, height: jinfo.height, alpha: false, stripped: j.dropped };
    } else {
      throw invalid("Choose a PNG or JPEG file. Other formats can be opened in Photoshop and added as a layer.");
    }
    if (out.bytes.length >= LIMIT) throw invalid("This file is " + mb(out.bytes.length) + " without its metadata; files must be under 4 MB. Open it in Photoshop and add it as a layer to send it reduced.");
    out.id = newId();
    out.source = "file";
    out.label = String(file.name || "File");
    out.reduced = false;
    out.document_id = null;
    return out;
  }

  return { capture: capture, chooseFile: chooseFile };
}

module.exports = { createReferences: createReferences, acceptsJpeg: acceptsJpeg, LIMIT: LIMIT };
