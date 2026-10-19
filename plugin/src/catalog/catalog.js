"use strict";
// The model catalog (SPEC 3.3): the current project's models and Scenario's
// public models, cached in the plugin data folder and refreshed when the
// cache is older than 24 h or on demand. The refresh is lazy: it starts the
// next time the catalog is read after the cache expired, so no timer runs.
// Model records are large, so the cache keeps display fields only. A model's
// schema (its inputs) is a second read, GET /v1/models/{id}, kept in memory
// for the session.

var MAP = require("../../../shared/catalog-map.json");
var errorsMod = require("../scenario/errors.js");
var schemaMod = require("../forms/schema.js");
var priceChecks = require("../scenario/dry-run.js");

var FILE = "model-catalog.json";
// 2: rows carry `thumb`, so an older cache is read again.
var CACHE_VERSION = 2;
var ASSET_ID = /^asset_[A-Za-z0-9_-]{1,128}$/;

function str(v) {
  return typeof v === "string" ? v : null;
}

function strings(v) {
  return Array.isArray(v)
    ? v.filter(function (x) {
        return typeof x === "string";
      })
    : [];
}

// The display fields of one list row.
function displayRow(m, fromProject) {
  if (!m || typeof m !== "object" || !priceChecks.validModelId(m.id)) return null;
  var desc = str(m.shortDescription) || str(m.description) || "";
  if (desc.length > MAP.listing.description_max_chars) desc = desc.slice(0, MAP.listing.description_max_chars - 3) + "...";
  var concepts = [];
  if (Array.isArray(m.concepts)) {
    for (var i = 0; i < m.concepts.length; i++) {
      var c = m.concepts[i];
      if (c && typeof c.modelId === "string" && typeof c.scale === "number") concepts.push({ modelId: c.modelId, scale: c.scale });
    }
  }
  return {
    id: m.id,
    name: str(m.name) || m.id,
    description: desc,
    type: str(m.type) || "custom",
    privacy: str(m.privacy) || (fromProject ? "private" : "public"),
    project: !!fromProject,
    capabilities: strings(m.capabilities),
    tags: strings(m.tags),
    created_at: str(m.createdAt) || "",
    compliant: strings(m.compliantModelIds),
    concepts: concepts,
    no_refund: m.disableRefund === true,
    // The asset shown as the model's picture: its thumbnail (trained
    // models) or its first example image (ui/thumbs.js).
    thumb: thumbAsset(m)
  };
}

function thumbAsset(m) {
  var t = m.thumbnail && typeof m.thumbnail === "object" ? m.thumbnail.assetId : null;
  if (typeof t === "string" && ASSET_ID.test(t)) return t;
  var ex = Array.isArray(m.exampleAssetIds) ? m.exampleAssetIds[0] : null;
  return typeof ex === "string" && ASSET_ID.test(ex) ? ex : null;
}

function parseCache(text) {
  try {
    var v = JSON.parse(text);
    if (!v || v.v !== CACHE_VERSION || typeof v.account !== "string" || typeof v.fetched_at !== "number" || !Array.isArray(v.rows)) return null;
    return v;
  } catch (e) {
    return null;
  }
}

// o: { client, host, account() -> {id} | null, now() -> ms, log }
function createCatalog(o) {
  var now = o.now || function () { return Date.now(); };
  var log = o.log || function () {};
  var state = { account: null, rows: null, fetched_at: 0, status: "idle", error: null };
  var loading = null;
  var schemas = {};
  var listeners = [];

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](status());
      } catch (e) {
        // a listener's failure does not stop the others
      }
    }
  }

  function status() {
    return { status: state.status, error: state.error, fetched_at: state.fetched_at || null, count: state.rows ? state.rows.length : 0 };
  }

  function currentId() {
    var acc = o.account();
    return acc ? acc.id : null;
  }

  async function listAll(query, fromProject) {
    var out = [];
    var token = null;
    for (var page = 0; page < MAP.listing.max_pages; page++) {
      var q = {};
      for (var k in query) q[k] = query[k];
      q.pageSize = String(MAP.listing.page_size);
      if (token) q.paginationToken = token;
      var res = await o.client.request("GET", MAP.listing.path, { query: q });
      var body = res.body || {};
      var models = Array.isArray(body.models) ? body.models : [];
      for (var i = 0; i < models.length; i++) {
        var row = displayRow(models[i], fromProject);
        if (row) out.push(row);
      }
      token = typeof body.nextPaginationToken === "string" && body.nextPaginationToken ? body.nextPaginationToken : null;
      if (!token) break;
    }
    return out;
  }

  async function fetchAll(accountId) {
    state.status = "loading";
    state.error = null;
    notify();
    try {
      // The project's models first, then Scenario's public ones.
      var mine = await listAll({}, true);
      var pub = await listAll({ privacy: "public" }, false);
      var seen = {};
      var rows = [];
      var both = mine.concat(pub);
      for (var i = 0; i < both.length; i++) {
        if (seen[both[i].id]) continue;
        seen[both[i].id] = true;
        rows.push(both[i]);
      }
      if (currentId() !== accountId) return;
      state.rows = rows;
      state.fetched_at = now();
      state.status = "ready";
      await o.host.writeDataText(FILE, JSON.stringify({ v: CACHE_VERSION, account: accountId, fetched_at: state.fetched_at, rows: rows }));
      log("catalog: " + rows.length + " models (" + mine.length + " in the project)");
    } catch (e) {
      if (currentId() !== accountId) return;
      state.status = state.rows ? "ready" : "failed";
      state.error = { type: e.type || "Internal", message: e.message || String(e) };
      log("catalog: refresh failed (" + state.error.type + ")");
    } finally {
      notify();
    }
  }

  function reset(accountId) {
    state = { account: accountId, rows: null, fetched_at: 0, status: "idle", error: null };
    schemas = {};
    loading = null;
  }

  // Resolves the rows for the current project; refreshes when asked, when
  // nothing is cached, or (in the background) when the cache is stale.
  async function ensure(opts) {
    opts = opts || {};
    var accountId = currentId();
    if (!accountId) throw new errorsMod.ScenarioError("NotSignedIn", "No Scenario key is saved in the plugin.");
    if (state.account !== accountId) {
      reset(accountId);
      var cached = parseCache(await o.host.readDataText(FILE));
      if (cached && cached.account === accountId && currentId() === accountId) {
        state.rows = cached.rows;
        state.fetched_at = cached.fetched_at;
        state.status = "ready";
      }
    }
    var stale = !state.rows || now() - state.fetched_at > MAP.listing.refresh_hours * 3600 * 1000;
    if (opts.force || stale) {
      if (!loading) {
        loading = fetchAll(accountId).then(function () {
          loading = null;
        });
      }
      if (opts.force || !state.rows) await loading;
    }
    if (!state.rows) {
      var err = state.error || { type: "Internal", message: "Models could not load." };
      throw new errorsMod.ScenarioError(err.type, err.message);
    }
    return state.rows;
  }

  function find(id) {
    if (!state.rows) return null;
    for (var i = 0; i < state.rows.length; i++) if (state.rows[i].id === id) return state.rows[i];
    return null;
  }

  // The model's schema, normalized (forms/schema.js). Kept for the session.
  async function schema(id) {
    if (!priceChecks.validModelId(id)) throw new errorsMod.ScenarioError("InvalidParameter", "model_id is not a Scenario model id.");
    var accountId = currentId();
    if (!accountId) throw new errorsMod.ScenarioError("NotSignedIn", "No Scenario key is saved in the plugin.");
    var key = accountId + "|" + id;
    if (schemas[key]) return schemas[key];
    var p = (async function () {
      var res;
      try {
        res = await o.client.request("GET", "/models/" + id);
      } catch (e) {
        if (e.status === 404) throw new errorsMod.ScenarioError("ModelUnavailable", "This model is no longer available to this key.");
        throw e;
      }
      var rec = res.body && res.body.model;
      if (!rec || rec.id !== id) throw new errorsMod.ScenarioError("Internal", "Scenario's model record did not match " + id + ".");
      var s = schemaMod.normalize(rec);
      s.row = displayRow(rec, rec.privacy === "private");
      return s;
    })();
    schemas[key] = p;
    p.catch(function () {
      if (schemas[key] === p) delete schemas[key];
    });
    return p;
  }

  // Schemas of the bases trained models run on (SPEC 3.4): only the ones
  // that load are returned.
  async function baseSchemas() {
    var ids = MAP.trained.base_probes;
    var out = [];
    var got = await Promise.all(
      ids.map(function (id) {
        return schema(id).then(
          function (s) {
            return s;
          },
          function () {
            return null;
          }
        );
      })
    );
    for (var i = 0; i < got.length; i++) if (got[i]) out.push(got[i]);
    return out;
  }

  return {
    ensure: ensure,
    rows: function () {
      return state.rows || [];
    },
    find: find,
    schema: schema,
    baseSchemas: baseSchemas,
    status: status,
    refresh: function () {
      return ensure({ force: true });
    },
    onChange: function (fn) {
      listeners.push(fn);
    }
  };
}

module.exports = { createCatalog: createCatalog, displayRow: displayRow, FILE: FILE };
