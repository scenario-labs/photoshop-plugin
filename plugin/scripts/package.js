#!/usr/bin/env node
"use strict";
// Builds the bundle and writes build/scenario-photoshop-<version>[-dev].ccx,
// a zip of the plugin folder. Entries are stored (not compressed) with a fixed
// date, so the same sources give the same bytes.

const fs = require("node:fs");
const path = require("node:path");
const { build } = require("./build.js");

const PLUGIN = path.resolve(__dirname, "..");
const REPO = path.resolve(PLUGIN, "..");
const FILES = ["manifest.json", "index.html", "styles.css", "dist/main.js"];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data: Buffer }] -> Buffer (zip, method 0 "stored")
function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, e.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

// distFile: where the bundle is written. A development package writes it
// under build/ so plugin/dist/main.js stays a release bundle; the tests use a
// temporary folder. The zip takes the bundle from memory.
function packagePlugin({ dev = false, outDir = path.join(REPO, "build"), distFile } = {}) {
  const built = build({ dev, outFile: distFile || (dev ? path.join(outDir, "dev-dist", "main.js") : undefined) });
  const entries = FILES.map((name) => ({
    name,
    data: name === "dist/main.js" ? Buffer.from(built.code, "utf8") : fs.readFileSync(path.join(PLUGIN, name))
  }));
  entries.push({ name: "LICENSE", data: fs.readFileSync(path.join(REPO, "LICENSE")) });
  const file = path.join(outDir, `scenario-photoshop-${built.version}${dev ? "-dev" : ""}.ccx`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, zip(entries));
  return { file, entries: entries.map((e) => e.name) };
}

if (require.main === module) {
  const dev = process.argv.includes("--dev");
  const r = packagePlugin({ dev });
  process.stdout.write(`packaged ${path.relative(REPO, r.file)} (${r.entries.join(", ")})\n`);
}

module.exports = { packagePlugin, zip, crc32 };
