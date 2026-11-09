"use strict";
// Restart simulation for M5 (SPEC 12.2 item 9): the plugin source (main.js)
// boots on the real host adapter over a fake Photoshop, against the fixture
// mock, with the development test hooks on. quit() is Photoshop quitting:
// timers stop and every file, storage and Photoshop call of that instance
// fails, so work held at a hook writes nothing more. A restart boots a new
// instance on the same data folder (`files`) and secure storage (`secure`)
// with the documents the test opens, against the same mock Scenario.

const { webcrypto } = require("node:crypto");
const main = require("../../plugin/src/main.js");
const hostMod = require("../../plugin/src/host.js");
const { createFakeDocument } = require("./fake-dom.js");
const { createFakePhotoshop } = require("./fake-photoshop.js");
const { startFixtureScenario } = require("./fixture-scenario.js");
const { newKeyPair, projectRecord } = require("./mock-scenario.js");
const { uxpWebSocket, freePort, newToken, waitFor } = require("./fakes.js");

// A world: one mock Scenario, one key pair, one data folder, one secure
// storage. opts: { mockOpts, projects (extra accounts: [{name}]) }
async function createWorld(t, opts = {}) {
  const pair = newKeyPair();
  const accounts = [{ ...pair, projects: [projectRecord(pair.key, { name: "Restart project", id: "project_restart1" })] }];
  const extra = [];
  for (const p of opts.projects || []) {
    const other = newKeyPair();
    accounts.push({ ...other, projects: [projectRecord(other.key, { name: p.name, id: p.id })] });
    extra.push(other);
  }
  const mock = await startFixtureScenario({ accounts, paid: true, ...(opts.mockOpts || {}) });
  const files = new Map();
  const secure = new Map([["scenario.pairing_token", newToken()]]);
  const running = new Set();
  t.after(async () => {
    for (const r of running) r.quit();
    await mock.close();
  });

  // opts: { docs, active, signIn (first boot), pollMs, offlineMs, psOpts,
  // blockedTexts }
  async function boot(bo = {}) {
    const port = await freePort();
    const ps = createFakePhotoshop({ docs: bo.docs || [], active: bo.active, files, secure, ...(bo.psOpts || {}) });
    const timers = new Set();
    let stopped = false;
    const clipboard = { text: null, writeText: async (v) => (clipboard.text = v), readText: async () => clipboard.text || "" };
    const g = {
      WebSocket: uxpWebSocket({ rewrite: (u) => u.replace(":9890", `:${port}`) }),
      crypto: webcrypto,
      fetch: (url, init) => (stopped ? Promise.reject(new Error("Photoshop quit")) : globalThis.fetch(url, init)),
      AbortController: globalThis.AbortController,
      setTimeout: (fn, ms) => {
        if (stopped) return null;
        const h = setTimeout(() => {
          timers.delete(h);
          if (!stopped) fn();
        }, ms);
        timers.add(h);
        return h;
      },
      clearTimeout: (h) => {
        timers.delete(h);
        clearTimeout(h);
      },
      navigator: { clipboard }
    };
    const host = hostMod.createHost(ps.require, g);
    const doc = createFakeDocument();
    const pollMs = bo.pollMs || 20;
    const app = await main.boot({ host, document: doc, console: null, apiBaseUrl: mock.url, downloadOrigins: [mock.origin], pollDelay: () => pollMs, offlineMs: bo.offlineMs || 50, testHooks: true, blockedTexts: bo.blockedTexts });
    const inst = {
      app,
      ps,
      doc,
      host,
      quit() {
        if (stopped) return;
        stopped = true;
        for (const h of timers) clearTimeout(h);
        timers.clear();
        try {
          app.link.stop();
        } catch {
          // already stopped
        }
        ps.halt();
        running.delete(inst);
      }
    };
    running.add(inst);
    if (bo.signIn) {
      doc.paste("signin-key", `${pair.key}:${pair.secret}`);
      doc.byId("signin-save").click();
      await waitFor(() => doc.shown("view-main"), { label: "signed in" });
    }
    return inst;
  }

  return { mock, pair, extra, files, secure, boot };
}

// The job records on disk, parsed (the copy a restart reads).
function onDisk(files) {
  const out = {};
  for (const [k, v] of files) {
    const m = /^jobs\/([0-9a-f-]{36})\.json$/.exec(k);
    if (m) out[m[1]] = JSON.parse(typeof v === "string" ? v : Buffer.from(v).toString("utf8"));
  }
  return out;
}

module.exports = { createWorld, onDisk };
