"use strict";
// DEVELOPMENT BUILDS ONLY. Release bundles replace this module with an empty
// stub (plugin/scripts/build.js), and a test checks that they do.
//
// Signs a development build in without pasting the key into the panel: if
// the file "dev-api-key" exists in the plugin's data folder, its lines
// SCENARIO_API_KEY=... and SCENARIO_API_SECRET=... go through the panel's own
// Save and test path, so the pair reaches secure storage only if Scenario
// accepts it. The file is removed in every case. The log says only that the
// key was imported, or the error type; never the values. Anyone who can write
// that folder already runs as the same user.

var FILE = "dev-api-key";
var NAMES = { SCENARIO_API_KEY: "key", SCENARIO_API_SECRET: "secret" };

// KEY=value lines; an optional "export " and matching quotes are accepted,
// other lines are ignored.
function parse(text) {
  var out = { key: "", secret: "" };
  String(text)
    .split(/\r?\n/)
    .forEach(function (line) {
      var m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || !Object.prototype.hasOwnProperty.call(NAMES, m[1])) return;
      var v = m[2];
      if (v.length >= 2 && (v.charAt(0) === '"' || v.charAt(0) === "'") && v.charAt(v.length - 1) === v.charAt(0)) v = v.slice(1, -1);
      out[NAMES[m[1]]] = v;
    });
  return out;
}

async function importKey(host, auth, log) {
  var text = await host.readDataText(FILE);
  if (text === null || text === undefined) return false;
  try {
    var pair = parse(text);
    if (!pair.key || !pair.secret) {
      log("dev build: dev-api-key ignored (InvalidParameter)");
      return false;
    }
    var out = await auth.saveAndTest(pair.key, pair.secret, {});
    if (out && out.ok) {
      log("dev build: API key imported");
      return true;
    }
    log("dev build: API key not imported (" + ((out && out.type) || "Internal") + ")");
    return false;
  } catch (e) {
    log("dev build: API key not imported (" + ((e && e.type) || "Internal") + ")");
    return false;
  } finally {
    await host.removeData(FILE);
  }
}

module.exports = { importKey: importKey, FILE: FILE, parse: parse };
