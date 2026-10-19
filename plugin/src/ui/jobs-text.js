"use strict";
// What the tray and the Jobs view say about a job, as plain data (SPEC 2.5,
// 3.9, 3.11, 3.13). No DOM here, so it is tested under Node.

var enums = require("../../../shared/enums.json");
var charges = require("../jobs/charges.js");
var slugMod = require("../util/slug.js");

var LABELS = {};
for (var i = 0; i < enums.job_status.length; i++) LABELS[enums.job_status[i].value] = enums.job_status[i].label;

var KIND_NAMES = { image: "Image", edit: "Edit", upscale: "Upscale", expand: "Expand", remove_background: "Remove BG" };

var TEXT = {
  empty: "No jobs yet. What you generate here, or an AI agent generates for you, shows up here.",
  mark_confirm: "Click again to mark it not sent. If a job for it exists on Scenario, it ran and was charged: check Jobs on app.scenario.com first.",
  unknown_help: "Unknown: the request may or may not have reached Scenario. Nothing is retried until you decide in Jobs.",
  ready_banner: "Ready. Describe a new image below, or select an area and use Edit to change it.",
  meta_banner: "Prompts and prices are saved in layer metadata and travel with the PSD."
};

function statusLabel(state) {
  return LABELS[state] || state;
}

function title(rec) {
  var kind = KIND_NAMES[rec.lane] || "Image";
  var slug = slugMod.slug(rec.parameters && rec.parameters.prompt);
  return slug ? kind + ' "' + slug + '"' : kind;
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function timeOf(iso) {
  var t = Date.parse(iso);
  if (isNaN(t)) return "";
  var d = new Date(t);
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function origin(rec) {
  if (rec.origin && rec.origin.kind === "agent") return String(rec.origin.client_name || "Agent client");
  return "You";
}

function takesWord(n) {
  return n + " take" + (n === 1 ? "" : "s");
}

function where(rec) {
  var t = rec.target || {};
  if (t.kind === "new_document") return "opens as a new document";
  return t.document_title ? "for " + t.document_title : "for its document";
}

// The tray's line for the latest job (SPEC 3.9, 3.13 loading words).
function tray(rec) {
  var n = (rec.outputs || []).length;
  var saved = (rec.outputs || []).filter(function (x) {
    return x && x.state === "saved";
  }).length;
  var status;
  switch (rec.state) {
    case "uploading_inputs":
      status = "Uploading references";
      break;
    case "awaiting_approval":
      status = "Price changed after upload: waiting for you";
      break;
    case "submitting":
      status = "Sending...";
      break;
    case "queued":
      status = "Queued on Scenario";
      break;
    case "generating":
      status = typeof rec.progress === "number" && rec.progress > 0 && rec.progress < 1 ? "Generating, " + Math.round(rec.progress * 100) + "%" : "Generating";
      break;
    case "succeeded":
    case "downloading":
      status = n ? "Downloading " + Math.min(saved + 1, n) + " of " + n : "Downloading results";
      break;
    case "ready":
      status = "Ready " + where(rec) + ": " + takesWord(n);
      break;
    case "applying":
      status = "Placing";
      break;
    case "applied":
      status = "Placed: " + takesWord(n);
      break;
    default:
      status = rec.error || statusLabel(rec.state);
  }
  var badges = [];
  var refs = (rec.inputs && rec.inputs.references) || [];
  for (var i = 0; i < refs.length; i++) if (refs[i].reduced) badges.push("Input reduced (" + refs[i].width + " x " + refs[i].height + ")");
  var notes = rec.placement && rec.placement.notes ? rec.placement.notes : [];
  var detail = [rec.model_name, charges.words(rec)].filter(Boolean).join(" · ");
  if (rec.state === "uncertain") detail = TEXT.unknown_help;
  else if ((rec.state === "apply_failed" || rec.state === "download_failed") && rec.error) detail = rec.error;
  return {
    status: status,
    detail: detail,
    badges: badges.concat(notes).join(" · "),
    place: rec.state === "ready" || rec.state === "apply_failed",
    open: rec.state === "ready" || rec.state === "apply_failed" || rec.state === "applied"
  };
}

// Jobs view actions per status (SPEC 3.11), limited to what this build does.
function actions(rec) {
  switch (rec.state) {
    case "awaiting_approval":
      return ["approve", "decline"];
    case "ready":
      return ["place", "open"];
    case "apply_failed":
      return ["place", "open", "copy_error"];
    case "applied":
      return ["open"];
    case "download_failed":
      return rec.download_error_type ? ["copy_error"] : ["resume", "copy_error"];
    case "uncertain":
      return ["mark_not_sent", "copy_error"];
    case "failed":
    case "blocked":
    case "canceled":
    case "not_sent":
      return ["copy_error"];
    default:
      return [];
  }
}

var ACTION_LABELS = {
  approve: "Approve",
  decline: "Decline",
  place: "Place",
  open: "Open as document",
  resume: "Resume download",
  mark_not_sent: "Mark not sent",
  copy_error: "Copy error"
};

// States that wait for the person (the Jobs row and the header badge show
// them in the warning color).
var ATTENTION = ["uncertain", "awaiting_approval", "apply_failed", "download_failed", "failed", "blocked"];

function row(rec) {
  var meta = [origin(rec), charges.words(rec), timeOf(rec.created_at)].filter(Boolean).join(" · ");
  var acts = actions(rec);
  return {
    title: title(rec) + "  " + statusLabel(rec.state),
    name: title(rec),
    status: statusLabel(rec.state),
    attention: ATTENTION.indexOf(rec.state) >= 0,
    meta: meta,
    detail: rec.state === "uncertain" ? TEXT.unknown_help : rec.error || (rec.placement && rec.placement.notes ? rec.placement.notes.join(" ") : ""),
    actions: acts.map(function (a) {
      return { name: a, label: a === "approve" && rec.cu_quoted_new ? "Approve (" + rec.cu_quoted_new + " CU)" : ACTION_LABELS[a] };
    })
  };
}

module.exports = { statusLabel: statusLabel, title: title, tray: tray, row: row, actions: actions, timeOf: timeOf, TEXT: TEXT, ACTION_LABELS: ACTION_LABELS };
