"use strict";
// Price checks (SPEC 6.1 items 1 and 4). A price check is a dry run:
// POST /v1/generate/custom/{modelId} with the flag below. The flag value is
// the literal string "true" from this one frozen constant: an unrecognized
// value such as "bogus" runs a real, charged job (measured live 2026-10-19).
// This file is the only place the flag's name and value are written; the
// client refuses any POST to /generate that does not carry this exact object
// (scenario/client.js), and a unit test asserts the exact query string of
// every price check.
//
// The answer is accepted when it is a 2xx whose body carries a numeric
// creativeUnitsCost and no job id. Over REST it is status 269 with
// creativeUnitsCost, creativeUnitsDiscount and costDetails, and no `job` key
// (measured live 2026-10-19). A job id in the answer is an alarm: the error
// type DryRunCreatedJob stops price checks for the session.

var errorsMod = require("./errors.js");

var DRY_RUN_QUERY = Object.freeze({ dryRun: "true" });

// The query string the constant produces ("?" name "=" value), derived so
// the flag is written once; tests compare every price check with it.
var DRY_RUN_SEARCH = "?" + Object.keys(DRY_RUN_QUERY)[0] + "=" + DRY_RUN_QUERY[Object.keys(DRY_RUN_QUERY)[0]];

var MODEL_ID = /^model_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validModelId(id) {
  return typeof id === "string" && MODEL_ID.test(id) && id.indexOf("..") < 0;
}

function priceCheckPath(modelId) {
  if (!validModelId(modelId)) throw new errorsMod.ScenarioError("InvalidParameter", "model_id is not a Scenario model id.");
  return "/generate/custom/" + modelId;
}

function jobIdIn(body) {
  if (!body || typeof body !== "object") return null;
  var job = body.job;
  if (job && typeof job === "object" && typeof job.jobId === "string") return job.jobId;
  if (job && typeof job === "object" && typeof job.id === "string") return job.id;
  if (typeof body.jobId === "string") return body.jobId;
  if (typeof body.job_id === "string") return body.job_id;
  if (job) return "unknown";
  return null;
}

// res: { status, body } from client.request. Returns { cost, discount,
// details } or throws a ScenarioError.
function classify(res) {
  var body = res && res.body;
  var jobId = jobIdIn(body);
  if (jobId) {
    var e = new errorsMod.ScenarioError("DryRunCreatedJob", "A price check created a job on Scenario. Price checks are stopped for this session.");
    e.jobId = jobId === "unknown" ? null : jobId;
    throw e;
  }
  if (!body || typeof body.creativeUnitsCost !== "number" || !isFinite(body.creativeUnitsCost) || body.creativeUnitsCost < 0) {
    throw new errorsMod.ScenarioError("Internal", "Scenario's price answer had no price (HTTP " + (res ? res.status : "?") + ").");
  }
  var details = body.costDetails && typeof body.costDetails === "object" && !Array.isArray(body.costDetails) ? body.costDetails : {};
  var cleanDetails = {};
  for (var k in details) {
    if (Object.prototype.hasOwnProperty.call(details, k) && typeof details[k] === "number" && isFinite(details[k])) cleanDetails[k] = details[k];
  }
  return {
    cost: body.creativeUnitsCost,
    discount: typeof body.creativeUnitsDiscount === "number" && isFinite(body.creativeUnitsDiscount) ? body.creativeUnitsDiscount : 0,
    details: cleanDetails
  };
}

// Scenario's refusals of a price check (measured live 2026-10-19): 400 with
// the input's problem ("Input image is required", "Input width must be at
// most 3840"), 404 "Model <id> not found" and 404 "Asset <id> not found".
function refusal(err) {
  if (!err || err.status === null || err.status === undefined) return err;
  var text = err.scenarioMessage || "";
  var type = null;
  if (err.status === 400) type = "InvalidParameter";
  else if (err.status === 404 && /^Model\b/i.test(text)) type = "ModelUnavailable";
  else if (err.status === 404 && /^Asset\b/i.test(text)) type = "InvalidParameter";
  if (!type) return err;
  var e = new errorsMod.ScenarioError(type, text ? "Scenario refused the price check: " + text : err.message, { status: err.status, scenarioMessage: err.scenarioMessage });
  e.assetMissing = err.status === 404 && type === "InvalidParameter";
  return e;
}

// The one function that sends a price check. Never retried (it is a POST).
async function priceCheck(client, modelId, body) {
  var res;
  try {
    res = await client.request("POST", priceCheckPath(modelId), { query: DRY_RUN_QUERY, body: body, priceCheck: true });
  } catch (err) {
    throw refusal(err);
  }
  return classify(res);
}

module.exports = {
  DRY_RUN_QUERY: DRY_RUN_QUERY,
  DRY_RUN_SEARCH: DRY_RUN_SEARCH,
  priceCheck: priceCheck,
  priceCheckPath: priceCheckPath,
  classify: classify,
  validModelId: validModelId
};
