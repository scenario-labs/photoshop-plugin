"use strict";
// What an Edit, Expand, Upscale or Remove BG job adds to its tray card and
// Jobs row (SPEC 3.9, 3.11), as plain data from the ledger record: the
// check badges per take, the actions the checks open (Undo after "Changed
// outside", Place unmasked after a canvas change, Upscale this take), the
// upload status words and the title of a trained edit. The panel's own
// texts for the Image lane stay in ui/jobs-text.js; this module only adds.

var KIND_NAMES = { edit: "Edit", upscale: "Upscale", expand: "Expand", remove_background: "Remove BG" };

var TEXT = {
  uploading_selection: "Uploading selection",
  uploading_source: "Uploading source",
  uploading_canvas: "Uploading canvas",
  changed_outside: "Pixels outside the selection changed. Undo puts the document back; the result stays saved.",
  canvas_changed: "The canvas changed since this edit started.",
  checks_note: "Checks compare the result with the area it was made from; a failed check never removes a result.",
  undone: "Undone. The result stays saved: Place puts it back."
};

function capture(rec) {
  return rec && rec.inputs && rec.inputs.capture ? rec.inputs.capture : null;
}

// The words for a job uploading its inputs.
function uploadingText(rec) {
  var t = rec.target || {};
  if (!capture(rec)) return null;
  if (rec.lane === "edit") return t.kind === "selection" ? TEXT.uploading_selection : TEXT.uploading_canvas;
  if (rec.lane === "expand") return TEXT.uploading_canvas;
  return TEXT.uploading_source;
}

function title(rec) {
  var trained = Array.isArray(rec.trained_model_ids) && rec.trained_model_ids.length > 0;
  if (rec.lane === "edit" && trained) return "Trained edit";
  return KIND_NAMES[rec.lane] || null;
}

// Badges per take: the checks' badges (runner, SPEC 3.9 table), then
// "Input reduced" when the capture was reduced to fit the upload limit.
function badges(rec) {
  var pl = rec.placement || null;
  var out = pl && Array.isArray(pl.badges) ? pl.badges.map(function (b) { return b.slice(); }) : [];
  var cap = capture(rec);
  if (cap && cap.reduced) {
    var f = (cap.files || [])[0];
    var label = "Input reduced" + (f ? " (" + f.width + " x " + f.height + ")" : "");
    if (!out.length) out = (rec.outputs || []).map(function () { return []; });
    if (!out.length) out = [[]];
    for (var i = 0; i < out.length; i++) out[i].push(label);
  }
  return out;
}

// The tray card and Jobs row data for one record. Returns null for lanes this
// module does not cover (the Image lane).
function card(rec) {
  if (!rec || !KIND_NAMES[rec.lane]) return null;
  var pl = rec.placement || null;
  var b = badges(rec);
  var first = b[0] || [];
  var changedOutside = !!(pl && !pl.undone && first.indexOf("Changed outside") >= 0);
  var canvasChanged = !!(rec.error && rec.error.indexOf(TEXT.canvas_changed) >= 0);
  var small = [];
  for (var i = 0; i < b.length; i++) for (var j = 0; j < b[i].length; j++) if (/^Result is \d+ px for an \d+ px area$/.test(b[i][j])) small.push(i);
  var notes = [];
  if (changedOutside) notes.push(TEXT.changed_outside);
  if (pl && pl.undone) notes.push(TEXT.undone);
  if (pl && Array.isArray(pl.notes)) notes = notes.concat(pl.notes);
  return {
    local_id: rec.local_id,
    title: title(rec),
    experimental: title(rec) === "Trained edit",
    uploading: rec.state === "uploading_inputs" ? uploadingText(rec) : null,
    badges: b,
    checks: pl && Array.isArray(pl.checks) ? pl.checks : [],
    verify: pl ? pl.verify || null : null,
    masked: pl ? !!pl.masked : null,
    notes: notes,
    actions: {
      undo: changedOutside && rec.state === "applied",
      place_unmasked: canvasChanged && rec.lane === "edit" && (rec.state === "ready" || rec.state === "apply_failed"),
      open_as_document: ["ready", "apply_failed", "applied"].indexOf(rec.state) >= 0,
      upscale_take: small
    }
  };
}

module.exports = { card: card, badges: badges, title: title, uploadingText: uploadingText, TEXT: TEXT };
