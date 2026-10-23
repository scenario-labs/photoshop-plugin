"use strict";
// A fake of the UXP modules the plugin requires (uxp, photoshop, fs, os),
// enough for plugin/src/host.js to run unchanged under Node: documents with
// layers and a selection, batchPlay for the descriptors the plugin plays
// (select, get selection, get layer, placeEvent, set XMP), executeAsModal
// with suspendHistory and resumeHistory, imaging (getPixels, getSelection,
// createImageDataFromBuffer, encodeImageData, putLayerMask), the plugin
// data folder as a Map, and the file dialog.
//
// It models the parts of Photoshop's behavior the plugin depends on, as
// observed live on 27.11 where marked in host.js: placeEvent places an
// embedded smart object at its native size centered on the canvas (scaled
// down to fit when larger: Photoshop's default "Resize image during place"),
// above the selected layer, and makes it the active layer. Everything else is
// a model, not a measurement.

const png = require("../../plugin/src/util/png.js");
const jpeg = require("../../plugin/src/util/jpeg.js");
const { createScene, selectionMask } = require("./fake-scene.js");

const DATA = "plugin-data:/";

function name(path) {
  if (!String(path).startsWith(DATA)) throw new Error(`fake fs: not in the data folder: ${path}`);
  return String(path).slice(DATA.length);
}

// Deterministic bytes: noise or a smooth gradient.
function fill(w, h, comps, pattern, seed = 1) {
  const out = new Uint8Array(w * h * comps);
  let s = seed >>> 0 || 1;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < comps; c++, i++) {
        if (comps === 4 && c === 3) {
          out[i] = 255;
          continue;
        }
        if (pattern === "blank") {
          out[i] = 255;
          continue;
        }
        if (pattern === "noise") {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          out[i] = s >>> 24;
        } else out[i] = (x * (c + 1) + y * (3 - c)) & 255;
      }
    }
  }
  return out;
}

// A JPEG-shaped file Photoshop's encoder stands in for: real markers (SOI,
// APP0, APP1 Exif, SOF0 with the size, SOS, EOI) around a payload whose size
// grows with the pixel count (bytesPerPixel), so size limits are exercised.
function fakeJpeg(w, h, bytesPerPixel) {
  const payload = Math.max(16, Math.round(w * h * bytesPerPixel));
  const parts = [];
  parts.push([0xff, 0xd8]);
  parts.push([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const exif = Buffer.from("Exif\u0000\u0000fake camera data", "latin1");
  parts.push([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif]);
  parts.push([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  parts.push([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
  const body = new Uint8Array(payload);
  let s = 7;
  for (let i = 0; i < payload; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    body[i] = (s >>> 16) % 0xfe;
  }
  parts.push(body);
  parts.push([0xff, 0xd9]);
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

// opts: { docs: [{id, title, width, height, pattern, layers: [{name, alpha,
//         kind, background, locked, clipped, content: "pattern" | "solid",
//         fill: [r, g, b], frame, mask}], selection: {left, top, width,
//         height, shape: "rect" | "ellipse", feather}}], active (doc id),
//         scene (pixels from fake-scene.js: composites, layer reads with
//         alpha, masks, canvas resize, flatten, duplicate, close, undo),
//         maskBroken (putLayerMask stores nothing: the outside check fails),
//         files: Map (data folder, names without the prefix), secure: Map,
//         chosenFile: {name, bytes} | null, busy: n (modal refusals before
//         one succeeds), jpegBytesPerPixel, renameRefusesExisting,
//         noRename }
function createFakePhotoshop(opts = {}) {
  const files = opts.files || new Map();
  const dirs = new Set();
  const secure = opts.secure || new Map();
  const enc = new TextEncoder();
  const ps = {
    files,
    dirs,
    secure,
    history: [],
    rolledBack: [],
    modals: [],
    played: [],
    notifications: [],
    tokens: new Map(),
    opened: [],
    busy: opts.busy || 0,
    chosenFile: opts.chosenFile === undefined ? null : opts.chosenFile,
    dialogs: 0,
    jpegBytesPerPixel: opts.jpegBytesPerPixel || 0.3,
    reads: [],
    moves: []
  };
  let nextId = 1000;
  let inModal = false;
  const scene = opts.scene ? createScene({ files }) : null;
  ps.scene = scene;
  // Per document: committed History states, newest last, with the state
  // before each (scene mode undo).
  const undo = new Map();

  function makeLayer(doc, spec) {
    const layer = {
      id: ++nextId,
      name: spec.name || "Layer",
      kind: spec.kind || "pixel",
      visible: spec.visible !== false,
      alpha: !!spec.alpha,
      frame: spec.frame || { left: 0, top: 0, width: doc.width, height: doc.height },
      xmp: spec.xmp || null,
      mask: spec.mask ? maskOf(spec.mask) : null,
      path: spec.path || null,
      layers: spec.layers || null,
      isBackgroundLayer: !!spec.background,
      allLocked: !!spec.locked,
      pixelsLocked: false,
      isClippingMask: !!spec.clipped,
      content: spec.content || (spec.path ? "file" : spec.fill ? "solid" : "pattern"),
      fill: spec.fill || null,
      raster: spec.raster || null,
      parent: null,
      async delete() {
        if (!inModal) throw new Error("delete needs a modal scope");
        removeLayer(doc, this);
      },
      // Layer.move(relativeTo, placement): placeAfter puts it right under
      // relativeTo, placeBefore right above, in relativeTo's list.
      async move(rel, placement) {
        if (!inModal) throw new Error("move needs a modal scope");
        removeLayer(doc, this);
        const list = rel.parent && rel.parent.layers ? rel.parent.layers : doc.layers;
        const at = list.indexOf(rel);
        if (at < 0) throw new Error("fake: move target is not in the document");
        list.splice(placement === "placeAfter" ? at + 1 : at, 0, this);
        this.parent = rel.parent || null;
        ps.moves.push({ id: this.id, rel: rel.id, placement });
      },
      get bounds() {
        const f = this.frame;
        return { left: f.left, top: f.top, right: f.left + f.width, bottom: f.top + f.height };
      },
      async scale(px, py) {
        if (!inModal) throw new Error("scale needs a modal scope");
        const f = this.frame;
        const cx = f.left + f.width / 2;
        const cy = f.top + f.height / 2;
        const w = (f.width * px) / 100;
        const h = (f.height * py) / 100;
        this.frame = { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
      },
      async translate(dx, dy) {
        if (!inModal) throw new Error("translate needs a modal scope");
        this.frame = { ...this.frame, left: this.frame.left + dx, top: this.frame.top + dy };
      }
    };
    // A group given as specs (a document opened with a group in it): its
    // layers are made here, each with the group as parent.
    if (layer.layers) {
      layer.layers = layer.layers.map((l) => (l && l.id ? l : makeLayer(doc, l)));
      for (const l of layer.layers) if (!l.parent) l.parent = layer;
    }
    return layer;
  }

  function maskOf(m) {
    const out = { width: m.width, height: m.height, left: m.left, top: m.top };
    Object.defineProperty(out, "data", { value: m.data || null, enumerable: false, writable: true });
    return out;
  }

  // A mask over a frame: an ellipse inscribed in it, or the whole rectangle.
  function ellipseMask(f, shape) {
    const w = Math.max(1, Math.round(f.width)), h = Math.max(1, Math.round(f.height));
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w / 2) / (w / 2), dy = (y + 0.5 - h / 2) / (h / 2);
      data[y * w + x] = shape !== "ellipse" || dx * dx + dy * dy <= 1 ? 255 : 0;
    }
    const m = maskOf({ width: w, height: h, left: Math.round(f.left), top: Math.round(f.top), data });
    Object.defineProperty(m, "shape", { value: shape, enumerable: false });
    return m;
  }

  function removeLayer(doc, layer) {
    const lists = [doc.layers];
    while (lists.length) {
      const list = lists.shift();
      const at = list.indexOf(layer);
      if (at >= 0) {
        list.splice(at, 1);
        doc.activeLayers = doc.activeLayers.filter((l) => l !== layer);
        if (!doc.activeLayers.length && doc.layers[0]) doc.activeLayers = [doc.layers[0]];
        return;
      }
      for (const l of list) if (l.layers) lists.push(l.layers);
    }
  }

  function allLayers(doc) {
    const out = [];
    const stack = [...doc.layers];
    while (stack.length) {
      const l = stack.shift();
      out.push(l);
      if (l.layers) stack.push(...l.layers);
    }
    return out;
  }

  function makeDoc(spec) {
    const doc = {
      id: spec.id,
      title: spec.title || `Untitled-${spec.id}`,
      // The saved file's path ("" when never saved), as UXP's Document.path.
      path: spec.path || "",
      width: spec.width || 1024,
      height: spec.height || 1024,
      pattern: spec.pattern || "gradient",
      selection: spec.selection || null,
      // The document's own XMP packet (File Info), as XMPMetadataAsUTF8.
      xmp: spec.xmp || null,
      layers: [],
      activeLayers: [],
      async createLayerGroup(o) {
        if (!inModal) throw new Error("createLayerGroup needs a modal scope");
        const from = o.fromLayers || [];
        const at = Math.min(...from.map((l) => doc.layers.indexOf(l)));
        const group = makeLayer(doc, { name: o.name || "Group", kind: "group", layers: from.slice() });
        for (const l of from) l.parent = group;
        doc.layers = doc.layers.filter((l) => !from.includes(l));
        doc.layers.splice(at, 0, group);
        doc.activeLayers = [group];
        return group;
      },
      // Scene mode: the canvas grows; layers keep their pixels, moved by the
      // anchor; the Background stays the size it was (the new area shows the
      // white under it).
      async resizeCanvas(w, h, anchor) {
        if (!inModal) throw new Error("resizeCanvas needs a modal scope");
        const dx = anchor === "BOTTOMRIGHT" ? w - doc.width : 0;
        const dy = anchor === "BOTTOMRIGHT" ? h - doc.height : 0;
        for (const l of allLayers(doc)) {
          l.frame = { ...l.frame, left: l.frame.left + dx, top: l.frame.top + dy };
          if (l.mask) l.mask.left += dx, (l.mask.top += dy);
        }
        doc.width = w;
        doc.height = h;
        ps.resized.push({ document_id: doc.id, width: w, height: h, anchor });
      },
      async duplicate(name) {
        if (!inModal) throw new Error("duplicate needs a modal scope");
        const copy = makeDoc({ id: ++nextId, title: name || `${doc.title} copy`, width: doc.width, height: doc.height, pattern: doc.pattern, layers: [] });
        const clone = (l) => {
          const c = makeLayer(copy, { name: l.name, kind: l.kind, visible: l.visible, frame: { ...l.frame }, background: l.isBackgroundLayer, content: l.content, fill: l.fill, raster: l.raster, path: l.path, layers: l.layers ? l.layers.map(clone) : null, mask: l.mask ? { ...l.mask, data: l.mask.data } : null });
          c.xmp = l.xmp;
          return c;
        };
        copy.layers = doc.layers.map(clone);
        copy.activeLayers = [copy.layers[0]];
        copy.selection = doc.selection ? { ...doc.selection } : null;
        app.documents.push(copy);
        app._active = copy.id;
        return copy;
      },
      async closeWithoutSaving() {
        if (!inModal) throw new Error("close needs a modal scope");
        const at = app.documents.indexOf(doc);
        if (at >= 0) app.documents.splice(at, 1);
        ps.closed.push(doc.id);
        if (app._active === doc.id) app._active = app.documents[0] ? app.documents[0].id : null;
      },
      get activeHistoryState() {
        const list = undo.get(doc.id) || [];
        return { name: list.length ? list[list.length - 1].name : "Open" };
      },
      // File > Save As (PSD) into a data-folder file entry: the "file" keeps
      // the title and size; app.open() makes a document from it again.
      saveAs: {
        async psd(file, o, asCopy) {
          if (!inModal) throw new Error("save needs a modal scope");
          if (ps.halted) throw new Error("fake: Photoshop quit");
          files.set(file._path, JSON.stringify({ fake_psd: true, title: file.name, width: doc.width, height: doc.height }));
          if (!asCopy) {
            doc.path = file.url;
            doc.title = file.name;
          }
        }
      }
    };
    const specs = spec.layers || [{ name: "Background", background: !!opts.scene }];
    doc.layers = specs.map((l) => makeLayer(doc, l));
    doc.activeLayers = [doc.layers[0]];
    return doc;
  }

  ps.resized = [];
  ps.closed = [];
  const app = {
    version: "27.11.0",
    documents: (opts.docs || []).map(makeDoc),
    _active: null,
    get activeDocument() {
      return app.documents.find((d) => d.id === app._active) || null;
    },
    set activeDocument(d) {
      app._active = d ? d.id : null;
    },
    // File > Open of a document saved with saveAs.psd: a new id, in front.
    async open(file) {
      if (!inModal) throw new Error("open needs a modal scope");
      const spec = JSON.parse(files.get(file._path));
      const d = makeDoc({ id: ++nextId, title: spec.title, width: spec.width, height: spec.height, path: file.url });
      app.documents.push(d);
      app._active = d.id;
      return d;
    },
    async createDocument(o) {
      if (!inModal) throw new Error("createDocument needs a modal scope");
      const doc = makeDoc({ id: ++nextId, title: o.name || "Untitled", width: o.width, height: o.height });
      doc.profile = o.profile || null;
      app.documents.push(doc);
      app._active = doc.id;
      return doc;
    },
    constants: null
  };
  app._active = opts.active === undefined ? (app.documents[0] ? app.documents[0].id : null) : opts.active;
  ps.app = app;

  function docOf(target) {
    const d = (target || []).find((t) => t._ref === "document");
    return d ? app.documents.find((x) => x.id === d._id) : app.activeDocument;
  }
  function findLayer(doc, id) {
    const stack = [...doc.layers];
    while (stack.length) {
      const l = stack.shift();
      if (l.id === id) return l;
      if (l.layers) stack.push(...l.layers);
    }
    return null;
  }
  const unit = (v) => ({ _unit: "pixelsUnit", _value: v });

  function play(d) {
    ps.played.push(d._obj);
    const doc = docOf(d._target);
    if (d._obj === "select" && d._target[0]._ref === "layer") {
      const layer = findLayer(app.activeDocument, d._target[0]._id);
      if (!layer) throw new Error("fake: no such layer");
      const doc2 = app.activeDocument;
      if (d.selectionModifier) doc2.activeLayers = [...doc2.activeLayers, layer];
      else doc2.activeLayers = [layer];
      return {};
    }
    if (d._obj === "select" && d._target[0]._ref === "historyState") {
      const doc3 = app.activeDocument;
      const list = undo.get(doc3.id) || [];
      const last = list.pop();
      if (!last) throw new Error("fake: no History state to undo");
      restore(doc3, last.snap);
      ps.undone.push({ document_id: doc3.id, name: last.name });
      return {};
    }
    if (d._obj === "get" && d._target[0]._property === "XMPMetadataAsUTF8" && d._target[1]._ref === "document") {
      if (!doc) throw new Error("fake: no such document");
      return doc.xmp ? { XMPMetadataAsUTF8: doc.xmp } : {};
    }
    if (d._obj === "set" && d._target[0]._property === "XMPMetadataAsUTF8" && d._target[1]._ref === "document") {
      if (!inModal) throw new Error("document metadata needs a modal scope");
      if (!doc) throw new Error("fake: no such document");
      doc.xmp = d.to.XMPMetadataAsUTF8;
      ps.docXmpWrites = (ps.docXmpWrites || 0) + 1;
      return {};
    }
    if (d._obj === "get" && d._target[0]._property === "XMPMetadataAsUTF8") {
      const layer = findLayer(doc, d._target[1]._id);
      if (!layer) throw new Error("fake: no such layer");
      ps.xmpReads = (ps.xmpReads || 0) + 1;
      return layer.xmp ? { XMPMetadataAsUTF8: layer.xmp } : {};
    }
    if (d._obj === "make" && d.new && d.new._class === "channel" && d.at && d.at._value === "mask") {
      // Layer > Layer Mask > Hide All on the active layer: everything hidden
      // until pixels are written.
      if (!inModal) throw new Error("a layer mask needs a modal scope");
      const layer = app.activeDocument.activeLayers[0];
      if (!layer) throw new Error("fake: no active layer");
      if (layer.mask) throw new Error("fake: the layer has a mask already");
      layer.mask = maskOf({ width: 0, height: 0, left: 0, top: 0, data: new Uint8Array(0) });
      layer.mask.outside = d.using && d.using._value === "hideAll" ? 0 : 255;
      ps.hideAllMasks = (ps.hideAllMasks || 0) + (layer.mask.outside === 0 ? 1 : 0);
      return {};
    }
    if (d._obj === "get" && d._target[0]._property === "userMaskEnabled") {
      const layer = findLayer(doc, d._target[1]._id);
      if (!layer) throw new Error("fake: no such layer");
      return { userMaskEnabled: !!layer.mask && layer.mask.enabled !== false };
    }
    if (d._obj === "get" && d._target[0]._property === "hasUserMask") {
      const layer = findLayer(doc, d._target[1]._id);
      if (!layer) throw new Error("fake: no such layer");
      return { hasUserMask: !!layer.mask };
    }
    if (d._obj === "set" && d._target[0]._ref === "layer" && d._target[0]._property === "background") {
      if (!inModal) throw new Error("layer from background needs a modal scope");
      const target = app.activeDocument;
      const bg = target.layers.find((l) => l.isBackgroundLayer);
      if (!bg) throw new Error("fake: no Background layer");
      bg.isBackgroundLayer = false;
      bg.name = "Layer 0";
      return {};
    }
    if (d._obj === "set" && d._target[0]._ref === "channel" && d._target[0]._property === "selection" && d.to && Array.isArray(d.to._ref)) {
      // A layer's mask loaded as the selection: its box (pixels inside it
      // are not modeled).
      const target = app.activeDocument;
      const ref = d.to._ref.find((r) => r._ref === "layer");
      const layer = ref ? findLayer(target, ref._id) : null;
      if (!layer || !layer.mask) throw new Error("fake: the layer has no mask");
      const m = layer.mask;
      target.selection = { left: m.left, top: m.top, width: m.width, height: m.height, shape: "rect", from_mask: layer.id };
      return {};
    }
    if (d._obj === "intersectWith" && d._target[0]._property === "selection") {
      // The selection's box cut to a rectangle (pixels are not modeled).
      const target = app.activeDocument;
      const s0 = target.selection;
      if (!s0) return {};
      const v = (k) => d.to[k]._value;
      const left = Math.max(s0.left, v("left"));
      const top = Math.max(s0.top, v("top"));
      const right = Math.min(s0.left + s0.width, v("right"));
      const bottom = Math.min(s0.top + s0.height, v("bottom"));
      target.selection = right > left && bottom > top ? { ...s0, left, top, width: right - left, height: bottom - top, cut_to: [v("left"), v("top"), v("right"), v("bottom")] } : null;
      return {};
    }
    if (d._obj === "set" && d._target[0]._ref === "channel" && d._target[0]._property === "selection" && d.to && d.to._enum === "ordinal") {
      app.activeDocument.selection = null;
      return {};
    }
    if (d._obj === "set" && d._target[0]._ref === "channel" && d._target[0]._property === "selection") {
      const target = app.activeDocument;
      const t = d.to;
      const v = (x) => (typeof x === "number" ? x : x._value);
      target.selection = { left: v(t.left), top: v(t.top), width: v(t.right) - v(t.left), height: v(t.bottom) - v(t.top), shape: t._obj === "ellipse" ? "ellipse" : "rect" };
      return {};
    }
    if (d._obj === "removeBackground") {
      // Remove Background on the active layer: an ellipse mask inside its
      // frame. As on 27.11, a layer much smaller than the canvas comes back
      // with its whole rectangle (opts.noSubject: no mask at all).
      if (!inModal) throw new Error("Remove Background needs a modal scope");
      const target = app.activeDocument;
      const layer = target.activeLayers[0];
      const f = layer && layer.frame;
      if (!f) throw new Error("fake: no layer frame");
      if (opts.noSubject) return {};
      const big = f.width >= target.width * 0.9 || f.height >= target.height * 0.9;
      layer.mask = ellipseMask(f, big ? "ellipse" : "rect");
      ps.subjectCuts = (ps.subjectCuts || []).concat([{ layer_id: layer.id, frame: { ...f }, big }]);
      return {};
    }
    if (d._obj === "transform") {
      // Free Transform about the layer's center; a linked mask follows.
      const target = app.activeDocument;
      const layer = target.activeLayers[0];
      const f = layer && layer.frame;
      if (!f) throw new Error("fake: no layer frame");
      const k = d.width ? d.width._value / 100 : 1;
      const cx = f.left + f.width / 2 + (d.offset ? d.offset.horizontal._value : 0);
      const cy = f.top + f.height / 2 + (d.offset ? d.offset.vertical._value : 0);
      layer.frame = { left: cx - (f.width * k) / 2, top: cy - (f.height * k) / 2, width: f.width * k, height: f.height * k };
      if (layer.mask && layer.mask.shape) layer.mask = ellipseMask(layer.frame, layer.mask.shape);
      return {};
    }
    if (d._obj === "feather") {
      const target = app.activeDocument;
      if (target.selection) target.selection = { ...target.selection, feather: d.radius._value };
      return {};
    }
    if (d._obj === "flattenImage") {
      if (!inModal) throw new Error("flatten needs a modal scope");
      const target = app.activeDocument;
      const data = scene.read(target, null, { left: 0, top: 0, right: target.width, bottom: target.height }, target.width, target.height);
      const bg = makeLayer(target, { name: "Background", background: true, content: "raster", raster: { width: target.width, height: target.height, data } });
      target.layers = [bg];
      target.activeLayers = [bg];
      return {};
    }
    if (d._obj === "get") {
      if (d._target[0]._property === "selection") {
        if (!doc || !doc.selection) return {};
        const s = doc.selection;
        return { selection: { _obj: "rectangle", left: unit(s.left), top: unit(s.top), right: unit(s.left + s.width), bottom: unit(s.top + s.height) } };
      }
      if (d._target[0]._ref === "layer") {
        const layer = findLayer(doc, d._target[0]._id);
        if (!layer) throw new Error("fake: no such layer");
        if (layer.kind !== "smartObject") return { name: layer.name };
        const f = layer.frame;
        return { name: layer.name, smartObjectMore: { transform: [f.left, f.top, f.left + f.width, f.top, f.left + f.width, f.top + f.height, f.left, f.top + f.height] } };
      }
    }
    if (d._obj === "placeEvent") {
      if (!inModal) throw new Error("placeEvent needs a modal scope");
      const target = app.activeDocument;
      // Placing a file drops the selection (seen live on 27.11).
      target.selection = null;
      const path = ps.tokens.get(d.null._path);
      if (!path) throw new Error("fake: unknown session token");
      const bytes = files.get(path);
      if (!(bytes instanceof Uint8Array)) throw new Error(`fake: no binary file ${path}`);
      const info = png.isPng(bytes) ? png.pngInfo(bytes) : jpeg.jpegInfo(bytes);
      let w = info.width;
      let h = info.height;
      const fit = Math.min(1, target.width / w, target.height / h);
      w *= fit;
      h *= fit;
      const layer = makeLayer(target, { name: path.split("/").pop().replace(/\.[a-z]+$/, ""), kind: "smartObject", path, frame: { left: (target.width - w) / 2, top: (target.height - h) / 2, width: w, height: h } });
      const above = target.activeLayers[0];
      const at = above ? Math.max(0, target.layers.indexOf(above)) : 0;
      target.layers.splice(at, 0, layer);
      target.activeLayers = [layer];
      return {};
    }
    if (d._obj === "set" && d._target[0]._property === "XMPMetadataAsUTF8") {
      const layer = findLayer(doc, d._target[1]._id);
      if (!layer) throw new Error("fake: no such layer");
      layer.xmp = d.to.XMPMetadataAsUTF8;
      return {};
    }
    // Tests of the agent commands add the descriptors they play.
    if (opts.extraPlay) {
      const r = opts.extraPlay(d, { app, doc: doc || app.activeDocument, inModal, findLayer, makeLayer, ps });
      if (r !== undefined) return r;
    }
    throw new Error(`fake: unknown descriptor ${d._obj}`);
  }

  function snapshot(doc) {
    const copyLayer = (l) => Object.assign(Object.create(Object.getPrototypeOf(l)), l, { frame: { ...l.frame }, layers: l.layers ? l.layers.map(copyLayer) : null });
    const every = allLayers(doc);
    return {
      layers: doc.layers.slice(),
      state: doc.layers.map((l) => ({ l, name: l.name, visible: l.visible, xmp: l.xmp, frame: { ...l.frame } })),
      deep: every.map((l) => ({ l, props: { name: l.name, visible: l.visible, xmp: l.xmp, frame: { ...l.frame }, mask: l.mask, isBackgroundLayer: l.isBackgroundLayer, layers: l.layers ? l.layers.slice() : null } })),
      width: doc.width,
      height: doc.height,
      active: doc.activeLayers.slice(),
      copyLayer
    };
  }

  function restore(doc, snap) {
    doc.layers = snap.layers;
    for (const st of snap.deep) Object.assign(st.l, st.props);
    doc.width = snap.width;
    doc.height = snap.height;
    doc.activeLayers = snap.active;
  }

  // Scene mode reads: the composite (RGB), or one layer (RGBA) whose
  // returned bounds are the requested ones cut to the layer's frame, as
  // Photoshop returns them.
  function sceneRead(doc, layer, o) {
    let b = o.sourceBounds || (layer ? layer.bounds : { left: 0, top: 0, right: doc.width, bottom: doc.height });
    b = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    if (layer && layer.kind !== "group") {
      const f = layer.frame;
      b = { left: Math.max(b.left, Math.floor(f.left)), top: Math.max(b.top, Math.floor(f.top)), right: Math.min(b.right, Math.ceil(f.left + f.width)), bottom: Math.min(b.bottom, Math.ceil(f.top + f.height)) };
      if (b.right <= b.left || b.bottom <= b.top) throw new Error("fake: the layer has no pixels there");
    }
    let w = b.right - b.left;
    let h = b.bottom - b.top;
    if (o.targetSize) {
      const req = o.sourceBounds ? o.sourceBounds : b;
      const k = o.targetSize.width ? o.targetSize.width / (req.right - req.left) : o.targetSize.height / (req.bottom - req.top);
      if (k < 1) {
        w = Math.max(1, Math.round(w * k));
        h = Math.max(1, Math.round(h * k));
      }
    }
    const comps = layer ? 4 : 3;
    ps.reads.push({ document_id: doc.id, layer_id: o.layerID || null, width: w, height: h, profile: o.colorProfile });
    const out = levelBounds(b, o.targetSize ? w / (b.right - b.left) : 1);
    return { imageData: imageData(w, h, comps, scene.read(doc, layer, b, w, h)), sourceBounds: out.bounds, level: out.level };
  }

  // With targetSize, Photoshop reads from a pyramid level and returns
  // sourceBounds in that level's pixels: level floor(log2(1 / scale)), the
  // bounds divided by 2^level (verified live on 27.11: a 272 px box read at
  // 100 px came back as level 1 with halved bounds; at 200 px, level 0).
  function levelBounds(b, scale) {
    const level = scale < 1 ? Math.max(0, Math.floor(Math.log2(1 / scale) + 1e-9)) : 0;
    const d = 2 ** level;
    return { level, bounds: { left: Math.floor(b.left / d), top: Math.floor(b.top / d), right: Math.ceil(b.right / d), bottom: Math.ceil(b.bottom / d) } };
  }

  // Photoshop's image data: after dispose(), its width, height and
  // components read as an error object, not numbers (verified live on 27.11).
  function imageData(width, height, components, data) {
    const gone = { code: "5", number: 5 };
    return {
      get width() {
        return this.disposed ? gone : width;
      },
      get height() {
        return this.disposed ? gone : height;
      },
      get components() {
        return this.disposed ? gone : components;
      },
      disposed: false,
      async getData() {
        if (this.disposed) throw new Error("fake: image data used after dispose");
        return data;
      },
      dispose() {
        this.disposed = true;
      },
      _data: data
    };
  }

  const photoshop = {
    app,
    constants: { NewDocumentMode: { RGB: "RGBColorMode" }, DocumentFill: { WHITE: "white" }, AnchorPosition: opts.scene ? { TOPLEFT: "TOPLEFT", BOTTOMRIGHT: "BOTTOMRIGHT" } : undefined, ElementPlacement: { PLACEAFTER: "placeAfter", PLACEBEFORE: "placeBefore" } },
    core: {
      async executeAsModal(fn, options) {
        ps.modals.push(options.commandName);
        // Tests of the agent tools: the person switches documents while a
        // call waits for the modal scope.
        if (typeof ps.beforeModal === "function") ps.beforeModal(options.commandName);
        if (inModal || ps.busy > 0) {
          if (ps.busy > 0) ps.busy--;
          throw new Error("host is in a modal state");
        }
        inModal = true;
        const suspended = new Map();
        let sid = 0;
        const hostControl = {
          async suspendHistory(o) {
            const doc = app.documents.find((d) => d.id === o.documentID);
            suspended.set(++sid, { doc, name: o.name, snap: snapshot(doc) });
            return sid;
          },
          async resumeHistory(id, commit) {
            const s = suspended.get(id);
            suspended.delete(id);
            if (commit) {
              ps.history.push({ document_id: s.doc.id, name: s.name });
              if (!undo.has(s.doc.id)) undo.set(s.doc.id, []);
              undo.get(s.doc.id).push({ name: s.name, snap: s.snap });
            } else {
              restore(s.doc, s.snap);
              ps.rolledBack.push({ document_id: s.doc.id, name: s.name });
            }
          }
        };
        try {
          return await fn({ hostControl });
        } finally {
          inModal = false;
        }
      }
    },
    action: {
      async batchPlay(descs) {
        return descs.map(play);
      },
      addNotificationListener(events, fn) {
        ps.notifications.push({ events, fn });
      }
    },
    imaging: {
      async getPixels(o) {
        if (!inModal) throw new Error("imaging needs a modal scope");
        const doc = app.documents.find((d) => d.id === o.documentID);
        const layer = o.layerID ? findLayer(doc, o.layerID) : null;
        if (scene) return sceneRead(doc, layer, o);
        const b = o.sourceBounds || (layer ? layer.bounds : { left: 0, top: 0, right: doc.width, bottom: doc.height });
        let w = b.right - b.left;
        let h = b.bottom - b.top;
        if (o.targetSize) {
          const k = o.targetSize.width ? o.targetSize.width / w : o.targetSize.height / h;
          if (k < 1) {
            w = Math.max(1, Math.round(w * k));
            h = Math.max(1, Math.round(h * k));
          }
        }
        const comps = layer && layer.alpha ? 4 : 3;
        ps.reads.push({ document_id: doc.id, layer_id: o.layerID || null, width: w, height: h, profile: o.colorProfile });
        const lb = levelBounds(b, o.targetSize ? w / (b.right - b.left) : 1);
        return { imageData: imageData(w, h, comps, fill(w, h, comps, doc.pattern, w * 31 + h)), sourceBounds: lb.bounds, level: lb.level };
      },
      // A layer's mask over an area: its pixels inside the mask's box, its
      // default outside (Hide All 0, Reveal All 255); a layer without a
      // mask gives no imageData (verified live on 27.11).
      async getLayerMask(o) {
        if (!inModal) throw new Error("imaging needs a modal scope");
        const doc = app.documents.find((d) => d.id === o.documentID);
        const layer = findLayer(doc, o.layerID);
        if (!layer) throw new Error("fake: no such layer");
        ps.maskReads = (ps.maskReads || 0) + 1;
        if (!layer.mask) return { imageData: undefined };
        const m = layer.mask;
        const b = o.sourceBounds || { left: 0, top: 0, right: doc.width, bottom: doc.height };
        const bw = b.right - b.left, bh = b.bottom - b.top;
        const t = o.targetSize || {};
        const w = t.width || (t.height ? Math.round((bw * t.height) / bh) : bw);
        const h = t.height || (t.width ? Math.round((bh * t.width) / bw) : bh);
        const outside = m.outside === undefined ? 0 : m.outside;
        const data = new Uint8Array(w * h);
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
          const mx = Math.floor(b.left + ((i + 0.5) * bw) / w) - Math.round(m.left);
          const my = Math.floor(b.top + ((j + 0.5) * bh) / h) - Math.round(m.top);
          data[j * w + i] = mx >= 0 && my >= 0 && mx < m.width && my < m.height ? (m.data ? m.data[my * m.width + mx] : 255) : outside;
        }
        return { imageData: imageData(w, h, 1, data), sourceBounds: { ...b } };
      },
      async getSelection(o) {
        if (!inModal) throw new Error("imaging needs a modal scope");
        const doc = app.documents.find((d) => d.id === o.documentID);
        if (!doc.selection) return { imageData: null };
        if (scene) {
          const m = selectionMask(doc.selection, doc);
          return { imageData: imageData(m.width, m.height, 1, m.data), sourceBounds: { left: m.left, top: m.top, right: m.left + m.width, bottom: m.top + m.height } };
        }
        const s = doc.selection;
        return { imageData: imageData(s.width, s.height, 1, new Uint8Array(s.width * s.height).fill(255)), sourceBounds: { left: s.left, top: s.top, right: s.left + s.width, bottom: s.top + s.height } };
      },
      async createImageDataFromBuffer(data, o) {
        return imageData(o.width, o.height, o.components, data);
      },
      async encodeImageData(o) {
        const bytes = fakeJpeg(o.imageData.width, o.imageData.height, ps.jpegBytesPerPixel);
        return o.base64 ? bytes.toString("base64") : bytes;
      },
      async putLayerMask(o) {
        if (!inModal) throw new Error("imaging needs a modal scope");
        const doc = app.documents.find((d) => d.id === o.documentID);
        const layer = findLayer(doc, o.layerID);
        // Photoshop reveals what lies outside the written box, unless the
        // mask was made Hide All first.
        const outside = layer.mask && layer.mask.outside === 0 ? 0 : 255;
        layer.mask = maskOf({ width: o.imageData.width, height: o.imageData.height, left: o.targetBounds.left, top: o.targetBounds.top, data: opts.maskBroken ? null : Uint8Array.from(o.imageData._data) });
        layer.mask.outside = outside;
      }
    }
  };

  function entry(path) {
    return { name: path.split("/").pop(), url: DATA + path, _path: path, isFile: true };
  }

  function isDir(path) {
    if (dirs.has(path)) return true;
    for (const k of files.keys()) if (k.startsWith(`${path}/`)) return true;
    return false;
  }

  // A data-folder subfolder, as UXP's Folder entry.
  function folder(path) {
    return {
      name: path.split("/").pop(),
      url: DATA + path,
      _path: path,
      isFile: false,
      isFolder: true,
      async createFile(n) {
        return entry(`${path}/${n}`);
      }
    };
  }

  const uxp = {
    host: { version: "27.11.0", name: "Photoshop" },
    entrypoints: { setup: (def) => (ps.entrypoints = def) },
    shell: {
      openExternal: async (url) => {
        ps.opened.push(url);
        return "";
      }
    },
    storage: {
      secureStorage: {
        getItem: async (k) => (secure.has(k) ? enc.encode(secure.get(k)) : null),
        setItem: async (k, v) => secure.set(k, String(v)),
        removeItem: async (k) => secure.delete(k)
      },
      formats: { binary: { binary: true }, utf8: { utf8: true } },
      localFileSystem: {
        async getEntryWithUrl(url) {
          const path = name(url).replace(/\/$/, "");
          if (!files.has(path) && isDir(path)) return folder(path);
          if (!files.has(path)) throw new Error(`fake: no entry ${url}`);
          return entry(path);
        },
        async getDataFolder() {
          return {
            async getEntry(path) {
              if (!files.has(path) && isDir(path)) return folder(path);
              if (!files.has(path)) throw new Error(`fake: no entry ${path}`);
              return entry(path);
            }
          };
        },
        createSessionToken(e) {
          const token = `token-${ps.tokens.size + 1}`;
          ps.tokens.set(token, e._path);
          return token;
        },
        async getFileForOpening() {
          ps.dialogs++;
          const f = ps.chosenFile;
          if (!f) return null;
          return { name: f.name, async read() {
            const b = Uint8Array.from(f.bytes);
            return b.buffer;
          } };
        }
      }
    }
  };

  const fs = {
    async readFile(path, o) {
      const n = name(path);
      if (!files.has(n)) throw new Error(`ENOENT ${path}`);
      const v = files.get(n);
      if (o && o.encoding) return typeof v === "string" ? v : Buffer.from(v).toString("utf8");
      return typeof v === "string" ? enc.encode(v).buffer : Uint8Array.from(v).buffer;
    },
    async writeFile(path, data, o) {
      const n = name(path);
      if (opts.failWrite && opts.failWrite(n)) throw new Error("fake: disk full");
      if (typeof data === "string") files.set(n, data);
      else files.set(n, new Uint8Array(data instanceof ArrayBuffer ? data.slice(0) : data));
      return o;
    },
    async unlink(path) {
      if (!files.delete(name(path))) throw new Error(`ENOENT ${path}`);
    },
    async rename(from, to) {
      if (opts.noRename) throw new Error("fake: rename is not available");
      const a = name(from);
      const b = name(to);
      if (!files.has(a)) throw new Error(`ENOENT ${from}`);
      if (opts.renameRefusesExisting && files.has(b)) throw new Error("EEXIST");
      files.set(b, files.get(a));
      files.delete(a);
    },
    async mkdir(path) {
      const n = name(path);
      if (dirs.has(n)) throw new Error("EEXIST");
      dirs.add(n);
    },
    // opts.symlinks: data-folder paths that are symbolic links.
    async lstat(path) {
      const n = name(path);
      if (!files.has(n) && !dirs.has(n)) throw new Error(`ENOENT ${path}`);
      return { isSymbolicLink: () => !!(opts.symlinks && opts.symlinks.has(n)), isFile: () => files.has(n) };
    },
    async readdir(path) {
      const n = name(path).replace(/\/$/, "");
      const out = new Set();
      for (const k of files.keys()) if (k.startsWith(`${n}/`)) out.add(k.slice(n.length + 1).split("/")[0]);
      for (const k of dirs) if (k.startsWith(`${n}/`)) out.add(k.slice(n.length + 1).split("/")[0]);
      return [...out];
    }
  };

  // ps.halt(): Photoshop quit. Every file, storage and Photoshop call of
  // this instance fails from then on, so work still pending in it (a held
  // test hook) writes nothing; a restart boots a new instance on the same
  // `files` and `secure` maps.
  ps.halted = false;
  ps.halt = () => {
    ps.halted = true;
  };
  const halting = (obj, name) => {
    const f = obj[name];
    obj[name] = function (...a) {
      if (ps.halted) return Promise.reject(new Error("fake: Photoshop quit"));
      return f.apply(this, a);
    };
  };
  for (const k of Object.keys(fs)) halting(fs, k);
  for (const k of ["getItem", "setItem", "removeItem"]) halting(uxp.storage.secureStorage, k);
  halting(photoshop.core, "executeAsModal");
  halting(photoshop.action, "batchPlay");

  const os = { platform: () => "darwin", release: () => "25.5.0" };
  const modules = { uxp, photoshop, fs, os };

  // Photoshop's own events, as addNotificationListener delivers them.
  ps.fire = (event = "select") => {
    for (const n of ps.notifications) if (n.events.some((e) => e.event === event)) n.fn(event, {});
  };
  ps.require = (n) => {
    if (Object.prototype.hasOwnProperty.call(modules, n)) return modules[n];
    throw new Error(`Cannot find module '${n}'`);
  };
  ps.modules = modules;
  ps.doc = (id) => app.documents.find((d) => d.id === id);
  ps.setActive = (id) => {
    app._active = id;
  };
  // The person opens a document (File > Open): it gets a new id and comes
  // to the front.
  ps.openDocument = (spec) => {
    const d = makeDoc({ ...spec, id: spec.id || ++nextId });
    app.documents.push(d);
    app._active = d.id;
    return d;
  };
  ps.closeAll = () => {
    app.documents.splice(0);
    app._active = null;
  };
  ps.binary = (path) => files.get(path);
  ps.undone = [];
  // Scene mode: the composite of a document over `box` at w x h (RGB).
  ps.composite = (id, box, w, h) => {
    const doc = app.documents.find((d) => d.id === id);
    return { width: w, height: h, components: 3, data: scene.read(doc, null, { left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height }, w, h) };
  };
  ps.layers = (id) => allLayers(app.documents.find((d) => d.id === id));
  return ps;
}

module.exports = { createFakePhotoshop, fakeJpeg, fill };
