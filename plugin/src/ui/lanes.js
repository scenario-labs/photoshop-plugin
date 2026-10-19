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
var icons = require("./icons.js");
var thumbs = require("./thumbs.js");
var uiDemo = require("../dev/ui-demo.js");

var DEBOUNCE_MS = 400;
var TAKES = [1, 2, 4];

var TEXT = {
  sample_prompt: "A lighthouse on a rocky coast at dawn, soft watercolor",
  generate: "Generate",
  checking: "Checking price...",
  unavailable: "Price unavailable",
  after_upload: "Generate (price after upload)",
  after_upload_reason: "This model is priced once its file is uploaded.",
  lane_later: "Generating here is not in this version yet. The Image lane generates now.",
  sending: "Sending...",
  sent: "Sent. The result lands here when it is ready.",
  changed: "The document or the settings changed since the price check. Check the new price, then click again.",
  selection_note: "Makes a new picture, masked to the selection. To change what is inside it, use Edit.",
  adding: "Adding reference...",
  no_refs: "This model takes no references.",
  first_run_file: "first-run.json",
  no_refund: "No refund if it fails",
  no_document: "Open or create a document to use this lane.",
  no_document_title: "No document open",
  alarm: "A price check created a job on Scenario. Price checks are stopped until Photoshop restarts.",
  expand_later: "Canvas size and anchor for Expand are not in this version yet, so there is no price.",
  trained_title: "Trained models",
  trained_later: "Generating with your project's trained models is not in this version yet. You can browse them.",
  trained_browse: "Browse trained models",
  trained_none: "No trained model chosen.",
  library_title: "Library",
  library_later: "Your project's images will show here. The Library is not in this version yet.",
  add_reference: "Add a reference",
  refs_full: "This model takes no more references.",
  remove_reference: "Remove",
  target_canvas: "Lands as a new layer over the whole canvas.",
  target_new: "No document is open: the result opens as a new document.",
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
//      log, timers, runner, references, ledger, settings, openJobs(),
//      urls (ui/thumbs.js createUrls, for reference pictures) }
function createLanes(doc, o) {
  if (!doc || typeof doc.getElementById !== "function") return null;
  var timers = o.timers || { setTimeout: setTimeout, clearTimeout: clearTimeout };
  var urls = o.urls || thumbs.createUrls(null);
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
  // Fills an sp-picker. UXP ignores a value set from code, so the chosen
  // item carries `selected`; the items are rebuilt only when they change, so
  // an open picker is not redrawn under the pointer.
  var pickerKeys = {};
  function fillSelect(id, options, selected) {
    var el = byId(id);
    if (!el || typeof doc.createElement !== "function") return;
    var sig = JSON.stringify([options, selected]);
    if (pickerKeys[id] === sig) return;
    pickerKeys[id] = sig;
    while (el.firstChild) el.removeChild(el.firstChild);
    var menu = doc.createElement("sp-menu");
    menu.setAttribute("slot", "options");
    for (var i = 0; i < options.length; i++) {
      var item = doc.createElement("sp-menu-item");
      item.setAttribute("value", options[i].value);
      if (options[i].value === selected) item.setAttribute("selected", "");
      item.textContent = options[i].label;
      menu.appendChild(item);
    }
    el.appendChild(menu);
    try {
      el.value = selected;
    } catch (e) {
      // the selected item already says it
    }
  }
  function setTitle(id, text) {
    var el = byId(id);
    if (el && el.setAttribute) el.setAttribute("title", text || "");
  }
  // The target chip: what the result lands on, with the explanation in its
  // tooltip. kind: selection | canvas | newdoc | visible | layer.
  function setTarget(label, kind, text, tip) {
    setText("target-label", label);
    icons.set(byId("target-icon"), kind);
    setText("lane-source", text);
    setTitle("target-chip", tip || "");
    show("target-row", !!text, "flex");
  }
  function times(w, h) {
    return w + " \u00d7 " + h;
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

  // An empty state in the lane body: icon, title, one line, an action.
  function renderEmpty(e) {
    show("lane-empty", !!e, "flex");
    if (!e) {
      setText("lane-note", "");
      return;
    }
    icons.set(byId("lane-empty-icon"), e.icon);
    setText("lane-empty-title", e.title);
    setText("lane-note", e.note);
    setText("lane-empty-action", e.action || "");
    show("lane-empty-action", !!e.action, "inline-flex");
    st.emptyAction = e.run || null;
  }

  // Which controls the lane shows.
  function renderLane() {
    var lane = st.lane;
    var hasForm = lane !== "library" && lane !== "trained";
    show("enhance-tools", lane === "enhance", "flex");
    for (var i = 0; i < map.TOOLS.length; i++) {
      var b = byId("tool-" + map.TOOLS[i]);
      if (!b) continue;
      if (map.TOOLS[i] === st.tool) b.setAttribute("selected", "");
      else b.removeAttribute("selected");
      b.className = map.TOOLS[i] === st.tool ? "seg-btn on" : "seg-btn";
    }
    show("model-card", hasForm, "flex");
    show("prompt-bar", hasForm);
    show("refs-section", lane === "image" && !!refInput());
    renderTray();
    show("size-row", false);
    show("factor-row", false);
    show("takes-row", false);
    setText("lane-output", "");
    setTarget("Target", "canvas", "", "");
    renderEmpty(null);
    if (lane === "library") renderEmpty({ icon: "library", title: TEXT.library_title, note: TEXT.library_later });
    if (lane === "trained") {
      renderEmpty({
        icon: "trained",
        title: TEXT.trained_title,
        note: TEXT.trained_later,
        action: TEXT.trained_browse,
        run: function () {
          o.openPicker("trained", null);
        }
      });
      setPrice({ state: "unavailable", label: null, reason: TEXT.trained_later, no_refund: false });
    }
  }

  // The model card: picture, name, and one line of what it takes.
  function renderModel(schema) {
    setText("model-name", schema.name);
    var badges = [];
    for (var i = 0; i < schema.file_inputs.length; i++) {
      var f = schema.file_inputs[i];
      if (f.role === "reference" && f.max) badges.push("Up to " + f.max + " references");
      if (f.role === "mask") badges.push("Mask");
    }
    var out = schema.output_max_px || (schema.size_inputs.kind === "grid" ? schema.size_inputs.max : null);
    if (out) badges.push(out + " px max");
    var row = schema.row || null;
    var line = badges.join(" · ") || (row && row.description) || "";
    setText("model-badges", line);
    setTitle("model-card", [schema.name, row && row.description, badges.join(" · ")].filter(Boolean).join("\n"));
    icons.set(byId("model-thumb-icon"), map.laneTab(key()) === "enhance" ? "enhance" : st.lane === "edit" ? "edit" : "image");
    thumbs.show(byId("model-thumb"), thumbs.modelThumb(row));
  }

  function clearModel(text) {
    setText("model-name", text);
    setText("model-badges", "");
    setTitle("model-card", "");
    thumbs.show(byId("model-thumb"), null);
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
          return { value: String(n), label: n + (n === 1 ? " take" : " takes") };
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
        setTarget("Target", "selection", "Selection " + times(sel.width, sel.height), TEXT.selection_note);
      } else {
        out.target = d ? { kind: "canvas", document_id: d.id, box: [0, 0, d.width, d.height] } : { kind: "new_document", width: 1024, height: 1024 };
        if (d) setTarget("Target", "canvas", "Canvas " + times(d.width, d.height), TEXT.target_canvas);
        else setTarget("Target", "newdoc", "New document", TEXT.target_new);
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
            return { value: sizeKey(s.width, s.height), label: String(s.label).replace(/(\d+) ?x ?(\d+)/, "$1 \u00d7 $2") };
          }),
          sizeKey(chosen.width, chosen.height)
        );
        show("size-row", true);
        params[si.width_input] = chosen.width;
        params[si.height_input] = chosen.height;
        // SPEC 3.8: with no document, the result opens as a new document at the Size preset.
        if (out.target.kind === "new_document") {
          out.target = { kind: "new_document", width: chosen.width, height: chosen.height };
          setTarget("Target", "newdoc", "New document " + times(chosen.width, chosen.height), TEXT.target_new);
        }
      }
      out.references = st.refs.length;
      return out;
    }
    if (!d) {
      out.blocked = TEXT.no_document;
      setTarget("Source", "canvas", "", "");
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
      setTarget("Source", "canvas", "Canvas " + times(d.width, d.height), "Sent to the model at " + times(shaped.width, shaped.height) + ".");
      return out;
    }
    if (lane === "expand") {
      setTarget("Source", "canvas", "Canvas " + times(d.width, d.height), "");
      out.blocked = TEXT.expand_later;
      return out;
    }
    var capped = d;
    var long = Math.max(d.width, d.height);
    if (long > MAP.stand_ins.read_cap_px) {
      var r = MAP.stand_ins.read_cap_px / long;
      capped = { width: Math.round(d.width * r), height: Math.round(d.height * r) };
    }
    setTarget("Source", "visible", "All visible " + times(d.width, d.height), capped !== d ? "Read at " + times(capped.width, capped.height) + "." : "All visible layers, merged.");
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
        setText("lane-output", "Output " + times(ow, oh) + note);
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
    clearModel(TEXT.loading);
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
      clearModel(TEXT.model_failed);
      setPrice({ state: "unavailable", label: null, reason: e.message || String(e), no_refund: false });
      return;
    }
    if (seq !== st.seq) return;
    renderModel(schema);
    // A model without a prompt (Upscale, Remove BG) shows no prompt field.
    show("prompt", !!schema.prompt_input);
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
    if (f.blocked === TEXT.no_document) renderEmpty({ icon: st.lane === "enhance" ? "enhance" : "edit", title: TEXT.no_document_title, note: TEXT.no_document });
    else renderEmpty(null);
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

  // References: one chip per image (its picture, a remove button, the
  // details in its tooltip), then a "+" that opens the sources menu.
  var refUrls = {};
  var refsMenuOpen = false;
  function refUrl(ref) {
    if (!Object.prototype.hasOwnProperty.call(refUrls, ref.id)) refUrls[ref.id] = urls.fromBytes(ref.bytes, ref.mime);
    return refUrls[ref.id];
  }
  function dropRef(id) {
    st.refs = st.refs.filter(function (q) {
      return q.id !== id;
    });
    if (Object.prototype.hasOwnProperty.call(refUrls, id)) {
      urls.release(refUrls[id]);
      delete refUrls[id];
    }
  }
  function refIcon(ref) {
    var l = String(ref.label || "");
    if (/^Selection/.test(l)) return "selection";
    if (/^Layer/.test(l)) return "layer";
    if (/^All visible/.test(l)) return "visible";
    return "file";
  }
  function setRefsMenu(open) {
    refsMenuOpen = !!open;
    show("refs-menu", refsMenuOpen, "flex");
  }

  function renderRefs() {
    var input = st.lane === "image" ? refInput() : null;
    show("refs-section", !!input);
    if (!input) {
      setRefsMenu(false);
      return;
    }
    var max = input.multiple ? input.max || null : 1;
    setText("refs-title", "References");
    setText("refs-count", st.refs.length ? st.refs.length + (max ? " of " + max : "") : max ? "Up to " + max : "");
    var full = max !== null && st.refs.length >= max;
    if (full || st.sending) setRefsMenu(false);
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
        var chip = doc.createElement("div");
        chip.className = "ref";
        chip.setAttribute("data-ref", ref.id);
        chip.setAttribute("title", ref.label + ", sent at " + times(ref.width, ref.height) + (ref.reduced ? ". Input reduced to fit the model." : "."));
        chip.appendChild(icons.icon(doc, refIcon(ref), "ref-icon"));
        var img = doc.createElement("img");
        img.className = "ref-img";
        img.setAttribute("alt", "");
        chip.appendChild(img);
        thumbs.show(img, refUrl(ref));
        if (ref.reduced) {
          var badge = doc.createElement("span");
          badge.className = "ref-badge";
          badge.textContent = "\u2193";
          chip.appendChild(badge);
        }
        var x = doc.createElement("div");
        x.className = "ref-x";
        x.setAttribute("data-remove", ref.id);
        x.setAttribute("title", TEXT.remove_reference);
        x.appendChild(icons.icon(doc, "close"));
        x.addEventListener("click", function () {
          if (st.sending) return;
          dropRef(ref.id);
          renderRefs();
          changed();
        });
        chip.appendChild(x);
        box.appendChild(chip);
      })(st.refs[r]);
    }
    var tile = doc.createElement("div");
    tile.className = full || st.sending ? "add-tile off" : "add-tile";
    tile.setAttribute("id", "refs-add");
    tile.setAttribute("title", full ? TEXT.refs_full : TEXT.add_reference);
    tile.appendChild(icons.icon(doc, "plus"));
    tile.addEventListener("click", function () {
      if (full || st.sending) return;
      activate();
      setRefsMenu(!refsMenuOpen);
    });
    box.appendChild(tile);
  }

  function addReference(source) {
    activate();
    setRefsMenu(false);
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
    renderTrayRecord(st.latest && o.ledger ? o.ledger.get(st.latest) : null);
  }

  // The tray: the latest job's status, its takes as pictures (take 1, the
  // visible layer once placed, carries a check), and Place / Open.
  function renderTrayRecord(rec) {
    show("tray", !!rec && st.lane === "image");
    if (!rec) return;
    var t = jobsText.tray(rec);
    setText("tray-status", t.status);
    setText("tray-detail", t.detail);
    setText("tray-badges", t.badges);
    show("tray-place", t.place);
    show("tray-open", t.open);
    var box = byId("tray-takes");
    if (!box || typeof doc.createElement !== "function") return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var outs = rec.outputs || [];
    for (var i = 0; i < outs.length; i++) {
      var out = outs[i] || {};
      var take = doc.createElement("div");
      var kept = rec.state === "applied" && i === 0;
      take.className = kept ? "take kept" : "take";
      take.setAttribute("title", "Take " + (i + 1) + (out.width ? ", " + times(out.width, out.height) : "") + (kept ? ". The visible layer." : out.state === "saved" ? "" : ". Not downloaded yet."));
      take.appendChild(icons.icon(doc, "image", "take-icon"));
      var img = doc.createElement("img");
      img.className = "take-img";
      img.setAttribute("alt", "");
      take.appendChild(img);
      thumbs.show(img, out.state === "saved" ? thumbs.resultThumb(out.path) : null);
      if (kept) take.appendChild(icons.icon(doc, "check", "take-mark"));
      box.appendChild(take);
    }
    show("tray-takes", outs.length > 0, "flex");
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
    setRefsMenu(false);
    renderLane();
    if (lane !== "trained" && lane !== "library") {
      setPrice({ state: "idle", label: null, reason: null, no_refund: false });
      if (st.schema && st.schemaFor === modelFor(key())) renderModel(st.schema);
      else clearModel(st.active ? TEXT.loading : "");
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
  bind("lane-empty-action", "click", function () {
    if (st.emptyAction) st.emptyAction();
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

  var api = {
    select: function (lane) {
      if (lane !== st.lane) select(lane);
    },
    activate: activate,
    // After the picker closes: the lane's own parts show again.
    restore: function () {
      show("prompt-bar", st.lane !== "library" && st.lane !== "trained");
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
  // Development builds only (a stub in release): sample states for looking
  // at the panel, drawn by the render code above.
  api.dev = uiDemo.hook("lanes", {
    st: st,
    renderRefs: renderRefs,
    renderTrayRecord: renderTrayRecord,
    renderButton: renderButton,
    setPrice: setPrice,
    setRefsMenu: setRefsMenu,
    dropRef: dropRef,
    showConfirm: showConfirm,
    clearConfirm: clearConfirm
  });
  return api;
}

module.exports = { createLanes: createLanes, TEXT: TEXT, shapeBox: shapeBox, nearestSize: nearestSize, DEBOUNCE_MS: DEBOUNCE_MS };
