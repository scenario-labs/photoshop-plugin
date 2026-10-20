"use strict";
// Result downloads (SPEC 6.4 item 3). Each attempt reads the asset record for
// a fresh signed link (kept in memory only), checks that the link's host is
// one of Scenario's download hosts, fetches it without any Authorization
// header (the CDN answers a fresh link with a 302 to the same host, then the
// file; measured live 2026-10-19), checks the bytes are an image whose
// header reads right, writes them to <file>.part and renames the part to the
// file. Three attempts with back-off; a link on another host stops at once
// (ResultUnreachable), an asset gone from Scenario too (ResultExpired). An
// expired signed link (the CDN answers 403) is not final: the next attempt
// asks for a fresh one. A partial file restarts from zero (no Range
// request). Stop download aborts the attempt in progress and removes its
// part file; the person resumes later with fresh links.

var API = require("../../../shared/scenario-api.json");
var errorsMod = require("./errors.js");
var jobsApi = require("./jobs-api.js");
var png = require("../util/png.js");
var jpeg = require("../util/jpeg.js");

var ATTEMPTS = 3;
var BACKOFF_MS = [1000, 3000];
var TIMEOUT_MS = 120000;

function originOf(url) {
  var m = /^(https?:\/\/[^\/?#]+)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : null;
}

function u32le(b, at) {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

function isWebp(b) {
  return b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
}

function webpInfo(b) {
  var kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  if (kind === "VP8L") {
    var bits = u32le(b, 21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (kind === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  throw new Error("broken WebP file");
}

// What the bytes are: { ext, mime, width, height }, or throws.
// An MP4 clip (Animate, FLOWS v2 F9): an ISO media file whose first box is
// "ftyp". Its size comes from the first track header with a width.
function isMp4(b) {
  return b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;
}

function u32be(b, at) {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

function mp4Size(b) {
  var CONTAINERS = { moov: 1, trak: 1 };
  function walk(from, to, depth) {
    var at = from;
    while (at + 8 <= to && depth < 6) {
      var size = u32be(b, at);
      var type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
      if (size < 8 || at + size > to) return null;
      if (type === "tkhd") {
        var version = b[at + 8];
        var end = at + size;
        var w = u32be(b, end - 8) / 65536;
        var h = u32be(b, end - 4) / 65536;
        if (version <= 1 && w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) };
      } else if (CONTAINERS[type]) {
        var got = walk(at + 8, at + size, depth + 1);
        if (got) return got;
      }
      at += size;
    }
    return null;
  }
  return walk(0, b.length, 0) || { width: null, height: null };
}

function sniff(bytes) {
  if (isMp4(bytes)) {
    var m = mp4Size(bytes);
    return { ext: "mp4", mime: "video/mp4", width: m.width, height: m.height };
  }
  if (png.isPng(bytes)) {
    var p = png.pngInfo(bytes);
    return { ext: "png", mime: "image/png", width: p.width, height: p.height };
  }
  if (jpeg.isJpeg(bytes)) {
    var j = jpeg.jpegInfo(bytes);
    return { ext: "jpg", mime: "image/jpeg", width: j.width, height: j.height };
  }
  if (isWebp(bytes)) {
    var w = webpInfo(bytes);
    return { ext: "webp", mime: "image/webp", width: w.width, height: w.height };
  }
  throw new Error("the file is not a PNG, JPEG or WebP image, or an MP4 clip");
}

// o: { client, fetch, AbortController, timers: {setTimeout, clearTimeout},
//      files: { writeBinary(path, bytes), rename(from, to), remove(path) },
//      origins (allowed download origins; tests only), sleep(ms) (tests),
//      hooks (dev/test-hooks.js: the `download_part` point, between the
//      part file and the rename; development builds only) }
function createDownloader(o) {
  var origins = (o.origins || API.downloads.origins).map(function (x) {
    return String(x).toLowerCase();
  });
  var setT = (o.timers && o.timers.setTimeout) || setTimeout;
  var clearT = (o.timers && o.timers.clearTimeout) || clearTimeout;
  var sleep =
    o.sleep ||
    function (ms) {
      return new Promise(function (resolve) {
        setT(resolve, ms);
      });
    };

  var hooks = o.hooks || null;

  function allowed(url) {
    return origins.indexOf(originOf(url)) >= 0;
  }

  function stoppedError() {
    var e = new errorsMod.ScenarioError("Internal", "Download stopped by you.");
    e.final = true;
    e.stopped = true;
    return e;
  }

  async function fetchOnce(url, token) {
    var controller = null;
    if (o.AbortController) {
      try {
        controller = new o.AbortController();
      } catch (e) {
        controller = null;
      }
    }
    var timer = null;
    var init = { method: "GET", redirect: "follow", credentials: "omit", headers: {} };
    if (controller) init.signal = controller.signal;
    var stopRace = null;
    if (token) {
      stopRace = new Promise(function (resolve, reject) {
        token.onStop = function () {
          try {
            if (controller) controller.abort();
          } catch (e) {
            // nothing more to do
          }
          reject(stoppedError());
        };
      });
    }
    var timeout = new Promise(function (resolve, reject) {
      timer = setT(function () {
        try {
          if (controller) controller.abort();
        } catch (e) {
          // nothing more to do
        }
        reject(new Error("the download did not finish within " + TIMEOUT_MS / 1000 + " s"));
      }, TIMEOUT_MS);
    });
    try {
      var res = await Promise.race(stopRace ? [o.fetch(url, init), timeout, stopRace] : [o.fetch(url, init), timeout]);
      if (res.url && !allowed(res.url)) {
        var e = new errorsMod.ScenarioError("ResultUnreachable", "Stored on a host this plugin can't reach.");
        e.final = true;
        throw e;
      }
      if (res.status !== 200) {
        var bad = new Error("the download answered HTTP " + res.status);
        bad.status = res.status;
        throw bad;
      }
      var buf = await Promise.race(stopRace ? [res.arrayBuffer(), timeout, stopRace] : [res.arrayBuffer(), timeout]);
      var bytes = new Uint8Array(buf);
      var declared = null;
      try {
        declared = res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : null;
      } catch (e2) {
        declared = null;
      }
      if (declared !== null && /^\d+$/.test(String(declared)) && Number(declared) !== bytes.length) throw new Error("the download was cut short");
      if (!bytes.length) throw new Error("the download was empty");
      return bytes;
    } finally {
      clearT(timer);
      if (token) token.onStop = null;
    }
  }

  // Downloads one asset to `<base>.<ext>`. Resolves { path, ext, mime,
  // width, height, bytes: size }. onAttempt(n) reports each attempt. token
  // (optional): { stopped } set by stop(token); a stopped download rejects
  // with e.stopped.
  async function download(assetId, base, onAttempt, token) {
    var last = null;
    for (var attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (token && token.stopped) throw stoppedError();
      if (onAttempt) onAttempt(attempt);
      var part = null;
      try {
        var info = await jobsApi.getAsset(o.client, assetId);
        if (!allowed(info.url)) throw new errorsMod.ScenarioError("ResultUnreachable", "Stored on a host this plugin can't reach.");
        var bytes = await fetchOnce(info.url, token);
        if (token && token.stopped) throw stoppedError();
        var kind = sniff(bytes);
        var path = base + "." + kind.ext;
        part = path + ".part";
        await o.files.writeBinary(part, bytes);
        if (hooks) await hooks.at("download_part", { asset_id: assetId, part: part });
        if (token && token.stopped) throw stoppedError();
        await o.files.rename(part, path);
        return { path: path, ext: kind.ext, mime: kind.mime, width: kind.width, height: kind.height, bytes: bytes.length };
      } catch (err) {
        last = err;
        if (err && err.stopped) {
          if (part && o.files.remove) {
            try {
              await o.files.remove(part);
            } catch (e) {
              // a leftover part file is overwritten by the next attempt
            }
          }
          throw err;
        }
        if (err && (err.type === "ResultUnreachable" || err.type === "ResultExpired" || err.final)) throw err;
        if (attempt < ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1] || 3000);
      }
    }
    var stopped = new errorsMod.ScenarioError("Internal", "Download stopped after " + ATTEMPTS + " attempts" + (last && last.message ? ": " + last.message : "."));
    stopped.downloadFailed = true;
    throw stopped;
  }

  // Stops a download started with this token.
  function stop(token) {
    if (!token) return;
    token.stopped = true;
    if (typeof token.onStop === "function") token.onStop();
  }

  return { download: download, stop: stop, allowed: allowed };
}

module.exports = { createDownloader: createDownloader, sniff: sniff, mp4Size: mp4Size, originOf: originOf, ATTEMPTS: ATTEMPTS, BACKOFF_MS: BACKOFF_MS };
