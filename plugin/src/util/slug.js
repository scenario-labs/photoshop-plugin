"use strict";
// Prompt slugs and asset tails for names (SPEC 9.1): the first four
// meaningful words of the prompt, lowercase, hyphenated, at most 24
// characters; the tail is the last six characters of the asset id. Slugs use
// ASCII letters and digits only, so they are safe in file names.

var MAX = 24;
var STOP = {};
"a an the of on in at to for with and or by from into onto over under near is are was were be this that these those its it as".split(" ").forEach(function (w) {
  STOP[w] = true;
});

function words(prompt) {
  var text = String(prompt || "");
  if (typeof text.normalize === "function") text = text.normalize("NFD");
  return text
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(function (w) {
      return w && !STOP[w];
    });
}

function slug(prompt) {
  var picked = words(prompt).slice(0, 4);
  var out = "";
  for (var i = 0; i < picked.length; i++) {
    var next = out ? out + "-" + picked[i] : picked[i];
    if (next.length > MAX) {
      if (!out) out = picked[i].slice(0, MAX);
      break;
    }
    out = next;
  }
  return out;
}

function tail(assetId) {
  var s = String(assetId || "");
  return s.length > 6 ? s.slice(-6) : s;
}

// A copy the person made of a take: Photoshop names it after the take plus a
// word ("Take 2 NfpUm8 copy", "Take 2 NfpUm8 copie 2"), and it keeps the
// take's metadata. A take the person renamed otherwise is still a take.
function isTakeCopy(name, fields) {
  if (!fields || !fields.take || !fields.assetId) return false;
  var own = "Take " + fields.take + " " + tail(fields.assetId) + " ";
  return String(name || "").indexOf(own) === 0;
}

module.exports = { slug: slug, tail: tail, isTakeCopy: isTakeCopy, MAX: MAX };
