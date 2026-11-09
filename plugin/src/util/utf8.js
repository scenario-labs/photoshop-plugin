"use strict";
// UTF-8 encoder and decoder. UXP has no TextEncoder or TextDecoder.
// encode() matches TextEncoder: a lone surrogate becomes U+FFFD.
// decode() matches TextDecoder("utf-8") without the fatal flag: each invalid
// sequence becomes U+FFFD, following the WHATWG decoding algorithm.

function encode(str) {
  if (typeof str !== "string") throw new TypeError("utf8.encode: expected a string");
  var out = new Uint8Array(str.length * 3);
  var n = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    } else if (c >= 0xd800 && c <= 0xdfff) {
      c = 0xfffd;
    }
    if (c < 0x80) {
      out[n++] = c;
    } else if (c < 0x800) {
      out[n++] = 0xc0 | (c >> 6);
      out[n++] = 0x80 | (c & 0x3f);
    } else if (c < 0x10000) {
      out[n++] = 0xe0 | (c >> 12);
      out[n++] = 0x80 | ((c >> 6) & 0x3f);
      out[n++] = 0x80 | (c & 0x3f);
    } else {
      out[n++] = 0xf0 | (c >> 18);
      out[n++] = 0x80 | ((c >> 12) & 0x3f);
      out[n++] = 0x80 | ((c >> 6) & 0x3f);
      out[n++] = 0x80 | (c & 0x3f);
    }
  }
  return out.slice(0, n);
}

function decode(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("utf8.decode: expected a Uint8Array");
  var units = [];
  var chunks = [];
  var cp = 0;
  var needed = 0;
  var seen = 0;
  var lower = 0x80;
  var upper = 0xbf;

  function emit(code) {
    if (code > 0xffff) {
      code -= 0x10000;
      units.push(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      units.push(code);
    }
    if (units.length >= 8192) {
      chunks.push(String.fromCharCode.apply(null, units));
      units = [];
    }
  }

  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (needed === 0) {
      if (b <= 0x7f) {
        emit(b);
      } else if (b >= 0xc2 && b <= 0xdf) {
        needed = 1;
        cp = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        needed = 2;
        cp = b & 0x0f;
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        needed = 3;
        cp = b & 0x07;
      } else {
        emit(0xfffd);
      }
      continue;
    }
    if (b < lower || b > upper) {
      cp = 0;
      needed = 0;
      seen = 0;
      lower = 0x80;
      upper = 0xbf;
      emit(0xfffd);
      i--; // process this byte again as the start of a sequence
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    cp = (cp << 6) | (b & 0x3f);
    seen++;
    if (seen === needed) {
      emit(cp);
      cp = 0;
      needed = 0;
      seen = 0;
    }
  }
  if (needed !== 0) emit(0xfffd);
  chunks.push(String.fromCharCode.apply(null, units));
  return chunks.join("");
}

module.exports = { encode: encode, decode: decode };
