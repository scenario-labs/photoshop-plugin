"use strict";
// M6 agent tools, found by the skills review: capture_reference's expand
// anchor (where the original sits in the larger canvas) uses the tool
// schema's names (left, right, top_left, ...). They used to reach the shape
// code unmapped and fall back to center, so "original at the left" grew both
// sides. A model that sizes the canvas itself keeps the original centered and
// now refuses any other anchor.

const test = require("node:test");
const assert = require("node:assert/strict");
const { bootGenerate, FLARE } = require("../helpers/generate-sim.js");
const { REFRAME } = require("../helpers/reframe-record.js");

const A = { session: "sess-a", client_name: "claude-code", connected_at: "2026-10-23T10:00:00.000Z" };
const DOC = { id: 7, title: "wide.psd", width: 1024, height: 768 };
const EXACT = "model_photoroom-expand";

function cost(cu) {
  return { status: 200, body: { creativeUnitsCost: cu, creativeUnitsDiscount: 0, costDetails: { "custom-generation": cu } } };
}

async function boot(t) {
  const sim = await bootGenerate(t, { docs: [DOC], active: 7, psOpts: { scene: true }, mockOpts: { extraRecords: { [REFRAME.id]: REFRAME }, answer: () => cost(3) } });
  const h = sim.app.agentTools.handlers;
  const offset = async (model, anchor) => {
    const r = await h.capture_reference({ purpose: "expand", model_id: model, expand: { aspect: "16:9", anchor } }, A);
    const cap = sim.app.inputs.capture(r.capture_id);
    return { offset: cap.view.request.target.expand.offset, position: r.parameters.position || null };
  };
  return { h, offset };
}

test("expand anchors left and right keep the original on that side, on a position model and a mask model", async (t) => {
  const { offset } = await boot(t);
  for (const model of [REFRAME.id, FLARE]) {
    const center = await offset(model, "center");
    const left = await offset(model, "left");
    const right = await offset(model, "right");
    assert.deepEqual(left.offset, [0, 0], model + " left");
    assert.ok(right.offset[0] > center.offset[0] && center.offset[0] > 0, model + " right " + JSON.stringify(right.offset));
    assert.equal(right.offset[1], 0);
    if (model === REFRAME.id) assert.notEqual(left.position, center.position, "the model is sent the side, not center");
  }
});

test("a model that sizes the canvas itself refuses an anchor other than center", async (t) => {
  const { h, offset } = await boot(t);
  await assert.rejects(
    () => h.capture_reference({ purpose: "expand", model_id: EXACT, expand: { aspect: "16:9", anchor: "right" } }, A),
    (e) => e.type === "InvalidParameter" && /centered/.test(e.message)
  );
  const c = await offset(EXACT, "center");
  assert.ok(c.offset[0] > 0);
});
