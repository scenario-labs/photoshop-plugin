"use strict";
// The lane bodies and the prompt bar (SPEC 3.2, 3.6, 3.7): the model card,
// the lane's options, and the Generate button carrying the price. In this
// build the button stays disabled ("Generation comes in the next build"):
// it shows the price of what it would run, from a price check that runs
// 400 ms after the form stops changing. Price checks start once the panel
// has been shown or the person used it, never at Photoshop's launch.

var MAP = require("../../../shared/catalog-map.json");
var map = require("../catalog/map.js");
var requests = require("../forms/requests.js");
var price = require("../forms/price.js");

var DEBOUNCE_MS = 400;
var TAKES = [1, 2, 4];

var TEXT = {
  sample_prompt: "A lighthouse on a rocky coast at dawn, soft watercolor",
  generate: "Generate",
  checking: "Checking price...",
  unavailable: "Price unavailable",
  after_upload: "Generate (price after upload)",
  after_upload_reason: "This model's price depends on a file no blank image can stand in for; it is priced once uploaded.",
  not_built: "Generation comes in the next build.",
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

function param(schema, name) {
  for (var i = 0; i < schema.parameters.length; i++) if (schema.parameters[i].name === name) return schema.parameters[i];
  return null;
}

// o: { catalog, quotes, host, account() -> {id} | null, openPicker(tab, tool),
//      log, timers }
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
    price: { state: "idle", label: null, reason: null, no_refund: false, quote: null }
  };

  function byId(id) {
    return doc.getElementById(id);
  }
  function setText(id, text) {
    var el = byId(id);
    if (el) el.textContent = text || "";
  }
  function show(id, on) {
    var el = byId(id);
    if (el && el.style) el.style.display = on ? "" : "none";
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

  function renderButton() {
    var p = st.price;
    var label = TEXT.generate;
    if (p.state === "checking") label = TEXT.checking;
    else if (p.state === "ready") label = TEXT.generate + " (" + p.label + ")";
    else if (p.state === "after_upload") label = TEXT.after_upload;
    else if (p.state === "unavailable") label = TEXT.unavailable;
    setText("generate", label);
    var btn = byId("generate");
    if (btn) btn.setAttribute("disabled", "");
    setText("generate-reason", p.state === "unavailable" || p.state === "after_upload" ? p.reason : "");
    setText("generate-refund", p.no_refund ? TEXT.no_refund : "");
    setText("generate-note", TEXT.not_built);
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
  function form(schema) {
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
      out.target = d ? { kind: "canvas", document_id: d.id, box: [0, 0, d.width, d.height] } : { kind: "new_document", width: 1024, height: 1024 };
      setText("lane-source", d ? "Target: canvas " + d.width + " x " + d.height : "Target: a new document");
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
      }
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
    var f = form(schema);
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
      var req = requests.build(schema, { lane: f.lane, model_id: modelId, parameters: f.params, takes: f.takes, target: f.target, source_size: f.source });
      var q = await o.quotes.estimate(req);
      if (seq !== st.seq) return;
      setPrice({ state: "ready", label: q.label, reason: null, no_refund: q.no_refund, quote: q });
    } catch (e) {
      if (seq !== st.seq) return;
      if (e && e.afterUpload) setPrice({ state: "after_upload", label: null, reason: TEXT.after_upload_reason, no_refund: schema.no_refund });
      else if (e && e.type === "DryRunCreatedJob") setPrice({ state: "unavailable", label: null, reason: TEXT.alarm, no_refund: schema.no_refund });
      else setPrice({ state: "unavailable", label: null, reason: e && e.message ? e.message : String(e), no_refund: schema.no_refund });
      log("price check: " + ((e && e.type) || "Internal"));
    }
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

  var promptEl = byId("prompt");
  if (promptEl && !promptEl.value) promptEl.value = TEXT.sample_prompt;
  renderLane();
  renderButton();

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
      changed();
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
      return { lane: st.lane, key: key(), model_id: modelFor(key()), active: st.active, price: st.price };
    }
  };
}

module.exports = { createLanes: createLanes, TEXT: TEXT, shapeBox: shapeBox, nearestSize: nearestSize, DEBOUNCE_MS: DEBOUNCE_MS };
