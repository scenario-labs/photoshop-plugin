"use strict";
// The later flows' landings in Photoshop (FLOWS v2, F7 to F10), on the host
// adapter's internals (host.moreInternals()). Each placer's place(rec,
// ctx) builds its plan with apply/more-plan.js and carries it out in one
// modal scope and one History state, then resolves what landed:
// { document_id, layer_ids, group_id, history, notes, badges, landed }.
// jobs/runner.js calls them by the job's target kind.
//
// Placers: split, text, segment, reframe, video, frames. `anyCanvas`: the
// placer does not need the canvas the job was read from (a selection and a
// clip still make sense after a crop). `anyDocument`: it lands in a new
// document, so the job's document need not be in front.

var morePlan = require("./apply/more-plan.js");
var matchMod = require("./apply/match.js");
var pixelsMod = require("./capture/pixels.js");

function createMorePlacers(host, o) {
  o = o || {};
  var log = o.log || function () {};
  var I = typeof host.moreInternals === "function" ? host.moreInternals() : null;
  if (!I || !I.ps) return {};
  var ps = I.ps;
  // Formats documents made this session, by source document id.
  var formatsDocs = {};

  function frontDoc(id) {
    var doc = I.findDoc(id);
    if (!doc) throw new Error("the document was closed");
    var active = ps.app.activeDocument;
    if (!active || active.id !== doc.id) {
      var e = new Error("the document is not the active one");
      e.notActive = true;
      throw e;
    }
    return doc;
  }

  function nameOf(doc, layerId) {
    var l = layerId ? I.findLayer(doc, layerId) : null;
    return l ? String(l.name || "") : null;
  }

  // Moves and scales a placed layer so its frame becomes `fit` ({ width,
  // height, center_x, center_y }), as placeFile does.
  async function refit(doc, layer, fit) {
    var frame = await I.frameOf(doc.id, layer.id);
    if (!frame || !(frame.width > 0 && frame.height > 0)) return false;
    var sx = (fit.width / frame.width) * 100;
    var sy = (fit.height / frame.height) * 100;
    if (Math.abs(sx - 100) > 0.01 || Math.abs(sy - 100) > 0.01) await layer.scale(sx, sy);
    var after = await I.frameOf(doc.id, layer.id);
    var dx = fit.center_x - (after.left + after.width / 2);
    var dy = fit.center_y - (after.top + after.height / 2);
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) await layer.translate(dx, dy);
    return true;
  }

  function clipToCanvas(doc, b) {
    var W = Math.round(Number(doc.width));
    var H = Math.round(Number(doc.height));
    var left = Math.max(0, Math.floor(b.left));
    var top = Math.max(0, Math.floor(b.top));
    var right = Math.min(W, Math.ceil(b.left + b.width));
    var bottom = Math.min(H, Math.ceil(b.top + b.height));
    if (!(right - left >= 1 && bottom - top >= 1)) return null;
    return { left: left, top: top, width: right - left, height: bottom - top };
  }

  async function group(doc, layers, name, packet) {
    var g;
    if (typeof doc.createLayerGroup === "function") g = await doc.createLayerGroup({ name: name, fromLayers: layers });
    else g = await doc.groupLayers(layers);
    g.name = name;
    await I.setXmp(doc, g.id, packet);
    return g;
  }

  // Runs fn(doc, notes) on the front document in one History state.
  function inState(plan, docId, fn) {
    return I.modal(plan.history_name, async function (mctx) {
      var doc = frontDoc(docId);
      var notes = [];
      var out = null;
      await I.inOneState(mctx, doc, plan.history_name, async function () {
        out = await fn(doc, notes);
      });
      out.document_id = doc.id;
      out.history = plan.history_name;
      out.notes = (out.notes || []).concat(notes);
      return out;
    });
  }

  // ---- Split into layers (F7) ----
  var split = {
    place: function (rec, ctx) {
      var t = rec.target || {};
      var srcName = null;
      var d0 = I.findDoc(ctx.document_id);
      if (d0) srcName = nameOf(d0, t.layer_id);
      var plan = morePlan.split(rec, { version: ctx.version, source_name: srcName });
      return inState(plan, ctx.document_id, async function (doc, notes) {
        var box = plan.box;
        var rs = morePlan.readSize(box, plan.match_read);
        var source = plan.source_layer_id ? I.findLayer(doc, plan.source_layer_id) : null;
        if (plan.source_layer_id && !source) notes.push("The layer it was made from is gone; the layers went to the top.");
        var original = await I.readArea(doc, source ? source.id : null, box, rs.width, rs.height);
        if (source) await I.selectLayers(doc.id, [source.id]);
        else if (doc.layers && doc.layers[0]) await I.selectLayers(doc.id, [doc.layers[0].id]);
        var base = await I.placeFile(doc, plan.base.path, morePlan.contain(plan.base.width, plan.base.height, box), notes);
        base.name = plan.base.name;
        await I.setXmp(doc, base.id, plan.base.xmp);
        var rebuilt = await I.readArea(doc, base.id, box, rs.width, rs.height);
        var placed = [base];
        var doubtful = 0;
        for (var i = 0; i < plan.elements.length; i++) {
          var el = plan.elements[i];
          var layer = await I.placeFile(doc, el.path, morePlan.contain(el.width, el.height, box), notes);
          layer.name = el.name;
          await I.setXmp(doc, layer.id, el.xmp);
          placed.push(layer);
          var frame = await I.frameOf(doc.id, layer.id);
          var fb = frame ? clipToCanvas(doc, frame) : null;
          if (!fb) {
            doubtful++;
            continue;
          }
          var es = morePlan.readSize(fb, plan.element_read);
          var img = await I.readArea(doc, layer.id, fb, es.width, es.height);
          var m = matchMod.findElement(original, img, rebuilt);
          if (!m) {
            doubtful++;
            continue;
          }
          var at = matchMod.placeOf(m, box, rs.width, rs.height);
          // The read covered the frame inside the canvas (all of it when it
          // fits): the whole frame moves and scales with that part.
          var sx = at.width / fb.width;
          var sy = at.height / fb.height;
          var fw = frame.width * sx;
          var fh = frame.height * sy;
          var fit = { width: fw, height: fh, center_x: at.left - (fb.left - frame.left) * sx + fw / 2, center_y: at.top - (fb.top - frame.top) * sy + fh / 2 };
          await refit(doc, layer, fit);
          if (m.doubtful) doubtful++;
        }
        // Elements on top, the background at the bottom of the group.
        var g = await group(doc, placed.slice(), plan.group.name, plan.group.xmp);
        if (plan.hide_source && source) source.visible = false;
        var n = plan.elements.length;
        var line = "A background and " + n + " element" + (n === 1 ? "" : "s") + (plan.hide_source ? "; the layer is hidden below." : ".");
        return {
          layer_ids: placed.map(function (l) {
            return l.id;
          }),
          group_id: g.id,
          masked: false,
          notes: [line].concat(doubtful ? [doubtful + " element" + (doubtful === 1 ? "" : "s") + " may sit off their place: check and move them if needed."] : []),
          badges: [],
          landed: { kind: "split", elements: n, doubtful: doubtful }
        };
      });
    }
  };

  // ---- Remove text and Split text (F7 variant) ----
  var text = {
    place: function (rec, ctx) {
      var t = rec.target || {};
      var d0 = I.findDoc(ctx.document_id);
      var plan = morePlan.text(rec, { version: ctx.version, source_name: d0 ? nameOf(d0, t.layer_id) : null });
      return inState(plan, ctx.document_id, async function (doc, notes) {
        var box = plan.box;
        var source = plan.source_layer_id ? I.findLayer(doc, plan.source_layer_id) : null;
        if (source) await I.selectLayers(doc.id, [source.id]);
        else if (doc.layers && doc.layers[0]) await I.selectLayers(doc.id, [doc.layers[0].id]);
        var base = await I.placeFile(doc, plan.base.path, morePlan.contain(plan.base.width, plan.base.height, box), notes);
        base.name = plan.base.name;
        await I.setXmp(doc, base.id, plan.base.xmp);
        if (plan.mode === "remove") return { layer_ids: [base.id], group_id: null, masked: false, notes: ["The text is gone from a new layer above; the layer stays as it was."], badges: [], landed: { kind: "text", mode: "remove" } };
        if (!source) throw new Error("the layer it was made from is gone");
        // The text: a copy of the source, masked to where it differs from
        // the clean base.
        var rs = morePlan.readSize(box, plan.text.read);
        var a = await I.readArea(doc, source.id, box, rs.width, rs.height);
        var b = await I.readArea(doc, base.id, box, rs.width, rs.height);
        var mask = morePlan.textMask(a, b, plan.text.threshold, 2);
        var copy = await source.duplicate();
        copy.name = plan.text.name;
        await I.setXmp(doc, copy.id, morePlan.textXmp(rec, { version: ctx.version }, morePlan.maskBox(mask, box)));
        var EP = ps.constants && ps.constants.ElementPlacement;
        if (EP && typeof copy.move === "function") await copy.move(base, EP.PLACEBEFORE);
        var full = rs.width === box.width && rs.height === box.height ? mask : pixelsMod.resize(mask, box.width, box.height);
        await I.putMask(doc, copy.id, { left: box.left, top: box.top, width: full.width, height: full.height, data: full.data });
        var g = await group(doc, [copy, base], plan.group.name, plan.group.xmp);
        source.visible = false;
        var pct = Math.round(mask.fraction * 100);
        return {
          layer_ids: [copy.id, base.id],
          group_id: g.id,
          masked: true,
          notes: ["Text and a clean background; the layer is hidden below." + (pct < 1 ? " Little text was found." : "")],
          badges: [],
          landed: { kind: "text", mode: "split", text_fraction: Math.round(mask.fraction * 1000) / 1000 }
        };
      });
    }
  };

  // ---- Select by description (F8) ----
  var segment = {
    anyCanvas: false,
    place: function (rec, ctx) {
      var plan = morePlan.segment(rec);
      return inState(plan, ctx.document_id, async function (doc, notes) {
        var box = plan.box;
        var rs = morePlan.readSize(box, plan.read);
        if (doc.layers && doc.layers[0]) await I.selectLayers(doc.id, [doc.layers[0].id]);
        var reads = [];
        var temps = [];
        for (var i = 0; i < plan.masks.length; i++) {
          var m = plan.masks[i];
          var temp = await I.placeFile(doc, m.path, morePlan.cover(m.width, m.height, box), notes);
          temps.push(temp);
          reads.push(await I.readArea(doc, temp.id, box, rs.width, rs.height));
        }
        var u = morePlan.unionMasks(reads);
        var objects = u ? u.objects : 0;
        if (objects) {
          // The union as the mask of the first temporary layer, loaded as
          // the selection, cut to the box.
          var full = rs.width === box.width && rs.height === box.height ? u : pixelsMod.resize(u, box.width, box.height);
          await I.putMask(doc, temps[0].id, { left: box.left, top: box.top, width: full.width, height: full.height, data: full.data });
          await I.maskToSelection(temps[0].id, box);
        }
        for (var k = temps.length - 1; k >= 0; k--) await I.deleteLayer(doc, temps[k]);
        var what = plan.text ? ' "' + plan.text + '"' : "";
        return {
          layer_ids: [],
          group_id: null,
          masked: false,
          notes: [objects ? "Selected " + objects + " object" + (objects === 1 ? "" : "s") + what + "." : "Nothing matched" + what + "; the selection is unchanged."],
          badges: [],
          landed: { kind: "segment", objects: objects }
        };
      });
    }
  };

  // ---- Formats (F10) ----
  async function makeArtboard(doc, layer, rect, name) {
    var u = function (v) {
      return v;
    };
    await I.selectLayers(doc.id, [layer.id]);
    await I.play([
      {
        _obj: "make",
        _target: [{ _ref: "artboardSection" }],
        from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
        artboardRect: { _obj: "classFloatRect", top: u(rect.top), left: u(rect.left), bottom: u(rect.top + rect.height), right: u(rect.left + rect.width) }
      }
    ]);
    var ab = doc.activeLayers && doc.activeLayers[0];
    if (ab && ab.id !== layer.id) ab.name = name;
    return ab;
  }

  // The titles of the source (type layers and Split text's Text layers),
  // copied onto the artboard and laid out again where they were on the
  // picture (more-plan.js titleFit). Live type stays live.
  async function placeTitles(src, doc, artboard, rect, titles, notes) {
    var EP = ps.constants && ps.constants.ElementPlacement;
    var ids = [];
    for (var i = 0; i < titles.length; i++) {
      var tl = titles[i];
      var layer = I.findLayer(src, tl.id);
      if (!layer || typeof layer.duplicate !== "function") continue;
      var copy = await layer.duplicate(doc);
      if (!copy) continue;
      if (artboard && EP && typeof copy.move === "function") {
        var first = artboard.layers && artboard.layers[0];
        if (first && first.id !== copy.id) await copy.move(first, EP.PLACEBEFORE);
      }
      var fit = morePlan.titleFit(tl.box, { width: src.width, height: src.height }, rect);
      var b = I.boundsOf(copy);
      var pcx = b.left + b.width / 2;
      var pcy = b.top + b.height / 2;
      await copy.scale(fit.scale * 100, fit.scale * 100);
      // The title's center after scaling about the layer's own center.
      var tcx = pcx + (tl.box.left + tl.box.width / 2 - pcx) * fit.scale;
      var tcy = pcy + (tl.box.top + tl.box.height / 2 - pcy) * fit.scale;
      await copy.translate(fit.center_x - tcx, fit.center_y - tcy);
      ids.push(copy.id);
    }
    if (ids.length) notes.push(ids.length === 1 ? "The title is laid out again on the artboard, still editable." : ids.length + " titles are laid out again on the artboard, still editable.");
    return ids;
  }

  var reframe = {
    anyDocument: true,
    place: function (rec, ctx) {
      var t = rec.target || {};
      var d0 = I.findDoc(t.document_id);
      var existing = formatsDocs[t.document_id] ? I.findDoc(formatsDocs[t.document_id].id) : null;
      var plan = morePlan.reframe(rec, { version: ctx.version, title: d0 ? d0.title : t.document_title, formats_document_id: existing ? existing.id : null });
      return I.modal(plan.history_name, async function (mctx) {
        var notes = [];
        var doc = existing;
        var at = { left: 0, top: 0 };
        var made = false;
        if (doc) {
          if (!ps.app.activeDocument || ps.app.activeDocument.id !== doc.id) ps.app.activeDocument = doc;
          at.left = formatsDocs[t.document_id].right + plan.gap;
        } else {
          var o2 = { width: plan.size.width, height: plan.size.height, resolution: 72, name: plan.document_name, profile: I.srgb };
          if (ps.constants && ps.constants.NewDocumentMode) o2.mode = ps.constants.NewDocumentMode.RGB;
          if (ps.constants && ps.constants.DocumentFill) o2.fill = ps.constants.DocumentFill.TRANSPARENT;
          try {
            doc = await ps.app.createDocument(o2);
          } catch (e) {
            delete o2.profile;
            doc = await ps.app.createDocument(o2);
          }
          made = true;
        }
        var layerId = null;
        var artboard = null;
        var titleIds = [];
        var titles = d0 ? await host.overlayLayers(d0.id) : [];
        await I.inOneState(mctx, doc, plan.history_name, async function () {
          var rect = { left: at.left, top: at.top, width: plan.size.width, height: plan.size.height };
          if (doc.layers && doc.layers[0]) await I.selectLayers(doc.id, [doc.layers[0].id]);
          var layer = await I.placeFile(doc, plan.layer.path, { width: rect.width, height: rect.height, center_x: rect.left + rect.width / 2, center_y: rect.top + rect.height / 2 }, notes);
          layer.name = plan.layer.name;
          await I.setXmp(doc, layer.id, plan.layer.xmp);
          layerId = layer.id;
          try {
            artboard = await makeArtboard(doc, layer, rect, plan.artboard_name);
          } catch (e) {
            artboard = null;
            log("formats: artboard not made (" + ((e && e.message) || e) + ")");
            notes.push("Placed as a layer: Photoshop did not make the artboard.");
          }
          if (titles.length) titleIds = await placeTitles(d0, doc, artboard, rect, titles, notes);
          // The empty layer of a new document goes.
          if (made && doc.layers) {
            for (var i = 0; i < doc.layers.length; i++) {
              var l = doc.layers[i];
              if (l.id !== layerId && titleIds.indexOf(l.id) < 0 && (!artboard || l.id !== artboard.id) && l.kind !== "group" && String(l.kind) !== "group") {
                try {
                  await I.deleteLayer(doc, l);
                } catch (e2) {
                  // a Background stays
                }
              }
            }
          }
        });
        formatsDocs[t.document_id] = { id: doc.id, right: at.left + plan.size.width };
        return {
          document_id: doc.id,
          layer_ids: [layerId].concat(titleIds),
          group_id: artboard && artboard.id !== layerId ? artboard.id : null,
          history: plan.history_name,
          masked: false,
          notes: [(made ? "In a new document " : "Added to ") + '"' + plan.document_name + '" as ' + plan.artboard_name + "."].concat(notes),
          badges: [],
          landed: { kind: "reframe", format: plan.format, artboard: !!artboard, new_document: made }
        };
      });
    }
  };

  // ---- Animate (F9): the clip opens as a new document ----
  var video = {
    anyDocument: true,
    anyCanvas: true,
    place: function (rec) {
      var plan = morePlan.video(rec);
      return I.modal(plan.history_name, async function () {
        var entry = await I.entryFor(plan.path);
        var doc = await ps.app.open(entry);
        return {
          document_id: doc ? doc.id : null,
          layer_ids: doc && doc.layers && doc.layers[0] ? [doc.layers[0].id] : [],
          group_id: null,
          history: null,
          masked: false,
          notes: ["The clip is open as a new document; the MP4 is in the output folder."],
          badges: [],
          landed: { kind: "video", document_id: doc ? doc.id : null }
        };
      });
    }
  };

  // ---- Frame to layer (F9) ----
  var frames = {
    anyCanvas: true,
    place: function (rec, ctx) {
      var plan = morePlan.frames(rec, { version: ctx.version });
      return inState(plan, ctx.document_id, async function (doc, notes) {
        var under = plan.insert_layer_id ? I.findLayer(doc, plan.insert_layer_id) : null;
        if (under) await I.selectLayers(doc.id, [under.id]);
        else if (doc.layers && doc.layers[0]) await I.selectLayers(doc.id, [doc.layers[0].id]);
        var W = Math.round(Number(doc.width));
        var H = Math.round(Number(doc.height));
        var box = { left: 0, top: 0, width: W, height: H };
        var layer = await I.placeFile(doc, plan.layer.path, morePlan.cover(plan.layer.width, plan.layer.height, box), notes);
        layer.name = plan.layer.name;
        await I.setXmp(doc, layer.id, plan.layer.xmp);
        return { layer_ids: [layer.id], group_id: null, masked: false, notes: ["The last of " + plan.count + " frames, as a layer."], badges: [], landed: { kind: "frames", count: plan.count } };
      });
    }
  };

  return { split: split, text: text, segment: segment, reframe: reframe, video: video, frames: frames };
}

// Opens a file of the data folder as a new document (Open from Library).
// Resolves the new document's id.
function createOpener(host) {
  var I = typeof host.moreInternals === "function" ? host.moreInternals() : null;
  return function openFile(path) {
    if (!I || !I.ps) return Promise.reject(new Error("this Photoshop cannot open files from the plugin"));
    return I.modal("Scenario: Open from Library", async function () {
      var entry = await I.entryFor(path);
      var doc = await I.ps.app.open(entry);
      return doc ? doc.id : null;
    });
  };
}

module.exports = { createMorePlacers: createMorePlacers, createOpener: createOpener };
