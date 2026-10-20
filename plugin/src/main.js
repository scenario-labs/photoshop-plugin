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
var devUiLoop = require("./dev/ui-loop.js");
var redactMod = require("./util/redact.js");
var accountsMod = require("./auth/accounts.js");
var authMod = require("./auth/auth.js");
var clientMod = require("./scenario/client.js");
var diagnosticsMod = require("./diagnostics.js");
var catalogMod = require("./catalog/catalog.js");
var assetsMod = require("./scenario/assets.js");
var quotesMod = require("./forms/quotes.js");
var catalogToolsMod = require("./bridge/catalog-tools.js");
var controllerMod = require("./panel/controller.js");
var createViewMod = require("./ui/create-view.js");
var mapMod = require("./catalog/map.js");
var pickerMod = require("./ui/picker.js");
var ledgerMod = require("./jobs/ledger.js");
var runnerMod = require("./jobs/runner.js");
var downloadMod = require("./scenario/download.js");
var referencesMod = require("./capture/references.js");
var captureMod = require("./capture/capture.js");
var flowMod = require("./lanes/flow.js");
var hostMoreMod = require("./host-more.js");
var libraryMod = require("./panel/library.js");
var devLive = require("./dev/live-run.js");
var devHooks = require("./dev/test-hooks.js");
var jobsModelMod = require("./jobs/view-model.js");
var jobsViewMod = require("./ui/jobs-view.js");
var jobsTextMod = require("./ui/jobs-text.js");
var menuMod = require("./ui/menu.js");
var thumbsMod = require("./ui/thumbs.js");
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
// mock CDN), pollDelay, offlineMs, blockedTexts and testHooks (the
// development test hooks, which development builds always have) }
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
  var controller = null;
  var createView = null;
  var picker = null;
  var link = null;
  var diagnostics = null;
  var quotes = null;
  var ledger = null;
  var runner = null;
  var references = null;
  var capture = null;
  var jobsView = null;
  var menu = null;
  var jobsModel = null;
  var library = null;
  // Development builds only (dev/test-hooks.js); release builds carry a stub
  // whose points do nothing.
  var hooks = flags.DEV || env.testHooks ? devHooks.create({ log: logger.log, timers: host.timers }) : null;

  // UXP wants entrypoints declared during the first synchronous run. A
  // reloaded panel (development builds) finds them declared already. The
  // panel menu (ui/menu.js) holds Jobs, Projects, Settings, Connect an AI
  // Agent, Diagnostics, Help, About and Sign Out.
  try {
    host.setupEntrypoints({
      panels: {
        scenarioPanel: {
          show: function () {
            if (panel) panel.refresh();
            // Price checks start when the panel is first shown, never at launch.
            if (controller) controller.activate();
          },
          menuItems: menuMod.items(),
          invokeMenu: function (id) {
            if (menu) menu.invoke(id);
          }
        }
      }
    });
  } catch (e) {
    logger.log("entrypoints not set: " + ((e && e.message) || e));
  }

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
    capture = captureMod.createCapture({ host: host, random: random, log: logger.log, now: host.timers.now, session: session });
    var downloader = downloadMod.createDownloader({
      client: client,
      fetch: host.fetch,
      AbortController: host.AbortController,
      timers: host.timers,
      files: { writeBinary: host.writeDataBinary, rename: host.renameData, remove: host.removeData },
      origins: env.downloadOrigins,
      hooks: hooks
    });
    // Open from Library and + Reference > Library (panel/library.js).
    library = libraryMod.createLibrary({ client: client, downloader: downloader, host: host, log: logger.log });
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
      capture: capture,
      log: logger.log,
      timers: host.timers,
      now: host.timers.now,
      recordError: errors.record,
      pollDelay: env.pollDelay,
      hooks: hooks,
      blockedTexts: env.blockedTexts,
      offlineMs: env.offlineMs,
      // The later flows' landings (host-more.js), by target kind.
      placers: env.placers || hostMoreMod.createMorePlacers(host, { log: logger.log })
    });
    jobsModel = jobsModelMod.createJobsModel({
      ledger: ledger,
      runner: runner,
      host: host,
      session: session,
      now: host.timers.now,
      openLink: function (name) {
        return host.openExternal(API.links[name]);
      },
      copyText: function (text) {
        return host.clipboardWrite(redactor.apply(text));
      }
    });
    references = referencesMod.createReferences({ host: host, random: random, log: logger.log });
  }
  // The Edit and Enhance lanes' logic (lanes/), drawn by the panel.
  var flow = flowMod.createFlow({ catalog: catalog, quotes: quotes, host: host, runner: runner, capture: capture, account: accounts.current, log: logger.log });

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
    var jobsRead = false;
    if (ledger) {
      try {
        await ledger.load();
        jobsRead = true;
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
    // After the keys are read, so polling and downloads resume under the
    // project each job was made in (SPEC 6.4).
    if (jobsRead) {
      try {
        await runner.recover();
      } catch (e) {
        logger.log("jobs recovery failed: " + e.message);
      }
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
      }
    };
    panel = panelMod.createPanel(env.document, panelActions, VERSION);
    picker = pickerMod.createPicker(env.document, {
      catalog: catalog,
      host: host,
      log: logger.log,
      onChoose: function (row) {
        if (controller) controller.chooseModel(row);
      },
      onClose: function () {
        if (createView) createView.render();
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
        log: logger.log,
        popover: true
      });
    }
    // The creation panel (FLOWS v2): the controller reads Photoshop and runs
    // the actions on the lanes' logic; the view draws it.
    controller = controllerMod.createController({
      host: host,
      catalog: catalog,
      quotes: quotes,
      flow: flow,
      runner: runner,
      ledger: ledger,
      references: references,
      library: library,
      openFile: hostMoreMod.createOpener(host),
      client: client,
      account: accounts.current,
      settings: settings,
      jobsModel: jobsModel,
      session: session,
      timers: host.timers,
      log: logger.log,
      urls: thumbsMod.createUrls(env.global)
    });
    createView = createViewMod.createCreateView(env.document, controller, {
      log: logger.log,
      global: env.global,
      openPicker: function (lane) {
        if (picker) picker.open(mapMod.laneTab(lane || "image"), lane);
      },
      openSettings: function () {
        if (accountPanel) accountPanel.menuHandlers.agents();
      },
      jobsMenu: ledger
        ? function () {
            return { title: jobsTextMod.TEXT.pop_title, rows: jobsTextMod.popRows(ledger.all(), 6), empty: jobsTextMod.TEXT.pop_empty, note: jobsTextMod.TEXT.pop_note, all: jobsTextMod.TEXT.pop_all, all_sub: jobsTextMod.TEXT.pop_all_sub };
          }
        : null,
      openJobs: function () {
        if (jobsView) jobsView.open();
      },
      agentMenu: function () {
        var d = panel ? panel.link() : { names: [] };
        var names = d.names || [];
        return {
          title: "Agent",
          text: names.length ? names.join(", ") + (names.length > 1 ? " are" : " is") + " connected through the Scenario MCP. It can read the document and propose runs; spending waits for your approval." : d.headline && d.dot === "warn" ? d.headline + "." : "No agent connected. Connect Claude or another client through the Scenario MCP to let it propose runs here."
        };
      }
    });
    var menuHandlers = {};
    if (accountPanel) {
      for (var mk in accountPanel.menuHandlers) menuHandlers[mk] = accountPanel.menuHandlers[mk];
    }
    menuHandlers.jobs = function () {
      if (jobsView) jobsView.open();
    };
    menu = menuMod.createMenu(menuHandlers);
    accounts.onChange(function () {
      if (accountPanel) accountPanel.refresh();
      if (controller) controller.refresh();
      // Jobs waiting for their project's key continue.
      if (runner) runner.resume();
    });
    // Document, layer, canvas and selection changes update the context card
    // and reprice the selected action.
    if (typeof host.onDocumentEvents === "function" && !host.onDocumentEvents(function () {
      if (controller) controller.documentChanged();
    })) {
      logger.log("document events unavailable");
    }

    link.start();
    var app = {
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
      controller: controller,
      createView: createView,
      picker: picker,
      catalogTools: catalogTools,
      accountPanel: accountPanel,
      ledger: ledger,
      runner: runner,
      references: references,
      capture: capture,
      flow: flow,
      jobsView: jobsView,
      jobsModel: jobsModel,
      hooks: hooks,
      session: session,
      diagnostics: diagnostics,
      errors: errors,
      redactor: redactor,
      menu: menu,
      copyToken: panelActions.copyToken,
      resetToken: panelActions.resetToken
    };
    if (flags.DEV) {
      app.devUi = devUiLoop.start({ host: host, doc: env.document, global: env.global, app: app, log: logger.log, menu: menu });
      // Development builds only: the live check's requests, read from the
      // data folder (dev/live-run.js). Release builds carry a stub.
      try {
        app.devLive = devLive.start(app, env.hostRequire);
      } catch (e) {
        logger.log("dev live run unavailable (" + ((e && e.type) || "Internal") + ")");
      }
    }
    return app;
  })();

  return ready;
}

module.exports = { boot: boot, catalogHash: catalogHash, VERSION: VERSION };
