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

// opts: { docs: [{id, title, width, height, pattern, layers: [{name, alpha}],
//         selection: {left, top, width, height}}], active (doc id),
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
    reads: []
  };
  let nextId = 1000;
  let inModal = false;

  function makeLayer(doc, spec) {
    const layer = {
      id: ++nextId,
      name: spec.name || "Layer",
      kind: spec.kind || "pixel",
      visible: spec.visible !== false,
      alpha: !!spec.alpha,
      frame: spec.frame || { left: 0, top: 0, width: doc.width, height: doc.height },
      xmp: null,
      mask: null,
      path: spec.path || null,
      layers: spec.layers || null,
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
    return layer;
  }

  function makeDoc(spec) {
    const doc = {
      id: spec.id,
      title: spec.title || `Untitled-${spec.id}`,
      width: spec.width || 1024,
      height: spec.height || 1024,
      pattern: spec.pattern || "gradient",
      selection: spec.selection || null,
      layers: [],
      activeLayers: [],
      async createLayerGroup(o) {
        if (!inModal) throw new Error("createLayerGroup needs a modal scope");
        const from = o.fromLayers || [];
        const at = Math.min(...from.map((l) => doc.layers.indexOf(l)));
        const group = makeLayer(doc, { name: o.name || "Group", kind: "group", layers: from.slice() });
        doc.layers = doc.layers.filter((l) => !from.includes(l));
        doc.layers.splice(at, 0, group);
        doc.activeLayers = [group];
        return group;
      }
    };
    const specs = spec.layers || [{ name: "Background" }];
    doc.layers = specs.map((l) => makeLayer(doc, l));
    doc.activeLayers = [doc.layers[0]];
    return doc;
  }

  const app = {
    version: "27.11.0",
    documents: (opts.docs || []).map(makeDoc),
    _active: null,
    get activeDocument() {
      return app.documents.find((d) => d.id === app._active) || null;
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
    if (d._obj === "select") {
      const layer = findLayer(app.activeDocument, d._target[0]._id);
      if (!layer) throw new Error("fake: no such layer");
      const doc2 = app.activeDocument;
      if (d.selectionModifier) doc2.activeLayers = [...doc2.activeLayers, layer];
      else doc2.activeLayers = [layer];
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
    throw new Error(`fake: unknown descriptor ${d._obj}`);
  }

  function snapshot(doc) {
    const copyLayer = (l) => Object.assign(Object.create(Object.getPrototypeOf(l)), l, { frame: { ...l.frame }, layers: l.layers ? l.layers.map(copyLayer) : null });
    return { layers: doc.layers.slice(), state: doc.layers.map((l) => ({ l, name: l.name, visible: l.visible, xmp: l.xmp, frame: { ...l.frame } })), active: doc.activeLayers.slice(), copyLayer };
  }

  function imageData(width, height, components, data) {
    return {
      width,
      height,
      components,
      disposed: false,
      async getData() {
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
    constants: { NewDocumentMode: { RGB: "RGBColorMode" }, DocumentFill: { WHITE: "white" } },
    core: {
      async executeAsModal(fn, options) {
        ps.modals.push(options.commandName);
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
            if (commit) ps.history.push({ document_id: s.doc.id, name: s.name });
            else {
              s.doc.layers = s.snap.layers;
              for (const st of s.snap.state) Object.assign(st.l, { name: st.name, visible: st.visible, xmp: st.xmp, frame: st.frame });
              s.doc.activeLayers = s.snap.active;
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
        return { imageData: imageData(w, h, comps, fill(w, h, comps, doc.pattern, w * 31 + h)), sourceBounds: b };
      },
      async getSelection(o) {
        if (!inModal) throw new Error("imaging needs a modal scope");
        const doc = app.documents.find((d) => d.id === o.documentID);
        if (!doc.selection) return { imageData: null };
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
        layer.mask = { width: o.imageData.width, height: o.imageData.height, left: o.targetBounds.left, top: o.targetBounds.top };
      }
    }
  };

  function entry(path) {
    return { name: path.split("/").pop(), url: DATA + path, _path: path, isFile: true };
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
          const path = name(url);
          if (!files.has(path)) throw new Error(`fake: no entry ${url}`);
          return entry(path);
        },
        async getDataFolder() {
          return {
            async getEntry(path) {
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
    async readdir(path) {
      const n = name(path).replace(/\/$/, "");
      const out = new Set();
      for (const k of files.keys()) if (k.startsWith(`${n}/`)) out.add(k.slice(n.length + 1).split("/")[0]);
      for (const k of dirs) if (k.startsWith(`${n}/`)) out.add(k.slice(n.length + 1).split("/")[0]);
      return [...out];
    }
  };

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
  ps.closeAll = () => {
    app.documents.splice(0);
    app._active = null;
  };
  ps.binary = (path) => files.get(path);
  return ps;
}

module.exports = { createFakePhotoshop, fakeJpeg, fill };
