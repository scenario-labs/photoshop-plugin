"use strict";
// The prompt box's height (ui/prompt-size.js): the grip on the composer's top
// edge drags it taller within the room the middle can give, double-click goes
// back to the stylesheet's height, and the height is kept on this computer.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeDocument } = require("../helpers/fake-dom");
const ps = require("../../plugin/src/ui/prompt-size.js");

function memoryStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

// The middle is midH px tall (with the field at its current height).
function setup({ midH = 300, saved } = {}) {
  const doc = createFakeDocument();
  const store = memoryStore(saved === undefined ? {} : { [ps.KEY]: String(saved) });
  doc.byId("sc-body").getBoundingClientRect = () => ({ width: 320, height: midH });
  const g = { localStorage: store, innerWidth: 320, innerHeight: 700, addEventListener() {} };
  const sizer = ps.attachPromptSize(doc, g);
  return { doc, store, sizer };
}

test("the markup has the grip on the composer's top edge and an id on the prompt's box", () => {
  const doc = createFakeDocument();
  assert.ok(doc.byId("composer-grip"));
  assert.equal(doc.byId("pfield").className, "pfield");
});

test("dragging the grip up makes the prompt taller; the field keeps its 4 px over its box", () => {
  const { doc, store, sizer } = setup();
  doc.byId("composer-grip").dispatch("mousedown", { clientY: 400 });
  doc.fire("mousemove", { clientY: 300, buttons: 1 });
  assert.equal(sizer.height(), 144);
  assert.equal(doc.byId("pfield").style.height, "144px");
  assert.equal(doc.byId("prompt").style.height, "148px");
  doc.fire("mouseup");
  assert.equal(store.m.get(ps.KEY), "144");
});

test("the middle keeps its minimum, and the box never goes under its stylesheet height", () => {
  const { doc, sizer } = setup({ midH: 100 });
  const grip = doc.byId("composer-grip");
  grip.dispatch("mousedown", { clientY: 400 });
  doc.fire("mousemove", { clientY: 0, buttons: 1 });
  assert.equal(sizer.height(), ps.BASE + 100 - ps.MID_MIN);
  doc.fire("mousemove", { clientY: 900, buttons: 1 });
  assert.equal(sizer.height(), ps.BASE);
  assert.equal(ps.dragHeight(ps.BASE, -5000, 5000), ps.MAX);
});

test("a move with no button down ends the drag (the button came up outside the panel)", () => {
  const { doc, store, sizer } = setup();
  doc.byId("composer-grip").dispatch("mousedown", { clientY: 400 });
  doc.fire("mousemove", { clientY: 350, buttons: 1 });
  doc.fire("mousemove", { clientY: 100, buttons: 0 });
  assert.equal(sizer.height(), 94);
  assert.equal(store.m.get(ps.KEY), "94");
  doc.fire("mousemove", { clientY: 50, buttons: 1 });
  assert.equal(sizer.height(), 94);
});

test("double-click goes back to the stylesheet's height", () => {
  const { doc, store, sizer } = setup({ saved: 200 });
  assert.equal(sizer.height(), 200);
  doc.byId("composer-grip").dispatch("dblclick");
  assert.equal(sizer.height(), ps.BASE);
  assert.equal(store.m.get(ps.KEY), String(ps.BASE));
});

test("a kept height comes back within the room the panel has, and a bad value is ignored", () => {
  assert.equal(setup({ saved: 120, midH: 300 }).sizer.height(), 120);
  assert.equal(setup({ saved: 300, midH: 120 }).sizer.height(), ps.BASE + 120 - ps.MID_MIN);
  assert.equal(setup({ saved: "tall" }).sizer.height(), ps.BASE);
  assert.equal(ps.readSaved({ getItem() { throw new Error("refused"); } }), ps.BASE);
});
