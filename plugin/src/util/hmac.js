"use strict";
// HMAC-SHA-256 (RFC 2104) on top of the plain JavaScript SHA-256, and a
// comparison whose time does not depend on where two values differ.

var sha = require("./sha256.js");

var BLOCK = 64;

function hmacSha256(key, message) {
  if (!(key instanceof Uint8Array) || !(message instanceof Uint8Array)) {
    throw new TypeError("hmacSha256: key and message must be Uint8Array");
  }
  var k = key.length > BLOCK ? sha.sha256(key) : key;
  var ipad = new Uint8Array(BLOCK);
  var opad = new Uint8Array(BLOCK);
  for (var i = 0; i < BLOCK; i++) {
    var b = i < k.length ? k[i] : 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  var inner = new sha.Sha256().update(ipad).update(message).digest();
  return new sha.Sha256().update(opad).update(inner).digest();
}

// Constant time for equal lengths. Lengths are public (both are fixed-size MACs).
function timingSafeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

module.exports = { hmacSha256: hmacSha256, timingSafeEqual: timingSafeEqual };
