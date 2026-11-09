"use strict";
// Modal scopes (live finding of 2026-10-21: docked panels could not be
// resized while an agent drove the plugin, the panel showed the host's raw
// "host is in a modal state", and the first Keep take right after a
// placement did nothing):
// - every modal scope holds only the document read or change itself, never
//   a network wait, an upload, a poll, a download or a price check;
// - the plugin's own scopes run one after the other, so a Keep take waits
//   for a thumbnail read instead of being refused;
// - a scope Photoshop refuses as busy is tried again, then reads one plain
//   line, typed PhotoshopBusy.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { bootGenerate } = require("../helpers/generate-sim.js");
const { waitFor } = require("../helpers/fakes.js");
const { REFRAME } = require("../helpers/reframe-record.js");
const ctlMod = require("../../plugin/src/panel/controller.js");

const SRC = path.join(__dirname, "../../plugin/src");
const BUSY = "Photoshop is busy. Try again in a moment.";

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

// The body of the function passed to each modal(...) or inState(...) call.
function scopes(file) {
  const s = stripComments(fs.readFileSync(path.join(SRC, file), "utf8"));
  const out = [];
  const re = /\b(?:I\.)?(?:modal|inState|executeAsModal)\(/g;
  let m;
  while ((m = re.exec(s))) {
    if (/function\s+$/.test(s.slice(Math.max(0, m.index - 12), m.index))) continue;
    const f = s.indexOf("function", m.index);
    const open = s.indexOf("{", f);
    if (f < 0 || open < 0 || f - m.index > 120) continue;
    let depth = 0;
    let i = open;
    for (; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}" && --depth === 0) break;
    }
    out.push({ at: s.slice(0, m.index).split("\n").length, body: s.slice(open, i + 1) });
  }
  return out;
}

test("no modal scope wraps a network call, an upload, a poll, a download, a price check or a wait", () => {
  const forbidden = /\b(fetch|XMLHttpRequest|request|upload\w*|download\w*|poll\w*|estimate|quote\w*|price\w*|runner|client|approve|setTimeout|sleep|delay)\s*\(/;
  let n = 0;
  for (const file of ["host.js", "host-more.js", "agents/ps-host.js", "dev/live-run.js"]) {
    for (const sc of scopes(file)) {
      n++;
      const hit = forbidden.exec(sc.body);
      assert.equal(hit, null, `${file} line ${sc.at}: a modal scope calls ${hit && hit[1]}()`);
    }
  }
  assert.ok(n >= 25, `the scan found the scopes (${n})`);
});

test("a whole Extend run (upload, price, poll, download, placement): no Scenario request while a modal scope is open", async (t) => {
  const DOC = { id: 7, title: "poster.psd", width: 1024, height: 768 };
  const sim = await bootGenerate(t, {
    docs: [DOC],
    active: 7,
    psOpts: { scene: true },
    mockOpts: {
      extraRecords: { [REFRAME.id]: REFRAME },
      answer: (model) => (model === REFRAME.id ? { status: 200, body: { creativeUnitsCost: 21, creativeUnitsDiscount: 0, costDetails: {} } } : undefined)
    }
  });
  const { app, doc, ps, mock } = sim;
  const core = ps.modules.photoshop.core;
  const real = core.executeAsModal.bind(core);
  let open = 0;
  let scopesRun = 0;
  core.executeAsModal = async (fn, opts) =>
    real(async (ctx) => {
      open++;
      scopesRun++;
      try {
        return await fn(ctx);
      } finally {
        open--;
      }
    }, opts);
  const during = [];
  for (const list of [mock.requests, mock.cdnRequests]) {
    const push = list.push.bind(list);
    list.push = (...rows) => {
      if (open > 0) during.push(rows.map((r) => r.path || r.url || JSON.stringify(r).slice(0, 80)));
      return push(...rows);
    };
  }
  ps.entrypoints.panels.scenarioPanel.show();
  await waitFor(() => app.controller.state().active, { label: "panel shown" });
  const all = (attr, v) => doc.all.filter((e) => e.getAttribute(attr) === v);
  await waitFor(() => all("data-pop", "more").length >= 1, { label: "More" });
  all("data-pop", "more")[0].click();
  await waitFor(() => all("data-pick", "extend").length >= 1, { label: "Extend" });
  all("data-pick", "extend")[0].children[0].click();
  await waitFor(() => /21 CU/.test(doc.text("go-cu")), { label: "priced", timeout: 5000 });
  doc.byId("go").click();
  await waitFor(() => app.ledger.all()[0] && app.ledger.all()[0].state === "applied", { label: "applied", timeout: 8000 });
  assert.ok(scopesRun >= 2, `modal scopes ran (${scopesRun})`);
  assert.ok(mock.uploads.length >= 1 && mock.paidCalls.length === 1, "the run uploaded and generated");
  assert.deepEqual(during, [], "no request was made while a modal scope was open");
});

test("the plugin's own scopes queue: a scope asked while another runs waits for it and is never refused", async (t) => {
  const sim = await bootGenerate(t, { docs: [{ id: 7, title: "poster.psd", width: 512, height: 512 }], active: 7 });
  const { host, ps } = sim;
  const before = ps.modals.length;
  const read = host.readPixels({ document_id: 7, layer_id: null, bounds: { left: 0, top: 0, width: 512, height: 512 }, long_side: 96, exact: true });
  const sel = host.readSelectionMask(7);
  const other = host.readPixels({ document_id: 7, layer_id: null, bounds: { left: 0, top: 0, width: 64, height: 64 }, long_side: 32, exact: true });
  const [a, , c] = await Promise.all([read, sel, other]);
  assert.equal(a.width, 96);
  assert.equal(c.width, 32);
  assert.equal(ps.modals.length - before, 3, "three scopes, no refused try");
  // A failing scope does not block the next one.
  await assert.rejects(host.readPixels({ document_id: 99, bounds: { left: 0, top: 0, width: 8, height: 8 }, exact: true }), /closed/);
  await host.readSelectionMask(7);
});

test("Photoshop busy: a refused scope is tried again; still busy, it reads one plain line typed PhotoshopBusy", async (t) => {
  const sim = await bootGenerate(t, { docs: [{ id: 7, title: "poster.psd", width: 512, height: 512 }], active: 7 });
  const { host, ps } = sim;
  ps.busy = 2;
  await host.readSelectionMask(7);
  assert.equal(ps.busy, 0, "refused twice, then it ran");
  ps.busy = 9;
  await assert.rejects(host.readSelectionMask(7), (e) => {
    assert.equal(e.message, BUSY);
    assert.equal(e.type, "PhotoshopBusy");
    assert.equal(e.busy, true);
    assert.match(e.cause_text, /modal state/);
    return true;
  });
  ps.busy = 0;
});

test("the panel never shows the host's raw modal text", () => {
  assert.equal(ctlMod.errText(new Error("host is in a modal state")), BUSY);
  assert.equal(ctlMod.errText(Object.assign(new Error("anything"), { busy: true })), BUSY);
  assert.equal(ctlMod.errText(new Error("the document was closed")), "the document was closed");
  assert.equal(ctlMod.errText("plain"), "plain");
});
