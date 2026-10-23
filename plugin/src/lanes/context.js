"use strict";
// What the Edit and Enhance lanes read from Photoshop before building a view
// (SPEC 3.8): the active document, its selection (clipped to the canvas) and
// its active layer. Read only: no modal scope, nothing changes.
//
// Resolves { doc: { id, width, height, title, layers (top-level count),
// selected (selected layers), state (the History state) } | null, selection: bounds
// clipped to the canvas | null, selection_raw: bounds as read | null, layer:
// host.activeLayerInfo() | null }.

var shapeMod = require("../capture/shape.js");

async function read(host) {
  var id = host.activeDocumentId();
  if (id === null || id === undefined) return { doc: null, selection: null, selection_raw: null, layer: null };
  var size = host.documentSize(id);
  if (!size) return { doc: null, selection: null, selection_raw: null, layer: null };
  var title = null;
  var docs = host.listDocuments();
  for (var i = 0; i < docs.length; i++) if (docs[i].id === id) title = docs[i].title;
  var raw = null;
  try {
    raw = await host.selectionBounds(id);
  } catch (e) {
    raw = null;
  }
  var layer = null;
  try {
    layer = await host.activeLayerInfo(id);
  } catch (e) {
    layer = null;
  }
  var canvas = { width: size.width, height: size.height };
  var stats = null;
  if (typeof host.documentStats === "function") {
    try {
      stats = host.documentStats(id);
    } catch (e) {
      stats = null;
    }
  }
  return {
    doc: { id: id, width: size.width, height: size.height, title: title, layers: stats ? stats.layers : null, selected: stats ? stats.selected : null, state: stats ? stats.state || null : null },
    selection: raw ? shapeMod.clip(raw, canvas) : null,
    selection_raw: raw,
    layer: layer
  };
}

module.exports = { read: read };
