"use strict";
// Sign in with Scenario in the browser: the OAuth 2.0 device authorization
// grant (RFC 8628) against Scenario's identity provider, and the session that
// keeps the access token fresh.
//
// - UXP cannot listen on a loopback port, so the plugin asks for a device
//   code, shows its short user code, opens the verification page in the
//   browser (Photoshop asks first) and polls the token endpoint until the
//   person approves, denies, cancels or the code expires.
// - The plugin is a public client: it sends its client id, never a secret.
// - Requests go to the issuer's origin only, form encoded, with redirects
//   refused. Token answers are never logged; tokens go to the redactor.
// - accounts.js keeps the refresh token in Photoshop's secure storage. The
//   access token lives in memory only, so a new Photoshop start refreshes
//   once. A refresh rotates the refresh token; one refresh runs at a time.

var API = require("../../../shared/scenario-api.json");
var b64 = require("../util/base64url.js");
var utf8 = require("../util/utf8.js");
var errorsMod = require("../scenario/errors.js");

var CFG = API.oauth;
var DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// What a sign-in or a refresh can end with, besides tokens. The panel words
// each one (account-view.js); none carries a token.
function OAuthError(state, message) {
  this.name = "OAuthError";
  this.state = state;
  this.message = message;
}
OAuthError.prototype = Object.create(Error.prototype);
OAuthError.prototype.constructor = OAuthError;

function originOf(url) {
  var m = /^(https?:\/\/[^\/?#]+)/i.exec(String(url));
  return m ? m[1].toLowerCase() : null;
}

// The production application of shared/scenario-api.json, or a development
// target (dev/oauth-target.js) with its own issuer, client id and API base.
function productionTarget() {
  return { issuer: CFG.issuer, client_id: CFG.client_id, scope: CFG.scope, api_base: API.base_url };
}

function form(fields) {
  var parts = [];
  for (var k in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
    if (fields[k] === null || fields[k] === undefined) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(fields[k])));
  }
  return parts.join("&");
}

function parseJson(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// The claims of a JWT access token, read without checking the signature:
// Scenario's API checks it. Only `sub` (who signed in) and `exp` are used.
function claims(token) {
  if (typeof token !== "string") return null;
  var parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    var c = JSON.parse(utf8.decode(b64.decode(parts[1])));
    return c && typeof c === "object" ? c : null;
  } catch (e) {
    return null;
  }
}

// A token answer, checked. nowMs: when the request was sent, so the expiry
// errs early.
function tokensFrom(body, nowMs) {
  if (!body || typeof body.access_token !== "string" || !body.access_token) return null;
  if (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer") return null;
  if (typeof body.refresh_token !== "string" || !body.refresh_token) return null;
  var c = claims(body.access_token);
  var subject = c && typeof c.sub === "string" && c.sub ? c.sub : null;
  if (!subject) return null;
  var life = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : c && typeof c.exp === "number" ? c.exp - Math.floor(nowMs / 1000) : 0;
  // The ID token (scope openid) names the account's email, shown in the
  // panel; it must be about the same person as the access token.
  var id = claims(body.id_token);
  var email = id && id.sub === subject && typeof id.email === "string" ? id.email : null;
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: nowMs + Math.max(0, life) * 1000, subject: subject, email: email };
}

// o: { fetch, AbortController, timers: {setTimeout, clearTimeout, now},
//      target: {issuer, client_id, scope}, redactor, sleep(ms) (tests) }
function createOAuth(o) {
  var target = o.target || productionTarget();
  var issuer = String(target.issuer).replace(/\/+$/, "");
  var issuerOrigin = originOf(issuer);
  var setT = (o.timers && o.timers.setTimeout) || setTimeout;
  var clearT = (o.timers && o.timers.clearTimeout) || clearTimeout;
  var now =
    (o.timers && o.timers.now) ||
    function () {
      return Date.now();
    };
  var sleep =
    o.sleep ||
    function (ms) {
      return new Promise(function (resolve) {
        setT(resolve, ms);
      });
    };

  function remember(t) {
    if (!o.redactor || !t) return;
    o.redactor.add(t.access_token);
    o.redactor.add(t.refresh_token);
  }

  // One form POST to the issuer. Resolves { status, body }; rejects with
  // OAuthError("offline") when nothing came back.
  async function post(path, fields) {
    if (typeof o.fetch !== "function") throw new OAuthError("failed", "This Photoshop offers no fetch.");
    var url = issuer + path;
    if (originOf(url) !== issuerOrigin) throw new OAuthError("failed", "Sign-in requests go to the identity provider only.");
    var controller = null;
    if (o.AbortController) {
      try {
        controller = new o.AbortController();
      } catch (e) {
        controller = null;
      }
    }
    var init = {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form(fields),
      redirect: "error"
    };
    if (controller) init.signal = controller.signal;
    var timer = null;
    var timeout = new Promise(function (resolve, reject) {
      timer = setT(function () {
        try {
          if (controller) controller.abort();
        } catch (e) {
          // nothing more to do
        }
        reject(new OAuthError("offline", "No answer from Scenario's sign-in."));
      }, CFG.timeout_ms);
    });
    var work = Promise.resolve()
      .then(function () {
        return o.fetch(url, init);
      })
      .then(function (res) {
        return Promise.resolve(res.text()).then(function (text) {
          return { status: res.status, body: parseJson(text) };
        });
      });
    try {
      return await Promise.race([work, timeout]);
    } catch (e) {
      if (e instanceof OAuthError) throw e;
      throw new OAuthError("offline", "No connection to Scenario's sign-in.");
    } finally {
      clearT(timer);
    }
  }

  function errorCode(res) {
    return res.body && typeof res.body.error === "string" ? res.body.error : null;
  }

  // Step 1: a device code and the user code to show. The verification page
  // must be an https page; the complete link carries the user code.
  async function startDevice() {
    var res = await post(CFG.device_authorization_path, { client_id: target.client_id, scope: target.scope || CFG.scope });
    var b = res.body;
    if (res.status !== 200 || !b || typeof b.device_code !== "string" || typeof b.user_code !== "string" || typeof b.verification_uri !== "string") {
      throw new OAuthError("failed", "Scenario's sign-in did not start (HTTP " + res.status + (errorCode(res) ? ", " + errorCode(res) : "") + ").");
    }
    var page = typeof b.verification_uri_complete === "string" ? b.verification_uri_complete : b.verification_uri;
    if (!/^https:\/\//i.test(page) || !/^https:\/\//i.test(b.verification_uri)) throw new OAuthError("failed", "Scenario's sign-in page is not an https page.");
    var interval = typeof b.interval === "number" && b.interval > 0 ? b.interval : CFG.poll_default_interval_s;
    var life = typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : CFG.device_default_life_s;
    if (o.redactor) o.redactor.add(b.device_code);
    return {
      device_code: b.device_code,
      user_code: b.user_code,
      verification_uri: b.verification_uri,
      page: page,
      interval_s: interval,
      expires_at: now() + life * 1000
    };
  }

  // Step 2: polls until the person approves (tokens), denies, cancels or the
  // code expires. hooks: { cancelled() -> boolean, onWait(seconds) }.
  async function waitForApproval(device, hooks) {
    hooks = hooks || {};
    var cancelled = hooks.cancelled || function () {
      return false;
    };
    var interval = device.interval_s;
    for (;;) {
      if (cancelled()) throw new OAuthError("cancelled", "Sign-in cancelled.");
      if (now() >= device.expires_at) throw new OAuthError("expired", "The sign-in code expired.");
      await sleep(interval * 1000);
      if (cancelled()) throw new OAuthError("cancelled", "Sign-in cancelled.");
      var sent = now();
      var res;
      try {
        res = await post(CFG.token_path, { grant_type: DEVICE_GRANT, device_code: device.device_code, client_id: target.client_id });
      } catch (e) {
        // A lost answer is retried at the next interval until the code expires.
        if (e.state === "offline") {
          if (hooks.onWait) hooks.onWait(interval);
          continue;
        }
        throw e;
      }
      if (res.status === 200) {
        var t = tokensFrom(res.body, sent);
        if (!t) throw new OAuthError("failed", "Scenario's sign-in answered without a usable token.");
        remember(t);
        return t;
      }
      var code = errorCode(res);
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        interval += CFG.slow_down_step_s;
        continue;
      }
      if (code === "access_denied") throw new OAuthError("denied", "The sign-in was declined in the browser.");
      if (code === "expired_token") throw new OAuthError("expired", "The sign-in code expired.");
      throw new OAuthError("failed", "Scenario's sign-in refused the code (HTTP " + res.status + (code ? ", " + code : "") + ").");
    }
  }

  // A refresh: new tokens, the refresh token rotated. A refused refresh token
  // ends the session ("ended"); a lost answer is "offline" and keeps it.
  async function refresh(refreshToken) {
    var sent = now();
    var res = await post(CFG.token_path, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: target.client_id });
    if (res.status === 200) {
      var t = tokensFrom(res.body, sent);
      if (!t) throw new OAuthError("failed", "Scenario's sign-in answered without a usable token.");
      remember(t);
      return t;
    }
    var code = errorCode(res);
    if (code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client") throw new OAuthError("ended", "The Scenario sign-in ended. Sign in again.");
    if (res.status === 429 || res.status >= 500) throw new OAuthError("offline", "Scenario's sign-in is busy. Try again in a moment.");
    throw new OAuthError("failed", "Scenario's sign-in refused the refresh (HTTP " + res.status + (code ? ", " + code : "") + ").");
  }

  // Sign out: asks the identity provider to revoke the refresh token. Best
  // effort; the plugin forgets the token either way.
  async function revoke(refreshToken) {
    try {
      var res = await post(CFG.revocation_path, { token: refreshToken, token_type_hint: "refresh_token", client_id: target.client_id });
      return res.status === 200;
    } catch (e) {
      return false;
    }
  }

  return { startDevice: startDevice, waitForApproval: waitForApproval, refresh: refresh, revoke: revoke, target: target, issuer: issuer };
}

// The tokens of one signed-in account. The access token is refreshed when it
// has less than refresh_margin_s left, one refresh at a time; the rotated
// refresh token is saved before the new access token is used.
// o: { oauth, refresh_token, access_token, expires_at, now(),
//      save(refreshToken) -> Promise, onEnd() }
function createSession(o) {
  var refreshToken = o.refresh_token;
  var access = o.access_token || null;
  var expiresAt = o.expires_at || 0;
  var pending = null;
  var ended = false;
  var now =
    o.now ||
    function () {
      return Date.now();
    };

  function fresh() {
    return access && expiresAt - now() > CFG.refresh_margin_s * 1000;
  }

  async function renew() {
    var t;
    try {
      t = await o.oauth.refresh(refreshToken);
    } catch (e) {
      if (e && e.state === "ended") {
        ended = true;
        access = null;
        if (o.onEnd) {
          try {
            await o.onEnd();
          } catch (e2) {
            // the request fails as signed out either way
          }
        }
        throw new errorsMod.ScenarioError("NotSignedIn", "The Scenario sign-in ended. Sign in again in the panel.");
      }
      if (e && e.state === "offline") throw new errorsMod.ScenarioError("Offline", e.message);
      throw new errorsMod.ScenarioError("Internal", (e && e.message) || "The Scenario sign-in could not be refreshed.");
    }
    refreshToken = t.refresh_token;
    access = t.access_token;
    expiresAt = t.expires_at;
    // The old refresh token no longer works: a save that fails leaves this
    // start signed in, and the next start asks to sign in again.
    try {
      await o.save(t.refresh_token);
    } catch (e) {
      if (o.onSaveFailed) o.onSaveFailed(e);
    }
    return access;
  }

  // The access token for the next request. `force` drops the current one
  // first (after a 401).
  async function token(force) {
    if (ended) throw new errorsMod.ScenarioError("NotSignedIn", "The Scenario sign-in ended. Sign in again in the panel.");
    if (force) access = null;
    if (fresh()) return access;
    if (!pending) {
      pending = renew().then(
        function (v) {
          pending = null;
          return v;
        },
        function (e) {
          pending = null;
          throw e;
        }
      );
    }
    return pending;
  }

  return {
    token: token,
    // After a write answered 401: the next request gets a new token.
    invalidate: function () {
      access = null;
    },
    ended: function () {
      return ended;
    },
    refreshToken: function () {
      return refreshToken;
    }
  };
}

module.exports = { createOAuth: createOAuth, createSession: createSession, OAuthError: OAuthError, claims: claims, tokensFrom: tokensFrom, productionTarget: productionTarget, form: form, DEVICE_GRANT: DEVICE_GRANT };
