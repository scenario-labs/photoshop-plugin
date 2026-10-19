"use strict";
// Everything the plugin reads from UXP and Photoshop goes through this adapter,
// so the rest of the code runs under Node with a fake host in the tests.
// Every call is wrapped: a missing API returns null instead of throwing.

var utf8 = require("./util/utf8.js");
var b64 = require("./util/base64url.js");
var pixelsMod = require("./capture/pixels.js");

function toBytes(v) {
  if (v && v.buffer && typeof v.byteLength === "number") return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
  return new Uint8Array(v);
}

// An ArrayBuffer holding exactly these bytes, for fs.writeFile.
function bufferOf(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.slice().buffer;
}

function px(v) {
  if (typeof v === "number") return v;
  if (v && typeof v._value === "number") return v._value;
  return Number(v);
}

// A failure that means Photoshop was busy (another modal operation), so a
// Place when ready waits and tries again.
function markBusy(e) {
  if (e && /modal|busy|is in use|not available/i.test(String(e.message || e))) e.busy = true;
  return e;
}

// hostRequire: the require function UXP gives the plugin. g: the global object.
function createHost(hostRequire, g) {
  function req(name) {
    try {
      return hostRequire(name);
    } catch (e) {
      return null;
    }
  }
  var uxp = req("uxp");
  var ps = req("photoshop");
  var os = req("os");
  var fs = req("fs");
  var secure = uxp && uxp.storage && uxp.storage.secureStorage;
  var lfs = uxp && uxp.storage && uxp.storage.localFileSystem;
  var DATA = "plugin-data:/";
  var SRGB = "sRGB IEC61966-2.1";

  function modal(name, fn, opts) {
    if (!ps || !ps.core || typeof ps.core.executeAsModal !== "function") return Promise.reject(new Error("this Photoshop offers no modal scope"));
    var options = { commandName: name };
    if (opts && opts.timeOut) options.timeOut = opts.timeOut;
    var inside = false;
    return Promise.resolve()
      .then(function () {
        return ps.core.executeAsModal(function (ctx) {
          inside = true;
          return fn(ctx);
        }, options);
      })
      .catch(function (e) {
        throw inside ? e : markBusy(e);
      });
  }

  function findDoc(id) {
    if (!ps || !ps.app) return null;
    var docs = ps.app.documents || [];
    for (var i = 0; i < docs.length; i++) if (docs[i].id === id) return docs[i];
    return null;
  }

  async function play(descs) {
    return ps.action.batchPlay(descs, {});
  }

  async function selectLayers(docId, ids) {
    for (var i = 0; i < ids.length; i++) {
      var d = { _obj: "select", _target: [{ _ref: "layer", _id: ids[i] }], makeVisible: false };
      if (i > 0) d.selectionModifier = { _enum: "selectionModifierType", _value: "addToSelection" };
      await play([d]);
    }
  }

  // The frame of a placed smart object in document pixels, from the
  // corners in smartObjectMore.transform (verified live on 27.11).
  async function frameOf(docId, layerId) {
    var r = await play([{ _obj: "get", _target: [{ _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }] }]);
    var t = r && r[0] && r[0].smartObjectMore && r[0].smartObjectMore.transform;
    if (!t || t.length < 8) return null;
    var xs = [px(t[0]), px(t[2]), px(t[4]), px(t[6])];
    var ys = [px(t[1]), px(t[3]), px(t[5]), px(t[7])];
    var left = Math.min.apply(null, xs);
    var top = Math.min.apply(null, ys);
    return { left: left, top: top, width: Math.max.apply(null, xs) - left, height: Math.max.apply(null, ys) - top };
  }

  function findLayer(doc, id) {
    var stack = (doc.layers || []).slice();
    while (stack.length) {
      var l = stack.shift();
      if (l.id === id) return l;
      if (l.layers && l.layers.length) for (var i = 0; i < l.layers.length; i++) stack.push(l.layers[i]);
    }
    return null;
  }

  function boundsOf(l) {
    var b = l.bounds || {};
    var left = px(b.left);
    var top = px(b.top);
    return { left: left, top: top, width: px(b.right) - left, height: px(b.bottom) - top };
  }

  async function hasUserMask(docId, layerId) {
    try {
      var r = await play([{ _obj: "get", _target: [{ _property: "hasUserMask" }, { _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }] }]);
      return !!(r && r[0] && r[0].hasUserMask);
    } catch (e) {
      return false;
    }
  }

  async function layerInfo(d, l) {
    var kind = String(l.kind || "pixel");
    var background = !!l.isBackgroundLayer;
    return {
      id: l.id,
      name: String(l.name || ""),
      visible: l.visible !== false,
      bounds: boundsOf(l),
      kind: kind,
      background: background,
      locked: !!(l.allLocked || l.pixelsLocked),
      has_mask: await hasUserMask(d.id, l.id),
      clipped: !!l.isClippingMask
    };
  }

  // Pixels of an area (bounds inside the canvas) as exactly w x h, 8-bit
  // sRGB; from one layer when layerId is given (outside its pixels: clear).
  // Must run inside a modal scope.
  async function readArea(doc, layerId, bounds, w, h) {
    var opts = { documentID: doc.id, colorSpace: "RGB", colorProfile: SRGB, componentSize: 8, applyAlpha: false };
    if (layerId) opts.layerID = layerId;
    opts.sourceBounds = { left: bounds.left, top: bounds.top, right: bounds.left + bounds.width, bottom: bounds.top + bounds.height };
    if (w < bounds.width || h < bounds.height) opts.targetSize = { width: w, height: h };
    var got = await ps.imaging.getPixels(opts);
    var image = got.imageData;
    var img;
    try {
      // Width, height and components are read before dispose(): after it
      // they are error objects (verified live on 27.11).
      var data = toBytes(await image.getData({ chunky: true })).slice();
      img = { width: Number(image.width), height: Number(image.height), components: Number(image.components), data: data };
    } finally {
      image.dispose();
    }
    if (!(img.components >= 1 && img.components <= 4) || img.data.length !== img.width * img.height * img.components) throw new Error("Photoshop returned pixels this plugin cannot read");
    // With targetSize, sourceBounds come in the pyramid level's pixels
    // (level n: document pixels / 2^n; verified live on 27.11).
    var lv = Math.pow(2, Math.max(0, Number(got.level) || 0));
    var sb = got.sourceBounds ? { left: px(got.sourceBounds.left) * lv, top: px(got.sourceBounds.top) * lv, right: px(got.sourceBounds.right) * lv, bottom: px(got.sourceBounds.bottom) * lv } : null;
    var off = function (a, b) {
      return Math.abs(a - b) >= lv;
    };
    if (sb && (off(sb.left, bounds.left) || off(sb.top, bounds.top) || off(sb.right, bounds.left + bounds.width) || off(sb.bottom, bounds.top + bounds.height))) {
      // A layer smaller than the area: place what came back, clear around it.
      var k = img.width / Math.max(1, sb.right - sb.left);
      var rgba = img.components === 4 ? img : pixelsMod.addAlpha(img);
      return pixelsMod.sampleRegion(rgba, { x: 0, y: 0 }, { left: (bounds.left - sb.left) * k, top: (bounds.top - sb.top) * k, width: bounds.width * k, height: bounds.height * k }, w, h, 0);
    }
    if (img.width !== w || img.height !== h) return pixelsMod.resize(img, w, h);
    return img;
  }

  // Selects the layer a result goes above: the insert point, or the top of
  // its clipping chain (SPEC 3.8), or the top of the document.
  async function selectInsertPoint(doc, insert, notes) {
    var target = null;
    if (insert && insert.layer_id) {
      target = findLayer(doc, insert.layer_id);
      if (!target) notes.push("The layer it was made from is gone; the result went to the top.");
    }
    if (target) {
      var parent = target.parent && target.parent.layers ? target.parent : doc;
      var list = parent.layers || [];
      var at = -1;
      for (var i = 0; i < list.length; i++) if (list[i].id === target.id) at = i;
      while (at > 0 && list[at - 1] && list[at - 1].isClippingMask) at--;
      if (at >= 0) target = list[at];
      await selectLayers(doc.id, [target.id]);
      return;
    }
    var top = doc.layers && doc.layers[0];
    if (top) await selectLayers(doc.id, [top.id]);
  }

  var ANCHOR = { tl: "TOPLEFT", br: "BOTTOMRIGHT" };

  // Grows the canvas so the current image sits at offset (SPEC 3.6 Expand):
  // left and top first (anchored bottom right), then right and bottom
  // (anchored top left).
  async function growCanvas(doc, c) {
    var w0 = Math.round(Number(doc.width));
    var h0 = Math.round(Number(doc.height));
    var steps = [];
    if (c.offset.x > 0 || c.offset.y > 0) steps.push({ width: w0 + c.offset.x, height: h0 + c.offset.y, anchor: "br" });
    steps.push({ width: c.width, height: c.height, anchor: "tl" });
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      if (Math.round(Number(doc.width)) === s.width && Math.round(Number(doc.height)) === s.height) continue;
      var consts = ps.constants && ps.constants.AnchorPosition;
      if (typeof doc.resizeCanvas === "function" && consts) {
        await doc.resizeCanvas(s.width, s.height, consts[ANCHOR[s.anchor]]);
      } else {
        await play([
          {
            _obj: "canvasSize",
            width: { _unit: "pixelsUnit", _value: s.width },
            height: { _unit: "pixelsUnit", _value: s.height },
            horizontal: { _enum: "horizontalLocation", _value: s.anchor === "br" ? "right" : "left" },
            vertical: { _enum: "verticalLocation", _value: s.anchor === "br" ? "bottom" : "top" }
          }
        ]);
      }
    }
    if (Math.round(Number(doc.width)) !== c.width || Math.round(Number(doc.height)) !== c.height) throw new Error("the canvas did not reach " + c.width + " x " + c.height);
  }

  // Places one file as an embedded smart object above the selected layer,
  // fitted to fit {width, height, center_x, center_y}. Returns the layer.
  async function placeFile(doc, path, fit, notes) {
    var entry = await entryFor(path);
    var token = lfs.createSessionToken(entry);
    await play([
      {
        _obj: "placeEvent",
        null: { _path: token, _kind: "local" },
        freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
        offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } }
      }
    ]);
    var layer = doc.activeLayers[0];
    var frame = await frameOf(doc.id, layer.id);
    if (frame && frame.width > 0 && frame.height > 0) {
      var sx = (fit.width / frame.width) * 100;
      var sy = (fit.height / frame.height) * 100;
      if (Math.abs(sx - 100) > 0.01 || Math.abs(sy - 100) > 0.01) await layer.scale(sx, sy);
      var after = await frameOf(doc.id, layer.id);
      var dx = fit.center_x - (after.left + after.width / 2);
      var dy = fit.center_y - (after.top + after.height / 2);
      if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) await layer.translate(dx, dy);
    } else {
      notes.push("The layer's frame could not be read; it is placed at Photoshop's default size.");
    }
    return layer;
  }

  async function setXmp(doc, layerId, packet) {
    await play([{ _obj: "set", _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, { _ref: "layer", _id: layerId }, { _ref: "document", _id: doc.id }], to: { _obj: "layer", XMPMetadataAsUTF8: packet } }]);
  }

  async function putMask(doc, layerId, m) {
    var data = await ps.imaging.createImageDataFromBuffer(m.data, { width: m.width, height: m.height, components: 1, chunky: true, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2" });
    try {
      await ps.imaging.putLayerMask({ documentID: doc.id, layerID: layerId, kind: "user", imageData: data, targetBounds: { left: m.left, top: m.top } });
    } finally {
      data.dispose();
    }
  }

  // The Background layer becomes a normal layer (Remove BG's Mask on the
  // layer, SPEC 3.6), as Layer > New > Layer from Background does.
  async function fromBackground(doc, layer) {
    await play([{ _obj: "set", _target: [{ _ref: "layer", _property: "background" }], to: { _obj: "layer", opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } } }]);
    return findLayer(doc, layer.id) || doc.activeLayers[0];
  }

  async function deleteLayer(doc, layer) {
    if (typeof layer.delete === "function") await layer.delete();
    else await play([{ _obj: "delete", _target: [{ _ref: "layer", _id: layer.id }] }]);
  }

  // Remove BG (SPEC 3.6): the cutout's alpha becomes a mask, on the source
  // layer or on a copy of the source pixels. The result is placed for a
  // moment to read its alpha, then removed.
  async function cutout(doc, plan, notes) {
    var c = plan.cutout;
    var source = findLayer(doc, c.layer_id);
    if (!source) throw new Error("the source layer is gone");
    await selectLayers(doc.id, [source.id]);
    var temp = await placeFile(doc, plan.takes[0].path, plan.takes[0].fit, notes);
    var box = c.box;
    var read = await readArea(doc, temp.id, box, box.width, box.height);
    var alpha = pixelsMod.alphaMask(read);
    await deleteLayer(doc, temp);
    var mb = c.mask_box;
    var mask = pixelsMod.placeInto(alpha, mb.width, mb.height, box.left - mb.left, box.top - mb.top);
    var target;
    if (c.lands === "mask") {
      if (source.isBackgroundLayer) source = await fromBackground(doc, source);
      target = source;
    } else {
      await selectLayers(doc.id, [source.id]);
      target = await placeFile(doc, c.source_path, c.source_fit, notes);
      target.name = c.name;
      await setXmp(doc, target.id, c.xmp);
    }
    await putMask(doc, target.id, { left: mb.left, top: mb.top, width: mb.width, height: mb.height, data: mask.data });
    return target;
  }

  async function entryFor(path) {
    if (!lfs) throw new Error("this Photoshop offers no file access");
    if (typeof lfs.getEntryWithUrl === "function") {
      try {
        return await lfs.getEntryWithUrl(DATA + path);
      } catch (e) {
        // fall back to the data folder below
      }
    }
    var folder = await lfs.getDataFolder();
    return folder.getEntry(path);
  }

  async function mkdirs(path) {
    if (!fs) throw new Error("no file system");
    var parts = String(path).split("/");
    var at = "";
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      at = at ? at + "/" + parts[i] : parts[i];
      try {
        await fs.mkdir(DATA + at);
      } catch (e) {
        // it exists already, or the write that follows reports the problem
      }
    }
  }

  var shell = uxp && uxp.shell;

  return {
    WebSocket: g.WebSocket,
    crypto: g.crypto,
    fetch: typeof g.fetch === "function" ? g.fetch.bind(g) : null,
    AbortController: typeof g.AbortController === "function" ? g.AbortController : null,
    timers: {
      setTimeout: function (fn, ms) {
        return g.setTimeout(fn, ms);
      },
      clearTimeout: function (t) {
        g.clearTimeout(t);
      },
      now: function () {
        return Date.now();
      }
    },

    secureGet: async function (key) {
      if (!secure) throw new Error("secureStorage is not available");
      var v = await secure.getItem(key);
      if (v === null || v === undefined) return null;
      if (typeof v === "string") return v;
      return utf8.decode(toBytes(v));
    },
    secureSet: async function (key, value) {
      if (!secure) throw new Error("secureStorage is not available");
      await secure.setItem(key, value);
    },
    // removeItem where UXP offers it; otherwise the entry is overwritten
    // with an empty value, which every reader treats as absent.
    secureRemove: async function (key) {
      if (!secure) throw new Error("secureStorage is not available");
      if (typeof secure.removeItem === "function") {
        await secure.removeItem(key);
        return;
      }
      await secure.setItem(key, "");
    },

    // Opens a page in the browser. Photoshop asks the person first, every time.
    openExternal: async function (url) {
      if (!shell || typeof shell.openExternal !== "function") throw new Error("this Photoshop cannot open links");
      return shell.openExternal(url, "Opens a Scenario page in your browser.");
    },

    photoshopVersion: function () {
      try {
        return (uxp && uxp.host && uxp.host.version) || (ps && ps.app && ps.app.version) || null;
      } catch (e) {
        return null;
      }
    },
    osName: function () {
      try {
        if (!os) return null;
        var name = typeof os.platform === "function" ? os.platform() : null;
        var release = typeof os.release === "function" ? os.release() : null;
        if (!name) return null;
        return release ? name + " " + release : name;
      } catch (e) {
        return null;
      }
    },
    listDocuments: function () {
      var out = [];
      if (!ps || !ps.app || !ps.app.documents) return out;
      var docs = ps.app.documents;
      for (var i = 0; i < docs.length; i++) {
        var d = docs[i];
        out.push({ id: d.id, title: d.title || d.name || "" });
      }
      return out;
    },
    activeDocumentId: function () {
      if (!ps || !ps.app) return null;
      var d = ps.app.activeDocument;
      return d ? d.id : null;
    },
    // Width and height in pixels of an open document (the active one when
    // id is null), or null. Read only: no modal state, no document change.
    documentSize: function (id) {
      try {
        if (!ps || !ps.app) return null;
        var d = null;
        if (id === null || id === undefined) d = ps.app.activeDocument;
        else {
          var docs = ps.app.documents || [];
          for (var i = 0; i < docs.length; i++) if (docs[i].id === id) d = docs[i];
        }
        if (!d) return null;
        var w = Number(d.width);
        var h = Number(d.height);
        if (!(w > 0 && h > 0)) return null;
        return { id: d.id, width: Math.round(w), height: Math.round(h) };
      } catch (e) {
        return null;
      }
    },

    readDataText: async function (name) {
      if (!fs) return null;
      try {
        var text = await fs.readFile(DATA + name, { encoding: "utf-8" });
        return typeof text === "string" ? text : utf8.decode(toBytes(text));
      } catch (e) {
        return null;
      }
    },
    writeDataText: async function (name, text) {
      if (!fs) return false;
      try {
        await fs.writeFile(DATA + name, text, { encoding: "utf-8" });
        return true;
      } catch (e) {
        return false;
      }
    },
    removeData: async function (name) {
      if (!fs) return false;
      try {
        await fs.unlink(DATA + name);
        return true;
      } catch (e) {
        try {
          await fs.writeFile(DATA + name, "", { encoding: "utf-8" });
        } catch (e2) {
          // nothing more to do
        }
        return false;
      }
    },

    // ---- files in the plugin data folder (job records, results) ----

    ensureDataDir: mkdirs,
    listData: async function (dir) {
      if (!fs) return [];
      try {
        var names = await fs.readdir(DATA + dir);
        return Array.isArray(names) ? names.map(String) : [];
      } catch (e) {
        return [];
      }
    },
    // Written to <name>.tmp, then renamed over <name>. If this Photoshop's
    // rename refuses an existing target, the target is removed first; if
    // rename fails even then, the record is written in place and the
    // temporary copy removed. The ledger reads the temporary file back if a
    // write stops in between.
    writeDataAtomic: async function (name, text) {
      if (!fs) return false;
      try {
        await fs.writeFile(DATA + name + ".tmp", text, { encoding: "utf-8" });
      } catch (e) {
        return false;
      }
      try {
        await fs.rename(DATA + name + ".tmp", DATA + name);
        return true;
      } catch (e) {
        // try the next way
      }
      try {
        try {
          await fs.unlink(DATA + name);
        } catch (e2) {
          // no previous file
        }
        await fs.rename(DATA + name + ".tmp", DATA + name);
        return true;
      } catch (e) {
        // try the next way
      }
      try {
        await fs.writeFile(DATA + name, text, { encoding: "utf-8" });
        try {
          await fs.unlink(DATA + name + ".tmp");
        } catch (e3) {
          // the newer copy is read back by revision
        }
        return true;
      } catch (e) {
        return false;
      }
    },
    writeDataBinary: async function (name, bytes) {
      if (!fs) throw new Error("no file system");
      await fs.writeFile(DATA + name, bufferOf(bytes));
      return true;
    },
    // A rename that fails twice is done as a copy, then the source goes.
    renameData: async function (from, to) {
      if (!fs) throw new Error("no file system");
      try {
        await fs.rename(DATA + from, DATA + to);
        return true;
      } catch (e) {
        // try the next way
      }
      try {
        try {
          await fs.unlink(DATA + to);
        } catch (e2) {
          // no previous file
        }
        await fs.rename(DATA + from, DATA + to);
        return true;
      } catch (e) {
        // try the next way
      }
      var data = await fs.readFile(DATA + from);
      await fs.writeFile(DATA + to, data);
      try {
        await fs.unlink(DATA + from);
      } catch (e3) {
        // a leftover .part file is harmless
      }
      return true;
    },

    // ---- document reads ----

    // The selection's bounds in document pixels, or null. Read only.
    selectionBounds: async function (docId) {
      if (!ps || !ps.action) return null;
      try {
        var r = await play([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: docId }] }]);
        var sel = r && r[0] && r[0].selection;
        if (!sel || sel.left === undefined) return null;
        var left = Math.round(px(sel.left));
        var top = Math.round(px(sel.top));
        var right = Math.round(px(sel.right));
        var bottom = Math.round(px(sel.bottom));
        if (!(right > left && bottom > top)) return null;
        return { left: left, top: top, width: right - left, height: bottom - top };
      } catch (e) {
        return null;
      }
    },
    // The active layer of a document: { id, name, visible, bounds, kind,
    // background, locked, has_mask }, or null.
    activeLayerInfo: async function (docId) {
      var d = findDoc(docId);
      if (!d) return null;
      try {
        var layers = d.activeLayers || [];
        var l = layers[0];
        if (!l) return null;
        return await layerInfo(d, l);
      } catch (e) {
        return null;
      }
    },
    // The same for a layer by id, or null when it is gone.
    layerInfo: async function (docId, layerId) {
      var d = findDoc(docId);
      if (!d) return null;
      try {
        var l = findLayer(d, layerId);
        return l ? await layerInfo(d, l) : null;
      } catch (e) {
        return null;
      }
    },
    // Pixels as 8-bit sRGB, read at most at long_side on the long side, in
    // one modal scope; imaging needs one (verified live on 27.11).
    // req: { document_id, layer_id (none: all visible), bounds, long_side,
    // exact (exactly the bounds, padded clear outside a layer) }.
    // Resolves { width, height, components, data }.
    readPixels: function (req) {
      return modal("Scenario: Read reference", async function () {
        if (req.exact && req.bounds) {
          // Exactly the bounds, at most long_side on the long side; outside a
          // layer's own pixels: clear (captures, SPEC 5.8).
          var bw = req.bounds.width;
          var bh = req.bounds.height;
          var k = req.long_side && Math.max(bw, bh) > req.long_side ? req.long_side / Math.max(bw, bh) : 1;
          var d0 = findDoc(req.document_id);
          if (!d0) throw new Error("the document was closed");
          return readArea(d0, req.layer_id || null, req.bounds, Math.max(1, Math.round(bw * k)), Math.max(1, Math.round(bh * k)));
        }
        var opts = { documentID: req.document_id, colorSpace: "RGB", colorProfile: SRGB, componentSize: 8, applyAlpha: false };
        if (req.layer_id) opts.layerID = req.layer_id;
        var w = null;
        var h = null;
        if (req.bounds) {
          opts.sourceBounds = { left: req.bounds.left, top: req.bounds.top, right: req.bounds.left + req.bounds.width, bottom: req.bounds.top + req.bounds.height };
          w = req.bounds.width;
          h = req.bounds.height;
        }
        if (req.long_side) {
          if (w === null) {
            var d = findDoc(req.document_id);
            w = d ? Number(d.width) : req.long_side;
            h = d ? Number(d.height) : req.long_side;
          }
          if (Math.max(w, h) > req.long_side) opts.targetSize = w >= h ? { width: req.long_side } : { height: req.long_side };
        }
        var got = await ps.imaging.getPixels(opts);
        var image = got.imageData;
        try {
          var data = await image.getData({ chunky: true });
          return { width: image.width, height: image.height, components: image.components, data: toBytes(data).slice() };
        } finally {
          image.dispose();
        }
      });
    },
    // JPEG bytes of opaque RGB pixels, encoded by Photoshop.
    encodeJpeg: function (pixels) {
      return modal("Scenario: Encode reference", async function () {
        var image = await ps.imaging.createImageDataFromBuffer(pixels.data, { width: pixels.width, height: pixels.height, components: 3, chunky: true, colorSpace: "RGB", colorProfile: SRGB });
        try {
          var text = await ps.imaging.encodeImageData({ imageData: image, base64: true });
          var bytes = b64.decodeStandard(String(text).replace(/^data:[^,]*,/, ""));
          if (!bytes) throw new Error("Photoshop's JPEG encoder returned no data");
          return bytes;
        } finally {
          image.dispose();
        }
      });
    },
    // The selection as a gray mask in document pixels, or null.
    readSelectionMask: function (docId) {
      return modal("Scenario: Read selection", async function () {
        var got = await ps.imaging.getSelection({ documentID: docId });
        if (!got || !got.imageData) return null;
        try {
          var b = got.sourceBounds || {};
          var data = await got.imageData.getData({ chunky: true });
          return { left: px(b.left), top: px(b.top), width: got.imageData.width, height: got.imageData.height, data: toBytes(data).slice() };
        } finally {
          got.imageData.dispose();
        }
      });
    },
    // A PNG or JPEG the person picks; null when they cancel.
    chooseImageFile: async function () {
      if (!lfs || typeof lfs.getFileForOpening !== "function") throw new Error("this Photoshop cannot open a file dialog");
      var file = await lfs.getFileForOpening({ types: ["png", "jpg", "jpeg"], allowMultiple: false });
      if (Array.isArray(file)) file = file[0];
      if (!file) return null;
      var formats = uxp.storage.formats;
      var data = await file.read(formats ? { format: formats.binary } : {});
      return { name: String(file.name || "file"), bytes: toBytes(data) };
    },

    // ---- placement (SPEC 5.3, 5.7, 6.5) ----

    // Carries out an apply/plan.js plan in one modal scope and one History
    // state. Takes are placed with placeEvent (an embedded smart object at
    // its native size, centered: verified live on 27.11), last take first
    // above the insert point (the top of the document, or the layer the edit
    // read, above its clipping chain), so take 1 ends on top; each is fitted
    // to its box, named, and given its metadata. Several takes are grouped,
    // takes 2 to n hidden. A mask goes on the group, or on the one layer.
    // Expand grows the canvas first (in a copy of the document when asked);
    // Remove BG puts the cutout's alpha on the source layer or on a copy of
    // its pixels. plan.reads asks for small reads used by the checks: the
    // composite before any change, each take before its mask, the composite
    // after. opts.decide(reads) may answer { mask: false } to land unmasked.
    // Anything failing rolls the History state back, so the document is as it
    // was. opts.auto: Place when ready (waits at most 1 s for the modal
    // state, restores the person's active layers).
    // Resolves { document_id, layer_ids, group_id, notes, reads, masked }.
    placeResults: function (plan, opts) {
      opts = opts || {};
      return modal(
        plan.history_name,
        async function (ctx) {
          var doc;
          var notes = [];
          if (plan.new_document) {
            var o = { width: plan.new_document.width, height: plan.new_document.height, resolution: 72, name: plan.new_document.name, profile: SRGB };
            if (ps.constants && ps.constants.NewDocumentMode) o.mode = ps.constants.NewDocumentMode.RGB;
            if (ps.constants && ps.constants.DocumentFill) o.fill = ps.constants.DocumentFill.WHITE;
            try {
              doc = await ps.app.createDocument(o);
            } catch (e) {
              delete o.profile;
              doc = await ps.app.createDocument(o);
            }
          } else {
            doc = findDoc(plan.document_id);
            if (!doc) throw new Error("the document was closed");
            var active = ps.app.activeDocument;
            if (!active || active.id !== doc.id) {
              var na = new Error("the document is not the active one");
              na.notActive = true;
              throw na;
            }
            if (plan.duplicate) {
              doc = await doc.duplicate(plan.duplicate.name);
              if (ps.app.activeDocument && ps.app.activeDocument.id !== doc.id) ps.app.activeDocument = doc;
            }
          }
          var before = [];
          try {
            before = (doc.activeLayers || []).map(function (l) {
              return l.id;
            });
          } catch (e) {
            before = [];
          }
          var reads = { before: null, takes: [], after: null };
          var R = plan.reads || {};
          var hc = ctx.hostControl;
          var sid = await hc.suspendHistory({ documentID: doc.id, name: plan.history_name });
          var placed = [];
          var groupId = null;
          var masked = false;
          try {
            if (R.before) reads.before = await readArea(doc, null, R.before.bounds, R.before.width, R.before.height);
            if (plan.canvas) await growCanvas(doc, plan.canvas);
            if (plan.cutout) {
              var t = await cutout(doc, plan, notes);
              placed.push(t);
              masked = true;
            } else {
              await selectInsertPoint(doc, plan.insert, notes);
              for (var i = plan.takes.length - 1; i >= 0; i--) {
                var take = plan.takes[i];
                var layer = await placeFile(doc, take.path, take.fit, notes);
                layer.name = take.name;
                await setXmp(doc, layer.id, take.xmp);
                placed.unshift(layer);
              }
              if (R.takes) {
                for (var r = 0; r < placed.length; r++) reads.takes.push(await readArea(doc, placed[r].id, R.takes.bounds, R.takes.width, R.takes.height));
              }
              var useMask = !!plan.mask;
              if (useMask && typeof opts.decide === "function") {
                var d = opts.decide(reads);
                if (d && d.mask === false) {
                  useMask = false;
                  if (d.note) notes.push(d.note);
                }
              }
              var maskTarget = placed.length === 1 ? placed[0] : null;
              if (placed.length > 1) {
                var group;
                if (typeof doc.createLayerGroup === "function") group = await doc.createLayerGroup({ name: plan.group.name, fromLayers: placed });
                else group = await doc.groupLayers(placed);
                group.name = plan.group.name;
                groupId = group.id;
                await setXmp(doc, group.id, plan.group.xmp);
                for (var v = 1; v < placed.length; v++) placed[v].visible = false;
                maskTarget = group;
              }
              if (useMask && maskTarget) {
                try {
                  await putMask(doc, maskTarget.id, plan.mask);
                  masked = true;
                } catch (e) {
                  notes.push("Placed unmasked: the mask could not be applied.");
                }
              }
            }
            if (R.after) reads.after = await readArea(doc, null, R.after.bounds, R.after.width, R.after.height);
            if (opts.auto && before.length && !plan.new_document && !plan.duplicate) {
              try {
                await selectLayers(doc.id, before);
              } catch (e) {
                // the new layer stays active
              }
            }
            await hc.resumeHistory(sid, true);
          } catch (e) {
            try {
              await hc.resumeHistory(sid, false);
            } catch (e2) {
              // nothing more to undo
            }
            throw e;
          }
          return {
            document_id: doc.id,
            layer_ids: placed.map(function (l) {
              return l.id;
            }),
            group_id: groupId,
            notes: notes,
            reads: reads,
            masked: masked
          };
        },
        opts.auto ? { timeOut: 1000 } : null
      );
    },

    // Undoes the last History state of a document when it is the one named
    // (the "Changed outside" card's Undo, SPEC 6.5). Resolves true when done.
    undoLast: function (docId, name) {
      return modal("Scenario: Undo", async function () {
        var doc = findDoc(docId);
        if (!doc) return false;
        var active = ps.app.activeDocument;
        if (!active || active.id !== docId) return false;
        var st = doc.activeHistoryState;
        if (st && st.name !== undefined && st.name !== name) return false;
        await play([{ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }]);
        return true;
      });
    },
    // Calls fn() (coalesced at 200 ms) when the active document, the
    // selection or the layers may have changed (SPEC 3.8).
    onDocumentEvents: function (fn) {
      if (!ps || !ps.action || typeof ps.action.addNotificationListener !== "function") return false;
      var pending = null;
      var events = ["select", "set", "make", "delete", "open", "close", "placeEvent", "crop", "canvasSize", "imageSize"];
      try {
        ps.action.addNotificationListener(
          events.map(function (e) {
            return { event: e };
          }),
          function () {
            if (pending) return;
            pending = g.setTimeout(function () {
              pending = null;
              fn();
            }, 200);
          }
        );
        return true;
      } catch (e) {
        return false;
      }
    },

    clipboardWrite: async function (text) {
      var clip = g.navigator && g.navigator.clipboard;
      if (!clip) throw new Error("clipboard is not available");
      if (typeof clip.writeText === "function") return clip.writeText(text);
      if (typeof clip.setContent === "function") return clip.setContent({ "text/plain": text });
      throw new Error("clipboard is not available");
    },

    // Clears the clipboard only if it still holds `text`. Resolves true when cleared.
    clipboardClearIf: async function (text) {
      var clip = g.navigator && g.navigator.clipboard;
      if (!clip) return false;
      var now = null;
      if (typeof clip.readText === "function") now = await clip.readText();
      else if (typeof clip.getContent === "function") {
        var content = await clip.getContent();
        now = content && content["text/plain"];
      }
      if (now !== text) return false;
      if (typeof clip.writeText === "function") await clip.writeText("");
      else if (typeof clip.setContent === "function") await clip.setContent({ "text/plain": "" });
      else return false;
      return true;
    },

    setupEntrypoints: function (def) {
      if (uxp && uxp.entrypoints && typeof uxp.entrypoints.setup === "function") uxp.entrypoints.setup(def);
    }
  };
}

module.exports = { createHost: createHost };
