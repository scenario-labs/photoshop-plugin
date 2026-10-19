"use strict";
// What the Jobs view shows and can do (SPEC 3.11, wireframes 11 and 12), as
// plain data built from the ledger and the runner. No DOM here: the panel
// (plugin/src/ui/) draws it, and the tests read it under Node.
//
//   list(filter)   filter: "all" | "attention" | "agents" | "document".
//                  { filter, rows, counts, document, empty }
//   row(rec)       one row: title, status, tone, price words, origin, time,
//                  thumbnail, detail, placement target, actions
//   header()       the Jobs icon's badge and tooltip
//   resolveView(id) the "Resolve unknown job" screen
//   details(id)    the Details screen
//   act(id, name, arg) runs a row or resolve action; resolves the runner's
//                  answer (copy_error and details resolve their data)
//   onChange(fn)   called when a record, a wait or a check changes
//
// Every action carries `enabled` and, when off, the `reason` to show.

var enums = require("../../../shared/enums.json");
var API = require("../../../shared/scenario-api.json");
var charges = require("./charges.js");
var slugMod = require("../util/slug.js");

var LABELS = {};
for (var i = 0; i < enums.job_status.length; i++) LABELS[enums.job_status[i].value] = enums.job_status[i].label;

var KIND_NAMES = { image: "Image", edit: "Edit", upscale: "Upscale", expand: "Expand", remove_background: "Remove BG" };
var FILTERS = ["all", "attention", "agents", "document"];
var RUNNING = ["uploading_inputs", "submitting", "queued", "generating", "cancel_requested", "succeeded", "downloading", "applying"];
var ATTENTION = ["awaiting_approval", "uncertain", "download_failed", "apply_failed"];
var ERRORS = ["failed", "blocked"];

var ACTION_LABELS = {
  cancel_upload: "Cancel",
  approve: "Approve",
  decline: "Decline",
  details: "Details",
  stop_download: "Stop download",
  resume: "Resume download",
  open_on_scenario: "Open on Scenario",
  place: "Place",
  place_current: "Place in current document",
  open: "Open as document",
  copy_error: "Copy error",
  resolve: "Resolve",
  check: "Check again",
  link: "Link this job",
  mark_not_sent: "Mark not sent"
};

var TEXT = {
  empty: "Jobs you start here or from an agent appear here. Jobs from another Photoshop version are on the On Scenario tab.",
  unknown_help: "The request may or may not have reached Scenario. Nothing is retried until you decide.",
  recovered: "Picked up again after Photoshop restarted.",
  no_match: "No job on Scenario matches this request. You can mark it not sent.",
  match: "A job on Scenario matches this request exactly: it ran and was charged. Link it to keep its result.",
  some: "Jobs on Scenario around that time, none with the same inputs. Link one only if you know it is this request.",
  checking: "Checking Scenario's jobs around that time..."
};

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function timeOf(iso, seconds) {
  var t = Date.parse(iso);
  if (isNaN(t)) return "";
  var d = new Date(t);
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + (seconds ? ":" + pad(d.getSeconds()) : "");
}

function statusLabel(state) {
  return LABELS[state] || state;
}

function title(rec) {
  var kind = KIND_NAMES[rec.lane] || "Image";
  var slug = slugMod.slug(rec.parameters && rec.parameters.prompt);
  return slug ? kind + ' "' + slug + '"' : kind;
}

function origin(rec) {
  if (rec.origin && rec.origin.kind === "agent") return String(rec.origin.client_name || "Agent client");
  return "You";
}

function tone(state) {
  if (RUNNING.indexOf(state) >= 0) return "running";
  if (ATTENTION.indexOf(state) >= 0) return "attention";
  if (ERRORS.indexOf(state) >= 0) return "error";
  if (state === "ready" || state === "applied") return "done";
  return "neutral";
}

function priceKindWords(rec, cu) {
  if (!cu) return "";
  if (rec.price_kind === "range" && rec.cu_quoted_max) return cu + " to " + rec.cu_quoted_max + " CU";
  if (rec.price_kind === "from") return "from " + cu + " CU";
  return cu + " CU";
}

// o: { ledger, runner, host, session, now, openLink(name), copyText(text) }
function createJobsModel(o) {
  var listeners = [];

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i]();
      } catch (e) {
        // a view that fails to draw does not stop the others
      }
    }
  }
  if (o.ledger && typeof o.ledger.onChange === "function") o.ledger.onChange(emit);
  if (o.runner && typeof o.runner.onEvent === "function") o.runner.onEvent(emit);

  function where(rec) {
    return o.runner && typeof o.runner.whereFor === "function" ? o.runner.whereFor(rec) : { kind: "closed", document_id: null, title: null };
  }

  function activeId() {
    var a = o.host && typeof o.host.activeDocumentId === "function" ? o.host.activeDocumentId() : null;
    return a === undefined ? null : a;
  }

  function landsInOwnDocument(rec) {
    var t = rec.target || {};
    return t.kind === "expand" || t.kind === "cutout";
  }

  function placeActions(rec) {
    var w = where(rec);
    var name = w.title ? '"' + w.title + '"' : "its document";
    var out = [];
    if (w.kind === "new_document" || w.kind === "active") out.push({ name: "place", enabled: true });
    else if (w.kind === "open") out.push({ name: "place", enabled: false, reason: "Bring " + name + " to the front to place it there." });
    else out.push({ name: "place", enabled: false, reason: w.unsaved ? "Its document was never saved, so it closed with Photoshop." : "Open " + name + " to place it there." });
    if ((w.kind === "open" || w.kind === "closed") && !landsInOwnDocument(rec)) {
      var active = activeId();
      out.push(active === null ? { name: "place_current", enabled: false, reason: "No document is open." } : { name: "place_current", enabled: true });
    }
    out.push({ name: "open", enabled: true });
    return out;
  }

  function actionsFor(rec) {
    var running = o.runner && typeof o.runner.isDownloading === "function" ? o.runner.isDownloading(rec.local_id) : false;
    switch (rec.state) {
      case "uploading_inputs":
        return [{ name: "cancel_upload", enabled: true }];
      case "awaiting_approval":
        return [
          { name: "decline", enabled: true },
          { name: "approve", enabled: true, label: "Approve (" + priceKindWords(rec, rec.cu_quoted_new || rec.cu_quoted) + ")" }
        ];
      case "queued":
      case "generating":
      case "cancel_requested":
        return [{ name: "details", enabled: true }];
      case "succeeded":
      case "downloading":
        return [running ? { name: "stop_download", enabled: true } : { name: "stop_download", enabled: false, reason: o.runner && o.runner.waitingFor(rec.local_id) ? o.runner.waitingFor(rec.local_id) : "Starting the download." }, { name: "details", enabled: true }];
      case "download_failed":
        if (rec.download_error_type) return [{ name: "open_on_scenario", enabled: true }, { name: "details", enabled: true }, { name: "copy_error", enabled: true }];
        return [{ name: "resume", enabled: true }, { name: "details", enabled: true }, { name: "copy_error", enabled: true }];
      case "ready":
        return placeActions(rec);
      case "apply_failed":
        return placeActions(rec).concat([{ name: "details", enabled: true }, { name: "copy_error", enabled: true }]);
      case "applied":
        return [{ name: "details", enabled: true }, { name: "open", enabled: true }];
      case "failed":
      case "blocked":
      case "canceled":
      case "not_sent":
        return [{ name: "details", enabled: true }, { name: "copy_error", enabled: true }];
      case "uncertain":
        return [{ name: "resolve", enabled: true }];
      default:
        return [];
    }
  }

  function detailFor(rec, w) {
    var waiting = o.runner && typeof o.runner.waitingFor === "function" ? o.runner.waitingFor(rec.local_id) : null;
    if (waiting) return waiting;
    if (rec.state === "uncertain") return TEXT.unknown_help;
    if ((rec.state === "ready" || rec.state === "apply_failed") && w && (w.kind === "open" || w.kind === "closed")) {
      var name = w.title ? '"' + w.title + '"' : "its document";
      var held = w.kind === "open" ? "Waiting to be placed: bring " + name + " to the front, then Place." : w.unsaved ? "Its document was never saved, so it closed with Photoshop. Place in current document or Open as document." : "Waiting to be placed: open " + name + ", then Place.";
      return rec.state === "apply_failed" && rec.error ? rec.error + " " + held : held;
    }
    if (rec.error) return rec.error;
    if (rec.placement && rec.placement.notes && rec.placement.notes.length) return rec.placement.notes.join(" ");
    if (rec.recovered_from && RUNNING.indexOf(rec.state) >= 0) return TEXT.recovered;
    return "";
  }

  function row(rec) {
    var w = rec.state === "ready" || rec.state === "apply_failed" ? where(rec) : null;
    var outs = rec.outputs || [];
    var saved = outs.filter(function (x) {
      return x && x.state === "saved" && x.path;
    });
    var acts = actionsFor(rec).map(function (a) {
      return { name: a.name, label: a.label || ACTION_LABELS[a.name], enabled: a.enabled !== false, reason: a.enabled === false ? a.reason || null : null };
    });
    var progress = null;
    if (rec.state === "generating" && typeof rec.progress === "number") progress = rec.progress;
    if ((rec.state === "downloading" || rec.state === "succeeded") && outs.length) progress = saved.length / outs.length;
    return {
      local_id: rec.local_id,
      title: title(rec),
      lane: rec.lane || "image",
      state: rec.state,
      status: statusLabel(rec.state),
      tone: tone(rec.state),
      attention: ATTENTION.indexOf(rec.state) >= 0 || !!(o.runner && o.runner.waitingFor && o.runner.waitingFor(rec.local_id)),
      progress: progress,
      takes: { saved: saved.length, total: outs.length },
      price: charges.words(rec),
      above_quote: charges.aboveQuote(rec),
      origin: origin(rec),
      created_at: rec.created_at || null,
      time: timeOf(rec.created_at),
      model_name: rec.model_name || rec.model_id || null,
      thumbnail: saved.length ? saved[0].path : null,
      detail: detailFor(rec, w),
      recovered: !!rec.recovered_from,
      place: w,
      actions: acts
    };
  }

  // The records of the active document: the jobs whose own document is in
  // front, and new-document jobs placed in it this session.
  function inDocument(rec, active) {
    if (active === null) return false;
    var t = rec.target || {};
    if (t.kind && t.kind !== "new_document" && !(t.kind === "upscale" && t.lands === "new_document")) {
      var w = where(rec);
      return w.kind === "active" && w.document_id === active;
    }
    return !!(rec.placement && rec.placement.document_id === active && rec.session === o.session);
  }

  function list(filter) {
    var f = FILTERS.indexOf(filter) >= 0 ? filter : "all";
    var all = o.ledger.all();
    var active = activeId();
    var counts = { all: all.length, attention: 0, agents: 0, document: 0 };
    var docRecs = [];
    var rows = [];
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      var rw = row(r);
      var isAgent = !!(r.origin && r.origin.kind === "agent");
      var inDoc = inDocument(r, active);
      if (rw.attention) counts.attention++;
      if (isAgent) counts.agents++;
      if (inDoc) {
        counts.document++;
        docRecs.push(r);
      }
      if (f === "all" || (f === "attention" && rw.attention) || (f === "agents" && isAgent) || (f === "document" && inDoc)) rows.push(rw);
    }
    var docInfo = null;
    if (active !== null) {
      var docs = o.host && typeof o.host.listDocuments === "function" ? o.host.listDocuments() : [];
      var t = null;
      for (var d = 0; d < docs.length; d++) if (docs[d].id === active) t = docs[d].title;
      docInfo = { document_id: active, title: t, charged: charges.total(docRecs), jobs: docRecs.length };
    }
    return { filter: f, rows: rows, counts: counts, document: docInfo, empty: all.length === 0, empty_text: all.length === 0 ? TEXT.empty : null };
  }

  function header() {
    var running = o.ledger.activeCount();
    var waiting = o.ledger.count("uncertain") + o.ledger.count("awaiting_approval");
    var ready = o.ledger.count("ready");
    var parts = [];
    if (running) parts.push(running + " running");
    if (waiting) parts.push(waiting + " waiting for you");
    if (ready) parts.push(ready + " ready to place");
    return { running: running, waiting: waiting, ready: ready, badge: waiting || running || null, attention: waiting > 0, tooltip: parts.length ? "Jobs: " + parts.join(", ") : "Jobs" };
  }

  function resolveView(id) {
    var rec = o.ledger.get(id);
    if (!rec) return null;
    var c = o.runner.lastCheck(id);
    var checking = typeof o.runner.isChecking === "function" ? o.runner.isChecking(id) : false;
    var candidates = c
      ? c.candidates.map(function (x) {
          return {
            job_id: x.job_id,
            created_at: x.created_at,
            time: timeOf(x.created_at, true),
            label: x.exact ? "same inputs" : "other inputs",
            exact: x.exact,
            status: statusLabel(x.status),
            results: x.results,
            selected: !!c.preselected && c.preselected === x.job_id
          };
        })
      : [];
    var exact = candidates.some(function (x) {
      return x.exact;
    });
    var complete = !!(c && c.complete);
    var note = checking ? TEXT.checking : !c ? null : !complete ? "Could not check Scenario's jobs" + (c.error ? " (" + c.error + ")" : "") + ". Check again." : exact ? TEXT.match : candidates.length ? TEXT.some : TEXT.no_match;
    var markReason = checking ? "Checking..." : !c ? null : !complete ? "Check again first: the last check did not finish." : exact ? "A job on Scenario matches this request: link it." : null;
    return {
      local_id: id,
      title: title(rec),
      help: TEXT.unknown_help,
      sent_at: rec.claimed_at || rec.created_at || null,
      sent: timeOf(rec.claimed_at || rec.created_at),
      model_name: rec.model_name || rec.model_id || null,
      price: priceKindWords(rec, rec.cu_quoted),
      error: rec.error || null,
      checking: checking,
      checked_at: c ? c.checked_at : null,
      complete: complete,
      window: c ? c.window : null,
      candidates: candidates,
      selected: c ? c.preselected : null,
      note: note,
      actions: {
        check: { label: ACTION_LABELS.check, enabled: !checking },
        link: { label: ACTION_LABELS.link, enabled: !checking && candidates.length > 0, reason: candidates.length ? null : "No job to link." },
        // With no recent check, Mark not sent runs one first (runner.markNotSent).
        mark_not_sent: { label: ACTION_LABELS.mark_not_sent, enabled: !checking && !markReason, reason: markReason }
      }
    };
  }

  function details(id) {
    var rec = o.ledger.get(id);
    if (!rec) return null;
    var t = rec.target || {};
    return {
      local_id: rec.local_id,
      title: title(rec),
      status: statusLabel(rec.state),
      state: rec.state,
      lane: rec.lane,
      model_name: rec.model_name || null,
      model_id: rec.model_id || null,
      trained_model_ids: rec.trained_model_ids || [],
      prompt: rec.parameters && typeof rec.parameters.prompt === "string" ? rec.parameters.prompt : null,
      origin: origin(rec),
      project: rec.project ? rec.project.name || null : null,
      document: t.kind === "new_document" ? "New document " + t.width + " x " + t.height : t.document_title || null,
      job_id: rec.job_id || null,
      price: charges.words(rec),
      cu_quoted: rec.cu_quoted || null,
      cu_charged: rec.cu_charged === undefined ? null : rec.cu_charged,
      refunded: !!rec.refunded,
      no_refund: !!rec.no_refund,
      created_at: rec.created_at || null,
      submitted_at: rec.submitted_at || null,
      finished_at: rec.finished_at || null,
      outputs: (rec.outputs || []).map(function (x) {
        return { asset_id: x.asset_id, state: x.state, path: x.path || null, width: x.width || null, height: x.height || null };
      }),
      placement: rec.placement ? { notes: rec.placement.notes || [], badges: rec.placement.badges || [], masked: rec.placement.masked } : null,
      error: rec.error || null,
      waiting: o.runner && o.runner.waitingFor ? o.runner.waitingFor(id) : null,
      recovered_from: rec.recovered_from ? statusLabel(rec.recovered_from) : null,
      resolution: rec.resolution || null
    };
  }

  function act(id, name, arg) {
    var r = o.runner;
    switch (name) {
      case "approve":
        return r.approve(id);
      case "decline":
        return r.decline(id);
      case "cancel_upload":
        return r.cancelUpload(id);
      case "stop_download":
        return r.stopDownload(id);
      case "resume":
        return r.resumeDownload(id);
      case "place":
        return r.place(id, {});
      case "place_current":
        return r.place(id, { current_document: true });
      case "open":
        return r.place(id, { new_document: true });
      case "resolve":
        if (!r.lastCheck(id)) {
          r.check(id).then(
            function () {},
            function () {}
          );
        }
        return Promise.resolve(resolveView(id));
      case "check":
        return r.check(id);
      case "link":
        return r.link(id, arg);
      case "mark_not_sent":
        return r.markNotSent(id);
      case "open_on_scenario":
        if (typeof o.openLink === "function") return Promise.resolve(o.openLink("open_on_scenario"));
        return Promise.resolve(API.links.open_on_scenario);
      case "copy_error": {
        var rec = o.ledger.get(id);
        var text = rec ? rec.error || statusLabel(rec.state) : "";
        if (typeof o.copyText === "function") return Promise.resolve(o.copyText(text));
        return Promise.resolve(text);
      }
      case "details":
        return Promise.resolve(details(id));
      default:
        return Promise.reject(new Error("unknown action " + name));
    }
  }

  return {
    list: list,
    row: row,
    header: header,
    resolveView: resolveView,
    details: details,
    act: act,
    onChange: function (fn) {
      listeners.push(fn);
    },
    FILTERS: FILTERS
  };
}

module.exports = { createJobsModel: createJobsModel, ACTION_LABELS: ACTION_LABELS, TEXT: TEXT, FILTERS: FILTERS, statusLabel: statusLabel, title: title, tone: tone };
