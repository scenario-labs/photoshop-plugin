"use strict";
// The plugin's answer to scenario_status. In this build there is no sign-in,
// no job ledger and no settings screen yet, so those fields report the
// defaults the spec sets: not signed in, no project, every agent switch off,
// spending "ask each time", no unknown jobs.

var DEFAULT_SWITCHES = {
  agents_may_modify: false,
  agents_may_run_commands: false,
  active_document_only: false
};

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

// host: { listDocuments() -> [{id, title}], activeDocumentId() -> id|null,
//         photoshopVersion() -> string|null, osName() -> string|null }
function createStatusHandler(host, settings, pluginVersion) {
  return function scenarioStatus() {
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
      signed_in: false,
      project_name: null,
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
      uncertain_jobs: 0
    };
  };
}

module.exports = { createSettings: createSettings, createStatusHandler: createStatusHandler };
