"use strict";
// Runs a plugin bundle (plugin/dist/main.js as built) the way UXP would: in a
// fresh V8 context whose require answers the UXP module names only (uxp,
// photoshop, os, fs), with a UXP-like WebSocket, fetch, AbortController, the
// clipboard and a DOM built from the real index.html.
//
// fetch sends https://api.cloud.scenario.com to opts.api (a mock Scenario API)
// and refuses every other host, recording it in `elsewhere`. Every frame the
// plugin sends on a link socket, every clipboard write and every page opened
// with uxp.shell.openExternal is recorded, so a test can check what left the
// plugin.

const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { uxpWebSocket } = require("./fakes.js");
const { createFakeDocument } = require("./fake-dom.js");

const API_ORIGIN = "https://api.cloud.scenario.com";

// opts: { port, secure: Map, files: Map, refuse(url), api: "http://127.0.0.1:N", macPassword }
function runBundle(code, { port, secure = new Map(), files = new Map(), refuse, api = null, macPassword = true } = {}) {
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
  const enc = new TextEncoder();

  function bundleFetch(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (dead) return Promise.reject(new TypeError("Photoshop has quit"));
    if (api && (url === API_ORIGIN || url.startsWith(`${API_ORIGIN}/`))) return globalThis.fetch(api + url.slice(API_ORIGIN.length), init);
    elsewhere.push(url);
    return Promise.reject(new TypeError(`Network request refused by the test: ${url}`));
  }

  const modules = {
    uxp: {
      host: { version: "27.11.0", name: "Photoshop" },
      entrypoints: { setup: (def) => entrypoints.push(def) },
      shell: {
        openExternal: async (url) => {
          opened.push(url);
          return "";
        }
      },
      storage: {
        secureStorage: {
          // UXP returns a Uint8Array, not a string (verified live on 27.11).
          getItem: async (k) => (secure.has(k) ? enc.encode(secure.get(k)) : null),
          setItem: async (k, v) => secure.set(k, String(v)),
          removeItem: async (k) => secure.delete(k)
        }
      }
    },
    photoshop: {
      app: {
        version: "27.11.0",
        documents: [
          { id: 7, title: "cover.psd" },
          { id: 8, title: "Untitled-2" }
        ],
        activeDocument: { id: 8, title: "Untitled-2" }
      }
    },
    os: { platform: () => "darwin", release: () => "25.5.0" },
    fs: {
      readFile: async (p) => {
        const name = p.replace("plugin-data:/", "");
        if (!files.has(name)) throw new Error(`ENOENT ${p}`);
        return files.get(name);
      },
      writeFile: async (p, text) => files.set(p.replace("plugin-data:/", ""), String(text)),
      unlink: async (p) => {
        const name = p.replace("plugin-data:/", "");
        if (!files.delete(name)) throw new Error(`ENOENT ${p}`);
      }
    }
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

module.exports = { runBundle, API_ORIGIN };
