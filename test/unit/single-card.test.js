"use strict";
// Two live findings of 2026-10-21, through the panel's own elements:
// - Extend canvas lands as a single result card, and that card showed none
//   of the badges its checks recorded (a step and a repeated detail at the
//   old edge), where a Takes card shows them on each take;
// - after a price change after the upload (New angle, 1 CU to 14 CU), the
//   composer's button kept the first quote while the run card showed the
//   new one.

const test = require("node:test");
const assert = require("node:assert/strict");
const png = require("../../plugin/src/util/png.js");
const { bootGenerate, FLARE } = require("../helpers/generate-sim.js");
const { waitFor } = require("../helpers/fakes.js");
const { REFRAME } = require("../helpers/reframe-record.js");

const cost = (n) => ({ status: 200, body: { creativeUnitsCost: n, creativeUnitsDiscount: 0, costDetails: { "custom-generation": n } } });
const go = (doc) => doc.text("go-label") + (doc.text("go-cu") ? " " + doc.text("go-cu") : "");
const shown = (doc, id) => doc.byId(id).style.display !== "none" && doc.byId(id).style.display !== undefined && doc.byId(id).style.display !== "";

function attached(doc, el) {
  for (let n = el; n; n = n.parentNode) if (n.id && doc.els.get(n.id) === n) return true;
  return false;
}
function findAll(doc, attr, value) {
  return doc.all.filter((e) => e.getAttribute(attr) !== null && (value === undefined || e.getAttribute(attr) === String(value)) && attached(doc, e));
}
async function show(app, ps) {
  ps.entrypoints.panels.scenarioPanel.show();
  await waitFor(() => app.controller.state().active, { label: "panel shown" });
}

// The new canvas with the original in place and the new area one flat
// color: it lines up on the overlap, and the old edge shows a step.
function flatTake(ps, w, h, ow, oh, ox, oy, fill) {
  const ctx = ps.composite(7, { left: 0, top: 0, width: ow, height: oh }, ow, oh);
  const out = { width: w, height: h, components: 3, data: new Uint8Array(w * h * 3) };
  for (let i = 0; i < w * h; i++) out.data.set(fill, i * 3);
  for (let y = 0; y < oh; y++) out.data.set(ctx.data.subarray(y * ow * 3, (y + 1) * ow * 3), ((y + oy) * w + ox) * 3);
  return Buffer.from(png.encodePng({ width: w, height: h, channels: 3, data: out.data }));
}

test("Extend canvas, one result: the single card shows the badge its checks gave, and each check in words", async (t) => {
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 768 };
  let ps;
  const sim = await bootGenerate(t, {
    docs: [DOC],
    active: 7,
    psOpts: { scene: true },
    mockOpts: {
      extraRecords: { [REFRAME.id]: REFRAME },
      answer: (model) => (model === REFRAME.id ? cost(21) : undefined),
      cdn: (r) => (/Take1$/.test(decodeURIComponent(r.path.split("/")[2] || "")) ? { status: 200, body: flatTake(ps, 1365, 768, 1024, 768, 171, 0, [90, 140, 120]), headers: { "content-type": "image/png" } } : undefined)
    }
  });
  ps = sim.ps;
  const { app, doc } = sim;
  await show(app, ps);
  // In this context Extend canvas sits under More.
  await waitFor(() => findAll(doc, "data-pop", "more").length === 1, { label: "the More chip" });
  findAll(doc, "data-pop", "more")[0].click();
  await waitFor(() => findAll(doc, "data-pick", "extend").length === 1, { label: "Extend under More" });
  findAll(doc, "data-pick", "extend")[0].children[0].click();
  await waitFor(() => go(doc) === "Extend canvas · 21 CU", { label: `priced (now ${go(doc)})`, timeout: 5000 });
  doc.byId("go").click();
  const rec = await waitFor(() => {
    const r = app.ledger.all()[0];
    return r && r.state === "applied" ? r : null;
  }, { label: "applied", timeout: 8000 });
  assert.equal(rec.model_id, REFRAME.id, "Reframe is the Extend default");
  assert.ok(rec.placement.badges[0].includes("Step at the old edge"), JSON.stringify(rec.placement.badges));
  const card = await waitFor(() => {
    const c = app.controller.model().card;
    return c && c.kind === "single" ? c : null;
  }, { label: "the single card" });
  assert.deepEqual(card.badge, { tone: "warn", text: "Edge may show" });
  assert.deepEqual(card.checks, rec.placement.badges[0]);
  assert.equal(card.tone, "warn");
  await waitFor(() => findAll(doc, "data-badge", "single").length === 1, { label: "the badge drawn on the card" });
  const text = findAll(doc, "data-card", "single")[0].textContent;
  assert.match(text, /Edge may show/);
  for (const b of rec.placement.badges[0]) assert.ok(text.includes(b), `the card names "${b}" (${text})`);
});

test("a price change after the upload: the composer's button shows the new price while the run waits and runs", async (t) => {
  let fx = null;
  const refPrice = (body) => (!body.referenceImages ? 2 : body.referenceImages.some((id) => (fx.assets.get(id) || {}).width !== 256) ? 5 : 3);
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [{ id: 7, title: "poster.psd", width: 1024, height: 1024 }], active: 7, mockOpts: { answer: (model, body) => (model === FLARE ? cost(refPrice(body)) : null) } });
  fx = mock;
  await show(app, ps);
  findAll(doc, "data-act", "new_layer")[0].click();
  await waitFor(() => findAll(doc, "data-pop", "addref").length === 1, { label: "the add tile" });
  findAll(doc, "data-pop", "addref")[0].click();
  await waitFor(() => doc.byId("pop").getAttribute("data-menu") === "addref", { label: "menu" });
  findAll(doc, "data-value", "visible").find((e) => {
    for (let n = e; n; n = n.parentNode) if (n === doc.byId("pop")) return true;
    return false;
  }).click();
  await waitFor(() => app.controller.state().refs === 1, { label: "reference added" });
  doc.type("prompt", "A paper kite");
  await waitFor(() => go(doc) === "New layer · 3 CU", { label: `priced (now ${go(doc)})`, timeout: 4000 });
  doc.byId("go").click();
  await waitFor(() => shown(doc, "confirm-card"), { label: "the price-changed card" });
  assert.match(doc.text("confirm-text"), /Now 5 CU \(was 3 CU\)/);
  // The composer re-prices after the click with the stand-in (3 CU); the
  // button shows the price the same request has after its upload.
  await waitFor(() => go(doc) === "New layer · 5 CU", { label: `the button at the new price while waiting (now ${go(doc)})`, timeout: 4000 });
  doc.byId("confirm-ok").click();
  await waitFor(() => app.ledger.all()[0] && app.ledger.all()[0].state === "applied", { label: "applied", timeout: 8000 });
  assert.equal(mock.paidCalls.length, 1);
});
