"use strict";
// Agent inputs (MCP.md 4.3): capture_reference, upload_reference,
// reference_upload_status, and the request a capture_id prices in
// estimate_cost.
//
// A capture is taken by the same lane code as the panel (lanes/edit.js,
// lanes/enhance.js, capture/capture.js), shaped for the model, saved in
// the plugin's temp folder (captures/<capture_id>/) and recorded with its
// placement target. Nothing is sent: upload_reference sends a capture's
// parts, and the first upload from each document, chosen file or saved
// result in a client session waits for the person's Allow in the panel.

var errorsMod = require("../scenario/errors.js");
var assetsMod = require("../scenario/assets.js");
var requests = require("../forms/requests.js");
var editMod = require("../lanes/edit.js");
var enhanceMod = require("../lanes/enhance.js");
var common = require("../lanes/common.js");
var shapeMod = require("../capture/shape.js");
var png = require("../util/png.js");
var jpeg = require("../util/jpeg.js");

var PURPOSES = { edit: "edit", reference: "image", expand: "expand", upscale: "upscale", remove_background: "remove_background" };
var SOURCES = ["selection", "layer", "all_visible", "document"];

function fail(type, text) {
  return new errorsMod.ScenarioError(type, text);
}

function invalid(text) {
  return fail("InvalidParameter", text);
}

function copy(v) {
  return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
}

// o: { host, catalog, capture, references, client, settings, approvals,
//      scope (agents/scope.js), random, now, log, session (this Photoshop
//      start), ledger }
function createInputs(o) {
  var log = o.log || function () {};
  var captures = {};
  var refs = {};
  // Consents per client session: { session: { "doc:<id>": true } }.
  var consents = {};
  // Files the person chose in the panel this session, by name.
  var chosen = {};
  var seq = 0;

  function newRef() {
    seq++;
    var b = o.random.bytes(4);
    var h = "";
    for (var i = 0; i < b.length; i++) h += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return "refup-" + seq + "-" + h;
  }

  // The lane context of any open document (reads work on any document).
  async function contextFor(docId, layerId) {
    var size = o.host.documentSize(docId);
    if (!size) throw fail("DocumentClosed", "The document is closed.");
    var title = null;
    var docs = o.host.listDocuments();
    for (var i = 0; i < docs.length; i++) if (docs[i].id === docId) title = docs[i].title;
    var raw = null;
    try {
      raw = await o.host.selectionBounds(docId);
    } catch (e) {
      raw = null;
    }
    var layer = null;
    try {
      layer = layerId ? await o.host.layerInfo(docId, layerId) : await o.host.activeLayerInfo(docId);
    } catch (e) {
      layer = null;
    }
    if (layerId && !layer) throw invalid("No layer " + layerId + " in this document.");
    var canvas = { width: size.width, height: size.height };
    return { doc: { id: docId, width: size.width, height: size.height, title: title }, selection: raw ? shapeMod.clip(raw, canvas) : null, selection_raw: raw, layer: layer };
  }

  function marginOpt(m) {
    if (m === undefined || m === null) return { value: "auto", note: null };
    if (m === 0) return { value: "none", note: null };
    if (m === 64) return { value: "64", note: null };
    return { value: "auto", note: "margin " + m + " is not offered; the automatic margin (half the long side, at least 64 px) was used." };
  }

  function viewFor(purpose, schema, ctx, a) {
    var src = a.source;
    if (purpose === "edit") {
      var m = marginOpt(a.margin);
      var opts = { margin: m.value, sample: a.sample === "layer" || src === "layer" ? "layer" : "visible", feather: 2 };
      var v = editMod.editView(schema, ctx, opts);
      if (m.note) v.notes.push(m.note);
      return v;
    }
    if (purpose === "expand") {
      var e = a.expand || {};
      var sides = e.left !== undefined || e.top !== undefined || e.right !== undefined || e.bottom !== undefined;
      return enhanceMod.expandView(schema, ctx, { mode: sides ? "sides" : "aspect", sides: sides ? { left: e.left || 0, top: e.top || 0, right: e.right || 0, bottom: e.bottom || 0 } : null, ratio: e.aspect || "1:1", anchor: e.anchor || "center", overlap: typeof e.overlap === "number" ? e.overlap : undefined });
    }
    if (purpose === "upscale") return enhanceMod.upscaleView(schema, ctx, { source: src === "selection" ? "selection" : src === "layer" ? "layer" : "visible", lands: "layer", read_long: a.max_px || undefined });
    return enhanceMod.cutoutView(schema, ctx, { source: src === "selection" ? "selection" : "layer", lands: "mask" });
  }

  function partName(f) {
    return f.slot === "mask" ? "mask" : "context";
  }

  // capture_reference.
  async function captureReference(args, ctx) {
    var purpose = args.purpose || "reference";
    if (!PURPOSES[purpose]) throw invalid("purpose must be one of: " + Object.keys(PURPOSES).join(", ") + ".");
    var source = args.source || (purpose === "edit" ? "selection" : "all_visible");
    if (SOURCES.indexOf(source) < 0) throw invalid("source must be one of: " + SOURCES.join(", ") + ".");
    if ((purpose === "edit" || purpose === "expand") && !args.model_id) throw invalid("model_id is required for " + purpose + ": the capture is shaped for that model.");
    if (source === "layer" && purpose === "reference" && args.layer_id === undefined) {
      // the active layer
    }
    var docId = o.scope.readDoc(args.document_id);
    var lctx = await contextFor(docId, args.layer_id);
    if (source !== "selection") {
      lctx.selection = null;
      lctx.selection_raw = null;
    } else if (!lctx.selection) {
      throw invalid(lctx.selection_raw ? "The selection is outside the canvas." : "There is no selection. Make one with set_selection, or use another source.");
    }
    var rec = { capture_id: null, purpose: purpose, document_id: docId, document_title: lctx.doc.title, session: ctx.session, client_name: ctx.client_name, created_at: o.now(), parts: {}, notes: [] };
    if (purpose === "reference") {
      var maxLong = args.max_px ? Math.min(Math.max(64, args.max_px), 4096) : undefined;
      var r = await o.references.capture(source === "selection" ? "selection" : source === "layer" ? "layer" : "visible", docId, args.model_id || null, maxLong, args.layer_id || null);
      rec.capture_id = "cap-ref-" + r.id;
      rec.parts.reference = { bytes: r.bytes, ext: r.ext, width: r.width, height: r.height, input: null };
      rec.lane = "image";
      rec.model_id = args.model_id || null;
      rec.box = null;
      rec.reduced = r.reduced ? { from: null, to: [r.width, r.height] } : null;
      captures[rec.capture_id] = rec;
      o.approvals.record({ client_name: ctx.client_name, what: "Captured a reference", detail: r.label });
      return {
        capture_id: rec.capture_id,
        box: null,
        scale: null,
        size: [r.width, r.height],
        parts: ["reference"],
        capture_input: null,
        mask_coverage: null,
        feathered: null,
        generated_size: null,
        resolution_ratio: null,
        expand_route: null,
        notes: r.reduced ? ["Reduced to " + r.width + " x " + r.height + " to fit Scenario's upload limit."] : []
      };
    }
    var schema = await o.catalog.schema(args.model_id || common.defaultModel(PURPOSES[purpose]));
    var view = viewFor(purpose, schema, lctx, args);
    if (view.blocked) throw invalid(view.blocked);
    var cap = await o.capture[view.capture.kind](view.capture.spec);
    rec.capture_id = cap.id;
    rec.lane = PURPOSES[purpose];
    rec.model_id = schema.model_id;
    rec.view = view;
    rec.memo = cap.memo;
    rec.reduced = cap.reduced;
    for (var i = 0; i < cap.files.length; i++) {
      var f = cap.files[i];
      rec.parts[partName(f)] = { bytes: f.bytes, ext: f.ext, width: f.width, height: f.height, input: f.input };
    }
    rec.box = view.request.target.box || null;
    captures[rec.capture_id] = rec;
    var t = view.request.target;
    var maskCov = null;
    var ck = cap.memo && cap.memo.check;
    if (ck && ck.mask && ck.mask.data && view.mask) {
      var sum = 0;
      for (var p = 0; p < ck.mask.data.length; p++) sum += ck.mask.data[p];
      maskCov = Math.round((sum / (255 * ck.mask.data.length)) * 1000) / 1000;
    }
    var gen = t.upload ? [t.upload[0], t.upload[1]] : null;
    var boxW = t.box ? t.box[2] : null;
    o.approvals.record({ client_name: ctx.client_name, what: "Captured for " + purpose, detail: view.source ? view.source.text : null });
    return {
      capture_id: rec.capture_id,
      box: t.box || null,
      scale: view.sizes && view.sizes.scale !== undefined ? view.sizes.scale : null,
      size: t.box ? [t.box[2], t.box[3]] : null,
      parts: Object.keys(rec.parts),
      capture_input: schema.capture_input_name || null,
      mask_coverage: maskCov,
      feathered: purpose === "edit" ? (t.feather || 0) > 0 : null,
      generated_size: gen,
      resolution_ratio: gen && boxW ? Math.round((gen[0] / boxW) * 1000) / 1000 : null,
      expand_route: purpose === "expand" ? schema.expand_route || null : null,
      parameters: paramsShown(view.request.parameters, schema),
      notes: view.notes.slice()
    };
  }

  // The parameters the capture sets (sizes and presets), which estimate_cost
  // keeps unless the agent passes its own.
  function paramsShown(params, schema) {
    var out = {};
    for (var k in params) if (k !== schema.prompt_input) out[k] = params[k];
    return out;
  }

  function captureOf(id, ctx) {
    var c = Object.prototype.hasOwnProperty.call(captures, id) ? captures[id] : null;
    if (!c) throw invalid("No capture " + id + " in this Photoshop session. Call capture_reference again.");
    return c;
  }

  // estimate_cost with capture_id: the capture's request with the agent's
  // parameters over the ones the capture set. File inputs the agent passes
  // as asset ids are not priced by stand-in.
  async function captureRequest(args, schema) {
    var c = captureOf(args.capture_id);
    if (c.purpose === "reference") throw invalid("A reference capture binds no target: pass its uploaded asset id in parameters, with canvas or new_document.");
    o.scope.readDoc(c.document_id);
    if (args.lane !== c.lane) throw invalid("This capture was made for the " + c.lane + " lane.");
    if (args.model_id !== c.model_id) throw invalid("This capture was shaped for " + c.model_id + ". Capture again for this model.");
    var base = copy(c.view.request);
    var merged = copy(base.parameters) || {};
    var given = args.parameters || {};
    for (var k in given) merged[k] = given[k];
    // The capture's parts already uploaded with upload_reference fill their
    // file inputs: the capture image first in a list input, then the
    // agent's own references.
    var filled = {};
    for (var pn in c.parts) {
      var part = c.parts[pn];
      var aid = part && part.input ? uploadedFor(c.capture_id, pn) : null;
      if (!aid) continue;
      var fi = null;
      for (var f = 0; f < schema.file_inputs.length; f++) if (schema.file_inputs[f].name === part.input) fi = schema.file_inputs[f];
      if (fi && fi.multiple) {
        var extra = given[part.input];
        extra = Array.isArray(extra) ? extra : given[part.input] ? [given[part.input]] : [];
        merged[part.input] = [aid].concat(extra.filter(function (x) {
          return x !== aid;
        }));
      } else {
        merged[part.input] = aid;
      }
      filled[part.input] = true;
    }
    var req = requests.build(schema, { lane: c.lane, model_id: c.model_id, parameters: merged, takes: args.takes === undefined || args.takes === null ? base.takes : args.takes, target: base.target, source_size: base.source_size, mask: base.mask, trained: !!(merged.loras || merged.modelId) });
    for (var name in req.pending) if (filled[name] || (given[name] !== undefined && given[name] !== null && !(Array.isArray(given[name]) && !given[name].length))) delete req.pending[name];
    req.capture_id = c.capture_id;
    return req;
  }

  // The asset id of a capture part this plugin uploaded, once imported.
  function uploadedFor(captureId, part) {
    for (var id in refs) {
      var r = refs[id];
      if (r.capture_id === captureId && r.part === part && r.state === "imported" && r.asset_id) return r.asset_id;
    }
    return null;
  }

  function requireConsentCard(session, key, ctx, label, run, decline) {
    if (consents[session] && consents[session][key]) return false;
    o.approvals.add({
      kind: "upload",
      session: session,
      client_name: ctx.client_name,
      title: ctx.client_name + " asks to upload",
      lines: ["Allow " + ctx.client_name + " to send pixels from " + label + " to Scenario for this session?"],
      approve_label: "Allow",
      decline_label: "Deny",
      data: { key: key },
      onApprove: function () {
        if (!consents[session]) consents[session] = {};
        consents[session][key] = true;
        o.approvals.record({ client_name: ctx.client_name, what: "Uploads allowed", detail: label });
        run();
      },
      onDecline: function (why) {
        decline(why);
      }
    });
    return true;
  }

  function uploadName(kind, id, ext) {
    var d = new Date(o.now());
    var p = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    return "photoshop-" + kind + "-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + String(id).replace(/[^A-Za-z0-9]/g, "").slice(-8) + "." + (ext === "jpg" ? "jpg" : "png");
  }

  function startUpload(id) {
    var r = refs[id];
    r.state = "uploading";
    Promise.resolve()
      .then(function () {
        return assetsMod.uploadImage(o.client, r.bytes, uploadName(r.part === "mask" ? "mask" : r.part === "reference" ? "reference" : "capture", r.id, r.ext));
      })
      .then(
        function (u) {
          r.state = "imported";
          r.asset_id = u.asset_id;
          r.bytes = null;
          o.approvals.record({ client_name: r.client_name, what: "Uploaded " + r.part, detail: r.label });
        },
        function (e) {
          r.state = "failed";
          r.error = ((e && e.type) || "Internal") + ": " + ((e && e.message) || e);
          r.bytes = null;
          log("agents: an upload failed (" + ((e && e.type) || "error") + ")");
        }
      );
  }

  // upload_reference.
  async function uploadReference(args, ctx) {
    if (o.settings.noSpend()) throw fail("NoSpend", "No-spend mode is on. Nothing was uploaded.");
    if (!o.account()) throw fail("NotSignedIn", "No Scenario key is saved in the plugin.");
    var items = [];
    var key;
    var label;
    if (args.capture_id) {
      var c = captureOf(args.capture_id);
      o.scope.readDoc(c.document_id, "upload");
      var parts = args.parts && args.parts.length ? args.parts : Object.keys(c.parts);
      for (var i = 0; i < parts.length; i++) {
        var pp = c.parts[parts[i]];
        if (!pp) throw invalid("This capture has no " + parts[i] + " part; it has " + Object.keys(c.parts).join(", ") + ".");
        items.push({ part: parts[i], bytes: pp.bytes, ext: pp.ext, width: pp.width, height: pp.height, existing: c.uploads && c.uploads[parts[i]] });
      }
      key = "doc:" + c.document_id;
      label = c.document_title ? c.document_title : "this document";
    } else if (args.path) {
      var f = await fileFor(String(args.path));
      items.push({ part: "reference", bytes: f.bytes, ext: f.ext, width: f.width, height: f.height, existing: null });
      key = f.key;
      label = f.label;
    } else {
      throw invalid("Pass capture_id or path.");
    }
    var out = { reference_ids: {}, state: null, asset_ids: {}, reduced: null };
    var fresh = [];
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      // The same capture part is uploaded once; a failed or declined one
      // may go again.
      if (it.existing && refs[it.existing] && ["failed", "declined"].indexOf(refs[it.existing].state) < 0) {
        out.reference_ids[it.part] = it.existing;
        continue;
      }
      var id = newRef();
      refs[id] = { id: id, part: it.part, capture_id: args.capture_id || null, path: args.path || null, session: ctx.session, client_name: ctx.client_name, state: "awaiting_approval", asset_id: null, error: null, bytes: it.bytes, ext: it.ext, label: label };
      if (args.capture_id) {
        var cc = captures[args.capture_id];
        cc.uploads = cc.uploads || {};
        cc.uploads[it.part] = id;
      }
      out.reference_ids[it.part] = id;
      fresh.push(id);
    }
    if (fresh.length) {
      var waiting = requireConsentCard(
        ctx.session,
        key,
        ctx,
        label,
        function () {
          for (var k = 0; k < fresh.length; k++) if (refs[fresh[k]].state === "awaiting_approval") startUpload(fresh[k]);
        },
        function (why) {
          for (var k = 0; k < fresh.length; k++) {
            var r = refs[fresh[k]];
            if (r.state !== "awaiting_approval") continue;
            r.state = "declined";
            r.bytes = null;
            r.error = why === "declined" ? "UploadDeclined: the person denied the upload." : "UploadDeclined: the upload card expired" + (why === "session" ? " when this client's session ended." : ".");
          }
        }
      );
      if (!waiting) {
        for (var s = 0; s < fresh.length; s++) startUpload(fresh[s]);
      } else {
        o.approvals.record({ client_name: ctx.client_name, what: "Asked to upload", detail: label });
      }
    }
    var states = [];
    for (var part in out.reference_ids) {
      var rr = refs[out.reference_ids[part]];
      states.push(rr.state);
      if (rr.asset_id) out.asset_ids[part] = rr.asset_id;
    }
    out.state = states.indexOf("awaiting_approval") >= 0 ? "awaiting_approval" : states.indexOf("uploading") >= 0 ? "uploading" : states.indexOf("failed") >= 0 ? "failed" : states.indexOf("declined") >= 0 ? "declined" : "imported";
    return out;
  }

  // A file an agent may upload: a result the plugin saved (by its path in
  // the Output Folder, as the ledger records it) or a file the person
  // chose in the panel this session (by its name).
  async function fileFor(path) {
    if (/(^|[\\/])\.\.([\\/]|$)/.test(path) || /^[\\/]|^[A-Za-z]:|^~|^[a-z]+:/.test(path)) throw fail("UploadRefused", "This path was not chosen by the person or made by the plugin.");
    if (Object.prototype.hasOwnProperty.call(chosen, path)) {
      var ch = chosen[path];
      return { bytes: ch.bytes, ext: ch.ext, width: ch.width, height: ch.height, key: "file:" + path, label: path };
    }
    var list = o.ledger.all();
    for (var i = 0; i < list.length; i++) {
      var outs = list[i].outputs || [];
      for (var k = 0; k < outs.length; k++) {
        if (outs[k].path !== path || outs[k].state !== "saved") continue;
        if (!o.scope.jobVisible(list[i])) throw fail("DocumentNotAllowed", "Agents read the active document only: this result belongs to another document's job.");
        var bytes = await o.host.readDataBinary(path);
        if (!bytes) throw fail("UploadRefused", "The saved result is missing from the Output Folder.");
        var info = png.isPng(bytes) ? png.pngInfo(bytes) : jpeg.isJpeg(bytes) ? jpeg.jpegInfo(bytes) : null;
        if (!info) throw fail("UploadRefused", "Only PNG and JPEG results can be uploaded.");
        var stripped = png.isPng(bytes) ? png.stripPng(bytes).bytes : jpeg.stripJpeg(bytes).bytes;
        return { bytes: stripped, ext: png.isPng(bytes) ? "png" : "jpg", width: info.width, height: info.height, key: "result:" + path, label: "the saved result " + path.split("/").pop() };
      }
    }
    throw fail("UploadRefused", "This path was not chosen by the person or made by the plugin.");
  }

  function referenceStatus(args, ctx) {
    var r = Object.prototype.hasOwnProperty.call(refs, args.reference_id) ? refs[args.reference_id] : null;
    if (!r) throw invalid("No upload " + args.reference_id + " in this Photoshop session.");
    return { state: r.state, asset_id: r.asset_id, error: r.error };
  }

  // SPEC 2.6: consents and waiting uploads end with their session.
  function endSessions(ids) {
    for (var i = 0; i < ids.length; i++) delete consents[ids[i]];
  }

  return {
    captureReference: captureReference,
    captureRequest: captureRequest,
    uploadReference: uploadReference,
    referenceStatus: referenceStatus,
    endSessions: endSessions,
    // A capture the ledger links to a job (generate), or null.
    capture: function (id) {
      return Object.prototype.hasOwnProperty.call(captures, id) ? captures[id] : null;
    },
    // The panel records each file the person chooses (by name, this session).
    chose: function (name, file) {
      if (name) chosen[String(name)] = file;
    },
    // Uploads of the plugin's own (never listed as Library assets).
    uploadedAssetIds: function () {
      var out = [];
      for (var id in refs) if (refs[id].asset_id) out.push(refs[id].asset_id);
      return out;
    }
  };
}

module.exports = { createInputs: createInputs, PURPOSES: PURPOSES };
