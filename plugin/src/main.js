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
var accountPanelMod = require("./ui/account-panel.js");
var devImport = require("./dev/import-token.js");
var devKeyImport = require("./dev/import-key.js");
var redactMod = require("./util/redact.js");
var accountsMod = require("./auth/accounts.js");
var authMod = require("./auth/auth.js");
var clientMod = require("./scenario/client.js");
var diagnosticsMod = require("./diagnostics.js");
var catalogMod = require("./catalog/catalog.js");
var assetsMod = require("./scenario/assets.js");
var quotesMod = require("./forms/quotes.js");
var catalogToolsMod = require("./bridge/catalog-tools.js");
var lanesMod = require("./ui/lanes.js");
var pickerMod = require("./ui/picker.js");
var ledgerMod = require("./jobs/ledger.js");
var runnerMod = require("./jobs/runner.js");
var downloadMod = require("./scenario/download.js");
var referencesMod = require("./capture/references.js");
var jobsViewMod = require("./ui/jobs-view.js");
var API = require("../../shared/scenario-api.json");

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
// holds the token, keys, secrets, prompts, document titles or project names:
// only link phases, sign-in steps and startup facts. The exact key, secret
// and token values, and anything token-like, are redacted on the way in.
function createLogger(host, consoleRef, redactor) {
  var lines = [];
  var writeTimer = null;
  function flush() {
    writeTimer = null;
    host.writeDataText(LOG_FILE, lines.join("\n") + "\n");
  }
  return {
    log: function (text) {
      text = String(text);
      if (redactor) text = redactor.apply(text);
      text = text.replace(TOKEN_LIKE, "[redacted]");
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

// This Photoshop start's marker: jobs carry it, so a result lands by itself
// only in the session that started it (SPEC 6.4).
function sessionMarker(random, now) {
  if (random) {
    var b = random.bytes(8);
    var h = "";
    for (var i = 0; i < b.length; i++) h += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return h;
  }
  return "t" + now().toString(16);
}

// env: { hostRequire, global, document, console; tests also pass host,
// clipboardClearMs, apiBaseUrl (a mock Scenario API), downloadOrigins (the
// mock CDN) and pollDelay }
function boot(env) {
  var host = env.host || hostMod.createHost(env.hostRequire, env.global);
  var redactor = redactMod.createRedactor();
  var logger = createLogger(host, env.console, redactor);
  var settings = statusMod.createSettings();
  var errors = diagnosticsMod.createErrorLog();
  var accounts = accountsMod.createAccounts(host, redactor);
  var client = clientMod.createClient({
    fetch: host.fetch,
    AbortController: host.AbortController,
    timers: host.timers,
    credentials: accounts.credentials,
    redactor: redactor,
    baseUrl: env.apiBaseUrl
  });
  var auth = authMod.createAuth({ client: client, accounts: accounts, redactor: redactor, log: logger.log, recordError: errors.record });
  var catalog = catalogMod.createCatalog({ client: client, host: host, account: accounts.current, now: host.timers.now, log: logger.log });
  var standIns = assetsMod.createStandIns({ client: client, host: host, account: accounts.current, log: logger.log });
  var panel = null;
  var accountPanel = null;
  var lanes = null;
  var picker = null;
  var link = null;
  var diagnostics = null;
  var quotes = null;
  var ledger = null;
  var runner = null;
  var references = null;
  var jobsView = null;

  // UXP wants entrypoints declared during the first synchronous run.
  host.setupEntrypoints({
    panels: {
      scenarioPanel: {
        show: function () {
          if (panel) panel.refresh();
          // Price checks start when the panel is first shown, never at launch.
          if (lanes) lanes.activate();
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
  quotes = quotesMod.createQuotes({
    client: client,
    catalog: catalog,
    standIns: standIns,
    account: accounts.current,
    random: random,
    now: host.timers.now,
    log: logger.log,
    onAlarm: function () {
      errors.record("DryRunCreatedJob");
    }
  });
  var catalogTools = catalogToolsMod.createCatalogTools({ catalog: catalog, quotes: quotes, host: host, settings: settings });
  var session = sessionMarker(random, host.timers.now);
  // Paid generation needs a secure random source for the job ids; without
  // one, prices still show and Generate stays off.
  if (random) {
    ledger = ledgerMod.createLedger({ host: host, random: random, now: host.timers.now, log: logger.log, session: session });
    var downloader = downloadMod.createDownloader({
      client: client,
      fetch: host.fetch,
      AbortController: host.AbortController,
      timers: host.timers,
      files: { writeBinary: host.writeDataBinary, rename: host.renameData, remove: host.removeData },
      origins: env.downloadOrigins
    });
    runner = runnerMod.createRunner({
      client: client,
      quotes: quotes,
      ledger: ledger,
      catalog: catalog,
      host: host,
      downloader: downloader,
      settings: settings,
      account: accounts.current,
      version: VERSION,
      session: session,
      log: logger.log,
      timers: host.timers,
      now: host.timers.now,
      recordError: errors.record,
      pollDelay: env.pollDelay
    });
    references = referencesMod.createReferences({ host: host, random: random, log: logger.log });
  }

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
    if (ledger) {
      try {
        await ledger.load();
        runner.resume();
      } catch (e) {
        logger.log("jobs unavailable: " + e.message);
      }
    }
    try {
      var acc = await accounts.load();
      logger.log(acc.signed_in ? "signed in (" + acc.count + " project(s) saved)" : "not signed in");
    } catch (e) {
      logger.log("saved keys unavailable: " + e.message);
    }
    if (flags.DEV) {
      // Development builds only: a key pair left in the data folder goes
      // through Save and test, then the file is removed.
      try {
        await devKeyImport.importKey(host, auth, logger.log);
      } catch (e) {
        logger.log("dev key import failed (" + ((e && e.type) || "Internal") + ")");
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
      handlers: {
        scenario_status: statusMod.createStatusHandler(host, settings, VERSION, auth, ledger),
        list_models: catalogTools.list_models,
        model_schema: catalogTools.model_schema,
        estimate_cost: catalogTools.estimate_cost
      },
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
      },
      onLane: function (id) {
        if (!lanes) return;
        lanes.select(id);
        lanes.activate();
      }
    };
    panel = panelMod.createPanel(env.document, panelActions, VERSION);
    picker = pickerMod.createPicker(env.document, {
      catalog: catalog,
      host: host,
      log: logger.log,
      onChoose: function (row) {
        var lane = lanes ? lanes.choose(row) : null;
        if (lane && panel) panel.selectLane(lane);
      },
      onClose: function () {
        if (lanes) lanes.restore();
      }
    });
    lanes = lanesMod.createLanes(env.document, {
      catalog: catalog,
      quotes: quotes,
      host: host,
      account: accounts.current,
      timers: host.timers,
      log: logger.log,
      openPicker: function (tab, tool) {
        if (picker) picker.open(tab, tool);
      },
      runner: runner,
      references: references,
      ledger: ledger,
      settings: settings,
      openJobs: function () {
        if (jobsView) jobsView.open();
      }
    });
    diagnostics = diagnosticsMod.createDiagnostics({ version: VERSION, build: flags.BUILD, host: host, settings: settings, auth: auth, link: link, errors: errors, jobs: ledger });
    accountPanel = accountPanelMod.createAccountPanel(env.document, {
      auth: auth,
      version: VERSION,
      openLink: function (name) {
        if (!Object.prototype.hasOwnProperty.call(API.links, name) || name.charAt(0) === "$") throw new Error("unknown link " + name);
        return host.openExternal(API.links[name]);
      },
      copyText: function (text) {
        return host.clipboardWrite(redactor.apply(text));
      },
      diagnostics: function () {
        return redactor.apply(diagnostics.text());
      }
    });
    if (ledger && accountPanel) {
      jobsView = jobsViewMod.createJobsView(env.document, {
        ledger: ledger,
        runner: runner,
        showView: accountPanel.showView,
        homeView: accountPanel.homeView,
        copyText: function (text) {
          return host.clipboardWrite(redactor.apply(text));
        },
        timers: host.timers,
        log: logger.log
      });
    }
    accounts.onChange(function () {
      if (accountPanel) accountPanel.refresh();
      if (lanes) lanes.refresh();
    });
    // Document, canvas and selection changes reprice the Image lane.
    if (typeof host.onDocumentEvents === "function" && !host.onDocumentEvents(function () {
      if (lanes) lanes.documentChanged();
    })) {
      logger.log("document events unavailable");
    }

    link.start();
    return {
      host: host,
      link: link,
      pairing: pairing,
      panel: panel,
      settings: settings,
      random: random,
      logger: logger,
      auth: auth,
      accounts: accounts,
      client: client,
      catalog: catalog,
      quotes: quotes,
      standIns: standIns,
      lanes: lanes,
      picker: picker,
      catalogTools: catalogTools,
      accountPanel: accountPanel,
      ledger: ledger,
      runner: runner,
      references: references,
      jobsView: jobsView,
      session: session,
      diagnostics: diagnostics,
      errors: errors,
      redactor: redactor,
      copyToken: panelActions.copyToken,
      resetToken: panelActions.resetToken
    };
  })();

  return ready;
}

module.exports = { boot: boot, catalogHash: catalogHash, VERSION: VERSION };
