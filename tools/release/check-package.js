#!/usr/bin/env node
"use strict";
// Checks a release package before it is attached and published: it must be
// exactly the release build of this checkout. blender-plugin opens its ZIP in
// Blender for this; no runner has Photoshop, so this reads the .ccx instead.
//
//   node tools/release/check-package.js build/scenario-photoshop-X.Y.Z.ccx X.Y.Z
//
// The entries are the five plugin/scripts/package.js writes, in its order,
// stored with matching checksums. The manifest, page, styles and licence are
// this checkout's files byte for byte, so no development host is allowed; the
// bundle is a fresh release build of this checkout, byte for byte, so a
// package built on another system must come out the same.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("../../plugin/scripts/build.js");
const { crc32 } = require("../../plugin/scripts/package.js");

const REPO = path.resolve(__dirname, "..", "..");
const ENTRIES = ["manifest.json", "index.html", "styles.css", "dist/main.js", "LICENSE"];
const SOURCES = { "manifest.json": "plugin/manifest.json", "index.html": "plugin/index.html", "styles.css": "plugin/styles.css", LICENSE: "LICENSE" };
const PLUGIN_ID = "com.scenario.photoshop";

// The entries of a zip whose files are stored (method 0), as package.js writes
// them: [{ name, data }]. Throws on anything else.
function readZip(buf) {
  const end = buf.length - 22;
  if (end < 0 || buf.readUInt32LE(end) !== 0x06054b50) throw new Error("no end of central directory record (or a zip comment)");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`central directory entry ${i} is damaged`);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    if (method !== 0 || packed !== size) throw new Error(`${name}: not stored`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: local header is damaged`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`${name}: checksum does not match`);
    entries.push({ name, data });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// The problems found in the package at `file` for `version`; empty when it is
// the release build of this checkout.
function checkPackage(file, version, { repo = REPO } = {}) {
  const problems = [];
  if (path.basename(file) !== `scenario-photoshop-${version}.ccx`) problems.push(`${path.basename(file)}: expected scenario-photoshop-${version}.ccx`);
  let entries;
  try {
    entries = readZip(fs.readFileSync(file));
  } catch (e) {
    return [...problems, `${path.basename(file)}: ${e.message}`];
  }
  const names = entries.map((e) => e.name);
  if (names.join("\n") !== ENTRIES.join("\n")) problems.push(`entries are ${names.join(", ")}; expected ${ENTRIES.join(", ")}`);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  for (const [name, source] of Object.entries(SOURCES)) {
    const data = byName.get(name);
    if (data && !data.equals(fs.readFileSync(path.join(repo, source)))) problems.push(`${name} differs from ${source}`);
  }
  const manifest = byName.get("manifest.json");
  if (manifest) {
    const m = JSON.parse(manifest.toString("utf8"));
    if (m.version !== version) problems.push(`manifest version is ${m.version}, expected ${version}`);
    if (m.id !== PLUGIN_ID) problems.push(`manifest id is ${m.id}, expected ${PLUGIN_ID}`);
  }
  const bundle = byName.get("dist/main.js");
  if (bundle) {
    const head = `/* Scenario for Photoshop ${version} (release build).`;
    if (!bundle.toString("utf8").startsWith(head)) problems.push(`dist/main.js does not start with "${head}"`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-package-"));
    try {
      const fresh = build({ dev: false, outFile: path.join(dir, "main.js") });
      if (!bundle.equals(Buffer.from(fresh.code, "utf8"))) problems.push("dist/main.js is not the release build of this checkout");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return problems;
}

if (require.main === module) {
  const [file, version] = process.argv.slice(2);
  if (!file || !/^\d+\.\d+\.\d+$/.test(version || "")) {
    process.stderr.write("usage: node tools/release/check-package.js <file.ccx> <X.Y.Z>\n");
    process.exit(2);
  }
  const problems = checkPackage(path.resolve(file), version);
  for (const p of problems) process.stderr.write(`::error::${p}\n`);
  if (!problems.length) process.stdout.write(`${path.basename(file)}: the release build of this checkout (${ENTRIES.length} entries)\n`);
  process.exit(problems.length ? 1 : 0);
}

module.exports = { checkPackage, readZip, ENTRIES };
