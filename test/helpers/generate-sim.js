"use strict";
// Boots the plugin source (main.js) on the real host adapter (host.js) over
// the fake Photoshop modules, against the fixture mock with paid generation
// on, and signs in through the panel. Results download from the mock's own
// CDN routes; polling runs every 20 ms. Used by the M3 generation tests.

const { webcrypto } = require("node:crypto");
const main = require("../../plugin/src/main.js");
const hostMod = require("../../plugin/src/host.js");
const { createFakeDocument } = require("./fake-dom.js");
const { createFakePhotoshop } = require("./fake-photoshop.js");
const { startFixtureScenario } = require("./fixture-scenario.js");
const { newKeyPair, projectRecord } = require("./mock-scenario.js");
const { uxpWebSocket, freePort, newToken, waitFor } = require("./fakes.js");

const FLARE = "model_openai-gpt-image-2-5-flare";

// opts: { docs, active, mockOpts, psOpts, pollMs, signIn (default true) }
async function bootGenerate(t, opts = {}) {
  const pair = newKeyPair();
  const mock = await startFixtureScenario({ accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "Generate project" })] }], paid: true, ...(opts.mockOpts || {}) });
  const port = await freePort();
  const secure = new Map([["scenario.pairing_token", newToken()]]);
  const ps = createFakePhotoshop({ docs: opts.docs || [], active: opts.active, secure, ...(opts.psOpts || {}) });
  const clipboard = { text: null, writeText: async (v) => (clipboard.text = v), readText: async () => clipboard.text || "" };
  const timers = new Set();
  let stopped = false;
  const g = {
    WebSocket: uxpWebSocket({ rewrite: (u) => u.replace(":9890", `:${port}`) }),
    crypto: webcrypto,
    fetch: (url, init) => globalThis.fetch(url, init),
    AbortController: globalThis.AbortController,
    setTimeout: (fn, ms) => {
      if (stopped) return null;
      const h = setTimeout(() => {
        timers.delete(h);
        fn();
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
  const pollMs = opts.pollMs || 20;
  // URL and Blob as UXP 9.4 has them: reference chips show blob links.
  const global = { URL: globalThis.URL, Blob: globalThis.Blob };
  const app = await main.boot({ host, document: doc, console: null, global, apiBaseUrl: mock.url, downloadOrigins: [mock.origin], pollDelay: () => pollMs });
  t.after(async () => {
    stopped = true;
    for (const h of timers) clearTimeout(h);
    app.link.stop();
    await mock.close();
  });
  if (opts.signIn !== false) {
    doc.paste("signin-key", `${pair.key}:${pair.secret}`);
    doc.byId("signin-save").click();
    await waitFor(() => doc.shown("view-main"), { label: "signed in" });
  }
  // port and token let an agent test start a real helper against this plugin.
  return { app, host, doc, mock, ps, pair, clipboard, port, token: secure.get("scenario.pairing_token") };
}

// The ledger records on disk, parsed.
function ledgerFiles(ps) {
  const out = [];
  for (const [k, v] of ps.files) if (/^jobs\/[0-9a-f-]{36}\.json$/.test(k)) out.push(JSON.parse(typeof v === "string" ? v : Buffer.from(v).toString("utf8")));
  return out;
}

module.exports = { bootGenerate, ledgerFiles, FLARE };
