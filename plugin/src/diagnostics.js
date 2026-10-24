"use strict";
// Copy diagnostics (SPEC 3.14): versions, OS, switch states, job counts and
// the last 20 error types. Never prompts, document or project names, ids,
// paths, keys or tokens. The panel shows the text before it is copied.

var MAX_ERRORS = 20;

function createErrorLog() {
  var types = [];
  return {
    record: function (type) {
      if (typeof type !== "string" || !/^[A-Z][A-Za-z]+$/.test(type)) type = "Internal";
      types.push(type);
      if (types.length > MAX_ERRORS) types.splice(0, types.length - MAX_ERRORS);
    },
    list: function () {
      return types.slice();
    }
  };
}

function onOff(v) {
  return v ? "on" : "off";
}

// Job counts by status, never prompts, titles or ids.
function jobsLine(jobs) {
  if (!jobs) return "none";
  var c = jobs.counts();
  var names = Object.keys(c).sort();
  if (!names.length) return "none";
  return names
    .map(function (k) {
      return k + " " + c[k];
    })
    .join(", ");
}

// o: { version, build, host, settings, auth, link, errors, jobs (the ledger) }
function createDiagnostics(o) {
  return {
    text: function () {
      var sw = o.settings.switches();
      var spending = o.settings.spending();
      var account = o.auth.status();
      var saved = o.auth.list().length;
      var linkState = o.link ? o.link.state() : null;
      var errors = o.errors.list();
      var lines = [
        "plugin " + o.version + " (" + o.build + ") . helper " + (linkState && linkState.helper_version ? linkState.helper_version : "not linked"),
        "Photoshop " + (o.host.photoshopVersion() || "unknown") + " . " + (o.host.osName() || "unknown OS"),
        "switches: modify " + onOff(sw.agents_may_modify) + ", commands " + onOff(sw.agents_may_run_commands) + ", active document only " + onOff(sw.active_document_only),
        "agent spending: " + spending.mode + ", no-spend " + onOff(o.settings.noSpend()),
        "agent link: " + (linkState ? linkState.phase : "none") + ", clients " + (linkState ? linkState.clients.length : 0),
        "account: " + (account.signed_in ? "signed in" : "not signed in") + ", keys saved " + saved,
        "jobs: " + jobsLine(o.jobs),
        "last errors: " + (errors.length ? errors.join(", ") : "none")
      ];
      return lines.join("\n");
    }
  };
}

module.exports = { createDiagnostics: createDiagnostics, createErrorLog: createErrorLog };
