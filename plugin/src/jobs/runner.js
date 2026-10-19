"use strict";
// A person's generation, from the click to the placed layer (SPEC 3.9, 6.1,
// 6.2, 6.4). In order:
//   1. No-spend mode and a 429 pause refuse at once; nothing is sent.
//   2. Idempotency (SPEC 6.2): the quote id is the key. A key already in the
//      ledger returns its job and sends nothing (the same key with another
//      request is IdempotencyConflict); a job with the same fingerprint that
//      is uploading, awaiting approval, being sent or Unknown blocks a new
//      key (RequestInFlight); then the quote checks (single use, 120 s, same
//      fingerprint).
//   3. The ledger record is written before anything is sent: state
//      uploading_inputs when references wait for upload, else submitting.
//   4. References upload (base64 route), then a second price check with the
//      real asset ids. A different price stops here: the job waits in
//      awaiting_approval and the panel shows the new price.
//   5. The record goes to submitting (written), then the paid request goes
//      once, classified by scenario/paid.js: queued, not_sent or uncertain.
//      Never retried; no answer within 60 s is uncertain.
//   6. Polling every 2 s for the first minute, 5 s until 10 minutes, then
//      15 s. The final status sets the charge (jobs/charges.js).
//   7. Results download to the Output Folder (scenario/download.js).
//   8. Place when ready: the person's own job lands by itself when its
//      document is the active one (a new-document job, when no document is
//      open), in one History state, and the person's active layer is made
//      active again. Never after a restart, never into another document.

var API = require("../../../shared/scenario-api.json");
var errorsMod = require("../scenario/errors.js");
var paid = require("../scenario/paid.js");
var jobsApi = require("../scenario/jobs-api.js");
var priceChecks = require("../scenario/dry-run.js");
var assetsMod = require("../scenario/assets.js");
var requests = require("../forms/requests.js");
var price = require("../forms/price.js");
var charges = require("./charges.js");
var planMod = require("../apply/plan.js");
var slugMod = require("../util/slug.js");

var OUTPUT_FOLDER = "Scenario";
var POLLING = ["queued", "generating", "cancel_requested"];
// The quote mode recorded with each job: the price-check flag's value.
var QUOTE_MODE = priceChecks.DRY_RUN_QUERY[Object.keys(priceChecks.DRY_RUN_QUERY)[0]];
var AUTO_PLACE_RETRY_MS = 2000;
var AUTO_PLACE_TRIES = 30;

// SPEC 6.4 item 5.
function pollDelay(elapsedMs) {
  if (elapsedMs < 60000) return 2000;
  if (elapsedMs < 600000) return 5000;
  return 15000;
}

function err(type, text) {
  return new errorsMod.ScenarioError(type, text);
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

// o: { client, quotes, ledger, catalog, host, downloader, settings,
//      account() -> {id, key_hash, project_name}, version, session, log,
//      timers, now, recordError(type), pollDelay(ms) (tests),
//      placeWhenReady (default true) }
function createRunner(o) {
  var log = o.log || function () {};
  var timers = o.timers || { setTimeout: setTimeout, clearTimeout: clearTimeout };
  var now =
    o.now ||
    function () {
      return Date.now();
    };
  var delayFor = o.pollDelay || pollDelay;
  var pausedUntil = 0;
  var claiming = {};
  var masks = {};
  var polling = {};
  var downloading = {};
  var autoTries = {};
  var listeners = [];

  function iso() {
    return new Date(now()).toISOString();
  }

  function recordError(type) {
    if (o.recordError && type) {
      try {
        o.recordError(type);
      } catch (e) {
        // diagnostics only
      }
    }
  }

  function emit(event) {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](event);
      } catch (e) {
        log("jobs: a listener failed: " + e.message);
      }
    }
  }

  function pausedFor() {
    var left = Math.ceil((pausedUntil - now()) / 1000);
    return left > 0 ? left : 0;
  }

  function update(id, patch) {
    return o.ledger.update(id, patch).catch(function (e) {
      log("jobs: record not saved: " + e.message);
      return o.ledger.get(id);
    });
  }

  function targetRecord(a) {
    var t = a.req.target || {};
    var out = { kind: t.kind || null, session: o.session || null, sample: null };
    if (t.kind === "new_document") {
      out.width = t.width;
      out.height = t.height;
      out.box = [0, 0, t.width, t.height];
    } else {
      out.document_id = t.document_id;
      out.document_title = a.document_title || null;
      out.box = t.box ? t.box.slice() : null;
    }
    return out;
  }

  // 2 and 3: checks in SPEC 6.2 order, then the record.
  async function start(a) {
    if (o.settings && typeof o.settings.noSpend === "function" && o.settings.noSpend()) throw err("NoSpend", "No-spend mode is on. Nothing was sent.");
    var wait = pausedFor();
    if (wait > 0) throw err("RateLimited", "Not sent: Scenario asked to wait " + wait + " s.");
    var acc = o.account();
    if (!acc) throw err("NotSignedIn", "No Scenario key is saved in the plugin.");
    var q = a.quote;
    if (!q || typeof q.quote_id !== "string") throw err("QuoteExpired", "No current price. Wait for the price on the button.");
    var key = q.quote_id;
    var fp = await o.quotes.fingerprintFor(a.req);
    var existing = o.ledger.findByKey(key);
    if (existing) {
      if (existing.fingerprint !== fp) throw err("IdempotencyConflict", "This price was already used for another request.");
      return { replayed: true, record: existing, state: existing.state };
    }
    var flying = o.ledger.inFlight(fp);
    if (flying || claiming[fp]) {
      throw err("RequestInFlight", flying && flying.state === "uncertain" ? "A matching request may already be running. Resolve it in Jobs first." : "This request is already being sent.");
    }
    claiming[fp] = true;
    var rec;
    var refs = a.refs || [];
    var red;
    try {
      red = await o.quotes.redeem(key, q.cu_cost_exact, a.req);
      var body = await o.quotes.bodyFor(a.req);
      rec = await o.ledger.create({
        idempotency_key: key,
        fingerprint: fp,
        origin: { kind: "person" },
        project: { name: acc.project_name || null, key_hash: acc.key_hash || null },
        lane: a.req.lane,
        model_id: a.req.model_id,
        model_name: a.model_name || null,
        trained_model_ids: [],
        parameters: body,
        inputs: {
          references: refs.map(function (r) {
            return { source: r.source, width: r.width, height: r.height, format: r.ext, reduced: !!r.reduced };
          }),
          asset_ids: []
        },
        target: targetRecord(a),
        state: refs.length ? "uploading_inputs" : "submitting",
        job_id: null,
        remote_status: null,
        progress: null,
        cu_quoted: q.cu_cost_exact,
        cu_quoted_max: red.max === null || red.max === undefined ? null : price.exactString(red.max),
        price_kind: red.kind,
        quote_mode: QUOTE_MODE,
        cu_record: null,
        cu_discount: null,
        cu_charged: null,
        refunded: false,
        no_refund: !!q.no_refund,
        outputs: [],
        placement: null,
        error: null,
        submitted_at: null,
        finished_at: null
      });
    } finally {
      delete claiming[fp];
    }
    if (a.mask) masks[rec.local_id] = a.mask;
    emit({ type: "started", local_id: rec.local_id });
    if (refs.length) return uploadThenCheck(rec, refs, red);
    return send(rec.local_id);
  }

  async function finish(id, state, patch) {
    var p = patch || {};
    p.state = state;
    if (state === "not_sent") {
      var c = charges.notSent();
      p.cu_charged = c.cu_charged;
      p.refunded = c.refunded;
    }
    p.finished_at = p.finished_at || iso();
    var rec = await update(id, p);
    return { record: rec, state: state };
  }

  function uploadName(ref, i) {
    var d = new Date(now());
    var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
    return "photoshop-reference-" + stamp + "-" + String(ref.id || i).replace(/[^A-Za-z0-9]/g, "").slice(-8) + "." + (ref.ext === "jpg" ? "jpg" : "png");
  }

  // 4: uploads, then the second price check.
  async function uploadThenCheck(rec, refs, red) {
    var ids = [];
    try {
      for (var i = 0; i < refs.length; i++) {
        var up = await assetsMod.uploadImage(o.client, refs[i].bytes, uploadName(refs[i], i));
        ids.push(up.asset_id);
      }
    } catch (e) {
      recordError(e && e.type);
      return finish(rec.local_id, "not_sent", { error: "Not sent: a reference did not upload. " + ((e && e.message) || e) });
    }
    var schema = await o.catalog.schema(rec.model_id);
    var input = requests.referenceInput(schema);
    var body = JSON.parse(JSON.stringify(rec.parameters));
    body[input.name] = input.multiple ? ids : ids[0];
    var inputs = JSON.parse(JSON.stringify(rec.inputs));
    inputs.asset_ids = ids;
    await update(rec.local_id, { parameters: body, inputs: inputs });
    return checkAndSend(rec.local_id, red.thousandths);
  }

  async function checkAndSend(id, expected) {
    var rec = o.ledger.get(id);
    var t;
    try {
      t = await o.quotes.recheck(rec.model_id, rec.parameters);
    } catch (e) {
      recordError(e && e.type);
      if (e && e.type === "DryRunCreatedJob") {
        var r = await update(id, { state: "uncertain", job_id: paid.validJobId(e.jobId) ? e.jobId : null, error: "Unknown: A price check created a job on Scenario." });
        return { record: r, state: "uncertain" };
      }
      return finish(id, "not_sent", { error: "Not sent: the price check after upload failed. " + ((e && e.message) || e) });
    }
    if (t !== expected) {
      var changed = await update(id, { state: "awaiting_approval", cu_quoted_new: price.exactString(t), price_checked_at: iso() });
      emit({ type: "price_changed", local_id: id });
      return { record: changed, state: "awaiting_approval", price: price.exactString(t), was: price.exactString(expected) };
    }
    return send(id);
  }

  // The person's Generate on the "Price changed after upload" card. A
  // price older than 120 s is checked again first; if it moved, the card
  // shows the new one and nothing is sent.
  async function approve(id) {
    var rec = o.ledger.get(id);
    if (!rec || rec.state !== "awaiting_approval") throw err("Internal", "This job is not waiting for approval.");
    if (o.settings && typeof o.settings.noSpend === "function" && o.settings.noSpend()) throw err("NoSpend", "No-spend mode is on. Nothing was sent.");
    var wait = pausedFor();
    if (wait > 0) throw err("RateLimited", "Not sent: Scenario asked to wait " + wait + " s.");
    var shown = charges.parse(rec.cu_quoted_new);
    if (now() - Date.parse(rec.price_checked_at) >= 120000) {
      var again = await o.quotes.recheck(rec.model_id, rec.parameters);
      if (again !== shown) {
        var r = await update(id, { cu_quoted_new: price.exactString(again), price_checked_at: iso() });
        return { record: r, state: "awaiting_approval", price: price.exactString(again), changed: true };
      }
    }
    await update(id, { cu_quoted: rec.cu_quoted_new, cu_quoted_new: null });
    return send(id);
  }

  function decline(id) {
    var rec = o.ledger.get(id);
    if (!rec || rec.state !== "awaiting_approval") return Promise.resolve(null);
    return finish(id, "not_sent", { error: "Not sent: Declined." });
  }

  // 5: the paid request.
  async function send(id) {
    var rec = o.ledger.get(id);
    try {
      await o.ledger.update(id, { state: "submitting", claimed_at: iso() });
    } catch (e) {
      log("jobs: record not saved before sending: " + e.message);
      return finish(id, "not_sent", { error: "Not sent: the job record could not be saved, so nothing was sent." });
    }
    var out;
    try {
      out = await paid.submit(o.client, rec.model_id, rec.parameters);
    } catch (e) {
      recordError(e && e.type);
      return finish(id, "not_sent", { error: "Not sent: " + ((e && e.message) || e) });
    }
    if (out.error) recordError(out.error.type);
    if (out.status === "queued") {
      var r = await update(id, {
        state: "queued",
        job_id: out.job_id,
        remote_status: typeof out.job.status === "string" ? out.job.status : null,
        progress: typeof out.job.progress === "number" ? out.job.progress : null,
        submitted_at: iso(),
        error: null
      });
      log("jobs: sent, queued on Scenario");
      poll(id);
      return { record: r, state: "queued" };
    }
    if (out.status === "not_sent") {
      if (out.pause_s) pausedUntil = now() + out.pause_s * 1000;
      log("jobs: not sent (" + ((out.error && out.error.type) || "refused") + ")");
      return finish(id, "not_sent", { error: out.reason });
    }
    if (out.alarm) {
      o.quotes.alarm(null);
      recordError("DryRunCreatedJob");
    }
    log("jobs: answer unknown; the job is Unknown until the person resolves it");
    var u = await update(id, { state: "uncertain", error: "Unknown: " + out.reason });
    return { record: u, state: "uncertain" };
  }

  // 6: polling.
  function poll(id) {
    if (polling[id]) return;
    polling[id] = true;
    var rec0 = o.ledger.get(id);
    var since = rec0 && rec0.submitted_at ? Date.parse(rec0.submitted_at) : now();
    function schedule() {
      timers.setTimeout(tick, delayFor(Math.max(0, now() - since)));
    }
    async function tick() {
      var rec = o.ledger.get(id);
      if (!rec || POLLING.indexOf(rec.state) < 0 || !rec.job_id) {
        delete polling[id];
        return;
      }
      var read;
      try {
        read = await jobsApi.getJob(o.client, rec.job_id);
      } catch (e) {
        log("jobs: status read failed (" + ((e && e.type) || "error") + "); trying again");
        schedule();
        return;
      }
      var patch = { remote_status: read.remote_status, progress: read.progress };
      if (!read.status || read.status === "queued" || read.status === "generating") {
        if (read.status && rec.state !== "cancel_requested") patch.state = read.status;
        await update(id, patch);
        schedule();
        return;
      }
      delete polling[id];
      var settled = charges.settle(read.status, read);
      for (var k in settled) patch[k] = settled[k];
      patch.finished_at = iso();
      if (read.status === "succeeded") {
        if (!read.asset_ids.length) {
          patch.state = "download_failed";
          patch.error = "Download stopped: Scenario reported success but listed no results.";
          await update(id, patch);
          return;
        }
        patch.state = "succeeded";
        patch.outputs = read.asset_ids.map(function (a) {
          return { asset_id: a, state: "pending", path: null };
        });
        await update(id, patch);
        download(id);
        return;
      }
      var label = read.status === "blocked" ? "Blocked" : read.status === "canceled" ? "Canceled" : "Failed";
      patch.state = read.status;
      patch.error = label + ": " + (read.status === "blocked" ? "Scenario blocked this request (content policy)." : read.hint || read.error || "Scenario reported a failure.");
      await update(id, patch);
    }
    schedule();
  }

  function datePath(iso8601) {
    var d = new Date(Date.parse(iso8601) || now());
    var y = d.getFullYear();
    var m = pad(d.getMonth() + 1);
    var day = pad(d.getDate());
    return { folder: y + m + day, prefix: y + "-" + m + "-" + day };
  }

  // 7: downloads, one take after another.
  async function download(id) {
    if (downloading[id]) return;
    downloading[id] = true;
    try {
      var rec = o.ledger.get(id);
      if (!rec) return;
      await update(id, { state: "downloading", error: null });
      var kind = planMod.kindOf(rec.lane);
      var dp = datePath(rec.submitted_at || rec.created_at);
      var dir = OUTPUT_FOLDER + "/" + kind + "/" + dp.folder;
      var slug = slugMod.slug(rec.parameters && rec.parameters.prompt);
      var outputs = JSON.parse(JSON.stringify(rec.outputs || []));
      try {
        await o.host.ensureDataDir(dir);
      } catch (e) {
        // the write below reports it
      }
      for (var i = 0; i < outputs.length; i++) {
        if (outputs[i].state === "saved" && outputs[i].path) continue;
        var base = dir + "/" + dp.prefix + (slug ? "-" + slug : "") + "-" + slugMod.tail(outputs[i].asset_id) + (outputs.length > 1 ? "-take" + (i + 1) : "");
        try {
          var got = await o.downloader.download(outputs[i].asset_id, base);
          outputs[i] = { asset_id: outputs[i].asset_id, state: "saved", path: got.path, width: got.width, height: got.height, mime: got.mime };
          await update(id, { outputs: outputs });
        } catch (e) {
          recordError(e && e.type);
          var type = e && (e.type === "ResultUnreachable" || e.type === "ResultExpired") ? e.type : null;
          await update(id, { state: "download_failed", outputs: outputs, error: (type || "Download stopped") + ": " + ((e && e.message) || e), download_error_type: type });
          return;
        }
      }
      await update(id, { state: "ready", error: null });
      emit({ type: "ready", local_id: id });
      maybeAutoPlace(id);
    } finally {
      delete downloading[id];
    }
  }

  function canAutoPlace(rec) {
    if (o.placeWhenReady === false) return false;
    if (!rec || rec.state !== "ready" || !rec.origin || rec.origin.kind !== "person") return false;
    if (!rec.session || rec.session !== o.session) return false;
    var t = rec.target || {};
    var active = o.host.activeDocumentId();
    if (t.kind === "new_document") return active === null || active === undefined;
    return active !== null && active !== undefined && active === t.document_id;
  }

  function maybeAutoPlace(id) {
    var rec = o.ledger.get(id);
    if (!canAutoPlace(rec)) return;
    place(id, { auto: true }).catch(function (e) {
      log("jobs: place failed: " + ((e && e.type) || "error"));
    });
  }

  // Where a job's results land, as the plan's document, box and mask.
  function placement(rec, opts) {
    var t = rec.target || {};
    var notes = [];
    var active = o.host.activeDocumentId();
    if (opts.new_document || t.kind === "new_document" || !t.kind) {
      var first = (rec.outputs || [])[0] || {};
      var w = t.kind === "new_document" ? t.width : first.width;
      var h = t.kind === "new_document" ? t.height : first.height;
      return { document: null, box: { left: 0, top: 0, width: w || first.width, height: h || first.height }, mask: null, notes: notes };
    }
    var sameDoc = rec.session === o.session && active !== null && active === t.document_id;
    if (sameDoc && t.box) {
      var mask = t.kind === "selection" ? masks[rec.local_id] || null : null;
      if (t.kind === "selection" && !mask) notes.push("Placed unmasked: the selection mask is kept until Photoshop quits.");
      return { document: o.host.documentSize(active), box: { left: t.box[0], top: t.box[1], width: t.box[2], height: t.box[3] }, mask: mask, notes: notes };
    }
    if (active === null || active === undefined) throw err("DocumentClosed", "Open a document to place this result, or use Open as document.");
    var size = o.host.documentSize(active);
    notes.push("Placed in the current document over its canvas.");
    return { document: size, box: { left: 0, top: 0, width: size.width, height: size.height }, mask: null, notes: notes };
  }

  // Places a ready job (Place, Open as document, or Place when ready).
  async function place(id, opts) {
    opts = opts || {};
    var rec = o.ledger.get(id);
    if (!rec || ["ready", "apply_failed", "applied"].indexOf(rec.state) < 0) throw err("Internal", "This job has no saved results to place.");
    var where = placement(rec, opts);
    var p = planMod.build(rec, { version: o.version, document: where.document, box: where.box, mask: where.mask, restore_active: !!opts.auto });
    var before = rec.state;
    await update(id, { state: "applying" });
    try {
      var result = await o.host.placeResults(p, { auto: !!opts.auto });
      var notes = where.notes.concat(result.notes || []);
      var done = await update(id, {
        state: "applied",
        error: null,
        placement: { document_id: result.document_id, layer_ids: result.layer_ids, group_id: result.group_id || null, history: p.history_name, notes: notes }
      });
      delete autoTries[id];
      emit({ type: "placed", local_id: id, auto: !!opts.auto, first: !!result.first });
      return done;
    } catch (e) {
      if (opts.auto && e && e.busy && (autoTries[id] || 0) < AUTO_PLACE_TRIES) {
        autoTries[id] = (autoTries[id] || 0) + 1;
        await update(id, { state: before === "applied" ? "applied" : "ready", error: null });
        timers.setTimeout(function () {
          maybeAutoPlace(id);
        }, AUTO_PLACE_RETRY_MS);
        return o.ledger.get(id);
      }
      if (opts.auto && e && e.notActive) {
        await update(id, { state: "ready", error: null });
        return o.ledger.get(id);
      }
      await update(id, { state: before === "applied" ? "applied" : "apply_failed", error: "Place failed: " + ((e && e.message) || e) });
      throw e;
    }
  }

  // SPEC 6.2 step 5.3: the person marks an Unknown job not sent.
  function markNotSent(id) {
    var rec = o.ledger.get(id);
    if (!rec || rec.state !== "uncertain") return Promise.resolve(null);
    return finish(id, "not_sent", { error: "Not sent: marked not sent by you." });
  }

  function resumeDownload(id) {
    var rec = o.ledger.get(id);
    if (!rec || rec.state !== "download_failed" || rec.download_error_type) return Promise.resolve(null);
    return download(id);
  }

  // After the ledger is read at startup: polling and downloads resume;
  // nothing is placed by itself.
  function resume() {
    var list = o.ledger.all();
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (POLLING.indexOf(r.state) >= 0 && r.job_id) poll(r.local_id);
      else if (r.state === "succeeded" || r.state === "downloading") download(r.local_id);
    }
  }

  return {
    start: start,
    approve: approve,
    decline: decline,
    place: place,
    markNotSent: markNotSent,
    resumeDownload: resumeDownload,
    resume: resume,
    pausedFor: pausedFor,
    canAutoPlace: canAutoPlace,
    onEvent: function (fn) {
      listeners.push(fn);
    },
    OUTPUT_FOLDER: OUTPUT_FOLDER
  };
}

module.exports = { createRunner: createRunner, pollDelay: pollDelay, OUTPUT_FOLDER: OUTPUT_FOLDER, QUOTE_MODE: QUOTE_MODE };
