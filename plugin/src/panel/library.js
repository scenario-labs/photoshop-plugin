"use strict";
// The Library lane (FLOWS v2, changes after review 11; M7): the project's
// images as a 3-column grid in the composer, with a search field and
// filters. A click opens one as a new document (no document open), places
// it in the document as a layer (Place from Library), or adds it to the
// refs row (+ Reference > Library). Free reads only: GET /assets lists the
// project's assets newest first, one list per asset type; a file is fetched
// from Scenario's CDN without the key, like a result.
//
// o: { client, downloader (scenario/download.js), host, log }

var slugMod = require("../util/slug.js");
var clipMod = require("../util/clip.js");
var xmp = require("../util/xmp.js");
var manifest = require("../../manifest.json");

var ORIGIN = "https://cdn.cloud.scenario.com";
var PAGE = 30;
var SHOWN = 12;
var FOLDER = "Scenario/library";
var CACHE_MS = 60000;
var HISTORY = "Scenario: Place library";

// Filters, each a set of asset types read with GET /assets?type=<type>
// (measured through hosted Scenario MCP on 2026-10-20: a project whose
// newest assets are 3D models listed no image in its first page of 30, so
// the grid asks for image types only). "All" reads the three lists and
// merges them newest first.
var FILTERS = [
  { key: "all", label: "All", types: ["txt2img", "img2img", "uploaded"] },
  { key: "generated", label: "Generated", types: ["txt2img"] },
  { key: "edited", label: "Edited", types: ["img2img"] },
  { key: "uploaded", label: "Uploaded", types: ["uploaded"] }
];

function filterOf(key) {
  for (var i = 0; i < FILTERS.length; i++) if (FILTERS[i].key === key) return FILTERS[i];
  return FILTERS[0];
}

function cdnUrl(u) {
  return typeof u === "string" && u.indexOf(ORIGIN + "/") === 0 ? u : null;
}

function text(v) {
  return typeof v === "string" ? v : "";
}

// One asset row of GET /assets as the grid shows it, or null for what the
// grid leaves out: other kinds, the plugin's own uploads (captures, masks,
// references, stand-ins), hidden assets.
function rowOf(a) {
  if (!a || typeof a.id !== "string") return null;
  var m = a.metadata && typeof a.metadata === "object" ? a.metadata : {};
  var kind = a.kind || m.kind;
  if (kind && kind !== "image") return null;
  var name = text(a.name) || text(m.name);
  if (/^photoshop-(capture|mask|reference|stand-in|standin)/.test(name) || m.hide === true || a.hide === true) return null;
  var thumb = cdnUrl(a.thumbnail && a.thumbnail.url) || cdnUrl(a.url);
  // A prompt kept as a text asset reads as its id: not shown or searched.
  var prompt = text(m.prompt) || text(a.prompt);
  if (/^asset_/.test(prompt)) prompt = "";
  var desc = text(a.description) || text(m.description);
  var width = typeof m.width === "number" ? m.width : typeof a.width === "number" ? a.width : null;
  var height = typeof m.height === "number" ? m.height : typeof a.height === "number" ? a.height : null;
  return {
    asset_id: a.id,
    name: name || (prompt ? clipMod.clip(prompt, 40) : desc ? clipMod.clip(desc, 40) : "Image"),
    title: name || prompt || desc || "Image",
    width: width,
    height: height,
    thumb: thumb,
    created_at: a.createdAt || null,
    source: text(a.source) || text(m.type) || null,
    model_id: text(m.modelId) || text(a.modelId) || null,
    prompt: prompt || null,
    description: desc || null,
    tags: Array.isArray(a.tags)
      ? a.tags.filter(function (t) {
          return typeof t === "string";
        })
      : []
  };
}

// The rows matching a search: every word of the query appears in the
// name, the prompt, the description or the tags (the newest loaded rows
// only; the count says how many were searched).
function search(rows, query) {
  var words = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return rows.slice();
  return rows.filter(function (r) {
    var hay = [r.name, r.prompt || "", r.description || "", r.tags.join(" ")].join(" ").toLowerCase();
    for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) < 0) return false;
    return true;
  });
}

// What placing a Library image does, as data for host.placeResults (SPEC
// 5.3, 9.1, 9.2): one layer "Scenario library <slug> <tail6>" above the
// active layer, at the image's own pixel size (never enlarged; shrunk to fit
// a smaller canvas), centered on the canvas, with the Scenario XMP packet
// of kind "library", in one History state "Scenario: Place library".
// row: rowOf(); file: { path, width, height }; doc: { id, width, height };
// o: { layer_id (the active layer), leave_prompts, version }.
function placePlan(row, file, doc, o) {
  o = o || {};
  var w = file.width || row.width || doc.width;
  var h = file.height || row.height || doc.height;
  var s = Math.min(1, doc.width / w, doc.height / h);
  var fit = { center_x: doc.width / 2, center_y: doc.height / 2, width: w * s, height: h * s };
  var slug = o.leave_prompts ? "" : slugMod.slug(row.name || row.prompt || "");
  var name = "Scenario library " + (slug ? slug + " " : "") + slugMod.tail(row.asset_id);
  var box = [Math.round(fit.center_x - fit.width / 2), Math.round(fit.center_y - fit.height / 2), Math.round(fit.width), Math.round(fit.height)];
  var fields = {
    schema: "1",
    assetId: row.asset_id,
    modelId: row.model_id || null,
    prompt: o.leave_prompts ? null : row.prompt || null,
    kind: "library",
    createdAt: row.created_at || null,
    captureBox: box.join(","),
    origin: "person",
    pluginVersion: o.version || manifest.version
  };
  return {
    history_name: HISTORY,
    kind: "library",
    document_id: doc.id,
    new_document: null,
    duplicate: null,
    box: { left: box[0], top: box[1], width: box[2], height: box[3] },
    takes: [{ path: file.path, asset_id: row.asset_id, name: name, xmp: xmp.build(fields), visible: true, width: w, height: h, fit: fit }],
    group: null,
    mask: null,
    insert: o.layer_id ? { layer_id: o.layer_id } : null,
    canvas: null,
    reads: null,
    cutout: null,
    restore_active: false,
    scaled: s < 1
  };
}

function createLibrary(o) {
  var log = o.log || function () {};
  // Per filter: the rows read so far, newest first, and each type's next
  // page token (null: that list is complete).
  var cache = {};

  // Per project as well: another project's images never show after a
  // switch (verification pass 2026-10-22).
  function keyOf(f) {
    var a = typeof o.account === "function" ? o.account() : null;
    return (a && a.id ? a.id : "-") + "|" + f.key;
  }

  async function readPage(type, token) {
    var q = { pageSize: String(PAGE), type: type };
    if (token) q.paginationToken = token;
    var res = await o.client.request("GET", "/assets", { query: q });
    var body = res && res.body && typeof res.body === "object" ? res.body : {};
    return {
      rows: (Array.isArray(body.assets) ? body.assets : []).map(rowOf).filter(Boolean),
      next: typeof body.nextPaginationToken === "string" && body.nextPaginationToken ? body.nextPaginationToken : null
    };
  }

  function merge(a, b) {
    var seen = {};
    var out = [];
    a.concat(b).forEach(function (r) {
      if (seen[r.asset_id]) return;
      seen[r.asset_id] = true;
      out.push(r);
    });
    out.sort(function (x, y) {
      return String(y.created_at || "").localeCompare(String(x.created_at || ""));
    });
    return out;
  }

  async function readMore(entry, types) {
    var got = await Promise.all(
      types.map(function (t) {
        return readPage(t, entry.tokens[t]).then(function (p) {
          return { type: t, page: p };
        });
      })
    );
    for (var i = 0; i < got.length; i++) {
      entry.rows = merge(entry.rows, got[i].page.rows);
      entry.tokens[got[i].type] = got[i].page.next;
      entry.done[got[i].type] = !got[i].page.next;
    }
  }

  // Resolves { rows (all read so far), more (another page exists) }.
  async function list(force, filter) {
    if (typeof force === "string") {
      filter = force;
      force = false;
    }
    var f = filterOf(filter);
    var e = cache[keyOf(f)];
    if (!force && e && Date.now() - e.at < CACHE_MS) return view(e);
    e = { at: Date.now(), rows: [], tokens: {}, done: {} };
    cache[keyOf(f)] = e;
    await readMore(e, f.types);
    log("library: " + e.rows.length + " images (" + f.key + ")");
    return view(e);
  }

  // The next page of each list of the filter that has one.
  async function more(filter) {
    var f = filterOf(filter);
    var e = cache[keyOf(f)];
    if (!e) return list(false, f.key);
    var open = f.types.filter(function (t) {
      return !e.done[t];
    });
    if (open.length) await readMore(e, open);
    return view(e);
  }

  function view(e) {
    var more = Object.keys(e.done).some(function (t) {
      return !e.done[t];
    });
    return { rows: e.rows.slice(), more: more };
  }

  // Saves one asset in the data folder. Resolves { path, ext, mime,
  // width, height }.
  // The folder is made first: the download writes into it and failed
  // three times on a data folder without it (live 2026-10-20).
  async function fetch(assetId) {
    if (o.host && typeof o.host.ensureDataDir === "function") {
      try {
        await o.host.ensureDataDir(FOLDER);
      } catch (e) {
        // the download reports it
      }
    }
    return o.downloader.download(assetId, FOLDER + "/" + assetId, null, null);
  }

  // Places one image in the active document as a layer (placePlan). Free:
  // the file is already on Scenario. Resolves host.placeResults' answer
  // and the plan.
  async function place(row, doc, opts) {
    if (!o.host || typeof o.host.placeResults !== "function") throw new Error("this Photoshop cannot place files from the plugin");
    var file = await fetch(row.asset_id);
    var plan = placePlan(row, file, doc, opts);
    var out = await o.host.placeResults(plan, {});
    return { placed: out, plan: plan };
  }

  return { list: list, more: more, fetch: fetch, place: place, rowOf: rowOf, search: search };
}

module.exports = { createLibrary: createLibrary, rowOf: rowOf, search: search, placePlan: placePlan, FILTERS: FILTERS, SHOWN: SHOWN, HISTORY: HISTORY };
