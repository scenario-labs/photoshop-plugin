"use strict";
// The bundle UXP loads (plugin/dist/main.js), run in a fresh V8 context with a
// fake UXP: the uxp, photoshop, os and fs modules, a UXP-like WebSocket, and a
// small DOM for the panel. Also checks what the release bundle must not hold
// and the .ccx package structure.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { webcrypto } = require("node:crypto");
const { bundle } = require("../../plugin/scripts/build.js");
const { packagePlugin, crc32 } = require("../../plugin/scripts/package.js");
const { Owner } = require("../../helper/src/link/owner.js");
const hp = require("../../helper/src/link/crypto.js");
const P = require("../../shared/protocol.json");
const { uxpWebSocket, freePort, newToken, waitFor, sleep } = require("../helpers/fakes.js");

const release = bundle({ dev: false });
const dev = bundle({ dev: true });

// A tiny DOM: what panel.js touches, nothing more.
function fakeDocument() {
  const els = new Map();
  function el(id, attrs = {}) {
    const handlers = {};
    const node = {
      id,
      textContent: "",
      className: "",
      attrs: { ...attrs },
      getAttribute: (k) => (k in node.attrs ? node.attrs[k] : null),
      setAttribute: (k, v) => (node.attrs[k] = String(v)),
      removeAttribute: (k) => delete node.attrs[k],
      addEventListener: (type, fn) => (handlers[type] = fn),
      click: () => handlers.click && handlers.click({ type: "click" })
    };
    return node;
  }
  for (const id of ["agent-dot", "link-dot", "link-headline", "link-detail", "token-value", "token-show", "token-copy", "token-reset", "token-note", "version", "lane-title", "lane-purpose", "lane-note", "project"]) {
    els.set(id, el(id));
  }
  const lanes = ["image", "edit", "enhance", "trained", "library"].map((id) => el(`lane-${id}`, { "data-lane": id }));
  return {
    els,
    lanes,
    getElementById: (id) => els.get(id) || null,
    querySelectorAll: (sel) => (sel === "[data-lane]" ? lanes : []),
    text: (id) => els.get(id).textContent
  };
}

// Runs a bundle as UXP would: hostRequire answers the UXP module names only.
function runBundle(code, { port, secure = new Map(), files = new Map(), refuse } = {}) {
  const timers = new Set();
  const sockets = new Set();
  let dead = false;
  const Base = uxpWebSocket({ rewrite: (url) => url.replace(":9890", `:${port}`), refuse });
  class TrackedWebSocket extends Base {
    constructor(url) {
      if (dead) throw new Error("Photoshop has quit");
      super(url);
      sockets.add(this);
    }
  }
  const clipboard = { text: null, writeText: async (t) => (clipboard.text = t) };
  const doc = fakeDocument();
  const logs = [];
  const entrypoints = [];
  const enc = new TextEncoder();
  const modules = {
    uxp: {
      host: { version: "27.11.0", name: "Photoshop" },
      entrypoints: { setup: (def) => entrypoints.push(def) },
      storage: {
        secureStorage: {
          // UXP returns a Uint8Array, not a string (verified live on 27.11).
          getItem: async (k) => (secure.has(k) ? enc.encode(secure.get(k)) : null),
          setItem: async (k, v) => secure.set(k, String(v))
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
    console: { log: (line) => logs.push(line), warn: () => {}, error: () => {} }
  });
  vm.runInContext(code, context, { filename: "dist/main.js" });
  return {
    doc,
    secure,
    files,
    logs,
    clipboard,
    entrypoints,
    // Photoshop quitting: every timer and socket of this plugin instance ends.
    kill() {
      dead = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const s of sockets) s.terminate();
    }
  };
}

async function ownerOn(port, token) {
  const o = new Owner({ port, token: hp.parseToken(token), version: "0.1.0", hosts: ["127.0.0.1", "::1"] });
  assert.equal((await o.bind()).ok, true);
  return o;
}

test("the release bundle holds no development code and no run-time code generation", () => {
  assert.ok(!release.code.includes("dev-pairing-token"), "the dev token import is stubbed out");
  assert.ok(release.code.includes("Release build: development-only module removed."));
  assert.ok(release.code.includes('module.exports = {"DEV":false,"BUILD":"release"}'));
  assert.ok(dev.code.includes("dev-pairing-token"));
  for (const code of [release.code, dev.code]) {
    assert.ok(!/\beval\s*\(/.test(code), "no eval");
    assert.ok(!/\bnew\s+Function\s*\(/.test(code), "no new Function");
    assert.ok(!/\bFunction\s*\(\s*["']/.test(code), "no Function(string)");
    assert.ok(!/\bimport\s*\(/.test(code), "no dynamic import");
    assert.ok(!/^\s*(const|let|var|function|class)\s+(URL|WebSocket|crypto|require|document|window|console)\b/m.test(code.split("\n").slice(0, 3).join("\n")));
  }
  assert.equal(release.files.some((f) => f.includes(`${path.sep}test${path.sep}`)), false);
});

test("the release bundle boots in a fake UXP, links to a real owner and answers scenario_status", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await ownerOn(port, token);
  const files = new Map([["dev-pairing-token", newToken()]]);
  const ps = runBundle(release.code, { port, secure: new Map([[P.token.secure_storage_key, token]]), files });
  t.after(async () => {
    ps.kill();
    await o.close();
  });
  assert.equal(ps.entrypoints.length, 1, "entrypoints set up during the first synchronous run");
  assert.ok(ps.entrypoints[0].panels.scenarioPanel);
  await waitFor(() => o.pluginInfo(), { label: "plugin linked" });
  assert.equal(o.pluginInfo().plugin_version, "0.1.0");
  assert.equal(o.pluginInfo().os, "darwin 25.5.0");
  o.setOwnClientName("Claude Code");
  const r = await o.callOwn("scenario_status", {});
  assert.deepEqual(r.open_documents, [
    { id: 7, title: "cover.psd" },
    { id: 8, title: "Untitled-2" }
  ]);
  assert.equal(r.active_document_id, 8);
  assert.equal(r.photoshop_version, "27.11.0");
  assert.equal(r.signed_in, false);
  assert.ok(files.has("dev-pairing-token"), "a release build ignores the dev token file");
  await waitFor(() => ps.doc.text("link-headline").startsWith("Connected"), { label: "panel shows the link" });
  assert.equal(ps.doc.els.get("link-dot").className, "dot on");
  assert.equal(ps.doc.text("token-value"), `Ending in ${token.slice(-4)}`);
  assert.match(ps.doc.text("version"), /^Scenario for Photoshop 0\.1\.0/);
  assert.equal(ps.doc.text("lane-title"), "Image");
  ps.doc.lanes[3].click();
  assert.equal(ps.doc.text("lane-title"), "Trained");
  assert.equal(ps.doc.lanes[3].getAttribute("selected"), "");
  assert.equal(ps.doc.lanes[0].getAttribute("selected"), null);
  await sleep(400);
  const log = ps.files.get("scenario-link.log") || "";
  assert.match(log, /plugin 0\.1\.0 \(release\) starting; random source: getRandomValues/);
  assert.ok(!log.includes(token) && !ps.logs.join("\n").includes(token), "the token is never logged");
  assert.ok(!log.includes("cover.psd"), "document titles are never logged");
});

test("panel: Show, Copy, and a confirmed Reset that cuts off the helper holding the old token", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await ownerOn(port, token);
  const ps = runBundle(release.code, { port, secure: new Map([[P.token.secure_storage_key, token]]) });
  t.after(async () => {
    ps.kill();
    await o.close();
  });
  await waitFor(() => o.pluginInfo(), { label: "linked" });
  ps.doc.els.get("token-show").click();
  assert.equal(ps.doc.text("token-value"), token);
  assert.equal(ps.doc.text("token-show"), "Hide");
  ps.doc.els.get("token-copy").click();
  await waitFor(() => ps.clipboard.text === token, { label: "copied" });
  assert.match(ps.doc.text("token-note"), /^Copied/);
  ps.doc.els.get("token-reset").click();
  assert.equal(ps.secure.get(P.token.secure_storage_key), token, "the first click only asks for confirmation");
  assert.equal(ps.doc.text("token-reset"), "Confirm reset");
  ps.doc.els.get("token-reset").click();
  await waitFor(() => ps.secure.get(P.token.secure_storage_key) !== token, { label: "new token stored" });
  const fresh = ps.secure.get(P.token.secure_storage_key);
  assert.ok(hp.parseToken(fresh));
  assert.equal(ps.doc.text("token-value"), `Ending in ${fresh.slice(-4)}`, "the new token is masked again");
  await waitFor(() => ps.doc.text("link-headline") === "A client tried to connect with an old pairing token.", { label: "old helper refused" });
  assert.equal(ps.doc.els.get("link-dot").className, "dot warn");
  assert.equal(o.pluginInfo(), null);
});

test("first start: the plugin makes and stores a 43-character token in secure storage", async (t) => {
  const port = await freePort();
  const secure = new Map();
  const ps = runBundle(release.code, { port, secure });
  t.after(() => ps.kill());
  await waitFor(() => secure.get(P.token.secure_storage_key), { label: "token stored" });
  const made = secure.get(P.token.secure_storage_key);
  assert.equal(made.length, 43);
  assert.ok(hp.parseToken(made));
  await waitFor(() => ps.doc.text("link-headline") === "No agent connected", { label: "waiting for a helper" });
});

test("development bundle: imports dev-pairing-token from the data folder, then removes the file", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await ownerOn(port, token);
  const files = new Map([["dev-pairing-token", `${token}\n`]]);
  const secure = new Map([[P.token.secure_storage_key, newToken()]]);
  const ps = runBundle(dev.code, { port, secure, files });
  t.after(async () => {
    ps.kill();
    await o.close();
  });
  await waitFor(() => o.pluginInfo(), { label: "linked with the imported token" });
  assert.equal(secure.get(P.token.secure_storage_key), token);
  assert.equal(files.has("dev-pairing-token"), false, "the file is removed after import");
  await sleep(400);
  assert.match(files.get("scenario-link.log"), /\(dev\) starting/);
  assert.match(files.get("scenario-link.log"), /pairing token imported/);
  assert.ok(!files.get("scenario-link.log").includes(token));

  const bad = new Map([["dev-pairing-token", "not a token"]]);
  const ps2 = runBundle(dev.code, { port: await freePort(), files: bad });
  t.after(() => ps2.kill());
  await waitFor(() => !bad.has("dev-pairing-token"), { label: "bad file removed" });
  await sleep(400);
  assert.match(bad.get("scenario-link.log"), /dev-pairing-token ignored/);
});

test("both link URLs refused by Photoshop: the panel says the connection was refused", async (t) => {
  const port = await freePort();
  const ps = runBundle(release.code, { port, secure: new Map([[P.token.secure_storage_key, newToken()]]), refuse: () => true });
  t.after(() => ps.kill());
  await waitFor(() => ps.doc.text("link-headline") === "Connection refused by Photoshop", { label: "permission_denied shown" });
  assert.equal(ps.doc.els.get("link-dot").className, "dot warn");
});

test(".ccx package: a valid stored zip with the five plugin files, same bytes on every build", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-ps-pkg-"));
  const a = packagePlugin({ dev: false, outDir: path.join(dir, "a"), distFile: path.join(dir, "a", "main.js") });
  const b = packagePlugin({ dev: false, outDir: path.join(dir, "b"), distFile: path.join(dir, "b", "main.js") });
  const buf = fs.readFileSync(a.file);
  assert.ok(buf.equals(fs.readFileSync(b.file)), "reproducible");
  assert.equal(path.basename(a.file), "scenario-photoshop-0.1.0.ccx");

  const names = [];
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const size = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extra = buf.readUInt16LE(off + 28);
    const name = buf.toString("utf8", off + 30, off + 30 + nameLen);
    const data = buf.subarray(off + 30 + nameLen + extra, off + 30 + nameLen + extra + size);
    assert.equal(method, 0);
    assert.equal(crc, crc32(data), `${name} CRC`);
    if (typeof zlib.crc32 === "function") assert.equal(crc, zlib.crc32(data), `${name} CRC matches zlib`);
    if (name === "dist/main.js") assert.equal(data.toString("utf8"), release.code);
    if (name === "manifest.json") assert.equal(JSON.parse(data.toString("utf8")).id, "com.scenario.photoshop");
    names.push(name);
    off += 30 + nameLen + extra + size;
  }
  assert.deepEqual(names, ["manifest.json", "index.html", "styles.css", "dist/main.js", "LICENSE"]);
  assert.equal(buf.readUInt32LE(off), 0x02014b50, "central directory follows");
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  assert.equal(buf.readUInt16LE(end + 10), 5);
  assert.equal(buf.readUInt32LE(end + 16), off, "central directory offset");

  const unzip = spawnSync("unzip", ["-tq", a.file], { encoding: "utf8" });
  if (!unzip.error) assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);

  const d = packagePlugin({ dev: true, outDir: path.join(dir, "d"), distFile: path.join(dir, "d", "main.js") });
  assert.equal(path.basename(d.file), "scenario-photoshop-0.1.0-dev.ccx");
});
