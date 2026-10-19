"use strict";
// Uploads to the Scenario project through POST /v1/assets, and the blank
// stand-ins price checks use (SPEC 6.1 item 3).
//
// - The body is {image: <base64 of the file, no data: prefix>, name, hide:
//   true}; the answer is {asset: {id, metadata: {width, height}}} (measured
//   live 2026-10-19). No projectId is needed: the key's project receives it.
// - A stand-in is a black PNG the plugin makes. It holds no document pixels,
//   is uploaded once per project and size, hidden from the Library like the
//   plugin's other uploads, and named photoshop-standin-<W>x<H>.png. Its
//   asset id is kept in the plugin data file stand-ins.json, by account.

var MAP = require("../../../shared/catalog-map.json");
var errorsMod = require("./errors.js");
var png = require("../util/png.js");
var b64 = require("../util/base64url.js");

var FILE = "stand-ins.json";
var ASSET_ID = /^asset_[A-Za-z0-9_-]{1,128}$/;

function validAssetId(id) {
  return typeof id === "string" && ASSET_ID.test(id);
}

// Uploads PNG bytes. Resolves { asset_id, width, height }.
async function uploadPng(client, bytes, name) {
  var res = await client.request("POST", "/assets", { body: { image: b64.encodeStandard(bytes), name: name, hide: true } });
  var asset = res.body && res.body.asset;
  if (!asset || !validAssetId(asset.id)) throw new errorsMod.ScenarioError("Internal", "Scenario's upload answer had no asset id.");
  var meta = asset.metadata || {};
  return { asset_id: asset.id, width: typeof meta.width === "number" ? meta.width : null, height: typeof meta.height === "number" ? meta.height : null };
}

function parse(text) {
  try {
    var v = JSON.parse(text);
    return v && typeof v === "object" && v.v === 1 && v.accounts && typeof v.accounts === "object" ? v : null;
  } catch (e) {
    return null;
  }
}

// o: { client, host, account() -> {id} | null, log }
function createStandIns(o) {
  var data = null;
  var inFlight = {};
  var log = o.log || function () {};

  async function load() {
    if (data) return data;
    var text = await o.host.readDataText(FILE);
    data = (text && parse(text)) || { v: 1, accounts: {} };
    return data;
  }

  async function save() {
    await o.host.writeDataText(FILE, JSON.stringify(data));
  }

  function sizeKey(w, h) {
    return w + "x" + h;
  }

  // Resolves the asset id of a blank stand-in of this size in the current
  // project, uploading it the first time.
  async function get(width, height) {
    var acc = o.account();
    if (!acc) throw new errorsMod.ScenarioError("NotSignedIn", "No Scenario key is saved in the plugin.");
    width = Math.round(width);
    height = Math.round(height);
    var key = sizeKey(width, height);
    var d = await load();
    var mine = d.accounts[acc.id] || {};
    if (validAssetId(mine[key])) return mine[key];
    var flightKey = acc.id + ":" + key;
    if (inFlight[flightKey]) return inFlight[flightKey];
    inFlight[flightKey] = (async function () {
      try {
        var up = await uploadPng(o.client, png.blackPng(width, height), MAP.stand_ins.name_prefix + key + ".png");
        var d2 = await load();
        d2.accounts[acc.id] = d2.accounts[acc.id] || {};
        d2.accounts[acc.id][key] = up.asset_id;
        await save();
        log("price check: blank stand-in " + key + " uploaded");
        return up.asset_id;
      } finally {
        delete inFlight[flightKey];
      }
    })();
    return inFlight[flightKey];
  }

  // Scenario answered "Asset not found" for a stand-in (deleted in the web
  // app): forget the account's stand-ins so the next price check uploads anew.
  async function forget(accountId) {
    var d = await load();
    if (!d.accounts[accountId]) return false;
    delete d.accounts[accountId];
    await save();
    return true;
  }

  function isStandIn(accountId, assetId) {
    var mine = data && data.accounts[accountId];
    if (!mine) return false;
    for (var k in mine) if (mine[k] === assetId) return true;
    return false;
  }

  return { get: get, forget: forget, isStandIn: isStandIn, small: MAP.stand_ins.small_px };
}

module.exports = { uploadPng: uploadPng, createStandIns: createStandIns, validAssetId: validAssetId, FILE: FILE };
