"use strict";
// The prompts the panel sends when the person gives none (SPEC 3.5), and the
// short name a run sent with one of them goes by: its layers are named
// "Scenario edit remove ...", and its Takes card reads "Remove", not the
// text of the built-in prompt.

var BUILTIN = {
  remove: "Remove what is inside the masked area and fill it so it matches the surroundings, as if it was never there.",
  variations: "A variation of this image: same subject, composition and colors, new details.",
  extend: "Extend the image into the empty area so it continues the scene naturally, with the same light and style.",
  sketch: "Render this sketch as finished, fully colored and lit artwork. Keep the composition, poses, shapes and proportions of the drawing exactly.",
  relight: "Relight the subject inside the masked area so its light, shadows, color and contrast match the scene around it. Keep its shape, pose, details and identity; change nothing outside the mask."
};

var NAMES = { remove: "Remove", variations: "Variations", extend: "Extend canvas", sketch: "Render sketch", relight: "Relight to scene" };

// The short name for a prompt that is one of the built-in ones (a style
// sentence may follow it), or null.
function nameOf(prompt) {
  var p = String(prompt || "").trim();
  for (var k in BUILTIN) {
    if (Object.prototype.hasOwnProperty.call(BUILTIN, k) && p.indexOf(BUILTIN[k]) === 0) return NAMES[k];
  }
  return null;
}

module.exports = { BUILTIN: BUILTIN, NAMES: NAMES, nameOf: nameOf };
