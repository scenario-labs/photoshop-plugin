"use strict";
// The plugin's side of the v1 agent tools (SPEC 7.3, MCP.md section 4).
// The helper relays each call with the client session it came from
// (ctx: { session, client_name, connected_at }); every handler here checks
// the switches and the read scope, then calls the same modules as the
// panel. Money: generate runs the checks of MCP.md section 3 in order, then
// the Agent spending setting (an approval card, or the allowance).

var errorsMod = require("../scenario/errors.js");
var jobsApi = require("../scenario/jobs-api.js");
var assetsMod = require("../scenario/assets.js");
var canonical = require("../util/canonical-json.js");
var inflate = require("../util/inflate.js");
var png = require("../util/png.js");
var jpeg = require("../util/jpeg.js");
var b64 = require("../util/base64url.js");
var price = require("../forms/price.js");
var charges = require("../jobs/charges.js");
var ledgerMod = require("../jobs/ledger.js");
var runnerMod = require("../jobs/runner.js");
var pixels = require("../capture/pixels.js");
var checksMod = require("../apply/checks.js");
var planMod = require("../apply/plan.js");
var common = require("../lanes/common.js");
var map = require("../catalog/map.js");

var WAIT_DEFAULT_S = 45;
var WAIT_MAX_S = 170;
var APPLICATION_TTL_MS = 600000;
// The panel's names of the lanes (FLOWS v2), for the cards.
var LANE_NAMES = { image: "Create image", edit: "Edit", upscale: "Upscale", expand: "Expand", remove_background: "Remove BG" };
var STOP_STATES = ["ready", "applied", "download_failed", "uncertain"].concat(ledgerMod.FINAL);
var CAPABILITY = { image: "txt2img", edit: "img2img" };

function fail(type, text) {
  return new errorsMod.ScenarioError(type, text);
}

function invalid(text) {
  return fail("InvalidParameter", text);
}

function has(obj, k) {
  return obj !== null && obj !== undefined && Object.prototype.hasOwnProperty.call(obj, k);
}

function given(v) {
  return v !== undefined && v !== null;
}

function cursorOf(c) {
  if (!given(c)) return 0;
  var m = /^o(\d{1,6})$/.exec(String(c));
  if (!m) throw invalid("cursor is not one this tool returned.");
  return Number(m[1]);
}

function limitOf(v, def, max) {
  if (!given(v)) return def;
  if (!(v >= 1 && v <= max) || v % 1) throw invalid("limit must be 1 to " + max + ".");
  return v;
}

// o: { host, ps (agents/ps-host.js), settings, approvals, inputs, ledger,
//      runner, quotes, catalog, catalogTools, client, account(), session,
//      random, timers, log, version }
function createAgentTools(o) {
  var log = o.log || function () {};
  var now = o.timers.now;
  var quoteCtx = {};
  var applications = {};
  // Allowance deductions per job: { local_id: { session, amount } }.
  var deducted = {};
  var appSeq = 0;

  // ---- scope (MCP.md section 2, SPEC 6.6) ----

  var scope = {
    // A document a call reads: defaults to the active one.
    readDoc: function (id) {
      var active = o.host.activeDocumentId();
      var docId = given(id) ? id : active;
      if (!given(docId)) throw fail("DocumentClosed", "No document is open.");
      if (o.settings.switches().active_document_only && docId !== active) throw fail("DocumentNotAllowed", "Agents read the active document only.");
      if (!o.host.documentSize(docId)) throw fail("DocumentClosed", "The document is closed.");
      return docId;
    },
    // A document a call changes: the active one only.
    changeDoc: function (id) {
      var active = o.host.activeDocumentId();
      var docId = scope.readDoc(id);
      if (docId !== active) throw fail("DocumentNotActive", "Bring the document to the front first: changes go to the active document only.");
      return docId;
    },
    // Jobs made without a document stay visible; a record from an earlier
    // Photoshop session counts as another document.
    jobVisible: function (rec) {
      if (!o.settings.switches().active_document_only) return true;
      var t = rec.target || {};
      if (!given(t.document_id) || t.kind === "new_document") return true;
      return rec.session === o.session && t.document_id === o.host.activeDocumentId();
    }
  };

  function switchOn(key, label) {
    if (!o.settings.switches()[key]) throw fail("SwitchOff", "Turn on " + label + " in Settings > Connect an AI agent to let agents do this.");
  }

  function modifyOn() {
    switchOn("agents_may_modify", "Agents may modify the document");
  }

  function record(ctx, what, detail) {
    o.approvals.record({ client_name: ctx.client_name, what: what, detail: detail || null });
  }

  // ---- jobs ----

  function jobFor(args, check) {
    var rec = null;
    if (given(args.local_id)) rec = o.ledger.get(args.local_id);
    else if (given(args.job_id)) rec = o.ledger.findByJobId(args.job_id);
    else throw invalid("Pass local_id or job_id.");
    if (!rec) throw invalid("No such job in this plugin's ledger." + (given(args.job_id) ? " recover_cloud_job adds a finished job of the current project." : ""));
    if (check !== false && !scope.jobVisible(rec)) throw fail("DocumentNotAllowed", "Agents read the active document only: this job belongs to another document.");
    return rec;
  }

  function own(rec, ctx) {
    return !!(rec.origin && rec.origin.kind === "agent" && rec.origin.session === ctx.session);
  }

  function actionsFor(rec, ctx) {
    if (rec.state === "uncertain") return [];
    var a = ["refresh"];
    if (rec.state === "ready" || rec.state === "download_failed" || rec.state === "apply_failed") a.push("recover_download");
    if (own(rec, ctx) && rec.state === "download_failed" && !rec.download_error_type) a.push("resume");
    if (own(rec, ctx) && rec.state === "downloading") a.push("stop_download");
    return a;
  }

  function applicationOf(rec) {
    if (rec.application) return JSON.parse(JSON.stringify(rec.application));
    if (rec.placement && !rec.placement.undone) return { state: "committed", history_state: rec.placement.history || null, layer_ids: rec.placement.layer_ids || [] };
    return { state: "none", history_state: null, layer_ids: [] };
  }

  function jobOut(rec, ctx) {
    var outs = (rec.outputs || []).map(function (x, i) {
      return { asset_id: x.asset_id, take: i + 1, file_state: x.state === "saved" ? "saved" : x.state || "pending", path: x.state === "saved" ? x.path : null };
    });
    return {
      local_id: rec.local_id,
      job_id: rec.job_id || null,
      status: rec.state,
      remote_status: rec.remote_status || null,
      progress: typeof rec.progress === "number" ? rec.progress : null,
      cu_quoted: rec.cu_quoted_new || rec.cu_quoted || null,
      cu_quoted_max: rec.cu_quoted_max || null,
      price_kind: rec.price_kind || null,
      cu_record: rec.cu_record === undefined ? null : rec.cu_record,
      cu_charged: rec.cu_charged === undefined ? null : rec.cu_charged,
      refunded: !!rec.refunded,
      no_refund: !!rec.no_refund,
      origin: { kind: rec.origin ? rec.origin.kind : "person", client: rec.origin && rec.origin.kind === "agent" ? rec.origin.client_name || null : null },
      approval: { state: rec.approval ? rec.approval.state : "none" },
      outputs: outs,
      application: applicationOf(rec),
      error: rec.error || null,
      revision: rec.revision || 0,
      actions: actionsFor(rec, ctx)
    };
  }

  function jobStatus(args, ctx) {
    return jobOut(jobFor(args), ctx);
  }

  function waitForJob(args, ctx) {
    var rec = jobFor(args);
    var t = given(args.timeout) ? args.timeout : WAIT_DEFAULT_S;
    if (!(t >= 0 && t <= WAIT_MAX_S)) throw invalid("timeout must be 0 to " + WAIT_MAX_S + " s.");
    var deadline = now() + t * 1000;
    var id = rec.local_id;
    return new Promise(function (resolve) {
      function tick() {
        var r = o.ledger.get(id);
        if (!r) return resolve({ still_running: false, status: null });
        if (STOP_STATES.indexOf(r.state) >= 0 || now() >= deadline) {
          var out = jobOut(r, ctx);
          out.still_running = STOP_STATES.indexOf(r.state) < 0;
          return resolve(out);
        }
        o.timers.setTimeout(tick, 250);
      }
      tick();
    });
  }

  var FILTERS = ["all", "active", "needs_attention", "agents", "this_client"];

  function listLocalJobs(args, ctx) {
    var filter = args.filter || "all";
    if (FILTERS.indexOf(filter) < 0) throw invalid("filter must be one of: " + FILTERS.join(", ") + ".");
    var limit = limitOf(args.limit, 20, 100);
    var start = cursorOf(args.cursor);
    var list = o.ledger.all().filter(function (r) {
      if (!scope.jobVisible(r)) return false;
      if (filter === "active") return ledgerMod.ACTIVE.indexOf(r.state) >= 0;
      if (filter === "needs_attention") return ["uncertain", "download_failed", "apply_failed", "awaiting_approval"].indexOf(r.state) >= 0;
      if (filter === "agents") return r.origin && r.origin.kind === "agent";
      if (filter === "this_client") return own(r, ctx);
      return true;
    });
    var page = list.slice(start, start + limit).map(function (r) {
      var p = r.parameters && typeof r.parameters.prompt === "string" ? r.parameters.prompt : "";
      return { local_id: r.local_id, job_id: r.job_id || null, status: r.state, lane: r.lane, model_name: r.model_name || null, prompt_slug: p ? p.slice(0, 40) : null, cu_quoted: r.cu_quoted || null, cu_quoted_max: r.cu_quoted_max || null, cu_charged: r.cu_charged === undefined ? null : r.cu_charged, origin: { kind: r.origin ? r.origin.kind : "person", client: r.origin && r.origin.client_name ? r.origin.client_name : null }, created_at: r.created_at, revision: r.revision || 0 };
    });
    return { jobs: page, next_cursor: start + limit < list.length ? "o" + (start + limit) : null };
  }

  // ---- spending ----

  function requestHash(args) {
    return canonical.hash({ lane: args.lane, model_id: args.model_id, parameters: args.parameters || {}, quote_id: args.quote_id, approved_cost: args.approved_cost });
  }

  // The quote's file inputs by name ({ name: [asset ids] }) as one list.
  function flatAssets(m) {
    var out = [];
    if (Array.isArray(m)) return m.slice();
    for (var k in m || {}) out = out.concat(m[k]);
    return out;
  }

  function onQuote(q, req, args) {
    var t = now();
    for (var id in quoteCtx) if (t - quoteCtx[id].at > 600000) delete quoteCtx[id];
    quoteCtx[q.quote_id] = { at: t, req: JSON.parse(JSON.stringify(req)), lane: args.lane, model_id: args.model_id, capture_id: req.capture_id || null, needs_upload: !!q.needs_upload, input_assets: flatAssets(q.input_assets), no_refund: !!q.no_refund, label: q.label };
  }

  // The request generate would send: what the quote priced, with the
  // agent's parameters (merged over a capture's, as estimate_cost did).
  function requestFor(args, qc) {
    var req = JSON.parse(JSON.stringify(qc.req));
    // What the quote priced (a capture's parameters and uploaded parts
    // included), with the agent's parameters over it: different ones fail
    // the fingerprint check.
    var params = JSON.parse(JSON.stringify(qc.req.parameters || {}));
    var a = args.parameters || {};
    for (var k in a) params[k] = a[k];
    req.parameters = params;
    return req;
  }

  function priceLabel(kind, exact, max) {
    var t = charges.parse(exact);
    var m = max ? charges.parse(max) : null;
    if (kind === "from") return "from " + price.display(t) + " CU, no upper bound";
    if (kind === "range" && m !== null) return price.display(t) + " to " + price.display(m) + " CU";
    return price.display(t) + " CU";
  }

  function spendCard(rec, ctx) {
    var label = priceLabel(rec.price_kind, rec.cu_quoted_new || rec.cu_quoted, rec.cu_quoted_max);
    var prompt = rec.parameters && typeof rec.parameters.prompt === "string" ? rec.parameters.prompt : null;
    var takes = null;
    for (var k in rec.parameters || {}) if (/^(numSamples|numOutputs|takes|n)$/.test(k)) takes = rec.parameters[k];
    o.approvals.add({
      kind: "spend",
      session: ctx.session,
      client_name: ctx.client_name,
      title: ctx.client_name + " asks to spend",
      lines: [(LANE_NAMES[rec.lane] || rec.lane || "Create image") + " with " + (rec.model_name || rec.model_id) + (takes ? ", " + takes + (takes === 1 ? " take" : " takes") : "") + (rec.target && rec.target.document_title ? ", for " + rec.target.document_title : "")],
      prompt: prompt,
      price_label: label,
      approve_label: "Approve · " + label,
      decline_label: "Decline",
      note: rec.no_refund ? "No refund if it fails" : null,
      data: { local_id: rec.local_id, prompt: prompt, model_name: rec.model_name || rec.model_id, price: label },
      onApprove: async function () {
        var out = await o.runner.approve(rec.local_id);
        if (out && out.changed) {
          var l2 = priceLabel(rec.price_kind, out.price, null);
          return { keep: true, update: { price_label: l2, approve_label: "Approve · " + l2, note: "The price changed to " + l2 + ". Approve again to send." } };
        }
        record(ctx, "Spend approved", label);
        return out;
      },
      onDecline: function (why) {
        record(ctx, why === "declined" ? "Spend declined" : "Spend request expired", label);
        return o.runner.decline(rec.local_id, why === "declined" ? "declined" : "expired");
      }
    });
  }

  async function generate(args, ctx) {
    var key = given(args.idempotency_key) ? String(args.idempotency_key) : args.quote_id;
    if (typeof key !== "string" || key.length < 8 || key.length > 128) throw invalid("idempotency_key must be 8 to 128 characters.");
    var hash = requestHash(args);
    // 1. Idempotency: a key already in the ledger returns its job.
    var existing = o.ledger.findByKey(key);
    if (existing) {
      if (existing.request_hash !== hash) throw fail("IdempotencyConflict", "This idempotency_key was already used for another request.");
      return { local_id: existing.local_id, status: existing.state, job_id: existing.job_id || null, replayed: true, allowance_remaining: null, note: "Replayed: this key's job is returned; nothing was sent." };
    }
    var qc = has(quoteCtx, args.quote_id) ? quoteCtx[args.quote_id] : null;
    if (!qc) throw fail("QuoteExpired", "This plugin issued no such quote, or it is older than 10 minutes. Call estimate_cost again.");
    if (qc.lane !== args.lane || qc.model_id !== args.model_id) throw fail("QuoteMismatch", "lane and model_id must be the ones the quote priced.");
    var req = requestFor(args, qc);
    // 2. In flight.
    var fp = await o.quotes.fingerprintFor(req);
    var flying = o.ledger.inFlight(fp);
    if (flying) throw fail("RequestInFlight", flying.state === "uncertain" ? "A matching request is Unknown; the person resolves it in Jobs first." : "A job with the same request is " + flying.state.replace("_", " ") + ".");
    // 3 to 5. Quote, cost, fingerprint (not used yet).
    var peek = await o.quotes.peek(args.quote_id, args.approved_cost, req);
    var waitingInputs = Object.keys(req.pending || {});
    if (waitingInputs.length) throw invalid("Upload " + waitingInputs.join(" and ") + " with upload_reference, pass the asset ids in parameters, and call estimate_cost again.");
    if (qc.needs_upload) throw invalid("This quote left out an input that is not uploaded yet (needs_upload). Upload it with upload_reference, pass its asset id, and call estimate_cost again.");
    // 6. No-spend.
    if (o.settings.noSpend()) throw fail("NoSpend", "No-spend mode is on. Nothing was sent.");
    // Then the Agent spending setting.
    var amount = peek.kind === "range" && peek.max !== null ? peek.max : peek.thousandths;
    var allowed = peek.kind !== "from" && o.settings.spending().mode === "allow" && o.settings.tryDeduct(ctx.session, amount);
    var hold = !allowed;
    var cap = qc.capture_id ? o.inputs.capture(qc.capture_id) : null;
    var docTitle = cap ? cap.document_title : null;
    if (!docTitle && req.target && given(req.target.document_id)) {
      var docs = o.host.listDocuments();
      for (var d = 0; d < docs.length; d++) if (docs[d].id === req.target.document_id) docTitle = docs[d].title;
    }
    var out;
    try {
      out = await o.runner.start({
        req: req,
        quote: { quote_id: args.quote_id, cu_cost_exact: args.approved_cost, no_refund: qc.no_refund },
        refs: [],
        capture: cap ? { id: cap.capture_id, reduced: !!cap.reduced, memo: cap.memo || null, files: [] } : null,
        model_name: (await o.catalog.schema(req.model_id)).name,
        document_title: docTitle,
        key: key,
        request_hash: hash,
        origin: { kind: "agent", client_name: ctx.client_name, session: ctx.session, connected_at: ctx.connected_at || null },
        hold: hold,
        allowance: allowed,
        priced_at: peek.issued_at,
        input_assets: qc.input_assets
      });
    } catch (e) {
      if (allowed) o.settings.refund(ctx.session, amount);
      throw e;
    }
    var rec = out.record;
    if (allowed) {
      if (out.state === "not_sent") o.settings.refund(ctx.session, amount);
      else deducted[rec.local_id] = { session: ctx.session, amount: amount };
      record(ctx, "Spent under the allowance", priceLabel(peek.kind, args.approved_cost, peek.max !== null ? price.exactString(peek.max) : null));
    }
    if (hold && out.state === "awaiting_approval") {
      spendCard(o.ledger.get(rec.local_id), ctx);
      record(ctx, "Asked to spend", priceLabel(peek.kind, args.approved_cost, peek.max !== null ? price.exactString(peek.max) : null));
    }
    var allowance = allowed ? o.settings.spending() : null;
    return {
      local_id: rec.local_id,
      status: out.state,
      job_id: rec.job_id || (out.record && out.record.job_id) || null,
      replayed: false,
      allowance_remaining: allowance ? allowance.remaining : null,
      note: hold ? "Waiting for the person's approval in the panel. Call wait_for_job." : null
    };
  }

  // A charge above its quote ends the allowance (SPEC 6.3).
  o.ledger.onChange(function (rec) {
    var d = deducted[rec.local_id];
    if (!d) return;
    var charged = rec.cu_charged === null || rec.cu_charged === undefined ? null : charges.parse(String(rec.cu_charged));
    if (charged !== null) {
      delete deducted[rec.local_id];
      if (o.settings.settle(d.session, d.amount, charged) === "above") o.approvals.record({ client_name: rec.origin ? rec.origin.client_name : null, what: "Allowance ended", detail: "Charged " + price.exactString(charged) + " CU, above the quoted " + price.exactString(d.amount) });
    } else if (ledgerMod.FINAL.indexOf(rec.state) >= 0) {
      delete deducted[rec.local_id];
    }
  });

  async function cancelPreparedJob(args, ctx) {
    var rec = jobFor({ local_id: args.local_id });
    if (!own(rec, ctx)) throw fail("NotYourJob", "Only jobs this client session started can be withdrawn.");
    if (rec.state !== "awaiting_approval") throw invalid("This job is " + rec.state + ", not awaiting approval.");
    // decline() does nothing while the person's approval is going through:
    // the request may be sent, so the agent is not told it was withdrawn.
    var dropCard = function () {
      o.approvals.drop(function (c) {
        return c.kind === "spend" && c.data && c.data.local_id === rec.local_id;
      });
    };
    var done;
    try {
      done = await o.runner.decline(rec.local_id, "withdrawn");
    } catch (e) {
      // The record is not sent in memory even when its write failed.
      dropCard();
      throw e;
    }
    if (!done) {
      var now = o.ledger.get(rec.local_id);
      throw invalid("This job is being approved in the panel (now " + (now ? now.state : "gone") + "), so it may be sent. Call job_status.");
    }
    dropCard();
    record(ctx, "Withdrew a spend request", null);
    return { status: "not_sent" };
  }

  // ---- recovery ----

  async function recoverLocalJob(args, ctx) {
    var rec = jobFor({ local_id: args.local_id });
    if (given(args.expected_revision) && args.expected_revision !== rec.revision) throw invalid("expected_revision is " + rec.revision + ": the job changed. Read job_status again.");
    if (rec.state === "uncertain") throw fail("UncertainNeedsPerson", "Only the person can resolve an Unknown job, in Jobs.");
    var action = args.action;
    if (action === "refresh") {
      if (rec.job_id && runnerMod.POLLING.indexOf(rec.state) >= 0) o.runner.resume();
    } else if (action === "recover_download") {
      var outs = rec.outputs || [];
      var ok = outs.length > 0;
      for (var i = 0; i < outs.length; i++) {
        if (outs[i].state !== "saved" || !outs[i].path) {
          ok = false;
          continue;
        }
        var at = outs[i].path.lastIndexOf("/");
        var names = (await o.host.listData(outs[i].path.slice(0, at))) || [];
        if (names.indexOf(outs[i].path.slice(at + 1)) < 0) ok = false;
      }
      if (["ready", "download_failed", "apply_failed"].indexOf(rec.state) < 0) throw invalid("recover_download needs a job with results (ready or download stopped).");
      if (!ok && rec.state !== "download_failed") await o.ledger.update(rec.local_id, { state: "download_failed", error: "Download stopped: a saved result is missing from the Output Folder. Resume download fetches it again.", download_error_type: null });
      if (ok && rec.state === "download_failed") await o.ledger.update(rec.local_id, { state: "ready", error: null, download_error_type: null });
    } else if (action === "resume" || action === "stop_download") {
      if (!own(rec, ctx)) throw fail("NotYourJob", "Only jobs this client session started can be " + (action === "resume" ? "resumed" : "stopped") + ".");
      if (action === "resume") {
        if (rec.state !== "download_failed") throw invalid("Only a stopped download can resume.");
        o.runner.resumeDownload(rec.local_id);
      } else await o.runner.stopDownload(rec.local_id);
    } else {
      throw invalid("action must be refresh, recover_download, resume or stop_download.");
    }
    var after = o.ledger.get(rec.local_id);
    return { status: after.state, revision: after.revision, actions: actionsFor(after, ctx), error: after.error || null };
  }

  async function recoverCloudJob(args, ctx) {
    var have = o.ledger.findByJobId(args.job_id);
    if (have) {
      if (!scope.jobVisible(have)) throw fail("DocumentNotAllowed", "Agents read the active document only: this job belongs to another document.");
      return { local_id: have.local_id, status: have.state, revision: have.revision };
    }
    var job = await jobsApi.getJob(o.client, args.job_id);
    if (job.status !== "succeeded") throw invalid("This job is " + (job.status || job.remote_status || "not finished") + " on Scenario; only finished jobs are added.");
    if (!job.asset_ids.length) throw invalid("This job lists no results.");
    var row = o.catalog.find ? o.catalog.find(job.model_id) : null;
    var rec = await o.runner.adopt({ origin: { kind: "agent", client_name: ctx.client_name, session: ctx.session }, lane: "image", model_id: job.model_id, model_name: row ? row.name : null, job_id: job.job_id, asset_ids: job.asset_ids, parameters: job.input && typeof job.input.prompt === "string" ? { prompt: job.input.prompt } : {}, cu_charged: job.cu_cost === null ? null : price.exactString(price.toThousandths(job.cu_cost)), created_at: job.created_at });
    record(ctx, "Added a cloud job", null);
    return { local_id: rec.local_id, status: rec.state, revision: rec.revision };
  }

  // ---- library ----

  // Images of the current project, without the plugin's own uploads.
  function ownUploads() {
    var ids = {};
    var list = o.ledger.all();
    for (var i = 0; i < list.length; i++) {
      var a = (list[i].inputs && list[i].inputs.asset_ids) || [];
      for (var k = 0; k < a.length; k++) ids[a[k]] = true;
    }
    var up = o.inputs.uploadedAssetIds();
    for (var j = 0; j < up.length; j++) ids[up[j]] = true;
    return ids;
  }

  // Results of jobs that belong to another document, under read scope.
  function hiddenByScope() {
    var ids = {};
    if (!o.settings.switches().active_document_only) return ids;
    var list = o.ledger.all();
    for (var i = 0; i < list.length; i++) {
      if (scope.jobVisible(list[i])) continue;
      var outs = list[i].outputs || [];
      for (var k = 0; k < outs.length; k++) ids[outs[k].asset_id] = true;
      var ins = (list[i].inputs && list[i].inputs.asset_ids) || [];
      for (var n = 0; n < ins.length; n++) ids[ins[n]] = true;
    }
    return ids;
  }

  function assetRow(a) {
    var m = a.metadata || {};
    var name = typeof a.name === "string" ? a.name : typeof m.name === "string" ? m.name : null;
    return { asset_id: a.id, name: name, width: typeof m.width === "number" ? m.width : null, height: typeof m.height === "number" ? m.height : null, created_at: a.createdAt || null };
  }

  function keepAsset(a, skip) {
    if (!a || typeof a.id !== "string" || skip[a.id]) return false;
    var kind = a.kind || (a.metadata && a.metadata.kind);
    if (kind && kind !== "image") return false;
    var name = typeof a.name === "string" ? a.name : a.metadata && typeof a.metadata.name === "string" ? a.metadata.name : "";
    if (/^photoshop-(capture|mask|reference)-/.test(name)) return false;
    if (a.metadata && a.metadata.hide === true) return false;
    return true;
  }

  async function assetsPage(query) {
    var res = await o.client.request("GET", "/assets", { query: query });
    var body = res.body && typeof res.body === "object" ? res.body : {};
    return { rows: Array.isArray(body.assets) ? body.assets : [], next: typeof body.nextPaginationToken === "string" && body.nextPaginationToken ? body.nextPaginationToken : null };
  }

  async function listAssets(args) {
    if (!o.account()) throw fail("NotSignedIn", "No Scenario key is saved in the plugin.");
    var limit = limitOf(args.limit, 20, 100);
    var skip = ownUploads();
    var hidden = hiddenByScope();
    for (var h in hidden) skip[h] = true;
    var query = { pageSize: String(Math.min(100, limit * 2)) };
    if (given(args.collection_id)) query.collectionId = String(args.collection_id);
    if (given(args.cursor)) query.paginationToken = String(args.cursor);
    var page = await assetsPage(query);
    var rows = page.rows.filter(function (a) {
      return keepAsset(a, skip);
    });
    return { assets: rows.slice(0, limit).map(assetRow), next_cursor: page.next };
  }

  async function searchAssets(args) {
    if (!o.account()) throw fail("NotSignedIn", "No Scenario key is saved in the plugin.");
    var limit = limitOf(args.limit, 20, 100);
    var words = String(args.query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) throw invalid("query is required.");
    var skip = ownUploads();
    var hidden = hiddenByScope();
    for (var h in hidden) skip[h] = true;
    var out = [];
    var token = null;
    // The newest five pages, matched on name, description and prompt.
    for (var p = 0; p < 5 && out.length < limit; p++) {
      var q = { pageSize: "100" };
      if (token) q.paginationToken = token;
      var page = await assetsPage(q);
      for (var i = 0; i < page.rows.length && out.length < limit; i++) {
        var a = page.rows[i];
        if (!keepAsset(a, skip)) continue;
        var m = a.metadata || {};
        var hay = [a.name, m.name, a.description, m.prompt, m.type].filter(function (x) {
          return typeof x === "string";
        }).join(" ").toLowerCase();
        var hit = words.every(function (w) {
          return hay.indexOf(w) >= 0;
        });
        if (hit) out.push(assetRow(a));
      }
      token = page.next;
      if (!token) break;
    }
    return { assets: out, note: "Search reads the newest 500 assets and can miss others; browse with list_assets to be sure." };
  }

  async function listCollections(args) {
    if (!o.account()) throw fail("NotSignedIn", "No Scenario key is saved in the plugin.");
    var limit = limitOf(args.limit, 20, 100);
    var query = { pageSize: String(limit) };
    if (given(args.cursor)) query.paginationToken = String(args.cursor);
    var res = await o.client.request("GET", "/collections", { query: query });
    var body = res.body && typeof res.body === "object" ? res.body : {};
    var rows = Array.isArray(body.collections) ? body.collections : [];
    return {
      collections: rows.slice(0, limit).map(function (c) {
        return { collection_id: c.id, name: typeof c.name === "string" ? c.name : null, asset_count: typeof c.assetCount === "number" ? c.assetCount : null };
      }),
      next_cursor: typeof body.nextPaginationToken === "string" && body.nextPaginationToken ? body.nextPaginationToken : null
    };
  }

  async function listGenerations(args) {
    if (!o.account()) throw fail("NotSignedIn", "No Scenario key is saved in the plugin.");
    var limit = limitOf(args.limit, 20, 100);
    var page = await jobsApi.listJobs(o.client, { created_after: args.created_after || null, page_token: args.cursor || null, page_size: limit });
    var hidden = hiddenByScope();
    var rows = page.jobs
      .filter(function (j) {
        return !j.asset_ids.some(function (a) {
          return hidden[a];
        });
      })
      .map(function (j) {
        var r = { job_id: j.job_id, status: j.status || j.remote_status, created_at: j.created_at, asset_ids: j.asset_ids };
        if (j.model_id) r.model_id = j.model_id;
        return r;
      });
    return { jobs: rows, next_cursor: page.next };
  }

  async function recommendModels(args) {
    var lane = args.lane;
    var limit = limitOf(args.limit, 5, 20);
    var listed = await o.catalogTools.list_models({ lane: lane, limit: 40, source: "catalog" });
    var byId = {};
    for (var i = 0; i < listed.models.length; i++) byId[listed.models[i].model_id] = listed.models[i];
    var out = [];
    var source = "plugin defaults";
    if (CAPABILITY[lane] && o.account()) {
      try {
        var res = await o.client.request("GET", "/recommendations/models", { query: { capabilities: CAPABILITY[lane], limit: String(Math.min(20, limit * 3)) } });
        var rows = res.body && Array.isArray(res.body.models) ? res.body.models : [];
        for (var k = 0; k < rows.length && out.length < limit; k++) {
          var row = byId[rows[k].id];
          if (!row) continue;
          var copy = JSON.parse(JSON.stringify(row));
          copy.reason = "Scenario recommends it for " + (lane === "image" ? "text to image" : "image to image") + ".";
          out.push(copy);
        }
        if (out.length) source = "scenario";
      } catch (e) {
        log("agents: recommendations unavailable (" + ((e && e.type) || "error") + ")");
      }
    }
    if (!out.length) {
      var def = common.defaultModel(lane);
      var picks = listed.models.slice();
      picks.sort(function (a, b) {
        return (a.model_id === def ? -1 : 0) - (b.model_id === def ? -1 : 0);
      });
      for (var p = 0; p < picks.length && out.length < limit; p++) {
        var c2 = JSON.parse(JSON.stringify(picks[p]));
        c2.reason = picks[p].model_id === def ? "The plugin's default for this lane." : "A plugin pick for this lane.";
        out.push(c2);
      }
    }
    return { models: out, source: source };
  }

  // ---- previews of results ----

  async function readResult(path, maxPx) {
    var bytes = await o.host.readDataBinary(path);
    if (!bytes) return null;
    if (png.isPng(bytes)) {
      var img = inflate.decodePng(bytes);
      if (img.components === 2) {
        var ga = new Uint8Array(img.width * img.height * 4);
        for (var i = 0; i < img.width * img.height; i++) {
          ga[i * 4] = ga[i * 4 + 1] = ga[i * 4 + 2] = img.data[i * 2];
          ga[i * 4 + 3] = img.data[i * 2 + 1];
        }
        img = { width: img.width, height: img.height, components: 4, data: ga };
      } else if (img.components === 1) {
        var g3 = new Uint8Array(img.width * img.height * 3);
        for (var j = 0; j < img.width * img.height; j++) g3[j * 3] = g3[j * 3 + 1] = g3[j * 3 + 2] = img.data[j];
        img = { width: img.width, height: img.height, components: 3, data: g3 };
      }
      return { img: img, bytes: null };
    }
    if (jpeg.isJpeg(bytes)) return { img: null, bytes: bytes, info: jpeg.jpegInfo(bytes) };
    return null;
  }

  function flatten(img) {
    if (img.components === 3) return img;
    var n = img.width * img.height;
    var out = new Uint8Array(n * 3);
    for (var i = 0; i < n; i++) {
      var a = img.data[i * 4 + 3] / 255;
      for (var c = 0; c < 3; c++) out[i * 3 + c] = Math.round(img.data[i * 4 + c] * a + 128 * (1 - a));
    }
    return { width: img.width, height: img.height, components: 3, data: out };
  }

  async function inspectResultPreviews(args, ctx) {
    var rec = jobFor(args);
    var maxPx = given(args.max_px) ? args.max_px : 512;
    if (!(maxPx >= 64 && maxPx <= 1024)) throw invalid("max_px must be 64 to 1024.");
    if (rec.state === "download_failed" && !rec.download_error_type) o.runner.resumeDownload(rec.local_id);
    var deadline = now() + 60000;
    while (["succeeded", "downloading", "download_failed"].indexOf(o.ledger.get(rec.local_id).state) >= 0 && now() < deadline && !(o.ledger.get(rec.local_id).state === "download_failed" && o.ledger.get(rec.local_id).download_error_type)) {
      await new Promise(function (r) {
        o.timers.setTimeout(r, 250);
      });
      if (o.ledger.get(rec.local_id).state === "download_failed") break;
    }
    rec = o.ledger.get(rec.local_id);
    var outs = rec.outputs || [];
    var want = Array.isArray(args.takes) && args.takes.length ? args.takes : outs.map(function (x, i) {
      return i + 1;
    });
    var memo = o.runner.memoFor(rec.local_id) || {};
    var t = rec.target || {};
    var images = [];
    var takes = [];
    for (var w = 0; w < want.length; w++) {
      var n = want[w];
      var out = outs[n - 1];
      if (!out) throw invalid("This job has " + outs.length + " take(s).");
      var row = { take: n, asset_id: out.asset_id, aspect_ok: null, edited: null, seam_bias: null, seam_residual: null, seam_ok: null, polarity_suspect: null, shift_px: null, badges: null, note: null };
      if (out.state !== "saved" || !out.path) {
        row.note = "Not downloaded yet (" + rec.state + ").";
        takes.push(row);
        continue;
      }
      var r = await readResult(out.path, maxPx);
      if (!r) {
        row.note = "The saved file could not be read.";
        takes.push(row);
        continue;
      }
      var W = r.img ? r.img.width : r.info.width;
      var H = r.img ? r.img.height : r.info.height;
      if (t.upload) row.aspect_ok = Math.abs(W / H - t.upload[0] / t.upload[1]) <= 0.01 * (t.upload[0] / t.upload[1]);
      else if (t.box) row.aspect_ok = Math.abs(W / H - t.box[2] / t.box[3]) <= 0.01 * (t.box[2] / t.box[3]);
      if (r.img) {
        var flat = flatten(r.img.components === 4 ? r.img : r.img);
        var s = pixels.fitLong(W, H, maxPx);
        var small = s.width === W && s.height === H ? flat : pixels.resize(flat, s.width, s.height);
        images.push({ data: b64.encodeStandard(await o.host.encodeJpeg(small)), mimeType: "image/jpeg" });
        var ck = memo.check;
        if (rec.lane === "edit" && ck && t.box) {
          var box = { left: t.box[0], top: t.box[1], width: t.box[2], height: t.box[3] };
          var sx = W / box.width;
          var sy = H / box.height;
          var region = { left: (ck.region.left - box.left) * sx, top: (ck.region.top - box.top) * sy, width: ck.region.width * sx, height: ck.region.height * sy };
          var res = pixels.sampleRegion(flat, { x: 0, y: 0 }, region, ck.width, ck.height, "clamp");
          var c = checksMod.check({ context: ck.context, result: res, mask: ck.mask, scale: ck.scale, shaped: t.upload ? { width: t.upload[0], height: t.upload[1] } : null, result_size: { width: W, height: H }, masked: true, cleared: t.expect === "cleared" });
          row.edited = c.edited;
          row.polarity_suspect = c.polarity_suspect;
          row.seam_bias = c.seam ? c.seam.bias : null;
          row.seam_residual = c.seam ? c.seam.residual : null;
          row.seam_ok = c.seam_ok;
          // shift_px tells a misaligned take from one the model redrew
          // around the edit; badges are the takes card's words for both.
          row.shift_px = typeof c.shift_px === "number" ? Math.round(c.shift_px * 10) / 10 : null;
          row.badges = checksMod.badges(c, null, { masked: true });
        } else if (rec.lane === "expand") {
          row.note = "The Expand seam check runs at placement.";
        }
      } else if (r.bytes.length <= 1500000) {
        images.push({ data: b64.encodeStandard(r.bytes), mimeType: "image/jpeg" });
        row.note = "JPEG result shown at its saved size.";
      } else {
        row.note = "JPEG result too large to preview here; place it and use preview_document.";
      }
      takes.push(row);
    }
    record(ctx, "Read result previews", null);
    return { local_id: rec.local_id, takes: takes, _images: images };
  }

  // ---- document ----

  function documentSummary(args) {
    var docId = scope.readDoc(args.document_id);
    var limit = given(args.layer_limit) ? args.layer_limit : 200;
    if (!(limit >= 1 && limit <= 1000)) throw invalid("layer_limit must be 1 to 1000.");
    return o.ps.summary(docId, limit, cursorOf(args.cursor));
  }

  function layerDetail(args) {
    var docId = scope.readDoc(args.document_id);
    return o.ps.layerDetail(docId, args.layer_id);
  }

  async function previewDocument(args, ctx) {
    var docId = scope.readDoc(args.document_id);
    var source = args.source || "all_visible";
    if (source !== "all_visible" && source !== "layer") throw invalid("source must be all_visible or layer.");
    if (source === "layer" && !given(args.layer_id)) throw invalid("source layer needs layer_id.");
    var maxPx = given(args.max_px) ? args.max_px : 1024;
    if (!(maxPx >= 64 && maxPx <= 1600)) throw invalid("max_px must be 64 to 1600.");
    var p = await o.ps.preview(docId, { layer_id: source === "layer" ? args.layer_id : null, box: args.box || null, max_px: maxPx, show_selection: !!args.show_selection });
    record(ctx, "Read a preview", (p.width + " x " + p.height));
    return { width: p.width, height: p.height, scale: p.scale, box: p.box, _images: [{ data: p.data, mimeType: "image/jpeg" }] };
  }

  async function selectLayers(args, ctx) {
    modifyOn();
    var docId = scope.changeDoc(args.document_id);
    var mode = args.mode || "replace";
    if (mode !== "replace" && mode !== "add") throw invalid("mode must be replace or add.");
    if (!Array.isArray(args.layer_ids) || !args.layer_ids.length) throw invalid("layer_ids is a non-empty list.");
    var ids = await o.ps.selectLayers(docId, args.layer_ids, mode);
    record(ctx, "Selected layers", String(args.layer_ids.length));
    return { active_layer_ids: ids };
  }

  async function setSelection(args, ctx) {
    modifyOn();
    var docId = scope.changeDoc(args.document_id);
    var forms = ["rect", "ellipse", "layer_transparency", "subject", "none"].filter(function (k) {
      return given(args[k]) && args[k] !== false;
    });
    if (forms.length !== 1) throw invalid("Pass exactly one of rect, ellipse, layer_transparency, subject or none.");
    var mode = args.mode || "replace";
    if (["replace", "add", "subtract", "intersect"].indexOf(mode) < 0) throw invalid("mode must be replace, add, subtract or intersect.");
    var shape = args.rect || args.ellipse;
    if (shape && (!Array.isArray(shape) || shape.length !== 4 || shape[2] <= 0 || shape[3] <= 0)) throw invalid("rect and ellipse are [x, y, width, height].");
    var sel = await o.ps.setSelection(docId, { rect: args.rect, ellipse: args.ellipse, layer_transparency: args.layer_transparency, subject: args.subject, none: !!args.none, feather: args.feather || 0, mode: mode });
    record(ctx, "Changed the selection", forms[0]);
    return { selection: sel, history_state: "Scenario agent: Select" };
  }

  async function removeScenarioLayers(args, ctx) {
    modifyOn();
    var docId = scope.changeDoc(args.document_id);
    if (!Array.isArray(args.layer_ids) || !args.layer_ids.length) throw invalid("layer_ids is a non-empty list.");
    var removed = await o.ps.removeScenarioLayers(docId, args.layer_ids);
    record(ctx, "Removed Scenario layers", String(removed.length));
    return { removed: removed, history_state: "Scenario agent: Remove layers" };
  }

  // execute_batchplay: file paths must be files of a capture recorded for
  // this document in this Photoshop session (SPEC 6.6 item 4).
  async function filePaths(descriptors, docId) {
    var found = [];
    (function walk(v) {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        for (var k in v) {
          if (k === "_path" && typeof v[k] === "string") found.push(v[k]);
          else walk(v[k]);
        }
      }
    })(descriptors);
    var files = {};
    for (var i = 0; i < found.length; i++) {
      var p = found[i];
      var m = /^captures\/(cap-[A-Za-z0-9-]{1,64})\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(p);
      if (!m || /\.\./.test(p)) continue;
      var meta = null;
      try {
        meta = JSON.parse((await o.host.readDataText("captures/" + m[1] + "/capture.json")) || "null");
      } catch (e) {
        meta = null;
      }
      if (!meta || meta.document_id !== docId || meta.session !== o.session || m[2] === "capture.json") continue;
      var I = o.host.internals();
      if (I.fs && typeof I.fs.lstat === "function") {
        try {
          var st = await I.fs.lstat(I.dataUrl(p));
          if (st && typeof st.isSymbolicLink === "function" && st.isSymbolicLink()) continue;
        } catch (e) {
          continue;
        }
      }
      try {
        files[p] = await I.sessionToken(p);
      } catch (e) {
        log("agents: no session token for a capture file");
      }
    }
    return files;
  }

  async function executeBatchplay(args, ctx) {
    modifyOn();
    switchOn("agents_may_run_commands", "Agents may run Photoshop commands");
    var docId = scope.changeDoc(args.document_id);
    var label = String(args.label || "Commands").replace(/[\r\n]+/g, " ").slice(0, 60);
    var files = await filePaths(args.descriptors, docId);
    try {
      var r = await o.ps.runBatchPlay(docId, args.descriptors, label, files);
      record(ctx, "Ran Photoshop commands", label + " (" + args.descriptors.length + ")");
      return { outcome: "committed", history_state: r.history_state, results: r.results, truncated: r.truncated };
    } catch (e) {
      if (e && (e.type === "CommandRefused" || e.type === "DocumentNotActive" || e.type === "DocumentClosed" || e.type === "PhotoshopBusy")) {
        if (e.type === "CommandRefused") record(ctx, "Command refused", e.message);
        throw e;
      }
      if (e && e.busy) throw fail("PhotoshopBusy", "Photoshop is busy: another plugin, a dialog or the person holds its modal state. Try again in a moment.");
      record(ctx, "Commands rolled back", label);
      return { outcome: "rolled_back", history_state: null, results: [], truncated: false, error: "Photoshop refused a command: " + ((e && e.message) || e) + ". Nothing changed." };
    }
  }

  // ---- placing results ----

  var PURPOSES = ["new_layer", "edit_selection", "expand", "cutout_mask", "new_document"];

  function newApplicationId() {
    appSeq++;
    var b = o.random.bytes(8);
    var h = "";
    for (var i = 0; i < b.length; i++) h += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return "app_" + h + appSeq;
  }

  async function prepareResultApplication(args, ctx) {
    var purpose = args.purpose || "new_layer";
    if (PURPOSES.indexOf(purpose) < 0) throw invalid("purpose must be one of: " + PURPOSES.join(", ") + ".");
    if (given(args.local_id) === given(args.library_asset_id)) throw invalid("Pass one of local_id or library_asset_id.");
    var rec;
    var warnings = [];
    var unmasked = false;
    if (given(args.library_asset_id)) {
      if (!assetsMod.validAssetId(args.library_asset_id)) throw invalid("Not a Scenario asset id.");
      if (purpose !== "new_layer" && purpose !== "new_document") throw invalid("Library assets land with new_layer or new_document.");
      if (hiddenByScope()[args.library_asset_id]) throw fail("DocumentNotAllowed", "Agents read the active document only: this asset belongs to another document's job.");
      var known = null;
      var all = o.ledger.all();
      for (var i = 0; i < all.length && !known; i++) if (all[i].lane === "library" && all[i].outputs && all[i].outputs[0] && all[i].outputs[0].asset_id === args.library_asset_id && ["ready", "applied", "succeeded", "downloading"].indexOf(all[i].state) >= 0) known = all[i];
      rec = known || (await o.runner.adopt({ origin: { kind: "agent", client_name: ctx.client_name, session: ctx.session }, lane: "library", asset_ids: [args.library_asset_id], adopted: "library" }));
      warnings.push("The asset downloads first; apply waits for it.");
    } else {
      rec = jobFor({ local_id: args.local_id });
      if (given(args.expected_revision) && args.expected_revision !== rec.revision) throw invalid("expected_revision is " + rec.revision + ": the job changed. Read job_status again.");
      if (["ready", "applied", "apply_failed"].indexOf(rec.state) < 0) throw invalid("This job is " + rec.state + "; results can be placed once it is ready.");
      if (purpose === "edit_selection" && (rec.lane !== "edit" || !rec.target || !rec.target.box)) throw invalid("edit_selection needs a job made from a capture_id in the edit lane.");
      if (purpose === "expand" && (!rec.target || rec.target.kind !== "expand")) throw invalid("expand needs a job made from an expand capture.");
      if (purpose === "cutout_mask" && rec.lane !== "remove_background") throw invalid("cutout_mask needs a Remove BG job.");
    }
    var t = args.target || {};
    var outs = rec.outputs || [];
    var assets = null;
    if (given(args.asset_id)) {
      if (!outs.some(function (x) {
        return x.asset_id === args.asset_id;
      })) throw invalid("asset_id is not a result of this job.");
      assets = [args.asset_id];
    } else if (Array.isArray(args.takes) && args.takes.length) {
      assets = args.takes.map(function (n) {
        if (!outs[n - 1]) throw invalid("This job has " + outs.length + " take(s).");
        return outs[n - 1].asset_id;
      });
    }
    var fit = t.fit || (rec.lane === "library" ? "native" : "cover");
    if (["exact", "contain", "cover", "native"].indexOf(fit) < 0) throw invalid("fit must be exact, contain, cover or native.");
    var docId = null;
    var docTitle = null;
    var opts = { assets: assets };
    if (purpose === "new_document") {
      opts.new_document = true;
    } else {
      docId = given(t.document_id) ? scope.readDoc(t.document_id) : null;
      var home = rec.target && given(rec.target.document_id) ? o.runner.docOf(rec) : null;
      if (!docId) docId = home ? home.id : scope.readDoc(null);
      if (home && home.id !== docId && purpose !== "new_layer") throw invalid("This result lands in the document it was made from.");
      if (!home && rec.target && given(rec.target.document_id) && (purpose === "edit_selection" || purpose === "expand" || purpose === "cutout_mask")) throw fail("DocumentClosed", "The document this result was made from is not open. Open it to land the result there, or open the result with new_document.");
      if (!home || home.id !== docId || rec.lane === "library") opts.current_document = true;
      if (purpose === "new_layer" && fit !== "cover") opts.fit = "box";
      if (given(t.box)) {
        if (!Array.isArray(t.box) || t.box.length !== 4) throw invalid("target.box is [x, y, width, height].");
        opts.box = { left: t.box[0], top: t.box[1], width: t.box[2], height: t.box[3] };
      }
      var docs = o.host.listDocuments();
      for (var d = 0; d < docs.length; d++) if (docs[d].id === docId) docTitle = docs[d].title;
      // The canvas must not have changed since the capture.
      if (purpose === "edit_selection" || purpose === "expand" || purpose === "cutout_mask") {
        var size = o.host.documentSize(docId);
        var cv = rec.target.canvas;
        if (cv && size && (size.width !== cv[0] || size.height !== cv[1])) throw fail("DocumentChanged", "The canvas changed since the capture. Capture again, or open the result with new_document.");
      }
      if (purpose === "edit_selection" && rec.outputs && rec.outputs[0] && rec.outputs[0].width && rec.target.upload) {
        var o0 = rec.outputs[0];
        if (Math.abs(o0.width / o0.height - rec.target.upload[0] / rec.target.upload[1]) > 0.01 * (rec.target.upload[0] / rec.target.upload[1])) warnings.push("may_be_misaligned");
      }
      // The selection mask lives in memory: after a panel reload or a
      // Photoshop restart the edit lands unmasked over the capture box.
      if (purpose === "edit_selection" && rec.target.kind === "selection" && !(o.runner.memoFor(rec.local_id) || {}).placement_mask) {
        unmasked = true;
        warnings.push("lands_unmasked");
      }
    }
    var kind = planMod.kindOf(rec.lane);
    var history = (planMod.HISTORY[kind] || "Scenario: Place " + kind).replace(/^Scenario: /, "Scenario agent: ");
    var n = assets ? assets.length : outs.length || 1;
    var will = purpose === "new_document" ? ["a new document"] : purpose === "cutout_mask" ? ["a layer mask from the cutout (or a cutout layer when the layer cannot take one)"] : purpose === "expand" ? ["a larger canvas", "a masked smart object"] : n > 1 ? ["a group of " + n + " takes (smart objects)"] : ["one smart object layer"];
    var id = newApplicationId();
    applications[id] = { id: id, local_id: rec.local_id, purpose: purpose, opts: opts, native: fit === "native" && purpose === "new_layer", document_id: docId, created_at: now(), used: false, session: ctx.session, client_name: ctx.client_name, history: history, canvas: docId ? o.host.documentSize(docId) : null };
    var where = purpose === "new_document" ? "a new document" : '"' + (docTitle || "the document") + '"' + (opts.box ? " at " + [opts.box.left, opts.box.top, opts.box.width, opts.box.height].join(", ") : rec.target && rec.target.box && !opts.current_document ? " over the capture box " + rec.target.box.join(", ") : " over the canvas");
    return {
      application_id: id,
      review: "Places " + n + " take" + (n > 1 ? "s" : "") + " of " + (rec.model_name || rec.lane) + " into " + where + " as " + will.join(" and ") + ", in one History state \"" + history + "\"." + (unmasked ? " Unmasked: the selection mask is gone after a panel reload or a Photoshop restart, so the take covers the whole capture box." : ""),
      target: { document_id: docId, purpose: purpose, fit: fit, box: opts.box ? [opts.box.left, opts.box.top, opts.box.width, opts.box.height] : rec.target && rec.target.box ? rec.target.box : null },
      checks: null,
      will_create: will,
      warnings: warnings,
      requires_approval: !o.settings.switches().agents_may_modify
    };
  }

  async function waitReady(localId) {
    var deadline = now() + 90000;
    while (now() < deadline) {
      var r = o.ledger.get(localId);
      if (!r || ["ready", "applied", "apply_failed", "download_failed"].indexOf(r.state) >= 0 || ledgerMod.FINAL.indexOf(r.state) >= 0) return r;
      await new Promise(function (res) {
        o.timers.setTimeout(res, 250);
      });
    }
    return o.ledger.get(localId);
  }

  async function setApplication(localId, app) {
    try {
      await o.ledger.update(localId, { application: app });
    } catch (e) {
      log("agents: application state not saved");
    }
  }

  async function runApplication(a) {
    var rec = await waitReady(a.local_id);
    if (!rec || ["ready", "applied", "apply_failed"].indexOf(rec.state) < 0) throw invalid("The result is not downloaded (" + (rec ? rec.state : "gone") + ").");
    // native: the result's own size, centered, contained when larger,
    // never enlarged.
    if (a.native && !a.opts.box && a.document_id !== null) {
      var first = (rec.outputs || [])[0] || {};
      var size = o.host.documentSize(a.document_id);
      if (first.width && size) {
        var k = Math.min(1, size.width / first.width, size.height / first.height);
        var w = first.width * k;
        var h = first.height * k;
        a.opts.box = { left: (size.width - w) / 2, top: (size.height - h) / 2, width: w, height: h };
        a.opts.fit = "box";
      }
    }
    try {
      var done = await o.runner.place(a.local_id, a.opts);
      var pl = done.placement || {};
      var app = { state: "committed", history_state: pl.history || a.history, layer_ids: pl.layer_ids || [] };
      await setApplication(a.local_id, app);
      return {
        outcome: "committed",
        layer_ids: pl.layer_ids || [],
        group_id: pl.group_id || null,
        names: null,
        history_state: pl.history || a.history,
        outside_check: pl.verify ? { max_diff: pl.verify.outside_max, untouched: pl.verify.untouched } : null,
        notes: pl.notes || []
      };
    } catch (e) {
      if (e && (e.type === "DocumentNotActive" || e.type === "DocumentClosed")) throw e;
      if (e && e.canvasChanged) throw fail("DocumentChanged", "The canvas changed since the capture.");
      if (e && e.busy) throw fail("PhotoshopBusy", "Photoshop is busy: another plugin, a dialog or the person holds its modal state. Try again in a moment.");
      await setApplication(a.local_id, { state: "rolled_back", history_state: null, layer_ids: [] });
      return { outcome: "rolled_back", layer_ids: [], group_id: null, names: null, history_state: null, outside_check: null, error: "Place failed: " + ((e && e.message) || e) };
    }
  }

  function proposalCard(a, ctx) {
    var rec = o.ledger.get(a.local_id);
    var title = null;
    if (a.document_id !== null) {
      var docs = o.host.listDocuments();
      for (var i = 0; i < docs.length; i++) if (docs[i].id === a.document_id) title = docs[i].title;
    }
    o.approvals.add({
      kind: "proposal",
      session: ctx.session,
      client_name: ctx.client_name,
      title: ctx.client_name + " proposes a change",
      lines: [(rec.model_name || rec.lane) + " result into " + (a.document_id === null ? "a new document" : '"' + (title || "the document") + '"'), "History: " + a.history],
      approve_label: "Apply",
      decline_label: "Dismiss",
      data: { local_id: a.local_id, application_id: a.id, document_id: a.document_id, asset_id: (a.opts.assets || [])[0] || ((rec.outputs || [])[0] || {}).asset_id || null },
      disabled: function () {
        return a.document_id !== null && o.host.activeDocumentId() !== a.document_id ? "Bring the document to the front to apply." : null;
      },
      onApprove: async function () {
        if (a.document_id !== null && o.host.activeDocumentId() !== a.document_id) throw fail("DocumentNotActive", "Bring the document to the front to apply.");
        var r = await runApplication(a);
        record(ctx, r.outcome === "committed" ? "Proposal applied" : "Proposal rolled back", a.history);
        return r;
      },
      onDecline: function (why) {
        record(ctx, why === "declined" ? "Proposal dismissed" : "Proposal expired", a.history);
        return setApplication(a.local_id, { state: why === "declined" ? "dismissed" : "expired", history_state: null, layer_ids: [] });
      }
    });
  }

  async function applyResultApplication(args, ctx) {
    var a = has(applications, args.application_id) ? applications[args.application_id] : null;
    if (!a) throw fail("ApplicationExpired", "No such application_id in this Photoshop session. Call prepare_result_application again.");
    if (a.used) throw fail("ApplicationUsed", "This application_id was already applied.");
    if (now() - a.created_at >= APPLICATION_TTL_MS) throw fail("ApplicationExpired", "This application_id is older than 10 minutes. Call prepare_result_application again.");
    var rec = o.ledger.get(a.local_id);
    if (!rec || !scope.jobVisible(rec)) throw fail("DocumentNotAllowed", "Agents read the active document only.");
    if (!o.settings.switches().agents_may_modify) {
      a.used = true;
      await setApplication(a.local_id, { state: "pending_approval", history_state: null, layer_ids: [] });
      proposalCard(a, ctx);
      record(ctx, "Proposed a change", a.history);
      return { outcome: "pending_approval", layer_ids: [], group_id: null, names: null, history_state: null, outside_check: null };
    }
    if (a.document_id !== null) scope.changeDoc(a.document_id);
    a.used = true;
    var r;
    try {
      r = await runApplication(a);
    } catch (e) {
      // Thrown before anything was placed (busy, not active, canvas
      // changed): the same application_id can be applied again.
      a.used = false;
      throw e;
    }
    record(ctx, r.outcome === "committed" ? "Placed a result" : "Placement rolled back", a.history);
    return r;
  }

  // A proposal card expires when its document's canvas changes.
  function documentChanged() {
    o.approvals.expire(function (c) {
      if (c.kind !== "proposal") return false;
      var a = applications[c.data.application_id];
      if (!a || a.document_id === null || !a.canvas) return false;
      var size = o.host.documentSize(a.document_id);
      return !size || size.width !== a.canvas.width || size.height !== a.canvas.height;
    }, "expired");
  }

  // ---- the handlers ----

  function estimateCost(args, ctx) {
    return o.catalogTools.estimate_cost(args, ctx);
  }

  return {
    handlers: {
      document_summary: documentSummary,
      layer_detail: layerDetail,
      preview_document: previewDocument,
      recommend_models: recommendModels,
      estimate_cost: estimateCost,
      job_status: jobStatus,
      wait_for_job: waitForJob,
      list_local_jobs: listLocalJobs,
      list_generations: listGenerations,
      list_assets: listAssets,
      search_assets: searchAssets,
      list_collections: listCollections,
      inspect_result_previews: inspectResultPreviews,
      capture_reference: function (args, ctx) {
        return o.inputs.captureReference(args, ctx);
      },
      upload_reference: function (args, ctx) {
        return o.inputs.uploadReference(args, ctx);
      },
      reference_upload_status: function (args, ctx) {
        return o.inputs.referenceStatus(args, ctx);
      },
      generate: generate,
      recover_local_job: recoverLocalJob,
      recover_cloud_job: recoverCloudJob,
      cancel_prepared_job: cancelPreparedJob,
      prepare_result_application: prepareResultApplication,
      apply_result_application: applyResultApplication,
      select_layers: selectLayers,
      set_selection: setSelection,
      remove_scenario_layers: removeScenarioLayers,
      execute_batchplay: executeBatchplay
    },
    scope: scope,
    onQuote: onQuote,
    documentChanged: documentChanged,
    // SPEC 2.6: what a session held ends with it.
    endSessions: function (ids) {
      o.inputs.endSessions(ids);
      return o.approvals.endSessions(ids);
    },
    // Photoshop quit or the plugin unloads: the commands switch is not saved.
    _applications: applications,
    _quotes: quoteCtx
  };
}

module.exports = { createAgentTools: createAgentTools, STOP_STATES: STOP_STATES };
