"use strict";
// Secure random bytes for the pairing token and the link nonces.
// First choice: crypto.getRandomValues. Fallback when it is missing or looks
// broken: SHA-256 over three crypto.randomUUID values, the time and a counter.
// With neither, there is no source and the caller must stop.

var sha = require("./sha256.js");
var utf8 = require("./utf8.js");

function allZero(bytes) {
  for (var i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
  return true;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// env: { crypto, now } where crypto is the host's crypto object.
function createRandom(env) {
  var c = env && env.crypto;
  var now = (env && env.now) || function () { return Date.now(); };

  if (c && typeof c.getRandomValues === "function") {
    try {
      var a = new Uint8Array(32);
      var b = new Uint8Array(32);
      c.getRandomValues(a);
      c.getRandomValues(b);
      if (!allZero(a) && !sameBytes(a, b)) {
        return {
          source: "getRandomValues",
          bytes: function (n) {
            var out = new Uint8Array(n);
            for (var off = 0; off < n; off += 65536) {
              c.getRandomValues(out.subarray(off, Math.min(n, off + 65536)));
            }
            return out;
          }
        };
      }
    } catch (e) {
      // fall through to the fallback
    }
  }

  if (c && typeof c.randomUUID === "function") {
    var counter = 0;
    return {
      source: "randomUUID",
      bytes: function (n) {
        var out = new Uint8Array(n);
        for (var off = 0; off < n; off += 32) {
          counter++;
          var seed = c.randomUUID() + "|" + c.randomUUID() + "|" + c.randomUUID() + "|" + now() + "|" + counter;
          var d = sha.sha256(utf8.encode(seed));
          out.set(d.subarray(0, Math.min(32, n - off)), off);
        }
        return out;
      }
    };
  }

  throw new Error("No secure random source: crypto.getRandomValues and crypto.randomUUID are both missing");
}

module.exports = { createRandom: createRandom };
