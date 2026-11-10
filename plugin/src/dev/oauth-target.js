"use strict";
// DEVELOPMENT BUILDS ONLY. Release bundles replace this module with a stub
// (plugin/scripts/build.js), and a test checks that they do.
//
// Points a development build at a development identity provider and API, so
// Sign in with Scenario can be tried without the production application: the
// file "dev-oauth-target.json" in the plugin's data folder holds
//   { "issuer", "client_id", "api_base", "download_origins" (optional) }
// with https URLs only. It holds no secret and stays in place. The package's
// manifest must allow those hosts: `DEV_OAUTH_TARGET=<file> pnpm run
// package:dev` adds the file's origins to the development package only
// (plugin/scripts/package.js). The log names no host.

var FILE = "dev-oauth-target.json";

function httpsOrigin(url) {
  var m = /^(https:\/\/[^\/?#\s]+)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : null;
}

// The target, or null when the text is not a complete one.
function parse(text) {
  var d;
  try {
    d = JSON.parse(String(text));
  } catch (e) {
    return null;
  }
  if (!d || typeof d !== "object") return null;
  if (!httpsOrigin(d.issuer) || !httpsOrigin(d.api_base) || typeof d.client_id !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(d.client_id)) return null;
  var downloads = Array.isArray(d.download_origins) ? d.download_origins.map(httpsOrigin).filter(Boolean) : [];
  return {
    issuer: String(d.issuer).replace(/\/+$/, ""),
    client_id: d.client_id,
    scope: typeof d.scope === "string" && d.scope ? d.scope : undefined,
    api_base: String(d.api_base).replace(/\/+$/, ""),
    download_origins: downloads
  };
}

// The origins a development package's manifest must allow for a target.
function origins(target) {
  var out = [httpsOrigin(target.issuer), httpsOrigin(target.api_base)].concat(target.download_origins || []);
  return out.filter(function (v, i) {
    return v && out.indexOf(v) === i;
  });
}

async function read(host, log) {
  var text = await host.readDataText(FILE);
  if (text === null || text === undefined) return null;
  var target = parse(text);
  log(target ? "dev build: development sign-in target in use" : "dev build: " + FILE + " ignored (InvalidParameter)");
  return target;
}

module.exports = { read: read, parse: parse, origins: origins, FILE: FILE };
