"use strict";
// DEVELOPMENT BUILDS ONLY. Release bundles replace this module with a stub
// whose hook() returns null (plugin/scripts/build.js), and a test checks it.
//
// Sample states for pictures of the panel made for the docs, never left on
// the live panel: Jobs rows, a sign-in error, a project name. Each one is drawn by the panel's own render code,
// which hands its render functions to hook() when it is built. Sample
// pictures arrive as base64 in the command (test/live/ui-dev.js) and are
// written under "dev-demo/" in the plugin's data folder; nothing is added to
// the jobs ledger.

var b64 = require("../util/base64url.js");

var DIR = "dev-demo";
var hooks = {};

function hook(name, internals) {
  hooks[name] = internals;
  return { demo: name };
}

function need(name) {
  if (!hooks[name]) throw new Error("no " + name + " hook in this panel");
  return hooks[name];
}

function bytesOf(img) {
  return b64.decodeStandard(String(img.b64 || ""));
}

// Writes the sample pictures; returns outputs as the ledger keeps them.
async function writeTakes(host, images, prefix) {
  var outs = [];
  if (images.length && host.ensureDataDir) await host.ensureDataDir(DIR);
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    var ext = img.mime === "image/jpeg" ? "jpg" : "png";
    var path = DIR + "/" + prefix + "-" + (i + 1) + "." + ext;
    await host.writeDataBinary(path, bytesOf(img));
    outs.push({ asset_id: "asset_demo" + prefix + (i + 1), state: "saved", path: path, width: img.width || 1024, height: img.height || 1024, mime: img.mime || "image/png" });
  }
  return outs;
}

function record(spec, outputs, n) {
  return {
    local_id: "demo-" + n,
    lane: spec.lane || "image",
    state: spec.state || "ready",
    parameters: { prompt: spec.prompt || "" },
    model_name: spec.model || "",
    price_kind: "exact",
    cu_quoted: spec.quoted || null,
    cu_charged: spec.charged === undefined ? null : spec.charged,
    created_at: spec.created_at || new Date().toISOString(),
    origin: spec.agent ? { kind: "agent", client_name: spec.agent } : { kind: "person" },
    target: spec.target || { kind: "canvas", document_title: spec.document || "Untitled-1" },
    outputs: outputs,
    progress: spec.progress,
    error: spec.error || null,
    inputs: { references: [] },
    placement: spec.state === "applied" ? { notes: [] } : null
  };
}

// ctx: { host, app, doc }
async function run(what, args, ctx) {
  args = args || {};
  switch (what) {
    case "jobs": {
      var jobs = need("jobs");
      if (ctx.app.jobsView) ctx.app.jobsView.open();
      var specs = args.records || [];
      var list = [];
      for (var j = 0; j < specs.length; j++) {
        var o2 = await writeTakes(ctx.host, specs[j].images || [], "job" + (j + 1));
        list.push(record(specs[j], o2, j + 1));
      }
      jobs.renderList(list);
      return { rows: list.length };
    }
    case "failure": {
      var acc = need("account");
      acc.renderFailure(args.prefix || "signin", args.state ? { state: args.state, type: "Demo" } : null);
      return { failure: args.state || null };
    }
    case "project": {
      // A sample project name in the header, for pictures of the panel.
      var label = ctx.doc ? ctx.doc.getElementById("project-label") : null;
      if (label) label.textContent = String(args.label || "");
      return { project: !!label };
    }
    case "adding": {
      need("account").startAdding();
      return { adding: true };
    }
    default:
      throw new Error("unknown demo: " + what);
  }
}

module.exports = { hook: hook, run: run, DIR: DIR };
