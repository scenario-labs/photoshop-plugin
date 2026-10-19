"use strict";
// The pairing token: 32 random bytes made in the plugin, kept in UXP
// secureStorage as 43 base64url characters. It never travels over a socket;
// the person copies it into an agent client's config. Reset makes a new one,
// which disconnects every helper that holds the old one.

var P = require("../../../shared/protocol.json");
var b64 = require("../util/base64url.js");
var protocol = require("./protocol.js");

// host: { secureGet(key) -> Promise<string|null>, secureSet(key, value) -> Promise }
// random: { bytes(n) -> Uint8Array }
function createPairing(host, random) {
  var current = null;
  var key = P.token.secure_storage_key;

  function make() {
    return b64.encode(random.bytes(P.token.bytes));
  }

  async function loadOrCreate() {
    var stored = null;
    try {
      stored = await host.secureGet(key);
    } catch (e) {
      stored = null;
    }
    if (protocol.parseToken(stored)) {
      current = stored.trim();
      return { token: current, created: false };
    }
    var fresh = make();
    await host.secureSet(key, fresh);
    current = fresh;
    return { token: current, created: true };
  }

  async function reset() {
    var fresh = make();
    await host.secureSet(key, fresh);
    current = fresh;
    return current;
  }

  // Used by development builds only, to pair without the panel (see AGENTS.md).
  async function adopt(text) {
    if (!protocol.parseToken(text)) throw new Error("not a valid pairing token");
    await host.secureSet(key, text.trim());
    current = text.trim();
    return current;
  }

  return {
    loadOrCreate: loadOrCreate,
    reset: reset,
    adopt: adopt,
    current: function () {
      return current;
    },
    // What the panel shows next to the masked token: the last 4 characters.
    hint: function () {
      return current ? current.slice(-4) : null;
    }
  };
}

module.exports = { createPairing: createPairing };
