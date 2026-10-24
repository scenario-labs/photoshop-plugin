"use strict";
// Test doubles: a UXP-like WebSocket (sends the Origin and User-Agent the UXP
// WebSocket sends on Photoshop 27.11), a fake Photoshop host, free ports, and
// a small wait helper. Tokens are generated per test; none is stored.

const net = require("node:net");
const crypto = require("node:crypto");
const WS = require("ws");

const UXP_ORIGIN = "file://";
const UXP_AGENT = "WebSocket++/0.8.2";

// Returns a WebSocket class with the browser-style API the plugin uses.
// opts.refuse(url) -> true makes the constructor throw, like a missing manifest entry.
// opts.rewrite(url) -> url lets a test point the plugin at another port.
function uxpWebSocket(opts = {}) {
  return class UxpLikeWebSocket extends WS {
    constructor(url) {
      if (opts.refuse && opts.refuse(url)) {
        throw new Error(`Permission denied to connect to ${url}. Manifest entry not found.`);
      }
      const target = opts.rewrite ? opts.rewrite(url) : url;
      const headers = {};
      if (opts.userAgent !== null) headers["User-Agent"] = opts.userAgent || UXP_AGENT;
      const options = { perMessageDeflate: false, headers };
      if (opts.origin !== null) options.origin = opts.origin === undefined ? UXP_ORIGIN : opts.origin;
      super(target, options);
      this.on("error", () => {});
    }
  };
}

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function fakeHost(over = {}) {
  const secure = new Map(over.secure || []);
  const files = new Map(over.files || []);
  const host = {
    secure,
    files,
    docs: over.docs || [
      { id: 101, title: "poster.psd" },
      { id: 102, title: "Untitled-1" }
    ],
    active: over.active === undefined ? 101 : over.active,
    clipboard: null,
    entrypoints: null,
    opened: [],
    WebSocket: over.WebSocket,
    fetch: over.fetch === undefined ? globalThis.fetch : over.fetch,
    AbortController: globalThis.AbortController,
    crypto: over.crypto === undefined ? crypto.webcrypto : over.crypto,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
      now: () => Date.now()
    },
    async secureGet(key) {
      return secure.has(key) ? secure.get(key) : null;
    },
    async secureSet(key, value) {
      if (over.secureSetFails && over.secureSetFails(key)) throw new Error("secure storage refused");
      secure.set(key, value);
    },
    async secureRemove(key) {
      secure.delete(key);
    },
    async openExternal(url) {
      host.opened.push(url);
      return "";
    },
    photoshopVersion: () => over.photoshopVersion || "27.11.0",
    osName: () => over.osName || "darwin 25.5.0",
    listDocuments: () => host.docs.map((d) => ({ id: d.id, title: d.title })),
    activeDocumentId: () => host.active,
    documentSize: (id) => {
      const want = id === null || id === undefined ? host.active : id;
      const d = host.docs.find((x) => x.id === want);
      return d ? { id: d.id, width: d.width || 1024, height: d.height || 1024 } : null;
    },
    async readDataText(name) {
      return files.has(name) ? files.get(name) : null;
    },
    async writeDataText(name, text) {
      files.set(name, text);
      return true;
    },
    async removeData(name) {
      return files.delete(name);
    },
    async clipboardWrite(text) {
      host.clipboard = text;
    },
    async clipboardClearIf(text) {
      if (host.clipboard !== text) return false;
      host.clipboard = "";
      return true;
    },
    setupEntrypoints(def) {
      host.entrypoints = def;
    }
  };
  return host;
}

function canBind(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (err) => resolve(err.code));
    s.listen({ port, host, exclusive: true, ipv6Only: host.includes(":") }, () => s.close(() => resolve(true)));
  });
}

let ipv6Cache = null;
async function hasIpv6() {
  if (ipv6Cache !== null) return ipv6Cache;
  ipv6Cache = (await canBind(0, "::1")) === true;
  return ipv6Cache;
}

// A port free on 127.0.0.1 and, when IPv6 loopback exists, on ::1.
async function freePort() {
  const v6 = await hasIpv6();
  for (let i = 0; i < 50; i++) {
    const port = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen({ port: 0, host: "127.0.0.1" }, () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    if (!v6 || (await canBind(port, "::1")) === true) return port;
  }
  throw new Error("no free port");
}

async function waitFor(fn, { timeout = 5000, interval = 20, label = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { uxpWebSocket, fakeHost, newToken, freePort, hasIpv6, waitFor, sleep, UXP_ORIGIN, UXP_AGENT };
