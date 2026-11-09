"use strict";
// The job ledger (SPEC 2.5, 6.2, 6.4): one JSON file per job in the plugin
// data folder, jobs/<local_id>.json, written atomically (the record goes to
// <file>.tmp, then is renamed over the file). It is the source of truth
// across restarts. At startup the records are read back from the files (the
// copy with the higher revision wins when a write stopped between the
// temporary file and the rename) and the restart transitions apply:
//   submitting                          -> uncertain (a job may exist)
//   uploading_inputs, awaiting_approval -> not_sent ("Interrupted by a restart")
//   applying                            -> ready (the runner first looks for
//                                          a placed layer: then applied)
//   queued, generating, cancel_requested without a job id -> uncertain
// queued, generating and cancel_requested resume polling; succeeded and
// downloading resume downloading (the runner does both); download_failed,
// ready, apply_failed and uncertain stay. Every record that was not final
// keeps `recovered_from` (its state before the restart) so Jobs can say so.
// Nothing lands in a document by itself after a restart.
//
// Records hold prompts, settings, document titles and hashes, never keys,
// secrets, signed links or absolute paths: file paths are relative to the
// plugin data folder.

var charges = require("./charges.js");

var DIR = "jobs";
var STATES = ["uploading_inputs", "awaiting_approval", "submitting", "queued", "generating", "cancel_requested", "succeeded", "downloading", "download_failed", "ready", "applying", "apply_failed", "applied", "failed", "blocked", "canceled", "not_sent", "uncertain"];
var FINAL = ["applied", "failed", "blocked", "canceled", "not_sent"];
var IN_FLIGHT = ["uploading_inputs", "awaiting_approval", "submitting", "uncertain"];
var ACTIVE = ["uploading_inputs", "awaiting_approval", "submitting", "queued", "generating", "cancel_requested", "succeeded", "downloading", "applying"];
var LOCAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function copy(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// A saved result path the plugin can trust: relative to the data folder,
// inside the Output Folder, no parent steps.
function safePath(p) {
  return typeof p === "string" && /^Scenario\/[A-Za-z0-9._\/-]+$/.test(p) && p.indexOf("..") < 0 && p.indexOf("//") < 0;
}

// Light checks on a record read from disk: a known state, outputs as a list
// whose paths stay inside the Output Folder. Returns the record, or null.
function sane(rec) {
  if (!rec || typeof rec !== "object" || STATES.indexOf(rec.state) < 0) return null;
  if (rec.outputs !== undefined && rec.outputs !== null && !Array.isArray(rec.outputs)) return null;
  var outs = rec.outputs || [];
  for (var i = 0; i < outs.length; i++) {
    if (!outs[i] || typeof outs[i] !== "object") return null;
    if (outs[i].path !== null && outs[i].path !== undefined && !safePath(outs[i].path)) {
      outs[i].path = null;
      outs[i].state = "pending";
    }
  }
  return rec;
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
      rec = sane(rec);
      if (!rec) {
        log("jobs: a record was skipped (unreadable)");
        continue;
      }
      var before = rec.state;
      var touched = false;
      if (FINAL.indexOf(before) < 0 && before !== "uncertain" && before !== "download_failed" && before !== "ready" && before !== "apply_failed") {
        rec.recovered_from = before;
        rec.recovered_at = iso();
        touched = true;
      }
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
        // The runner looks for its layers once before any new placement.
        rec.placement_checked = false;
      } else if ((rec.state === "queued" || rec.state === "generating" || rec.state === "cancel_requested") && !rec.job_id) {
        rec.state = "uncertain";
        rec.error = "Unknown: the job id was not saved before Photoshop closed. A job may exist on Scenario.";
      }
      records[id] = rec;
      if (rec.state !== before || touched) {
        changed.push(rec);
        // The first 8 characters of the local id: enough to follow one job
        // in the log, and short of the redaction of token-like strings.
        log("jobs: restart: " + id.slice(0, 8) + " " + before + (rec.state !== before ? " -> " + rec.state : ", resumes"));
      }
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

  function findByJobId(jobId) {
    if (!jobId) return null;
    for (var id in records) if (records[id].job_id === jobId) return copy(records[id]);
    return null;
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
      // Its temporary copy would load as a claimed request after a restart
      // and block the same request as Unknown.
      if (o.host && typeof o.host.removeData === "function") {
        Promise.resolve(o.host.removeData(DIR + "/" + rec.local_id + ".json.tmp")).catch(function () {});
      }
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
    findByJobId: findByJobId,
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

module.exports = { createLedger: createLedger, IN_FLIGHT: IN_FLIGHT, LOCAL_ID: LOCAL_ID, STATES: STATES, FINAL: FINAL, ACTIVE: ACTIVE, safePath: safePath };
