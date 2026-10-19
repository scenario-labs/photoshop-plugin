"use strict";
// Job and asset reads (SPEC 2.5, 6.4). GET /v1/jobs/{id} answers {job:
// {jobId, status, progress, billing: {cuCost, cuDiscount, cuCostDetails?,
// disableRefund?}, metadata: {input, assetIds, error?, hint?}}}; GET
// /v1/assets/{id} answers {asset: {id, url, mimeType, metadata: {width,
// height}}}, where url is a signed CDN link (measured live 2026-10-19). The
// signed link is returned to the caller and never stored.

var errorsMod = require("./errors.js");
var assetsMod = require("./assets.js");
var paidMod = require("./paid.js");

// Scenario job status to plugin status (SPEC 2.5).
var STATUS = {
  pending: "queued",
  queued: "queued",
  "warming-up": "queued",
  "in-progress": "generating",
  finalizing: "generating",
  success: "succeeded",
  failure: "failed",
  canceled: "canceled"
};

// Failure codes that mean a content-policy refusal: none measured yet (M2.0
// item 10), so every failure reads as failed until data names one.
var BLOCKED_CODES = [];

function num(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

// The parts of a job record the plugin keeps. Never the prompt text, the
// owner or the author ids.
function readJob(job) {
  if (!job || typeof job !== "object") throw new errorsMod.ScenarioError("Internal", "Scenario's job answer had no job.");
  var meta = job.metadata && typeof job.metadata === "object" ? job.metadata : {};
  var billing = job.billing && typeof job.billing === "object" ? job.billing : {};
  var details = billing.cuCostDetails && typeof billing.cuCostDetails === "object" ? billing.cuCostDetails : null;
  var detailSum = 0;
  if (details) for (var k in details) if (Object.prototype.hasOwnProperty.call(details, k) && num(details[k]) !== null) detailSum += details[k];
  var remote = typeof job.status === "string" ? job.status : null;
  var status = remote && Object.prototype.hasOwnProperty.call(STATUS, remote) ? STATUS[remote] : null;
  var errorText = typeof meta.error === "string" ? errorsMod.oneLine(meta.error) : null;
  var hint = typeof meta.hint === "string" ? errorsMod.oneLine(meta.hint) : null;
  if (status === "failed" && errorText) {
    for (var b = 0; b < BLOCKED_CODES.length; b++) if (errorText.indexOf(BLOCKED_CODES[b]) >= 0) status = "blocked";
  }
  var ids = Array.isArray(meta.assetIds) ? meta.assetIds.filter(assetsMod.validAssetId) : [];
  return {
    job_id: paidMod.validJobId(job.jobId) ? job.jobId : null,
    remote_status: remote,
    status: status,
    progress: num(job.progress),
    asset_ids: ids,
    cu_cost: num(billing.cuCost),
    cu_cost_details: details ? detailSum : 0,
    cu_discount: num(billing.cuDiscount),
    disable_refund: billing.disableRefund === true,
    error: errorText,
    hint: hint
  };
}

async function getJob(client, jobId) {
  if (!paidMod.validJobId(jobId)) throw new errorsMod.ScenarioError("Internal", "Not a Scenario job id.");
  var res = await client.request("GET", "/jobs/" + jobId);
  return readJob(res.body && res.body.job);
}

// Resolves { asset_id, url (signed, keep in memory only), mime, width,
// height }. A 404 is ResultExpired.
async function getAsset(client, assetId) {
  if (!assetsMod.validAssetId(assetId)) throw new errorsMod.ScenarioError("Internal", "Not a Scenario asset id.");
  var res;
  try {
    res = await client.request("GET", "/assets/" + assetId);
  } catch (err) {
    if (err && err.status === 404) throw new errorsMod.ScenarioError("ResultExpired", "This result is no longer available on Scenario.", { status: 404 });
    throw err;
  }
  var asset = res.body && res.body.asset;
  if (!asset || typeof asset.url !== "string") throw new errorsMod.ScenarioError("ResultExpired", "Scenario's asset record has no file link.");
  var meta = asset.metadata && typeof asset.metadata === "object" ? asset.metadata : {};
  return {
    asset_id: assetId,
    url: asset.url,
    mime: typeof asset.mimeType === "string" ? asset.mimeType : null,
    width: num(meta.width),
    height: num(meta.height)
  };
}

module.exports = { getJob: getJob, getAsset: getAsset, readJob: readJob, STATUS: STATUS, BLOCKED_CODES: BLOCKED_CODES };
