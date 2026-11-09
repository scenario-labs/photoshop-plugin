"use strict";
// The plugin hashes with plain JavaScript (UXP has no crypto.subtle). These
// tests hold it to published test vectors and to Node's own crypto module.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const sha = require("../../plugin/src/util/sha256.js");
const { hmacSha256, timingSafeEqual } = require("../../plugin/src/util/hmac.js");

const bytes = (s) => new Uint8Array(Buffer.from(s, "utf8"));
const hex = (u8) => Buffer.from(u8).toString("hex");
const fill = (n, v) => new Uint8Array(n).fill(v);

test("SHA-256 matches the FIPS 180 examples", () => {
  assert.equal(hex(sha.sha256(bytes(""))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hex(sha.sha256(bytes("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    hex(sha.sha256(bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
  );
  assert.equal(
    hex(sha.sha256(bytes("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"))),
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"
  );
});

test("SHA-256 of one million 'a' (fed in uneven pieces)", () => {
  const h = new sha.Sha256();
  const piece = fill(9973, 0x61);
  let left = 1000000;
  while (left > 0) {
    const n = Math.min(left, piece.length);
    h.update(piece.subarray(0, n));
    left -= n;
  }
  assert.equal(hex(h.digest()), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("SHA-256 equals node:crypto for every length 0..300 and random chunking", () => {
  for (let len = 0; len <= 300; len++) {
    const data = new Uint8Array(crypto.randomBytes(len));
    const expected = crypto.createHash("sha256").update(data).digest("hex");
    assert.equal(hex(sha.sha256(data)), expected, `length ${len}`);
    const h = new sha.Sha256();
    let pos = 0;
    while (pos < len) {
      const step = 1 + Math.floor(Math.random() * 70);
      h.update(data.subarray(pos, Math.min(len, pos + step)));
      pos += step;
    }
    assert.equal(hex(h.digest()), expected, `chunked length ${len}`);
  }
});

test("SHA-256 refuses misuse", () => {
  const h = new sha.Sha256();
  h.digest();
  assert.throws(() => h.update(bytes("x")), /after digest/);
  assert.throws(() => h.digest(), /twice/);
  assert.throws(() => sha.sha256("text"), /Uint8Array/);
});

test("HMAC-SHA-256 matches RFC 4231 test cases 1 to 7", () => {
  const cases = [
    [fill(20, 0x0b), bytes("Hi There"), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"],
    [bytes("Jefe"), bytes("what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"],
    [fill(20, 0xaa), fill(50, 0xdd), "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"],
    [
      new Uint8Array(Array.from({ length: 25 }, (_, i) => i + 1)),
      fill(50, 0xcd),
      "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"
    ],
    [fill(131, 0xaa), bytes("Test Using Larger Than Block-Size Key - Hash Key First"), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"],
    [
      fill(131, 0xaa),
      bytes(
        "This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm."
      ),
      "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"
    ]
  ];
  for (const [key, data, expected] of cases) assert.equal(hex(hmacSha256(key, data)), expected);
  // Case 5 is truncated to 128 bits.
  assert.equal(hex(hmacSha256(fill(20, 0x0c), bytes("Test With Truncation"))).slice(0, 32), "a3b6167473100ee06e0c796c2955552b");
});

test("HMAC-SHA-256 equals node:crypto for random keys (0 to 200 bytes) and messages", () => {
  for (let i = 0; i < 300; i++) {
    const key = new Uint8Array(crypto.randomBytes(Math.floor(Math.random() * 201)));
    const msg = new Uint8Array(crypto.randomBytes(Math.floor(Math.random() * 400)));
    assert.equal(hex(hmacSha256(key, msg)), crypto.createHmac("sha256", key).update(msg).digest("hex"));
  }
});

test("timingSafeEqual compares bytes and lengths", () => {
  assert.equal(timingSafeEqual(bytes("abc"), bytes("abc")), true);
  assert.equal(timingSafeEqual(bytes("abc"), bytes("abd")), false);
  assert.equal(timingSafeEqual(bytes("abc"), bytes("ab")), false);
  assert.equal(timingSafeEqual(bytes(""), bytes("")), true);
  assert.equal(timingSafeEqual("abc", bytes("abc")), false);
});
