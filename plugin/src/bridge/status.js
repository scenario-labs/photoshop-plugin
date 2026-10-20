"use strict";
// The agent settings (SPEC 6.3, 6.6) and the plugin's answer to
// scenario_status. signed_in and project_name come from the auth module
// (never the key, the secret or the project id); uncertain_jobs counts the
// ledger's Unknown jobs.
//
// Settings > Agents changes them; agents never can (MCP.md section 10).
// "Agents may modify the document", "Agents read the active document only"
// and No-spend mode persist in the data folder; "Agents may run Photoshop
// commands" never does, so it is off at every Photoshop start. The
// allowance (Allow without asking) lives in memory: it ends with its client
// session, when Photoshop quits, on End, or when the total is used.

var price = require("../forms/price.js");
var charges = require("../jobs/charges.js");

var DEFAULT_SWITCHES = {
  agents_may_modify: false,
  agents_may_run_commands: false,
  active_document_only: false
};

// SPEC 3.7: Generate asks for confirmation above this price (thousandths of a CU).
var CONFIRM_ABOVE = 100000;
var FILE = "agent-settings.json";
// SPEC 6.3 defaults, in thousandths of a CU.
var PER_CALL_DEFAULT = 50000;
var TOTAL_DEFAULT = 300000;

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

// o (optional): { host (writeDataAtomic, readDataText), log }
function createSettings(o) {
  o = o || {};
  var log = o.log || function () {};
  var switches = copyOf(DEFAULT_SWITCHES);
  var spending = copyOf(DEFAULT_SPENDING);
  var noSpend = false;
  // The allowance in thousandths, while one runs.
  var allowance = null;
  var listeners = [];

  function notify(what) {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](what);
      } catch (e) {
        log("settings: a listener failed: " + e.message);
      }
    }
  }

  function save() {
    if (!o.host || typeof o.host.writeDataAtomic !== "function") return Promise.resolve();
    var text = JSON.stringify({ agents_may_modify: switches.agents_may_modify, active_document_only: switches.active_document_only, no_spend: noSpend });
    return Promise.resolve(o.host.writeDataAtomic(FILE, text)).catch(function (e) {
      log("settings: not saved (" + ((e && e.message) || e) + ")");
    });
  }

  function syncSpending() {
    if (!allowance) {
      spending = copyOf(DEFAULT_SPENDING);
      return;
    }
    spending = {
      mode: "allow",
      client: copyOf(allowance.client),
      per_call_limit: price.exactString(allowance.per_call),
      session_total: price.exactString(allowance.total),
      remaining: price.exactString(allowance.remaining)
    };
  }

  function endAllowance(why) {
    if (!allowance) return false;
    allowance = null;
    syncSpending();
    log("agent allowance ended (" + why + ")");
    notify({ type: "allowance", ended: why });
    return true;
  }

  function limitOf(v, fallback) {
    if (v === undefined || v === null || v === "") return fallback;
    var t = charges.parse(String(v));
    if (t === null || t <= 0) throw new Error("A limit is a positive CU amount.");
    return t;
  }

  return {
    // Reads the saved switches (the commands switch is never saved).
    load: async function () {
      if (!o.host || typeof o.host.readDataText !== "function") return;
      var text = null;
      try {
        text = await o.host.readDataText(FILE);
      } catch (e) {
        text = null;
      }
      if (!text) return;
      try {
        var v = JSON.parse(text);
        switches.agents_may_modify = v.agents_may_modify === true;
        switches.active_document_only = v.active_document_only === true;
        noSpend = v.no_spend === true;
      } catch (e) {
        log("settings: the saved agent settings were unreadable; defaults apply");
      }
    },
    switches: function () {
      return copyOf(switches);
    },
    spending: function () {
      var copy = copyOf(spending);
      if (copy.client) copy.client = copyOf(copy.client);
      return copy;
    },
    noSpend: function () {
      return noSpend;
    },
    // The person's confirm limit, in thousandths of a CU.
    confirmAbove: function () {
      return CONFIRM_ABOVE;
    },
    // Settings > Agents. The commands switch needs the modify switch; turning
    // modify off turns commands off.
    setSwitch: function (key, value) {
      if (!Object.prototype.hasOwnProperty.call(switches, key)) throw new Error("unknown switch " + key);
      value = !!value;
      if (key === "agents_may_run_commands" && value && !switches.agents_may_modify) throw new Error("Turn on Agents may modify the document first.");
      switches[key] = value;
      if (key === "agents_may_modify" && !value) switches.agents_may_run_commands = false;
      notify({ type: "switches" });
      return save().then(function () {
        return copyOf(switches);
      });
    },
    setNoSpend: function (value) {
      noSpend = !!value;
      notify({ type: "no_spend" });
      return save();
    },
    // Allow without asking, for one client session (SPEC 6.3). Limits are
    // decimal CU strings; defaults 50 per call and 300 in total.
    grant: function (client, perCall, total) {
      if (!client || !client.session) throw new Error("Pick a connected client.");
      var p = limitOf(perCall, PER_CALL_DEFAULT);
      var t = limitOf(total, TOTAL_DEFAULT);
      allowance = { client: { session: client.session, client_name: client.client_name, connected_at: client.connected_at }, per_call: p, total: t, remaining: t };
      syncSpending();
      notify({ type: "allowance", granted: true });
      return this.spending();
    },
    end: function (why) {
      return endAllowance(why || "ended by you");
    },
    // The allowance applies to this session and this amount (thousandths;
    // M for a range): the check and the deduction are one synchronous step.
    tryDeduct: function (session, amount) {
      if (!allowance || allowance.client.session !== session) return false;
      if (!(amount >= 0) || amount > allowance.per_call || amount > allowance.remaining) return false;
      allowance.remaining -= amount;
      syncSpending();
      notify({ type: "allowance" });
      if (allowance.remaining <= 0) endAllowance("the total is used");
      return true;
    },
    // A deducted request that was never sent gives its amount back.
    refund: function (session, amount) {
      if (!allowance || allowance.client.session !== session || !(amount > 0)) return;
      allowance.remaining = Math.min(allowance.total, allowance.remaining + amount);
      syncSpending();
      notify({ type: "allowance" });
    },
    // Once a charge is known: the deduction becomes the larger of the quote
    // and the charge; a refund gives nothing back; a charge above its quote
    // ends the allowance. Returns "above" in that case.
    settle: function (session, quoted, charged) {
      if (!allowance || allowance.client.session !== session) return null;
      if (!(charged > quoted)) return null;
      allowance.remaining = Math.max(0, allowance.remaining - (charged - quoted));
      syncSpending();
      endAllowance("Charged " + price.exactString(charged) + " CU, above the quoted " + price.exactString(quoted));
      return "above";
    },
    allowanceFor: function (session) {
      if (!allowance || allowance.client.session !== session) return null;
      return { per_call: allowance.per_call, remaining: allowance.remaining, total: allowance.total };
    },
    // SPEC 2.6, Client sessions: when a session ends (it leaves the clients
    // list, or the link drops), the allowance granted to it ends too.
    endSessions: function (ids) {
      if (!allowance || ids.indexOf(allowance.client.session) < 0) return false;
      return endAllowance("its session ended");
    },
    onChange: function (fn) {
      listeners.push(fn);
    },
    // Tests use these.
    _set: function (key, value) {
      if (!Object.prototype.hasOwnProperty.call(switches, key)) throw new Error("unknown switch " + key);
      switches[key] = !!value;
    },
    _grant: function (client, remaining) {
      this.grant(client);
      if (remaining !== undefined) {
        var r = charges.parse(String(remaining));
        allowance.remaining = r === null ? allowance.remaining : r;
        syncSpending();
      }
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
