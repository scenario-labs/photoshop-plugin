"use strict";
// Short text for the panel: cut at a word boundary, never inside a word, and
// end with an ellipsis when anything was left out. One helper for every
// caption, name and status line the panel shortens.

var ELLIPSIS = "…";

// clip(text, max): the text, whitespace folded, at most `max` characters
// including the ellipsis. A first word longer than that is cut, since there
// is no boundary to keep.
function clip(text, max) {
  var s = String(text === undefined || text === null ? "" : text)
    .replace(/\s+/g, " ")
    .trim();
  var n = Math.max(2, Math.floor(Number(max) || 0));
  if (s.length <= n) return s;
  var room = s.slice(0, n - 1);
  // The cut falls between words when the next character is a space.
  var cut = s.charAt(n - 1) === " " ? room.length : room.lastIndexOf(" ");
  var out = cut > 0 ? room.slice(0, cut) : room;
  out = out.replace(/[\s,;:.\-]+$/, "");
  if (!out) out = room;
  return out + ELLIPSIS;
}

module.exports = { clip: clip, ELLIPSIS: ELLIPSIS };
