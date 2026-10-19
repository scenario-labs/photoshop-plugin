"use strict";
// The plugin's answer to scenario_status. signed_in and project_name come
// from the auth module (never the key, the secret or the project id);
// uncertain_jobs counts the ledger's Unknown jobs. There is no settings
// screen yet, so the settings report the defaults the spec sets: every agent
// switch off, spending "ask each time", no-spend off, and the person's
// confirm limit at 100 CU.

var DEFAULT_SWITCHES = {
  agents_may_modify: false,
  agents_may_run_commands: false,
  active_document_only: false
};

// SPEC 3.7: Generate asks for confirmation above this price (thousandths of a CU).
var CONFIRM_ABOVE = 100000;

var DEFAULT_SPENDING = {
  mode: "ask",
  client: null,
  per_call_limit: "50",
  session_total: "300",
  remaining: null
};

function copyOf(obj) {
  var out = {};
  for (var key in obj) out[key] = obj[key];
  return out;
}

function createSettings() {
  var switches = copyOf(DEFAULT_SWITCHES);
  var spending = copyOf(DEFAULT_SPENDING);
  return {
    switches: function () {
      return copyOf(switches);
    },
    spending: function () {
      var copy = copyOf(spending);
      if (copy.client) copy.client = copyOf(copy.client);
      return copy;
    },
    noSpend: function () {
      return false;
    },
    // The person's confirm limit, in thousandths of a CU.
    confirmAbove: function () {
      return CONFIRM_ABOVE;
    },
    // SPEC 2.6, Client sessions: when a session ends (it leaves the clients
    // list, or the link drops), the allowance granted to it ends too and the
    // plugin goes back to asking each time. Consents, cards and job ownership
    // tied to a session do not exist in this build yet.
    endSessions: function (ids) {
      if (!spending.client || ids.indexOf(spending.client.session) < 0) return false;
      spending = copyOf(DEFAULT_SPENDING);
      return true;
    },
    // Tests use these: this build has no settings screen to change them.
    _set: function (key, value) {
      if (!Object.prototype.hasOwnProperty.call(switches, key)) throw new Error("unknown switch " + key);
      switches[key] = !!value;
    },
    _grant: function (client, remaining) {
      spending = copyOf(DEFAULT_SPENDING);
      spending.mode = "allow";
      spending.client = { session: client.session, client_name: client.client_name, connected_at: client.connected_at };
      spending.remaining = remaining === undefined ? spending.session_total : remaining;
    }
  };
}

var SIGNED_OUT = {
  status: function () {
    return { signed_in: false, project_name: null };
  }
};

// host: { listDocuments() -> [{id, title}], activeDocumentId() -> id|null,
//         photoshopVersion() -> string|null, osName() -> string|null }
// account: { status() -> {signed_in, project_name} }; signed out when omitted.
// jobs: the ledger ({count(state)}); no Unknown jobs when omitted.
function createStatusHandler(host, settings, pluginVersion, account, jobs) {
  account = account || SIGNED_OUT;
  return function scenarioStatus() {
    var acc = { signed_in: false, project_name: null };
    try {
      var s = account.status();
      acc.signed_in = s.signed_in === true;
      acc.project_name = acc.signed_in && typeof s.project_name === "string" ? s.project_name : null;
    } catch (e) {
      acc = { signed_in: false, project_name: null };
    }
    var switches = settings.switches();
    var docs = [];
    var active = null;
    try {
      docs = host.listDocuments() || [];
    } catch (e) {
      docs = [];
    }
    try {
      active = host.activeDocumentId();
    } catch (e) {
      active = null;
    }
    if (active === undefined) active = null;
    var visible = switches.active_document_only
      ? docs.filter(function (d) {
          return d.id === active;
        })
      : docs;
    return {
      signed_in: acc.signed_in,
      project_name: acc.project_name,
      plugin_version: pluginVersion,
      photoshop_version: host.photoshopVersion(),
      os: host.osName(),
      switches: switches,
      agent_spending: settings.spending(),
      no_spend: settings.noSpend(),
      active_document_id: active,
      open_documents: visible.map(function (d) {
        return { id: d.id, title: String(d.title) };
      }),
      uncertain_jobs: jobs ? jobs.count("uncertain") : 0
    };
  };
}

module.exports = { createSettings: createSettings, createStatusHandler: createStatusHandler, CONFIRM_ABOVE: CONFIRM_ABOVE };
