"use strict";
// Everything the plugin reads from UXP and Photoshop goes through this adapter,
// so the rest of the code runs under Node with a fake host in the tests.
// Every call is wrapped: a missing API returns null instead of throwing.

var utf8 = require("./util/utf8.js");
var b64 = require("./util/base64url.js");

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
    // The active layer of a document: { id, name, visible, bounds }, or null.
    activeLayerInfo: async function (docId) {
      var d = findDoc(docId);
      if (!d) return null;
      try {
        var layers = d.activeLayers || [];
        var l = layers[0];
        if (!l) return null;
        var b = l.bounds || {};
        var left = px(b.left);
        var top = px(b.top);
        return { id: l.id, name: String(l.name || ""), visible: l.visible !== false, bounds: { left: left, top: top, width: px(b.right) - left, height: px(b.bottom) - top } };
      } catch (e) {
        return null;
      }
    },
    // Pixels as 8-bit sRGB, read at most at long_side on the long side, in
    // one modal scope; imaging needs one (verified live on 27.11).
    // req: { document_id, layer_id (none: all visible), bounds, long_side }.
    // Resolves { width, height, components, data }.
    readPixels: function (req) {
      return modal("Scenario: Read reference", async function () {
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
    // above the top layer, so take 1 ends on top; each is scaled to cover the
    // box and centered on it, named, and given its metadata. Several takes
    // are grouped, takes 2 to n hidden. A mask from the selection goes on the
    // group, or on the one layer. Anything failing rolls the History state
    // back, so the document is as it was. opts.auto: Place when ready (waits
    // at most 1 s for the modal state, restores the person's active layers).
    // Resolves { document_id, layer_ids, group_id, notes }.
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
          }
          var before = [];
          try {
            before = (doc.activeLayers || []).map(function (l) {
              return l.id;
            });
          } catch (e) {
            before = [];
          }
          var hc = ctx.hostControl;
          var sid = await hc.suspendHistory({ documentID: doc.id, name: plan.history_name });
          var placed = [];
          var groupId = null;
          try {
            var top = doc.layers && doc.layers[0];
            if (top) await selectLayers(doc.id, [top.id]);
            for (var i = plan.takes.length - 1; i >= 0; i--) {
              var take = plan.takes[i];
              var entry = await entryFor(take.path);
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
                var pct = (take.fit.width / frame.width) * 100;
                if (Math.abs(pct - 100) > 0.01) await layer.scale(pct, pct);
                var after = await frameOf(doc.id, layer.id);
                var dx = take.fit.center_x - (after.left + after.width / 2);
                var dy = take.fit.center_y - (after.top + after.height / 2);
                if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) await layer.translate(dx, dy);
              } else {
                notes.push("The layer's frame could not be read; it is placed at Photoshop's default size.");
              }
              layer.name = take.name;
              await play([{ _obj: "set", _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, { _ref: "layer", _id: layer.id }, { _ref: "document", _id: doc.id }], to: { _obj: "layer", XMPMetadataAsUTF8: take.xmp } }]);
              placed.unshift(layer);
            }
            var maskTarget = placed.length === 1 ? placed[0] : null;
            if (placed.length > 1) {
              var group;
              if (typeof doc.createLayerGroup === "function") group = await doc.createLayerGroup({ name: plan.group.name, fromLayers: placed });
              else group = await doc.groupLayers(placed);
              group.name = plan.group.name;
              groupId = group.id;
              await play([{ _obj: "set", _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, { _ref: "layer", _id: group.id }, { _ref: "document", _id: doc.id }], to: { _obj: "layer", XMPMetadataAsUTF8: plan.group.xmp } }]);
              for (var v = 1; v < placed.length; v++) placed[v].visible = false;
              maskTarget = group;
            }
            if (plan.mask && maskTarget) {
              try {
                var maskData = await ps.imaging.createImageDataFromBuffer(plan.mask.data, { width: plan.mask.width, height: plan.mask.height, components: 1, chunky: true, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2" });
                try {
                  await ps.imaging.putLayerMask({ documentID: doc.id, layerID: maskTarget.id, kind: "user", imageData: maskData, targetBounds: { left: plan.mask.left, top: plan.mask.top } });
                } finally {
                  maskData.dispose();
                }
              } catch (e) {
                notes.push("Placed unmasked: the selection mask could not be applied.");
              }
            }
            if (opts.auto && before.length && !plan.new_document) {
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
            notes: notes
          };
        },
        opts.auto ? { timeOut: 1000 } : null
      );
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
