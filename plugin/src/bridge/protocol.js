"use strict";
// Pairing proofs and message MACs, plugin side, in plain JavaScript.
// The helper implements the same rules with Node's crypto module; the tests
// check that both produce the same bytes. Byte layout (SPEC 2.6): each HMAC
// input is the UTF-8 label, one 0x00 byte, then the fields in this order.
//
//   proof   = HMAC(token, role    0x00 nonce_o nonce_c)
//   proof_o = HMAC(token, "owner" 0x00 nonce_c nonce_o)
//   K       = HMAC(token, "session" 0x00 nonce_o nonce_c)
//   mac     = HMAC(K, direction 0x00 counter(8 bytes, big-endian) body)
//
// The token key and the nonces are their raw 32 bytes; they travel as 43
// base64url characters. After the proofs every message is one text frame
// "<counter>.<mac>.<body>", and the MAC covers the body's UTF-8 bytes.

var P = require("../../../shared/protocol.json");
var schema = require("../../../shared/schema-check.js");
var hmac = require("../util/hmac.js");
var utf8 = require("../util/utf8.js");
var b64 = require("../util/base64url.js");

var L = P.labels;
var COUNTER = new RegExp(P.frame.counter_pattern);
var MAX_COUNTER = 9007199254740991;

function parseToken(text) {
  if (typeof text !== "string") return null;
  var trimmed = text.trim();
  if (trimmed.length !== P.token.chars) return null;
  var bytes = b64.decode(trimmed);
  if (!bytes || bytes.length !== P.token.bytes) return null;
  return bytes;
}

function nonceBytes(text) {
  var bytes = b64.decode(text);
  return bytes && bytes.length === P.nonce_bytes ? bytes : null;
}

function isNonce(text) {
  return nonceBytes(text) !== null;
}

function concat(parts) {
  var total = 0;
  var i;
  for (i = 0; i < parts.length; i++) total += parts[i].length;
  var out = new Uint8Array(total);
  var off = 0;
  for (i = 0; i < parts.length; i++) {
    out.set(parts[i], off);
    off += parts[i].length;
  }
  return out;
}

var ZERO = new Uint8Array([0]);

// label 0x00 a b, with a and b given as base64url nonces.
function labelled(label, nonceA, nonceB) {
  var a = nonceBytes(nonceA);
  var b = nonceBytes(nonceB);
  if (!a || !b) throw new Error("nonce must be 32 bytes in base64url");
  return concat([utf8.encode(label), ZERO, a, b]);
}

function connectProof(token, role, nonceOwner, nonceClient) {
  return b64.encode(hmac.hmacSha256(token, labelled(role, nonceOwner, nonceClient)));
}

function ownerProof(token, nonceOwner, nonceClient) {
  return b64.encode(hmac.hmacSha256(token, labelled(L.owner, nonceClient, nonceOwner)));
}

function sessionKey(token, nonceOwner, nonceClient) {
  return hmac.hmacSha256(token, labelled(L.session, nonceOwner, nonceClient));
}

function counterBytes(n) {
  var out = new Uint8Array(8);
  var hi = Math.floor(n / 4294967296);
  var lo = n % 4294967296;
  for (var i = 0; i < 4; i++) {
    out[3 - i] = (hi >>> (8 * i)) & 0xff;
    out[7 - i] = (lo >>> (8 * i)) & 0xff;
  }
  return out;
}

function messageMac(key, direction, counter, bodyBytes) {
  return hmac.hmacSha256(key, concat([utf8.encode(direction), ZERO, counterBytes(counter), bodyBytes]));
}

function proofMatches(expectedText, receivedText) {
  var a = b64.decode(expectedText);
  var b = b64.decode(receivedText);
  if (!a || !b) return false;
  return hmac.timingSafeEqual(a, b);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return undefined;
  }
}

// Checks a handshake message against shared/protocol.json. Returns the object or null.
function readHandshake(kind, text) {
  if (typeof text !== "string" || text.length > P.limits.max_handshake_message_bytes) return null;
  var obj = parseJson(text);
  if (!obj || typeof obj !== "object") return null;
  if (schema.validate(P.handshake[kind], obj).length) return null;
  return obj;
}

// A signed channel over one link. sendDir and recvDir are "o2c" or "c2o".
function Channel(key, sendDir, recvDir) {
  this.key = key;
  this.sendDir = sendDir;
  this.recvDir = recvDir;
  this.sent = 0;
  this.received = 0;
}

Channel.prototype.seal = function (message) {
  var body = JSON.stringify(message);
  this.sent += 1;
  var n = this.sent;
  return n + "." + b64.encode(messageMac(this.key, this.sendDir, n, utf8.encode(body))) + "." + body;
};

// frame: the text of one WebSocket text frame. Returns the message, or throws
// an Error that says what failed. Any failure means the link must close.
Channel.prototype.open = function (frame) {
  if (typeof frame !== "string") throw new Error("not text");
  if (frame.length > P.limits.max_message_bytes) throw new Error("message too large");
  var i = frame.indexOf(".");
  var j = i > 0 ? frame.indexOf(".", i + 1) : -1;
  if (i < 1 || j - i - 1 !== P.frame.mac_chars) throw new Error("malformed frame");
  var counterText = frame.slice(0, i);
  if (!COUNTER.test(counterText)) throw new Error("malformed frame");
  var n = Number(counterText);
  if (n > MAX_COUNTER) throw new Error("malformed frame");
  var got = b64.decode(frame.slice(i + 1, j));
  var body = frame.slice(j + 1);
  if (!got || !hmac.timingSafeEqual(messageMac(this.key, this.recvDir, n, utf8.encode(body)), got)) throw new Error("bad MAC");
  if (n <= this.received) throw new Error("old counter");
  this.received = n;
  var inner = parseJson(body);
  if (!inner || typeof inner !== "object" || Array.isArray(inner) || typeof inner.t !== "string") {
    throw new Error("malformed message");
  }
  return inner;
};

module.exports = {
  P: P,
  parseToken: parseToken,
  isNonce: isNonce,
  connectProof: connectProof,
  ownerProof: ownerProof,
  sessionKey: sessionKey,
  messageMac: messageMac,
  counterBytes: counterBytes,
  proofMatches: proofMatches,
  readHandshake: readHandshake,
  Channel: Channel
};
