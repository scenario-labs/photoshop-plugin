"use strict";
// Everything the plugin reads from UXP and Photoshop goes through this adapter,
// so the rest of the code runs under Node with a fake host in the tests.
// Every call is wrapped: a missing API returns null instead of throwing.

var utf8 = require("./util/utf8.js");

function toBytes(v) {
  if (v && v.buffer && typeof v.byteLength === "number") return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
  return new Uint8Array(v);
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
  var DATA = "plugin-data:/";

  return {
    WebSocket: g.WebSocket,
    crypto: g.crypto,
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
