"use strict";
// Runs a plugin bundle (plugin/dist/main.js as built) the way UXP would: in a
// fresh V8 context whose require answers the UXP module names only (uxp,
// photoshop, os, fs, from test/helpers/fake-photoshop.js), with a UXP-like
// WebSocket, fetch, AbortController, the clipboard and a DOM built from the
// real index.html.
//
// fetch sends https://api.cloud.scenario.com to opts.api (a mock Scenario API)
// and https://cdn.cloud.scenario.com to opts.cdn (the mock's CDN routes; the
// answer's url reads as the CDN's again), and refuses every other host,
// recording it in `elsewhere`. Every frame the
// plugin sends on a link socket, every clipboard write and every page opened
// with uxp.shell.openExternal is recorded, so a test can check what left the
// plugin.

const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { uxpWebSocket } = require("./fakes.js");
const { createFakeDocument } = require("./fake-dom.js");
const { createFakePhotoshop } = require("./fake-photoshop.js");

const API_ORIGIN = "https://api.cloud.scenario.com";
const CDN_ORIGIN = "https://cdn.cloud.scenario.com";

// opts: { port, secure: Map, files: Map, refuse(url), api: "http://127.0.0.1:N",
//         cdn: "http://127.0.0.1:N", macPassword, photoshop: fake options
//         (docs, active, ...) }
function runBundle(code, { port, secure = new Map(), files = new Map(), refuse, api = null, cdn = null, macPassword = true, photoshop = null } = {}) {
  const timers = new Set();
  const sockets = new Set();
  const frames = [];
  const elsewhere = [];
  const opened = [];
  let dead = false;
  const Base = uxpWebSocket({ rewrite: (url) => url.replace(":9890", `:${port}`), refuse });
  class TrackedWebSocket extends Base {
    constructor(url) {
      if (dead) throw new Error("Photoshop has quit");
      super(url);
      sockets.add(this);
    }
    send(data, ...rest) {
      frames.push(Buffer.isBuffer(data) ? data.toString("utf8") : typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
      return super.send(data, ...rest);
    }
  }
  const clipboard = {
    text: null,
    history: [],
    writeText: async (t) => {
      clipboard.text = t;
      clipboard.history.push(String(t));
    },
    readText: async () => clipboard.text || ""
  };
  const doc = createFakeDocument({ macPassword });
  const logs = [];
  const entrypoints = [];

  // The answer as UXP's fetch gives it, with the url the plugin asked for.
  function asCdn(res) {
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      url: String(res.url).replace(cdn, CDN_ORIGIN),
      text: () => res.text(),
      arrayBuffer: () => res.arrayBuffer()
    };
  }

  function bundleFetch(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (dead) return Promise.reject(new TypeError("Photoshop has quit"));
    if (api && (url === API_ORIGIN || url.startsWith(`${API_ORIGIN}/`))) return globalThis.fetch(api + url.slice(API_ORIGIN.length), init);
    if (cdn && url.startsWith(`${CDN_ORIGIN}/`)) return globalThis.fetch(cdn + url.slice(CDN_ORIGIN.length), init).then(asCdn);
    elsewhere.push(url);
    return Promise.reject(new TypeError(`Network request refused by the test: ${url}`));
  }

  // UXP returns a Uint8Array from secureStorage, not a string (verified live
  // on 27.11); the fake does the same.
  const ps = createFakePhotoshop({
    docs: [
      { id: 7, title: "cover.psd", width: 2400, height: 1600 },
      { id: 8, title: "Untitled-2", width: 1024, height: 1024 }
    ],
    active: 8,
    ...(photoshop || {}),
    files,
    secure
  });
  const modules = ps.modules;
  modules.uxp.entrypoints.setup = (def) => entrypoints.push(def);
  modules.uxp.shell.openExternal = async (url) => {
    opened.push(url);
    return "";
  };
  const context = vm.createContext({
    require: (name) => {
      if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
      throw new Error(`Cannot find module '${name}'`);
    },
    WebSocket: TrackedWebSocket,
    fetch: bundleFetch,
    AbortController: globalThis.AbortController,
    crypto: webcrypto,
    setTimeout: (fn, ms) => {
      if (dead) return null;
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
      return t;
    },
    clearTimeout: (t) => {
      timers.delete(t);
      clearTimeout(t);
    },
    navigator: { clipboard },
    document: doc,
    console: { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)) }
  });
  vm.runInContext(code, context, { filename: "dist/main.js" });
  return {
    doc,
    ps,
    secure,
    files,
    logs,
    clipboard,
    entrypoints,
    frames,
    elsewhere,
    opened,
    // Photoshop quitting: every timer and socket of this plugin instance ends.
    kill() {
      dead = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const s of sockets) s.terminate();
    }
  };
}

module.exports = { runBundle, API_ORIGIN, CDN_ORIGIN };
