"use strict";
// Spawns the real helper (helper/bin/scenario-photoshop.js) and speaks MCP to
// it over stdio, as an agent client would.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BIN = path.resolve(__dirname, "..", "..", "helper", "bin", "scenario-photoshop.js");

// Every helper gets its own empty HOME (and APPDATA), so a test never reads or
// writes the real token file of the person running the tests.
function spawnHelper({ env = {}, args = [], home } = {}) {
  const dir = home || fs.mkdtempSync(path.join(os.tmpdir(), "scenario-ps-home-"));
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, "AppData"), SCENARIO_PHOTOSHOP_QUIET: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "";
  let stderr = "";
  let nextId = 0;
  const pending = new Map();
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      lines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  function request(method, params, timeout = 20000) {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no answer to ${method} within ${timeout} ms; stderr: ${stderr}`));
      }, timeout);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  function raw(text) {
    child.stdin.write(text);
  }

  async function initialize(name = "test-client", protocolVersion = "2025-06-18") {
    const r = await request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name, version: "1.0.0" } });
    notify("notifications/initialized", {});
    return r;
  }

  async function status() {
    const r = await request("tools/call", { name: "scenario_status", arguments: {} });
    if (r.error) throw new Error(JSON.stringify(r.error));
    return r.result.structuredContent || JSON.parse(r.result.content[0].text);
  }

  async function close() {
    child.stdin.end();
    const t = setTimeout(() => child.kill("SIGKILL"), 5000);
    const r = await exited;
    clearTimeout(t);
    return r;
  }

  return { child, home: dir, request, notify, raw, initialize, status, close, exited, lines, stderr: () => stderr };
}

module.exports = { spawnHelper, BIN };
