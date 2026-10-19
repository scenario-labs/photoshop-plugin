"use strict";
// The job ledger (SPEC 2.5, 6.2, 6.4): one JSON file per job in the plugin
// data folder, jobs/<local_id>.json, written atomically (the record goes to
// <file>.tmp, then is renamed over the file). At startup the records are
// read back from the files and the restart transitions apply:
//   submitting                        -> uncertain (a job may exist)
//   uploading_inputs, awaiting_approval -> not_sent ("Interrupted by a restart")
//   applying                          -> ready (nothing lands by itself)
// queued, generating and cancel_requested resume polling; succeeded and
// downloading resume downloading (the runner does both).
//
// Records hold prompts, settings and document titles, never keys, secrets,
// signed links or absolute paths: file paths are relative to the plugin data
// folder.

var charges = require("./charges.js");

var DIR = "jobs";
var IN_FLIGHT = ["uploading_inputs", "awaiting_approval", "submitting", "uncertain"];
var ACTIVE = ["uploading_inputs", "awaiting_approval", "submitting", "queued", "generating", "cancel_requested", "succeeded", "downloading", "applying"];
var LOCAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function copy(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// o: { host: {readDataText, writeDataAtomic, listData, ensureDataDir},
//      random: {bytes(n)}, now() -> ms, log, session (this Photoshop start's
//      marker) }
function createLedger(o) {
  var records = {};
  var chains = {};
  var listeners = [];
  var log = o.log || function () {};
  var now =
    o.now ||
    function () {
      return Date.now();
    };
  var loaded = false;

  function iso() {
    return new Date(now()).toISOString();
  }

  function newId() {
    var b = o.random.bytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = "";
    for (var i = 0; i < 16; i++) h += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  function notify(rec) {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](copy(rec));
      } catch (e) {
        log("jobs: a listener failed: " + e.message);
      }
    }
  }

  // Writes are serialized per record, so two updates never interleave.
  function write(rec) {
    var id = rec.local_id;
    var text = JSON.stringify(rec);
    var prev = chains[id] || Promise.resolve();
    var next = prev.then(function () {
      return o.host.writeDataAtomic(DIR + "/" + id + ".json", text);
    });
    chains[id] = next.then(
      function () {},
      function () {}
    );
    return next.then(function (ok) {
      if (ok === false) throw new Error("the job record could not be written");
      return copy(rec);
    });
  }

  async function load() {
    if (loaded) return all();
    loaded = true;
    try {
      await o.host.ensureDataDir(DIR);
    } catch (e) {
      log("jobs: data folder unavailable: " + e.message);
    }
    var names = [];
    try {
      names = (await o.host.listData(DIR)) || [];
    } catch (e) {
      names = [];
    }
    var ids = {};
    for (var i = 0; i < names.length; i++) {
      var m = /^([0-9a-f-]{36})\.json(\.tmp)?$/.exec(names[i]);
      if (m && LOCAL_ID.test(m[1])) ids[m[1]] = true;
    }
    var changed = [];
    for (var id in ids) {
      var text = await o.host.readDataText(DIR + "/" + id + ".json");
      // A write cut between the temporary file and the rename leaves the
      // newer record in the temporary file: the higher revision wins.
      var tmp = await o.host.readDataText(DIR + "/" + id + ".json.tmp");
      var rec = null;
      var pick = [text, tmp];
      for (var p = 0; p < pick.length; p++) {
        if (!pick[p]) continue;
        try {
          var v = JSON.parse(pick[p]);
          if (v && v.local_id === id && typeof v.state === "string" && (!rec || (v.revision || 0) > (rec.revision || 0))) rec = v;
        } catch (e) {
          // an unreadable copy is skipped
        }
      }
      if (!rec) continue;
      var before = rec.state;
      if (rec.state === "submitting") {
        rec.state = "uncertain";
        rec.error = "Unknown: Photoshop closed while the request was being sent. A job may exist on Scenario.";
      } else if (rec.state === "uploading_inputs" || rec.state === "awaiting_approval") {
        rec.state = "not_sent";
        rec.error = "Not sent: Interrupted by a restart.";
        var c = charges.notSent();
        rec.cu_charged = c.cu_charged;
        rec.refunded = c.refunded;
        rec.finished_at = rec.finished_at || iso();
      } else if (rec.state === "applying") {
        rec.state = "ready";
      }
      records[id] = rec;
      if (rec.state !== before) changed.push(rec);
    }
    for (var k = 0; k < changed.length; k++) {
      changed[k].revision = (changed[k].revision || 0) + 1;
      try {
        await write(changed[k]);
      } catch (e) {
        log("jobs: restart transition not saved: " + e.message);
      }
    }
    log("jobs: " + Object.keys(records).length + " record(s) read" + (changed.length ? ", " + changed.length + " changed by the restart" : ""));
    return all();
  }

  function all() {
    var list = [];
    for (var id in records) list.push(copy(records[id]));
    list.sort(function (a, b) {
      return String(b.created_at).localeCompare(String(a.created_at)) || String(b.local_id).localeCompare(String(a.local_id));
    });
    return list;
  }

  function get(id) {
    return Object.prototype.hasOwnProperty.call(records, id) ? copy(records[id]) : null;
  }

  function findByKey(key) {
    for (var id in records) if (records[id].idempotency_key === key) return copy(records[id]);
    return null;
  }

  function inFlight(fingerprint) {
    for (var id in records) if (records[id].fingerprint === fingerprint && IN_FLIGHT.indexOf(records[id].state) >= 0) return copy(records[id]);
    return null;
  }

  // Claims a new record (SPEC 6.2 step 3): written before anything is sent.
  // The in-memory record exists at once, so a second click in the same
  // moment sees it.
  function create(fields) {
    var rec = copy(fields);
    rec.local_id = newId();
    rec.revision = 1;
    rec.session = o.session || null;
    rec.created_at = rec.created_at || iso();
    rec.claimed_at = rec.claimed_at || rec.created_at;
    records[rec.local_id] = rec;
    // A record that cannot be written is dropped: nothing is sent for it.
    var done = write(rec).catch(function (e) {
      delete records[rec.local_id];
      throw e;
    });
    notify(rec);
    return done;
  }

  function update(id, patch) {
    var rec = records[id];
    if (!rec) return Promise.reject(new Error("no such job"));
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) rec[k] = copy(patch[k]);
    rec.revision = (rec.revision || 0) + 1;
    var done = write(rec);
    notify(rec);
    return done;
  }

  function count(state) {
    var n = 0;
    for (var id in records) if (!state || records[id].state === state) n++;
    return n;
  }

  function counts() {
    var out = {};
    for (var id in records) out[records[id].state] = (out[records[id].state] || 0) + 1;
    return out;
  }

  function activeCount() {
    var n = 0;
    for (var id in records) if (ACTIVE.indexOf(records[id].state) >= 0) n++;
    return n;
  }

  return {
    load: load,
    all: all,
    get: get,
    findByKey: findByKey,
    inFlight: inFlight,
    create: create,
    update: update,
    count: count,
    counts: counts,
    activeCount: activeCount,
    onChange: function (fn) {
      listeners.push(fn);
    },
    DIR: DIR
  };
}

module.exports = { createLedger: createLedger, IN_FLIGHT: IN_FLIGHT, LOCAL_ID: LOCAL_ID };
