"use strict";
// Quotes (SPEC 6.1, MCP.md section 3): a validated form, priced by one dry
// run, becomes a quote that is single use, expires after 120 s and is bound
// to a SHA-256 fingerprint of what it priced. Price checks upload no
// document pixels: file inputs the lane fills later (the capture, the mask,
// the source) are priced by the measured rule of each model
// (shared/catalog-map.json, models.*.price_inputs):
//   omit   the input is left out (its absence does not change the price);
//   count  the price follows the number of files: the first `free` files
//          are left out, beyond that every slot gets a small blank stand-in;
//   size   the price follows the file's size: a blank stand-in at the
//          source's size, within the read cap;
//   any    the input is required but any file prices it: one small stand-in.
// An input with no measured rule is priced as `any` when the schema says it
// does not change the price and is required, left out when optional, and
// otherwise needs the real file first ("price after upload"), so no price is
// ever shown that the charge could exceed unannounced.

var MAP = require("../../../shared/catalog-map.json");
var errorsMod = require("../scenario/errors.js");
var priceChecks = require("../scenario/dry-run.js");
var validate = require("./validate.js");
var price = require("./price.js");
var canonical = require("../util/canonical-json.js");
var sha = require("../util/sha256.js");

var QUOTE_TTL_MS = 120000;
var KEEP_MS = 600000;
// The quote mode M2.0 fixed (SPEC 6.1 item 1), part of every fingerprint.
var QUOTE_MODE = priceChecks.DRY_RUN_QUERY;

function copy(obj) {
  var out = {};
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== null && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function ruleFor(schema, f) {
  var facts = Object.prototype.hasOwnProperty.call(MAP.models, schema.model_id) ? MAP.models[schema.model_id] : null;
  var r = facts && facts.price_inputs && facts.price_inputs[f.name];
  if (r && typeof r.rule === "string") return r;
  if (!f.price_affecting) return { rule: f.required ? "any" : "omit" };
  return { rule: "after_upload" };
}

// How many files of a "count" input are priced without one, for this body.
// free_when: { parameter: [values] } limits the free slots to those values:
// GPT Image 2.5 prices its first reference image at no cost at quality Low
// only (measured 2026-10-20: Flare, 2 takes, 1024 x 1024: Low 3 CU with or
// without a reference, Medium 6 without and 7 with one of any size).
function freeSlots(rule, body) {
  var free = rule.free || 0;
  var when = rule.free_when;
  if (!when || typeof when !== "object") return free;
  for (var k in when) {
    if (!Object.prototype.hasOwnProperty.call(when, k)) continue;
    if (!Array.isArray(when[k]) || when[k].indexOf(body[k]) < 0) return 0;
  }
  return free;
}

// Fits a size inside the read cap, keeping its aspect.
function capSize(w, h) {
  var cap = MAP.stand_ins.read_cap_px;
  var long = Math.max(w, h);
  if (long <= cap) return { width: Math.round(w), height: Math.round(h) };
  var s = cap / long;
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

function countOf(v) {
  if (v === null || v === undefined) return 0;
  return Array.isArray(v) ? v.length : 1;
}

function assetIdsIn(schema, params) {
  var out = {};
  for (var i = 0; i < schema.file_inputs.length; i++) {
    var n = schema.file_inputs[i].name;
    if (params[n] !== undefined) out[n] = Array.isArray(params[n]) ? params[n].slice() : [params[n]];
  }
  return out;
}

// o: { client, catalog, standIns, account() -> {id, key_hash, project_id},
//      random: {bytes(n)}, now() -> ms, log, onAlarm(jobId) }
function createQuotes(o) {
  var now = o.now || function () { return Date.now(); };
  var log = o.log || function () {};
  var store = {};
  var stopped = null;

  function newId() {
    if (!o.random) throw new errorsMod.ScenarioError("Internal", "No secure random source for quote ids.");
    return "quote_" + sha.toHex(o.random.bytes(12));
  }

  function prune() {
    var t = now();
    for (var id in store) if (t - store[id].issued_at > KEEP_MS) delete store[id];
  }

  function fingerprint(acc, req, params) {
    return canonical.hash({
      model_id: req.model_id,
      lane: req.lane || null,
      trained: { ids: params.loras || (params.modelId ? [params.modelId] : []), scales: params.lorasScale || [] },
      parameters: params,
      pending: req.pending || {},
      target: req.target || null,
      project: acc.project_id || null,
      key: acc.key_hash,
      quote_mode: QUOTE_MODE
    });
  }

  // The parameters as priced: the request's, without nulls, with takes as
  // the model's take count input.
  function paramsOf(schema, req) {
    var params = copy(req.parameters || {});
    if (req.takes !== null && req.takes !== undefined) {
      if (!schema.takes_input) {
        if (req.takes !== 1) throw new errorsMod.ScenarioError("InvalidParameter", "This model makes one take per run.");
      } else {
        if (params[schema.takes_input] !== undefined && params[schema.takes_input] !== req.takes) throw new errorsMod.ScenarioError("InvalidParameter", "takes and " + schema.takes_input + " differ.");
        params[schema.takes_input] = req.takes;
      }
    }
    return params;
  }

  // Builds the body of the price check. Returns { body, needsUpload,
  // standIns: count }.
  async function build(schema, params, req) {
    var pending = req.pending || {};
    var body = copy(params);
    var needsUpload = false;
    var standInCount = 0;
    for (var i = 0; i < schema.file_inputs.length; i++) {
      var f = schema.file_inputs[i];
      var waiting = pending[f.name] || 0;
      if (!waiting) continue;
      var requiredNow = f.required;
      for (var w = 0; w < f.required_with.length; w++) if (body[f.required_with[w]] !== undefined || pending[f.required_with[w]]) requiredNow = true;
      if (requiredNow || f.price_affecting) needsUpload = true;
      var rule = ruleFor(schema, f);
      var given = countOf(body[f.name]);
      if (rule.rule === "omit") continue;
      if (rule.rule === "count") {
        var total = given + waiting;
        if (total <= freeSlots(rule, body)) continue;
        var small = await o.standIns.get(MAP.stand_ins.small_px, MAP.stand_ins.small_px);
        var ids = Array.isArray(body[f.name]) ? body[f.name].slice() : body[f.name] ? [body[f.name]] : [];
        for (var c = 0; c < waiting; c++) ids.push(small);
        body[f.name] = f.multiple ? ids : ids[0];
        standInCount += waiting;
        continue;
      }
      if (given) continue;
      if (rule.rule === "any") {
        var one = await o.standIns.get(MAP.stand_ins.small_px, MAP.stand_ins.small_px);
        body[f.name] = f.multiple ? [one] : one;
        standInCount++;
        continue;
      }
      if (rule.rule === "size" && req.source_size && req.source_size.width > 0 && req.source_size.height > 0) {
        var s = capSize(req.source_size.width, req.source_size.height);
        var sized = await o.standIns.get(s.width, s.height);
        body[f.name] = f.multiple ? [sized] : sized;
        standInCount++;
        continue;
      }
      var e = new errorsMod.ScenarioError("InvalidParameter", "The price of this model depends on " + f.name + ", which no blank stand-in can price. Upload it first and pass its asset id.");
      e.afterUpload = f.name;
      throw e;
    }
    return { body: body, needsUpload: needsUpload, standIns: standInCount };
  }

  async function checkPrice(schema, params, req, acc) {
    var built = await build(schema, params, req);
    try {
      return { built: built, answer: await priceChecks.priceCheck(o.client, schema.model_id, built.body) };
    } catch (err) {
      // A stand-in deleted on Scenario's side: forget the stand-ins and try once more.
      if (err && err.assetMissing && built.standIns && o.standIns.forget && (await o.standIns.forget(acc.id))) {
        built = await build(schema, params, req);
        return { built: built, answer: await priceChecks.priceCheck(o.client, schema.model_id, built.body) };
      }
      throw err;
    }
  }

  // req: { model_id, lane, parameters, takes, pending: {input: count},
  //        source_size: {width, height}, target }
  async function estimate(req) {
    if (stopped) throw new errorsMod.ScenarioError("DryRunCreatedJob", "Price checks are stopped for this session: a price check created a job on Scenario.");
    var acc = o.account();
    if (!acc) throw new errorsMod.ScenarioError("NotSignedIn", "No Scenario key is saved in the plugin.");
    var schema = await o.catalog.schema(req.model_id);
    var params = paramsOf(schema, req);
    validate.assertValid(schema, params, req.pending);
    var run;
    try {
      run = await checkPrice(schema, params, req, acc);
    } catch (err) {
      if (err && err.type === "DryRunCreatedJob") alarm(err.jobId || null);
      throw err;
    }
    var t = price.toThousandths(run.answer.cost);
    var kind = "exact";
    var max = null;
    var variable = schema.variable_charge;
    if (variable && variable.kind === "from") kind = "from";
    if (variable && variable.kind === "range" && variable.bound_parameter) {
      var bound = null;
      for (var p = 0; p < schema.parameters.length; p++) if (schema.parameters[p].name === variable.bound_parameter) bound = schema.parameters[p];
      if (bound && bound.max !== null) {
        var atMax = copy(params);
        atMax[variable.bound_parameter] = bound.max;
        var high = await checkPrice(schema, atMax, req, acc);
        kind = "range";
        max = Math.max(t, price.toThousandths(high.answer.cost));
      } else {
        kind = "from";
      }
    }
    prune();
    var issued = now();
    var id = newId();
    var fp = fingerprint(acc, req, params);
    store[id] = { id: id, fingerprint: fp, exact: price.exactString(t), thousandths: t, max: max, kind: kind, issued_at: issued, used: false };
    return {
      quote_id: id,
      cu_cost_exact: price.exactString(t),
      cu_cost: t / 1000,
      price_kind: kind,
      cu_cost_max: max === null ? null : max / 1000,
      cost_details: run.answer.details,
      expires_at: new Date(issued + QUOTE_TTL_MS).toISOString(),
      no_refund: schema.no_refund,
      needs_upload: run.built.needsUpload,
      label: price.label(kind, t, max),
      stand_ins: run.built.standIns,
      input_assets: assetIdsIn(schema, params)
    };
  }

  // The quote checks of MCP.md section 3, item 3 (3 to 5), for the request
  // that would spend. Marks the quote used when every check passes.
  async function redeem(quoteId, approvedCost, req) {
    prune();
    var q = Object.prototype.hasOwnProperty.call(store, quoteId) ? store[quoteId] : null;
    if (!q) throw new errorsMod.ScenarioError("QuoteExpired", "This plugin issued no such quote, or it is older than 10 minutes. Call estimate_cost again.");
    if (q.used) throw new errorsMod.ScenarioError("QuoteUsed", "This quote was already used. Call estimate_cost again.");
    if (now() - q.issued_at >= QUOTE_TTL_MS) throw new errorsMod.ScenarioError("QuoteExpired", "This quote is older than 120 s. Call estimate_cost again.");
    if (typeof approvedCost !== "string" || approvedCost !== q.exact) throw new errorsMod.ScenarioError("CostMismatch", "approved_cost must be the quote's cu_cost_exact, " + q.exact + ", character for character.");
    // Held while the fingerprint is checked, so two requests cannot both use it.
    q.used = true;
    var acc = o.account();
    var params;
    try {
      params = paramsOf(await o.catalog.schema(req.model_id), req);
    } catch (e) {
      params = null;
    }
    if (!acc || !params || fingerprint(acc, req, params) !== q.fingerprint) {
      q.used = false;
      throw new errorsMod.ScenarioError("QuoteMismatch", "The request differs from what the quote priced (model, parameters, inputs, target or project).");
    }
    return { kind: q.kind, thousandths: q.thousandths, max: q.max, fingerprint: q.fingerprint, issued_at: q.issued_at };
  }

  // Gives a redeemed quote back when its request was never claimed (the
  // record could not be written), so the same price can be sent again.
  function release(quoteId) {
    var q = Object.prototype.hasOwnProperty.call(store, quoteId) ? store[quoteId] : null;
    if (q) q.used = false;
  }

  // Checks 3 to 5 without using the quote (MCP.md section 3: the agent's
  // generate runs them before No-spend and the allowance; redeem() runs
  // them again when the request is claimed).
  async function peek(quoteId, approvedCost, req) {
    prune();
    var q = Object.prototype.hasOwnProperty.call(store, quoteId) ? store[quoteId] : null;
    if (!q) throw new errorsMod.ScenarioError("QuoteExpired", "This plugin issued no such quote, or it is older than 10 minutes. Call estimate_cost again.");
    if (q.used) throw new errorsMod.ScenarioError("QuoteUsed", "This quote was already used. Call estimate_cost again.");
    if (now() - q.issued_at >= QUOTE_TTL_MS) throw new errorsMod.ScenarioError("QuoteExpired", "This quote is older than 120 s. Call estimate_cost again.");
    if (typeof approvedCost !== "string" || approvedCost !== q.exact) throw new errorsMod.ScenarioError("CostMismatch", "approved_cost must be the quote's cu_cost_exact, " + q.exact + ", character for character.");
    var acc = o.account();
    var params;
    try {
      params = paramsOf(await o.catalog.schema(req.model_id), req);
    } catch (e) {
      params = null;
    }
    if (!acc || !params || fingerprint(acc, req, params) !== q.fingerprint) throw new errorsMod.ScenarioError("QuoteMismatch", "The request differs from what the quote priced (model, parameters, inputs, target or project).");
    return { kind: q.kind, thousandths: q.thousandths, max: q.max, fingerprint: q.fingerprint, issued_at: q.issued_at, exact: q.exact };
  }

  // The fingerprint a request would carry (SPEC 6.2 step 2: the in-flight
  // block runs before the quote checks).
  async function fingerprintFor(req) {
    var acc = o.account();
    if (!acc) throw new errorsMod.ScenarioError("NotSignedIn", "No Scenario key is saved in the plugin.");
    return fingerprint(acc, req, paramsOf(await o.catalog.schema(req.model_id), req));
  }

  // The parameters a redeemed request sends: as priced, with takes as the
  // model's take count input. File inputs the lane fills are added by the
  // caller once uploaded.
  async function bodyFor(req) {
    return paramsOf(await o.catalog.schema(req.model_id), req);
  }

  function alarm(jobId) {
    if (!stopped) stopped = { job_id: jobId || null, at: now() };
    log("price check created a job: price checks stopped for the session");
    if (o.onAlarm) o.onAlarm(jobId || null);
  }

  // The second price check of SPEC 6.1 step 3, with the real asset ids.
  // Resolves the price in thousandths.
  async function recheck(modelId, body) {
    if (stopped) throw new errorsMod.ScenarioError("DryRunCreatedJob", "Price checks are stopped for this session: a price check created a job on Scenario.");
    try {
      var answer = await priceChecks.priceCheck(o.client, modelId, body);
      return price.toThousandths(answer.cost);
    } catch (err) {
      if (err && err.type === "DryRunCreatedJob") alarm(err.jobId || null);
      throw err;
    }
  }

  return {
    estimate: estimate,
    redeem: redeem,
    release: release,
    peek: peek,
    fingerprintFor: fingerprintFor,
    bodyFor: bodyFor,
    recheck: recheck,
    alarm: alarm,
    stopped: function () {
      return stopped;
    },
    TTL_MS: QUOTE_TTL_MS
  };
}

module.exports = { createQuotes: createQuotes, capSize: capSize, ruleFor: ruleFor, QUOTE_TTL_MS: QUOTE_TTL_MS };
