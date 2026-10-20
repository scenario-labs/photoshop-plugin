"use strict";
// Where the panel's small pictures come from. No network call of its own:
// each one is an <img> source.
//
// - Model thumbnails: Scenario's public thumbnail path on its file host
//   (shared/scenario-api.json, downloads.origins), a 70 px JPEG of the
//   model's thumbnail or first example image, fetched by the panel without
//   any key (measured live 2026-10-19). A picture that fails to load leaves
//   the model's icon in place.
// - Results: the saved file in the plugin's data folder (plugin-data:/).
// - References: a blob link to the bytes the plugin already holds, released
//   when the reference goes.

var API = require("../../../shared/scenario-api.json");
var assets = require("../scenario/assets.js");

var ORIGIN = API.downloads.origins[0];

// row: a catalog row (catalog.js displayRow) or a schema's row.
function modelThumb(row) {
  var id = row && row.thumb;
  return id && assets.validAssetId(id) ? ORIGIN + "/thumbnails/" + id : null;
}

// path: a result's path inside the data folder, as the ledger keeps it.
// Only pictures: an MP4 (an Animate clip) or any other file given to an
// <img> stopped the panel painting what follows it (live 2026-10-20).
var PICTURE = /\.(png|jpe?g|webp|gif)$/i;
function resultThumb(path) {
  if (typeof path !== "string" || !path || path.charAt(0) === "/" || path.indexOf("..") >= 0 || path.indexOf(":") >= 0) return null;
  if (!PICTURE.test(path)) return null;
  return "plugin-data:/" + path;
}

// global: the panel's window (URL, Blob). Returns { fromBytes(bytes, mime),
// release(url) }; without blob support, fromBytes returns null and the chip
// shows its icon.
function createUrls(global) {
  var g = global || {};
  var ok = !!(g.URL && typeof g.URL.createObjectURL === "function" && typeof g.Blob === "function");
  return {
    fromBytes: function (bytes, mime) {
      if (!ok || !bytes) return null;
      try {
        return g.URL.createObjectURL(new g.Blob([bytes], { type: mime || "image/png" }));
      } catch (e) {
        return null;
      }
    },
    release: function (url) {
      if (!ok || !url) return;
      try {
        g.URL.revokeObjectURL(url);
      } catch (e) {
        // already released
      }
    }
  };
}

// Sets an <img>'s source; on a load error the image hides so the box
// behind it (an icon) shows. A null source hides it at once.
function show(img, src) {
  if (!img) return;
  if (!img.__thumbBound && typeof img.addEventListener === "function") {
    img.__thumbBound = true;
    img.addEventListener("error", function () {
      if (img.style) img.style.display = "none";
    });
  }
  if (!src) {
    if (img.style) img.style.display = "none";
    if (img.getAttribute && img.getAttribute("src")) img.removeAttribute("src");
    return;
  }
  if (img.getAttribute && img.getAttribute("src") === src) return;
  if (img.style) img.style.display = "";
  img.setAttribute("src", src);
}

module.exports = { modelThumb: modelThumb, resultThumb: resultThumb, createUrls: createUrls, show: show, ORIGIN: ORIGIN };
