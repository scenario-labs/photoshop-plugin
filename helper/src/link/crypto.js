"use strict";
// Pairing proofs and message MACs, helper side, with Node's crypto module.
// Same rules as plugin/src/bridge/protocol.js (plain JavaScript); the tests
// check that both produce the same bytes.

const crypto = require("node:crypto");
const P = require("../../../shared/protocol.json");
const schema = require("../../../shared/schema-check.js");

const L = P.labels;
const B64URL = /^[A-Za-z0-9_-]*$/;

// Strict base64url: alphabet only, no padding, canonical trailing bits.
function decode(text, expectedBytes) {
  if (typeof text !== "string" || !B64URL.test(text) || text.length % 4 === 1) return null;
  const buf = Buffer.from(text, "base64url");
  if (buf.toString("base64url") !== text) return null;
  if (expectedBytes !== undefined && buf.length !== expectedBytes) return null;
  return buf;
}

function encode(buf) {
  return Buffer.from(buf).toString("base64url");
}

function parseToken(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t.length !== P.token.chars) return null;
  return decode(t, P.token.bytes);
}

function newToken() {
  return encode(crypto.randomBytes(P.token.bytes));
}

function nonce() {
  return encode(crypto.randomBytes(P.nonce_bytes));
}

function isNonce(text) {
  return decode(text, P.nonce_bytes) !== null;
}

const ZERO = Buffer.from([0]);
const COUNTER = new RegExp(P.frame.counter_pattern);

// label 0x00 a b, with a and b given as base64url nonces (SPEC 2.6 byte layout).
function labelled(label, nonceA, nonceB) {
  const a = decode(nonceA, P.nonce_bytes);
  const b = decode(nonceB, P.nonce_bytes);
  if (!a || !b) throw new Error("nonce must be 32 bytes in base64url");
  return Buffer.concat([Buffer.from(label, "utf8"), ZERO, a, b]);
}

function hmac(key, bytes) {
  return crypto.createHmac("sha256", key).update(bytes).digest();
}

function connectProof(token, role, nonceOwner, nonceClient) {
  return encode(hmac(token, labelled(role, nonceOwner, nonceClient)));
}

function ownerProof(token, nonceOwner, nonceClient) {
  return encode(hmac(token, labelled(L.owner, nonceClient, nonceOwner)));
}

function sessionKey(token, nonceOwner, nonceClient) {
  return hmac(token, labelled(L.session, nonceOwner, nonceClient));
}

function counterBytes(n) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(n));
  return out;
}

// HMAC(K, direction 0x00 counter(8 bytes, big-endian) body)
function messageMac(key, direction, counter, bodyBytes) {
  return crypto.createHmac("sha256", key).update(Buffer.from(direction, "utf8")).update(ZERO).update(counterBytes(counter)).update(bodyBytes).digest();
}

function proofMatches(expectedText, receivedText) {
  const a = decode(expectedText, 32);
  const b = decode(receivedText, 32);
  if (!a || !b) return false;
  return crypto.timingSafeEqual(a, b);
}

function readHandshake(kind, text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > P.limits.max_handshake_message_bytes) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || schema.validate(P.handshake[kind], obj).length) return null;
  return obj;
}

// A signed channel over one link. sendDir and recvDir are "o2c" or "c2o".
// Frames are "<counter>.<mac>.<body>"; the MAC covers the body bytes exactly
// as they arrived, so open() takes the raw frame bytes when it has them.
class Channel {
  constructor(key, sendDir, recvDir) {
    this.key = key;
    this.sendDir = sendDir;
    this.recvDir = recvDir;
    this.sent = 0;
    this.received = 0;
  }

  seal(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.sent += 1;
    const n = this.sent;
    return `${n}.${encode(messageMac(this.key, this.sendDir, n, body))}.${body.toString("utf8")}`;
  }

  // frame: a Buffer (the frame's bytes) or a string.
  open(frame) {
    const buf = Buffer.isBuffer(frame) ? frame : typeof frame === "string" ? Buffer.from(frame, "utf8") : null;
    if (!buf) throw new Error("not text");
    if (buf.length > P.limits.max_message_bytes) throw new Error("message too large");
    const i = buf.indexOf(0x2e);
    const j = i > 0 ? buf.indexOf(0x2e, i + 1) : -1;
    if (i < 1 || j - i - 1 !== P.frame.mac_chars) throw new Error("malformed frame");
    const counterText = buf.toString("latin1", 0, i);
    if (!COUNTER.test(counterText)) throw new Error("malformed frame");
    const n = Number(counterText);
    if (!Number.isSafeInteger(n)) throw new Error("malformed frame");
    const got = decode(buf.toString("latin1", i + 1, j), 32);
    const body = buf.subarray(j + 1);
    if (!got || !crypto.timingSafeEqual(messageMac(this.key, this.recvDir, n, body), got)) throw new Error("bad MAC");
    if (n <= this.received) throw new Error("old counter");
    this.received = n;
    let inner;
    try {
      inner = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error("malformed message");
    }
    if (!inner || typeof inner !== "object" || Array.isArray(inner) || typeof inner.t !== "string") {
      throw new Error("malformed message");
    }
    return inner;
  }
}

module.exports = {
  P,
  decode,
  encode,
  parseToken,
  newToken,
  nonce,
  isNonce,
  connectProof,
  ownerProof,
  sessionKey,
  messageMac,
  counterBytes,
  proofMatches,
  readHandshake,
  Channel
};
