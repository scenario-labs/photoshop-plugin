"use strict";
// The creation panel's logic (FLOWS v2, SPEC 3), without the DOM: it reads
// what Photoshop has (no document, a layer, a cut-out layer, a selection, a
// Scenario takes group), offers the context's actions, keeps the composer's
// choices, prices the selected action 400 ms after the last change, and on
// Generate builds the request again from the document as it is, so a change
// since the price check makes the quote mismatch and nothing is spent (SPEC
// 6). Results land through the runner (jobs/runner.js); the Takes card
// shows, keeps and refines them from the layers' own metadata, after a
// restart too. ui/create-view.js draws model() and calls the actions here.
//
// o: { host, catalog, quotes, flow (lanes/flow.js), runner, ledger,
//      references (capture/references.js), account() -> {id} | null,
//      settings, jobsModel, session, timers, log, urls (ui/thumbs.js) }

var builtinMod = require("../util/builtin.js");
var clipMod = require("../util/clip.js");
var slugMod = require("../util/slug.js");
var actionsMod = require("./actions.js");
var imageMod = require("./image.js");
var docRefsMod = require("./doc-refs.js");
var contextMod = require("../lanes/context.js");
var commonMod = require("../lanes/common.js");
var enhanceMod = require("../lanes/enhance.js");
var map = require("../catalog/map.js");
var trainedMod = require("../catalog/trained.js");
var trainedPanel = require("./trained.js");
var requests = require("../forms/requests.js");
var schemaMod = require("../forms/schema.js");
var price = require("../forms/price.js");
var thumbs = require("../ui/thumbs.js");
var pngMod = require("../util/png.js");
var errorsMod = require("../scenario/errors.js");
var sparkMod = require("../scenario/spark.js");
var moreLanes = require("../lanes/more.js");
var libraryMod = require("./library.js");

var A = actionsMod.ACTIONS;
var TAKES_PRICE_MS = 2500;
var DEBOUNCE_MS = 400;
var PINS_FILE = "panel-pins.json";
var RUNNING = ["uploading_inputs", "submitting", "queued", "generating", "cancel_requested", "succeeded", "downloading", "applying"];
var FAILED = ["failed", "blocked", "canceled", "not_sent", "download_failed", "apply_failed", "uncertain"];
var TARGETS = [
  { key: "16:9", label: "16:9" },
  { key: "4:5", label: "4:5" },
  { key: "1:1", label: "1:1" },
  { key: "9:16", label: "9:16" },
  { key: "3:2", label: "3:2" },
  { key: "+20", label: "+20%", sub: "Grows every side", sides: true }
];
var TAKES = [1, 2, 3, 4];
var CHANGE = [
  { label: "Subtle", at: 0.15 },
  { label: "Light", at: 0.35 },
  { label: "Balanced", at: 0.55 },
  { label: "Strong", at: 0.75 },
  { label: "Free", at: 0.95 }
];

var TEXT = {
  // A model the panel cannot give the layer to (its schema has no image
  // input the plugin knows): offered nowhere, refused from All models.
  no_layer_input: function (name, action) {
    return name + " can't take the layer, so it can't " + String(action || "run here").toLowerCase() + " in this version of the plugin.";
  },
  need_prompt: "Fill in the prompt to see the price",
  checking: "Checking the price",
  sending: "Sending",
  not_signed_in: "Sign in to see prices.",
  alarm: "A price check created a job on Scenario. Price checks are stopped until Photoshop restarts.",
  after_upload: "This model is priced once its files are uploaded.",
  changed: "The document or the settings changed since the price check. Check the new price, then click again.",
  replayed: "This price was already used: see Jobs.",
  no_mask: "This run's layers have no mask to load as the selection.",
  layers_gone: "This run's layers are no longer in the document.",
  styles_note: "Trained styles are the project's trained models and run on the model they were trained on. Match an image uses a picture as the style reference, with any model.",
  styles_note_image: "Match an image uses a picture as the style reference, with any model.",
  base_note: "A trained style runs on the model it was trained on. Pick No style or Match an image in the Style chip to use another model.",
  match_note: "The picture goes with the run as its style reference; the prompt and the chips stay in charge.",
  ref_hint: "Selection, layer or file",
  // Replace inside with a reference (SPEC 3.7, refs row): a
  // reference of the whole scene is drawn into the selection as it is.
  replace_ref_note: "Use an object or a style as the reference. A whole scene can be copied in.",
  empty_mid: "Takes and recent runs on this document show here.",
  declined: "Declined. The agent was told, and nothing was spent.",
  need_select: "Type what to select",
  frame_next: "Animate starts from the new frame layer: describe the next motion."
};
var FORMAT_KEYS = ["9:16", "4:5", "1:1", "16:9"];

// Sent after the prompt when the Style chip is on Match an image; the style
// picture is always the last reference image of the run.
var STYLE_SENTENCE = "Use the last reference image for its style only (colors, rendering, texture), not for its content.";
var QUALITY = [
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"]
];

function invalid(text) {
  return new errorsMod.ScenarioError("InvalidParameter", text);
}

function times(w, h) {
  return Math.round(w) + " × " + Math.round(h);
}

function laneOf(id) {
  var a = A[id];
  if (!a || !a.family) return null;
  if (a.family === "cutout") return "remove_background";
  if (a.family === "tool") return moreLanes.LANE[a.tool] || null;
  return a.family;
}

// A run's short name: its prompt, else what it was.
function runName(prompt, kind) {
  var named = builtinMod.nameOf(prompt);
  if (named) return named;
  var p = String(prompt || "").trim();
  if (p) return clipMod.clip(p, 60);
  var KINDS = { edit: "Edit", cutout: "Cut out", upscale: "Upscale", expand: "Extend canvas", video: "Animate" };
  return KINDS[kind] || "Image";
}

// The context title of a layer: its own name, except a Scenario result
// still under the name the plugin gave it ("Take 1 NfpUm8", "Scenario image
// kite NfpUm8"), which reads in plain words ("Take 1 of A paper kite"); the
// id tail stays in the tooltip. A layer the person renamed keeps its name.
function layerTitle(name, fields) {
  var n = String(name || "");
  if (!fields || !fields.assetId) return n;
  var t = slugMod.tail(fields.assetId);
  if (!t || n.slice(-t.length - 1) !== " " + t) return n;
  var run = runName(fields.runName || fields.prompt, fields.kind);
  var take = /^Take (\d+) /.exec(n);
  if (take) return "Take " + take[1] + " of " + run;
  if (/^Scenario /.test(n)) return run;
  return n;
}

// The takes a layer's metadata describes (the results model): a Scenario
// group holding takes, or one Scenario result layer outside a group.
// meta: host.scenarioLayer(). Returns null for anything else.
function takesOf(meta) {
  if (!meta || !meta.fields) return null;
  var f = meta.fields;
  var gen = function (k) {
    return k === "image" || k === "edit";
  };
  if (meta.group) {
    // The group's own takes: a Scenario layer of another run dropped into
    // the group is not one, nor is a copy of a take (the higher layer id of
    // two with one asset id; host.js takeIdsOf).
    var first = {};
    (meta.children || []).forEach(function (c) {
      if (!c.fields || !c.fields.assetId || c.fields.jobId !== f.jobId || slugMod.isTakeCopy(c.name, c.fields)) return;
      var a = c.fields.assetId;
      if (!first[a] || c.id < first[a].id) first[a] = c;
    });
    var kids = (meta.children || []).filter(function (c) {
      return c.fields && first[c.fields.assetId] === c;
    });
    if (!f.jobId || !gen(f.kind) || !kids.length) return null;
    return { group_id: meta.id, layer_id: null, job_id: f.jobId, kind: f.kind, name: meta.name, prompt: f.runName || f.prompt || null, model_name: f.modelName || null, children: kids };
  }
  if (meta.parent || !f.assetId || !f.jobId || !gen(f.kind)) return null;
  return { group_id: null, layer_id: meta.id, job_id: f.jobId, kind: f.kind, name: meta.name, prompt: f.runName || f.prompt || null, model_name: f.modelName || null, children: [{ id: meta.id, name: meta.name, visible: true, fields: f }] };
}

// A layer with transparency (a cut-out subject): a pixel or smart object
// layer with a mask, or one that covers less of the canvas than all of it.
// Scenario results count only when they are cut-outs (Cut out subject).
function isCutout(layer, doc, meta) {
  if (!layer || !doc || layer.background) return false;
  if (meta && meta.fields && meta.fields.assetId && meta.fields.kind !== "cutout") return false;
  if (layer.kind !== "pixel" && layer.kind !== "smartObject") return false;
  if (layer.has_mask) return true;
  var b = layer.bounds;
  if (!b || !(b.width > 0 && b.height > 0)) return false;
  var x0 = Math.max(0, b.left);
  var y0 = Math.max(0, b.top);
  var x1 = Math.min(doc.width, b.left + b.width);
  var y1 = Math.min(doc.height, b.top + b.height);
  var area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return area < 0.97 * doc.width * doc.height;
}

// raw: lanes/context.read(); meta: the active layer's Scenario metadata.
function classify(raw, meta) {
  if (!raw || !raw.doc) return { kind: "none", run: null };
  if (raw.selection || raw.selection_raw) return { kind: "selection", run: null };
  var run = takesOf(meta);
  if (run) return { kind: "takes", run: run };
  // A layer made by Split into layers has its own actions.
  if (raw.layer && meta && meta.fields && meta.fields.kind === "split-element") return { kind: "element", run: null };
  if (isCutout(raw.layer, raw.doc, meta)) return { kind: "cutout", run: null };
  // A document of one Background layer: a delivered or generated JPEG or
  // PNG, opened as it is.
  if (raw.layer && raw.layer.background && raw.doc.layers === 1) return { kind: "flat", run: null };
  return { kind: "layer", run: null };
}

// The text of a failure for the panel. Photoshop's own refusal while
// another modal operation runs ("host is in a modal state", live
// 2026-10-21) reads as one plain line.
var BUSY_LINE = "Photoshop is busy. Try again in a moment.";
function errText(e) {
  var m = (e && e.message) || String(e);
  if ((e && e.busy) || /modal state/i.test(m)) return BUSY_LINE;
  return m;
}

function badgeOf(list) {
  list = list || [];
  for (var i = 0; i < list.length; i++) if (/misaligned|Changed outside|Unchanged inside/.test(list[i])) return { tone: "warn", text: "May not line up" };
  for (var j = 0; j < list.length; j++) if (/may be unchanged/.test(list[j])) return { tone: "warn", text: "Part unchanged" };
  // Edges a person can see in the composite (2026-10-21): a patch at the
  // selection edge, a step or a repeated detail at Extend's old edge.
  for (var e = 0; e < list.length; e++) if (/patch at the selection edge|Step at the old edge|Repeated detail/.test(list[e])) return { tone: "warn", text: "Edge may show" };
  for (var s = 0; s < list.length; s++) if (/spills past/.test(list[s])) return { tone: "warn", text: "Spills past" };
  for (var k = 0; k < list.length; k++) if (/Seam ok/.test(list[k])) return { tone: "ok", text: "Edges ok" };
  return null;
}

// The price a run card shows: what was charged, else the price waiting for
// approval (a price that changed after the upload, New angle 1 to 6 CU
// live), else the quote.
function cuOf(rec) {
  if (!rec) return null;
  var has = function (v) {
    return v !== null && v !== undefined && v !== "";
  };
  if (has(rec.cu_charged)) return rec.cu_charged;
  if (has(rec.cu_quoted_new)) return rec.cu_quoted_new;
  return has(rec.cu_quoted) ? rec.cu_quoted : null;
}

function needsConfirm(q, limit) {
  if (q.price_kind === "from") return true;
  var compare = q.price_kind === "range" && q.cu_cost_max !== null && q.cu_cost_max !== undefined ? price.toThousandths(q.cu_cost_max) : price.toThousandths(q.cu_cost);
  return compare > limit;
}

function createController(o) {
  var log = o.log || function () {};
  var timers = o.timers || { setTimeout: setTimeout, clearTimeout: clearTimeout };
  var urls = o.urls || thumbs.createUrls(null);
  var listeners = [];
  var st = {
    active: false,
    raw: null,
    meta: null,
    ctx: { kind: "none", run: null },
    key: "",
    action: "create",
    keepAction: false,
    prompt: "",
    takes: {},
    models: {},
    style: null,
    styleRef: null,
    size: imageMod.DEFAULT_SIZE,
    target: "16:9",
    factor: null,
    change: 2,
    adv: {},
    refs: [],
    drefs: [],
    drefsDoc: null,
    drefOff: {},
    price: { state: "idle" },
    seq: 0,
    timer: null,
    sending: false,
    confirm: null,
    note: "",
    latest: {},
    repriced: null,
    done: {},
    // Runs an earlier panel session placed in a document, found again by
    // their layers' metadata: { <document id>: { <local id>: true|false } }.
    placedSeen: {},
    card: null,
    startFrom: null,
    pins: {},
    styles: null,
    // M7: the trained model picked in the Model menu (Run with), stacked
    // with a trained style on one base when both fit (panel/trained.js);
    // the schemas of the bases trained models run on.
    runWith: null,
    bases: null,
    agent: null,
    reading: null,
    again: false,
    schemaCache: {},
    // Suggest (Prompt Spark): the proposals for one action, model and
    // prompt; shortName is the person's short prompt while a proposal fills
    // the prompt box (the run keeps it as its name).
    spark: null,
    shortName: null,
    // The later flows' chips: New angle's preset, the Formats placement,
    // Animate's duration; the Select… field's text; the clip Frame to layer
    // reads (from the Animate card).
    angle: "right45",
    format: "9:16",
    duration: 5,
    selectText: "",
    clip: null,
    // Open from Library and + Reference > Library: the project's images.
    // M7: the search text, the filter (library.js FILTERS), how many tiles
    // show.
    lib: { state: "idle", rows: [], more: false, error: null },
    libPick: false,
    libQuery: "",
    libFilter: "all",
    libShown: libraryMod.SHOWN,
    // F14: an agent's multi-step plan, shown only while one waits.
    plan: null
  };

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i]();
      } catch (e) {
        log("panel: a view failed to draw (" + ((e && e.message) || e) + ")");
      }
    }
  }

  function docId() {
    return st.raw && st.raw.doc ? st.raw.doc.id : null;
  }

  function layerName() {
    if (st.raw && st.raw.layer) return st.raw.layer.name;
    return "the canvas";
  }

  function takesFor(id, n) {
    if (n) return n;
    if (st.takes[id]) return st.takes[id];
    return (A[id] && A[id].takes) || 1;
  }

  function defaultModel(lane) {
    var d = map.defaults(lane);
    return d ? d.model_id : null;
  }

  // The defaults entry of an action: its model_lane (Replace inside,
  // Remove), else its lane.
  function modelLane(id) {
    return (A[id] && A[id].model_lane) || laneOf(id);
  }

  // An action with its own model or its own defaults entry keeps the
  // person's choice for itself; the others share their lane's.
  function modelKey(id) {
    return A[id] && A[id].model ? "a:" + id : modelLane(id);
  }

  function defaultFor(id) {
    return A[id] && A[id].model ? A[id].model : defaultModel(modelLane(id));
  }

  // The Edit chip (Replace inside): Bolder when the model grows its mask.
  function editOn(id) {
    return !!(A[id] && (A[id].chips || []).indexOf("edit") >= 0 && !trainedRun(id));
  }

  function editMode(id) {
    var m = modelFor(id);
    return m && schemaMod.modelFacts(m).mask_growth ? "bolder" : "inside";
  }

  // Sets the Edit chip: Bolder runs its model, Inside selection the
  // action's recommended one; a model already of that kind is kept.
  function setEditMode(id, mode) {
    if (!editOn(id) || editMode(id) === mode) return;
    if (mode === "bolder") st.models[modelKey(id)] = actionsMod.EDIT_MODES.bolder.model;
    else delete st.models[modelKey(id)];
    st.runWith = null;
  }

  // over: { runWith } prices another Run with choice than the current one
  // (the Model menu's trained rows); left out, the current choices.
  function modelFor(id, over) {
    var lane = laneOf(id);
    if (!lane) return null;
    var tr = trainedRun(id, over);
    if (tr) return tr.base_model_id;
    return st.models[modelKey(id)] || defaultFor(id);
  }

  function styleApplies(id) {
    return !!(st.style && !st.style.match && trainedPanel.fits(A[id], st.style));
  }

  function runWithOf(over) {
    return over && Object.prototype.hasOwnProperty.call(over, "runWith") ? over.runWith : st.runWith;
  }

  // The trained models this run applies and the base that runs them, or
  // null (panel/trained.js). over false: none (a model picked by id).
  function trainedRun(id, over) {
    if (over === false) return null;
    return trainedPanel.resolve(A[id], st.style, runWithOf(over), st.bases || []);
  }

  // Match an image: the style picture goes with every action that has the
  // Style chip and takes reference images.
  function matchOn(id) {
    return !!(st.style && st.style.match && st.styleRef && A[id] && (A[id].chips || []).indexOf("style") >= 0 && (A[id].refs || A[id].autoRef));
  }

  // The Change chip shows on the actions that list it (Make versions) when
  // the run has a strength control: the trained image + strength route, or
  // an edit model with a strength input. GPT Image 2.5 has none.
  function changeOn(id, schema) {
    var a = A[id];
    if (!a || a.family !== "edit" || (a.chips || []).indexOf("change") < 0) return false;
    var tr = trainedRun(id);
    if (tr) return tr.route === "image_strength";
    return !!(schema && commonMod.param(schema, "strength"));
  }

  function promptOf(id, over) {
    if (A[id] && A[id].prompt === "field") return String(st.selectText || "").trim() || null;
    var t = actionsMod.promptFor(id, st.prompt);
    if (t && matchOn(id)) t = t + " " + STYLE_SENTENCE;
    // Trained models: their trigger words go in front (Advanced turns it off).
    return trainedPanel.withTriggers(t, trainedRun(id, over), st.adv);
  }

  // GPT Image 2.5 and other models with a Low / Medium / High quality
  // input: Medium unless the person picks another level (Advanced).
  function qualityOf(schema, id) {
    var q = schema ? commonMod.param(schema, "quality") : null;
    if (!q || !q.enum) return null;
    for (var i = 0; i < QUALITY.length; i++) if (q.enum.indexOf(QUALITY[i][0]) < 0) return null;
    // Render sketch starts at High (FLOWS v2, changes after review 9).
    return st.adv.quality || (A[id || st.action] && A[id || st.action].quality) || "medium";
  }

  function schemaFor(modelId) {
    if (!modelId) return Promise.reject(invalid("No model for this action."));
    return o.catalog.schema(modelId).then(function (s) {
      st.schemaCache[modelId] = s;
      return s;
    });
  }

  // ---- the run the Takes card acts on ----

  function recordOf(run) {
    if (!run || !o.ledger) return null;
    if (run.local_id) return o.ledger.get(run.local_id);
    if (run.job_id && typeof o.ledger.findByJobId === "function") return o.ledger.findByJobId(run.job_id) || null;
    return null;
  }

  function cardRun() {
    if (st.ctx.kind === "takes") return st.ctx.run;
    return st.card;
  }

  function maskLayerOf(run) {
    return run ? run.group_id || run.layer_id : null;
  }

  // The run's capture box from its layers' metadata ("left,top,width,height"),
  // the box its mask was made for.
  function boxOf(run) {
    var kids = (run && run.children) || [];
    for (var i = 0; i < kids.length; i++) {
      var v = kids[i].fields && kids[i].fields.captureBox;
      var n = v ? String(v).split(",").map(Number) : [];
      if (n.length === 4 && n.every(isFinite) && n[2] > 0 && n[3] > 0) return { left: n[0], top: n[1], width: n[2], height: n[3] };
    }
    return null;
  }

  function shownChild(run) {
    if (!run || !run.children.length) return null;
    for (var i = 0; i < run.children.length; i++) if (run.children[i].visible) return { i: i, child: run.children[i] };
    return { i: 0, child: run.children[0] };
  }

  function wasMasked(rec) {
    return !!(rec && rec.lane === "edit" && rec.target && rec.target.kind === "selection");
  }

  // ---- reading Photoshop ----

  // A run is in the document when the layer its placement names carries its
  // job id or one of its result asset ids.
  function layerOfRun(meta, rec) {
    if (!meta || !rec) return false;
    var assets = (rec.outputs || []).map(function (x) {
      return x && x.asset_id;
    });
    var f = meta.fields || {};
    if (rec.job_id && f.jobId === rec.job_id) return true;
    if (f.assetId && assets.indexOf(f.assetId) >= 0) return true;
    var kids = meta.children || [];
    for (var i = 0; i < kids.length; i++) if (kids[i].fields && kids[i].fields.assetId && assets.indexOf(kids[i].fields.assetId) >= 0) return true;
    return false;
  }

  // Recent after the panel reloads while Photoshop keeps running (a plugin
  // reload, the development loop): the session marker is new, and a
  // document that was never saved has no file to match, so the runs placed
  // in it are found again from their layers, once per document and run.
  async function findEarlierRuns(docId) {
    if (!o.ledger || typeof o.host.scenarioLayer !== "function") return;
    var seen = st.placedSeen[docId] || (st.placedSeen[docId] = {});
    var all = o.ledger.all();
    var reads = 0;
    for (var i = 0; i < all.length && reads < 12; i++) {
      var r = all[i];
      if (r.state !== "applied" || !r.placement || r.session === o.session || r.placement.document_id !== docId) continue;
      if (Object.prototype.hasOwnProperty.call(seen, r.local_id)) continue;
      var at = r.placement.group_id || (r.placement.layer_ids || [])[0];
      reads++;
      var m = null;
      try {
        m = at ? await o.host.scenarioLayer(docId, at) : null;
      } catch (e) {
        m = null;
      }
      seen[r.local_id] = layerOfRun(m, r);
    }
  }

  async function readContext() {
    var raw = await contextMod.read(o.host);
    if (raw.doc) await findEarlierRuns(raw.doc.id);
    var meta = null;
    if (raw.doc && raw.layer && typeof o.host.scenarioLayer === "function") meta = await o.host.scenarioLayer(raw.doc.id, raw.layer.id);
    var ctx = classify(raw, meta);
    // The document's latest run from this panel: its Takes card shows in
    // every context of the document until the person closes it.
    var card = null;
    if (raw.doc && ctx.kind !== "takes") {
      var lid = st.latest[raw.doc.id];
      var rec = lid && o.ledger ? o.ledger.get(lid) : null;
      if (rec && !st.done[lid]) {
        if (rec.state === "applied" && rec.placement && typeof o.host.scenarioLayer === "function") {
          var at = rec.placement.group_id || (rec.placement.layer_ids || [])[0];
          var m = at ? await o.host.scenarioLayer(raw.doc.id, at) : null;
          card = takesOf(m);
          if (card) card.local_id = lid;
          else card = { local_id: lid, other: true, children: [] };
        } else card = { local_id: lid, other: true, children: [] };
      }
    }
    if (ctx.run) {
      var r = recordOf(ctx.run);
      if (r) ctx.run.local_id = r.local_id;
    }
    return { raw: raw, meta: meta, ctx: ctx, card: card };
  }

  function keyOf(raw, ctx) {
    if (!raw || !raw.doc) return "none";
    var s = raw.selection || raw.selection_raw;
    // The layer's size is in the key: a resized layer can price differently,
    // and an after-upload price for the old size must not stay on the button.
    var lb = raw.layer && raw.layer.bounds;
    return [raw.doc.id, ctx.kind, raw.layer ? raw.layer.id : "-", lb ? Math.round(lb.width) + "x" + Math.round(lb.height) : "-", ctx.run ? maskLayerOf(ctx.run) : "-", s ? [s.left, s.top, s.width, s.height].join(",") : "-", raw.doc.width, raw.doc.height].join("|");
  }

  function contextKind(raw, ctx) {
    return (raw && raw.doc ? raw.doc.id : "-") + "|" + ctx.kind + "|" + (raw && raw.layer ? raw.layer.id : "-");
  }

  async function refresh() {
    if (st.reading) {
      st.again = true;
      return st.reading;
    }
    st.reading = (async function () {
      do {
        st.again = false;
        var got;
        try {
          got = await readContext();
        } catch (e) {
          log("panel: context read failed (" + ((e && e.message) || e) + ")");
          got = { raw: { doc: null }, meta: null, ctx: { kind: "none", run: null }, card: null };
        }
        var before = contextKind(st.raw, st.ctx);
        var prevKey = st.key;
        st.raw = got.raw;
        st.meta = got.meta;
        st.ctx = got.ctx;
        st.card = got.card;
        st.key = keyOf(got.raw, got.ctx);
        if (contextKind(got.raw, got.ctx) !== before) {
          if (st.keepAction) st.keepAction = false;
          else {
            st.action = actionsMod.CONTEXTS[got.ctx.kind][0];
            st.startFrom = null;
            st.prompt = "";
            st.shortName = null;
          }
          st.confirm = st.confirm && st.confirm.kind === "changed" ? st.confirm : null;
        }
        await loadDocRefs();
        if (st.key !== prevKey || st.price.state === "idle") schedule();
        emit();
        refreshThumb();
      } while (st.again);
      st.reading = null;
    })();
    return st.reading;
  }

  // ---- the context card's picture of a layer or a selection ----
  // Read once per document, layer and selection box (96 px on the long side,
  // one read in a modal scope), kept as a blob link; the icon shows until it
  // is ready or when the read fails.
  var THUMB_SIDE = 96;
  var thumb = { key: null, url: null, size: null };

  function thumbKey() {
    var c = st.ctx;
    var raw = st.raw;
    if (!raw || !raw.doc || (c.kind !== "layer" && c.kind !== "cutout" && c.kind !== "selection" && c.kind !== "element" && c.kind !== "flat")) return null;
    var b = thumbBounds();
    if (!b) return null;
    return [raw.doc.id, c.kind === "selection" ? "visible" : raw.layer && raw.layer.id, b.left, b.top, b.width, b.height].join(":");
  }

  function thumbBounds() {
    var raw = st.raw;
    var b = st.ctx.kind === "selection" ? raw.selection || raw.selection_raw : raw.layer && raw.layer.bounds;
    if (!b) return null;
    var left = Math.max(0, b.left);
    var top = Math.max(0, b.top);
    var right = Math.min(raw.doc.width, b.left + b.width);
    var bottom = Math.min(raw.doc.height, b.top + b.height);
    if (!(right - left >= 1 && bottom - top >= 1)) return null;
    return { left: left, top: top, width: right - left, height: bottom - top };
  }

  async function refreshThumb() {
    var key = thumbKey();
    if (!key || key === thumb.key || typeof o.host.readPixels !== "function") return;
    thumb.key = key;
    try {
      var sel = st.ctx.kind === "selection";
      var px = await o.host.readPixels({ document_id: st.raw.doc.id, layer_id: sel ? null : st.raw.layer.id, bounds: thumbBounds(), long_side: THUMB_SIDE, exact: true });
      if (thumb.key !== key) return;
      var url = urls.fromBytes(pngMod.encodePng({ width: px.width, height: px.height, channels: px.components, data: px.data }), "image/png");
      if (thumb.url) urls.release(thumb.url);
      thumb.url = url;
      thumb.size = { width: px.width, height: px.height };
      emit();
    } catch (e) {
      if (thumb.key === key) thumb.key = null;
    }
  }

  function thumbNow() {
    var key = thumbKey();
    return key && key === thumb.key && thumb.url ? thumb : null;
  }

  async function loadDocRefs() {
    var id = docId();
    if (id === st.drefsDoc) return;
    st.drefsDoc = id;
    st.drefs = [];
    st.drefOff = {};
    if (id === null || typeof o.host.documentReferences !== "function") return;
    try {
      st.drefs = await o.host.documentReferences(id);
    } catch (e) {
      st.drefs = [];
    }
  }

  // ---- composer arguments ----

  function drefsOn() {
    var a = A[st.action];
    if (!a || !a.refs) return [];
    return st.drefs.filter(function (r) {
      return !st.drefOff[r.layer_id];
    });
  }

  function takeRefNeeded(id) {
    if (id !== "more_like") return false;
    return wasMasked(recordOf(cardRun()));
  }

  function refCount(id) {
    var a = A[id];
    if (!a) return 0;
    var n = a.refs ? drefsOn().length + st.refs.length : 0;
    if (a.autoRef) n++;
    if (takeRefNeeded(id)) n++;
    if (matchOn(id)) n++;
    return n;
  }

  // The context a run reads: the document as it is, or, for the takes
  // actions, the shown take (Upscale kept take, More like this) or the
  // selection the run was made in (More like this on a selection edit).
  async function contextFor(id) {
    var raw = st.raw;
    var run = cardRun();
    if (!run || (id !== "more_like" && id !== "upscale_kept")) return raw;
    var shown = shownChild(run);
    var rec = recordOf(run);
    if (id === "more_like" && wasMasked(rec) && rec.target.selection) {
      var s = rec.target.selection;
      var sel = { left: s[0], top: s[1], width: s[2], height: s[3] };
      return { doc: raw.doc, selection: sel, selection_raw: sel, layer: raw.layer };
    }
    var info = shown && typeof o.host.layerInfo === "function" ? await o.host.layerInfo(raw.doc.id, shown.child.id) : null;
    return { doc: raw.doc, selection: null, selection_raw: null, layer: info || raw.layer };
  }

  function expandOptions(raw) {
    var t = st.target;
    var opts = { anchor: st.adv.anchor || "center", overlap: commonMod.DEFAULT_OVERLAP };
    if (t === "+20" && raw && raw.doc) {
      var w = Math.round(raw.doc.width * 0.2);
      var h = Math.round(raw.doc.height * 0.2);
      opts.mode = "sides";
      opts.sides = { left: w, top: h, right: w, bottom: h };
    } else {
      opts.mode = "aspect";
      opts.ratio = t;
    }
    return opts;
  }

  async function flowArgs(id, n, factor, modelId, over) {
    var a = A[id];
    var lane = laneOf(id);
    var model = modelId || modelFor(id, over);
    var ctx = await contextFor(id);
    // A model picked by id (a Model menu price) runs without trained models.
    var tr = trainedRun(id, modelId ? false : over);
    var prompt = promptOf(id, modelId ? false : over);
    var args = { model_id: model, context: ctx, references: refCount(id), options: {} };
    var schema = st.schemaCache[model] || null;
    if (!schema && model) {
      try {
        schema = await schemaFor(model);
      } catch (e) {
        schema = null;
      }
    }
    var quality = qualityOf(schema, id);
    if (a.family === "edit") {
      args.tool = tr ? "trained_edit" : "edit";
      var sample = a.sample === "layer" ? "layer" : st.adv.sample === "layer" ? "layer" : "visible";
      if (id === "more_like" && !ctx.selection) sample = "layer";
      args.options = { prompt: prompt, takes: takesFor(id, n), sample: sample, margin: st.adv.margin || "auto" };
      if (quality && args.tool === "edit") args.options.quality = quality;
      // The Change chip on a model with a strength input (lanes/edit.js).
      if (args.tool === "edit" && changeOn(id, schema)) args.options.change = CHANGE[st.change].at;
      if (a.expect) args.options.expect = a.expect;
      if (a.model_lane) args.options.model_lane = a.model_lane;
      // Replace inside records how it lands: Bolder grows the mask.
      if (args.tool === "edit" && editOn(id)) args.options.edit_mode = model && schemaMod.modelFacts(model).mask_growth ? "bolder" : "inside";
      // Relight to scene: the layer's outline is the mask, the model sees
      // the scene (FLOWS v2, F13).
      if (a.mask_layer && !ctx.selection) {
        args.options.mask_layer = true;
        args.options.sample = "visible";
      }
      if (id === "angle") args.options.extra = angleOf().extra;
      // A cut-out or a split element is mostly transparent: New angle's
      // model gets it on gray (lanes/edit.js).
      if (id === "angle" && st.ctx && (st.ctx.kind === "cutout" || st.ctx.kind === "element")) args.options.matte = true;
      if (args.tool === "trained_edit") args.trained = trainedPanel.argOf(tr, st.adv, CHANGE[st.change].at);
    } else if (a.family === "expand") {
      args.tool = "expand";
      args.options = expandOptions(ctx);
      args.options.prompt = prompt;
      args.options.takes = takesFor(id, n);
      if (quality) args.options.quality = quality;
    } else if (a.family === "upscale") {
      args.tool = "upscale";
      args.options = { source: a.source, factor: factor || st.factor || undefined, lands: a.source === "selection" ? "box" : "new_document" };
    } else if (a.family === "cutout") {
      args.tool = "remove_background";
      args.options = { source: a.source, lands: a.lands || st.adv.lands || "mask" };
    } else if (a.family === "tool") {
      args.tool = a.tool;
      args.options = { prompt: prompt || "", mode: a.mode, format: st.format, duration: st.duration };
      if (a.tool === "frames" && st.clip) {
        args.options.video_asset = st.clip.asset_id;
        args.options.clip_name = st.clip.name;
      }
    }
    args.lane = lane;
    return args;
  }

  function imageOptions(id, refs, n, schema, over, modelId) {
    var a = A[id];
    var tr = trainedRun(id, modelId ? false : over);
    return { action: id, size: st.size, prompt: promptOf(id, modelId ? false : over), takes: takesFor(id, n), references: refs, insert: a.insert || null, quality: tr ? null : qualityOf(schema, id), trained: trainedPanel.argOf(tr, st.adv) };
  }

  // Short words for a blocked view, from the prototype where it has them.
  function friendly(reason, id) {
    if (reason === commonMod.TEXT.nothing_grows && A[id] && A[id].family === "expand") return "Already " + st.target + ", pick another target";
    return reason || "Not available here";
  }

  // ---- the price check ----

  // The action waits for text: its prompt, or the Select… field.
  function needsText(id) {
    var a = A[id];
    if (!a) return false;
    if (a.prompt === "field") return !String(st.selectText || "").trim();
    return a.prompt === "req" && !String(st.prompt).trim();
  }

  function angleOf() {
    var list = actionsMod.ANGLES;
    for (var i = 0; i < list.length; i++) if (list[i].key === st.angle) return list[i];
    return list[0];
  }

  function setPrice(p) {
    st.price = p;
    emit();
  }

  async function check(seq) {
    if (seq !== st.seq) return;
    var id = st.action;
    var a = A[id];
    if (!a || !a.family) {
      setPrice({ state: "none" });
      return;
    }
    if (needsText(id)) {
      setPrice({ state: "need_prompt" });
      return;
    }
    if (o.account && !o.account()) {
      setPrice({ state: "unavailable", reason: TEXT.not_signed_in });
      return;
    }
    if (o.quotes.stopped && o.quotes.stopped()) {
      setPrice({ state: "unavailable", reason: TEXT.alarm });
      return;
    }
    // Two trained models that share no base: nothing to price.
    var trc = trainedRun(id);
    if (trc && !trc.base_model_id) {
      setPrice({ state: "blocked", action: id, reason: trc.reason });
      return;
    }
    setPrice({ state: "checking", action: id });
    var out;
    try {
      if (a.family === "image") out = await priceImage(id);
      else {
        var p = await o.flow.price(await flowArgs(id));
        out = { state: p.state, quote: p.quote, reason: p.reason, view: p.view, schema: p.schema };
      }
    } catch (e) {
      out = { state: e && e.afterUpload ? "after_upload" : "unavailable", reason: errText(e) };
      log("panel: price check " + ((e && e.type) || "error"));
    }
    if (seq !== st.seq) return;
    if (out.state === "ready") setPrice({ state: "ready", action: id, quote: out.quote, label: out.quote.label, view: out.view, schema: out.schema });
    else if (out.state === "blocked") setPrice({ state: "blocked", action: id, reason: friendly(out.reason, id), view: out.view, schema: out.schema });
    else if (out.state === "after_upload") setPrice({ state: "after_upload", action: id, reason: TEXT.after_upload, view: out.view, schema: out.schema });
    else if (out.state === "not_signed_in") setPrice({ state: "unavailable", action: id, reason: TEXT.not_signed_in });
    else if (out.state === "alarm") setPrice({ state: "unavailable", action: id, reason: TEXT.alarm });
    else setPrice({ state: "unavailable", action: id, reason: out.reason || "Price unavailable", view: out.view, schema: out.schema });
  }

  async function priceImage(id, n, modelId, over) {
    var schema = await schemaFor(modelId || modelFor(id, over));
    var v = imageMod.imageView(schema, st.raw, imageOptions(id, refCount(id), n, schema, over, modelId));
    if (v.blocked) return { state: "blocked", reason: v.blocked, view: v, schema: schema };
    var req;
    try {
      req = requests.build(schema, v.request);
    } catch (e) {
      return { state: "blocked", reason: errText(e), view: v, schema: schema };
    }
    try {
      var q = await o.quotes.estimate(req);
      return { state: "ready", quote: q, view: v, schema: schema };
    } catch (e) {
      if (e && e.afterUpload) return { state: "after_upload", view: v, schema: schema };
      if (e && e.type === "DryRunCreatedJob") return { state: "alarm" };
      return { state: "unavailable", reason: errText(e), view: v, schema: schema };
    }
  }

  // The price of each choice of a chip menu: Takes (counts), Upscale
  // (factors) or Model (models). Free price checks, kept for this context
  // and these settings, so reopening a menu asks nothing again. The menu
  // waits at most TAKES_PRICE_MS; choices still pricing show "…" and the
  // returned `later` settles when they have answered (each price check has
  // its own timeout), so the open menu can be drawn again with them.
  var optCache = { key: null, prices: {}, pending: {} };
  function settingsKey(id) {
    return JSON.stringify([st.key, id, st.prompt, st.takes[id] || null, st.models, st.style ? st.style.id || st.style.name : null, st.runWith ? st.runWith.id : null, st.styleRef ? st.styleRef.id : null, st.size, st.target, st.factor, st.change, st.adv, refCount(id), st.drefOff, st.angle, st.format, st.duration, st.selectText]);
  }
  async function optionPrices(id, values, kind, current) {
    var a = A[id];
    var out = { prices: {}, pending: false, later: null };
    if (!a || !a.family || needsText(id)) return out;
    if ((o.account && !o.account()) || (o.quotes.stopped && o.quotes.stopped())) return out;
    var key = settingsKey(id);
    if (optCache.key !== key) optCache = { key: key, prices: {}, pending: {} };
    var cache = optCache;
    var jobs = values.map(function (v) {
      var slot = kind + ":" + String(v);
      if (Object.prototype.hasOwnProperty.call(cache.prices, slot)) return Promise.resolve();
      if (cache.pending[slot]) return cache.pending[slot];
      if (v === current && st.price.state === "ready" && st.price.action === id && kind !== "model_trained") {
        cache.prices[slot] = st.price.label;
        return Promise.resolve();
      }
      var n = kind === "takes" ? v : null;
      var f = kind === "upsize" ? v : null;
      var m = kind === "model" ? v || defaultFor(id) : null;
      // A trained row of the Model menu ("t:<id>"): Run with that model.
      var over;
      if ((kind === "model" || kind === "model_trained") && typeof v === "string" && v.indexOf("t:") === 0) {
        over = { runWith: trainedById(v.slice(2)) };
        m = null;
      }
      var run = a.family === "image" ? priceImage(id, n, m, over) : flowArgs(id, n, f, m, over).then(function (args) {
        if (kind === "duration") args.options.duration = v;
        return o.flow.price(args);
      });
      cache.pending[slot] = run.then(
        function (p) {
          cache.prices[slot] = p && p.state === "ready" && p.quote ? p.quote.label : "";
          delete cache.pending[slot];
        },
        function () {
          cache.prices[slot] = "";
          delete cache.pending[slot];
        }
      );
      return cache.pending[slot];
    });
    var all = Promise.all(jobs);
    var timer = null;
    await Promise.race([
      all,
      new Promise(function (resolve) {
        timer = timers.setTimeout(resolve, TAKES_PRICE_MS);
      })
    ]);
    if (timer) timers.clearTimeout(timer);
    for (var i = 0; i < values.length; i++) {
      var sl = kind + ":" + String(values[i]);
      if (Object.prototype.hasOwnProperty.call(cache.prices, sl)) out.prices[values[i]] = cache.prices[sl];
      else {
        out.prices[values[i]] = "…";
        out.pending = true;
      }
    }
    if (out.pending) out.later = all.then(function () {
      return true;
    });
    return out;
  }

  // The price of each More entry in this context, with its own default
  // model and settings (free price checks, kept until the context changes;
  // an entry that needs a prompt shows one only when the prompt is filled).
  var morePrices = { key: null, prices: {} };
  async function actionPrices(ids) {
    if (morePrices.key !== st.key) morePrices = { key: st.key, prices: {} };
    var cache = morePrices.prices;
    if ((o.account && !o.account()) || (o.quotes.stopped && o.quotes.stopped())) return cache;
    var jobs = ids.map(function (id) {
      var a = A[id];
      if (cache[id] !== undefined || !a || !a.family) return Promise.resolve();
      if (needsText(id)) return Promise.resolve();
      var run = a.family === "image" ? priceImage(id) : flowArgs(id).then(function (args) {
        return o.flow.price(args);
      });
      return run.then(
        function (p) {
          cache[id] = p && p.state === "ready" && p.quote ? p.quote.label : "";
        },
        function () {
          cache[id] = "";
        }
      );
    });
    var timer = null;
    await Promise.race([
      Promise.all(jobs),
      new Promise(function (resolve) {
        timer = timers.setTimeout(resolve, TAKES_PRICE_MS);
      })
    ]);
    if (timer) timers.clearTimeout(timer);
    return cache;
  }

  function schedule() {
    st.seq++;
    if (st.timer) timers.clearTimeout(st.timer);
    st.timer = null;
    if (!st.active) return;
    var seq = st.seq;
    var a = A[st.action];
    // Nothing to price: the button says so at once.
    if (!a || !a.family) {
      st.price = { state: "none" };
      return;
    }
    if (needsText(st.action)) {
      st.price = { state: "need_prompt" };
      return;
    }
    if (st.price.state !== "checking") st.price = { state: "checking", action: st.action };
    st.timer = timers.setTimeout(function () {
      st.timer = null;
      check(seq);
    }, DEBOUNCE_MS);
  }

  function changed() {
    schedule();
    emit();
  }

  // ---- Generate ----

  async function refFromTake(run, modelId) {
    var rec = recordOf(run);
    var shown = shownChild(run);
    if (!rec || !shown) throw invalid("The shown take's file is not on this computer.");
    var out = null;
    var asset = shown.child.fields && shown.child.fields.assetId;
    for (var i = 0; i < (rec.outputs || []).length; i++) if (rec.outputs[i].asset_id === asset) out = rec.outputs[i];
    if (!out || !out.path || typeof o.host.readDataBinary !== "function") throw invalid("The shown take's file is not on this computer.");
    var bytes = await o.host.readDataBinary(out.path);
    if (!bytes) throw invalid("The shown take's file could not be read.");
    var png = /\.png$/i.test(out.path);
    return { id: "take-" + asset.slice(-8), bytes: bytes, ext: png ? "png" : "jpg", mime: png ? "image/png" : "image/jpeg", width: out.width, height: out.height, source: "take", label: "Take " + (shown.i + 1), reduced: false, document_id: docId() };
  }

  async function collectRefs(id, modelId) {
    var a = A[id];
    var out = [];
    var d = docId();
    if (a.refs) {
      var on = drefsOn();
      for (var i = 0; i < on.length; i++) {
        var r = await o.references.capture("layer", d, modelId, null, on[i].layer_id);
        r.label = on[i].role + ": " + on[i].name;
        out.push(r);
      }
    }
    if (a.autoRef) out.push(await o.references.capture("layer", d, modelId, null, null));
    if (takeRefNeeded(id)) out.push(await refFromTake(cardRun(), modelId));
    if (a.refs) for (var k = 0; k < st.refs.length; k++) out.push(st.refs[k]);
    if (matchOn(id)) out.push(st.styleRef);
    return out;
  }

  function limit() {
    return o.settings && typeof o.settings.confirmAbove === "function" ? o.settings.confirmAbove() : 100000;
  }

  function confirmFor(q, id) {
    var t = price.toThousandths(q.cu_cost);
    var lim = price.exactString(limit());
    var text;
    if (q.price_kind === "from") text = "This costs from " + price.display(t) + " CU. The charge can be higher; Scenario gives no upper bound for this model.";
    else if (q.price_kind === "range") text = "This costs " + q.label + "; " + price.display(price.toThousandths(q.cu_cost_max)) + " CU is above your confirm limit of " + lim + " CU.";
    else text = "This costs " + q.label + ", above your confirm limit of " + lim + " CU.";
    return { kind: "threshold", quote: q, action: id, text: text, detail: q.no_refund ? "No refund if it fails." : "", ok: buttonLabel(id) + " · " + q.label };
  }

  // After a run that is not masked to a selection, its new group or layer
  // is selected once it lands, so the next chip works on the result, not on
  // the hidden source (FLOWS v2, changes after review 13). Masked runs keep
  // the selection; a mask on the layer and a new document select nothing.
  function selectsResult(id) {
    var a = A[id];
    if (!a || !a.family) return false;
    if (a.family === "upscale") return false;
    if (a.family === "cutout") return a.lands === "new_layer" || st.adv.lands === "new_layer";
    if (a.family === "image") return !!docId();
    if (a.family === "edit") return !(st.raw && (st.raw.selection || st.raw.selection_raw));
    // Split and text land as a group or a layer; a selection, a formats
    // document and a clip select nothing.
    if (a.family === "tool") return a.tool === "split" || a.tool === "text" || a.tool === "frames";
    return true;
  }

  // A price that changed after the upload (live 2026-10-21: New angle, 1 CU
  // before the upload, 14 CU after it): the composer's button shows it for
  // the same action and settings, since the stand-in quote it re-checks
  // would read the old price again. Any change of settings drops it.
  function noteRepriced(id, cu, localId) {
    st.repriced = { action: id, key: settingsKey(id), price: String(cu), local_id: localId };
  }

  function repricedFor(id) {
    var r = st.repriced;
    if (!r || r.action !== id) return null;
    if (r.key !== settingsKey(id)) {
      st.repriced = null;
      return null;
    }
    return r.price;
  }

  function go() {
    if (st.sending || st.confirm || st.price.state !== "ready" || st.price.action !== st.action) return Promise.resolve(null);
    if (!o.runner) return Promise.resolve(null);
    var q = st.price.quote;
    if (needsConfirm(q, limit())) {
      st.confirm = confirmFor(q, st.action);
      emit();
      return Promise.resolve(null);
    }
    return run(q, st.action);
  }

  async function run(q, id) {
    st.sending = true;
    st.note = "";
    emit();
    var a = A[id];
    var d = docId();
    try {
      var modelId = modelFor(id);
      var refs = await collectRefs(id, modelId);
      var out;
      if (a.family === "image") {
        var raw = await contextMod.read(o.host);
        var schema = await schemaFor(modelId);
        var v = imageMod.imageView(schema, raw, imageOptions(id, refs.length, null, schema));
        if (v.blocked) throw invalid(v.blocked);
        var req = requests.build(schema, v.request);
        out = await o.runner.start({ req: req, quote: q, refs: refs, model_name: schema.name, document_title: raw.doc ? raw.doc.title : null, mask: null, name: st.shortName });
      } else {
        var args = await flowArgs(id);
        args.refs = refs;
        args.name = st.shortName || (a.prompt === "none" || a.prompt === "field" || (a.family === "tool" && !String(st.prompt).trim()) ? a.label : null);
        if (id === "more_like" && args.context.selection) {
          // The capture reads the selection: the run's own, from its mask.
          await o.host.selectionFromMask(d, maskLayerOf(cardRun()), boxOf(cardRun()));
        }
        out = await o.flow.generate(args, q);
      }
      if (out.record && d !== null) {
        st.latest[d] = out.record.local_id;
        delete st.done[out.record.local_id];
      }
      if (out.record && selectsResult(id)) selectAfter[out.record.local_id] = true;
      if (out.record && id === "frame") afterFrame[out.record.local_id] = true;
      if (out.record && id === "select_desc") st.selectText = "";
      if (out.record && d === null) st.latest.none = out.record.local_id;
      if (out.replayed) st.note = TEXT.replayed;
      else if (out.state === "awaiting_approval") {
        st.confirm = { kind: "changed", local_id: out.record.local_id, text: "Price changed after upload. Now " + out.price + " CU (was " + out.was + " CU). Nothing was spent.", ok: "Approve · " + out.price + " CU" };
        noteRepriced(id, out.price, out.record.local_id);
      } else if (out.state !== "queued" && out.record && out.record.error) st.note = out.record.error;
      if (id === "more_like") st.keepAction = false;
    } catch (e) {
      var type = e && e.type;
      st.note = type === "QuoteMismatch" || type === "QuoteExpired" || type === "QuoteUsed" ? TEXT.changed : errText(e);
      log("panel: generate " + (type || "error"));
    } finally {
      st.sending = false;
      // A used quote never spends twice: the next click needs a new price.
      schedule();
      emit();
      refresh();
    }
    return true;
  }

  function confirmOk() {
    var c = st.confirm;
    if (!c) return Promise.resolve(null);
    st.confirm = null;
    if (c.kind === "threshold") return run(c.quote, c.action);
    if (c.kind === "changed") {
      st.sending = true;
      emit();
      return o.runner.approve(c.local_id).then(
        function (out) {
          st.sending = false;
          if (out && out.state === "awaiting_approval" && out.changed) {
            st.confirm = { kind: "changed", local_id: c.local_id, text: "Price changed again. Now " + out.price + " CU. Nothing was spent.", ok: "Approve · " + out.price + " CU" };
            if (st.repriced && st.repriced.local_id === c.local_id) st.repriced.price = String(out.price);
          }
          else st.note = out && out.state !== "queued" && out.record ? out.record.error || "" : "";
          changed();
        },
        function (e) {
          st.sending = false;
          st.note = errText(e);
          changed();
        }
      );
    }
    if (c.kind === "agent") return Promise.resolve(c.approve ? c.approve() : null).then(emit);
    return Promise.resolve(null);
  }

  function confirmCancel() {
    var c = st.confirm;
    st.confirm = null;
    if (c && c.kind === "changed" && o.runner) o.runner.decline(c.local_id).then(emit, emit);
    emit();
  }

  // ---- the Takes card ----

  async function showTake(i) {
    var run = cardRun();
    var d = docId();
    if (!run || !run.group_id || !run.children[i]) return;
    try {
      await o.host.showTake(d, run.group_id, run.children[i].id);
    } catch (e) {
      st.note = errText(e);
    }
    await refresh();
  }

  async function keep() {
    var run = cardRun();
    var shown = shownChild(run);
    if (!run || !run.group_id || !shown || run.children.length < 2) return;
    try {
      await o.host.keepTake(docId(), run.group_id, shown.child.id);
    } catch (e) {
      st.note = errText(e);
    }
    await refresh();
  }

  // Refine: keep the shown take, then the composer starts from it: Replace
  // inside on the same selection for a selection edit, else Make versions of the
  // kept layer, with an empty prompt.
  async function refine() {
    var run = cardRun();
    var shown = shownChild(run);
    if (!run || !shown) return;
    var d = docId();
    var rec = recordOf(run);
    try {
      if (run.group_id && run.children.length > 1) await o.host.keepTake(d, run.group_id, shown.child.id);
      st.startFrom = { n: Number(shown.child.fields.take) || shown.i + 1 };
      st.keepAction = true;
      st.prompt = "";
      if (wasMasked(rec)) {
        await o.host.selectionFromMask(d, maskLayerOf(run), boxOf(run));
        if (rec.target.layer_id) await o.host.selectLayer(d, rec.target.layer_id).catch(function () {});
        st.action = "replace";
      } else {
        await o.host.selectLayer(d, shown.child.id);
        st.action = "versions";
      }
    } catch (e) {
      st.keepAction = false;
      st.note = errText(e);
    }
    await refresh();
    changed();
  }

  function closeCard() {
    var c = st.card;
    if (c && c.local_id) st.done[c.local_id] = true;
    st.card = null;
    emit();
  }

  async function placeCard() {
    var c = st.card;
    if (!c || !c.local_id) return;
    try {
      await o.runner.place(c.local_id, {});
    } catch (e) {
      st.note = errText(e);
    }
    await refresh();
  }

  async function openRecent(localId) {
    var rec = o.ledger ? o.ledger.get(localId) : null;
    var pl = rec && rec.placement;
    var at = pl ? pl.group_id || (pl.layer_ids || [])[0] : null;
    if (!at) {
      st.note = TEXT.layers_gone;
      emit();
      return;
    }
    try {
      await o.host.selectLayer(docId(), at);
    } catch (e) {
      st.note = TEXT.layers_gone;
    }
    await refresh();
  }

  // ---- composer changes ----

  function selectAction(id) {
    if (!A[id]) return;
    if (A[id].special === "refine") {
      refine();
      return;
    }
    if (id !== st.action) {
      st.action = id;
      // + Reference > Library belongs to the action it was opened for.
      st.libPick = false;
      st.confirm = st.confirm && st.confirm.kind === "changed" ? st.confirm : null;
      if (A[id].prompt === "none" || A[id].prompt === "field") {
        st.prompt = "";
        st.shortName = null;
      }
    }
    changed();
  }

  // The Select… field of a layer's card (F8): typing picks Select by
  // description; clearing it goes back to the context's first action.
  function setSelect(text) {
    st.selectText = String(text || "");
    var has = st.selectText.trim() !== "";
    if (has && st.action !== "select_desc") {
      st.action = "select_desc";
      st.prompt = "";
      st.shortName = null;
    } else if (!has && st.action === "select_desc") st.action = actionsMod.CONTEXTS[st.ctx.kind][0];
    changed();
  }

  // A single-result card's own buttons (cardActions).
  // The Edit choice a Replace inside run did not use, or null. Offered
  // while a selection is there to run it in (placing loads it back).
  function tryEditOf(rec) {
    if (!st.ctx || st.ctx.kind !== "selection") return null;
    var m = rec && rec.lane === "edit" && rec.target ? rec.target.edit_mode : null;
    if (m !== "bolder" && m !== "inside") return null;
    return m === "bolder" ? "inside" : "bolder";
  }

  async function cardAction(name) {
    var c = st.card || cardRun();
    var rec = c && c.local_id && o.ledger ? o.ledger.get(c.local_id) : null;
    if (!rec) return;
    // Try the other Edit choice: Replace inside with the same prompt and
    // the other chip value, priced in the composer before anything runs.
    if (name === "try_edit") {
      var other = tryEditOf(rec);
      if (!other) return;
      var prompt = rec.name || (rec.parameters && rec.parameters.prompt) || "";
      if (st.action !== "replace") selectAction("replace");
      if (prompt && !String(st.prompt).trim()) st.prompt = prompt;
      setEditMode("replace", other);
      changed();
      return;
    }
    if (name === "frame") {
      var out = (rec.outputs || []).filter(function (x) {
        return x.state === "saved";
      })[0];
      if (!out) return;
      st.clip = { asset_id: out.asset_id, name: runName(rec.name || (rec.parameters && rec.parameters.prompt), rec.lane), local_id: rec.local_id };
      st.keepAction = true;
      selectAction("frame");
      return;
    }
    if (name === "open_clip") {
      try {
        await o.runner.place(rec.local_id, {});
      } catch (e) {
        st.note = errText(e);
      }
      await refresh();
    }
  }

  function setPrompt(text) {
    var before = String(st.prompt).trim() !== "";
    st.prompt = String(text || "");
    var now = st.prompt.trim() !== "";
    if (!now) st.shortName = null;
    var a = A[st.action];
    // An empty prompt shows its words at once; typing reprices after 400 ms.
    if (a && a.prompt === "req" && before !== now) changed();
    else {
      schedule();
      if (a && a.prompt !== "req") emit();
      else emit();
    }
  }

  function choose(kind, value) {
    var id = st.action;
    var lane = laneOf(id);
    if (kind === "takes") st.takes[id] = Number(value) || 1;
    else if (kind === "model") {
      if (lane) {
        if (value) st.models[modelKey(id)] = value;
        else delete st.models[modelKey(id)];
      }
      if (typeof value === "string" && value.indexOf("t:") === 0) {
        // Run with a trained model: it runs on its base, with the trained
        // style when both fit one base, else it replaces the style.
        delete st.models[modelKey(id)];
        var tw = trainedById(value.slice(2));
        // "t:-": the trained style's base alone.
        if (!tw) {
          st.runWith = null;
          changed();
          return;
        }
        var why = trainedPanel.clash(A[id], st.style, tw, st.bases || []);
        if (why) {
          st.note = trainedPanel.TEXT.replaced(st.style.name, tw.name, why);
          st.style = null;
        }
        st.runWith = tw;
      } else {
        st.runWith = null;
        if (trainedPanel.familyOf(A[id]) && st.style && !st.style.match) st.style = null;
      }
    } else if (kind === "style") {
      // Match an image: the picture comes next (menu "stylesrc"); until
      // then nothing changes.
      if (value === "match") return;
      if (value && !value.match && st.runWith) {
        var why2 = trainedPanel.clash(A[id], value, st.runWith, st.bases || []);
        if (why2) {
          st.note = trainedPanel.TEXT.replaced(st.runWith.name, value.name, why2);
          st.runWith = null;
        }
      }
      st.style = value || null;
      dropStyleRef();
    } else if (kind === "stylesrc") {
      return pickStyle(value);
    } else if (kind === "size") st.size = value;
    else if (kind === "target") st.target = value;
    else if (kind === "upsize") st.factor = value;
    else if (kind === "change") st.change = Math.max(0, Math.min(CHANGE.length - 1, Number(value) || 0));
    else if (kind === "edit") setEditMode(id, value === "bolder" ? "bolder" : "inside");
    else if (kind === "angle") st.angle = value;
    else if (kind === "format") st.format = value;
    else if (kind === "duration") st.duration = Number(value) || 5;
    else if (kind === "suggest") {
      var items = st.spark && st.spark.state === "ready" ? st.spark.items : [];
      var pick = items[Number(value)];
      if (typeof pick !== "string") return;
      // The run keeps the person's short prompt as its name.
      if (!st.shortName && String(st.prompt).trim()) st.shortName = String(st.prompt).trim();
      st.prompt = pick;
      st.note = "";
    }
    else if (kind === "adv") {
      st.adv[value.name] = value.value;
    }
    changed();
  }

  function togglePin(id) {
    st.pins = actionsMod.togglePin(st.pins, st.ctx.kind, id);
    if (o.host && typeof o.host.writeDataText === "function") o.host.writeDataText(PINS_FILE, JSON.stringify(st.pins));
    emit();
  }

  function toggleDocRef(layerId) {
    if (st.drefOff[layerId]) delete st.drefOff[layerId];
    else st.drefOff[layerId] = true;
    changed();
  }

  // ---- the Library grid ----

  async function loadLibrary(force) {
    if (!o.library) {
      st.lib = { state: "error", rows: [], more: false, error: "The Library needs a signed-in project." };
      emit();
      return;
    }
    if (st.lib.state === "loading") return;
    var f = st.libFilter;
    st.lib = { state: "loading", rows: st.lib.rows, more: st.lib.more, error: null };
    emit();
    try {
      var got = await o.library.list(!!force, f);
      if (f !== st.libFilter) {
        st.lib.state = "idle";
        return loadLibrary(false);
      }
      st.lib = { state: "ready", rows: got.rows, more: !!got.more, error: null };
    } catch (e) {
      st.lib = { state: "error", rows: [], more: false, error: errText(e) };
    }
    emit();
  }

  // The grid's mode: "ref" (+ Reference > Library), "place" (Place from
  // Library: a document is open) or "open" (Open from Library).
  function libraryMode() {
    if (st.libPick) return "ref";
    var a = A[st.action];
    return a && a.grid ? a.grid : null;
  }

  function libraryModel() {
    var mode = libraryMode();
    if (!mode) return null;
    if (st.lib.state === "idle") loadLibrary();
    var found = libraryMod.search(st.lib.rows, st.libQuery);
    var shown = found.slice(0, st.libShown);
    var q = String(st.libQuery || "").trim();
    var empty = null;
    if (st.lib.state === "ready" && !found.length) {
      if (q) empty = 'No image matches "' + q + '" in the ' + st.lib.rows.length + " newest" + (st.lib.more ? " (Show more reads further)" : "") + ".";
      else empty = st.libFilter === "all" ? "No images in this project yet." : "No " + libraryMod.FILTERS.filter(function (x) {
        return x.key === st.libFilter;
      })[0].label.toLowerCase() + " images in this project yet.";
    }
    var verb = mode === "ref" ? "Add " : mode === "place" ? "Place " : "Open ";
    return {
      mode: mode,
      title: mode === "ref" ? "Add a Library image as a reference" : null,
      state: st.lib.state,
      error: st.lib.error,
      query: st.libQuery,
      filters: libraryMod.FILTERS.map(function (x) {
        return { key: x.key, label: x.label, on: x.key === st.libFilter };
      }),
      items: shown.map(function (r) {
        var size = r.width && r.height ? { width: r.width, height: r.height } : null;
        var bits = [r.title];
        if (size) bits.push(size.width + " × " + size.height);
        return { asset_id: r.asset_id, name: verb + r.name, title: verb + bits.join(", "), thumb: r.thumb, size: size, source: r.source };
      }),
      more: found.length > shown.length || (st.lib.more && st.lib.state !== "loading"),
      count: found.length,
      empty: empty
    };
  }

  // A click in the grid: opens the image as a new document, places it in
  // the document as a layer, or adds it to the refs row.
  async function libraryPick(assetId) {
    var row = st.lib.rows.filter(function (r) {
      return r.asset_id === assetId;
    })[0];
    if (!row || !o.library) return;
    var mode = libraryMode();
    st.note = "";
    st.sending = true;
    emit();
    try {
      if (mode === "place") {
        var raw = st.raw || {};
        if (!raw.doc) throw invalid("Open a document to place a Library image in it.");
        await o.library.place(row, { id: raw.doc.id, width: raw.doc.width, height: raw.doc.height }, { layer_id: raw.layer ? raw.layer.id : null, leave_prompts: !!o.leavePrompts });
        st.note = clipMod.clip(row.name, 40) + " is placed as a new layer.";
      } else {
        var got = await o.library.fetch(assetId);
        if (mode === "ref") {
          var bytes = await o.host.readDataBinary(got.path);
          var r = o.references.fromBytes(bytes, row.name, modelFor(st.action), "library");
          r.url = urls.fromBytes(r.bytes, r.mime);
          st.refs.push(r);
          st.libPick = false;
        } else {
          if (!o.openFile) throw invalid("This Photoshop cannot open files from the plugin.");
          await o.openFile(got.path);
        }
      }
    } catch (e) {
      st.note = errText(e);
    } finally {
      st.sending = false;
    }
    changed();
    refresh();
  }

  // The search field: filters the rows read so far, at once.
  function librarySearch(text) {
    st.libQuery = String(text || "");
    st.libShown = libraryMod.SHOWN;
    emit();
  }

  function libraryFilter(key) {
    if (key === st.libFilter) return;
    st.libFilter = key;
    st.libShown = libraryMod.SHOWN;
    st.lib = { state: "idle", rows: [], more: false, error: null };
    loadLibrary();
  }

  // Show more: the next tiles, reading the next page when the rows read so
  // far are all shown.
  async function libraryMore() {
    st.libShown += libraryMod.SHOWN;
    var found = libraryMod.search(st.lib.rows, st.libQuery);
    if (found.length >= st.libShown || !st.lib.more || !o.library || st.lib.state === "loading") {
      emit();
      return;
    }
    var f = st.libFilter;
    st.lib.state = "loading";
    emit();
    try {
      var got = await o.library.more(f);
      if (f === st.libFilter) st.lib = { state: "ready", rows: got.rows, more: !!got.more, error: null };
    } catch (e) {
      st.lib = { state: "ready", rows: st.lib.rows, more: st.lib.more, error: errText(e) };
    }
    emit();
  }

  function libraryCancel() {
    st.libPick = false;
    emit();
  }

  async function addRef(source) {
    if (source === "library") {
      st.libPick = true;
      loadLibrary();
      emit();
      return;
    }
    var id = st.action;
    var modelId = modelFor(id);
    st.note = "";
    try {
      var r = source === "file" ? await o.references.chooseFile(modelId) : await o.references.capture(source, docId(), modelId, null, null);
      if (r) {
        r.url = urls.fromBytes(r.bytes, r.mime);
        st.refs.push(r);
      }
    } catch (e) {
      st.note = errText(e);
    }
    changed();
  }

  function dropStyleRef() {
    if (st.styleRef && st.styleRef.url) urls.release(st.styleRef.url);
    st.styleRef = null;
  }

  // Match an image: captures the style picture from the document or a file,
  // then puts the Style chip on it.
  async function pickStyle(source) {
    var modelId = modelFor(st.action);
    st.note = "";
    try {
      var r = source === "file" ? await o.references.chooseFile(modelId) : await o.references.capture(source, docId(), modelId, null, null);
      if (r) {
        dropStyleRef();
        r.url = urls.fromBytes(r.bytes, r.mime);
        r.style = true;
        r.label = "Style · " + r.label;
        st.styleRef = r;
        st.style = { match: true, name: "Match an image" };
      }
    } catch (e) {
      st.note = errText(e);
    }
    changed();
  }

  function removeRef(refId) {
    if (st.styleRef && st.styleRef.id === refId) {
      dropStyleRef();
      st.style = null;
      changed();
      return;
    }
    st.refs = st.refs.filter(function (r) {
      if (r.id === refId && r.url) urls.release(r.url);
      return r.id !== refId;
    });
    changed();
  }

  // Pins the active layer as a document reference with a role, in the
  // document's metadata.
  async function pinDocRef(role) {
    var d = docId();
    var L = st.raw && st.raw.layer;
    if (d === null || !L) return;
    var list = st.drefs.filter(function (r) {
      return r.layer_id !== L.id;
    });
    list.push({ role: role, layer_id: L.id, name: L.name });
    try {
      st.drefs = await o.host.setDocumentReferences(d, list);
    } catch (e) {
      st.note = "Document references could not be saved in this document: " + errText(e);
    }
    changed();
  }

  async function unpinDocRef(layerId) {
    var d = docId();
    if (d === null) return;
    var list = st.drefs.filter(function (r) {
      return r.layer_id !== layerId;
    });
    try {
      st.drefs = await o.host.setDocumentReferences(d, list);
    } catch (e) {
      st.note = errText(e);
    }
    changed();
  }

  // ---- Suggest (Prompt Spark, free) ----
  // Proposals for the selected action's model from the prompt, or, with an
  // empty prompt, a description of the active layer (a 512 px capture sent
  // as a data link, nothing uploaded). Sent only when its price check
  // answers 0 CU (scenario/spark.js).

  function sparkOk(id) {
    var a = A[id];
    return !!(a && a.family && a.prompt !== "none" && o.client && modelFor(id));
  }

  function sparkKey(id) {
    return [st.key, id, modelFor(id), String(st.prompt).trim(), sparkConstraints(id).join(" ")].join("|");
  }

  // What Prompt Spark must respect (prototype review findings): the size
  // the result fills, the Style chip, a cut-out's transparent background.
  // Sent as a closing paragraph of the request only (scenario/spark.js).
  function sparkConstraints(id) {
    var out = [];
    var raw = st.raw || {};
    var kind = st.ctx && st.ctx.kind;
    var b = kind === "selection" ? raw.selection || raw.selection_raw : null;
    var w = b ? b.width : raw.doc ? raw.doc.width : null;
    var h = b ? b.height : raw.doc ? raw.doc.height : null;
    if (!raw.doc && /^\d+:\d+$/.test(String(st.size || ""))) out.push("The result is a " + st.size + " image; do not propose another size or aspect.");
    else if (w > 0 && h > 0) out.push("The result fills " + Math.round(w) + " x " + Math.round(h) + " px (" + (w > h * 1.05 ? "landscape" : h > w * 1.05 ? "portrait" : "square") + "); do not propose another size.");
    if (st.style && matchOn(id)) out.push("The style comes from the last reference image; do not name another style or medium.");
    else if (st.style && styleApplies(id)) out.push("The style is set by a trained model (" + st.style.name + "); do not name another style or medium.");
    else if (raw.doc) out.push("Keep the style and medium of the picture as they are (for example do not call a painting photorealistic) unless the prompt asks for a change.");
    if (kind === "cutout" || kind === "element") {
      if (id === "background") out.push("The subject is a cut-out that stays as it is; describe only the new background behind it.");
      else out.push("The subject is a cut-out on a transparent background; do not add a background.");
    }
    out.push("Leave out sizes, resolution and quality settings.");
    return out;
  }

  function startSpark(id) {
    var key = sparkKey(id);
    var prompt = String(st.prompt).trim();
    var raw = st.raw || {};
    var describe = !prompt;
    var entry = { key: key, state: "working", items: [], reason: null, cu: null, describe: describe, layer: raw.layer ? raw.layer.name : null, model: modelFor(id), promise: null };
    st.spark = entry;
    if (describe && !(raw.doc && raw.layer)) {
      entry.state = "need_prompt";
      return entry;
    }
    if (o.account && !o.account()) {
      entry.state = "failed";
      entry.reason = TEXT.not_signed_in;
      return entry;
    }
    entry.promise = (async function () {
      var image = null;
      if (describe) {
        try {
          image = await o.references.capture("layer", raw.doc.id, entry.model, 512, raw.layer.id);
        } catch (e) {
          return { state: "failed", reason: errText(e) };
        }
      }
      try {
        return await sparkMod.suggest({ client: o.client, quotes: o.quotes, settings: o.settings }, { model_id: entry.model, prompt: prompt, image: image, n: 3, constraints: sparkConstraints(id) });
      } catch (e) {
        return { state: "failed", reason: errText(e) };
      }
    })().then(function (r) {
      entry.state = r.state;
      entry.items = r.items || [];
      entry.reason = r.reason || null;
      entry.cu = r.cu === undefined ? null : r.cu;
      if (r.state === "ready") log("panel: suggest ready" + (r.charged ? ", charged " + r.charged + " CU" : ""));
      else log("panel: suggest " + r.state);
      if (r.charged) entry.charged = r.charged;
      emit();
      return true;
    });
    return entry;
  }

  function sparkMenu() {
    var id = st.action;
    var title = "Suggest · Prompt Spark · Free";
    if (!sparkOk(id)) return { kind: "suggest", title: title, state: "off", text: "Suggest is not available for this action.", items: [] };
    var e = st.spark && st.spark.key === sparkKey(id) && st.spark.state !== "failed" ? st.spark : null;
    if (!e) e = startSpark(id);
    var row = o.catalog && o.catalog.find ? o.catalog.find(e.model) : null;
    var mname = row ? row.name : (st.schemaCache[e.model] || {}).name || "this model";
    var from = e.describe ? "The prompt is empty, so Suggest describes the " + (e.layer || "active") + " layer" : "Proposals for " + mname + " from your prompt";
    var out = { kind: "suggest", title: title, state: e.state, from: from, items: e.items, text: "", note: "", later: e.state === "working" ? e.promise : null };
    if (e.state === "working") out.text = "Asking Prompt Spark…";
    else if (e.state === "need_prompt") out.text = "Type a few words first; Suggest turns them into fuller prompts.";
    else if (e.state === "priced") {
      // Not free here: the title stops saying it is.
      out.title = "Suggest · Prompt Spark";
      out.text = "Prompt Spark quotes " + price.display(price.toThousandths(e.cu)) + " CU here, so nothing was sent: Suggest runs only when it is free.";
    }
    else if (e.state === "failed") out.text = e.reason || "Prompt Spark did not answer.";
    else out.note = "Picking one replaces the prompt; the run keeps your short prompt as its name. Size, style and quality stay on the chips." + (e.charged ? " Scenario charged " + e.charged + " CU for these." : "");
    return out;
  }

  // ---- styles (the project's trained models that can edit) ----

  // The project's trained models (styles and characters) with the bases
  // they run on: the Style chip's trained styles and the Model menu's
  // trained rows (panel/trained.js). Read once per project.
  var trainedLoad = null;
  function loadStyles() {
    var acc = o.account ? o.account() : null;
    var key = acc ? acc.id : "-";
    if (trainedLoad && trainedLoad.key === key) return trainedLoad.promise;
    var entry = { key: key, promise: null };
    trainedLoad = entry;
    entry.promise = (async function () {
      var list = [];
      try {
        await o.catalog.ensure();
        var rows = o.catalog.rows();
        var any = rows.some(function (r) {
          return r.project && !map.isBase(r);
        });
        var bases = any || st.runWith ? await o.catalog.baseSchemas() : st.bases || [];
        st.bases = bases;
        list = trainedPanel.projectEntries(rows, bases);
      } catch (e) {
        log("panel: trained models unavailable (" + ((e && e.message) || e) + ")");
      }
      if (trainedLoad === entry) st.styles = list;
      emit();
      return list;
    })();
    return entry.promise;
  }

  function trainedById(id) {
    var all = (st.styles || []).concat(st.runWith ? [st.runWith] : []);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  // Run with a trained model from All models… (the picker's Trained tab,
  // public models too): it becomes the Model menu's trained pick.
  // Whether a base model can do this action in the panel: Create image needs
  // no picture; every other action sends the layer or the selection, so the
  // model needs an input the plugin knows how to fill (forms/schema.js
  // capture_input_name). A schema that cannot be read counts as no.
  function feedsLayer(id, modelId) {
    if (laneOf(id) === "image") return Promise.resolve(true);
    return Promise.resolve()
      .then(function () {
        return o.catalog.schema(modelId);
      })
      .then(
        function (s) {
          return !!(s && s.capture_input_name);
        },
        function () {
          return false;
        }
      );
  }

  async function runWithRow(row) {
    await loadStyles();
    if (!st.bases || !st.bases.length) st.bases = await o.catalog.baseSchemas();
    var e = trainedPanel.entryOf(row, st.bases);
    if (!e) {
      st.note = "This trained model's type has no base model in this version of the plugin.";
      emit();
      return false;
    }
    if (!trainedPanel.fits(A[st.action], e)) {
      st.note = e.name + " cannot run with " + (A[st.action] ? A[st.action].label : "this action") + ".";
      emit();
      return false;
    }
    if (!trainedById(e.id)) st.styles = (st.styles || []).concat([e]);
    choose("model", "t:" + e.id);
    return true;
  }

  // ---- the render model ----

  function buttonLabel(id, v) {
    var a = A[id];
    if (!a || !a.button) return a ? a.label : "";
    return a.button(takesFor(id), v ? viewFacts(v) : viewFacts(st.price.view));
  }

  // What the labels need from a priced view: sizes and the factor.
  function viewFacts(v) {
    if (!v) return { factor: st.factor || "2x" };
    var out = { factor: (v.controls && v.controls.factor) || st.factor || "2x" };
    if (v.sizes && v.sizes.output) out.out = v.sizes.output;
    if (v.sizes && v.sizes.to) out.to = v.sizes.to;
    if (v.lane === "image" && v.out) out.out = v.out;
    return out;
  }

  function runProgress(rec) {
    if (!rec || RUNNING.indexOf(rec.state) < 0) return null;
    var takes = rec.parameters && rec.parameters.numOutputs ? Number(rec.parameters.numOutputs) : (rec.outputs || []).length || 1;
    var words = {
      uploading_inputs: "Uploading",
      submitting: "Sending to Scenario",
      queued: "Queued on Scenario",
      generating: "Generating " + actionsMod.plural(takes, "take"),
      cancel_requested: "Canceling",
      succeeded: "Downloading",
      downloading: "Downloading",
      applying: "Placing in the document"
    };
    var at = { uploading_inputs: 0.08, submitting: 0.14, queued: 0.2, generating: 0.25, cancel_requested: 0.9, succeeded: 0.85, downloading: 0.88, applying: 0.95 }[rec.state];
    if (rec.state === "generating" && typeof rec.progress === "number") at = 0.25 + Math.max(0, Math.min(1, rec.progress)) * 0.6;
    return { label: words[rec.state] || "Working", at: at };
  }

  function latestRecord() {
    var d = docId();
    var lid = d === null ? st.latest.none : st.latest[d];
    return lid && o.ledger ? o.ledger.get(lid) : null;
  }

  function outputFor(rec, assetId) {
    if (!rec) return null;
    for (var i = 0; i < (rec.outputs || []).length; i++) if (rec.outputs[i].asset_id === assetId) return rec.outputs[i];
    return null;
  }

  function thumbOf(rec, assetId) {
    var out = outputFor(rec, assetId);
    return out && out.state === "saved" ? thumbs.resultThumb(out.path) : null;
  }

  function sizeOfOut(out) {
    return out && out.width > 0 && out.height > 0 ? { width: out.width, height: out.height } : null;
  }

  function ctxModel() {
    var c = st.ctx;
    var raw = st.raw || {};
    var a = A[st.action] || {};
    var facts = viewFacts(st.price.action === st.action ? st.price.view : null);
    var n = takesFor(st.action);
    var L = layerName();
    var land = a.land ? a.land(L, n, facts) : "";
    var out = { kind: c.kind, icon: "file", thumb: null, count: null, title: "", detail: land, running: false, progress: null, checker: false };
    if (c.kind === "none") {
      out.icon = "file";
      out.title = "No document open";
    } else if (c.kind === "selection") {
      var s = raw.selection || raw.selection_raw;
      out.icon = "selection";
      out.title = "Selection " + times(s.width, s.height) + " on " + L;
      var ts = thumbNow();
      if (ts) {
        out.thumb = ts.url;
        out.thumb_size = ts.size;
      }
      if (st.startFrom && st.action === "replace") out.detail = "Starting from take " + st.startFrom.n + " · lands inside the selection";
    } else if (c.kind === "takes") {
      var r = c.run;
      var sh = shownChild(r);
      var rec = recordOf(r);
      var kept = r.group_id ? r.children.length === 1 : true;
      out.icon = "image";
      out.thumb = sh ? thumbOf(rec, sh.child.fields.assetId) : null;
      out.thumb_size = sh ? sizeOfOut(outputFor(rec, sh.child.fields.assetId)) : null;
      out.count = r.children.length > 1 ? r.children.length : null;
      var name = runName(r.prompt, r.kind);
      out.title = (r.group_id ? (kept ? "Kept take" : r.children.length + " takes") : "1 take") + " · " + name;
      // One take outside a group is a single layer: there is no group to name.
      if (st.action === "compare") out.detail = !r.group_id ? "One take, placed as a layer" : kept ? "Take " + (Number(sh.child.fields.take) || 1) + " kept in the group" : "Showing take " + (Number(sh.child.fields.take) || sh.i + 1) + " · click a take to compare";
    } else {
      var lay = raw.layer;
      var lw = lay && lay.bounds ? lay.bounds.width : raw.doc.width;
      var lh = lay && lay.bounds ? lay.bounds.height : raw.doc.height;
      out.icon = "layer";
      out.checker = c.kind === "cutout";
      out.title = lay ? lay.name + " · Layer " + times(lw, lh) : (raw.doc.title || "Document") + " · Canvas " + times(raw.doc.width, raw.doc.height);
      var plain = lay ? layerTitle(lay.name, st.meta && st.meta.fields) : null;
      if (plain && plain !== lay.name) {
        out.tip = out.title;
        out.title = plain;
      }
      if (st.startFrom && st.action === "versions") out.detail = "Starting from take " + st.startFrom.n + " · " + land.charAt(0).toLowerCase() + land.slice(1);
      var mf = st.meta && st.meta.fields;
      if (mf && mf.assetId && mf.jobId && o.ledger && typeof o.ledger.findByJobId === "function") {
        var lr = o.ledger.findByJobId(mf.jobId);
        out.thumb = thumbOf(lr, mf.assetId);
        out.thumb_size = sizeOfOut(outputFor(lr, mf.assetId));
      }
      var tl = out.thumb ? null : thumbNow();
      if (tl) {
        out.thumb = tl.url;
        out.thumb_size = tl.size;
      }
      // Select by description (F8): the Select… field of a layer's card.
      out.select = { value: st.selectText, placeholder: "Select…", on: st.action === "select_desc", title: "Select by description: type what to select, for example all the boats" };
    }
    var latest = latestRecord();
    var pr = runProgress(latest);
    if (pr) {
      out.running = true;
      out.progress = pr.at;
      out.detail = pr.label;
    }
    return out;
  }

  function chipsModel() {
    var kind = st.ctx.kind;
    var list = actionsMod.chipsFor(kind, st.pins);
    var extra = null;
    if (st.action && list.indexOf(st.action) < 0 && A[st.action]) {
      if (list.length < actionsMod.MAX_CHIPS) list = list.concat([st.action]);
      else extra = st.action;
    }
    var chips = list.map(function (id) {
      return { id: id, label: A[id].label, on: st.action === id };
    });
    var groups = actionsMod.moreFor(kind, st.pins, st.action);
    var more = groups.length ? { label: extra ? A[extra].label : "More", on: !!extra } : null;
    return { chips: chips, more: more };
  }

  function cardModel() {
    var run = cardRun();
    if (!run) return null;
    var rec = recordOf(run);
    if (run.other) {
      // A run that has not landed as takes (failed, waiting, or an
      // Enhance result): one line and its own buttons.
      if (!rec) return null;
      if (RUNNING.indexOf(rec.state) >= 0) return null;
      var words = { ready: "Ready to place", awaiting_approval: "Waiting for your approval", applied: "Placed" };
      var line = words[rec.state] || (FAILED.indexOf(rec.state) >= 0 ? rec.error || "Did not finish" : "");
      var first = shownOutput(rec);
      // The checks' badges for the shown output, as a Takes card shows them
      // for each take (live 2026-10-21: Extend recorded a step and a repeated
      // detail, and its single card showed neither).
      var all = rec.placement && rec.placement.badges ? rec.placement.badges : [];
      var at = Math.max(0, (rec.outputs || []).indexOf(first));
      var checks = (all[at] || []).slice();
      var badge = badgeOf(checks);
      return {
        kind: "single",
        local_id: rec.local_id,
        title: rec.lane === "upscale" && rec.target && rec.target.document_title ? "New document from " + rec.target.document_title : runName(rec.name || (rec.parameters && rec.parameters.prompt), rec.lane),
        meta: rec.state === "applied" ? "Placed" : "",
        sub: [rec.model_name, cuOf(rec) ? cuOf(rec) + " CU" : null].filter(Boolean).join(" · "),
        thumb: first && first.state === "saved" ? thumbs.resultThumb(first.path) || posterOf(rec) : null,
        thumb_size: sizeOfOut(first),
        line: rec.placement && rec.placement.notes && rec.placement.notes.length ? rec.placement.notes.join(" ") : line,
        tone: FAILED.indexOf(rec.state) >= 0 || (badge && badge.tone === "warn") ? "warn" : "ok",
        badge: badge,
        checks: checks,
        place: rec.state === "ready",
        actions: cardActions(rec),
        compare: compareOf(rec),
        done: true
      };
    }
    var sh = shownChild(run);
    var kept = run.group_id ? run.children.length === 1 && (!rec || (rec.outputs || []).length > 1) : false;
    var badges = rec && rec.placement && rec.placement.badges ? rec.placement.badges : [];
    var crop = tileCrop(rec);
    var takes = run.children.map(function (c, i) {
      var idx = (Number(c.fields.take) || i + 1) - 1;
      return { i: i, n: idx + 1, on: !!sh && sh.i === i, thumb: thumbOf(rec, c.fields.assetId), size: sizeOfOut(outputFor(rec, c.fields.assetId)), crop: crop, badge: badgeOf(badges[idx]), name: c.name };
    });
    var cu = cuOf(rec);
    return {
      kind: "takes",
      local_id: rec ? rec.local_id : null,
      title: runName(run.prompt, run.kind),
      meta: kept ? "Kept" : takes.length > 1 ? takes.length + " takes" : "1 take",
      sub: [run.model_name, cu ? cu + " CU" : null].filter(Boolean).join(" · "),
      takes: takes,
      keep: !kept && takes.length > 1 && run.group_id ? "Keep take " + (sh ? takes[sh.i].n : 1) : null,
      clickable: !!run.group_id && takes.length > 1,
      actions: rec ? cardActions(rec) : [],
      by: rec && rec.origin && rec.origin.kind === "agent" ? String(rec.origin.client_name || "Agent") : null,
      done: st.ctx.kind !== "takes"
    };
  }

  // Upscale's card compares the same region at 100% (FLOWS v2, changes
  // after review 12): the source as read, enlarged, beside the result at
  // its own pixels, from the middle of the picture. Tiles are 120 x 90.
  var COMPARE_TILE = { width: 120, height: 90 };
  function compareOf(rec) {
    if (!rec || rec.lane !== "upscale") return null;
    var out = (rec.outputs || []).filter(function (x) {
      return x.state === "saved" && x.width > 0 && x.height > 0;
    })[0];
    var cap = rec.inputs && rec.inputs.capture;
    var file = cap && cap.files && cap.files[0];
    if (!out || !cap || !cap.source_path || !file || !(file.width > 0)) return null;
    var tw = Math.min(COMPARE_TILE.width, out.width);
    var th = Math.min(COMPARE_TILE.height, out.height);
    var crop = { x: (out.width - tw) / 2 / out.width, y: (out.height - th) / 2 / out.height, w: tw / out.width, h: th / out.height };
    return {
      tile: { width: tw, height: th },
      before: { thumb: thumbs.resultThumb(cap.source_path), size: { width: file.width, height: file.height }, crop: crop, label: "Original, enlarged" },
      after: { thumb: thumbs.resultThumb(out.path), size: { width: out.width, height: out.height }, crop: crop, label: "Upscale at 100%" }
    };
  }

  // The output a single-result card shows: the frame that landed for Frame
  // to layer (the last one), else the first.
  function shownOutput(rec) {
    var outs = rec.outputs || [];
    var landed = (rec.placement && rec.placement.landed) || {};
    return landed.kind === "frames" && outs.length ? outs[outs.length - 1] : outs[0];
  }

  // A clip's card shows the picture it started from (its capture).
  function posterOf(rec) {
    var cap = rec && rec.inputs && rec.inputs.capture;
    return cap && cap.source_path ? thumbs.resultThumb(cap.source_path) : null;
  }

  // The buttons of a single-result card: an Animate clip offers Frame to
  // layer and Open clip again (FLOWS v2, F9).
  function cardActions(rec) {
    var out = [];
    if (rec.lane === "video" && rec.target && rec.target.kind === "video" && (rec.outputs || []).some(function (x) {
      return x.state === "saved";
    })) {
      out.push({ id: "frame", label: "Frame to layer" });
      if (rec.state === "applied") out.push({ id: "open_clip", label: "Open clip" });
    }
    // Replace inside: the other Edit choice, as a variant of the run.
    var other = tryEditOf(rec);
    if (other) out.push({ id: "try_edit", label: "Try " + actionsMod.EDIT_MODES[other].label });
    return out;
  }

  // An edit inside a selection: its tiles show the selection (with a little
  // of what surrounds it), not the whole capture, as fractions of the take.
  function tileCrop(rec) {
    var t = rec && rec.lane === "edit" && rec.target;
    if (!t || !t.selection || !t.box) return null;
    var b = t.box;
    var s = t.selection;
    if (!(b[2] > 0 && b[3] > 0)) return null;
    var pad = Math.round(Math.max(s[2], s[3]) * 0.1);
    var l = Math.max(b[0], s[0] - pad);
    var tp = Math.max(b[1], s[1] - pad);
    var r = Math.min(b[0] + b[2], s[0] + s[2] + pad);
    var bt = Math.min(b[1] + b[3], s[1] + s[3] + pad);
    if (!(r > l && bt > tp)) return null;
    if (r - l >= b[2] * 0.95 && bt - tp >= b[3] * 0.95) return null;
    return { x: (l - b[0]) / b[2], y: (tp - b[1]) / b[3], w: (r - l) / b[2], h: (bt - tp) / b[3] };
  }

  function recentModel() {
    if (!o.ledger || docId() === null) return [];
    var current = cardRun();
    var currentId = current ? current.local_id || (recordOf(current) || {}).local_id : null;
    var d = docId();
    var out = [];
    var all = o.ledger.all();
    for (var i = 0; i < all.length && out.length < 8; i++) {
      var r = all[i];
      if (r.state !== "applied" || !r.placement || r.local_id === currentId) continue;
      // A run that opened its own document (a clip, a formats document)
      // shows in that document only: its layer is there.
      var lk = r.placement.landed || {};
      if ((lk.kind === "video" || lk.new_document) && r.placement.document_id !== d) continue;
      var here = r.placement.document_id === d && (r.session === o.session || !!(st.placedSeen[d] && st.placedSeen[d][r.local_id]));
      if (!here && o.runner && typeof o.runner.whereFor === "function") {
        var w = o.runner.whereFor(r);
        here = w.kind === "active" && w.document_id === d;
      }
      if (!here) continue;
      var first = (r.outputs || [])[0];
      out.push({ local_id: r.local_id, title: runName(r.name || (r.parameters && r.parameters.prompt), r.lane), thumb: first && first.state === "saved" ? thumbs.resultThumb(first.path) : null, size: sizeOfOut(first), lane: r.lane });
    }
    return out;
  }

  function goModel() {
    var a = A[st.action];
    var p = st.price;
    var current = p.action === st.action;
    var label = a.label;
    var g = { label: label, cu: "", enabled: false, title: "", reason: "" };
    if (st.sending) {
      g.label = TEXT.sending;
      return g;
    }
    if (p.state === "need_prompt" || needsText(st.action)) {
      g.label = a.prompt === "field" ? TEXT.need_select : TEXT.need_prompt;
      return g;
    }
    g.label = buttonLabel(st.action, current ? p.view : null);
    if (p.state === "checking" || !current) {
      g.cu = "· …";
      g.title = TEXT.checking;
      return g;
    }
    if (p.state === "ready") {
      var after = repricedFor(st.action);
      var shownLabel = after !== null ? after + " CU" : p.label;
      g.cu = "· " + shownLabel;
      g.enabled = !st.confirm && !!o.runner && !(o.runner.pausedFor && o.runner.pausedFor() > 0);
      g.title = g.label + " · " + shownLabel + (after !== null ? " (the price after the upload)" : "");
      if (o.runner && o.runner.pausedFor && o.runner.pausedFor() > 0) g.reason = "Not sent: Scenario asked to wait " + o.runner.pausedFor() + " s.";
      if (p.quote && p.quote.no_refund) g.reason = g.reason || "No refund if it fails.";
      return g;
    }
    var reason = p.reason || "Price unavailable";
    if (reason.length <= 40) {
      g.label = reason;
    } else {
      g.reason = reason;
    }
    g.title = reason;
    return g;
  }

  function chipModel(kind) {
    var id = st.action;
    var p = st.price.action === id ? st.price : {};
    var schema = p.schema || st.schemaCache[modelFor(id)] || null;
    if (kind === "style") {
      if (st.style && st.style.match) return { kind: kind, thumb: st.styleRef ? st.styleRef.url : null, icon: "style", value: "Match an image", title: "Style: Match an image" + (st.styleRef ? ", " + st.styleRef.label : "") };
      if (!styleApplies(id) && st.style) return { kind: kind, icon: "style", value: "No style", title: "Style" };
      return st.style ? { kind: kind, thumb: st.style.thumb, icon: "style", value: st.style.name, title: "Style: " + st.style.name + (st.style.trigger ? ". Trigger: " + st.style.trigger : "") } : { kind: kind, icon: "style", value: "No style", title: "Style" };
    }
    if (kind === "model") {
      // Run with a trained model: the chip shows it; the base runs it.
      var rw = runWithOf();
      var trm = trainedRun(id);
      if (rw && trm && trm.list.indexOf(rw) >= 0) return { kind: kind, thumb: rw.thumb, mono: monoOf(rw.name), value: rw.name, title: "Model: " + rw.name + " on " + (trm.base_name || "its base") + (rw.trigger ? ". Trigger: " + rw.trigger : "") };
      var row = schema ? schema.row : null;
      var name = schema ? schema.name : o.catalog && o.catalog.find(modelFor(id)) ? o.catalog.find(modelFor(id)).name : "Model";
      return { kind: kind, thumb: row ? thumbs.modelThumb(row) : null, mono: monoOf(name), value: name, title: "Model: " + name };
    }
    if (kind === "takes") {
      if (schema && !schema.takes_input) return null;
      return { kind: kind, icon: "takes", value: actionsMod.plural(takesFor(id), "take"), title: "Takes" };
    }
    if (kind === "size") {
      var v = p.view;
      var key = v && v.size_key ? v.size_key : st.size;
      var dims = v && v.out ? times(v.out.width, v.out.height) : "";
      return { kind: kind, icon: "ratio", value: key, key_text: dims, title: "Size" };
    }
    if (kind === "target") {
      var t = TARGETS.filter(function (x) {
        return x.key === st.target;
      })[0];
      return { kind: kind, icon: "expand", value: t ? t.label : st.target, title: "Extend to" };
    }
    if (kind === "upsize") {
      var f = viewFacts(p.view);
      return { kind: kind, icon: "upscale", value: actionsMod.factorLabel(f), key_text: f.out ? times(f.out.width, f.out.height) : "", title: "Upscale factor" };
    }
    if (kind === "edit") {
      if (!editOn(id)) return null;
      var em = actionsMod.EDIT_MODES[editMode(id)];
      return { kind: kind, icon: "selection", key_text: "Edit", value: em.label, title: "Edit: " + em.label, key_first: true };
    }
    if (kind === "change") {
      if (!changeOn(id, schema)) return null;
      return { kind: kind, icon: "slider", key_text: "Change", value: CHANGE[st.change].label, title: "Change amount", key_first: true };
    }
    if (kind === "angle") return { kind: kind, icon: "refresh", value: angleOf().label, title: "Angle" };
    if (kind === "format") {
      var fm = moreLanes.FORMATS[st.format];
      return { kind: kind, icon: "ratio", value: st.format, key_text: fm ? times(fm.width, fm.height) : "", title: "Format" };
    }
    if (kind === "duration") return { kind: kind, icon: "jobs", value: st.duration + " s", title: "Duration" };
    return null;
  }

  function monoOf(name) {
    var p = String(name || "?")
      .replace(/[^A-Za-z0-9 .]/g, "")
      .split(/[ .]+/)
      .filter(Boolean);
    return ((p[0] || "?").charAt(0) + (p[1] ? p[1].charAt(0) : "")).toUpperCase();
  }

  function refsModel() {
    var a = A[st.action];
    if (!a || (!a.refs && !a.autoRef)) return null;
    var p = st.price.action === st.action ? st.price : {};
    var schema = p.schema || st.schemaCache[modelFor(st.action)] || null;
    if (schema && a.family === "image" && !requests.referenceInput(schema)) return null;
    // How many references the model takes beside the capture (null: no
    // limit). An edit model takes them with its capture (GPT Image 2.5) or
    // in its own reference input (Ideogram 4.5 Precise Edit, 3 with a
    // selection's mask).
    var most = null;
    if (schema && a.family === "edit") {
      var ci = commonMod.fileInput(schema, schema.capture_input_name);
      var own = requests.separateReferenceInput(schema);
      if (ci && ci.multiple) most = ci.max ? ci.max - 1 : null;
      else if (own) most = requests.refMax(schema, own, st.ctx.kind === "selection");
      else return null;
    }
    var items = [];
    if (a.autoRef && st.raw && st.raw.layer) items.push({ id: "auto", label: st.raw.layer.name + ", for light and perspective", url: null, icon: "layer", removable: false });
    if (takeRefNeeded(st.action)) items.push({ id: "take", label: "The shown take", url: null, icon: "image", removable: false });
    var drefs = a.refs
      ? st.drefs.map(function (r) {
          return { layer_id: r.layer_id, role: r.role, name: r.name, on: !st.drefOff[r.layer_id], title: "Document reference · " + r.role + ": " + r.name + ". Travels with the PSD. Click to leave it out of this run." };
        })
      : [];
    if (matchOn(st.action)) items.push({ id: st.styleRef.id, label: st.styleRef.label + ", sent at " + times(st.styleRef.width, st.styleRef.height), url: st.styleRef.url || null, width: st.styleRef.width, height: st.styleRef.height, icon: "style", removable: true, role: "Style" });
    if (a.refs) {
      for (var i = 0; i < st.refs.length; i++) items.push({ id: st.refs[i].id, label: st.refs[i].label + ", sent at " + times(st.refs[i].width, st.refs[i].height), url: st.refs[i].url || null, width: st.refs[i].width, height: st.refs[i].height, icon: st.refs[i].source === "file" ? "file" : st.refs[i].source === "selection" ? "selection" : st.refs[i].source === "visible" ? "visible" : "layer", removable: true });
    }
    var count = items.length + drefs.length;
    var sent = items.length + drefs.filter(function (d) {
      return d.on;
    }).length;
    return {
      drefs: drefs,
      items: items,
      add: !!a.refs && (most === null || sent < most),
      add_label: count ? "" : "Reference",
      hint: drefs.length ? "" : st.refs.length === 1 ? st.refs[0].label : st.refs.length > 1 ? st.refs.length + " references" : items.length ? "" : TEXT.ref_hint,
      note: st.action === "replace" && sent > 0 ? TEXT.replace_ref_note : null
    };
  }

  function composerModel() {
    var a = A[st.action] || {};
    var c = { action: st.action, note: null, refs: null, prompt: null, none: null, chips: [], go: null, confirm: st.confirm, agent: st.agent, plan: planModel(), message: st.note || null, gear: false };
    c.library = libraryModel();
    if (a.note) {
      c.note = a.note(cardModelLite());
      return c;
    }
    c.refs = refsModel();
    if (a.prompt === "none") c.none = a.none;
    else if (a.prompt === "field") c.none = String(st.selectText || "").trim() ? 'Selects "' + String(st.selectText).trim() + '", one mask per object, as a Photoshop selection.' : a.none;
    else c.prompt = { placeholder: a.placeholder || "", value: st.prompt };
    c.suggest = !!c.prompt && sparkOk(st.action);
    var chips = (a.chips || []).map(chipModel).filter(Boolean);
    c.chips = chips;
    c.go = goModel();
    var gp = st.price.action === st.action ? st.price : {};
    c.gear = advancedFor(st.action, gp.schema || st.schemaCache[modelFor(st.action)] || null).length > 0;
    return c;
  }

  // F14: one card for an agent's plan: its steps, each with its price and
  // state, one total, Approve all or step by step, Decline.
  function planModel() {
    var p = st.plan;
    if (!p || !p.steps || !p.steps.length) return null;
    var WORDS = { waiting: "", approved: "Approved", running: "Running", done: "Done", failed: "Failed", declined: "Declined" };
    return {
      who: String(p.client_name || "Agent") + " plans " + p.steps.length + " steps",
      steps: p.steps.map(function (x, i) {
        return { n: i + 1, label: String(x.label || ""), cu: x.cu !== undefined && x.cu !== null ? x.cu + " CU" : "", state: WORDS[x.state] !== undefined ? WORDS[x.state] : "" };
      }),
      total: p.total_cu !== undefined && p.total_cu !== null ? "Approve all · " + p.total_cu + " CU" : "Approve all",
      pending: p.steps.some(function (x) {
        return !x.state || x.state === "waiting";
      })
    };
  }

  function planDecision(kind) {
    var p = st.plan;
    if (!p) return;
    var fn = kind === "all" ? p.approve_all : kind === "steps" ? p.step_by_step : p.decline;
    if (kind === "decline") {
      st.plan = null;
      st.note = TEXT.declined;
    }
    emit();
    if (typeof fn === "function") Promise.resolve(fn()).then(emit, emit);
  }

  function cardModelLite() {
    var run = cardRun();
    if (!run) return null;
    var sh = shownChild(run);
    return { kept: run.group_id ? run.children.length === 1 : true, shown_n: sh ? Number(sh.child.fields.take) || sh.i + 1 : 1 };
  }

  function headerModel() {
    var h = o.jobsModel ? o.jobsModel.header() : { badge: null, attention: false, tooltip: "Jobs", running: 0 };
    var total = o.ledger ? o.ledger.all().length : 0;
    return { jobs: total, running: h.running > 0, attention: !!h.attention, title: h.tooltip };
  }

  function model() {
    var ch = chipsModel();
    var card = cardModel();
    var recent = recentModel();
    return {
      header: headerModel(),
      ctx: ctxModel(),
      chips: ch.chips,
      more: ch.more,
      card: card,
      recent: recent,
      empty_mid: !card && !recent.length && st.ctx.kind !== "none" ? TEXT.empty_mid : null,
      composer: composerModel()
    };
  }

  // ---- menus (the popovers' contents) ----

  function advancedFor(id, schema) {
    var a = A[id];
    if (!a || !a.family) return [];
    var rows = [];
    var trA = trainedRun(id);
    var q = qualityOf(schema) && !trA ? [{ name: "quality", label: "Quality", value: qualityOf(schema), options: QUALITY }] : [];
    // Trained models: a weight per LoRA and the trigger words (M7).
    q = q.concat(trainedPanel.advancedRows(trA, st.adv));
    if (a.family === "edit")
      rows = q.concat([
        { name: "margin", label: "Context margin", value: st.adv.margin || "auto", options: [["auto", "Auto"], ["64", "64 px"], ["none", "None"]] },
        { name: "sample", label: "The model sees", value: a.sample === "layer" || id === "more_like" ? "layer" : st.adv.sample || "visible", options: a.sample === "layer" ? [["layer", "This layer"]] : [["visible", "All visible"], ["layer", "Current layer"]] }
      ]);
    else if (a.family === "image") rows = q;
    else if (a.family === "expand") rows = q.concat([{ name: "anchor", label: "Original at", value: st.adv.anchor || "center", options: [["center", "Center"], ["top", "Top"], ["bottom", "Bottom"], ["center-left", "Left"], ["center-right", "Right"]] }]);
    else if (a.family === "cutout" && !a.lands) rows = [{ name: "lands", label: "Lands as", value: st.adv.lands || "mask", options: [["mask", "Mask on the layer"], ["new_layer", "New masked layer"]] }];
    return rows;
  }

  async function menu(kind) {
    var id = st.action;
    var a = A[id] || {};
    var lane = laneOf(id);
    var p = st.price.action === id ? st.price : {};
    var schema = p.schema || st.schemaCache[modelFor(id)] || null;
    // A chip menu opened before the first price check (an empty prompt)
    // still lists the model's own choices.
    if (!schema && kind !== "more" && kind !== "addref" && modelFor(id)) {
      try {
        schema = await schemaFor(modelFor(id));
      } catch (e) {
        schema = null;
      }
    }
    if (kind === "suggest") return sparkMenu();
    if (kind === "more") {
      var mg = actionsMod.moreFor(st.ctx.kind, st.pins, st.action);
      var ids = [];
      for (var gi = 0; gi < mg.length; gi++) for (var ii = 0; ii < mg[gi].items.length; ii++) ids.push(mg[gi].items[ii].id);
      var mp = await actionPrices(ids);
      for (var gj = 0; gj < mg.length; gj++) for (var ij = 0; ij < mg[gj].items.length; ij++) mg[gj].items[ij].right = mp[mg[gj].items[ij].id] || "";
      return { title: null, groups: mg };
    }
    if (kind === "takes") {
      var max = schema && schema.takes_max ? schema.takes_max : 4;
      var counts = TAKES.filter(function (n) {
        return n <= max;
      });
      var tp = await optionPrices(id, counts, "takes", takesFor(id));
      var priced = tp.prices;
      return {
        title: "Takes",
        later: tp.later,
        items: counts.map(function (n) {
          return { value: n, label: actionsMod.plural(n, "take"), sub: n === 1 ? "One result" : n + " results to compare", right: priced[n] || "", checked: takesFor(id) === n };
        })
      };
    }
    if (kind === "size") {
      var sizes = schema ? imageMod.presets(schema) : [];
      var cur = p.view && p.view.size_key ? p.view.size_key : st.size;
      return {
        title: "Size",
        items: sizes.map(function (s) {
          return { value: s.key, label: s.key, sub: s.label, checked: s.key === cur };
        })
      };
    }
    if (kind === "target") {
      var sidesOk = schema ? schema.expand_route === "mask" : true;
      return {
        title: "Extend to",
        items: TARGETS.filter(function (t) {
          return !t.sides || sidesOk;
        }).map(function (t) {
          return { value: t.key, label: t.sides ? "+20% each side" : t.label, sub: t.sub || "", checked: st.target === t.key };
        })
      };
    }
    if (kind === "upsize") {
      var fp = schema ? commonMod.param(schema, "upscaleFactor") : null;
      var values = fp && fp.enum ? fp.enum.filter(function (v) {
        return /^\d+(\.\d+)?x$/.test(v);
      }) : ["2x"];
      var curF = (p.view && p.view.controls && p.view.controls.factor) || st.factor || "2x";
      var read = p.view && p.view.sizes ? p.view.sizes.read : null;
      var fp2 = await optionPrices(id, values, "upsize", curF);
      var fprices = fp2.prices;
      return {
        title: "Upscale",
        later: fp2.later,
        items: values.map(function (v) {
          var f = parseFloat(v);
          return { value: v, label: actionsMod.factorLabel({ factor: v }), sub: read ? times(read.width * f, read.height * f) : "", right: fprices[v] || "", checked: v === curF };
        })
      };
    }
    if (kind === "edit") {
      var cur = editMode(id);
      var bm = actionsMod.EDIT_MODES.bolder.model;
      var ins = cur === "inside" ? st.models[modelKey(id)] || null : null;
      var ep = await optionPrices(id, [ins, bm], "model", st.models[modelKey(id)] || null);
      return {
        title: "Edit",
        later: ep.later,
        items: ["inside", "bolder"].map(function (k) {
          var m = actionsMod.EDIT_MODES[k];
          return { value: k, label: m.label, sub: m.sub, right: ep.prices[k === "inside" ? ins : bm] || "", checked: cur === k };
        })
      };
    }
    if (kind === "change") {
      return {
        title: "Change amount",
        items: CHANGE.map(function (c, i) {
          return { value: i, label: c.label, sub: i === 0 ? "Stays close to the layer" : i === CHANGE.length - 1 ? "May redraw the whole layer" : "", checked: st.change === i };
        })
      };
    }
    if (kind === "style") {
      var on = st.style && (st.style.match || styleApplies(id)) ? st.style : null;
      var sgroups = [
        {
          title: "Style",
          items: [
            { value: null, label: "No style", sub: "The model's own look", checked: !on, icon: "style" },
            { value: "match", label: "Match an image", sub: on && on.match && st.styleRef ? st.styleRef.label : "Style from a picture, any model", thumb: on && on.match && st.styleRef ? st.styleRef.url : null, checked: !!(on && on.match), icon: "image", next: true }
          ]
        }
      ];
      // Trained styles run on the base they were trained on: edits (the
      // Edit lane on the base) and new images (Make new on the base, M7).
      var styles = trainedPanel.familyOf(a) ? await loadStyles() : [];
      var titems = [];
      for (var s = 0; s < styles.length; s++) {
        if (styles[s].role !== "style" || !trainedPanel.fits(a, styles[s])) continue;
        titems.push({ value: styles[s], label: styles[s].name, sub: trainedPanel.subOf(styles[s]), title: trainedPanel.titleOf(styles[s]), thumb: styles[s].thumb, mono: monoOf(styles[s].name), checked: !!on && on.id === styles[s].id });
      }
      if (titems.length) sgroups.push({ title: "Trained styles", items: titems });
      return { title: null, groups: sgroups, note: titems.length ? TEXT.styles_note : TEXT.styles_note_image };
    }
    if (kind === "stylesrc") {
      var sraw = st.raw || {};
      var src = [];
      if (sraw.doc && (sraw.selection || sraw.selection_raw)) src.push({ value: "selection", label: "Selection", sub: "What is inside the marching ants" });
      if (sraw.doc) src.push({ value: "layer", label: "Layer", sub: "The active layer" }, { value: "visible", label: "All visible", sub: "The document as it looks now" });
      src.push({ value: "file", label: "File…", sub: "An image on this computer" });
      return { title: "Match an image", items: src, note: TEXT.match_note };
    }
    if (kind === "model" && styleApplies(id)) {
      var trS = trainedRun(id, { runWith: null });
      var base = trS && trS.base_model_id ? trS.base_model_id : st.style.bases[0];
      var baseRow = o.catalog.find(base);
      var bname = baseRow ? baseRow.name : trS && trS.base_name ? trS.base_name : base;
      // Trained models that run together with the style, on its base.
      var withItems = [];
      var all2 = await loadStyles();
      for (var w2 = 0; w2 < all2.length; w2++) {
        var cand = all2[w2];
        if (cand.id === st.style.id || !trainedPanel.fits(a, cand)) continue;
        var both = trainedPanel.resolve(a, st.style, cand, st.bases || []);
        if (!both || !both.base_model_id) continue;
        withItems.push({ value: "t:" + cand.id, label: cand.name, sub: trainedPanel.subOf(cand), title: trainedPanel.titleOf(cand), thumb: cand.thumb, mono: monoOf(cand.name), checked: !!st.runWith && st.runWith.id === cand.id });
      }
      var vals2 = ["t:-"].concat(
        withItems.map(function (x) {
          return x.value;
        })
      );
      var bp2 = await optionPrices(id, vals2, "model_trained", null);
      var bp = bp2.prices;
      var g2 = [{ title: "Trained style base", items: [{ value: "t:-", label: bname, sub: st.style.name + " is trained on it", thumb: baseRow ? thumbs.modelThumb(baseRow) : null, mono: monoOf(bname), right: bp["t:-"] || "", checked: !st.runWith }] }];
      for (var w3 = 0; w3 < withItems.length; w3++) withItems[w3].right = bp[withItems[w3].value] || "";
      if (withItems.length) g2.push({ title: "Run with " + st.style.name, items: withItems });
      return { title: null, later: bp2.later, groups: g2, note: TEXT.base_note };
    }
    if (kind === "model" && a.model) {
      var own = [a.model].concat(a.alts || []);
      var oitems = own.map(function (mid, i) {
        var orow = o.catalog.find(mid);
        var nm2 = orow ? orow.name : schema && schema.model_id === mid ? schema.name : mid;
        return { value: i === 0 ? null : mid, label: nm2, thumb: orow ? thumbs.modelThumb(orow) : null, mono: monoOf(nm2), tag: i === 0 ? "Recommended" : null, checked: i === 0 ? !st.models[modelKey(id)] : st.models[modelKey(id)] === mid };
      });
      var ovals = oitems.map(function (x) {
        return x.value;
      });
      var op = await optionPrices(id, ovals, "model", st.models[modelKey(id)] || null);
      for (var oi = 0; oi < oitems.length; oi++) oitems[oi].right = op.prices[oitems[oi].value] || "";
      return { title: null, groups: [{ title: "Models for " + a.label, items: oitems }], later: op.later, note: "Prices are price checks for this document and these settings." };
    }
    if (kind === "angle") {
      return {
        title: "Angle",
        items: actionsMod.ANGLES.map(function (x) {
          return { value: x.key, label: x.label, sub: "Turn " + x.extra.horizontalAngle + "°, tilt " + x.extra.verticalAngle + "°", checked: st.angle === x.key };
        })
      };
    }
    if (kind === "format") {
      return {
        title: "Format",
        items: FORMAT_KEYS.map(function (k) {
          var f = moreLanes.FORMATS[k];
          return { value: k, label: f.label, sub: times(f.width, f.height), checked: st.format === k };
        })
      };
    }
    if (kind === "duration") {
      var dp = schema ? commonMod.param(schema, "duration") : null;
      var durs = moreLanes.DURATIONS.filter(function (d) {
        return !dp || ((typeof dp.min !== "number" || d >= dp.min) && (typeof dp.max !== "number" || d <= dp.max));
      });
      var dpr = await optionPrices(id, durs, "duration", st.duration);
      return {
        title: "Duration",
        later: dpr.later,
        items: durs.map(function (d) {
          return { value: d, label: d + " s", right: dpr.prices[d] || "", checked: st.duration === d };
        })
      };
    }
    if (kind === "model") {
      var rec = defaultFor(id);
      var mkey = modelKey(id);
      var recRow = o.catalog.find(rec);
      var groups = [{ title: "Recommended for " + a.label, items: [{ value: null, label: recRow ? recRow.name : schema && schema.model_id === rec ? schema.name : rec, thumb: recRow ? thumbs.modelThumb(recRow) : null, mono: monoOf(recRow ? recRow.name : schema && schema.model_id === rec ? schema.name : rec), tag: "Recommended", checked: !st.models[mkey] && !trainedRun(id) }] }];
      try {
        await o.catalog.ensure();
      } catch (e) {
        // the catalog list is optional here
      }
      // Your trained models (M7, Run with): the project's trained models that
      // can do this action, characters first; each runs on its base.
      var rwOn = st.runWith && trainedRun(id) && trainedRun(id).list.indexOf(st.runWith) >= 0 ? st.runWith : null;
      if (trainedPanel.familyOf(a)) {
        var mine = await loadStyles();
        var titems2 = [];
        for (var t2 = 0; t2 < mine.length; t2++) {
          if (!trainedPanel.fits(a, mine[t2])) continue;
          titems2.push({ value: "t:" + mine[t2].id, label: mine[t2].name, sub: trainedPanel.subOf(mine[t2]), title: trainedPanel.titleOf(mine[t2]), thumb: mine[t2].thumb, mono: monoOf(mine[t2].name), checked: !!rwOn && rwOn.id === mine[t2].id });
        }
        if (rwOn && !titems2.some(function (x) {
          return x.value === "t:" + rwOn.id;
        })) titems2.push({ value: "t:" + rwOn.id, label: rwOn.name, sub: trainedPanel.subOf(rwOn) + (rwOn.public ? " · Public" : ""), title: trainedPanel.titleOf(rwOn), thumb: rwOn.thumb, mono: monoOf(rwOn.name), checked: true });
        if (titems2.length) groups.push({ title: "Your trained models", items: titems2 });
      }
      var rows = o.catalog.rows();
      var tool = lane === "image" || lane === "edit" ? null : lane;
      var tab = map.laneTab(lane);
      var ids = map.picks(rows, tab);
      var cat = [];
      for (var r = 0; r < rows.length && cat.length < 16; r++) {
        var row = rows[r];
        if (row.id === rec || map.hidden(row) || !map.isBase(row)) continue;
        var lanes = map.lanesOf(row);
        if (lanes.indexOf(tool || lane) < 0) continue;
        if (ids.length && ids.indexOf(row.id) < 0 && cat.length >= ids.length) continue;
        cat.push({ value: row.id, label: row.name, thumb: thumbs.modelThumb(row), mono: monoOf(row.name), checked: !rwOn && st.models[mkey] === row.id });
      }
      // Only models that can take the layer (verification pass 2026-10-22:
      // Gemini 3.1, Seedream 5.0 Pro and Grok Imagine were offered for Make
      // versions and then blocked the button). The chosen one stays shown.
      var fed = await Promise.all(
        cat.map(function (c) {
          return feedsLayer(id, c.value);
        })
      );
      cat = cat
        .filter(function (c, i) {
          return fed[i] || c.checked;
        })
        .slice(0, 8);
      if (cat.length) groups.push({ title: "Catalog · can " + a.label.toLowerCase(), items: cat });
      // Each model's price for this document and these settings.
      var mvals = [];
      for (var mg2 = 0; mg2 < groups.length; mg2++) for (var mi2 = 0; mi2 < groups[mg2].items.length; mi2++) mvals.push(groups[mg2].items[mi2].value);
      var mp2 = await optionPrices(id, mvals, "model", rwOn ? "t:" + rwOn.id : st.models[mkey] || null);
      var mprices = mp2.prices;
      for (var mg3 = 0; mg3 < groups.length; mg3++) for (var mi3 = 0; mi3 < groups[mg3].items.length; mi3++) groups[mg3].items[mi3].right = mprices[groups[mg3].items[mi3].value] || "";
      return { title: null, groups: groups, all: true, lane: lane, later: mp2.later, note: "Prices are price checks for this document and these settings." };
    }
    if (kind === "adv") {
      var nm = schema ? schema.name : "";
      return { title: "Advanced" + (nm ? " · " + nm : ""), rows: advancedFor(id, schema) };
    }
    if (kind === "addref") {
      var raw = st.raw || {};
      var add = [];
      if (raw.doc && (raw.selection || raw.selection_raw)) add.push({ value: "selection", label: "Selection", sub: "What is inside the marching ants" });
      if (raw.doc) add.push({ value: "layer", label: "Layer", sub: "The active layer" }, { value: "visible", label: "All visible", sub: "The document as it looks now" });
      add.push({ value: "file", label: "File…", sub: "An image on this computer" });
      if (o.library) add.push({ value: "library", label: "Library", sub: "An image of this project" });
      var groups2 = [{ title: "Add a reference", items: add }];
      if (raw.doc && raw.layer) {
        groups2.push({
          title: "Pin the layer as a document reference",
          items: docRefsMod.ROLES.map(function (role) {
            return { value: "pin:" + role, label: role, sub: "Shows first in every action, travels with the PSD" };
          })
        });
      }
      return { title: null, groups: groups2 };
    }
    return { title: null, items: [] };
  }

  // ---- startup ----

  if (o.host && typeof o.host.readDataText === "function") {
    Promise.resolve(o.host.readDataText(PINS_FILE)).then(
      function (text) {
        try {
          var v = text ? JSON.parse(text) : null;
          if (v && typeof v === "object") {
            for (var k in v) if (Array.isArray(v[k])) st.pins[k] = v[k].filter(function (x) {
              return actionsMod.inMore(k, x);
            });
          }
        } catch (e) {
          // no pins yet
        }
        emit();
      },
      function () {}
    );
  }
  if (o.ledger && typeof o.ledger.onChange === "function") {
    o.ledger.onChange(function (rec) {
      var latest = latestRecord();
      if (rec && latest && rec.local_id === latest.local_id && rec.state === "applied") refresh();
      else emit();
    });
  }
  // Runs whose group is selected once it lands (actions with selectGroup).
  var selectAfter = {};
  // Frame to layer runs: once the frame lands, Animate is picked with it
  // as the first frame of the next clip (FLOWS v2, changes after review 14).
  var afterFrame = {};
  function frameLanded(localId) {
    delete afterFrame[localId];
    st.action = "animate";
    st.keepAction = true;
    st.clip = null;
    st.note = TEXT.frame_next;
  }
  async function selectLanded(localId) {
    delete selectAfter[localId];
    var rec = o.ledger ? o.ledger.get(localId) : null;
    var pl = rec && rec.placement;
    var at = pl ? pl.group_id || (pl.layer_ids || [])[0] : null;
    if (!at || pl.document_id !== docId() || typeof o.host.selectLayer !== "function") return;
    try {
      await o.host.selectLayer(pl.document_id, at);
    } catch (e) {
      log("panel: select the landed group failed");
    }
  }
  if (o.runner && typeof o.runner.onEvent === "function") {
    o.runner.onEvent(function (ev) {
      if (ev && ev.type === "placed") {
        if (afterFrame[ev.local_id]) frameLanded(ev.local_id);
        if (selectAfter[ev.local_id]) selectLanded(ev.local_id).then(refresh);
        else refresh();
      } else emit();
    });
  }

  return {
    model: model,
    menu: menu,
    onChange: function (fn) {
      listeners.push(fn);
    },
    activate: function () {
      if (st.active) return refresh();
      st.active = true;
      if (o.catalog && typeof o.catalog.ensure === "function") o.catalog.ensure().catch(function () {});
      st.price = { state: "idle" };
      return refresh();
    },
    documentChanged: function () {
      return refresh();
    },
    refresh: refresh,
    selectAction: selectAction,
    setPrompt: setPrompt,
    setSelect: setSelect,
    libraryPick: libraryPick,
    libraryCancel: libraryCancel,
    librarySearch: librarySearch,
    libraryFilter: libraryFilter,
    libraryMore: libraryMore,
    libraryReload: function () {
      return loadLibrary(true);
    },
    // Signed in, out or to another project: the grid is read again when it
    // shows next.
    resetLibrary: function () {
      st.lib = { state: "idle", rows: [], more: false, error: null };
    },
    cardAction: cardAction,
    choose: choose,
    togglePin: togglePin,
    toggleDocRef: toggleDocRef,
    addRef: addRef,
    removeRef: removeRef,
    pinDocRef: pinDocRef,
    unpinDocRef: unpinDocRef,
    go: go,
    confirmOk: confirmOk,
    confirmCancel: confirmCancel,
    showTake: showTake,
    keep: keep,
    refine: refine,
    moreLike: function () {
      st.keepAction = st.ctx.kind !== "takes";
      selectAction("more_like");
    },
    closeCard: closeCard,
    placeCard: placeCard,
    openRecent: openRecent,
    // F5: an agent's request to spend, shown above the composer until it
    // is approved or declined. req: { client_name, what, prompt, model_name,
    // cu, approve(), decline() }. Agent spending runs through the agent
    // link (M6); until then nothing calls this, so the card never shows.
    showAgentRequest: function (req) {
      st.agent = req || null;
      emit();
    },
    // F14: an agent's plan of several steps (the agent link sends it; until
    // a plan request exists nothing calls this, so the card never shows).
    // plan: { client_name, steps: [{ label, cu, state }], total_cu,
    // approve_all(), step_by_step(), decline() }, or null to clear it.
    showAgentPlan: function (plan) {
      st.plan = plan || null;
      emit();
    },
    planDecision: planDecision,
    agentDecision: function (yes) {
      var req = st.agent;
      // An approval going through can no longer be declined (verification
      // pass 2026-10-22: the card came back with both buttons live, and
      // Decline said nothing was spent while the charge went on).
      if (req && req.busy) return;
      st.agent = null;
      if (req) {
        if (yes && typeof req.approve === "function") req.approve();
        if (!yes && typeof req.decline === "function") req.decline();
        if (!yes) st.note = TEXT.declined;
      }
      emit();
    },
    // The model chosen in the full model list (ui/picker.js).
    // All models…: a base model sets the Model chip; a trained row runs
    // with that trained model on its base (Run with, M7).
    chooseModel: function (row) {
      if (!row || !row.id) return Promise.resolve(false);
      if (row.type && row.type !== "custom") return runWithRow(row);
      var id = st.action;
      return feedsLayer(id, row.id).then(function (ok) {
        if (!ok) {
          st.note = TEXT.no_layer_input(row.name || row.id, A[id] ? A[id].label : null);
          emit();
          return false;
        }
        choose("model", row.id);
        return true;
      });
    },
    state: function () {
      return { action: st.action, kind: st.ctx.kind, prompt: st.prompt, select: st.selectText, price: st.price, sending: st.sending, confirm: st.confirm, note: st.note, latest: st.latest, active: st.active, key: st.key, pins: st.pins, refs: st.refs.length, drefs: st.drefs.slice(), style: st.style ? (st.style.match ? "match" : st.style.id) : null, runWith: st.runWith ? st.runWith.id : null, models: JSON.parse(JSON.stringify(st.models)) };
    },
    TEXT: TEXT
  };
}

module.exports = { createController: createController, errText: errText, layerTitle: layerTitle, classify: classify, takesOf: takesOf, isCutout: isCutout, badgeOf: badgeOf, cuOf: cuOf, needsConfirm: needsConfirm, TEXT: TEXT, DEBOUNCE_MS: DEBOUNCE_MS, TARGETS: TARGETS, CHANGE: CHANGE };
