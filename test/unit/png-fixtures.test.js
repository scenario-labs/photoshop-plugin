"use strict";
// The blank stand-in PNG the plugin uploads for price checks, checked against
// Node's zlib, and the M2.0 fixtures checked for anything that must not ship
// in a public repo: account, job, project or team ids, signed links, hosts,
// emails, long hex values, and asset ids that are not fixture names.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const png = require("../../plugin/src/util/png.js");

function chunks(buf) {
  const out = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    out.push({ type, data, crc: buf.readUInt32BE(off + 8 + len), crcOver: buf.subarray(off + 4, off + 8 + len) });
    off += 12 + len;
  }
  return out;
}

test("blackPng: a valid 8-bit RGB PNG of the asked size, all zero pixels, checked by zlib", () => {
  for (const [w, h] of [
    [1, 1],
    [256, 256],
    [300, 17],
    [1024, 768]
  ]) {
    const buf = Buffer.from(png.blackPng(w, h));
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.deepEqual(png.pngSize(buf), { width: w, height: h });
    const cs = chunks(buf);
    assert.deepEqual(cs.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
    for (const c of cs) assert.equal(c.crc, png.crc32(c.crcOver, 0, c.crcOver.length) >>> 0, `${c.type} CRC`);
    if (typeof zlib.crc32 === "function") for (const c of cs) assert.equal(c.crc, zlib.crc32(c.crcOver));
    const ihdr = cs[0].data;
    assert.equal(ihdr.readUInt32BE(0), w);
    assert.equal(ihdr.readUInt32BE(4), h);
    assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0], "8-bit RGB, no interlace");
    const raw = zlib.inflateSync(cs[1].data);
    assert.equal(raw.length, h * (3 * w + 1), "one filter byte and 3 bytes per pixel per row");
    assert.ok(raw.every((b) => b === 0), "black pixels, filter 0");
  }
});

test("blackPng: the largest stand-in (6144 px) stays small and quick; sizes outside 1 to 16384 are refused", () => {
  const t0 = Date.now();
  const buf = Buffer.from(png.blackPng(6144, 6144));
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(buf.length < 1024 * 1024, `${buf.length} bytes`);
  assert.equal(zlib.inflateSync(chunks(buf)[1].data).length, 6144 * (3 * 6144 + 1));
  for (const [w, h] of [
    [0, 10],
    [10, png.MAX_SIDE + 1],
    [1.5, 2],
    ["8", 8]
  ]) {
    assert.throws(() => png.blackPng(w, h));
  }
  assert.equal(png.pngSize(Buffer.from("not a png")), null);
});

test("the M2.0 fixtures hold no ids, links, hosts or emails from a real account", () => {
  const dir = path.resolve(__dirname, "..", "fixtures");
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  })(dir);
  assert.ok(files.length >= 10);
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const name = path.relative(dir, f);
    assert.doesNotMatch(text, /[0-9a-f]{32}/i, `${name}: a long hex value`);
    assert.doesNotMatch(text, /\b(job|proj|project|team|apiu|user|inference|key)_[A-Za-z0-9]{6,}/, `${name}: an account, job or project id`);
    assert.doesNotMatch(text, /https?:\/\//, `${name}: a link`);
    assert.doesNotMatch(text, /Signature=|Expires=|Credential=|[a-z0-9-]+\.(com|net|io)\//i, `${name}: a host or a signed link`);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, `${name}: an email`);
    for (const id of text.match(/\basset_[A-Za-z0-9]+/g) || []) assert.match(id, /^asset_fixture[A-Z][A-Za-z0-9]*$/, `${name}: ${id} is not a fixture asset name`);
    assert.ok(!text.includes(String.fromCharCode(0x2014)), `${name}: a long dash`);
  }
});
