"use strict";
// Job and asset reads (SPEC 2.5, 3.11, 6.2, 6.4). GET /v1/jobs/{id} answers
// {job: {jobId, jobType, status, progress, createdAt, billing: {cuCost,
// cuDiscount, cuCostDetails?, disableRefund?}, metadata: {input, assetIds,
// error?, hint?}}}; GET /v1/jobs lists the project's jobs newest first
// ({jobs, nextPaginationToken}); GET /v1/assets/{id} answers {asset: {id,
// url, mimeType, metadata: {width, height}}}, where url is a signed CDN link,
// and a prompt's text asset carries its text in metadata.preview (measured
// live 2026-10-19). Signed links are returned to the caller and never stored.

var API = require("../../../shared/scenario-api.json");
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

// Texts that mark a content-policy refusal, as data (shared/scenario-api.json
// `blocked`): none measured yet (M2.0 item 10), so every failure reads as
// failed until data names one.
var BLOCKED_TEXTS = API.blocked.texts;

function num(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

// True when a text names a content-policy refusal. texts: the list to use
// (tests), shared/scenario-api.json by default.
function isBlockedText(text, texts) {
  if (typeof text !== "string" || !text) return false;
  var list = texts || BLOCKED_TEXTS;
  var lower = text.toLowerCase();
  for (var i = 0; i < list.length; i++) if (list[i] && lower.indexOf(String(list[i]).toLowerCase()) >= 0) return true;
  return false;
}

// The parts of a job record the plugin keeps. Never the owner or the author
// ids. `input` is metadata.input as Scenario recorded it (model id and
// every valid input, a processed prompt as a text asset id): it is used to
// match an Unknown job and never written to the ledger as is.
function readJob(job, texts) {
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
  if (status === "failed" && (isBlockedText(errorText, texts) || isBlockedText(hint, texts))) status = "blocked";
  var ids = Array.isArray(meta.assetIds) ? meta.assetIds.filter(assetsMod.validAssetId) : [];
  var input = meta.input && typeof meta.input === "object" && !Array.isArray(meta.input) ? meta.input : null;
  return {
    job_id: paidMod.validJobId(job.jobId) ? job.jobId : null,
    job_type: typeof job.jobType === "string" ? job.jobType : null,
    remote_status: remote,
    status: status,
    progress: num(job.progress),
    created_at: typeof job.createdAt === "string" && !isNaN(Date.parse(job.createdAt)) ? job.createdAt : null,
    model_id: input && typeof input.modelId === "string" ? input.modelId : null,
    input: input,
    asset_ids: ids,
    cu_cost: num(billing.cuCost),
    cu_cost_details: details ? detailSum : 0,
    cu_discount: num(billing.cuDiscount),
    disable_refund: billing.disableRefund === true,
    error: errorText,
    hint: hint
  };
}

// texts: the blocked texts to use (tests); shared/scenario-api.json by default.
async function getJob(client, jobId, texts) {
  if (!paidMod.validJobId(jobId)) throw new errorsMod.ScenarioError("Internal", "Not a Scenario job id.");
  var res;
  try {
    res = await client.request("GET", "/jobs/" + jobId);
  } catch (err) {
    if (err && err.status === 404) {
      var gone = new errorsMod.ScenarioError("JobNotFound", "Scenario does not list this job for the current key.", { status: 404, scenarioMessage: err.scenarioMessage });
      throw gone;
    }
    throw err;
  }
  return readJob(res.body && res.body.job, texts);
}

// One page of the project's jobs, newest first. o: { created_after (ISO),
// page_token, page_size }. Resolves { jobs: [readJob rows], next: token |
// null }.
async function listJobs(client, o) {
  o = o || {};
  var texts = o.texts;
  var query = { pageSize: String(o.page_size || API.jobs.page_size) };
  if (o.created_after) query.createdAfter = o.created_after;
  if (o.page_token) query.paginationToken = o.page_token;
  var res = await client.request("GET", API.jobs.path, { query: query });
  var body = res.body && typeof res.body === "object" ? res.body : {};
  var rows = Array.isArray(body.jobs) ? body.jobs : [];
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    try {
      var r = readJob(rows[i], texts);
      if (r.job_id) out.push(r);
    } catch (e) {
      // an unreadable row is skipped
    }
  }
  var next = typeof body.nextPaginationToken === "string" && body.nextPaginationToken ? body.nextPaginationToken : null;
  return { jobs: out, next: next };
}

// The text of a prompt's text asset: { text, full } (full: the preview holds
// the whole text), or null when the asset is not a text asset.
async function getText(client, assetId) {
  if (!assetsMod.validAssetId(assetId)) throw new errorsMod.ScenarioError("Internal", "Not a Scenario asset id.");
  var res = await client.request("GET", "/assets/" + assetId);
  var asset = res.body && res.body.asset;
  var meta = asset && asset.metadata && typeof asset.metadata === "object" ? asset.metadata : {};
  if (typeof meta.preview !== "string") return null;
  var count = num(meta.charCount);
  var full = meta.hasFullPreview === true || (count !== null && count === meta.preview.length);
  return { text: meta.preview, full: full };
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

module.exports = { getJob: getJob, getAsset: getAsset, listJobs: listJobs, getText: getText, readJob: readJob, isBlockedText: isBlockedText, STATUS: STATUS, BLOCKED_TEXTS: BLOCKED_TEXTS };
