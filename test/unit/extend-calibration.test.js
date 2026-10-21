"use strict";
// The Extend canvas edge limits against labelled real takes
// (test/fixtures/extend-edges/scores.json, measured 2026-10-21): every
// clean take reads "Edges ok", every stepped or doubled take gets a warning,
// and each limit sits with a margin from the takes it separates.
//
// What the data says: the step score alone does not separate the labels
// (the stepped mask-route takes score 0 to 11.7 after the tone match, the
// clean takes 11.2 and 12.2). Those takes are caught by the band residual
// (9.1 and up against 5.3 for the clean takes). The step limit is set
// above the clean takes, for the tone band a position-route take showed
// (41.9). The repeat limit sits between the clean takes (0 and 1 block)
// and the takes that drew the main figure twice (3 blocks and up).

const test = require("node:test");
const assert = require("node:assert/strict");
const checks = require("../../plugin/src/apply/checks.js");
const ctl = require("../../plugin/src/panel/controller.js");
const data = require("../fixtures/extend-edges/scores.json");

const MARGIN = 1.5;

// The runner's summary of one Extend take (jobs/runner.js), then the
// badges and the card's summary badge.
function verdict(t) {
  const seam = { bias: t.bias, residual: t.residual };
  const bandOk = t.bias < checks.LIMITS.seam_bias && t.residual < checks.LIMITS.seam_residual;
  const stepOk = t.step === null || t.step < checks.EDGE.step;
  const repeated = t.repeats >= checks.EDGE.repeats;
  const c = { seam, seam_ok: bandOk && stepOk && !repeated, step: t.step, step_ok: stepOk, repeated, edited: null, aspect_ok: true };
  const badges = checks.badges(c, null, { masked: true });
  return { badges, badge: ctl.badgeOf(badges), stepOk, repeated, bandOk };
}

const of = (label) => data.takes.filter((t) => t.label === label);

test("extend edge limits: clean takes read Edges ok; stepped and doubled takes are flagged", () => {
  assert.equal(of("clean").length, 2);
  for (const t of of("clean")) assert.deepEqual(verdict(t).badge, { tone: "ok", text: "Edges ok" }, `${t.id}: ${JSON.stringify(verdict(t).badges)}`);
  for (const t of [...of("stepped"), ...of("repeated")]) assert.equal(verdict(t).badge && verdict(t).badge.tone, "warn", `${t.id}: ${JSON.stringify(verdict(t).badges)}`);
  // A doubled figure is named as such, not only as a misalignment.
  for (const t of of("repeated")) assert.ok(verdict(t).badges.includes("Repeated detail past the old edge"), t.id);
});

test("extend edge limits: each limit has a margin from the takes it separates", () => {
  const clean = of("clean");
  const cleanStep = Math.max(...clean.map((t) => t.step));
  assert.ok(cleanStep * MARGIN <= checks.EDGE.step, `clean step ${cleanStep} vs limit ${checks.EDGE.step}`);
  // Takes only the step check catches (a tone band past the edge).
  const byStep = of("stepped").filter((t) => !verdict(t).bandOk);
  const stepOnly = of("stepped").filter((t) => verdict(t).bandOk);
  assert.ok(stepOnly.length >= 1);
  for (const t of stepOnly) assert.ok(t.step >= checks.EDGE.step * MARGIN, `${t.id} step ${t.step}`);
  // The band residual catches the other stepped takes with a margin.
  for (const t of byStep) assert.ok(t.residual >= checks.LIMITS.seam_residual * MARGIN, `${t.id} residual ${t.residual}`);
  // The clean takes stay under the residual limit (5.3 against 6: the
  // thinnest margin in this data).
  for (const t of clean) assert.ok(t.residual < checks.LIMITS.seam_residual, `${t.id} residual ${t.residual}`);
  // Repeats: the limit lies strictly between the clean takes and the
  // doubled figure.
  assert.ok(Math.max(...clean.map((t) => t.repeats)) < checks.EDGE.repeats);
  assert.ok(Math.min(...of("repeated").map((t) => t.repeats)) > checks.EDGE.repeats);
});

test("extend edge limits: the step score alone does not separate the labels", () => {
  const cleanStep = Math.max(...of("clean").map((t) => t.step));
  const low = of("stepped").filter((t) => t.step <= cleanStep);
  assert.ok(low.length >= 2, "stepped takes scoring at or below the clean ones: " + low.map((t) => t.id + " " + t.step).join(", "));
});
