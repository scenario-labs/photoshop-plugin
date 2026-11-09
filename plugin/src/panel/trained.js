"use strict";
// Trained models in the creation panel (SPEC 3.4, M7), without the DOM:
// the project's trained styles and characters as entries for the Style
// chip and the Model menu, which of them a run applies, the base model that
// runs them (stacked on one base when there are two), their weights and
// trigger words. The controller keeps the choices; this module decides what
// they mean. A trained model is never the model called: its base is
// (catalog/trained.js derives the bases from the catalog's schemas).

var trainedMod = require("../catalog/trained.js");
var map = require("../catalog/map.js");
var thumbs = require("../ui/thumbs.js");

var TEXT = {
  replaced: function (gone, now, why) {
    return why + " " + now + " replaces " + gone + ".";
  },
  weight_note: "The weight of a trained model: 1 is its full effect, lower is lighter.",
  trigger_note: "Trigger words call the trained look up; they are added before your prompt unless it already has them."
};

// Weights offered for a trained model (lorasScale), within the base's range.
var WEIGHTS = [0.25, 0.5, 0.75, 1, 1.25, 1.5];

function round2(v) {
  return Math.round(v * 100) / 100;
}

// An entry from a catalog row: what the menus show and what a run needs.
// Null when no base the plugin reads takes the model's type.
function entryOf(row, bases) {
  if (!row || row.type === "custom") return null;
  var d = trainedMod.derive(row, bases);
  if (!d.supported || !d.lanes.length) return null;
  return {
    id: row.id,
    name: row.name,
    thumb: thumbs.modelThumb(row),
    kind: d.trained_kind,
    scale: d.default_scale,
    bases: d.base_model_ids.slice(),
    base_names: d.base_names.slice(),
    lanes: d.lanes.slice(),
    route: d.edit_route,
    trigger: row.trigger || null,
    images: typeof row.images === "number" ? row.images : null,
    role: trainedMod.roleOf(row),
    public: !row.project
  };
}

// The project's trained models, characters first, then by name.
function projectEntries(rows, bases) {
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i].project || map.isBase(rows[i]) || map.hidden(rows[i])) continue;
    var e = entryOf(rows[i], bases);
    if (e) out.push(e);
  }
  out.sort(function (a, b) {
    if (a.role !== b.role) return a.role === "character" ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}

// "Trained character · 20 images · FLUX.1 Dev"
function subOf(e) {
  var parts = [e.role === "character" ? "Trained character" : "Trained style"];
  if (e.images) parts.push(e.images + " images");
  if (e.base_names[0]) parts.push(e.base_names[0]);
  return parts.join(" · ");
}

// The menu row's tooltip: the name, the base, the trigger words.
function titleOf(e) {
  return e.name + (e.kind === "composition" ? " (composition)" : "") + " runs on " + (e.base_names[0] || "its base") + (e.trigger ? ". Trigger: " + e.trigger : "");
}

// The family of an action that can run a trained model: "edit" (Replace
// inside, Make versions, Render sketch, More like this: the Edit lane on the
// base) or "image" (Create image, New layer, Add background: Make new on
// the base), else null.
function familyOf(action) {
  if (!action || (action.chips || []).indexOf("style") < 0) return null;
  return action.family === "edit" || action.family === "image" ? action.family : null;
}

function fits(action, e) {
  var f = familyOf(action);
  return !!(f && e && e.lanes.indexOf(f) >= 0);
}

// What a run applies: the trained style (Style chip), then the trained
// model picked in the Model menu (Run with), each once.
function listFor(action, style, runWith) {
  var out = [];
  if (style && !style.match && fits(action, style)) out.push(style);
  if (runWith && fits(action, runWith) && !out.some(function (x) {
    return x.id === runWith.id;
  })) out.push(runWith);
  return out;
}

function baseSchema(bases, id) {
  for (var i = 0; i < bases.length; i++) if (bases[i].model_id === id) return bases[i];
  return null;
}

// The run's trained part: { list, base_model_id, base_name, route, reason }
// or null when it applies none. reason: why the list cannot run together.
function resolve(action, style, runWith, bases) {
  var list = listFor(action, style, runWith);
  if (!list.length) return null;
  var fam = familyOf(action);
  var cb = trainedMod.commonBase(
    list.map(function (e) {
      return { trained_kind: e.kind, base_model_ids: e.bases };
    }),
    bases || [],
    fam
  );
  var b = cb.base_model_id ? baseSchema(bases || [], cb.base_model_id) : null;
  return { list: list, family: fam, base_model_id: cb.base_model_id, base_name: b ? b.name : null, base: b, route: b && fam === "edit" ? trainedMod.editRoute(b) : null, reason: cb.reason };
}

function weightOf(e, adv) {
  var v = adv ? Number(adv["w:" + e.id]) : NaN;
  return isFinite(v) && v > 0 ? v : e.scale;
}

// The trained models as lanes/edit.js loraParams takes them: one model as
// before ({ model_id, kind, scale }); several as { loras: [...] }, the first
// id kept as model_id. strength: the Change amount (image + strength route).
function argOf(r, adv, strength) {
  if (!r || !r.base_model_id) return null;
  var first = r.list[0];
  var out = { model_id: first.id, kind: first.kind, scale: weightOf(first, adv) };
  if (r.list.length > 1)
    out.loras = r.list.map(function (e) {
      return { model_id: e.id, scale: weightOf(e, adv) };
    });
  if (typeof strength === "number" && r.route === "image_strength") out.strength = strength;
  return out;
}

// The prompt with the trigger words in front, unless the person turned
// them off (Advanced) or the prompt already holds them.
function withTriggers(prompt, r, adv) {
  if (!prompt || !r || (adv && adv.trigger === "off")) return prompt;
  var add = [];
  var low = String(prompt).toLowerCase();
  for (var i = 0; i < r.list.length; i++) {
    var t = r.list[i].trigger;
    if (t && low.indexOf(t.toLowerCase()) < 0 && add.indexOf(t) < 0) add.push(t);
  }
  return add.length ? add.join(", ") + ", " + prompt : prompt;
}

// Advanced rows for the trained part: a weight per LoRA, and the trigger
// words when one of them has some.
function advancedRows(r, adv) {
  if (!r || !r.base_model_id) return [];
  var rows = [];
  var lo = r.base && r.base.takes_loras ? r.base.takes_loras.scale_min : 0;
  var hi = r.base && r.base.takes_loras ? r.base.takes_loras.scale_max : 2;
  for (var i = 0; i < r.list.length; i++) {
    var e = r.list[i];
    if (e.kind !== "lora") continue;
    var vals = WEIGHTS.slice();
    if (vals.indexOf(round2(e.scale)) < 0) vals.push(round2(e.scale));
    vals = vals
      .filter(function (v) {
        return (typeof lo !== "number" || v >= lo) && (typeof hi !== "number" || v <= hi);
      })
      .sort(function (a, b) {
        return a - b;
      });
    rows.push({
      name: "w:" + e.id,
      label: e.name + " weight",
      value: weightOf(e, adv),
      options: vals.map(function (v) {
        return [v, String(v) + (v === round2(e.scale) ? " (its own)" : "")];
      })
    });
  }
  var any = r.list.some(function (x) {
    return !!x.trigger;
  });
  if (any) {
    var words = r.list
      .filter(function (x) {
        return !!x.trigger;
      })
      .map(function (x) {
        return x.trigger;
      })
      .join(", ");
    rows.push({ name: "trigger", label: "Trigger words · " + words, value: adv && adv.trigger === "off" ? "off" : "add", options: [["add", "Add to the prompt"], ["off", "Leave out"]] });
  }
  return rows;
}

// Two picks that cannot run on one base: the newer one stays. Returns the
// note to show, or null when both fit.
function clash(action, style, runWith, bases) {
  var r = resolve(action, style, runWith, bases);
  if (!r || r.list.length < 2 || r.base_model_id) return null;
  return r.reason;
}

module.exports = {
  entryOf: entryOf,
  projectEntries: projectEntries,
  subOf: subOf,
  titleOf: titleOf,
  familyOf: familyOf,
  fits: fits,
  listFor: listFor,
  resolve: resolve,
  argOf: argOf,
  weightOf: weightOf,
  withTriggers: withTriggers,
  advancedRows: advancedRows,
  clash: clash,
  WEIGHTS: WEIGHTS,
  TEXT: TEXT
};
