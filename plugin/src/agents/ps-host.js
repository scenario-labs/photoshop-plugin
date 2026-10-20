"use strict";
// Photoshop reads and changes for the agent tools (MCP.md 4.1, 4.6, 4.7),
// on top of host.js. Reads work on any open document. Changes run on the
// active document only, checked when the call starts and again inside the
// modal scope; each change is one History state "Scenario agent: <label>".
// Nothing here decides what an agent may do: agents/tools.js checks the
// switches and the read scope first.

var errorsMod = require("../scenario/errors.js");
var allowlist = require("./allowlist.js");
var pixels = require("../capture/pixels.js");
var b64 = require("../util/base64url.js");

var SRGB = "sRGB IEC61966-2.1";

function fail(type, text) {
  return new errorsMod.ScenarioError(type, text);
}

function num(v) {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof v._value === "number") return v._value;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

// "smartObject" -> "smart_object"; Photoshop's LayerKind in snake case.
function snake(v) {
  return String(v || "pixel")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function baseName(p) {
  if (typeof p !== "string" || !p) return null;
  var parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

// host: the object host.js made. Returns the agent Photoshop functions.
function createPsHost(host) {
  var I = host.internals();
  var ps = I.ps;

  function doc(id) {
    var d = I.findDoc(id);
    if (!d) throw fail("DocumentClosed", "The document is closed.");
    return d;
  }

  function activeId() {
    return host.activeDocumentId();
  }

  // Inside the modal scope, right before a change: the target is still in front.
  function stillActive(docId) {
    var a = ps && ps.app ? ps.app.activeDocument : null;
    if (!a || a.id !== docId) throw fail("DocumentNotActive", "Bring the document to the front first: changes go to the active document only.");
    return I.findDoc(docId);
  }

  function safe(fn, fallback) {
    try {
      var v = fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function docInfo(d) {
    var path = safe(function () {
      return d.path;
    }, "");
    return {
      id: d.id,
      title: String(safe(function () {
        return d.title || d.name;
      }, "")),
      file_name: path ? baseName(path) : null,
      saved: safe(function () {
        return d.saved;
      }, null),
      width: Math.round(Number(d.width)),
      height: Math.round(Number(d.height)),
      resolution: num(safe(function () {
        return d.resolution;
      }, null)),
      mode: safe(function () {
        return d.mode ? String(d.mode) : null;
      }, null),
      bits: safe(function () {
        return d.bitsPerChannel ? String(d.bitsPerChannel) : null;
      }, null),
      profile: safe(function () {
        return d.colorProfileName || null;
      }, null)
    };
  }

  function boundsArr(l) {
    var b = I.boundsOf(l);
    return [b.left, b.top, b.width, b.height];
  }

  async function layerRow(d, l, parentId) {
    var info = await I.layerInfo(d, l);
    var meta = await I.metaOf(d.id, l.id);
    var row = {
      id: l.id,
      name: info.name,
      kind: snake(info.kind),
      visible: info.visible,
      opacity: num(safe(function () {
        return l.opacity;
      }, null)),
      blend: safe(function () {
        return l.blendMode ? String(l.blendMode) : null;
      }, null),
      bounds: boundsArr(l),
      parent_id: parentId,
      clipped: info.clipped,
      has_mask: info.has_mask,
      locked: info.locked
    };
    if (meta && meta.assetId) row.scenario = { asset_id: meta.assetId, kind: meta.kind || null };
    return row;
  }

  // Depth first, top to bottom, with parent ids.
  function flatten(d) {
    var out = [];
    function visit(list, parentId) {
      for (var i = 0; i < list.length; i++) {
        out.push({ layer: list[i], parent_id: parentId });
        var kids = safe(function () {
          return list[i].layers;
        }, null);
        if (kids && kids.length) visit(kids, list[i].id);
      }
    }
    visit(d.layers || [], null);
    return out;
  }

  async function summary(docId, limit, cursor) {
    var d = doc(docId);
    var all = flatten(d);
    var start = cursor || 0;
    var page = all.slice(start, start + limit);
    var layers = [];
    for (var i = 0; i < page.length; i++) layers.push(await layerRow(d, page[i].layer, page[i].parent_id));
    var sel = await host.selectionBounds(d.id);
    var states = safe(function () {
      return d.historyStates;
    }, null);
    var current = safe(function () {
      return d.activeHistoryState ? d.activeHistoryState.name : null;
    }, null);
    var artboards = [];
    for (var a = 0; a < all.length; a++) {
      var k = safe(function () {
        return String(all[a].layer.kind);
      }, "");
      if (k === "artboard") artboards.push({ id: all[a].layer.id, name: String(all[a].layer.name || ""), bounds: boundsArr(all[a].layer) });
    }
    return {
      document: docInfo(d),
      selection: sel ? { bounds: [sel.left, sel.top, sel.width, sel.height] } : null,
      quick_mask: !!safe(function () {
        return d.quickMaskMode;
      }, false),
      active_layer_ids: safe(function () {
        return (d.activeLayers || []).map(function (l) {
          return l.id;
        });
      }, []),
      layers: layers,
      history: { count: states && typeof states.length === "number" ? states.length : null, current: current },
      artboards: artboards,
      next_cursor: start + limit < all.length ? "o" + (start + limit) : null
    };
  }

  async function layerDetail(docId, layerId) {
    var d = doc(docId);
    var l = I.findLayer(d, layerId);
    if (!l) throw fail("InvalidParameter", "No layer " + layerId + " in this document.");
    var parent = null;
    var all = flatten(d);
    for (var i = 0; i < all.length; i++) if (all[i].layer.id === layerId) parent = all[i].parent_id;
    var row = await layerRow(d, l, parent);
    var meta = await I.metaOf(d.id, l.id);
    row.scenario_metadata = meta && Object.keys(meta).length ? meta : null;
    if (row.kind === "smart_object") {
      try {
        var r = await I.play([{ _obj: "get", _target: [{ _ref: "layer", _id: l.id }, { _ref: "document", _id: d.id }] }]);
        var so = r && r[0] ? r[0].smartObjectMore || null : null;
        var linked = r && r[0] && r[0].smartObject ? !!r[0].smartObject.linked : null;
        row.smart_object = so ? { embedded: linked === null ? null : !linked, content_size: so.size ? [num(so.size.width), num(so.size.height)] : null, transform: Array.isArray(so.transform) ? so.transform.map(num) : null } : { embedded: linked === null ? null : !linked };
      } catch (e) {
        row.smart_object = null;
      }
    }
    if (row.kind === "text") {
      row.text = safe(function () {
        var t = l.textItem;
        return t ? { content: String(t.contents || ""), font: t.characterStyle && t.characterStyle.font ? String(t.characterStyle.font) : null, size: t.characterStyle ? num(t.characterStyle.size) : null } : null;
      }, null);
    }
    if (row.has_mask && ps && ps.imaging && typeof ps.imaging.getLayerMask === "function") {
      row.mask_bounds = await I.modal("Scenario agent: Read mask", async function () {
        try {
          var m = await ps.imaging.getLayerMask({ documentID: d.id, layerID: l.id });
          var b = m && m.sourceBounds;
          if (m && m.imageData) m.imageData.dispose();
          return b ? [num(b.left), num(b.top), num(b.right) - num(b.left), num(b.bottom) - num(b.top)] : null;
        } catch (e) {
          return null;
        }
      });
    }
    var kind = row.kind;
    if (["solid_color", "gradient_fill", "pattern_fill", "brightness_contrast", "levels", "curves", "exposure", "vibrance", "hue_saturation", "color_balance", "black_and_white", "photo_filter", "channel_mixer", "color_lookup", "invert", "posterize", "threshold", "selective_color", "gradient_map"].indexOf(kind) >= 0) row.adjustment = kind;
    return row;
  }

  // A JPEG of the composite or one layer, at most maxPx on the long side.
  async function preview(docId, o) {
    var d = doc(docId);
    var W = Math.round(Number(d.width));
    var H = Math.round(Number(d.height));
    var box = o.box ? { left: o.box[0], top: o.box[1], width: o.box[2], height: o.box[3] } : { left: 0, top: 0, width: W, height: H };
    if (box.left < 0 || box.top < 0 || box.width < 1 || box.height < 1 || box.left + box.width > W || box.top + box.height > H) throw fail("InvalidParameter", "box must lie inside the document (" + W + " x " + H + ").");
    var k = Math.min(1, o.max_px / Math.max(box.width, box.height));
    var w = Math.max(1, Math.round(box.width * k));
    var h = Math.max(1, Math.round(box.height * k));
    var img = await I.modal("Scenario agent: Preview", async function () {
      var got = await I.readArea(d, o.layer_id || null, box, w, h);
      var mask = null;
      if (o.show_selection) {
        try {
          var s = await ps.imaging.getSelection({ documentID: d.id });
          if (s && s.imageData) {
            var sb = s.sourceBounds || {};
            var data = await s.imageData.getData({ chunky: true });
            mask = { left: num(sb.left), top: num(sb.top), width: Number(s.imageData.width), height: Number(s.imageData.height), data: Uint8Array.from(data) };
            s.imageData.dispose();
          }
        } catch (e) {
          mask = null;
        }
      }
      return { img: got, mask: mask };
    });
    var rgb = toRgb(img.img);
    if (img.mask) dimOutside(rgb, img.mask, box, k);
    var bytes = await host.encodeJpeg(rgb);
    return { data: b64.encodeStandard(bytes), width: rgb.width, height: rgb.height, scale: k, box: [box.left, box.top, box.width, box.height] };
  }

  // Composite over mid gray where the layer is clear.
  function toRgb(img) {
    if (img.components === 3) return img;
    var n = img.width * img.height;
    var out = new Uint8Array(n * 3);
    for (var i = 0; i < n; i++) {
      var a = img.components === 4 ? img.data[i * 4 + 3] / 255 : 1;
      for (var c = 0; c < 3; c++) {
        var v = img.components === 1 ? img.data[i] : img.data[i * img.components + c];
        out[i * 3 + c] = Math.round(v * a + 128 * (1 - a));
      }
    }
    return { width: img.width, height: img.height, components: 3, data: out };
  }

  // The selection shown by darkening what lies outside it.
  function dimOutside(rgb, m, box, k) {
    for (var y = 0; y < rgb.height; y++) {
      for (var x = 0; x < rgb.width; x++) {
        var dx = Math.floor(box.left + x / k) - m.left;
        var dy = Math.floor(box.top + y / k) - m.top;
        var inside = dx >= 0 && dy >= 0 && dx < m.width && dy < m.height ? m.data[dy * m.width + dx] / 255 : 0;
        var f = 0.35 + 0.65 * inside;
        var i = (y * rgb.width + x) * 3;
        rgb.data[i] = Math.round(rgb.data[i] * f);
        rgb.data[i + 1] = Math.round(rgb.data[i + 1] * f);
        rgb.data[i + 2] = Math.round(rgb.data[i + 2] * f);
      }
    }
  }

  // Changes the active layers. Photoshop records layer selection as it does
  // a click in the Layers panel (SPEC 6.5); no extra History state is made.
  async function selectLayers(docId, ids, mode) {
    var d = doc(docId);
    for (var i = 0; i < ids.length; i++) if (!I.findLayer(d, ids[i])) throw fail("InvalidParameter", "No layer " + ids[i] + " in this document.");
    return I.modal("Scenario agent: Select layers", async function () {
      var t = stillActive(docId);
      for (var j = 0; j < ids.length; j++) {
        var desc = { _obj: "select", _target: [{ _ref: "layer", _id: ids[j] }], makeVisible: false };
        if (j > 0 || mode === "add") desc.selectionModifier = { _enum: "selectionModifierType", _value: "addToSelection" };
        await I.play([desc]);
      }
      return (t.activeLayers || []).map(function (l) {
        return l.id;
      });
    });
  }

  function unit(v) {
    return { _unit: "pixelsUnit", _value: v };
  }

  var MODE_EVENT = { add: "addTo", subtract: "subtractFrom", intersect: "intersectWith" };

  // One History state "Scenario agent: Select". s: { rect | ellipse:
  // [x, y, w, h], layer_transparency: id, subject: {sample_all_layers},
  // none: true, feather, mode }.
  async function setSelection(docId, s) {
    var d = doc(docId);
    if (s.layer_transparency !== undefined && !I.findLayer(d, s.layer_transparency)) throw fail("InvalidParameter", "No layer " + s.layer_transparency + " in this document.");
    var mode = s.mode || "replace";
    var descs = [];
    var shape = s.rect || s.ellipse;
    if (shape) {
      var to = { _obj: s.ellipse ? "ellipse" : "rectangle", top: unit(shape[1]), left: unit(shape[0]), bottom: unit(shape[1] + shape[3]), right: unit(shape[0] + shape[2]) };
      if (s.ellipse) to.antiAlias = true;
      descs.push({ _obj: mode === "replace" ? "set" : MODE_EVENT[mode], _target: [{ _ref: "channel", _property: "selection" }], to: to });
    } else if (s.layer_transparency !== undefined) {
      var ref = { _ref: [{ _ref: "channel", _enum: "channel", _value: "transparencyEnum" }, { _ref: "layer", _id: s.layer_transparency }] };
      if (mode === "replace") descs.push({ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: ref });
      else descs.push({ _obj: MODE_EVENT[mode], null: ref, to: { _ref: [{ _ref: "channel", _property: "selection" }] } });
    } else if (s.subject) {
      // Select Subject follows Photoshop's Image Processing preference
      // (SPEC 6.6); the descriptor exposes no processing option.
      descs.push({ _obj: "autoCutout", sampleAllLayers: !!s.subject.sample_all_layers });
    } else if (s.none) {
      descs.push({ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } });
    }
    if (s.feather && !s.none) descs.push({ _obj: "feather", radius: unit(s.feather), selectionModifyEffectAtCanvasBounds: false });
    await I.modal("Scenario agent: Select", async function (ctx) {
      var t = stillActive(docId);
      await I.inOneState(ctx, t, "Scenario agent: Select", async function () {
        for (var i = 0; i < descs.length; i++) await playChecked([descs[i]]);
      });
    });
    var sel = await host.selectionBounds(d.id);
    return sel ? { bounds: [sel.left, sel.top, sel.width, sel.height] } : null;
  }

  // batchPlay reports a failed descriptor as a result, not a throw.
  async function playChecked(descs) {
    var r = await I.play(descs);
    for (var i = 0; r && i < r.length; i++) {
      if (r[i] && r[i]._obj === "error") {
        var e = new Error((r[i].message || "Photoshop refused the command") + " (descriptor " + i + ")");
        e.index = i;
        throw e;
      }
    }
    return r || [];
  }

  async function isScenario(d, l) {
    var meta = await I.metaOf(d.id, l.id);
    return !!(meta && meta.assetId);
  }

  async function removeScenarioLayers(docId, ids) {
    var d = doc(docId);
    var layers = [];
    for (var i = 0; i < ids.length; i++) {
      var l = I.findLayer(d, ids[i]);
      if (!l) throw fail("InvalidParameter", "No layer " + ids[i] + " in this document.");
      if (!(await isScenario(d, l))) throw fail("NotScenarioLayer", "Layer " + ids[i] + " carries no Scenario metadata.");
      layers.push(l);
    }
    await I.modal("Scenario agent: Remove layers", async function (ctx) {
      var t = stillActive(docId);
      await I.inOneState(ctx, t, "Scenario agent: Remove layers", async function () {
        for (var j = 0; j < layers.length; j++) await I.deleteLayer(t, layers[j]);
      });
    });
    return ids.slice();
  }

  // Does an id belong to the target? Layers by id; channels and paths by
  // the ids Photoshop reports for them.
  function hasIn(d, cls, id) {
    if (cls === "layer" || cls === "contentLayer" || cls === "adjustmentLayer") return !!I.findLayer(d, id);
    var list = safe(function () {
      return cls === "channel" ? d.channels : cls === "path" ? d.pathItems : null;
    }, null);
    if (!list) return false;
    for (var i = 0; i < list.length; i++) if (safe(function () {
      return list[i].id;
    }, null) === id) return true;
    return false;
  }

  // execute_batchplay: checked before and inside the modal scope; one
  // History state; any failed descriptor rolls the whole call back.
  // files: { path -> session token } from the caller's path checks.
  async function runBatchPlay(docId, descriptors, label, files) {
    var d = doc(docId);
    var ctxFor = function (t) {
      return {
        document_id: docId,
        has: function (cls, id) {
          return hasIn(t, cls, id);
        },
        file: function (p) {
          return Object.prototype.hasOwnProperty.call(files || {}, p) ? { ok: true, ref: files[p] } : { ok: false, reason: "not a file of a capture of this document" };
        }
      };
    };
    allowlist.check(descriptors, ctxFor(d));
    var name = "Scenario agent: " + label;
    var results = null;
    await I.modal(name, async function (ctx) {
      var t = stillActive(docId);
      var ready = allowlist.check(descriptors, ctxFor(t));
      await I.inOneState(ctx, t, name, async function () {
        results = await playChecked(ready);
      });
    });
    var out = [];
    for (var i = 0; i < results.length; i++) out.push(descriptors[i]._obj === "get" ? allowlist.strip(results[i]) : results[i] && typeof results[i] === "object" && !Object.keys(results[i]).length ? null : allowlist.strip(results[i]));
    var capped = allowlist.cap(out);
    return { history_state: name, results: capped.results, truncated: capped.truncated };
  }

  return {
    activeId: activeId,
    summary: summary,
    layerDetail: layerDetail,
    preview: preview,
    selectLayers: selectLayers,
    setSelection: setSelection,
    removeScenarioLayers: removeScenarioLayers,
    runBatchPlay: runBatchPlay,
    isScenarioLayer: async function (docId, layerId) {
      var d = doc(docId);
      var l = I.findLayer(d, layerId);
      return !!l && (await isScenario(d, l));
    },
    sessionToken: I.sessionToken,
    readArea: I.readArea,
    flattenIds: function (docId) {
      return flatten(doc(docId)).map(function (x) {
        return x.layer.id;
      });
    }
  };
}

module.exports = { createPsHost: createPsHost, snake: snake, pixels: pixels };
