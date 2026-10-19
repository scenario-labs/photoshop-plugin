"use strict";
// REST client for Scenario's API (SPEC 2.3, module `scenario`).
//
// - Every URL is the API base plus a relative path, so the Authorization
//   header (HTTP Basic, key and secret) can only go to api.cloud.scenario.com.
//   Downloads and uploads to other hosts will use their own code, never this
//   client.
// - Redirects are refused (`redirect: "error"`): no redirected request carries
//   the key. Photoshop 26.9 and later also drop the header on a cross-origin
//   redirect (SPEC 2.10).
// - Reads (GET) retry on 429 and on 502 to 504; nothing else is retried.
// - Request and response bodies are never logged.
//
// Seams for M2 after the M2.0 measurements: the catalog, model schemas, dry
// runs (price checks), runs, jobs, assets and uploads are built on request()
// in their own modules. Paid requests pass `paid: true`: no retry, 60 s
// timeout (SPEC 6.1).

var API = require("../../../shared/scenario-api.json");
var errorsMod = require("./errors.js");
var utf8 = require("../util/utf8.js");
var b64 = require("../util/base64url.js");

var PAID_TIMEOUT_MS = 60000;

function basicToken(pair) {
  return b64.encodeStandard(utf8.encode(pair.key + ":" + pair.secret));
}

function originOf(url) {
  var m = /^(https?:\/\/[^\/?#]+)/i.exec(String(url));
  return m ? m[1].toLowerCase() : null;
}

function queryString(query) {
  if (!query) return "";
  var parts = [];
  for (var k in query) {
    if (!Object.prototype.hasOwnProperty.call(query, k)) continue;
    var v = query[k];
    if (v === null || v === undefined) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
  }
  return parts.length ? "?" + parts.join("&") : "";
}

function parseJson(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// opts: { fetch, AbortController, timers: {setTimeout, clearTimeout},
//         credentials() -> {key, secret} | null, redactor,
//         baseUrl and sleep(ms) (tests only) }
function createClient(opts) {
  var baseUrl = String(opts.baseUrl || API.base_url).replace(/\/+$/, "");
  var apiOrigin = originOf(baseUrl);
  var fetchFn = opts.fetch;
  var AC = opts.AbortController || null;
  var setT = (opts.timers && opts.timers.setTimeout) || setTimeout;
  var clearT = (opts.timers && opts.timers.clearTimeout) || clearTimeout;
  var redactor = opts.redactor || null;

  var sleep =
    opts.sleep ||
    function (ms) {
      return new Promise(function (resolve) {
        setT(resolve, ms);
      });
    };

  function cleaner(pair) {
    return function (text) {
      var out = String(text);
      if (pair) {
        var values = [pair.key, pair.secret, basicToken(pair)];
        for (var i = 0; i < values.length; i++) if (values[i] && values[i].length >= 4) out = out.split(values[i]).join("[redacted]");
      }
      return redactor ? redactor.apply(out) : out;
    };
  }

  function buildUrl(path, query) {
    if (typeof path !== "string" || path.charAt(0) !== "/" || path.indexOf("//") >= 0 || /[?#\\]/.test(path) || /(^|\/)\.\.?(\/|$)/.test(path)) {
      throw new errorsMod.ScenarioError("Internal", "API paths are relative to the API base.");
    }
    return baseUrl + path + queryString(query);
  }

  function once(url, init, timeoutMs) {
    var controller = null;
    if (AC) {
      try {
        controller = new AC();
      } catch (e) {
        controller = null;
      }
    }
    if (controller) init.signal = controller.signal;
    var timer = null;
    var timedOut = false;
    var timeout = new Promise(function (resolve, reject) {
      timer = setT(function () {
        timedOut = true;
        try {
          if (controller) controller.abort();
        } catch (e) {
          // nothing more to do
        }
        reject(errorsMod.timeoutError(timeoutMs));
      }, timeoutMs);
    });
    var work = Promise.resolve()
      .then(function () {
        return fetchFn(url, init);
      })
      .then(function (res) {
        return Promise.resolve(res.text()).then(function (text) {
          return { status: res.status, headers: res.headers, text: text };
        });
      });
    return Promise.race([work, timeout]).then(
      function (r) {
        clearT(timer);
        return r;
      },
      function (e) {
        clearT(timer);
        if (timedOut || (e && e.type === "Offline")) throw errorsMod.timeoutError(timeoutMs);
        throw errorsMod.networkError(e);
      }
    );
  }

  // o: { query, body, credentials (overrides the saved pair, for Save and
  //      test), retries, timeoutMs, paid, onWait(seconds, error) }
  // Resolves { status, body }; rejects with a ScenarioError.
  async function request(method, path, o) {
    o = o || {};
    if (typeof fetchFn !== "function") throw new errorsMod.ScenarioError("Internal", "This Photoshop offers no fetch.");
    var pair = o.credentials || (opts.credentials ? opts.credentials() : null);
    if (!pair || !pair.key || !pair.secret) throw new errorsMod.ScenarioError("NotSignedIn", "No Scenario key is saved in the plugin.");
    var url = buildUrl(path, o.query);
    var headers = { Accept: "application/json" };
    // Always true for a URL built above; kept as the one place the header is set.
    if (originOf(url) === apiOrigin) headers.Authorization = "Basic " + basicToken(pair);
    var init = { method: method, headers: headers, redirect: "error" };
    if (o.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(o.body);
    }
    var isRead = method === "GET" && !o.paid;
    var retries = isRead ? (o.retries === undefined ? API.reads.retries : o.retries) : 0;
    var timeoutMs = o.timeoutMs || (o.paid ? PAID_TIMEOUT_MS : API.reads.timeout_ms);
    var clean = cleaner(pair);
    for (var attempt = 0; ; attempt++) {
      var res = await once(url, Object.assign({}, init), timeoutMs);
      var body = parseJson(res.text);
      if (res.status >= 200 && res.status < 300) return { status: res.status, body: body };
      var err = errorsMod.fromResponse(res.status, body !== null ? body : res.text, res.headers, clean);
      if (attempt < retries && API.reads.retry_statuses.indexOf(res.status) >= 0) {
        var wait = res.status === 429 ? err.retryAfterS || API.reads.rate_limit_default_wait_s : API.reads.server_error_wait_s;
        wait = Math.max(1, Math.min(API.reads.rate_limit_max_wait_s, wait));
        if (o.onWait) o.onWait(wait, err);
        await sleep(wait * 1000);
        continue;
      }
      throw err;
    }
  }

  return { request: request, baseUrl: baseUrl };
}

module.exports = { createClient: createClient, basicToken: basicToken, originOf: originOf, PAID_TIMEOUT_MS: PAID_TIMEOUT_MS };
