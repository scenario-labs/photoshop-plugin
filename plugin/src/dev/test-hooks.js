"use strict";
// DEVELOPMENT BUILDS ONLY. Release bundles replace this module with a stub
// whose points do nothing (plugin/scripts/build.js), and a test checks that
// they do.
//
// Test hooks for the restart checks (SPEC 12.2 item 9): a point in the job
// flow can be armed to hold (wait until Photoshop quits), wait a delay, or
// fail, once. The development live run (dev/live-run.js) and the Node tests
// arm them; nothing reads them from the network. Points:
//   upload             after the first input upload, before the price check
//   price_after_upload value(): adds `add` thousandths of a CU to the price
//                      read after upload (a price change, so the job waits
//                      for approval)
//   paid_answer        after the paid request's answer arrives, before the
//                      ledger records it (the job stays `submitting`)
//   poll               after a status read that leaves the job queued or
//                      generating has been saved
//   download_part      after a result's .part file is written, before the
//                      rename
//   place              after the record reads `applying`, before Photoshop
//                      places anything
// Arming lives in memory only, so a hook never fires again after a restart.

function create(o) {
  o = o || {};
  var log = o.log || function () {};
  var timers = o.timers || { setTimeout: setTimeout };
  var armed = {};
  var reached = {};
  var waiters = {};

  function fire(point, info) {
    reached[point] = info || {};
    log("dev hook: " + point + " reached");
    var list = waiters[point] || [];
    delete waiters[point];
    for (var i = 0; i < list.length; i++) list[i](reached[point]);
  }

  // spec: { action: "hold" | "delay" | "fail", ms (delay), skip (calls to
  // let through first), add (price_after_upload) }
  function arm(point, spec) {
    armed[point] = JSON.parse(JSON.stringify(spec || { action: "hold" }));
    delete reached[point];
  }

  function take(point) {
    var spec = armed[point];
    if (!spec) return null;
    if (spec.skip > 0) {
      spec.skip--;
      return null;
    }
    delete armed[point];
    return spec;
  }

  function at(point, info) {
    var spec = take(point);
    if (!spec) return Promise.resolve();
    fire(point, info);
    if (spec.action === "hold") return new Promise(function () {});
    if (spec.action === "fail") return Promise.reject(new Error("dev hook: " + point + " failed on purpose"));
    if (spec.action === "delay") {
      return new Promise(function (resolve) {
        timers.setTimeout(resolve, spec.ms || 0);
      });
    }
    return Promise.resolve();
  }

  function value(point, v, info) {
    var spec = take(point);
    if (!spec) return v;
    fire(point, info);
    return typeof spec.add === "number" ? v + spec.add : v;
  }

  // Resolves the point's info once it is reached.
  function wait(point) {
    if (reached[point]) return Promise.resolve(reached[point]);
    return new Promise(function (resolve) {
      (waiters[point] = waiters[point] || []).push(resolve);
    });
  }

  function disarm() {
    armed = {};
  }

  return { arm: arm, at: at, value: value, wait: wait, disarm: disarm, active: true };
}

module.exports = { create: create };
