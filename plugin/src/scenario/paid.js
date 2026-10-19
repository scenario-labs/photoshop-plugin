"use strict";
// The paid request (SPEC 6.1 items 8 and 9): POST /v1/generate/custom/{id}
// with no query string at all, sent once. The client lets a POST to
// /generate through only with the frozen PAID_REQUEST marker below (compared
// by identity) and no query, or as a price check from scenario/dry-run.js.
// The body is checked here too: the price-check flag's name, taken from
// dry-run.js so it is written in one file only, never rides on a paid body.
//
// The answer is classified, never retried:
//   2xx with a job id                          queued
//   2xx whose body has no job id               uncertain, and the dry-run alarm
//   2xx with an unreadable body                uncertain
//   400, 404, 409, 413, 422                    not_sent
//   401, 403                                   not_sent (key, scope or plan)
//   402                                        not_sent (not enough CU)
//   429                                        not_sent; paid requests pause for
//                                              Retry-After, else 60 s
//   no answer in 60 s, connection lost, 5xx,   uncertain: a job may exist
//   a redirect, any other status
// Any other status reads as uncertain: the reading that never loses a paid
// result. Measured live 2026-10-19: 200 with {job: {jobId, billing, status,
// metadata}, creativeUnitsCost, creativeUnitsDiscount, costDetails}; 400
// {reason} for a bad enum, with no job.

var API = require("../../../shared/scenario-api.json");
var errorsMod = require("./errors.js");
var priceChecks = require("./dry-run.js");

var PAID_REQUEST = Object.freeze({ kind: "paid generation" });
var PAUSE_DEFAULT_S = API.paid.pause_default_s;
var JOB_ID = /^job_[A-Za-z0-9_-]{1,128}$/;

// The price-check flag's name, read from the one constant that holds it.
var CHECK_FLAG = Object.keys(priceChecks.DRY_RUN_QUERY)[0].toLowerCase();

function validJobId(id) {
  return typeof id === "string" && JOB_ID.test(id);
}

function paidPath(modelId) {
  return priceChecks.priceCheckPath(modelId);
}

// The body as sent: plain JSON values only, and never the price-check flag.
function checkBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new errorsMod.ScenarioError("Internal", "A paid request needs a parameter object.");
  for (var k in body) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
    if (String(k).toLowerCase() === CHECK_FLAG) throw new errorsMod.ScenarioError("Internal", "A paid request never carries the price-check flag.");
  }
  return body;
}

function classifyAnswer(res) {
  var body = res ? res.body : null;
  if (!body || typeof body !== "object") {
    return { status: "uncertain", alarm: false, reason: "Scenario's answer could not be read (HTTP " + (res ? res.status : "?") + "). A job may exist.", http: res ? res.status : null };
  }
  var job = body.job && typeof body.job === "object" ? body.job : null;
  var jobId = job ? job.jobId || job.id : null;
  if (validJobId(jobId)) return { status: "queued", job_id: jobId, job: job, http: res.status, quote: { cost: body.creativeUnitsCost, discount: body.creativeUnitsDiscount } };
  if (job) return { status: "uncertain", alarm: false, reason: "Scenario's answer carried a job without a readable id. A job may exist.", http: res.status };
  return { status: "uncertain", alarm: true, reason: "Scenario answered a paid request like a price check (HTTP " + res.status + "). A job may exist.", http: res.status };
}

function classifyError(err) {
  var status = err && typeof err.status === "number" ? err.status : null;
  if (status === null) {
    var msg = err && err.message ? err.message : "No answer from Scenario.";
    return { status: "uncertain", reason: msg + " A job may exist.", error: err };
  }
  if (status === 400 || status === 404 || status === 409 || status === 413 || status === 422) {
    var refused = new errorsMod.ScenarioError(status === 404 && /^Model\b/i.test(err.scenarioMessage || "") ? "ModelUnavailable" : "InvalidParameter", "Not sent: " + (err.scenarioMessage || err.message), { status: status, scenarioMessage: err.scenarioMessage });
    return { status: "not_sent", reason: refused.message, error: refused };
  }
  if (status === 401 || status === 403) {
    var text = status === 401 || err.type === "Unauthorized" ? "Scenario did not accept this key and secret." : "Scenario refused this request: " + (err.scenarioMessage || "forbidden") + ". The key may not have access to this model or action.";
    return { status: "not_sent", reason: "Not sent. " + text, error: new errorsMod.ScenarioError(err.type === "Unauthorized" ? "Unauthorized" : "Forbidden", text, { status: status, scenarioMessage: err.scenarioMessage }) };
  }
  if (status === 402) {
    return { status: "not_sent", reason: "Not enough CU for this job. Nothing was sent.", error: new errorsMod.ScenarioError("InsufficientCredits", "Not enough CU for this job.", { status: status, scenarioMessage: err.scenarioMessage }) };
  }
  if (status === 429) {
    var wait = typeof err.retryAfterS === "number" && err.retryAfterS > 0 ? Math.min(err.retryAfterS, 3600) : PAUSE_DEFAULT_S;
    return { status: "not_sent", pause_s: wait, reason: "Not sent: Scenario asked to wait " + wait + " s.", error: new errorsMod.ScenarioError("RateLimited", "Scenario asked to wait " + wait + " s.", { status: status, scenarioMessage: err.scenarioMessage, retryAfterS: wait }) };
  }
  return { status: "uncertain", reason: (err.message || "Scenario answered HTTP " + status + ".") + " A job may exist.", error: err };
}

// Sends the paid request once. Resolves a classification (above); never
// rejects for an answer, only for a request refused before it leaves.
async function submit(client, modelId, body) {
  var path = paidPath(modelId);
  checkBody(body);
  var res;
  try {
    res = await client.request("POST", path, { body: body, paid: PAID_REQUEST });
  } catch (err) {
    if (err && err.beforeSend) throw err;
    return classifyError(err);
  }
  return classifyAnswer(res);
}

module.exports = {
  PAID_REQUEST: PAID_REQUEST,
  submit: submit,
  classifyAnswer: classifyAnswer,
  classifyError: classifyError,
  validJobId: validJobId,
  PAUSE_DEFAULT_S: PAUSE_DEFAULT_S
};
