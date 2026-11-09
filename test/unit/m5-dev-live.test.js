"use strict";
// The development-only live entry's restart requests (plugin/src/dev/
// live-run.js, used by test/live/m5-live-check.js) on the fake Photoshop:
// a `restart` request saves its document, stops the job at a test hook and
// closes the document; after a restart, a `check` request reads what
// recovery made of the job, tries Place with the document closed, reopens
// the saved document and places. Release bundles carry a stub
// (test/unit/bundle.test.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const devLive = require("../../plugin/src/dev/live-run.js");
const { createWorld } = require("../helpers/restart-sim.js");
const { solidPng } = require("../helpers/fixture-scenario.js");

const FLARE = "model_openai-gpt-image-2-5-flare";
const BG = "model_851-labs-background-remover";
const DOC = { width: 512, height: 512, fixture: "dev-live/fixture.png", flatten: true };
const SEL = { left: 192, top: 192, width: 128, height: 128, shape: "ellipse", feather: 2 };

function costAnswer(cu) {
  return { status: 200, body: { creativeUnitsCost: cu, creativeUnitsDiscount: 0, costDetails: { "custom-generation": cu } } };
}

const answer = (model, body) => (model === FLARE && body.referenceImages ? costAnswer(2) : model === BG ? costAnswer(1) : undefined);

async function holdThenCheck(t, request) {
  const w = await createWorld(t, { mockOpts: { answer } });
  w.files.set("dev-live/fixture.png", new Uint8Array(solidPng(512, 512, [90, 120, 160])));
  const one = await w.boot({ docs: [], signIn: true, psOpts: { scene: true } });
  const held = await devLive.start(one.app, one.ps.require, { poll: false }).run({ id: request.id, ...request, timeout_s: 20 });
  assert.equal(held.ok, true, held.error);
  assert.equal(held.held, true);
  assert.equal(held.closed, true);
  assert.equal(one.ps.app.documents.length, 0, "its document is closed before the quit");
  assert.ok(w.files.has(held.psd), "the document was saved first");
  one.quit();
  const two = await w.boot({ docs: [], psOpts: { scene: true } });
  const checked = await devLive.start(two.app, two.ps.require, { poll: false }).run({ id: `${request.id}-check`, check: { local_id: held.local_id, point: request.restart.point, psd: held.psd }, timeout_s: 20 });
  return { w, held, checked, two };
}

test("dev live run, restart while placing: held at the hook, then after the restart Place waits for the closed document and lands once in the reopened one", async (t) => {
  const { w, held, checked, two } = await holdThenCheck(t, { id: "restart-placing", restart: { point: "place" }, document: DOC, selection: SEL, run: { tool: "edit", prompt: "a red ball", takes: 1 }, max_cu: 5 });
  assert.equal(held.before_quit.state, "applying");
  assert.equal(checked.ok, true, checked.error);
  const steps = Object.fromEntries(checked.steps.map((s) => [s.step, s]));
  assert.equal(steps.after_restart.record.state, "ready");
  assert.equal(steps.after_restart.record.recovered_from, "applying");
  assert.equal(steps.place_while_closed.placed, false);
  assert.match(steps.place_while_closed.error, /^DocumentClosed: Open "restart-placing\.psd" to place this result there/);
  assert.equal(steps.reopened.state, "ready", "nothing lands by itself after a restart");
  assert.equal(steps.reopened.where.how, "key");
  assert.equal(steps.placed.in_reopened_document, true);
  assert.equal(steps.placed.layers_with_job_metadata, 1, "it lands once");
  assert.equal(w.mock.paidCalls.length, 1);
  assert.equal(checked.closed, true);
  assert.equal(two.ps.app.documents.length, 0, "the reopened document is closed at the end");
});

test("dev live run, restart while sending: the check resolves the Unknown job, links the one exact match and places the result", async (t) => {
  const { w, held, checked } = await holdThenCheck(t, { id: "restart-submitting", restart: { point: "paid_answer" }, document: DOC, run: { tool: "remove_background" }, max_cu: 3 });
  assert.equal(held.before_quit.state, "submitting");
  assert.equal(checked.ok, true, checked.error);
  const steps = Object.fromEntries(checked.steps.map((s) => [s.step, s]));
  assert.equal(steps.after_restart.record.state, "uncertain");
  assert.equal(steps.resolve.candidates.filter((c) => c.exact).length, 1);
  assert.equal(steps.linked.record.resolution.kind, "linked");
  assert.equal(steps.placed.record.state, "applied");
  assert.equal(w.mock.paidCalls.length, 1, "one paid call; the check never sends again");
});

test("dev live run, restart while awaiting approval: the check reports Not sent and stops there", async (t) => {
  const { w, held, checked } = await holdThenCheck(t, { id: "restart-approval", restart: { point: "price_after_upload", add: 1000 }, document: DOC, run: { tool: "remove_background" }, max_cu: 3 });
  assert.equal(held.before_quit.state, "awaiting_approval");
  assert.equal(checked.ok, true, checked.error);
  assert.equal(checked.state, "not_sent");
  assert.equal(checked.steps[0].record.error, "Not sent: Interrupted by a restart.");
  assert.equal(w.mock.paidCalls.length, 0);
});
