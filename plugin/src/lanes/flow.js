"use strict";
// The Edit and Enhance lanes end to end, without the panel: read the
// document, build the view, price it, and on Generate build it again, take
// the capture and start the paid run (jobs/runner.js). The panel and the
// development live check (dev/live-run.js) both drive the lanes through this.
//
// a (what the person chose): {
//   tool: "edit" | "trained_edit" | "upscale" | "expand" | "remove_background",
//   model_id (the lane default when left out; the base for trained_edit),
//   trained: { model_id, kind: "lora" | "composition", scale, strength }
//            (trained_edit only),
//   options: the view options (lanes/edit.js, lanes/enhance.js), prompt
//   included, context (optional: a context already read), references (how
//   many reference images the Edit lane sends, for the price) or refs (the
//   references themselves, at Generate) }
//
// The money contract stays with the runner and the quotes: Generate is
// built from the document as it is at the click, so a document, selection
// or setting changed since the price check makes the quote mismatch and
// nothing is spent. A capture that must shrink to fit the upload limit on a
// model whose output follows its input stops with InputReduced
// (e.reduced_long) before anything is sent; the caller prices again with
// options.read_long = e.reduced_long.

var errorsMod = require("../scenario/errors.js");
var requests = require("../forms/requests.js");
var contextMod = require("./context.js");
var editMod = require("./edit.js");
var enhanceMod = require("./enhance.js");
var common = require("./common.js");

var LANE = { edit: "edit", trained_edit: "edit", upscale: "upscale", expand: "expand", remove_background: "remove_background" };

function invalid(text) {
  return new errorsMod.ScenarioError("InvalidParameter", text);
}

// o: { catalog, quotes, host, runner, capture, account() -> {id} | null, log }
function createFlow(o) {
  var log = o.log || function () {};

  function context() {
    return contextMod.read(o.host);
  }

  function viewFor(tool, schema, ctx, a) {
    var opts = {};
    for (var k in a.options || {}) opts[k] = a.options[k];
    if (a.prompt !== undefined && opts.prompt === undefined) opts.prompt = a.prompt;
    if (a.takes !== undefined && opts.takes === undefined) opts.takes = a.takes;
    if (tool === "edit") return editMod.editView(schema, ctx, opts);
    if (tool === "trained_edit") return editMod.trainedView(schema, ctx, a.trained, opts);
    if (tool === "upscale") return enhanceMod.upscaleView(schema, ctx, opts);
    if (tool === "expand") return enhanceMod.expandView(schema, ctx, opts);
    return enhanceMod.cutoutView(schema, ctx, opts);
  }

  // Resolves { tool, lane, context, schema, view, req (null when blocked) }.
  async function prepare(a) {
    var tool = a.tool;
    var lane = LANE[tool];
    if (!lane) throw invalid("tool must be one of: " + Object.keys(LANE).join(", ") + ".");
    if (tool === "trained_edit" && (!a.trained || !a.trained.model_id)) throw invalid("A trained edit needs the trained model.");
    var modelId = a.model_id || common.defaultModel(lane);
    if (!modelId) throw invalid("No model for the " + lane + " lane.");
    var ctx = a.context || (await context());
    var schema = await o.catalog.schema(modelId);
    var view = viewFor(tool, schema, ctx, a);
    // References go with the capture in the Edit lane (the panel's refs
    // row): priced by count, uploaded at Generate.
    var refCount = a.refs ? a.refs.length : a.references || 0;
    if (view.request && lane === "edit" && refCount) view.request.references = refCount;
    var req = null;
    if (!view.blocked) {
      try {
        req = requests.build(schema, view.request);
      } catch (e) {
        view.blocked = (e && e.message) || String(e);
        view.request = null;
        view.capture = null;
      }
    }
    return { tool: tool, lane: lane, context: ctx, schema: schema, view: view, req: req };
  }

  // The price check. Resolves the prepared object plus { state: "ready" |
  // "blocked" | "after_upload" | "unavailable" | "not_signed_in" | "alarm",
  // quote, reason }.
  async function price(a) {
    var p = await prepare(a);
    p.quote = null;
    p.reason = null;
    if (!p.req) {
      p.state = "blocked";
      p.reason = p.view.blocked;
      return p;
    }
    if (o.account && !o.account()) {
      p.state = "not_signed_in";
      return p;
    }
    try {
      p.quote = await o.quotes.estimate(p.req);
      p.state = "ready";
    } catch (e) {
      p.state = e && e.afterUpload ? "after_upload" : e && e.type === "DryRunCreatedJob" ? "alarm" : "unavailable";
      p.reason = (e && e.message) || String(e);
      log("lanes: price check " + ((e && e.type) || "error"));
    }
    return p;
  }

  // Generate with a quote from price(). Resolves the runner's answer (state
  // queued, awaiting_approval, not_sent, uncertain, or a replay) plus the
  // view it ran.
  async function generate(a, quote) {
    var p = await prepare(a);
    if (!p.req) throw invalid(p.view.blocked);
    if (!o.runner || !o.capture) throw invalid("Generate needs a secure random source; prices still show.");
    var spec = p.view.capture;
    var cap = await o.capture[spec.kind](spec.spec);
    var out = await o.runner.start({ req: p.req, quote: quote, refs: p.lane === "edit" && a.refs ? a.refs : [], capture: cap, model_name: p.schema.name, document_title: p.context.doc ? p.context.doc.title : null });
    out.view = p.view;
    return out;
  }

  return { context: context, prepare: prepare, price: price, generate: generate, LANE: LANE };
}

module.exports = { createFlow: createFlow, LANE: LANE };
