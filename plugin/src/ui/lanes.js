"use strict";
// The lane bodies and the prompt bar (SPEC 3.2, 3.6, 3.7, 3.9): the model
// card, the lane's options, the Image lane's references, the results tray,
// and the Generate button carrying the price, from a price check that runs
// 400 ms after the form stops changing. Price checks start once the panel
// has been shown or the person used it, never at Photoshop's launch.
//
// Generate runs in the Image lane: a click on a priced button is the
// approval, with an inline confirm above the confirm limit (100 CU by
// default; M for a range; always for a `from` price). The request is built
// again at the click, so a document, selection or setting changed since the
// price check makes the quote mismatch: nothing is spent and the button
// shows the new price. Other lanes show their price and stay disabled.

var MAP = require("../../../shared/catalog-map.json");
var map = require("../catalog/map.js");
var requests = require("../forms/requests.js");
var price = require("../forms/price.js");
var jobsText = require("./jobs-text.js");

var DEBOUNCE_MS = 400;
var TAKES = [1, 2, 4];

var TEXT = {
  sample_prompt: "A lighthouse on a rocky coast at dawn, soft watercolor",
  generate: "Generate",
  checking: "Checking price...",
  unavailable: "Price unavailable",
  after_upload: "Generate (price after upload)",
  after_upload_reason: "This model's price depends on a file no blank image can stand in for; it is priced once uploaded.",
  lane_later: "This lane generates in a later build. The Image lane generates now.",
  sending: "Sending...",
  sent: "Sent. The result lands here when it is ready.",
  changed: "The document or the settings changed since the price check. Check the new price, then click again.",
  selection_note: "Makes a new picture, masked to the selection. To change what is inside it, use Edit.",
  adding: "Adding reference...",
  no_refs: "This model takes no references.",
  first_run_file: "first-run.json",
  no_refund: "No refund if it fails",
  no_document: "Open or create a document to use this lane.",
  alarm: "A price check created a job on Scenario. Price checks are stopped until Photoshop restarts.",
  expand_later: "Canvas size and anchor controls for Expand come in a later build, so this lane shows no price yet.",
  trained_later: "Trained models run in a later build. Use Change to browse them.",
  trained_none: "No trained model chosen.",
  library_later: "The Library comes in a later build.",
  loading: "Loading model",
  model_failed: "Model could not load",
  not_signed_in: "Sign in to see prices."
};

function sizeKey(w, h) {
  return w + "x" + h;
}

function parseSize(v) {
  var m = /^(\d+)x(\d+)$/.exec(String(v || ""));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

// The preset nearest in ratio to the box, then the smallest (SPEC 3.7: the
// default size matches the target box aspect).
function nearestSize(sizes, box) {
  var want = Math.log(box.width / box.height);
  var best = null;
  for (var i = 0; i < sizes.length; i++) {
    var s = sizes[i];
    var d = Math.abs(Math.log(s.width / s.height) - want);
    var a = s.width * s.height;
    if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && a < best.a)) best = { d: d, a: a, s: s };
  }
  return best ? best.s : null;
}

// SPEC 5.8 grid shaping for the Edit lane: the canvas read at most at the
// capture's long side, each axis rounded up to the model's step.
function shapeBox(doc, sizeInputs) {
  var long = Math.max(doc.width, doc.height);
  var cap = MAP.capture.default_long_side_px;
  if (sizeInputs.kind === "grid" && sizeInputs.max) cap = Math.min(cap, sizeInputs.max);
  var s = long > cap ? cap / long : 1;
  var step = sizeInputs.kind === "grid" ? sizeInputs.step || 1 : 1;
  function axis(v) {
    var n = Math.max(1, Math.round(v * s));
    n = Math.ceil(n / step) * step;
    if (sizeInputs.kind === "grid") {
      if (sizeInputs.max) while (n > sizeInputs.max) n -= step;
      if (sizeInputs.min && n < sizeInputs.min) n = Math.ceil(sizeInputs.min / step) * step;
    }
    return n;
  }
  return { width: axis(doc.width), height: axis(doc.height) };
}

function sameBox(a, b) {
  if (!a || !b) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function param(schema, name) {
  for (var i = 0; i < schema.parameters.length; i++) if (schema.parameters[i].name === name) return schema.parameters[i];
  return null;
}

// o: { catalog, quotes, host, account() -> {id} | null, openPicker(tab, tool),
//      log, timers, runner, references, ledger, settings, openJobs() }
function createLanes(doc, o) {
  if (!doc || typeof doc.getElementById !== "function") return null;
  var timers = o.timers || { setTimeout: setTimeout, clearTimeout: clearTimeout };
  var log = o.log || function () {};
  var st = {
    active: false,
    lane: "image",
    tool: "upscale",
    models: {},
    takes: {},
    sizes: {},
    factor: null,
    schema: null,
    schemaFor: null,
    seq: 0,
    timer: null,
    price: { state: "idle", label: null, reason: null, no_refund: false, quote: null },
    refs: [],
    sending: false,
    confirm: null,
    selection: null,
    signature: null,
    latest: null,
    note: "",
    firstRun: { generated: false, meta_note: false },
    shown: false
  };

  function byId(id) {
    return doc.getElementById(id);
  }
  function setText(id, text) {
    var el = byId(id);
    if (el) el.textContent = text || "";
  }
  // display: "block" for elements the stylesheet hides until shown (banners).
  function show(id, on, display) {
    var el = byId(id);
    if (el && el.style) el.style.display = on ? display || "" : "none";
  }
  function bind(id, type, fn) {
    var el = byId(id);
    if (el) el.addEventListener(type, fn);
  }
  function fillSelect(id, options, selected) {
    var el = byId(id);
    if (!el || typeof doc.createElement !== "function") return;
    while (el.firstChild) el.removeChild(el.firstChild);
    for (var i = 0; i < options.length; i++) {
      var opt = doc.createElement("option");
      opt.setAttribute("value", options[i].value);
      if (options[i].value === selected) opt.setAttribute("selected", "");
      opt.textContent = options[i].label;
      el.appendChild(opt);
    }
    el.value = selected;
  }

  function key() {
    return st.lane === "enhance" ? st.tool : st.lane;
  }

  function modelFor(k) {
    if (st.models[k]) return st.models[k];
    var d = map.defaults(k);
    return d ? d.model_id : null;
  }

  function preset(k, modelId) {
    var d = map.defaults(k);
    return d && d.model_id === modelId ? d.preset : {};
  }

  function takesFor(k) {
    if (st.takes[k]) return st.takes[k];
    var d = map.defaults(k);
    return d ? d.takes : 1;
  }

  function promptText() {
    var el = byId("prompt");
    return el ? String(el.value || "").trim() : "";
  }

  function docSize() {
    try {
      return o.host.documentSize(null);
    } catch (e) {
      return null;
    }
  }

  function setPrice(p) {
    st.price = p;
    renderButton();
  }

  function canGenerate() {
    if (st.lane !== "image" || st.sending || st.confirm || st.price.state !== "ready") return false;
    if (o.runner && o.runner.pausedFor() > 0) return false;
    return !!o.runner;
  }

  function renderButton() {
    var p = st.price;
    var label = TEXT.generate;
    if (st.sending) label = TEXT.sending;
    else if (p.state === "checking") label = TEXT.checking;
    else if (p.state === "ready") label = TEXT.generate + " (" + p.label + ")";
    else if (p.state === "after_upload") label = TEXT.after_upload;
    else if (p.state === "unavailable") label = TEXT.unavailable;
    setText("generate", label);
    var btn = byId("generate");
    if (btn) {
      if (canGenerate()) btn.removeAttribute("disabled");
      else btn.setAttribute("disabled", "");
    }
    var reason = p.state === "unavailable" || p.state === "after_upload" ? p.reason : "";
    var wait = o.runner ? o.runner.pausedFor() : 0;
    if (!reason && wait > 0 && st.lane === "image") reason = "Not sent: Scenario asked to wait " + wait + " s.";
    setText("generate-reason", reason);
    setText("generate-refund", p.no_refund ? TEXT.no_refund : "");
    var noteText = st.note;
    if (!noteText && st.lane !== "image" && st.lane !== "library") noteText = TEXT.lane_later;
    setText("generate-note", noteText);
    show("confirm-card", !!st.confirm);
  }

  // Which controls the lane shows.
  function renderLane() {
    var lane = st.lane;
    var hasForm = lane !== "library";
    show("enhance-tools", lane === "enhance");
    for (var i = 0; i < map.TOOLS.length; i++) {
      var b = byId("tool-" + map.TOOLS[i]);
      if (!b) continue;
      if (map.TOOLS[i] === st.tool) b.setAttribute("selected", "");
      else b.removeAttribute("selected");
    }
    show("model-card", hasForm);
    show("prompt-bar", hasForm);
    show("lane-source", hasForm);
    show("refs-section", lane === "image" && !!refInput());
    renderTray();
    show("size-row", false);
    show("factor-row", false);
    show("takes-row", false);
    setText("lane-output", "");
    setText("lane-source", "");
    setText("lane-note", lane === "library" ? TEXT.library_later : "");
    if (lane === "trained") {
      setText("model-name", TEXT.trained_none);
      setText("model-badges", "");
      setText("lane-note", TEXT.trained_later);
      setPrice({ state: "unavailable", label: null, reason: TEXT.trained_later, no_refund: false });
    }
  }

  function renderModel(schema) {
    setText("model-name", schema.name);
    var badges = [];
    for (var i = 0; i < schema.file_inputs.length; i++) {
      var f = schema.file_inputs[i];
      if (f.role === "mask") badges.push("Mask input");
      if (f.role === "reference" && f.max) badges.push("Up to " + f.max + " references");
    }
    var out = schema.output_max_px || (schema.size_inputs.kind === "grid" ? schema.size_inputs.max : null);
    if (out) badges.push("Max output " + out + " px");
    setText("model-badges", badges.join(" · "));
  }

  // The lane's form for the current schema: options shown and the request.
  // sel: the active document's selection bounds (Image lane), or null.
  function form(schema, sel) {
    var k = key();
    var lane = k;
    var params = {};
    var pre = preset(k, schema.model_id);
    for (var name in pre) params[name] = pre[name];
    var prompt = promptText();
    if (schema.prompt_input && prompt) params[schema.prompt_input] = prompt;
    var d = docSize();
    var takes = null;
    if (schema.takes_input && (lane === "image" || lane === "edit")) {
      var max = schema.takes_max || 1;
      var options = TAKES.filter(function (n) {
        return n <= max;
      });
      var t = takesFor(k);
      if (options.indexOf(t) < 0) t = options[0] || 1;
      fillSelect(
        "takes-select",
        options.map(function (n) {
          return { value: String(n), label: String(n) };
        }),
        String(t)
      );
      show("takes-row", true);
      takes = t;
    }
    var out = { lane: lane, params: params, takes: takes, target: null, source: null, blocked: null };
    var si = schema.size_inputs;
    if (lane === "image") {
      var box = d ? { width: d.width, height: d.height } : { width: 1024, height: 1024 };
      if (d && sel) {
        box = { width: sel.width, height: sel.height };
        out.target = { kind: "selection", document_id: d.id, box: [sel.left, sel.top, sel.width, sel.height] };
        setText("lane-source", "Target: selection " + sel.width + " x " + sel.height + ", lands masked to the selection");
        setText("lane-note", TEXT.selection_note);
      } else {
        out.target = d ? { kind: "canvas", document_id: d.id, box: [0, 0, d.width, d.height] } : { kind: "new_document", width: 1024, height: 1024 };
        setText("lane-source", d ? "Target: canvas " + d.width + " x " + d.height : "Target: a new document");
        if (st.lane === "image") setText("lane-note", "");
      }
      if (si.kind === "grid") {
        var sizes = si.sizes.filter(function (s) {
          return s.width >= (si.min || 1) && s.height >= (si.min || 1) && s.width <= (si.max || 16384) && s.height <= (si.max || 16384);
        });
        if (!sizes.length) {
          var fit = shapeBox({ width: box.width, height: box.height }, { kind: "grid", step: si.step, min: si.min, max: Math.min(si.max || 1024, 1024) });
          sizes = [{ width: fit.width, height: fit.height, label: fit.width + " x " + fit.height }];
        }
        var chosen = parseSize(st.sizes[schema.model_id]);
        var valid = chosen && sizes.some(function (s) {
          return s.width === chosen.width && s.height === chosen.height;
        });
        if (!valid) chosen = nearestSize(sizes, box);
        fillSelect(
          "size-select",
          sizes.map(function (s) {
            return { value: sizeKey(s.width, s.height), label: s.label };
          }),
          sizeKey(chosen.width, chosen.height)
        );
        show("size-row", true);
        params[si.width_input] = chosen.width;
        params[si.height_input] = chosen.height;
        // SPEC 3.8: with no document, the result opens as a new document at the Size preset.
        if (out.target.kind === "new_document") {
          out.target = { kind: "new_document", width: chosen.width, height: chosen.height };
          setText("lane-source", "Target: a new document " + chosen.width + " x " + chosen.height);
        }
      }
      out.references = st.refs.length;
      return out;
    }
    if (!d) {
      out.blocked = TEXT.no_document;
      return out;
    }
    out.source = { width: d.width, height: d.height };
    out.target = { kind: "canvas", document_id: d.id, box: [0, 0, d.width, d.height] };
    if (lane === "edit") {
      var shaped = shapeBox(d, si);
      if (si.kind === "grid") {
        params[si.width_input] = shaped.width;
        params[si.height_input] = shaped.height;
      }
      setText("lane-source", "Source: canvas " + d.width + " x " + d.height + ", sent at " + shaped.width + " x " + shaped.height);
      return out;
    }
    if (lane === "expand") {
      setText("lane-source", "Canvas " + d.width + " x " + d.height);
      out.blocked = TEXT.expand_later;
      return out;
    }
    var capped = d;
    var long = Math.max(d.width, d.height);
    if (long > MAP.stand_ins.read_cap_px) {
      var r = MAP.stand_ins.read_cap_px / long;
      capped = { width: Math.round(d.width * r), height: Math.round(d.height * r) };
    }
    setText("lane-source", "Source: all visible, " + d.width + " x " + d.height + (capped !== d ? ", read at " + capped.width + " x " + capped.height : ""));
    if (lane === "upscale") {
      var fp = param(schema, "upscaleFactor");
      if (fp && fp.enum) {
        var factors = fp.enum.filter(function (v) {
          return /^\d+(\.\d+)?x$/.test(v);
        });
        var f = st.factor && factors.indexOf(st.factor) >= 0 ? st.factor : params.upscaleFactor || fp.default || factors[0];
        fillSelect(
          "factor-select",
          factors.map(function (v) {
            return { value: v, label: v };
          }),
          f
        );
        show("factor-row", true);
        params.upscaleFactor = f;
        var factor = parseFloat(f);
        var ow = Math.round(capped.width * factor);
        var oh = Math.round(capped.height * factor);
        var omax = schema.output_max_px;
        var note = "";
        if (omax && Math.max(ow, oh) > omax) {
          var k2 = omax / Math.max(ow, oh);
          ow = Math.round(ow * k2);
          oh = Math.round(oh * k2);
          note = " (this model's largest output)";
        }
        setText("lane-output", "Output " + ow + " x " + oh + note);
      }
      return out;
    }
    if (lane === "remove_background") {
      var cap = schema.output_max_px;
      if (cap && long > cap) setText("lane-output", "Mask at " + Math.round((cap / long) * 100) + "% of the layer's resolution");
    }
    return out;
  }

  async function loadSchema(modelId) {
    if (st.schemaFor === modelId && st.schema) return st.schema;
    setText("model-name", TEXT.loading);
    setText("model-badges", "");
    var s = await o.catalog.schema(modelId);
    st.schema = s;
    st.schemaFor = modelId;
    return s;
  }

  async function check(seq) {
    if (seq !== st.seq) return;
    var k = key();
    if (st.lane === "trained" || st.lane === "library") return;
    if (!o.account()) {
      setPrice({ state: "unavailable", label: null, reason: TEXT.not_signed_in, no_refund: false });
      return;
    }
    var modelId = modelFor(k);
    var schema;
    try {
      schema = await loadSchema(modelId);
    } catch (e) {
      if (seq !== st.seq) return;
      setText("model-name", TEXT.model_failed);
      setText("model-badges", "");
      setPrice({ state: "unavailable", label: null, reason: e.message || String(e), no_refund: false });
      return;
    }
    if (seq !== st.seq) return;
    renderModel(schema);
    var sel = null;
    if (st.lane === "image") {
      var dsz = docSize();
      if (dsz) {
        try {
          sel = await o.host.selectionBounds(dsz.id);
        } catch (e) {
          sel = null;
        }
      }
      if (seq !== st.seq) return;
      st.selection = sel;
      st.signature = signatureOf(dsz, sel);
    }
    renderRefs();
    var f = form(schema, sel);
    if (f.blocked) {
      setPrice({ state: "unavailable", label: null, reason: f.blocked, no_refund: schema.no_refund });
      return;
    }
    if (o.quotes.stopped()) {
      setPrice({ state: "unavailable", label: null, reason: TEXT.alarm, no_refund: schema.no_refund });
      return;
    }
    setPrice({ state: "checking", label: null, reason: null, no_refund: schema.no_refund });
    try {
      var req = requests.build(schema, { lane: f.lane, model_id: modelId, parameters: f.params, takes: f.takes, target: f.target, source_size: f.source, references: f.references || 0 });
      var q = await o.quotes.estimate(req);
      if (seq !== st.seq) return;
      setPrice({ state: "ready", label: q.label, reason: null, no_refund: q.no_refund, quote: q, req: req, schema: schema });
    } catch (e) {
      if (seq !== st.seq) return;
      if (e && e.afterUpload) setPrice({ state: "after_upload", label: null, reason: TEXT.after_upload_reason, no_refund: schema.no_refund });
      else if (e && e.type === "DryRunCreatedJob") setPrice({ state: "unavailable", label: null, reason: TEXT.alarm, no_refund: schema.no_refund });
      else setPrice({ state: "unavailable", label: null, reason: e && e.message ? e.message : String(e), no_refund: schema.no_refund });
      log("price check: " + ((e && e.type) || "Internal"));
    }
  }

  // ---- references (Image lane) ----

  function refInput() {
    var schema = st.schema && st.schemaFor === modelFor("image") ? st.schema : null;
    return schema ? requests.referenceInput(schema) : null;
  }

  function renderRefs() {
    var input = st.lane === "image" ? refInput() : null;
    show("refs-section", !!input);
    if (!input) return;
    var max = input.multiple ? input.max || null : 1;
    setText("refs-title", "REFERENCES (" + st.refs.length + (max ? " of " + max : "") + ")");
    var full = max !== null && st.refs.length >= max;
    var add = ["refs-add-selection", "refs-add-layer", "refs-add-visible", "refs-add-file"];
    for (var i = 0; i < add.length; i++) {
      var b = byId(add[i]);
      if (!b) continue;
      if (full || st.sending) b.setAttribute("disabled", "");
      else b.removeAttribute("disabled");
    }
    var box = byId("refs-list");
    if (!box || typeof doc.createElement !== "function") return;
    while (box.firstChild) box.removeChild(box.firstChild);
    for (var r = 0; r < st.refs.length; r++) {
      (function (ref) {
        var row = doc.createElement("div");
        row.setAttribute("class", "row");
        row.setAttribute("data-ref", ref.id);
        var t = doc.createElement("sp-body");
        t.setAttribute("size", "XS");
        t.setAttribute("class", "grow");
        t.textContent = ref.label + ", sent at " + ref.width + " x " + ref.height + (ref.reduced ? " · Input reduced" : "");
        row.appendChild(t);
        var x = doc.createElement("sp-action-button");
        x.setAttribute("quiet", "");
        x.textContent = "Remove";
        x.addEventListener("click", function () {
          st.refs = st.refs.filter(function (q) {
            return q.id !== ref.id;
          });
          renderRefs();
          changed();
        });
        row.appendChild(x);
        box.appendChild(row);
      })(st.refs[r]);
    }
  }

  function addReference(source) {
    activate();
    if (!o.references) return;
    var modelId = modelFor("image");
    var input = refInput();
    if (!input) {
      setText("refs-note", TEXT.no_refs);
      return;
    }
    setText("refs-note", TEXT.adding);
    var d = docSize();
    var work = source === "file" ? o.references.chooseFile(modelId) : o.references.capture(source, d ? d.id : null, modelId, null);
    Promise.resolve(work).then(
      function (ref) {
        setText("refs-note", "");
        if (!ref) return;
        st.refs.push(ref);
        renderRefs();
        changed();
      },
      function (e) {
        setText("refs-note", (e && e.message) || String(e));
        log("reference: " + ((e && e.type) || "error"));
      }
    );
  }

  // ---- the results tray (SPEC 3.9) ----

  function renderTray() {
    var rec = st.latest && o.ledger ? o.ledger.get(st.latest) : null;
    show("tray", !!rec && st.lane === "image");
    if (!rec) return;
    var t = jobsText.tray(rec);
    setText("tray-status", t.status);
    setText("tray-detail", t.detail);
    setText("tray-badges", t.badges);
    show("tray-place", t.place);
    show("tray-open", t.open);
  }

  function trayAction(newDocument) {
    if (!st.latest || !o.runner) return;
    o.runner.place(st.latest, newDocument ? { new_document: true } : {}).then(
      function () {
        renderTray();
      },
      function (e) {
        st.note = (e && e.message) || String(e);
        renderButton();
        renderTray();
      }
    );
  }

  // ---- banners (SPEC 3.12, 3.9) ----

  function saveFirstRun() {
    if (o.host && typeof o.host.writeDataText === "function") o.host.writeDataText(TEXT.first_run_file, JSON.stringify(st.firstRun));
  }

  function renderBanners() {
    var signedIn = !!o.account();
    setText("ready-banner-text", jobsText.TEXT.ready_banner);
    show("ready-banner", signedIn && !st.firstRun.generated && !st.firstRun.ready_closed, "block");
    setText("meta-banner-text", jobsText.TEXT.meta_banner);
    show("meta-banner", !!st.firstRun.meta_due, "block");
  }

  // ---- Generate ----

  function signatureOf(d, sel) {
    if (!d) return "none";
    return [d.id, d.width, d.height, sel ? [sel.left, sel.top, sel.width, sel.height].join(",") : "-"].join("|");
  }

  function thresholdFor() {
    var limit = o.settings && typeof o.settings.confirmAbove === "function" ? o.settings.confirmAbove() : 100000;
    return limit;
  }

  function confirmText(q, schema) {
    var t = price.toThousandths(q.cu_cost);
    var limitCu = price.exactString(thresholdFor());
    var text;
    if (q.price_kind === "from") text = "This generation costs from " + price.display(t) + " CU. The charge can be higher; Scenario gives no upper bound for this model.";
    else if (q.price_kind === "range") text = "This generation costs " + q.label + "; " + price.display(price.toThousandths(q.cu_cost_max)) + " CU is above your confirm limit of " + limitCu + " CU.";
    else text = "This generation costs " + q.label + ", above your confirm limit of " + limitCu + " CU.";
    var detail = [schema ? schema.name : null, st.price.req && st.price.req.takes ? st.price.req.takes + " take" + (st.price.req.takes === 1 ? "" : "s") : null].filter(Boolean).join(" · ");
    if (q.no_refund) detail += (detail ? ". " : "") + TEXT.no_refund;
    return { text: text, detail: detail, ok: "Generate (" + q.label + ")" };
  }

  function needsConfirm(q) {
    if (q.price_kind === "from") return true;
    var compare = q.price_kind === "range" && q.cu_cost_max !== null ? price.toThousandths(q.cu_cost_max) : price.toThousandths(q.cu_cost);
    return compare > thresholdFor();
  }

  function showConfirm(c) {
    st.confirm = c;
    setText("confirm-text", c.text);
    setText("confirm-detail", c.detail || "");
    setText("confirm-ok", c.ok);
    renderButton();
  }

  function clearConfirm() {
    st.confirm = null;
    renderButton();
  }

  function onGenerate() {
    activate();
    if (!canGenerate()) return;
    var q = st.price.quote;
    if (needsConfirm(q)) {
      var c = confirmText(q, st.price.schema);
      c.kind = "threshold";
      c.quote = q;
      showConfirm(c);
      return;
    }
    go(q);
  }

  async function go(q) {
    st.sending = true;
    st.note = "";
    if (!st.firstRun.generated) {
      st.firstRun.generated = true;
      saveFirstRun();
      renderBanners();
    }
    renderButton();
    renderRefs();
    try {
      var schema = st.price.schema;
      var d = docSize();
      var sel = null;
      if (d) {
        try {
          sel = await o.host.selectionBounds(d.id);
        } catch (e) {
          sel = null;
        }
      }
      // The request as it is now: a change since the price check makes the
      // quote mismatch, and nothing is spent.
      var f = form(schema, sel);
      var req = requests.build(schema, { lane: f.lane, model_id: schema.model_id, parameters: f.params, takes: f.takes, target: f.target, source_size: f.source, references: f.references || 0 });
      var mask = null;
      if (req.target && req.target.kind === "selection") {
        try {
          mask = await o.host.readSelectionMask(req.target.document_id);
        } catch (e) {
          mask = null;
        }
      }
      var title = null;
      if (d) {
        var docs = o.host.listDocuments();
        for (var i = 0; i < docs.length; i++) if (docs[i].id === d.id) title = docs[i].title;
      }
      var out = await o.runner.start({ req: req, quote: q, refs: st.refs.slice(), model_name: schema.name, document_title: title, mask: mask });
      st.latest = out.record ? out.record.local_id : st.latest;
      if (out.replayed) st.note = "This price was already used: see Jobs.";
      else if (out.state === "awaiting_approval") {
        showConfirm({ kind: "changed", local_id: out.record.local_id, text: "Price changed after upload. Now " + out.price + " CU (was " + out.was + " CU). Nothing was spent.", detail: "", ok: "Generate (" + out.price + " CU)" });
      } else if (out.state === "queued") st.note = TEXT.sent;
      else st.note = (out.record && out.record.error) || "";
    } catch (e) {
      var type = e && e.type;
      st.note = type === "QuoteMismatch" || type === "QuoteExpired" || type === "QuoteUsed" ? TEXT.changed : (e && e.message) || String(e);
      log("generate: " + (type || "error"));
    } finally {
      st.sending = false;
      renderRefs();
      renderTray();
      // A used quote never spends twice: the next click needs a new price.
      changed();
    }
  }

  function onConfirmOk() {
    var c = st.confirm;
    if (!c) return;
    if (c.kind === "threshold") {
      clearConfirm();
      go(c.quote);
      return;
    }
    if (c.kind === "changed") {
      st.sending = true;
      renderButton();
      o.runner.approve(c.local_id).then(
        function (out) {
          st.sending = false;
          if (out && out.state === "awaiting_approval" && out.changed) {
            showConfirm({ kind: "changed", local_id: c.local_id, text: "Price changed again. Now " + out.price + " CU. Nothing was spent.", detail: "", ok: "Generate (" + out.price + " CU)" });
            return;
          }
          st.confirm = null;
          st.note = out && out.state === "queued" ? TEXT.sent : (out && out.record && out.record.error) || "";
          renderButton();
          renderTray();
          changed();
        },
        function (e) {
          st.sending = false;
          st.confirm = null;
          st.note = (e && e.message) || String(e);
          renderButton();
          changed();
        }
      );
    }
  }

  function onConfirmCancel() {
    var c = st.confirm;
    clearConfirm();
    if (c && c.kind === "changed" && o.runner) {
      o.runner.decline(c.local_id).then(function () {
        renderTray();
      });
    }
  }

  // Photoshop notifications (coalesced by the host): reprice only when the
  // target changed (document, canvas size or selection).
  async function documentChanged() {
    if (!st.active || st.lane !== "image") {
      if (st.active && st.lane !== "trained" && st.lane !== "library") changed();
      return;
    }
    var d = docSize();
    var sel = null;
    if (d) {
      try {
        sel = await o.host.selectionBounds(d.id);
      } catch (e) {
        sel = null;
      }
    }
    if (signatureOf(d, sel) !== st.signature) changed();
  }

  // Runs the price check 400 ms after the last change.
  function schedule() {
    st.seq++;
    if (st.timer) timers.clearTimeout(st.timer);
    st.timer = null;
    if (!st.active) return;
    var seq = st.seq;
    st.timer = timers.setTimeout(function () {
      st.timer = null;
      check(seq);
    }, DEBOUNCE_MS);
  }

  function changed() {
    if (st.lane === "trained" || st.lane === "library") return;
    schedule();
  }

  function select(lane) {
    st.lane = lane;
    st.seq++;
    renderLane();
    if (lane !== "trained" && lane !== "library") {
      setPrice({ state: "idle", label: null, reason: null, no_refund: false });
      if (st.schema && st.schemaFor === modelFor(key())) renderModel(st.schema);
      else setText("model-name", st.active ? TEXT.loading : "");
      changed();
    }
  }

  function activate() {
    if (st.active) return;
    st.active = true;
    if (o.catalog) o.catalog.ensure().catch(function () {});
    // SPEC 3.7: the sample prompt is selected, so typing replaces it.
    var el = byId("prompt");
    if (el && el.value === TEXT.sample_prompt && typeof el.select === "function") {
      try {
        el.select();
      } catch (e) {
        // not every field can select
      }
    }
    changed();
  }

  bind("model-change", "click", function () {
    activate();
    o.openPicker(map.laneTab(key()), st.lane === "enhance" ? st.tool : null);
  });
  for (var i = 0; i < map.TOOLS.length; i++) {
    (function (tool) {
      bind("tool-" + tool, "click", function () {
        st.tool = tool;
        activate();
        select("enhance");
      });
    })(map.TOOLS[i]);
  }
  bind("takes-select", "change", function () {
    var v = Number(byId("takes-select").value);
    if (v > 0) st.takes[key()] = v;
    activate();
    changed();
  });
  bind("size-select", "change", function () {
    if (st.schemaFor) st.sizes[st.schemaFor] = byId("size-select").value;
    activate();
    changed();
  });
  bind("factor-select", "change", function () {
    st.factor = byId("factor-select").value;
    activate();
    changed();
  });
  bind("prompt", "input", function () {
    activate();
    changed();
  });
  // SPEC 3.7: Cmd+Enter (Ctrl+Enter) generates when the button shows a current price.
  bind("prompt", "keydown", function (ev) {
    if (ev && ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      if (typeof ev.preventDefault === "function") ev.preventDefault();
      onGenerate();
    }
  });
  bind("generate", "click", onGenerate);
  bind("confirm-ok", "click", onConfirmOk);
  bind("confirm-cancel", "click", onConfirmCancel);
  bind("refs-add-selection", "click", function () {
    addReference("selection");
  });
  bind("refs-add-layer", "click", function () {
    addReference("layer");
  });
  bind("refs-add-visible", "click", function () {
    addReference("visible");
  });
  bind("refs-add-file", "click", function () {
    addReference("file");
  });
  bind("tray-place", "click", function () {
    trayAction(false);
  });
  bind("tray-open", "click", function () {
    trayAction(true);
  });
  bind("tray-jobs", "click", function () {
    if (o.openJobs) o.openJobs();
  });
  bind("ready-banner-close", "click", function () {
    st.firstRun.ready_closed = true;
    saveFirstRun();
    renderBanners();
  });
  bind("meta-banner-close", "click", function () {
    st.firstRun.meta_due = false;
    saveFirstRun();
    renderBanners();
  });
  if (o.ledger) {
    o.ledger.onChange(function (rec) {
      if (rec && rec.local_id === st.latest) renderTray();
    });
  }
  if (o.runner) {
    o.runner.onEvent(function (ev) {
      if (ev.type === "placed" && !st.firstRun.meta_note) {
        st.firstRun.meta_note = true;
        st.firstRun.meta_due = true;
        saveFirstRun();
        renderBanners();
      }
      if (ev.local_id === st.latest) renderTray();
    });
  }
  if (o.host && typeof o.host.readDataText === "function") {
    Promise.resolve(o.host.readDataText(TEXT.first_run_file)).then(function (text) {
      try {
        var v = text ? JSON.parse(text) : null;
        if (v && typeof v === "object") {
          st.firstRun.generated = v.generated === true;
          st.firstRun.ready_closed = v.ready_closed === true;
          st.firstRun.meta_note = v.meta_note === true;
          st.firstRun.meta_due = v.meta_due === true;
        }
      } catch (e) {
        // a fresh first run
      }
      renderBanners();
    });
  }

  var promptEl = byId("prompt");
  if (promptEl && !promptEl.value) promptEl.value = TEXT.sample_prompt;
  renderLane();
  renderButton();
  renderBanners();

  return {
    select: function (lane) {
      if (lane !== st.lane) select(lane);
    },
    activate: activate,
    // After the picker closes: the lane's own parts show again.
    restore: function () {
      show("prompt-bar", st.lane !== "library");
    },
    refresh: function () {
      st.schema = st.schemaFor === modelFor(key()) ? st.schema : null;
      renderBanners();
      changed();
    },
    documentChanged: documentChanged,
    references: function () {
      return st.refs.slice();
    },
    latest: function () {
      return st.latest;
    },
    // A model chosen in the picker: it becomes the lane's model.
    choose: function (row) {
      var tabs = map.tabsOf(row);
      if (!tabs.length || row.type !== "custom") return false;
      var k = key();
      var lane = st.lane;
      if (lane === "enhance") {
        var tools = map.toolsOf(row);
        if (tools.indexOf(st.tool) < 0 && tools.length) st.tool = tools[0];
        k = st.tool;
      } else if (tabs.indexOf(lane) < 0) {
        lane = tabs[0];
        k = lane === "enhance" ? map.toolsOf(row)[0] : lane;
        if (lane === "enhance") st.tool = k;
      }
      st.models[k] = row.id;
      st.lane = lane;
      st.schema = null;
      st.schemaFor = null;
      activate();
      select(lane);
      return lane;
    },
    state: function () {
      return { lane: st.lane, key: key(), model_id: modelFor(key()), active: st.active, price: st.price, sending: st.sending, confirm: st.confirm, note: st.note, latest: st.latest };
    }
  };
}

module.exports = { createLanes: createLanes, TEXT: TEXT, shapeBox: shapeBox, nearestSize: nearestSize, DEBOUNCE_MS: DEBOUNCE_MS };
