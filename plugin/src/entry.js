"use strict";
// Bundle entry inside UXP. Host module names ("uxp", "photoshop", "os", "fs")
// are not part of the bundle, so the bundle's require hands them to UXP's own.
var g = typeof globalThis !== "undefined" ? globalThis : window;
require("./main.js").boot({
  hostRequire: function (name) {
    return require(name);
  },
  global: g,
  document: typeof document !== "undefined" ? document : null,
  console: typeof console !== "undefined" ? console : null
});
