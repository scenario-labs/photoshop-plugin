"use strict";
// UTF-8 (UXP has no TextEncoder or TextDecoder), base64url and canonical JSON.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const utf8 = require("../../plugin/src/util/utf8.js");
const b64 = require("../../plugin/src/util/base64url.js");
const cj = require("../../plugin/src/util/canonical-json.js");

function randomString(len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    const r = Math.random();
    if (r < 0.4) s += String.fromCharCode(32 + Math.floor(Math.random() * 95));
    else if (r < 0.6) s += String.fromCharCode(0x80 + Math.floor(Math.random() * 0x780));
    else if (r < 0.8) s += String.fromCharCode(0x800 + Math.floor(Math.random() * 0xd000));
    else if (r < 0.9) s += String.fromCodePoint(0x10000 + Math.floor(Math.random() * 0xfffff));
    else s += String.fromCharCode(0xd800 + Math.floor(Math.random() * 0x800)); // lone surrogate
  }
  return s;
}

test("utf8.encode equals TextEncoder, lone surrogates included", () => {
  const enc = new TextEncoder();
  for (const s of ["", "abc", "é", "€", "😀", "a\ud800b", "\udc00", "\ud83d", "Ünïcödé 写真 🎨"]) {
    assert.deepEqual(Buffer.from(utf8.encode(s)), Buffer.from(enc.encode(s)), JSON.stringify(s));
  }
  for (let i = 0; i < 500; i++) {
    const s = randomString(Math.floor(Math.random() * 40));
    assert.deepEqual(Buffer.from(utf8.encode(s)), Buffer.from(enc.encode(s)));
  }
});

test("utf8.decode equals TextDecoder on valid and invalid bytes", () => {
  const dec = new TextDecoder("utf-8");
  const edge = [
    [0xc0, 0x80],
    [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf0, 0x9f, 0x98],
    [0xff],
    [0x80, 0x41],
    [0xe2, 0x82],
    [0xc3, 0x28],
    [0xf0, 0x9f, 0x98, 0x80, 0xc3, 0xa9]
  ];
  for (const e of edge) assert.equal(utf8.decode(new Uint8Array(e)), dec.decode(new Uint8Array(e)), JSON.stringify(e));
  for (let i = 0; i < 2000; i++) {
    const b = new Uint8Array(crypto.randomBytes(Math.floor(Math.random() * 30)));
    assert.equal(utf8.decode(b), dec.decode(b));
  }
  const long = new Uint8Array(Buffer.from("é".repeat(20000)));
  assert.equal(utf8.decode(long), "é".repeat(20000));
});

test("utf8 round-trips random well-formed strings", () => {
  for (let i = 0; i < 300; i++) {
    const s = randomString(30).replace(/[\ud800-\udfff]/g, "x");
    assert.equal(utf8.decode(utf8.encode(s)), s);
  }
});

test("base64url equals Buffer's encoding and decodes strictly", () => {
  for (let len = 0; len < 70; len++) {
    const data = new Uint8Array(crypto.randomBytes(len));
    const text = b64.encode(data);
    assert.equal(text, Buffer.from(data).toString("base64url"));
    assert.deepEqual(Buffer.from(b64.decode(text)), Buffer.from(data));
  }
  assert.equal(b64.decode("AAAA="), null, "padding refused");
  assert.equal(b64.decode("AA+A"), null, "standard alphabet refused");
  assert.equal(b64.decode("A"), null, "impossible length refused");
  assert.equal(b64.decode("AB"), null, "non-zero trailing bits refused");
  assert.equal(b64.decode("AAB"), null, "non-zero trailing bits refused");
  assert.equal(b64.decode(" AAA"), null);
  assert.equal(b64.decode(42), null);
  assert.deepEqual(Buffer.from(b64.decode("")), Buffer.alloc(0));
});

test("canonical JSON matches the RFC 8785 examples", () => {
  // RFC 8785 section 3.2.2 input, as parsed values.
  const input = {
    numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
    string: "€$\u000f\nA'B\"\\\\\"/",
    literals: [null, true, false]
  };
  assert.equal(
    cj.stringify(input),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}'
  );
  // RFC 8785 section 3.2.3 sorting example.
  const sorting = { "€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One", "😀": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis" };
  assert.equal(
    cj.stringify(sorting),
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}'
  );
});

test("canonical JSON is order-independent, compact, and escapes like JSON.stringify", () => {
  const a = { b: 1, a: [1, { y: 2, x: "é" }], c: null, d: true };
  const b = { d: true, c: null, a: [1, { x: "é", y: 2 }], b: 1 };
  assert.equal(cj.stringify(a), cj.stringify(b));
  assert.equal(cj.stringify(a), '{"a":[1,{"x":"é","y":2}],"b":1,"c":null,"d":true}');
  for (let i = 0; i < 300; i++) {
    const s = randomString(20);
    assert.equal(cj.stringify(s), JSON.stringify(s));
  }
  assert.equal(cj.stringify(-0), "0");
  assert.equal(cj.stringify({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(cj.hash({ b: 1, a: 2 }), crypto.createHash("sha256").update('{"a":2,"b":1}').digest("hex"));
});

test("canonical JSON refuses values JSON cannot carry", () => {
  assert.throws(() => cj.stringify(NaN), /non-finite/);
  assert.throws(() => cj.stringify({ a: Infinity }), /non-finite/);
  assert.throws(() => cj.stringify([undefined]), /undefined/);
  assert.throws(() => cj.stringify({ f() {} }), /unsupported/);
  assert.throws(() => cj.stringify(new Date(0)), /plain objects/);
  assert.throws(() => cj.stringify(10n), /unsupported/);
});

test("clip: cuts on a word boundary with an ellipsis, never inside a word; one helper for the panel's short texts", () => {
  const { clip } = require("../../plugin/src/util/clip.js");
  const caption = "A small fishing boat rests in harbor water at dawn";
  const out = clip(caption, 40);
  assert.equal(out, "A small fishing boat rests in harbor…");
  assert.ok(out.length <= 40);
  assert.equal(clip("Short caption", 40), "Short caption", "short text stays whole, no ellipsis");
  assert.equal(clip("  spaces\n folded  ", 40), "spaces folded");
  assert.equal(clip("one two three", 8), "one two…", "a cut right at a space keeps the word before it");
  assert.equal(clip("Supercalifragilistic", 8), "Superca…", "a first word longer than the room is cut");
  assert.equal(clip("Rests in harbor, waiting", 17), "Rests in harbor…", "punctuation before the ellipsis goes");
  assert.equal(clip(null, 10), "");
  // The Library's names and the place note use it.
  const library = require("../../plugin/src/panel/library.js");
  const row = library.rowOf({ id: "asset_x1", kind: "image", metadata: { type: "txt2img", prompt: caption } });
  assert.equal(row.name, "A small fishing boat rests in harbor…");
  const fs = require("node:fs");
  const ctl = fs.readFileSync(require.resolve("../../plugin/src/panel/controller.js"), "utf8");
  assert.match(ctl, /clipMod\.clip\(row\.name, 40\) \+ " is placed as a new layer\."/);
  // "Result is N px for the M px area": no "an" before a number.
  const runner = fs.readFileSync(require.resolve("../../plugin/src/jobs/runner.js"), "utf8");
  assert.match(runner, /" px for the " \+ m \+ " px area"/);
  assert.doesNotMatch(runner, /px for an /);
});
