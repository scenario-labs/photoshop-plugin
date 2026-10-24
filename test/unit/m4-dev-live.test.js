"use strict";
// The development-only live entry (plugin/src/dev/live-run.js) on the fake
// Photoshop: a request file in the data folder makes a document from a
// fixture, sets the selection, prices and runs a lane through lanes/flow.js,
// waits for the result to land, writes the result and the composites, and
// closes only the documents it made. Release bundles carry a stub
// (test/unit/bundle.test.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const devLive = require("../../plugin/src/dev/live-run.js");
const { bootGenerate, FLARE } = require("../helpers/generate-sim.js");
const { solidPng } = require("../helpers/fixture-scenario.js");
const { waitFor } = require("../helpers/fakes.js");

function costAnswer(cu) {
  return { status: 200, body: { creativeUnitsCost: cu, creativeUnitsDiscount: 0, costDetails: { "custom-generation": cu } } };
}

test("dev live run: a request file runs an Edit end to end on a document it makes, then closes it; a person's document is never touched", async (t) => {
  const PERSON = { id: 3, title: "theirs.psd", width: 800, height: 600 };
  const { app, ps, mock } = await bootGenerate(t, { docs: [PERSON], active: 3, psOpts: { scene: true }, mockOpts: { answer: (model, body) => (model === FLARE && body.referenceImages ? costAnswer(2) : undefined) } });
  ps.files.set("dev-live/fixture.png", new Uint8Array(solidPng(512, 512, [90, 120, 160])));
  const runner = devLive.start(app, ps.require, { poll: true });
  t.after(() => runner.stop());
  ps.files.set(devLive.REQUEST, JSON.stringify({
    id: "edit-1",
    route: "edit",
    document: { width: 512, height: 512, fixture: "dev-live/fixture.png", flatten: true },
    selection: { left: 192, top: 192, width: 128, height: 128, shape: "ellipse", feather: 2 },
    run: { tool: "edit", prompt: "a red ball", takes: 1 },
    spend: true,
    max_cu: 5,
    timeout_s: 20
  }));
  const text = await waitFor(() => ps.files.get("dev-live/edit-1/result.json"), { label: "result written", timeout: 15000 });
  const r = JSON.parse(text);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state, "applied");
  assert.equal(r.quote.label, "2 CU");
  assert.equal(r.view.source.text, "Selection 128 x 128");
  assert.ok(r.placement.badges, "the check results are in the result");
  assert.ok(ps.files.get("dev-live/edit-1/before.png") && ps.files.get("dev-live/edit-1/after.png"));
  assert.equal(ps.files.has(devLive.REQUEST), false, "the request file is removed when read");
  assert.equal(r.closed, true);
  assert.deepEqual(ps.app.documents.map((d) => d.id), [3], "its own document closed; the person's stays");
  assert.equal(ps.doc(3).layers.length, 1);
  assert.equal(mock.paidCalls.length, 1);
});

test("dev live run: price only without spend; a price above max_cu sends nothing", async (t) => {
  const { app, ps, mock } = await bootGenerate(t, { docs: [], psOpts: { scene: true } });
  ps.files.set("dev-live/fixture.png", new Uint8Array(solidPng(512, 512, [90, 120, 160])));
  const runner = devLive.start(app, ps.require, { poll: false });
  const priced = await runner.run({ id: "p1", document: { width: 512, height: 512, fixture: "dev-live/fixture.png", flatten: true }, run: { tool: "edit", prompt: "x", takes: 1 } });
  assert.equal(priced.ok, true, priced.error);
  assert.equal(priced.state, "priced");
  const refused = await runner.run({ id: "p2", document: { width: 512, height: 512, fixture: "dev-live/fixture.png", flatten: true }, run: { tool: "edit", prompt: "x", takes: 1 }, spend: true, max_cu: 1 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /above max_cu; nothing sent/);
  assert.equal(mock.paidCalls.length, 0);
  assert.equal(ps.app.documents.length, 0);
});
