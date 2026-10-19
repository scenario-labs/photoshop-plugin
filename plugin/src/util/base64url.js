"use strict";
// base64url without padding (RFC 4648 section 5). decode() is strict: it
// refuses padding, characters outside the alphabet, impossible lengths and
// non-zero trailing bits, so every byte string has exactly one text form.

var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
var LOOKUP = {};
for (var i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charAt(i)] = i;

function encode(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("base64url.encode: expected a Uint8Array");
  var out = "";
  var j;
  for (j = 0; j + 2 < bytes.length; j += 3) {
    var n = (bytes[j] << 16) | (bytes[j + 1] << 8) | bytes[j + 2];
    out += ALPHABET.charAt(n >> 18) + ALPHABET.charAt((n >> 12) & 63) + ALPHABET.charAt((n >> 6) & 63) + ALPHABET.charAt(n & 63);
  }
  var rest = bytes.length - j;
  if (rest === 1) {
    var a = bytes[j] << 16;
    out += ALPHABET.charAt(a >> 18) + ALPHABET.charAt((a >> 12) & 63);
  } else if (rest === 2) {
    var b = (bytes[j] << 16) | (bytes[j + 1] << 8);
    out += ALPHABET.charAt(b >> 18) + ALPHABET.charAt((b >> 12) & 63) + ALPHABET.charAt((b >> 6) & 63);
  }
  return out;
}

// Returns a Uint8Array, or null when the text is not canonical base64url.
function decode(text) {
  if (typeof text !== "string") return null;
  var len = text.length;
  if (len % 4 === 1) return null;
  var vals = new Array(len);
  for (var k = 0; k < len; k++) {
    var v = LOOKUP[text.charAt(k)];
    if (v === undefined || !Object.prototype.hasOwnProperty.call(LOOKUP, text.charAt(k))) return null;
    vals[k] = v;
  }
  var outLen = Math.floor((len * 3) / 4);
  var out = new Uint8Array(outLen);
  var o = 0;
  var p;
  for (p = 0; p + 3 < len; p += 4) {
    var n = (vals[p] << 18) | (vals[p + 1] << 12) | (vals[p + 2] << 6) | vals[p + 3];
    out[o++] = n >> 16;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  var rest = len - p;
  if (rest === 2) {
    if (vals[p + 1] & 15) return null;
    out[o++] = ((vals[p] << 18) | (vals[p + 1] << 12)) >> 16;
  } else if (rest === 3) {
    if (vals[p + 2] & 3) return null;
    var m = (vals[p] << 18) | (vals[p + 1] << 12) | (vals[p + 2] << 6);
    out[o++] = m >> 16;
    out[o++] = (m >> 8) & 255;
  }
  return out;
}

module.exports = { encode: encode, decode: decode };
