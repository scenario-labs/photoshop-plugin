"use strict";
// The creation flows' actions (FLOWS v2, SPEC 3): what each one is called,
// what its composer asks for, which logic runs it and where it lands, and
// which actions a context offers. Plain data and small functions, so the
// panel and the tests read the same table. Only actions that run in this
// build are listed (Start a set, Same action on each and Run a workflow
// are not entries here).
//
// family: which logic runs the action.
//   "image"  the Image lane (panel/image.js, forms/requests.js)
//   "edit"   lanes/edit.js through lanes/flow.js (tool edit or trained_edit)
//   "expand", "upscale", "cutout"  lanes/enhance.js through lanes/flow.js
//   "tool"   lanes/more.js through lanes/flow.js (tool: split, text,
//            segment, reframe, video, frames); host-more.js lands it
// model: the action's own recommended model (else the lane's default);
// alts: the other models its Model menu offers (actions with their own
// model list only those). model_lane: the catalog-map defaults entry that
// names its recommended model and keeps the person's model choice apart
// (Replace inside and Remove, mask strategy test of 2026-10-20). quality: the Quality level it starts at.
// prompt: "req" (needed), "opt" (may stay empty: the built-in prompt is
// sent), "none" (the action takes no prompt; the note says so).
// chips: the composer chips, in order (edit, style, model, takes, size,
// target, upsize, change, angle, format, duration). edit: Inside selection
// or Bolder, the two ways a masked Replace inside lands. refs: the refs row shows (when
// the model takes images).

// Models of the later flows (recommend with quality priority plus the
// newest-first search on 2026-10-20, matching the prototype review).
var SUNBURST = "model_openai-gpt-image-2-5-sunburst";
var MODELS = {
  sketch: SUNBURST,
  relight: SUNBURST,
  angle: "model_qwen-edit-multiangle-2511",
  split: "model_bytedance-seedream-5-0-flash-layerize",
  text: "model_ideogram-v3-layerize-text",
  segment: "model_meta-sam-3-1-image",
  reframe: "model_scenario-smart-reframe",
  video: "model_minimax-h3-fast",
  frames: "model_scenario-video-to-image-seq"
};

// New angle presets: turn (horizontalAngle, degrees) and tilt.
var ANGLES = [
  { key: "left45", label: "Turn left 45°", extra: { horizontalAngle: 315, verticalAngle: 0, zoom: 5 } },
  { key: "right45", label: "Turn right 45°", extra: { horizontalAngle: 45, verticalAngle: 0, zoom: 5 } },
  { key: "side", label: "Side view", extra: { horizontalAngle: 90, verticalAngle: 0, zoom: 5 } },
  { key: "back", label: "Back view", extra: { horizontalAngle: 180, verticalAngle: 0, zoom: 5 } },
  { key: "above", label: "From above", extra: { horizontalAngle: 0, verticalAngle: 45, zoom: 5 } }
];

// The model needs a prompt even where the person gives none; these are sent
// then, and named in SPEC 3.
var BUILTIN = require("../util/builtin.js").BUILTIN;

function plural(n, one) {
  return n + " " + one + (n === 1 ? "" : "s");
}

// The Edit chip of Replace inside (mask strategy test of 2026-10-20):
// Inside selection runs the action's recommended model, which keeps the
// pixels outside the selection; Bolder runs GPT Image 2.5 Flare, whose
// change is stronger and may reach past the selection, and the placed mask
// grows to keep the new subject whole (apply/grow.js). A model picked in
// the Model menu sets the chip: one with mask growth reads Bolder.
var EDIT_MODES = {
  inside: { label: "Inside selection", sub: "Changes only what is inside the selection. Everything outside stays as it is." },
  bolder: { label: "Bolder", sub: "A stronger change. The new subject may reach past the selection; the mask grows to keep it whole.", model: "model_openai-gpt-image-2-5-flare" }
};

var ACTIONS = {
  // ---- Selection (F1) ----
  replace: {
    label: "Replace inside",
    family: "edit",
    prompt: "req",
    placeholder: "Describe what goes inside the selection",
    model_lane: "replace",
    takes: 2,
    chips: ["edit", "style", "model", "takes"],
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
    model_lane: "remove",
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
      return ("Upscale " + factorLabel(v)).trim();
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
    chips: ["bg", "style", "model", "takes"],
    refs: true,
    insert: "above",
    button: function () {
      return "New layer";
    },
    land: function (L, n, v) {
      var where = v && v.within === "selection" ? " inside the selection" : " at canvas size";
      return "Lands above " + L + where + (v && v.cutout ? ", cut out" : "");
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
      return ("Upscale " + factorLabel(v)).trim();
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

  // ---- Make variants, Layers, Finish, Animate (F6 to F10, F13) ----
  sketch: {
    label: "Render sketch",
    family: "edit",
    model: MODELS.sketch,
    quality: "high",
    sample: "layer",
    prompt: "opt",
    placeholder: "Optional: describe the finish",
    builtin: BUILTIN.sketch,
    takes: 2,
    chips: ["style", "model", "takes"],
    refs: true,
    button: function () {
      return "Render sketch";
    },
    land: function (L, n) {
      return n > 1 ? "Lands above " + L + " as a group" : "Lands above " + L;
    }
  },
  relight: {
    label: "Relight to scene",
    family: "edit",
    model: MODELS.relight,
    mask_layer: true,
    prompt: "opt",
    placeholder: "Optional: the light to match, or leave empty",
    builtin: BUILTIN.relight,
    takes: 2,
    chips: ["model", "takes"],
    refs: true,
    button: function () {
      return "Relight to scene";
    },
    land: function (L) {
      return "Lands above " + L + ", masked to its outline";
    }
  },
  angle: {
    label: "New angle",
    family: "edit",
    model: MODELS.angle,
    sample: "layer",
    prompt: "none",
    none: "Turns the subject to the angle you pick. No prompt needed.",
    takes: 2,
    chips: ["angle", "takes"],
    button: function () {
      return "New angle";
    },
    land: function (L, n) {
      return n > 1 ? "Lands above " + L + " as a group" : "Lands above " + L;
    }
  },
  split: {
    label: "Split into layers",
    family: "tool",
    tool: "split",
    model: MODELS.split,
    alts: ["model_bytedance-seedream-5-0-pro-layerize"],
    prompt: "opt",
    placeholder: "What to separate, or leave empty for the main elements",
    takes: 1,
    chips: ["model"],
    button: function () {
      return "Split into layers";
    },
    land: function (L) {
      return "Lands as a group above " + L + ": a background and one layer per element";
    }
  },
  split_text: {
    label: "Split text",
    family: "tool",
    tool: "text",
    mode: "split",
    model: MODELS.text,
    prompt: "none",
    none: "Separates the lettering from a clean background. No prompt needed.",
    takes: 1,
    chips: [],
    button: function () {
      return "Split text";
    },
    land: function (L) {
      return "Lands as a group above " + L + ": the text and a clean background";
    }
  },
  remove_text: {
    label: "Remove text",
    family: "tool",
    tool: "text",
    mode: "remove",
    model: MODELS.text,
    prompt: "none",
    none: "Removes lettering and logos and rebuilds what was behind. No prompt needed.",
    takes: 1,
    chips: [],
    button: function () {
      return "Remove text";
    },
    land: function (L) {
      return "Lands as a new layer above " + L;
    }
  },
  select_desc: {
    label: "Select by description",
    family: "tool",
    tool: "segment",
    model: MODELS.segment,
    // The description is typed in the context card's Select… field.
    prompt: "field",
    placeholder: "Select… (all the boats)",
    none: "Type what to select in the Select… field above.",
    takes: 1,
    chips: [],
    button: function () {
      return "Select";
    },
    land: function () {
      return "Makes a selection of what matches";
    }
  },
  formats: {
    label: "Formats",
    family: "tool",
    tool: "reframe",
    model: MODELS.reframe,
    prompt: "opt",
    placeholder: "Optional: what must stay in frame",
    takes: 1,
    chips: ["format"],
    button: function () {
      return "Formats";
    },
    land: function (L, n, v) {
      return v && v.out ? "Lands as an artboard " + v.out.width + " × " + v.out.height + " in a formats document" : "Lands as an artboard in a formats document";
    }
  },
  animate: {
    label: "Animate",
    family: "tool",
    tool: "video",
    model: MODELS.video,
    alts: ["model_minimax-h3"],
    prompt: "req",
    placeholder: "Describe the motion: lanterns flicker, water ripples, camera still",
    takes: 1,
    chips: ["duration", "model"],
    button: function () {
      return "Animate";
    },
    land: function () {
      return "Opens the clip as a new document; the MP4 goes to the output folder";
    }
  },
  frame: {
    label: "Frame to layer",
    family: "tool",
    tool: "frames",
    model: MODELS.frames,
    prompt: "none",
    none: "Brings the clip's last frame back as a layer. No prompt needed.",
    takes: 1,
    chips: [],
    button: function () {
      return "Frame to layer";
    },
    land: function (L) {
      return "Lands as a layer above " + L;
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

  library: {
    label: "Open from Library",
    family: null,
    grid: "open",
    note: function () {
      return "Click an image to open it as a new document.";
    },
    land: function () {
      return "Opens as a new document";
    }
  },
  // M7: a project image placed in the open document as a layer, with its
  // Scenario metadata (library.js placePlan). Free: nothing is generated.
  library_place: {
    label: "Place from Library",
    family: null,
    grid: "place",
    note: function () {
      return "Click an image to place it as a new layer.";
    },
    land: function () {
      return "Lands as a new layer";
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
      return ("Upscale " + factorLabel(v)).trim();
    },
    land: function (L, n, v) {
      return v && v.out ? "Opens as a new document " + v.out.width + " × " + v.out.height : "Opens as a new document";
    }
  }
};

function factorLabel(v) {
  // A model with no factor setting upscales at its own rate: no factor shown.
  if (v && v.factor === null) return "";
  var f = v && v.factor ? String(v.factor) : "2x";
  var m = /^(\d+(?:\.\d+)?)x$/.exec(f);
  return "×" + (m ? m[1] : "2");
}

// The actions of each context, in order; the first is selected when the
// context appears.
var CONTEXTS = {
  none: ["create", "library"],
  layer: ["versions", "extend", "upscale", "remove_bg", "new_layer"],
  cutout: ["background", "relight", "versions", "upscale", "extend"],
  // A layer made by Split into layers.
  element: ["versions", "relight", "angle", "upscale"],
  // A document of one layer (a generated or delivered JPEG or PNG).
  flat: ["split", "versions", "upscale", "formats"],
  selection: ["replace", "remove", "versions_sel", "cutout", "new_layer"],
  takes: ["compare", "more_like", "refine", "upscale_kept"]
};

// More: every other action of the context that runs in this build, grouped.
// Select by description is the Select… field of the layer card, not an
// entry.
var MORE = {
  none: [],
  layer: [
    ["Finish", ["remove_text", "formats", "upscale_layer"]],
    ["Select and cut", ["cutout_layer"]],
    ["Layers", ["split", "split_text", "library_place"]],
    ["Make variants", ["sketch", "angle", "relight"]],
    ["Animate", ["animate"]]
  ],
  cutout: [
    ["Finish", ["upscale_layer"]],
    ["Select and cut", ["remove_bg"]],
    ["Layers", ["new_layer", "library_place"]],
    ["Make variants", ["angle", "sketch"]],
    ["Animate", ["animate"]]
  ],
  element: [
    ["Finish", ["extend", "remove_text"]],
    ["Layers", ["library_place"]],
    ["Animate", ["animate"]]
  ],
  flat: [
    ["Finish", ["extend", "remove_text"]],
    ["Select and cut", ["remove_bg"]],
    ["Layers", ["split_text", "library_place"]],
    ["Make variants", ["sketch", "angle", "relight"]],
    ["Animate", ["animate"]]
  ],
  // Upscale the selection was Upscale with a crop: removed after the review.
  selection: [],
  takes: [["Animate", ["animate"]]]
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
  if (!a || a.prompt === "none" || a.prompt === "field") return a && a.builtin ? a.builtin : null;
  if (t) return t;
  return a.prompt === "opt" ? a.builtin || null : null;
}

module.exports = {
  ACTIONS: ACTIONS,
  EDIT_MODES: EDIT_MODES,
  MODELS: MODELS,
  ANGLES: ANGLES,
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
