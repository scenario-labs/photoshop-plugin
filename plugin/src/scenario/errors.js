"use strict";
// Classifies what Scenario's API answers (SPEC 3.13): by HTTP status and the
// error body's text. Scenario's bodies carry `reason` (400, 403, 404) or
// `message` (401, 413) and no code; the texts shared/scenario-api.json knows
// give their own type (an unknown key answers 403 "Given APIKey does not
// exists"), anything else is classified by status and keeps Scenario's text.
// Types are those of shared/errors.json. Messages are one line, cut to a
// readable length, and pass through the caller's redaction before anyone
// sees them.

var API = require("../../../shared/scenario-api.json");

var MAX_MESSAGE = 300;

function ScenarioError(type, message, extra) {
  this.name = "ScenarioError";
  this.type = type;
  this.message = message;
  extra = extra || {};
  this.status = extra.status === undefined ? null : extra.status;
  this.code = extra.code === undefined ? null : extra.code;
  this.scenarioMessage = extra.scenarioMessage || null;
  this.retryAfterS = extra.retryAfterS === undefined ? null : extra.retryAfterS;
}
ScenarioError.prototype = Object.create(Error.prototype);
ScenarioError.prototype.constructor = ScenarioError;
ScenarioError.prototype.toString = function () {
  return this.type + ": " + this.message;
};

function oneLine(text, max) {
  var out = String(text).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  max = max || MAX_MESSAGE;
  if (out.length > max) out = out.slice(0, max - 3) + "...";
  return out;
}

function firstString() {
  for (var i = 0; i < arguments.length; i++) if (typeof arguments[i] === "string" && arguments[i].trim()) return arguments[i];
  return null;
}

// Scenario's bodies are {reason} or {message}; the documented {status, code,
// message} and other common shapes ({error: "..."}, {error: {message}}) are
// read too, so an answer in another shape still shows its text.
function readBody(body) {
  if (!body || typeof body !== "object") return { code: null, message: typeof body === "string" ? body : null };
  var nested = body.error && typeof body.error === "object" ? body.error : {};
  var code = firstString(body.code, nested.code);
  var message = firstString(body.reason, body.message, nested.reason, nested.message, body.error_description, typeof body.error === "string" ? body.error : null);
  return { code: code, message: message };
}

function retryAfter(headers, nowMs) {
  var raw = null;
  try {
    raw = headers && typeof headers.get === "function" ? headers.get("retry-after") : null;
  } catch (e) {
    raw = null;
  }
  if (raw === null || raw === undefined || raw === "") return null;
  if (/^\s*\d+\s*$/.test(raw)) return Number(raw);
  var at = Date.parse(raw);
  if (isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - (nowMs || Date.now())) / 1000));
}

// A text shared/scenario-api.json knows, at its status: its error type.
function typeForText(status, text) {
  if (!text) return null;
  var lower = String(text).toLowerCase();
  var list = API.known_errors.texts;
  for (var i = 0; i < list.length; i++) {
    if (list[i].status === status && lower.indexOf(String(list[i].text).toLowerCase()) >= 0) return list[i].type;
  }
  return null;
}

// clean(text) removes secrets; it is applied before the text is kept anywhere.
function fromResponse(status, body, headers, clean) {
  clean = clean || function (t) {
    return t;
  };
  var parsed = readBody(body);
  var scenarioMessage = parsed.message ? oneLine(clean(parsed.message)) : null;
  var code = parsed.code ? oneLine(clean(parsed.code), 64) : null;
  var type = typeForText(status, parsed.message);
  if (!type) {
    if (status === 401) type = "Unauthorized";
    else if (status === 403) type = "Forbidden";
    else if (status === 429) type = "RateLimited";
    else type = "Internal";
  }
  var text = "Scenario answered HTTP " + status + (scenarioMessage ? ": " + scenarioMessage : "") + (code ? " (" + code + ")" : "");
  return new ScenarioError(type, text, { status: status, code: code, scenarioMessage: scenarioMessage, retryAfterS: status === 429 ? retryAfter(headers) : null });
}

function causeText(e) {
  var parts = [];
  for (var depth = 0; e && depth < 3; depth++) {
    if (e.message) parts.push(String(e.message));
    e = e.cause;
  }
  return parts.join(" ");
}

// fetch rejected: no answer from Scenario. A refused redirect is told apart
// because the plugin never follows one with the key (SPEC 2.10, Credentials).
function networkError(e) {
  if (/redirect/i.test(causeText(e))) {
    return new ScenarioError("Internal", "Scenario answered with a redirect; the plugin does not follow redirects with your key.");
  }
  return new ScenarioError("Offline", "No connection to Scenario.");
}

function timeoutError(ms) {
  return new ScenarioError("Offline", "Scenario did not answer within " + Math.round(ms / 1000) + " s.");
}

module.exports = {
  ScenarioError: ScenarioError,
  fromResponse: fromResponse,
  networkError: networkError,
  timeoutError: timeoutError,
  retryAfter: retryAfter,
  readBody: readBody,
  typeForText: typeForText,
  oneLine: oneLine
};
