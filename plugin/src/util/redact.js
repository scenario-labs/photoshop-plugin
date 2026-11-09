"use strict";
// Keeps the exact secret values the plugin holds (API keys, secrets, the
// Basic header built from them) and removes them from any text before it is
// logged, shown, copied or sent to the helper (SPEC 4.3). Values shorter than
// 4 characters are not tracked: they would redact ordinary words.

var MARK = "[redacted]";

function createRedactor() {
  var values = [];

  function add(value) {
    if (typeof value !== "string" || value.length < 4) return;
    if (values.indexOf(value) < 0) values.push(value);
    // Longest first, so a value that contains another is removed whole.
    values.sort(function (a, b) {
      return b.length - a.length;
    });
  }

  function remove(value) {
    var i = values.indexOf(value);
    if (i >= 0) values.splice(i, 1);
  }

  function apply(text) {
    var out = String(text);
    for (var i = 0; i < values.length; i++) {
      if (out.indexOf(values[i]) >= 0) out = out.split(values[i]).join(MARK);
    }
    return out;
  }

  return { add: add, remove: remove, apply: apply, MARK: MARK };
}

module.exports = { createRedactor: createRedactor, MARK: MARK };
