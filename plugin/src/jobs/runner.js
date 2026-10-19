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
//      uploading_inputs when a capture, a mask or references wait for
//      upload, else submitting.
//   4. The capture (Edit, Expand, Upscale, Remove BG), its mask and the
//      references upload (base64 route), then a second price check with the
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
//   9. The checks of SPEC 3.9 run on reads taken during the placement: the
//      seam, alignment and edit checks per take, then the outside-the-mask
//      check on the composite. A failed check adds a badge and, for
//      "Changed outside", offers Undo; the result always stays placed, and
//      a check that cannot run leaves a note. Nothing is ever discarded.
//
// After a restart (SPEC 6.4, M5), recover() runs once the ledger is read:
// saved results whose files are gone go back to download stopped, a job
// that was placing is looked for in the open documents first, then polling
// and downloads resume for the jobs of the signed-in project. A job of
// another project waits until its project is the current one. Place puts a
// result in its own document: the same document in this Photoshop session,
// or the saved file it was made from (a hash of its path); it is held while
// that document is closed or not in front, and never switches documents.
// "Place in current document" is the person's explicit choice. Unknown jobs
// are resolved in Jobs (jobs/resolve.js): Link this job continues it; Mark
// not sent needs a complete check that found no exact match.

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
var checksMod = require("../apply/checks.js");
var pixelsMod = require("../capture/pixels.js");
var shapeMod = require("../capture/shape.js");
var slugMod = require("../util/slug.js");
var xmpMod = require("../util/xmp.js");
var sha = require("../util/sha256.js");
var utf8 = require("../util/utf8.js");
var resolveMod = require("./resolve.js");

var OUTPUT_FOLDER = "Scenario";
var POLLING = ["queued", "generating", "cancel_requested"];
// The quote mode recorded with each job: the price-check flag's value.
var QUOTE_MODE = priceChecks.DRY_RUN_QUERY[Object.keys(priceChecks.DRY_RUN_QUERY)[0]];
var AUTO_PLACE_RETRY_MS = 2000;
var AUTO_PLACE_TRIES = 30;
// Pauses for a status read that cannot go through (SPEC 6.4 item 5).
var OFFLINE_MS = API.jobs.poll_offline_ms;
var RATE_LIMIT_MS = API.paid.pause_default_s * 1000;
var NO_HOOKS = {
  at: function () {
    return Promise.resolve();
  },
  value: function (point, v) {
    return v;
  }
};

// A short hash of a project id, kept with each job so it resumes only under
// that project's key.
function projectHash(id) {
  if (typeof id !== "string" || !id) return null;
  return sha.toHex(sha.sha256(utf8.encode(id))).slice(0, 24);
}

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

// The trained models a request applies (SPEC 3.4): its LoRAs, or its
// composition.
function trainedIds(params) {
  var out = [];
  if (params && Array.isArray(params.loras)) out = params.loras.slice();
  if (params && typeof params.modelId === "string" && params.modelId) out.push(params.modelId);
  return out;
}

// o: { client, quotes, ledger, catalog, host, downloader, settings,
//      account() -> {id, key_hash, project_name}, version, session, log,
//      timers, now, recordError(type), pollDelay(ms) (tests),
//      placeWhenReady (default true), capture (capture/capture.js),
//      hooks (dev/test-hooks.js; development builds only), blockedTexts
//      (tests), offlineMs (tests) }
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
  // What a placement needs that stays on this computer only: the selection
  // mask, the small copies the checks compare. Kept until Photoshop quits.
  var memos = {};
  var polling = {};
  var downloading = {};
  var autoTries = {};
  var listeners = [];
  // Why a job is not moving (sign-in, another project, offline), in memory.
  var waiting = {};
  // Download stop tokens, per job.
  var stops = {};
  var placing = {};
  var hooks = o.hooks || NO_HOOKS;
  var blockedTexts = o.blockedTexts || null;
  var offlineMs = o.offlineMs || OFFLINE_MS;
  var resolver = resolveMod.createResolver({ client: o.client, ledger: o.ledger, now: now, log: log, blockedTexts: blockedTexts });

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

  function setWaiting(id, why) {
    var before = waiting[id] || null;
    if (why) waiting[id] = why;
    else delete waiting[id];
    if (before !== (why || null)) emit({ type: "waiting", local_id: id, reason: why || null });
  }

  // Null when the job can be read with the current key, else why not. A job
  // made under another project waits for it; records without a project
  // hash (made before 0.5.0) compare the key hash, then the project name.
  function gateFor(rec) {
    var acc = o.account();
    if (!acc) return "Waiting for sign-in to continue.";
    var p = rec.project || {};
    var other = false;
    if (p.id_hash && acc.project_id) other = p.id_hash !== projectHash(acc.project_id);
    else if (p.key_hash && acc.key_hash && p.key_hash !== acc.key_hash) other = !(p.name && acc.project_name && p.name === acc.project_name);
    return other ? "Waiting for its project" + (p.name ? ' "' + p.name + '"' : "") + ": switch to that project to continue." : null;
  }

  function update(id, patch) {
    return o.ledger.update(id, patch).catch(function (e) {
      log("jobs: record not saved: " + e.message);
      return o.ledger.get(id);
    });
  }

  function targetRecord(a) {
    var t = a.req.target || {};
    var out = { kind: t.kind || null, session: o.session || null, sample: t.sample || null };
    var keep = ["canvas", "upload", "layer_id", "selection", "margin", "feather", "source", "read", "output", "lands", "expand", "route", "overlap", "anchor", "mask_box", "background", "insert"];
    for (var i = 0; i < keep.length; i++) if (t[keep[i]] !== undefined) out[keep[i]] = JSON.parse(JSON.stringify(t[keep[i]]));
    if (t.kind === "new_document") {
      out.width = t.width;
      out.height = t.height;
      out.box = [0, 0, t.width, t.height];
    } else {
      out.document_id = t.document_id;
      out.document_title = a.document_title || null;
      out.document_key = o.host && typeof o.host.documentKey === "function" ? o.host.documentKey(t.document_id) : null;
      out.box = t.box ? t.box.slice() : null;
      if (o.host && typeof o.host.documentSize === "function") {
        var size = o.host.documentSize(t.document_id);
        if (size) out.document_size = [size.width, size.height];
      }
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
    var cap = a.capture || null;
    var capFiles = cap ? cap.files || [] : [];
    var red;
    try {
      red = await o.quotes.redeem(key, q.cu_cost_exact, a.req);
      var body = await o.quotes.bodyFor(a.req);
      rec = await o.ledger.create({
        idempotency_key: key,
        fingerprint: fp,
        origin: { kind: "person" },
        project: { name: acc.project_name || null, key_hash: acc.key_hash || null, id_hash: projectHash(acc.project_id) },
        lane: a.req.lane,
        model_id: a.req.model_id,
        model_name: a.model_name || null,
        trained_model_ids: trainedIds(body),
        parameters: body,
        inputs: {
          references: refs.map(function (r) {
            return { source: r.source, width: r.width, height: r.height, format: r.ext, reduced: !!r.reduced };
          }),
          capture: cap
            ? {
                id: cap.id,
                reduced: !!cap.reduced,
                source_path: cap.memo && cap.memo.source_path ? cap.memo.source_path : null,
                files: capFiles.map(function (f) {
                  return { slot: f.slot, input: f.input, width: f.width, height: f.height, format: f.ext, reduced: !!f.reduced };
                })
              }
            : null,
          asset_ids: []
        },
        target: targetRecord(a),
        state: refs.length || capFiles.length ? "uploading_inputs" : "submitting",
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
    memos[rec.local_id] = { mask: a.mask || null, check: cap && cap.memo ? cap.memo.check || null : null, placement_mask: cap && cap.memo ? cap.memo.placement_mask || null : null };
    if (cap && o.capture && typeof o.capture.link === "function") o.capture.link(cap.id, rec.local_id);
    emit({ type: "started", local_id: rec.local_id });
    if (refs.length || capFiles.length) return uploadThenCheck(rec, refs, red, capFiles);
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

  function uploadName(kind, id, ext) {
    var d = new Date(now());
    var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
    return "photoshop-" + kind + "-" + stamp + "-" + String(id).replace(/[^A-Za-z0-9]/g, "").slice(-8) + "." + (ext === "jpg" ? "jpg" : "png");
  }

  function fileInput(schema, name) {
    for (var i = 0; i < schema.file_inputs.length; i++) if (schema.file_inputs[i].name === name) return schema.file_inputs[i];
    return null;
  }

  // 4: uploads (the capture, its mask, then the references), then the
  // second price check. The capture goes to the model's image input, or
  // first among its references.
  // True when the person canceled the upload (the record left
  // uploading_inputs): nothing more is uploaded or sent.
  function canceled(id) {
    var r = o.ledger.get(id);
    return !r || r.state !== "uploading_inputs";
  }

  async function uploadThenCheck(rec, refs, red, capFiles) {
    var ids = [];
    var capId = null;
    var capInput = null;
    var placed = {};
    var all = [];
    try {
      for (var c = 0; c < capFiles.length; c++) {
        var f = capFiles[c];
        var u = await assetsMod.uploadImage(o.client, f.bytes, uploadName(f.slot === "mask" ? "mask" : "capture", rec.local_id + c, f.ext));
        all.push(u.asset_id);
        if (f.slot === "capture") {
          capId = u.asset_id;
          capInput = f.input;
        } else placed[f.input] = u.asset_id;
        if (all.length === 1) await hooks.at("upload", { local_id: rec.local_id });
        if (canceled(rec.local_id)) return { record: o.ledger.get(rec.local_id), state: "not_sent" };
      }
      for (var i = 0; i < refs.length; i++) {
        var up = await assetsMod.uploadImage(o.client, refs[i].bytes, uploadName("reference", refs[i].id || i, refs[i].ext));
        ids.push(up.asset_id);
        all.push(up.asset_id);
        if (all.length === 1) await hooks.at("upload", { local_id: rec.local_id });
        if (canceled(rec.local_id)) return { record: o.ledger.get(rec.local_id), state: "not_sent" };
      }
    } catch (e) {
      recordError(e && e.type);
      if (canceled(rec.local_id)) return { record: o.ledger.get(rec.local_id), state: "not_sent" };
      return finish(rec.local_id, "not_sent", { error: "Not sent: " + (capFiles.length ? "an input" : "a reference") + " did not upload. " + ((e && e.message) || e) });
    }
    var schema = await o.catalog.schema(rec.model_id);
    var body = JSON.parse(JSON.stringify(rec.parameters));
    var input = requests.referenceInput(schema);
    if (capId) {
      var ci = fileInput(schema, capInput);
      if (ci && ci.multiple) body[capInput] = [capId].concat(input && input.name === capInput ? ids : []);
      else body[capInput] = capId;
    }
    if (ids.length && input && !(capId && input.name === capInput)) body[input.name] = input.multiple ? ids : ids[0];
    for (var name in placed) body[name] = placed[name];
    var inputs = JSON.parse(JSON.stringify(rec.inputs));
    inputs.asset_ids = all;
    if (canceled(rec.local_id)) return { record: o.ledger.get(rec.local_id), state: "not_sent" };
    await update(rec.local_id, { parameters: body, inputs: inputs });
    return checkAndSend(rec.local_id, red.thousandths);
  }

  async function checkAndSend(id, expected) {
    var rec = o.ledger.get(id);
    var t;
    try {
      t = await o.quotes.recheck(rec.model_id, rec.parameters);
      t = hooks.value("price_after_upload", t, { local_id: id });
      if (canceled(id)) return { record: o.ledger.get(id), state: "not_sent" };
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
    if (!rec || ["uploading_inputs", "awaiting_approval", "submitting"].indexOf(rec.state) < 0) return { record: rec, state: rec ? rec.state : null };
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
    await hooks.at("paid_answer", { local_id: id, status: out.status });
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
    if (out.status === "not_sent" && out.error && jobsApi.isBlockedText(out.error.scenarioMessage || out.reason, blockedTexts)) {
      // A content-policy refusal at submit (SPEC 2.5): no job exists.
      recordError("Blocked");
      log("jobs: blocked at submit");
      return finish(id, "blocked", { error: "Blocked: Scenario refused this request (content policy)." + (out.error.scenarioMessage ? " " + out.error.scenarioMessage : ""), cu_charged: "0", refunded: false });
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

  // 6: polling. A read that cannot go through pauses: offline 15 s, a 429
  // for Retry-After (60 s when absent); a refused key, a job the key cannot
  // see and other errors keep the normal pace, with the reason shown. A job
  // of another project, or no key at all, stops polling until the account
  // changes (accounts.onChange calls resume()).
  function poll(id) {
    if (polling[id]) return;
    polling[id] = true;
    var rec0 = o.ledger.get(id);
    var since = rec0 && rec0.submitted_at ? Date.parse(rec0.submitted_at) : now();
    if (isNaN(since)) since = now();
    function schedule(ms) {
      timers.setTimeout(tick, ms || delayFor(Math.max(0, now() - since)));
    }
    async function tick() {
      var rec = o.ledger.get(id);
      if (!rec || POLLING.indexOf(rec.state) < 0 || !rec.job_id) {
        delete polling[id];
        return;
      }
      var gate = gateFor(rec);
      if (gate) {
        delete polling[id];
        setWaiting(id, gate);
        return;
      }
      var read;
      try {
        read = await jobsApi.getJob(o.client, rec.job_id, blockedTexts);
      } catch (e) {
        var type = (e && e.type) || "error";
        log("jobs: status read failed (" + type + ")");
        if (type === "NotSignedIn") {
          delete polling[id];
          setWaiting(id, "Waiting for sign-in to continue.");
          return;
        }
        if (type === "Unauthorized" || type === "Forbidden" || type === "JobNotFound") {
          // Reads go on at the normal pace: a paid job is never given up.
          setWaiting(id, type === "JobNotFound" ? "Scenario does not list this job for the current key. Still checking." : "Scenario refused the current key. It continues once the key works again.");
          schedule();
          return;
        }
        if (type === "Offline") {
          setWaiting(id, "Offline. Checking again when the connection returns.");
          schedule(offlineMs);
          return;
        }
        if (type === "RateLimited") {
          var wait = e.retryAfterS > 0 ? Math.min(e.retryAfterS, 3600) * 1000 : RATE_LIMIT_MS;
          setWaiting(id, "Scenario asked to wait " + Math.round(wait / 1000) + " s.");
          schedule(wait);
          return;
        }
        schedule();
        return;
      }
      setWaiting(id, null);
      var patch = { remote_status: read.remote_status, progress: read.progress };
      if (!read.status || read.status === "queued" || read.status === "generating") {
        if (read.status && rec.state !== "cancel_requested") patch.state = read.status;
        await update(id, patch);
        await hooks.at("poll", { local_id: id, status: read.status });
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

  // 7: downloads, one take after another. Files already saved are kept;
  // each new attempt asks for fresh signed links.
  async function download(id) {
    if (downloading[id]) return;
    var rec = o.ledger.get(id);
    if (!rec) return;
    var gate = gateFor(rec);
    if (gate) {
      setWaiting(id, gate);
      return;
    }
    setWaiting(id, null);
    if (!(rec.outputs || []).length) {
      // Finished on Scenario but the result list was not saved: read it again.
      if (rec.job_id) {
        await update(id, { state: "queued" });
        poll(id);
      } else {
        await update(id, { state: "download_failed", error: "Download stopped: the job's results were not saved. Open it on Scenario." });
      }
      return;
    }
    downloading[id] = true;
    var token = { stopped: false, onStop: null };
    stops[id] = token;
    try {
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
          var got = await o.downloader.download(outputs[i].asset_id, base, null, token);
          outputs[i] = { asset_id: outputs[i].asset_id, state: "saved", path: got.path, width: got.width, height: got.height, mime: got.mime };
          await update(id, { outputs: outputs });
        } catch (e) {
          if (token.stopped || (e && e.stopped)) {
            await update(id, { state: "download_failed", outputs: outputs, error: "Download stopped: stopped by you. Resume download fetches it again.", download_error_type: null });
            return;
          }
          recordError(e && e.type);
          var type = e && (e.type === "ResultUnreachable" || e.type === "ResultExpired") ? e.type : null;
          await update(id, { state: "download_failed", outputs: outputs, error: (type || "Download stopped") + ": " + ((e && e.message) || e), download_error_type: type });
          return;
        }
      }
      await update(id, { state: "ready", error: null, download_error_type: null });
      emit({ type: "ready", local_id: id });
      maybeAutoPlace(id);
    } finally {
      delete downloading[id];
      if (stops[id] === token) delete stops[id];
    }
  }

  // Stop download in Jobs (SPEC 6.4 item 4): the attempt in progress stops,
  // its part file goes, saved takes stay; Resume download continues.
  function stopDownload(id) {
    var token = stops[id];
    if (!token) return Promise.resolve(o.ledger.get(id));
    o.downloader.stop(token);
    return Promise.resolve(o.ledger.get(id));
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

  function boxOf(arr) {
    return { left: arr[0], top: arr[1], width: arr[2], height: arr[3] };
  }

  function canvasChanged() {
    var e = err("CanvasChanged", "The canvas changed since this edit started. Use Place unmasked or Open as document.");
    e.canvasChanged = true;
    return e;
  }

  function docTitle(rec) {
    var t = rec.target || {};
    return t.document_title ? '"' + t.document_title + '"' : "its document";
  }

  // The open document a job's results belong in (SPEC 6.4, M5): the same
  // document in this Photoshop session; else the saved file it was made
  // from, found by the hash of its path; for records made before 0.5.0,
  // which carry no such hash, the open document with the same title and
  // canvas size. Returns { id, how: "same" | "key" | "title" } or null.
  function homeDoc(rec) {
    var t = rec.target || {};
    var docs = typeof o.host.listDocuments === "function" ? o.host.listDocuments() : [];
    var i;
    if (rec.session && rec.session === o.session && t.document_id !== undefined && t.document_id !== null) {
      for (i = 0; i < docs.length; i++) if (docs[i].id === t.document_id) return { id: t.document_id, how: "same" };
    }
    if (Object.prototype.hasOwnProperty.call(t, "document_key")) {
      if (!t.document_key || typeof o.host.documentKey !== "function") return null;
      for (i = 0; i < docs.length; i++) if (o.host.documentKey(docs[i].id) === t.document_key) return { id: docs[i].id, how: "key" };
      return null;
    }
    if (!t.document_title) return null;
    var want = t.canvas || t.document_size || null;
    for (i = 0; i < docs.length; i++) {
      if (docs[i].title !== t.document_title) continue;
      var size = o.host.documentSize(docs[i].id);
      if (!want || (size && size.width === want[0] && size.height === want[1])) return { id: docs[i].id, how: "title" };
    }
    return null;
  }

  // Where a placement would go now, for Jobs: { kind: "new_document" |
  // "active" (its document is in front) | "open" (open, not in front) |
  // "closed", document_id, title }.
  function whereFor(rec) {
    var t = rec.target || {};
    var newDoc = t.kind === "new_document" || !t.kind || (t.kind === "upscale" && t.lands === "new_document");
    if (newDoc) return { kind: "new_document", document_id: null, title: null };
    var home = homeDoc(rec);
    var active = o.host.activeDocumentId();
    if (!home) return { kind: "closed", document_id: null, title: t.document_title || null, unsaved: Object.prototype.hasOwnProperty.call(t, "document_key") && !t.document_key && rec.session !== o.session };
    return { kind: home.id === active ? "active" : "open", document_id: home.id, title: t.document_title || null, how: home.how };
  }

  // Where a job's results land: the plan options (document, box, fit, mask,
  // insert point, canvas, reads for the checks) and notes. opts:
  // new_document (Open as document), current_document (Place in current
  // document: the active document over its canvas), unmasked.
  function placement(rec, opts) {
    var t = rec.target || {};
    var notes = [];
    var active = o.host.activeDocumentId();
    var memo = memos[rec.local_id] || {};
    var first = (rec.outputs || [])[0] || {};
    var newDoc = opts.new_document || t.kind === "new_document" || !t.kind || (t.kind === "upscale" && t.lands === "new_document");
    if (newDoc) {
      var w = t.kind === "new_document" ? t.width : first.width;
      var h = t.kind === "new_document" ? t.height : first.height;
      return { document: null, box: { left: 0, top: 0, width: w || first.width, height: h || first.height }, fit: "cover", mask: null, notes: notes };
    }
    var hasActive = active !== null && active !== undefined;
    var home = homeDoc(rec);
    var inHome = !!home && hasActive && home.id === active;
    if (!inHome && !opts.current_document) {
      if (!home) {
        var unsaved = Object.prototype.hasOwnProperty.call(t, "document_key") && !t.document_key && rec.session !== o.session;
        throw err("DocumentClosed", unsaved ? "Its document was never saved, so it closed with Photoshop. Use Place in current document or Open as document." : "Open " + docTitle(rec) + " to place this result there, or use Place in current document or Open as document.");
      }
      throw err("DocumentNotActive", "Bring " + docTitle(rec) + " to the front to place this result there, or use Place in current document.");
    }
    if (!inHome || !t.box) {
      if (!hasActive) throw err("DocumentClosed", "Open a document to place this result, or use Open as document.");
      if (t.kind === "expand" || t.kind === "cutout") throw err("DocumentClosed", "This result lands in the document it was made from. Open that document, or use Open as document.");
      var size = o.host.documentSize(active);
      notes.push("Placed in the current document over its canvas.");
      return { document: size, box: { left: 0, top: 0, width: size.width, height: size.height }, fit: rec.lane === "image" ? "cover" : "box", mask: null, notes: notes };
    }
    if (home.how === "title") notes.push("Placed in " + docTitle(rec) + ", found by its name and size after a restart.");
    var doc = o.host.documentSize(active);
    var box = boxOf(t.box);
    var sameCanvas = !t.canvas || (doc.width === t.canvas[0] && doc.height === t.canvas[1]);
    if (rec.lane === "image") {
      var mask = t.kind === "selection" ? memo.mask || null : null;
      if (t.kind === "selection" && !mask) notes.push("Placed unmasked: the selection mask is kept until Photoshop quits.");
      // New layer lands above the active layer, Add background below it
      // (the panel's actions, SPEC 3).
      var ins = t.layer_id && (t.insert === "above" || t.insert === "below") ? { layer_id: t.layer_id, below: t.insert === "below" } : null;
      return { document: doc, box: box, fit: "cover", mask: mask, insert: ins, notes: notes };
    }
    if (rec.lane === "edit") {
      var m = null;
      if (!sameCanvas) {
        if (!opts.unmasked) throw canvasChanged();
        notes.push("Placed unmasked: the canvas changed since this edit started.");
      } else if (t.kind === "selection") {
        m = opts.unmasked ? null : memo.placement_mask || null;
        if (!m && !opts.unmasked) notes.push("Placed unmasked: the selection mask is kept until Photoshop quits.");
      }
      var check = sameCanvas ? memo.check : null;
      var R = check ? { bounds: check.region, width: check.width, height: check.height } : null;
      return { document: doc, box: box, fit: "box", mask: m, insert: t.sample === "layer" && t.layer_id ? { layer_id: t.layer_id } : null, reads: R ? { before: R, takes: R, after: R } : null, notes: notes };
    }
    if (t.kind === "expand") {
      if (!sameCanvas) throw canvasChanged();
      var e = t.expand;
      var old = { left: e.offset[0], top: e.offset[1], width: t.canvas[0], height: t.canvas[1] };
      var nc = { width: e.width, height: e.height };
      var inCanvas = shapeMod.clip(box, nc);
      var pm = pixelsMod.expandPlacementMask(inCanvas, old, e.sides, t.overlap);
      var cs = pixelsMod.fitLong(old.width, old.height, 512);
      var band = pixelsMod.expandBand(old, cs.width, cs.height, old, e.sides, t.overlap);
      var scale = cs.width / old.width;
      var decide = null;
      if (t.route !== "mask") {
        decide = function (reads) {
          if (!reads.before || !reads.takes.length) return null;
          var c = checksMod.bandCheck({ context: reads.before, result: reads.takes[0], band: band, scale: scale });
          if (c.seam_ok) return null;
          return { mask: false, note: "Placed unmasked for manual alignment: the result did not line up with the original on the overlap." };
        };
      }
      memo.expand = { band: band, scale: scale };
      memos[rec.local_id] = memo;
      return {
        document: doc,
        box: box,
        fit: "box",
        mask: pm,
        canvas: { width: e.width, height: e.height, offset: { x: e.offset[0], y: e.offset[1] } },
        duplicate: t.lands === "copy" ? { name: null } : null,
        reads: { before: { bounds: { left: 0, top: 0, width: old.width, height: old.height }, width: cs.width, height: cs.height }, takes: { bounds: old, width: cs.width, height: cs.height }, after: { bounds: old, width: cs.width, height: cs.height } },
        decide: decide,
        notes: notes
      };
    }
    if (t.kind === "upscale") {
      if (!sameCanvas) throw canvasChanged();
      return { document: doc, box: box, fit: "box", mask: null, insert: t.source === "layer" && t.layer_id ? { layer_id: t.layer_id } : null, notes: notes };
    }
    if (t.kind === "cutout") {
      if (!sameCanvas) throw canvasChanged();
      var src = rec.inputs && rec.inputs.capture ? rec.inputs.capture.source_path : null;
      if (t.lands === "new_layer" && !src) throw err("Internal", "The source pixels of this cutout were not saved; use Open as document.");
      // A cut-out of a selection lands as a new layer and drops the
      // selection, as Layer via Copy does (FLOWS v2, F1).
      var drop = t.source === "selection" && t.lands === "new_layer";
      return { document: doc, box: box, fit: "box", mask: null, cutout: { layer_id: t.layer_id, background: !!t.background, lands: t.lands, box: box, mask_box: t.mask_box ? boxOf(t.mask_box) : box, source_path: src, drop_selection: drop }, notes: notes };
    }
    return { document: doc, box: box, fit: "box", mask: null, notes: notes };
  }

  function rgbOf(img) {
    return img && img.components === 4 ? { width: img.width, height: img.height, components: 3, data: dropAlpha(img) } : img;
  }

  function dropAlpha(img) {
    var n = img.width * img.height;
    var out = new Uint8Array(n * 3);
    for (var i = 0; i < n; i++) for (var c = 0; c < 3; c++) out[i * 3 + c] = img.data[i * 4 + c];
    return out;
  }

  // 9: the checks, on the reads taken during the placement.
  function runChecks(rec, where, result) {
    var t = rec.target || {};
    var memo = memos[rec.local_id] || {};
    var reads = result.reads || {};
    var out = { checks: [], verify: null, badges: [] };
    var outputs = (rec.outputs || []).filter(function (x) {
      return x && x.path;
    });
    if (rec.lane === "edit" && memo.check && reads.takes && reads.takes.length) {
      var ck = memo.check;
      for (var i = 0; i < reads.takes.length; i++) {
        var c = checksMod.check({
          context: ck.context,
          result: rgbOf(reads.takes[i]),
          mask: ck.mask,
          scale: ck.scale,
          shaped: t.upload ? { width: t.upload[0], height: t.upload[1] } : null,
          result_size: outputs[i] ? { width: outputs[i].width, height: outputs[i].height } : null,
          masked: !!where.mask && result.masked,
          cleared: t.expect === "cleared"
        });
        out.checks.push(summary(c));
      }
      if (reads.before && reads.after && where.mask && result.masked) out.verify = checksMod.verify({ before: reads.before, after: reads.after, mask: ck.mask, feather: t.feather || 0, scale: ck.scale });
    } else if (t.kind === "expand" && memo.expand && reads.takes && reads.takes.length && reads.before) {
      for (var j = 0; j < reads.takes.length; j++) {
        var b = checksMod.bandCheck({ context: reads.before, result: rgbOf(reads.takes[j]), band: memo.expand.band, scale: memo.expand.scale });
        out.checks.push({ seam: b.seam ? { bias: b.seam.bias, residual: b.seam.residual } : null, seam_ok: b.seam_ok, edited: null, aspect_ok: aspectOk(rec, outputs[j]) });
      }
      if (reads.after && result.masked) out.verify = checksMod.verify({ before: reads.before, after: reads.after, mask: memo.expand.band, feather: 0, scale: memo.expand.scale });
    }
    for (var k = 0; k < Math.max(out.checks.length, outputs.length); k++) {
      var badges = checksMod.badges(out.checks[k] || null, k === 0 ? out.verify : null, { masked: !!where.mask && result.masked });
      var small = smallResult(rec, outputs[k]);
      if (small) badges.push(small);
      out.badges.push(badges);
    }
    return out;
  }

  function aspectOk(rec, output) {
    var t = rec.target || {};
    if (!output || !t.upload) return null;
    var w = t.upload[0];
    var h = t.upload[1];
    return Math.abs(output.width / output.height - w / h) <= checksMod.LIMITS.aspect * (w / h);
  }

  function summary(c) {
    return {
      edited: c.edited,
      polarity_suspect: c.polarity_suspect,
      aspect_ok: c.aspect_ok,
      inside_mean: c.inside ? c.inside.mean : null,
      outside_mean: c.outside ? c.outside.mean : null,
      seam: c.seam ? { bias: c.seam.bias, residual: c.seam.residual } : null,
      seam_ok: c.seam_ok,
      kept_share: c.kept_share === undefined ? null : c.kept_share
    };
  }

  // "Result is N px for an M px area" (SPEC 3.9): the result was scaled up
  // into its box.
  function smallResult(rec, output) {
    var t = rec.target || {};
    if (!output || !t.box || rec.lane === "image" || t.kind === "cutout") return null;
    if (t.kind === "upscale" && t.lands === "new_document") return null;
    var n = Math.max(output.width, output.height);
    var m = Math.round(Math.max(t.box[2], t.box[3]));
    return n < m ? "Result is " + n + " px for an " + m + " px area" : null;
  }

  // Places a ready job (Place, Place unmasked, Open as document, or Place
  // when ready).
  async function place(id, opts) {
    opts = opts || {};
    var rec = o.ledger.get(id);
    if (!rec || ["ready", "apply_failed", "applied"].indexOf(rec.state) < 0) throw err("Internal", "This job has no saved results to place.");
    if (placing[id]) throw err("Internal", "This result is being placed.");
    placing[id] = true;
    try {
      return await placeNow(id, rec, opts);
    } finally {
      delete placing[id];
    }
  }

  // Layers in the open documents whose metadata carries this job's result
  // asset ids or its job id (SPEC 6.4: a placement that was running when
  // Photoshop closed may have been kept by crash recovery).
  async function placedLayers(rec) {
    if (typeof o.host.findPlacedLayers !== "function") return [];
    var assets = (rec.outputs || [])
      .map(function (x) {
        return x && x.asset_id;
      })
      .filter(Boolean);
    var needles = assets.slice();
    if (rec.job_id) needles.push(rec.job_id);
    if (!needles.length) return [];
    var found = [];
    try {
      found = (await o.host.findPlacedLayers(needles)) || [];
    } catch (e) {
      return [];
    }
    return found.filter(function (f) {
      var m = xmpMod.parse(f.xmp || "") || {};
      return (m.assetId && assets.indexOf(m.assetId) >= 0) || (rec.job_id && m.jobId === rec.job_id && !m.assetId);
    });
  }

  // A job recovered from placing: if its layers are already in an open
  // document, it is placed (applied) and nothing lands twice.
  async function checkPlaced(id) {
    var rec = o.ledger.get(id);
    if (!rec || rec.recovered_from !== "applying" || rec.placement_checked || rec.state !== "ready") return null;
    var found = await placedLayers(rec);
    if (!found.length) return null;
    var docId = found[0].document_id;
    log("jobs: a job that was placing at the restart is already in a document");
    return update(id, {
      state: "applied",
      placement_checked: true,
      error: null,
      placement: {
        document_id: docId,
        layer_ids: found
          .filter(function (f) {
            return f.document_id === docId;
          })
          .map(function (f) {
            return f.layer_id;
          }),
        group_id: null,
        history: null,
        masked: null,
        notes: ["Found in the document after Photoshop restarted; it was not placed again."],
        checks: [],
        verify: null,
        badges: [],
        undone: false
      }
    });
  }

  async function placeNow(id, rec, opts) {
    if (!opts.new_document) {
      var already = await checkPlaced(id);
      if (already) return already;
    }
    var where;
    try {
      where = placement(rec, opts);
    } catch (e) {
      if (e && e.canvasChanged && !opts.auto) await update(id, { error: e.message });
      throw e;
    }
    var p = planMod.build(rec, { version: o.version, document: where.document, box: where.box, mask: where.mask, restore_active: !!opts.auto, fit: where.fit, insert: where.insert, canvas: where.canvas, duplicate: where.duplicate, reads: where.reads, cutout: where.cutout });
    var before = rec.state;
    await update(id, { state: "applying", placement_checked: true });
    await hooks.at("place", { local_id: id, document_id: where.document ? where.document.id : null });
    try {
      var result = await o.host.placeResults(p, { auto: !!opts.auto, decide: where.decide || null });
      var notes = where.notes.concat(result.notes || []);
      var checked = { checks: [], verify: null, badges: [] };
      try {
        checked = runChecks(rec, where, result);
      } catch (e) {
        log("jobs: checks did not run (" + ((e && e.message) || e) + ")");
        notes.push("The checks did not run; the result is placed.");
      }
      var done = await update(id, {
        state: "applied",
        error: null,
        placement: {
          document_id: result.document_id,
          layer_ids: result.layer_ids,
          group_id: result.group_id || null,
          history: p.history_name,
          masked: !!result.masked,
          notes: notes,
          checks: checked.checks,
          verify: checked.verify ? { untouched: checked.verify.untouched, outside_max: checked.verify.outside_max } : null,
          badges: checked.badges,
          undone: false
        }
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

  // The Undo of a "Changed outside" card (SPEC 6.5): steps back Scenario's
  // own History state when it is still the last one. The results stay saved.
  async function undo(id) {
    var rec = o.ledger.get(id);
    if (!rec || rec.state !== "applied" || !rec.placement) throw err("Internal", "This result is not placed.");
    var ok = await o.host.undoLast(rec.placement.document_id, rec.placement.history);
    if (!ok) throw err("Internal", "Undo it from Photoshop's History panel: Scenario's step is no longer the last one, or its document is not active.");
    var pl = JSON.parse(JSON.stringify(rec.placement));
    pl.undone = true;
    return update(id, { state: "ready", placement: pl });
  }

  // Cancel on an uploading job (SPEC 3.11): nothing was sent to generate.
  // Uploads already done stay on Scenario, hidden like every upload.
  function cancelUpload(id) {
    var rec = o.ledger.get(id);
    if (!rec || rec.state !== "uploading_inputs") return Promise.resolve(rec);
    return finish(id, "not_sent", { error: "Not sent: Canceled while uploading." }).then(function (r) {
      return r.record;
    });
  }

  // SPEC 6.2 step 5: Unknown resolution, by the person only.
  function check(id) {
    var rec = o.ledger.get(id);
    if (!rec || rec.state !== "uncertain") return Promise.reject(err("Internal", "This job is not Unknown."));
    return resolver.check(id).then(function (c) {
      emit({ type: "checked", local_id: id });
      return c;
    });
  }

  // Link this job: the record takes the Scenario job and continues
  // (polling, the charge, download, then Place). Only a job the last check
  // listed, and never one another record holds.
  async function link(id, jobId) {
    var rec = o.ledger.get(id);
    if (!rec || rec.state !== "uncertain") throw err("Internal", "This job is not Unknown.");
    if (!paid.validJobId(jobId)) throw err("Internal", "Not a Scenario job id.");
    var other = o.ledger.findByJobId(jobId);
    if (other && other.local_id !== id) throw err("Internal", "This Scenario job is already linked to another job here.");
    var c = resolver.lastCheck(id);
    var pick = null;
    for (var i = 0; c && i < c.candidates.length; i++) if (c.candidates[i].job_id === jobId) pick = c.candidates[i];
    if (!pick) throw err("Internal", "Check again first: this job is not among the jobs found.");
    var r = await update(id, {
      state: "queued",
      job_id: jobId,
      submitted_at: pick.created_at || rec.claimed_at || iso(),
      error: null,
      resolution: { kind: "linked", at: iso(), exact: !!pick.exact }
    });
    resolver.forget(id);
    log("jobs: Unknown job linked by the person");
    emit({ type: "linked", local_id: id });
    poll(id);
    return r;
  }

  // Mark not sent (SPEC 6.2 step 5.3), durable; it unblocks the request.
  // Allowed only after a complete check within the last 10 minutes found no
  // job on Scenario matching this request exactly: a matching job ran and
  // was charged, so it is linked instead and its result is kept. The check
  // runs here when none is recent.
  async function markNotSent(id) {
    var rec = o.ledger.get(id);
    if (!rec || rec.state !== "uncertain") return null;
    var c = resolver.lastCheck(id);
    if (!resolver.fresh(c) || !c.complete) c = await resolver.check(id);
    if (!c.complete) {
      throw err("CheckIncomplete", "Could not check Scenario's jobs" + (c.error ? " (" + c.error + ")" : "") + ". Check again before marking it not sent.");
    }
    if (c.preselected || c.candidates.some(function (x) {
      return x.exact;
    })) {
      throw err("JobMayExist", "A job on Scenario matches this request exactly, so it ran and was charged. Link it to keep its result.");
    }
    var out = await finish(id, "not_sent", { error: "Not sent: marked not sent by you.", resolution: { kind: "not_sent", at: iso(), checked_at: c.checked_at, candidates: c.candidates.length } });
    resolver.forget(id);
    return out;
  }

  function resumeDownload(id) {
    var rec = o.ledger.get(id);
    if (!rec || rec.state !== "download_failed" || rec.download_error_type) return Promise.resolve(null);
    return download(id);
  }

  // Polling and downloads continue for the jobs the current key can read;
  // the others wait (SPEC 6.4). Called after the ledger is read and on every
  // account change. Nothing is placed by itself.
  function resume() {
    var list = o.ledger.all();
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (POLLING.indexOf(r.state) >= 0 && r.job_id) poll(r.local_id);
      else if (r.state === "succeeded" || r.state === "downloading") download(r.local_id);
    }
  }

  // At startup, once the ledger is read (SPEC 6.4 item 2): saved results
  // whose files are gone go back to download stopped (Resume download asks
  // Scenario again); a job that was placing is looked for in the open
  // documents; then resume().
  async function recover() {
    var list = o.ledger.all();
    var dirs = {};
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      try {
        if (r.state === "ready" || r.state === "apply_failed") {
          var outs = JSON.parse(JSON.stringify(r.outputs || []));
          var missing = 0;
          for (var k = 0; k < outs.length; k++) {
            if (outs[k].state !== "saved" || !outs[k].path) continue;
            var at = outs[k].path.lastIndexOf("/");
            var dir = outs[k].path.slice(0, at);
            if (!dirs[dir]) dirs[dir] = (await o.host.listData(dir)) || [];
            if (dirs[dir].indexOf(outs[k].path.slice(at + 1)) < 0) {
              outs[k] = { asset_id: outs[k].asset_id, state: "pending", path: null };
              missing++;
            }
          }
          if (missing) {
            await update(r.local_id, { state: "download_failed", outputs: outs, error: "Download stopped: " + (missing === 1 ? "a saved result is" : missing + " saved results are") + " missing from the Output Folder. Resume download fetches them again.", download_error_type: null });
            continue;
          }
          if (r.recovered_from === "applying") await checkPlaced(r.local_id);
        }
      } catch (e) {
        log("jobs: recovery check failed (" + ((e && e.message) || e) + ")");
      }
    }
    resume();
  }

  return {
    start: start,
    approve: approve,
    decline: decline,
    place: place,
    undo: undo,
    cancelUpload: cancelUpload,
    check: check,
    link: link,
    markNotSent: markNotSent,
    lastCheck: resolver.lastCheck,
    isChecking: resolver.isChecking,
    resumeDownload: resumeDownload,
    stopDownload: stopDownload,
    resume: resume,
    recover: recover,
    pausedFor: pausedFor,
    canAutoPlace: canAutoPlace,
    whereFor: whereFor,
    waitingFor: function (id) {
      return waiting[id] || null;
    },
    isDownloading: function (id) {
      return !!downloading[id];
    },
    onEvent: function (fn) {
      listeners.push(fn);
    },
    OUTPUT_FOLDER: OUTPUT_FOLDER
  };
}

module.exports = { createRunner: createRunner, pollDelay: pollDelay, trainedIds: trainedIds, projectHash: projectHash, OUTPUT_FOLDER: OUTPUT_FOLDER, QUOTE_MODE: QUOTE_MODE, POLLING: POLLING };
