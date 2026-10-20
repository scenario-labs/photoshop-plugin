"use strict";
// Open from Library and + Reference > Library (FLOWS v2, changes after
// review 11): the project's images as a 3-column grid in the composer. A
// click opens one as a new document, or adds it to the refs row. Free
// reads only: GET /assets lists the project's assets newest first; a file
// is fetched from Scenario's CDN without the key, like a result.
//
// o: { client, downloader (scenario/download.js), host, log }

var ORIGIN = "https://cdn.cloud.scenario.com";
var PAGE = 30;
var SHOWN = 12;
var FOLDER = "Scenario/library";

function cdnUrl(u) {
  return typeof u === "string" && u.indexOf(ORIGIN + "/") === 0 ? u : null;
}

// One asset row of GET /assets as the grid shows it, or null for what the
// grid leaves out: other kinds, the plugin's own uploads (captures, masks,
// references, stand-ins), hidden assets.
function rowOf(a) {
  if (!a || typeof a.id !== "string") return null;
  var m = a.metadata && typeof a.metadata === "object" ? a.metadata : {};
  var kind = a.kind || m.kind;
  if (kind && kind !== "image") return null;
  var name = typeof a.name === "string" ? a.name : typeof m.name === "string" ? m.name : "";
  if (/^photoshop-(capture|mask|reference|stand-in)/.test(name) || m.hide === true) return null;
  var thumb = cdnUrl(a.thumbnail && a.thumbnail.url) || cdnUrl(a.url);
  return { asset_id: a.id, name: name || "Image", width: typeof m.width === "number" ? m.width : null, height: typeof m.height === "number" ? m.height : null, thumb: thumb, created_at: a.createdAt || null };
}

function createLibrary(o) {
  var log = o.log || function () {};
  var cache = { at: 0, rows: null };

  async function list(force) {
    if (!force && cache.rows && Date.now() - cache.at < 60000) return cache.rows;
    var res = await o.client.request("GET", "/assets", { query: { pageSize: String(PAGE) } });
    var body = res && res.body && typeof res.body === "object" ? res.body : {};
    var rows = (Array.isArray(body.assets) ? body.assets : []).map(rowOf).filter(Boolean).slice(0, SHOWN);
    cache = { at: Date.now(), rows: rows };
    return rows;
  }

  // Saves one asset in the data folder. Resolves { path, ext, mime,
  // width, height }.
  function fetch(assetId) {
    return o.downloader.download(assetId, FOLDER + "/" + assetId, null, null);
  }

  return { list: list, fetch: fetch, rowOf: rowOf };
}

module.exports = { createLibrary: createLibrary, rowOf: rowOf, SHOWN: SHOWN };
