"use strict";
// Reads a pasted key and secret (SPEC 4.2 step 3): "key:secret", two lines,
// or two lines with labels such as "API key: ..." and "Secret: ...". A
// single-line field may turn a line break into a space, so a space or a tab
// between two parts also splits. Keys and secrets never contain whitespace.

var LABEL = /^(?:api[\s_-]*)?(?:key(?:[\s_-]*id)?|secret|api)\s*[:=]\s*/i;

function stripLabel(line) {
  return line.replace(LABEL, "").trim();
}

function token(text) {
  return typeof text === "string" && /^\S+$/.test(text) ? text : null;
}

// Returns { key, secret } when the text holds both, else null.
function splitPair(text) {
  if (typeof text !== "string") return null;
  var t = text.trim();
  if (!t) return null;
  var lines = t.split(/[\r\n]+/).map(function (l) {
    return l.trim();
  }).filter(Boolean);
  var key = null;
  var secret = null;
  if (lines.length >= 2) {
    if (lines.length !== 2) return null;
    key = stripLabel(lines[0]);
    secret = stripLabel(lines[1]);
  } else {
    t = t.replace(/[\t ]*:[\t ]*/, ":");
    var parts = t.split(/[\t ]+/);
    if (parts.length === 2) {
      key = parts[0];
      secret = parts[1];
    } else if (parts.length === 1) {
      var at = t.indexOf(":");
      if (at <= 0 || at === t.length - 1) return null;
      key = t.slice(0, at);
      secret = t.slice(at + 1);
    } else {
      return null;
    }
  }
  key = token(key);
  secret = token(secret);
  if (!key || !secret) return null;
  return { key: key, secret: secret };
}

// True when a field value holds more than a key: the input handler splits it.
function looksLikePair(value) {
  return typeof value === "string" && /[:\s]/.test(value.trim());
}

// A typed or pasted key or secret, trimmed. Null when empty or when it holds
// whitespace inside (not a key or a secret).
function cleanPart(value) {
  if (typeof value !== "string") return null;
  var v = value.trim();
  return v && /^\S+$/.test(v) ? v : null;
}

module.exports = { splitPair: splitPair, looksLikePair: looksLikePair, cleanPart: cleanPart };
