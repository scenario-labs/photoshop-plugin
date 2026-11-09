"use strict";
// Resolving an Unknown (`uncertain`) job (SPEC 6.2 step 5). Only the person
// resolves one, in Jobs; agents get UncertainNeedsPerson.
//
// check(local_id) looks the job up on Scenario:
//   - by the job id the record already holds (a price check that created a
//     job, section 6.1 step 4): that job is the one candidate;
//   - otherwise by time window: GET /v1/jobs with createdAfter set to the
//     claim time minus 10 minutes, paged newest first, keeping model jobs
//     (jobType `custom`) created until the claim time plus 60 minutes, and
//     leaving out jobs another record of this ledger already holds.
// A candidate matches exactly when its metadata.input names the record's
// model and every parameter the record sent, the uploaded asset ids
// included; a prompt Scenario stored as a text asset is read once (its
// metadata.preview) and compared as text. One exact match, and only one, is
// pre-selected. A scan that stops at the page limit, or a read that fails,
// is incomplete.
//
// Scenario's run endpoint takes no idempotency key (documented), so "by
// idempotency key" is the ledger's own lookup: the record the key names, and
// the job id it holds when it has one.
//
// The runner uses the result: Link this job continues the job (polling,
// download, placement); Mark not sent is allowed only after a complete check
// within the last 10 minutes found no exact match, so a paid result is never
// written off while Scenario lists a job that matches it.

var API = require("../../../shared/scenario-api.json");
var jobsApi = require("../scenario/jobs-api.js");
var assetsMod = require("../scenario/assets.js");
var canonical = require("../util/canonical-json.js");

var CFG = API.jobs;

function same(a, b) {
  if (a === undefined || b === undefined) return a === b;
  try {
    return canonical.stringify(a) === canonical.stringify(b);
  } catch (e) {
    return false;
  }
}

// o: { client, ledger, now() -> ms, log, blockedTexts (tests) }
function createResolver(o) {
  var log = o.log || function () {};
  var now =
    o.now ||
    function () {
      return Date.now();
    };
  var last = {};
  var texts = {};
  var running = {};

  function iso(ms) {
    return new Date(ms === undefined ? now() : ms).toISOString();
  }

  async function promptText(id) {
    if (Object.prototype.hasOwnProperty.call(texts, id)) return texts[id];
    var t = await jobsApi.getText(o.client, id);
    texts[id] = t;
    return t;
  }

  // True when the job's recorded input matches what this record sent.
  async function matches(rec, row) {
    var params = rec.parameters;
    if (!params || typeof params !== "object" || !Object.keys(params).length) return false;
    if (!row.input || row.model_id !== rec.model_id) return false;
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      var want = params[k];
      var got = row.input[k];
      if (k === "prompt" && typeof want === "string" && typeof got === "string" && got !== want) {
        if (!assetsMod.validAssetId(got)) return false;
        var t = await promptText(got);
        if (!t || !t.full || t.text !== want) return false;
        continue;
      }
      if (!same(want, got)) return false;
    }
    return true;
  }

  function candidate(row, exact, via) {
    return {
      job_id: row.job_id,
      created_at: row.created_at,
      status: row.status,
      remote_status: row.remote_status,
      model_id: row.model_id,
      cu_cost: row.cu_cost,
      results: row.asset_ids.length,
      exact: !!exact,
      via: via
    };
  }

  async function scan(rec, out) {
    var claim = Date.parse(rec.claimed_at || rec.created_at);
    if (isNaN(claim)) claim = now();
    var from = claim - CFG.window.before_ms;
    var to = claim + CFG.window.after_ms;
    var token = null;
    var pages = 0;
    var rows = [];
    do {
      var page = await jobsApi.listJobs(o.client, { created_after: iso(from), page_token: token, page_size: CFG.page_size });
      pages++;
      for (var i = 0; i < page.jobs.length; i++) rows.push(page.jobs[i]);
      token = page.next;
    } while (token && pages < CFG.max_pages);
    out.complete = !token;
    out.pages = pages;
    out.window = { from: iso(from), to: iso(to) };
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var at = Date.parse(r.created_at);
      if (r.job_type !== CFG.model_job_type || isNaN(at) || at < from || at > to) continue;
      var other = o.ledger.findByJobId(r.job_id);
      if (other && other.local_id !== rec.local_id) continue;
      out.candidates.push(candidate(r, await matches(rec, r), "time window"));
    }
  }

  // Resolves { local_id, checked_at, complete, candidates, preselected,
  // window, error }. Never throws for Scenario's answers: a failed read
  // makes the check incomplete, with the reason in `error`.
  async function check(id) {
    if (running[id]) return running[id];
    var p = (async function () {
      var rec = o.ledger.get(id);
      var out = { local_id: id, checked_at: iso(), complete: false, candidates: [], preselected: null, window: null, error: null };
      if (!rec) {
        out.error = "No such job.";
        return out;
      }
      try {
        if (rec.job_id) {
          var read = await jobsApi.getJob(o.client, rec.job_id, o.blockedTexts);
          out.candidates.push(candidate(read, true, "job id"));
          out.complete = true;
        } else {
          await scan(rec, out);
        }
      } catch (e) {
        out.complete = false;
        out.error = ((e && e.type) || "Internal") + ": " + ((e && e.message) || String(e));
        log("jobs: Unknown check incomplete (" + ((e && e.type) || "error") + ")");
      }
      var exact = out.candidates.filter(function (c) {
        return c.exact;
      });
      out.preselected = exact.length === 1 ? exact[0].job_id : null;
      out.candidates.sort(function (a, b) {
        return (b.exact ? 1 : 0) - (a.exact ? 1 : 0) || String(a.created_at).localeCompare(String(b.created_at));
      });
      last[id] = out;
      return out;
    })();
    running[id] = p;
    try {
      return await p;
    } finally {
      delete running[id];
    }
  }

  function lastCheck(id) {
    return last[id] ? JSON.parse(JSON.stringify(last[id])) : null;
  }

  // A check recent enough to mark a job not sent from.
  function fresh(c) {
    return !!c && now() - Date.parse(c.checked_at) <= CFG.check_valid_ms;
  }

  function forget(id) {
    delete last[id];
  }

  return { check: check, lastCheck: lastCheck, fresh: fresh, forget: forget, matches: matches, isChecking: function (id) {
    return !!running[id];
  } };
}

module.exports = { createResolver: createResolver };
