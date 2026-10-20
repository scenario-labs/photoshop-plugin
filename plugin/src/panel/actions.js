"use strict";
// The creation flows' actions (FLOWS v2, SPEC 3): what each one is called,
// what its composer asks for, which logic runs it and where it lands, and
// which actions a context offers. Plain data and small functions, so the
// panel and the tests read the same table. Only actions that run in this
// build are listed: the P2 flows (sketch, split, select by description,
// animate, formats, sets, workflows) are not entries here.
//
// family: which logic runs the action.
//   "image"  the Image lane (panel/image.js, forms/requests.js)
//   "edit"   lanes/edit.js through lanes/flow.js (tool edit or trained_edit)
//   "expand", "upscale", "cutout"  lanes/enhance.js through lanes/flow.js
// prompt: "req" (needed), "opt" (may stay empty: the built-in prompt is
// sent), "none" (the action takes no prompt; the note says so).
// chips: the composer chips, in order (style, model, takes, size, target,
// upsize, change). refs: the refs row shows (when the model takes images).

// The model needs a prompt even where the person gives none; these are sent
// then, and named in SPEC 3.
var BUILTIN = require("../util/builtin.js").BUILTIN;

function plural(n, one) {
  return n + " " + one + (n === 1 ? "" : "s");
}

var ACTIONS = {
  // ---- Selection (F1) ----
  replace: {
    label: "Replace inside",
    family: "edit",
    prompt: "req",
    placeholder: "Describe what goes inside the selection",
    takes: 2,
    chips: ["style", "model", "takes"],
    refs: true,
    button: function () {
      return "Replace inside";
    },
    land: function () {
      return "Lands inside the selection, masked";
    }
  },
  remove: {
    label: "Remove",
    family: "edit",
    prompt: "none",
    none: "Fills the selection from what surrounds it. No prompt needed.",
    builtin: BUILTIN.remove,
    // The checks flag a Remove that left part of the selection as it was.
    expect: "cleared",
    takes: 2,
    chips: ["model", "takes"],
    button: function () {
      return "Remove";
    },
    land: function () {
      return "Lands inside the selection, masked";
    }
  },
  versions_sel: {
    label: "Make versions",
    family: "edit",
    prompt: "opt",
    placeholder: "Describe the change, or leave empty for variations",
    builtin: BUILTIN.variations,
    takes: 2,
    chips: ["style", "model", "takes", "change"],
    refs: true,
    button: function (n) {
      return "Make versions";
    },
    land: function () {
      return "Lands inside the selection, masked";
    }
  },
  cutout: {
    label: "Cut out subject",
    family: "cutout",
    source: "selection",
    // A new layer with the subject masked, the layer untouched (a mask on
    // the layer itself would hide everything outside the subject).
    lands: "new_layer",
    prompt: "none",
    none: "Finds the main subject inside the selection and puts it on a new layer. No prompt needed.",
    takes: 1,
    chips: ["model"],
    button: function () {
      return "Cut out subject";
    },
    land: function (L) {
      return "Lands as a new layer above " + L + ", which stays untouched";
    }
  },

  // ---- Layer, no selection (F2, F3, F4) ----
  versions: {
    label: "Make versions",
    family: "edit",
    sample: "layer",
    prompt: "opt",
    placeholder: "Describe the change, or leave empty for variations",
    builtin: BUILTIN.variations,
    takes: 4,
    chips: ["style", "model", "takes", "change"],
    refs: true,
    button: function (n) {
      return "Make versions";
    },
    land: function (L, n) {
      return n > 1 ? "Lands above " + L + " as a group" : "Lands above " + L;
    }
  },
  extend: {
    label: "Extend canvas",
    family: "expand",
    prompt: "opt",
    placeholder: "Optional: what the new area shows",
    builtin: BUILTIN.extend,
    takes: 1,
    chips: ["target", "model", "takes"],
    button: function () {
      return "Extend canvas";
    },
    land: function (L, n, v) {
      return v && v.to ? "Canvas grows to " + v.to.width + " × " + v.to.height + ", new area only" : "Lands above " + L + ", new area only";
    }
  },
  upscale: {
    label: "Upscale",
    family: "upscale",
    source: "visible",
    prompt: "none",
    none: "Adds detail at the larger size. No prompt needed.",
    takes: 1,
    chips: ["upsize", "model"],
    button: function (n, v) {
      return "Upscale " + factorLabel(v);
    },
    land: function (L, n, v) {
      return v && v.out ? "Opens as a new document " + v.out.width + " × " + v.out.height : "Opens as a new document";
    }
  },
  remove_bg: {
    label: "Remove background",
    family: "cutout",
    source: "layer",
    prompt: "none",
    none: "Keeps the subject and masks the rest. No prompt needed.",
    takes: 1,
    chips: ["model"],
    button: function () {
      return "Remove background";
    },
    land: function (L) {
      return "Lands as a mask on " + L;
    }
  },
  new_layer: {
    label: "New layer",
    family: "image",
    prompt: "req",
    placeholder: "Describe the new layer",
    takes: 2,
    chips: ["style", "model", "takes"],
    refs: true,
    insert: "above",
    button: function () {
      return "New layer";
    },
    land: function (L) {
      return "Lands above " + L + " at canvas size";
    }
  },
  background: {
    label: "Add background",
    family: "image",
    prompt: "req",
    placeholder: "Describe the background",
    takes: 2,
    chips: ["style", "model", "takes"],
    refs: true,
    autoRef: true,
    insert: "below",
    button: function () {
      return "Add background";
    },
    land: function (L) {
      return "Lands below " + L + " at canvas size";
    }
  },
  upscale_layer: {
    label: "Upscale this layer",
    family: "upscale",
    source: "layer",
    prompt: "none",
    none: "Reads this layer only, not the whole picture. No prompt needed.",
    takes: 1,
    chips: ["upsize", "model"],
    button: function (n, v) {
      return "Upscale " + factorLabel(v);
    },
    land: function (L, n, v) {
      return v && v.out ? "Opens as a new document " + v.out.width + " × " + v.out.height : "Opens as a new document";
    }
  },
  cutout_layer: {
    label: "Cut out to a new layer",
    family: "cutout",
    source: "layer",
    lands: "new_layer",
    prompt: "none",
    none: "Keeps the subject on a copy of the layer; the layer stays as it is. No prompt needed.",
    takes: 1,
    chips: ["model"],
    button: function () {
      return "Cut out to a new layer";
    },
    land: function (L) {
      return "Lands above " + L + " as a masked copy";
    }
  },

  // ---- No document (F3) ----
  create: {
    label: "Create image",
    family: "image",
    prompt: "req",
    placeholder: "Describe the image",
    takes: 4,
    chips: ["size", "style", "model", "takes"],
    refs: true,
    button: function (n) {
      return "Create image";
    },
    land: function (L, n, v) {
      return v && v.out ? "Opens as a new document " + v.out.width + " × " + v.out.height : "Opens as a new document";
    }
  },

  // ---- A Scenario takes group (results model) ----
  compare: {
    label: "Compare takes",
    family: null,
    note: function (run) {
      if (run && run.kept) return "Take " + run.shown_n + " is kept. Refine or More like this start from it.";
      return "Click a take above to show it in the document, then Keep it.";
    },
    land: function () {
      return "";
    }
  },
  more_like: {
    label: "More like this",
    family: "edit",
    prompt: "opt",
    placeholder: "Describe what to keep or push further",
    builtin: BUILTIN.variations,
    takes: 2,
    chips: ["style", "model", "takes"],
    refs: true,
    button: function () {
      return "More like this";
    },
    land: function () {
      return "Lands as a new group, the shown take as a reference";
    }
  },
  refine: {
    label: "Refine",
    family: null,
    special: "refine"
  },
  upscale_kept: {
    label: "Upscale kept take",
    family: "upscale",
    source: "layer",
    prompt: "none",
    none: "Upscales the take that is showing. No prompt needed.",
    takes: 1,
    chips: ["upsize", "model"],
    button: function (n, v) {
      return "Upscale " + factorLabel(v);
    },
    land: function (L, n, v) {
      return v && v.out ? "Opens as a new document " + v.out.width + " × " + v.out.height : "Opens as a new document";
    }
  }
};

function factorLabel(v) {
  var f = v && v.factor ? String(v.factor) : "2x";
  var m = /^(\d+(?:\.\d+)?)x$/.exec(f);
  return "×" + (m ? m[1] : "2");
}

// The actions of each context, in order; the first is selected when the
// context appears.
var CONTEXTS = {
  none: ["create"],
  layer: ["versions", "extend", "upscale", "remove_bg", "new_layer"],
  cutout: ["background", "versions", "upscale", "extend"],
  selection: ["replace", "remove", "versions_sel", "cutout"],
  takes: ["compare", "more_like", "refine", "upscale_kept"]
};

// More: every other action of the context that runs in this build, grouped.
var MORE = {
  none: [],
  layer: [
    ["Finish", ["upscale_layer"]],
    ["Select and cut", ["cutout_layer"]]
  ],
  cutout: [
    ["Finish", ["upscale_layer"]],
    ["Select and cut", ["remove_bg"]],
    ["Layers", ["new_layer"]]
  ],
  // Upscale the selection was Upscale with a crop: removed after the review.
  selection: [],
  takes: []
};

var MAX_CHIPS = 6;

// The chips of a context: its own actions, then the person's pins, at most
// six. Chips never reorder by themselves.
function chipsFor(kind, pins) {
  var list = (CONTEXTS[kind] || []).slice();
  var mine = (pins && pins[kind]) || [];
  for (var i = 0; i < mine.length; i++) if (list.indexOf(mine[i]) < 0 && list.length < MAX_CHIPS && inMore(kind, mine[i])) list.push(mine[i]);
  return list;
}

function inMore(kind, id) {
  var g = MORE[kind] || [];
  for (var i = 0; i < g.length; i++) if (g[i][1].indexOf(id) >= 0) return true;
  return false;
}

// The More menu: groups of { id, label, sub, pinned, can_pin }; actions
// already among the context's own chips are left out.
function moreFor(kind, pins, current) {
  var chips = chipsFor(kind, pins);
  var mine = (pins && pins[kind]) || [];
  var full = chips.length >= MAX_CHIPS;
  var out = [];
  var groups = MORE[kind] || [];
  for (var i = 0; i < groups.length; i++) {
    var items = [];
    for (var k = 0; k < groups[i][1].length; k++) {
      var id = groups[i][1][k];
      if ((CONTEXTS[kind] || []).indexOf(id) >= 0) continue;
      var a = ACTIONS[id];
      var pinned = mine.indexOf(id) >= 0;
      items.push({ id: id, label: a.label, sub: a.prompt === "none" ? "One click, no prompt" : "", pinned: pinned, can_pin: pinned || !full, selected: current === id });
    }
    if (items.length) out.push({ title: groups[i][0], items: items });
  }
  return out;
}

// Pins one action to (or from) a context's chips. Returns the new pins.
function togglePin(pins, kind, id) {
  var out = {};
  for (var k in pins || {}) out[k] = pins[k].slice();
  var list = out[kind] || [];
  var at = list.indexOf(id);
  if (at >= 0) list.splice(at, 1);
  else if (inMore(kind, id) && chipsFor(kind, out).length < MAX_CHIPS) list.push(id);
  out[kind] = list;
  return out;
}

// The prompt that goes to the model: the person's, else the action's
// built-in one (null when the action needs a prompt and has none).
function promptFor(id, text) {
  var a = ACTIONS[id];
  var t = String(text || "").trim();
  if (!a || a.prompt === "none") return a && a.builtin ? a.builtin : null;
  if (t) return t;
  return a.prompt === "opt" ? a.builtin || null : null;
}

module.exports = {
  ACTIONS: ACTIONS,
  CONTEXTS: CONTEXTS,
  MORE: MORE,
  BUILTIN: BUILTIN,
  MAX_CHIPS: MAX_CHIPS,
  chipsFor: chipsFor,
  moreFor: moreFor,
  inMore: inMore,
  togglePin: togglePin,
  promptFor: promptFor,
  factorLabel: factorLabel,
  plural: plural
};
