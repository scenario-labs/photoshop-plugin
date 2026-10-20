"use strict";
// Suggest in the prompt box (FLOWS v2, changes after review 8): Scenario
// Prompt Spark proposes prompts for the action's model from the person's
// short prompt, or describes the active layer when the prompt is empty.
// POST /v1/generate/prompt, mode contextual-v2, synchronous.
//
// Suggest is offered as free. Each request is price-checked first with the
// one dry-run constant (scenario/dry-run.js); it is sent only when that
// check answers 0 CU (measured 2026-10-20: 3 proposals from a text prompt,
// 0 CU), so it never spends and keeps no job record. Any other price stops
// it and the menu says the price. A charge read back from the answer is
// returned so the panel can say it.
//
// The proposals are cleaned for the prompt box: text only (Prompt Spark's
// sizes, quality and other parameters are dropped: the chips stay in
// charge), em and en dashes become commas, at most `n`.

var errorsMod = require("./errors.js");
var priceChecks = require("./dry-run.js");
var paid = require("./paid.js");
var b64 = require("../util/base64url.js");

var MODE = "contextual-v2";
var MAX_PROMPT = 2000;

function clean(text) {
  return String(text)
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// image: { bytes, mime } (a capture of the layer) -> a data: URL.
function dataUrl(image) {
  return "data:" + (image.mime || "image/png") + ";base64," + b64.encodeStandard(image.bytes);
}

// o: { model_id, prompt, image ({bytes, mime}) | null, n (1 to 5) }
function bodyFor(o) {
  if (!priceChecks.validModelId(o.model_id)) throw new errorsMod.ScenarioError("InvalidParameter", "model_id is not a Scenario model id.");
  var body = { mode: MODE, modelId: o.model_id, numResults: Math.max(1, Math.min(5, o.n || 3)) };
  var p = String(o.prompt || "").trim();
  if (p) body.prompt = p.slice(0, MAX_PROMPT);
  if (o.image && o.image.bytes) body.images = [dataUrl(o.image)];
  if (!body.prompt && !body.images) throw new errorsMod.ScenarioError("InvalidParameter", "Suggest needs a prompt or a picture.");
  return body;
}

// deps: { client, quotes (forms/quotes.js: stopped(), alarm()), settings }
// Resolves { state: "ready", items: [text], charged } or { state: "priced",
// cu } (not sent) or { state: "failed", reason }.
async function suggest(deps, o) {
  if (deps.quotes && deps.quotes.stopped && deps.quotes.stopped()) return { state: "failed", reason: "Price checks are stopped until Photoshop restarts." };
  if (deps.settings && typeof deps.settings.noSpend === "function" && deps.settings.noSpend()) return { state: "failed", reason: "No-spend mode is on. Nothing was sent." };
  var body = bodyFor(o);
  var check;
  try {
    check = await priceChecks.promptCheck(deps.client, body);
  } catch (e) {
    if (e && e.type === "DryRunCreatedJob" && deps.quotes && deps.quotes.alarm) deps.quotes.alarm(e.jobId || null);
    return { state: "failed", reason: (e && e.message) || String(e) };
  }
  if (check.cost !== 0) return { state: "priced", cu: check.cost };
  var out = await paid.submitPrompt(deps.client, body);
  if (out.status !== "done") return { state: "failed", reason: out.reason || "Prompt Spark did not answer." };
  var items = [];
  for (var i = 0; i < out.prompts.length && items.length < (o.n || 3); i++) {
    if (typeof out.prompts[i] !== "string") continue;
    var t = clean(out.prompts[i]);
    if (t) items.push(t);
  }
  if (!items.length) return { state: "failed", reason: "Prompt Spark returned no proposal." };
  return { state: "ready", items: items, charged: typeof out.charged === "number" ? out.charged : null };
}

module.exports = { suggest: suggest, bodyFor: bodyFor, clean: clean, MODE: MODE };
