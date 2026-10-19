"use strict";
// Startup code. Photoshop loads the plugin at launch (manifest loadEvent
// "startup"), so the agent link runs even when the panel was never opened.
// boot() wires the modules together; src/entry.js calls it inside UXP, and
// the tests call it under Node with a fake host.

var manifest = require("../manifest.json");
var catalog = require("../../shared/catalog.json");
var flags = require("./build-flags.js");
var hostMod = require("./host.js");
var canonical = require("./util/canonical-json.js");
var randomMod = require("./util/random.js");
var pairingMod = require("./bridge/pairing.js");
var linkMod = require("./bridge/link.js");
var statusMod = require("./bridge/status.js");
var panelMod = require("./ui/panel.js");
var devImport = require("./dev/import-token.js");

var VERSION = manifest.version;
var LOG_FILE = "scenario-link.log";
// SPEC 4.3: the copied token is cleared from the clipboard after 60 s if it is still there.
var CLIPBOARD_CLEAR_MS = 60000;
// SPEC 4.3: logs redact any token-like string of 32 characters or more.
var TOKEN_LIKE = /[A-Za-z0-9_-]{32,}/g;

function catalogHash() {
  return canonical.hash({ catalog_version: catalog.catalog_version, tools: catalog.tools });
}

// A short local log in the plugin's data folder (the last 200 lines). It never
// holds the token, prompts or document titles: only link phases and startup
// facts, and anything token-like is redacted on the way in.
function createLogger(host, consoleRef) {
  var lines = [];
  var writeTimer = null;
  function flush() {
    writeTimer = null;
    host.writeDataText(LOG_FILE, lines.join("\n") + "\n");
  }
  return {
    log: function (text) {
      text = String(text).replace(TOKEN_LIKE, "[redacted]");
      var line = new Date().toISOString() + " " + text;
      lines.push(line);
      if (lines.length > 200) lines.splice(0, lines.length - 200);
      if (consoleRef && typeof consoleRef.log === "function") consoleRef.log("[Scenario] " + text);
      if (!writeTimer) writeTimer = host.timers.setTimeout(flush, 300);
    },
    lines: function () {
      return lines.slice();
    }
  };
}

// env: { hostRequire, global, document, console; tests also pass host and clipboardClearMs }
function boot(env) {
  var host = env.host || hostMod.createHost(env.hostRequire, env.global);
  var logger = createLogger(host, env.console);
  var settings = statusMod.createSettings();
  var panel = null;
  var link = null;

  // UXP wants entrypoints declared during the first synchronous run.
  host.setupEntrypoints({
    panels: {
      scenarioPanel: {
        show: function () {
          if (panel) panel.refresh();
        }
      }
    }
  });

  var random = null;
  try {
    random = randomMod.createRandom({ crypto: host.crypto });
  } catch (e) {
    random = null;
  }
  logger.log("plugin " + VERSION + " (" + flags.BUILD + ") starting; random source: " + (random ? random.source : "none"));
  var pairing = random ? pairingMod.createPairing(host, random) : null;

  var ready = (async function () {
    if (pairing && flags.DEV) {
      try {
        await devImport.importToken(host, pairing, logger.log);
      } catch (e) {
        logger.log("dev token import failed: " + e.message);
      }
    }
    if (pairing) {
      try {
        var made = await pairing.loadOrCreate();
        logger.log(made.created ? "pairing token created" : "pairing token loaded");
      } catch (e) {
        logger.log("pairing token unavailable: " + e.message);
      }
    }

    link = linkMod.createLink({
      WebSocket: host.WebSocket,
      getToken: function () {
        return pairing ? pairing.current() : null;
      },
      random: random,
      info: function () {
        return { plugin_version: VERSION, photoshop_version: host.photoshopVersion(), os: host.osName() };
      },
      catalogHash: catalogHash(),
      switches: settings.switches,
      handlers: { scenario_status: statusMod.createStatusHandler(host, settings, VERSION) },
      timers: host.timers,
      log: logger.log,
      onState: function (s) {
        if (panel) panel.renderLink(s);
      },
      onSessionsEnded: function (ids, why) {
        if (settings.endSessions(ids)) logger.log("agent allowance ended (" + why + ")");
      }
    });

    var panelActions = {
      token: function () {
        return pairing ? pairing.current() : null;
      },
      copyToken: function () {
        var t = pairing && pairing.current();
        if (!t) throw new Error("no pairing token");
        return Promise.resolve(host.clipboardWrite(t)).then(function () {
          host.timers.setTimeout(function () {
            Promise.resolve(host.clipboardClearIf(t)).then(
              function (cleared) {
                if (cleared) logger.log("clipboard cleared (it still held the pairing token)");
              },
              function () {}
            );
          }, env.clipboardClearMs || CLIPBOARD_CLEAR_MS);
        });
      },
      resetToken: async function () {
        if (!pairing) throw new Error("no secure random source");
        await pairing.reset();
        logger.log("pairing token reset");
        link.restart("Pairing token reset. Agent clients need the new token.");
      }
    };
    panel = panelMod.createPanel(env.document, panelActions, VERSION);

    link.start();
    return {
      host: host,
      link: link,
      pairing: pairing,
      panel: panel,
      settings: settings,
      random: random,
      logger: logger,
      copyToken: panelActions.copyToken,
      resetToken: panelActions.resetToken
    };
  })();

  return ready;
}

module.exports = { boot: boot, catalogHash: catalogHash, VERSION: VERSION };
