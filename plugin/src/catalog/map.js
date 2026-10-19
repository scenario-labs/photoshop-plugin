"use strict";
// Tabs, chips, picks, search and order of the model picker (SPEC 3.3), from
// the mapping data in shared/catalog-map.json. Pure functions over the
// catalog's display rows, so they run under Node.

var MAP = require("../../../shared/catalog-map.json");

var TABS = ["image", "edit", "enhance", "trained"];
var TOOLS = ["upscale", "expand", "remove_background"];
var TAB_LABELS = { image: "Image", edit: "Edit", enhance: "Enhance", trained: "Trained" };
var TOOL_LABELS = { upscale: "Upscale", expand: "Expand", remove_background: "Remove BG" };
var CHIPS = {
  image: ["all", "favorites", "recommended", "references"],
  edit: ["all", "favorites", "recommended", "mask", "references"],
  enhance: ["all", "favorites", "recommended", "upscale", "expand", "remove_background"],
  trained: ["all", "favorites", "project", "public"]
};
var CHIP_LABELS = { all: "All", favorites: "Favorites", recommended: "Recommended", references: "References", mask: "Mask input", upscale: "Upscale", expand: "Expand", remove_background: "Remove BG", project: "This project", public: "Public" };

function lower(list) {
  return list.map(function (x) {
    return String(x).toLowerCase();
  });
}

function hasAny(list, wanted) {
  var l = lower(list);
  for (var i = 0; i < wanted.length; i++) if (l.indexOf(String(wanted[i]).toLowerCase()) >= 0) return true;
  return false;
}

function isBase(row) {
  return MAP.tabs.base_types.indexOf(row.type) >= 0;
}

function hidden(row) {
  return hasAny(row.tags, MAP.hidden_tags);
}

// The Enhance tools a row belongs to.
function toolsOf(row) {
  if (!isBase(row) || hidden(row)) return [];
  var out = [];
  var e = MAP.tabs.enhance;
  for (var i = 0; i < TOOLS.length; i++) {
    var t = e.tools[TOOLS[i]];
    var byList = t.models.indexOf(row.id) >= 0;
    var byTag = hasAny(row.tags, t.tags) && hasAny(row.capabilities, e.requires_capabilities);
    if (byList || byTag) out.push(TOOLS[i]);
  }
  return out;
}

// The picker tabs a row belongs to; [] for models that fit none (video,
// audio, 3D, deprecated).
function tabsOf(row) {
  if (hidden(row)) return [];
  if (!isBase(row)) return ["trained"];
  var out = [];
  if (hasAny(row.capabilities, MAP.tabs.image.capabilities)) out.push("image");
  var edit = MAP.tabs.edit;
  if ((hasAny(row.capabilities, edit.capabilities) || edit.instruction_editors.indexOf(row.id) >= 0) && !hasAny(row.tags, edit.exclude_tags)) out.push("edit");
  if (toolsOf(row).length) out.push("enhance");
  return out;
}

// MCP lanes of a catalog row (trained rows get theirs from trained.js).
function lanesOf(row) {
  var tabs = tabsOf(row);
  var out = [];
  if (tabs.indexOf("image") >= 0) out.push("image");
  if (tabs.indexOf("edit") >= 0) out.push("edit");
  var tools = toolsOf(row);
  for (var i = 0; i < tools.length; i++) out.push(tools[i]);
  return out;
}

function laneTab(lane) {
  if (lane === "image" || lane === "edit" || lane === "trained") return lane;
  return "enhance";
}

function acceptsMask(row, schema) {
  if (schema) {
    for (var i = 0; i < schema.file_inputs.length; i++) if (schema.file_inputs[i].role === "mask") return true;
  }
  return hasAny(row.capabilities, MAP.mask_capabilities);
}

function takesReferences(row, schema) {
  if (schema) {
    for (var i = 0; i < schema.file_inputs.length; i++) if (schema.file_inputs[i].role === "reference") return true;
    return false;
  }
  return hasAny(row.capabilities, MAP.reference_capabilities);
}

function newestFirst(a, b) {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

// Scenario picks for a tab (SPEC 3.3 item 6): the shipped list, then the
// tab's featured models, newest first, up to the cap.
function picks(rows, tab) {
  var out = [];
  var seen = {};
  var listed = MAP.picks[tab] || [];
  var byId = {};
  for (var r = 0; r < rows.length; r++) byId[rows[r].id] = rows[r];
  for (var i = 0; i < listed.length && out.length < MAP.picks.max; i++) {
    var row = byId[listed[i]];
    if (row && tabsOf(row).indexOf(tab) >= 0 && !seen[row.id]) {
      out.push(row.id);
      seen[row.id] = true;
    }
  }
  var featured = rows
    .filter(function (x) {
      return !seen[x.id] && tabsOf(x).indexOf(tab) >= 0 && x.tags.indexOf(MAP.picks.featured_tag) >= 0;
    })
    .sort(newestFirst);
  for (var f = 0; f < featured.length && out.length < MAP.picks.max; f++) out.push(featured[f].id);
  return out;
}

function matches(row, words, baseNames) {
  var hay = [row.name, row.description, row.type].concat(row.tags, row.compliant, baseNames || []).join(" ").toLowerCase();
  for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) < 0) return false;
  return true;
}

// opts: { tab, chip, tag, query, favorites: [ids], schemas: {id: schema},
//         bases: {id: [base names]} }. Returns the ordered rows.
function select(rows, opts) {
  var tab = opts.tab || "image";
  var chip = opts.chip || "all";
  var favs = opts.favorites || [];
  var schemas = opts.schemas || {};
  var words = String(opts.query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  var pickIds = picks(rows, tab);
  var out = rows.filter(function (row) {
    if (tabsOf(row).indexOf(tab) < 0) return false;
    if (opts.tag && !hasAny(row.tags, [opts.tag])) return false;
    if (words.length && !matches(row, words, opts.bases && opts.bases[row.id])) return false;
    switch (chip) {
      case "favorites":
        return favs.indexOf(row.id) >= 0;
      case "recommended":
        return pickIds.indexOf(row.id) >= 0;
      case "mask":
        return acceptsMask(row, schemas[row.id]);
      case "references":
        return takesReferences(row, schemas[row.id]);
      case "upscale":
      case "expand":
      case "remove_background":
        return toolsOf(row).indexOf(chip) >= 0;
      case "project":
        return row.project;
      case "public":
        return !row.project;
      default:
        return true;
    }
  });
  // Favorites, then Scenario picks, then the newest; in Trained, the
  // project's models before public ones.
  function rank(row) {
    var f = favs.indexOf(row.id) >= 0 ? 0 : 1;
    var p = pickIds.indexOf(row.id);
    return [tab === "trained" && !row.project ? 1 : 0, f, p >= 0 ? p : pickIds.length];
  }
  return out.sort(function (a, b) {
    var ra = rank(a);
    var rb = rank(b);
    for (var i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return newestFirst(a, b);
  });
}

// The Tags menu: catalog tags among the tab's models, most common first,
// without Scenario's internal ones.
function tagMenu(rows, tab) {
  var counts = {};
  var shown = {};
  for (var i = 0; i < rows.length; i++) {
    if (tabsOf(rows[i]).indexOf(tab) < 0) continue;
    for (var t = 0; t < rows[i].tags.length; t++) {
      var tag = rows[i].tags[t];
      var key = tag.toLowerCase();
      var internal = false;
      for (var p = 0; p < MAP.internal_tag_prefixes.length; p++) if (key.indexOf(MAP.internal_tag_prefixes[p]) === 0) internal = true;
      if (internal) continue;
      counts[key] = (counts[key] || 0) + 1;
      if (!shown[key]) shown[key] = tag;
    }
  }
  return Object.keys(counts)
    .sort(function (a, b) {
      return counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0);
    })
    .map(function (k) {
      return { tag: shown[k], count: counts[k] };
    });
}

function defaults(lane) {
  return Object.prototype.hasOwnProperty.call(MAP.defaults, lane) && lane.charAt(0) !== "$" ? MAP.defaults[lane] : null;
}

module.exports = {
  TABS: TABS,
  TOOLS: TOOLS,
  TAB_LABELS: TAB_LABELS,
  TOOL_LABELS: TOOL_LABELS,
  CHIPS: CHIPS,
  CHIP_LABELS: CHIP_LABELS,
  tabsOf: tabsOf,
  toolsOf: toolsOf,
  lanesOf: lanesOf,
  laneTab: laneTab,
  hidden: hidden,
  acceptsMask: acceptsMask,
  takesReferences: takesReferences,
  picks: picks,
  select: select,
  tagMenu: tagMenu,
  defaults: defaults
};
