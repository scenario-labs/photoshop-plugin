"use strict";
// DEVELOPMENT BUILDS ONLY. Release bundles replace this module with an empty
// stub (plugin/scripts/build.js), and a test checks that they do.
//
// Lets a test harness pair with the plugin without opening the panel: if the
// file "dev-pairing-token" exists in the plugin's data folder, its content is
// adopted as the pairing token and the file is removed. Anyone who can write
// that folder already runs as the same user, which the pairing token does not
// protect against (SPEC 2.6, threat model).

var FILE = "dev-pairing-token";

async function importToken(host, pairing, log) {
  var text = await host.readDataText(FILE);
  if (text === null || text === undefined || text.trim() === "") return false;
  try {
    await pairing.adopt(text);
    log("dev build: pairing token imported from the data folder");
    return true;
  } catch (e) {
    log("dev build: dev-pairing-token ignored (" + e.message + ")");
    return false;
  } finally {
    await host.removeData(FILE);
  }
}

module.exports = { importToken: importToken, FILE: FILE };
