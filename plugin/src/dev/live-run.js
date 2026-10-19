"use strict";
// DEVELOPMENT BUILDS ONLY. Release bundles replace this module with a stub
// (plugin/scripts/build.js), and a test checks that they do.
//
// Drives the Edit and Enhance lanes from a live check without clicking in
// the panel (test/live/m4-live-check.js). Every 2 s it looks for
// "dev-live-run.json" in the plugin's data folder. A request:
//   { id, document: { width, height, fixture (a PNG in the data folder at
//     that size), flatten }, selection: { left, top, width, height, shape:
//     "rect" | "ellipse", feather } | null, run: lanes/flow.js `a`,
//     trained_pick: { type, base } (a public trained model of that type),
//     spend: true to generate (else price only), max_cu (refuse above),
//     timeout_s, keep_open }
// It makes its own document from the fixture, prices the run, and with
// `spend` generates through the same flow, quote and runner as the panel,
// waits for the result to land, reads the composite before and after, then
// closes the documents it made without saving. It writes
// dev-live/<id>/result.json and PNGs beside it. It never touches a
// document it did not make. The request file is removed when read.

var png = require("../util/png.js");
var trainedMod = require("../catalog/trained.js");
var price = require("../forms/price.js");

var REQUEST = "dev-live-run.json";
var DIR = "dev-live";
var POLL_MS = 2000;
var EVIDENCE_LONG = 1024;
var TERMINAL = ["applied", "apply_failed", "failed", "blocked", "canceled", "not_sent", "uncertain", "download_failed", "awaiting_approval"];

function px(v) {
  return { _unit: "pixelsUnit", _value: v };
}

function sleep(host, ms) {
  return new Promise(function (resolve) {
    host.timers.setTimeout(resolve, ms);
  });
}

function safeId(id) {
  return String(id || "run").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "run";
}

// app: the object main.js boot() resolves; hostRequire: UXP's require;
// o: { poll (default true): watch the data folder for requests }.
function start(app, hostRequire, o) {
  o = o || {};
  var host = app.host;
  var log = app.logger ? app.logger.log : function () {};
  var ps = hostRequire ? hostRequire("photoshop") : null;
  var uxp = hostRequire ? hostRequire("uxp") : null;
  var lfs = uxp && uxp.storage ? uxp.storage.localFileSystem : null;
  var stopped = false;
  var busy = false;

  function modal(name, fn) {
    return ps.core.executeAsModal(fn, { commandName: name });
  }

  async function play(descs) {
    return ps.action.batchPlay(descs, {});
  }

  function findDoc(id) {
    var docs = ps.app.documents || [];
    for (var i = 0; i < docs.length; i++) if (docs[i].id === id) return docs[i];
    return null;
  }

  async function entryFor(path) {
    if (typeof lfs.getEntryWithUrl === "function") {
      try {
        return await lfs.getEntryWithUrl("plugin-data:/" + path);
      } catch (e) {
        // the data folder below
      }
    }
    var folder = await lfs.getDataFolder();
    return folder.getEntry(path);
  }

  // A new document holding the fixture, flattened when asked, with the
  // selection set. Resolves its id.
  async function makeDocument(d, sel, name) {
    return modal("Scenario dev: set up", async function () {
      var o = { width: d.width, height: d.height, resolution: 72, name: name };
      if (ps.constants && ps.constants.NewDocumentMode) o.mode = ps.constants.NewDocumentMode.RGB;
      if (ps.constants && ps.constants.DocumentFill) o.fill = ps.constants.DocumentFill.WHITE;
      var doc = await ps.app.createDocument(o);
      if (d.fixture) {
        var token = lfs.createSessionToken(await entryFor(d.fixture));
        await play([{ _obj: "placeEvent", null: { _path: token, _kind: "local" }, freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" }, offset: { _obj: "offset", horizontal: px(0), vertical: px(0) } }]);
        if (d.flatten) await play([{ _obj: "flattenImage" }]);
      }
      if (sel) {
        var shape = sel.shape === "ellipse" ? "ellipse" : "rectangle";
        await play([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _obj: shape, top: px(sel.top), left: px(sel.left), bottom: px(sel.top + sel.height), right: px(sel.left + sel.width) }, antiAlias: true }]);
        if (sel.feather) await play([{ _obj: "feather", radius: px(sel.feather), selectionModifyEffectAtCanvasBounds: false }]);
      }
      return doc.id;
    });
  }

  async function closeDocs(ids) {
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      try {
        await modal("Scenario dev: close", async function () {
          var doc = findDoc(id);
          if (doc) await doc.closeWithoutSaving();
        });
      } catch (e) {
        log("dev live run: a document did not close (" + ((e && e.message) || e) + ")");
      }
    }
  }

  async function savePng(path, img) {
    var bytes = png.encodePng({ width: img.width, height: img.height, channels: img.components, data: img.data });
    await host.writeDataBinary(path, bytes);
    return path;
  }

  async function composite(docId, path) {
    try {
      var img = await host.readPixels({ document_id: docId, layer_id: null, bounds: null, long_side: EVIDENCE_LONG });
      return await savePng(path, img);
    } catch (e) {
      log("dev live run: composite not read (" + ((e && e.message) || e) + ")");
      return null;
    }
  }

  async function pickTrained(p) {
    await app.catalog.ensure();
    var rows = app.catalog.rows() || [];
    var base = await app.catalog.schema(p.base);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.type !== p.type) continue;
      var d = trainedMod.derive(r, [base]);
      if (!d.supported) continue;
      return { model_id: r.id, name: r.name, kind: d.trained_kind, scale: d.default_scale };
    }
    throw new Error("no public trained model of type " + p.type);
  }

  async function waitFor(localId, timeoutMs) {
    var t0 = host.timers.now();
    var readySince = null;
    while (host.timers.now() - t0 < timeoutMs) {
      var rec = app.ledger.get(localId);
      if (rec && TERMINAL.indexOf(rec.state) >= 0) return rec;
      if (rec && rec.state === "ready") {
        if (readySince === null) readySince = host.timers.now();
        else if (host.timers.now() - readySince > 10000) {
          // Place when ready did not run (Photoshop busy, or another document
          // active): place it as the Place button does.
          try {
            await app.runner.place(localId);
          } catch (e) {
            log("dev live run: place failed (" + ((e && e.message) || e) + ")");
          }
          readySince = host.timers.now();
        }
      }
      await sleep(host, 1000);
    }
    return app.ledger.get(localId);
  }

  async function run(req) {
    var id = safeId(req.id);
    var dir = DIR + "/" + id;
    await host.ensureDataDir(dir);
    var out = { id: id, route: req.route || null, started_at: new Date(host.timers.now()).toISOString(), photoshop: typeof host.photoshopVersion === "function" ? host.photoshopVersion() : null, ok: false, state: null, error: null, files: {} };
    var made = [];
    try {
      if (!app.accounts.current()) throw new Error("not signed in");
      var a = JSON.parse(JSON.stringify(req.run || {}));
      if (req.trained_pick) {
        var t = await pickTrained(req.trained_pick);
        a.trained = { model_id: t.model_id, kind: t.kind, scale: t.scale };
        a.model_id = req.trained_pick.base;
        out.trained = { model_id: t.model_id, name: t.name, type: req.trained_pick.type, kind: t.kind, scale: t.scale };
      }
      var docId = await makeDocument(req.document, req.selection || null, "Scenario dev " + id);
      made.push(docId);
      out.files.before = await composite(docId, dir + "/before.png");
      var p = await app.flow.price(a);
      out.view = { tool: p.view.tool, model_id: p.view.model_id, blocked: p.view.blocked, source: p.view.source, sizes: p.view.sizes, notes: p.view.notes, route: p.view.route || null, experimental: !!p.view.experimental };
      out.request = p.req ? { lane: p.req.lane, model_id: p.req.model_id, takes: p.req.takes, target: p.req.target, parameters: p.req.parameters } : null;
      out.price_state = p.state;
      if (p.state !== "ready") throw new Error("price " + p.state + (p.reason ? ": " + p.reason : ""));
      out.quote = { label: p.quote.label, cu: p.quote.cu_cost_exact, kind: p.quote.price_kind, no_refund: !!p.quote.no_refund };
      if (!req.spend) {
        out.ok = true;
        out.state = "priced";
        return out;
      }
      if (req.max_cu !== undefined && price.toThousandths(p.quote.price_kind === "range" && typeof p.quote.cu_cost_max === "number" ? p.quote.cu_cost_max : p.quote.cu_cost) > price.toThousandths(Number(req.max_cu))) throw new Error("price above max_cu; nothing sent");
      var started = await app.flow.generate(a, p.quote);
      var localId = started.record ? started.record.local_id : null;
      out.local_id = localId;
      var rec = localId ? await waitFor(localId, (req.timeout_s || 600) * 1000) : null;
      if (!rec) throw new Error("no job record");
      out.state = rec.state;
      out.error = rec.error || null;
      out.model_id = rec.model_id;
      out.model_name = rec.model_name;
      out.trained_model_ids = rec.trained_model_ids || [];
      out.cu_quoted = rec.cu_quoted;
      out.cu_charged = rec.cu_charged;
      out.job_id = rec.job_id || null;
      out.asset_ids = (rec.outputs || []).map(function (x) {
        return x.asset_id || null;
      });
      out.parameters = rec.parameters;
      out.capture = rec.inputs && rec.inputs.capture ? rec.inputs.capture : null;
      out.outputs = (rec.outputs || []).map(function (x) {
        return { width: x.width, height: x.height, path: x.path };
      });
      out.placement = rec.placement || null;
      if (rec.placement && rec.placement.document_id && made.indexOf(rec.placement.document_id) < 0) made.push(rec.placement.document_id);
      if (rec.placement && rec.placement.document_id) out.files.after = await composite(rec.placement.document_id, dir + "/after.png");
      out.ok = rec.state === "applied";
      return out;
    } catch (e) {
      out.error = out.error || (e && e.type ? e.type + ": " : "") + ((e && e.message) || String(e));
      return out;
    } finally {
      out.finished_at = new Date(host.timers.now()).toISOString();
      if (!req.keep_open) await closeDocs(made);
      out.closed = !req.keep_open;
      try {
        await host.writeDataText(dir + "/result.json", JSON.stringify(out, null, 1));
      } catch (e) {
        log("dev live run: result not written");
      }
    }
  }

  async function tick() {
    if (stopped) return;
    if (!busy) {
      var text = null;
      try {
        text = await host.readDataText(REQUEST);
      } catch (e) {
        text = null;
      }
      if (text) {
        busy = true;
        try {
          await host.removeData(REQUEST);
        } catch (e) {
          // a request that cannot be removed would run again: stop polling
          stopped = true;
        }
        var req = null;
        try {
          req = JSON.parse(text);
        } catch (e) {
          log("dev live run: request is not JSON");
        }
        if (req) {
          log("dev live run: " + safeId(req.id));
          await run(req);
        }
        busy = false;
      }
    }
    if (!stopped) host.timers.setTimeout(tick, POLL_MS);
  }

  if (ps && lfs && o.poll !== false) host.timers.setTimeout(tick, POLL_MS);
  return {
    run: run,
    stop: function () {
      stopped = true;
    },
    REQUEST: REQUEST
  };
}

module.exports = { start: start, REQUEST: REQUEST, DIR: DIR };
