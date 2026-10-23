"use strict";
// DEVELOPMENT BUILDS ONLY. Release bundles replace this module with an empty
// stub (plugin/scripts/build.js), and a test checks that they do.
//
// A loop for working on the panel's look without restarting Photoshop or
// touching it: the build polls the file "dev-ui-command.json" in the
// plugin's data folder, runs the one command it holds from a fixed list (no
// code is evaluated), writes "dev-ui-result.json" and removes the command
// file. test/live/ui-dev.js writes the commands and reads the results.
//
// Commands: ping; reload (reloads the panel, which reads index.html,
// styles.css and dist/main.js again from the installed plugin folder); view
// (shows a view, an action or the model picker); width (constrains the
// panel's root to a width, or shifts it left, to look at widths other than
// the docked one); scroll; metrics (the box of every element with an id);
// demo (fills a view with sample data through the panel's own render code,
// dev/ui-demo.js, for pictures made for the docs only);
// menu (the panel menu items, and runs one of them).
//
// Driving the real creation panel, on documents the loop makes itself (it
// never touches another document): makedoc (a new document from a fixture
// in the data folder, with a selection), select (sets or drops the selection
// of its document), layer (makes one of its layers active), selection (its
// selection's bounds), state (the controller's state and the model the view
// draws), click (an element by id, or by a data attribute and its value, as
// a person would), prompt (types into the prompt), pop (opens a chip menu by
// kind, or closes it; "stylesrc" opens Match an image from the Style menu),
// stylesrc (picks Match an image's picture: selection, layer, visible, or a
// file read from the data folder in place of the dialog), inspect (its document's layers, masks, Scenario
// metadata and History state), adopt (takes on a document that a run
// started from this loop opened, such as Create image's new document, so it
// can be inspected and closed), closedoc (closes the documents it made,
// without saving), savedoc (saves one of its documents as a PSD under
// dev-live/ in the data folder), opendoc (opens such a PSD again as one of
// its documents, after a restart), hook (arms a test hook of
// dev/test-hooks.js, such as a delay after a status read, to look at a
// running job), probe (records the real mouse events the panel receives,
// for a pass that clicks with the system's pointer), rects (the boxes of
// the elements a selector matches). The list of documents it made survives
// a reload of the panel (dev-ui-made.json), so a reload never strands one.

var uiDemo = require("./ui-demo.js");

var COMMAND = "dev-ui-command.json";
var RESULT = "dev-ui-result.json";
// The documents the loop made, kept across panel reloads so a reload never
// leaves one it cannot close.
var MADE = "dev-ui-made.json";
var POLL_MS = 500;

function rect(el) {
  var b = el.getBoundingClientRect();
  return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
}

// o: { host, doc, global, app, log, menu: { items(), invoke(id) } }
function start(o) {
  var host = o.host;
  var doc = o.doc;
  var busy = false;
  var stopped = false;
  var made = [];
  var startedAt = new Date().toISOString();
  var madeRead = null;

  // Ids from before a reload count only while that document is still open.
  async function loadMade() {
    try {
      var text = await host.readDataText(MADE);
      var saved = text ? JSON.parse(text) : null;
      var open = typeof host.listDocuments === "function" ? host.listDocuments() : [];
      var ids = {};
      for (var i = 0; i < open.length; i++) ids[open[i].id] = true;
      if (saved && Array.isArray(saved.ids)) {
        for (var j = 0; j < saved.ids.length; j++) if (ids[saved.ids[j]] && made.indexOf(saved.ids[j]) < 0) made.push(saved.ids[j]);
      }
      if (saved && typeof saved.since === "string" && made.length) startedAt = saved.since;
    } catch (e) {
      // nothing saved
    }
  }

  function saveMade() {
    return host.writeDataText(MADE, JSON.stringify({ ids: made, since: startedAt }));
  }

  // UXP keeps a hidden element's last box, so visibility is read from the
  // display of the element and its parents.
  function hidden(el) {
    var gcs = o.global && typeof o.global.getComputedStyle === "function" ? o.global.getComputedStyle : null;
    for (var n = el; n && n !== doc.body; n = n.parentNode) {
      var d = n.style && n.style.display;
      if (!d && gcs) {
        try {
          d = gcs(n).display;
        } catch (e) {
          d = "";
        }
      }
      if (d === "none") return true;
    }
    return false;
  }

  function metrics(cmd) {
    var out = { body: rect(doc.body), elements: {} };
    var root = doc.getElementById(cmd.root || "app") || doc.body;
    out.root = rect(root);
    out.root_scroll = [root.scrollWidth, root.clientWidth, root.scrollHeight, root.clientHeight];
    var all = doc.querySelectorAll("[id]");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var r = rect(el);
      if (!cmd.all && (r[2] === 0 || r[3] === 0 || hidden(el))) continue;
      var text = String(el.textContent || "").replace(/\s+/g, " ").trim();
      out.elements[el.id] = {
        tag: String(el.tagName || "").toLowerCase(),
        r: r,
        s: [el.scrollWidth, el.clientWidth, el.scrollHeight, el.clientHeight],
        text: text.length > 80 ? text.slice(0, 77) + "..." : text
      };
      if (out.elements[el.id].tag === "img") {
        var src = String(el.getAttribute("src") || "");
        out.elements[el.id].img = [el.naturalWidth || 0, el.naturalHeight || 0, el.complete === true, src.slice(0, src.indexOf(":") + 1)];
      }
    }
    // The action chips one by one, and the top's class, for the short-panel
    // fold (create-view.js fitTop).
    var acts = doc.getElementById("acts");
    out.chips = [];
    for (var c = 0; acts && c < (acts.children || []).length; c++) {
      var ch = acts.children[c];
      out.chips.push({ act: ch.getAttribute("data-act"), r: rect(ch), o: [ch.offsetLeft, ch.offsetTop, ch.offsetWidth, ch.offsetHeight], c: [ch.clientWidth, ch.clientHeight] });
    }
    var top = doc.getElementById("sc-top");
    out.top_class = top ? String(top.className) : null;
    out.renders = o.app && o.app.createView && typeof o.app.createView.renders === "function" ? o.app.createView.renders() : null;
    return out;
  }

  // Real pointer checks: the loop's own click() calls a handler from code,
  // so it passes even when no mouse click can land (the redraw loop of
  // 2026-10-21). probe records the mouse events the panel really receives
  // from macOS, each with the element under the pointer and whether that
  // element is still in the page; a press whose click never arrives, or
  // arrives on a node that was replaced, is a click the person lost.
  var probeLog = [];
  var probeOn = false;
  function describe(el) {
    if (!el || !el.getAttribute) return null;
    var d = { tag: String(el.tagName || "").toLowerCase() };
    if (el.id) d.id = el.id;
    var cls = el.getAttribute("class");
    if (cls) d.cls = String(cls);
    var attrs = el.attributes || [];
    for (var i = 0; i < attrs.length; i++) if (/^data-/.test(attrs[i].name)) d[attrs[i].name] = attrs[i].value;
    var text = String(el.textContent || "").replace(/\s+/g, " ").trim();
    if (text) d.text = text.length > 40 ? text.slice(0, 37) + "..." : text;
    return d;
  }
  // The nearest element up the tree that names itself (id or a data-
  // attribute), which is what a check compares.
  function named(el) {
    for (var n = el; n && n !== doc.body && n.getAttribute; n = n.parentNode) {
      if (n.id) return n;
      var attrs = n.attributes || [];
      for (var i = 0; i < attrs.length; i++) if (/^data-/.test(attrs[i].name)) return n;
    }
    return el;
  }
  function inPage(el) {
    for (var n = el; n; n = n.parentNode) if (n === doc.body) return true;
    return false;
  }
  function record(ev) {
    var t = ev.target;
    var entry = { t: Date.now(), type: ev.type, x: Math.round(ev.clientX), y: Math.round(ev.clientY), target: describe(t), named: describe(named(t)), in_page: inPage(t), chain: [] };
    // Every named element from the target up, so a press on a control's icon
    // or label counts as a press on the control.
    for (var n = t; n && n !== doc.body && entry.chain.length < 6; n = n.parentNode) {
      if (n !== t && n === named(n) && (n.id || (n.attributes && n.attributes.length))) {
        var dn = describe(n);
        if (dn && (dn.id || Object.keys(dn).some(function (k) { return /^data-/.test(k); }))) entry.chain.push(dn);
      }
    }
    if (ev.type === "mousemove") {
      if (probeLog.length && probeLog[probeLog.length - 1].type === "mousemove") probeLog.pop();
    }
    probeLog.push(entry);
    if (probeLog.length > 400) probeLog.shift();
  }
  function probe(cmd) {
    if (cmd.on && !probeOn) {
      ["mousemove", "pointerdown", "mousedown", "mouseup", "click"].forEach(function (type) {
        doc.addEventListener(type, record, true);
      });
      probeOn = true;
    }
    var out = { on: probeOn, events: probeLog.slice(), renders: o.app && o.app.createView && typeof o.app.createView.renders === "function" ? o.app.createView.renders() : null };
    if (cmd.clear) probeLog = [];
    return out;
  }
  // Every shown element a selector matches, with its box and name.
  function rects(cmd) {
    var all = doc.querySelectorAll(String(cmd.sel || "[id]"));
    var out = [];
    for (var i = 0; i < all.length && out.length < 300; i++) {
      if (hidden(all[i])) continue;
      var row = { r: rect(all[i]), el: describe(all[i]) };
      // full: the whole text, to compare a view before and after a click.
      if (cmd.full) row.full = String(all[i].textContent || "").replace(/\s+/g, " ").trim().slice(0, 4000);
      if (cmd.full && all[i].tagName && /sp-(checkbox|textfield)/i.test(all[i].tagName)) row.value = all[i].checked !== undefined ? !!all[i].checked : all[i].value;
      out.push(row);
    }
    return { rects: out, viewport: [o.global.innerWidth, o.global.innerHeight] };
  }

  function setWidth(cmd) {
    var root = doc.getElementById("app") || doc.body;
    root.style.width = cmd.px ? cmd.px + "px" : "";
    root.style.marginLeft = cmd.shift ? -cmd.shift + "px" : "";
    return { width: rect(root) };
  }

  function view(cmd) {
    var app = o.app;
    if (app.picker && app.picker.state && app.picker.state().open && cmd.name !== "picker") app.picker.close();
    if (cmd.name === "jobs") {
      if (app.jobsView) app.jobsView.open();
    } else if (cmd.name === "picker") {
      if (app.accountPanel) app.accountPanel.showView("main");
      app.picker.open(cmd.tab || "image", cmd.tool || null);
    } else if (cmd.name === "main") {
      if (app.accountPanel) app.accountPanel.showView("main");
      if (app.controller) app.controller.activate();
      if (cmd.action && app.controller) app.controller.selectAction(cmd.action);
    } else if (app.accountPanel) {
      app.accountPanel.showView(cmd.name);
    }
    if (cmd.section) {
      var el = doc.getElementById(cmd.section);
      if (el && typeof el.scrollIntoView === "function") el.scrollIntoView();
    }
    return { view: cmd.name };
  }

  function scroll(cmd) {
    // el, not id: "id" carries the command's own request id.
    var el = doc.getElementById(cmd.el);
    if (!el) throw new Error("no element " + cmd.el);
    // by: scrolls from where the element is now, as a wheel turn does.
    el.scrollTop = typeof cmd.by === "number" ? el.scrollTop + cmd.by : cmd.top || 0;
    return { scrollTop: el.scrollTop };
  }

  async function demo(cmd) {
    if (cmd.what === "link") {
      o.app.panel.renderLink(cmd.args || {});
      return { demo: "link" };
    }
    return { demo: cmd.what, out: await uiDemo.run(cmd.what, cmd.args || {}, { host: host, app: o.app, doc: doc }) };
  }

  function live() {
    if (!o.app.devLive || typeof o.app.devLive.makeDocument !== "function") throw new Error("the dev live run is not available");
    return o.app.devLive;
  }

  function own(id) {
    var d = id === undefined || id === null ? made[made.length - 1] : Number(id);
    if (made.indexOf(d) < 0) throw new Error("not a document this loop made");
    return d;
  }

  // An element by id is "el": "id" carries the command's own request id.
  function find(cmd) {
    if (cmd.el) return doc.getElementById(cmd.el);
    var all = doc.querySelectorAll("[" + cmd.attr + "]");
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute(cmd.attr) === String(cmd.value) && !hidden(all[i])) return all[i];
    return null;
  }

  // The Match an image menu has no chip of its own: it opens from the
  // Style menu's Match an image row, as a person reaches it.
  async function openStyleSource() {
    await app0().createView.openPop("style");
    var pop = doc.getElementById("pop");
    var rows = doc.querySelectorAll("[data-value]");
    var match = null;
    for (var i = 0; i < rows.length && !match; i++) {
      if (rows[i].getAttribute("data-value") !== "match") continue;
      for (var n = rows[i]; n && !match; n = n.parentNode) if (n === pop) match = rows[i];
    }
    if (!match) throw new Error("no Match an image row in the Style menu");
    match.click();
    for (var w = 0; w < 60 && app0().createView.popKind() !== "stylesrc"; w++) {
      await new Promise(function (r) {
        host.timers.setTimeout(r, 50);
      });
    }
    if (app0().createView.popKind() !== "stylesrc") throw new Error("the Match an image menu did not open");
  }
  function app0() {
    return o.app;
  }

  async function drive(cmd) {
    var app = o.app;
    switch (cmd.cmd) {
      case "makedoc": {
        var id = await live().makeDocument(cmd.document, cmd.selection || null, cmd.name || "Scenario panel check");
        made.push(id);
        await saveMade();
        return { document_id: id };
      }
      case "select":
        return { selection: await live().select(own(cmd.document_id), cmd.selection || null) };
      case "state":
        return { state: app.controller.state(), model: app.controller.model(), pop: app.createView ? app.createView.popKind() : null };
      case "layer": {
        // Makes a layer of a document the loop made the active one, as a
        // click in the Layers panel does.
        var ld = own(cmd.document_id);
        await o.host.selectLayer(ld, Number(cmd.layer_id));
        return { layer_id: Number(cmd.layer_id) };
      }
      case "selection":
        return { selection: await o.host.selectionBounds(own(cmd.document_id)) };
      case "click": {
        var el = find(cmd);
        if (!el) throw new Error("no such element shown");
        // child: a row whose own control is its first child (More rows).
        if (typeof cmd.child === "number" && el.children && el.children[cmd.child]) el = el.children[cmd.child];
        el.click();
        return { clicked: true };
      }
      case "stylesrc": {
        // Style > Match an image, its picture: selection, layer, visible,
        // or file, which is read from cmd.path in the data folder in place
        // of the file dialog the loop cannot answer.
        var sv = String(cmd.value || "");
        if (["selection", "layer", "visible", "file"].indexOf(sv) < 0) throw new Error("not a Match an image source");
        if (sv !== "file") {
          await app.controller.choose("stylesrc", sv);
          return { stylesrc: sv, style: app.controller.state().style, note: app.controller.state().note };
        }
        if (!cmd.path) throw new Error("file: give path, a PNG or JPEG in the data folder");
        var sb = await host.readDataBinary(String(cmd.path));
        if (!sb) throw new Error("no such file in the data folder");
        var chooser = host.chooseImageFile;
        host.chooseImageFile = function () {
          return Promise.resolve({ name: String(cmd.path).split("/").pop(), bytes: sb });
        };
        try {
          await app.controller.choose("stylesrc", "file");
        } finally {
          host.chooseImageFile = chooser;
        }
        return { stylesrc: sv, style: app.controller.state().style, note: app.controller.state().note };
      }
      case "prompt": {
        var p = doc.getElementById("prompt");
        if (p) p.value = String(cmd.text || "");
        app.controller.setPrompt(String(cmd.text || ""));
        return { prompt: String(cmd.text || "") };
      }
      case "selecttext": {
        var sf = doc.getElementById("ctx-select");
        if (sf) sf.value = String(cmd.text || "");
        app.controller.setSelect(String(cmd.text || ""));
        return { select: String(cmd.text || "") };
      }
      case "pop":
        if (cmd.close) app.createView.closePop();
        else if (cmd.kind === "stylesrc") await openStyleSource();
        else await app.createView.openPop(cmd.kind);
        // menu: what the open menu lists (cmd.menu), as the controller gives it.
        return { pop: app.createView.popKind(), menu: cmd.menu && app.controller.menu ? await app.controller.menu(cmd.kind) : undefined };
      case "adopt": {
        // Only a document that a job created after the loop started opened
        // as its result (a new-document target), never one the person opened.
        var want = Number(cmd.document_id);
        var recs = app.ledger ? app.ledger.all() : [];
        var ok = false;
        for (var i = 0; i < recs.length; i++) {
          var r = recs[i];
          var t = r.target || {};
          var landed = (r.placement && r.placement.landed) || {};
          var opened = t.kind === "new_document" || (t.kind === "upscale" && t.lands === "new_document") || landed.new_document === true || (landed.kind === "video" && landed.document_id === want);
          if (opened && r.created_at >= startedAt && r.placement && r.placement.document_id === want) ok = true;
        }
        if (!ok) throw new Error("not a document opened by a run of this loop");
        if (made.indexOf(want) < 0) made.push(want);
        await saveMade();
        return { adopted: want };
      }
      case "inspect":
        return await live().inspect(own(cmd.document_id));
      case "composite":
        return { path: await live().composite(own(cmd.document_id), String(cmd.path || "dev-live/panel-composite.png")) };
      case "front":
        return { document_id: await live().front(own(cmd.document_id)) };
      case "savedoc": {
        var sname = String(cmd.psd || "panel-check.psd").replace(/[^A-Za-z0-9 ._-]/g, "");
        await live().saveDocument(own(cmd.document_id), "dev-live", sname);
        return { saved: "dev-live/" + sname };
      }
      case "opendoc": {
        var oname = String(cmd.psd || "panel-check.psd").replace(/[^A-Za-z0-9 ._-]/g, "");
        var oid = await live().openSaved("dev-live/" + oname);
        if (made.indexOf(oid) < 0) made.push(oid);
        await saveMade();
        return { document_id: oid };
      }
      case "placejob": {
        // Places a saved result of this loop's runs again, in the loop's own
        // active document (Place in current document), for the free checks
        // of a takes state after a restart.
        var act = typeof host.activeDocumentId === "function" ? host.activeDocumentId() : null;
        own(act);
        var rec = o.app.ledger ? o.app.ledger.get(String(cmd.local_id)) : null;
        if (!rec) throw new Error("no such job record");
        var done = await o.app.runner.place(rec.local_id, { current_document: true });
        return { state: done && done.state, placement: done && done.placement ? { group_id: done.placement.group_id, layer_ids: done.placement.layer_ids } : null };
      }
      case "hook": {
        var hk = o.app.hooks;
        if (!hk || !hk.active) throw new Error("test hooks are off in this build");
        var spec = cmd.spec && typeof cmd.spec === "object" ? cmd.spec : { action: "delay", ms: 20000 };
        hk.arm(String(cmd.point), { action: String(spec.action || "delay"), ms: Math.min(120000, Number(spec.ms) || 0), skip: Number(spec.skip) || 0 });
        return { armed: String(cmd.point) };
      }
      case "runwith": {
        // M7: Run with a trained model of the catalog (what a click on its
        // row in All models does).
        var trow = app.catalog && typeof app.catalog.find === "function" ? app.catalog.find(String(cmd.model_id)) : null;
        if (!trow) throw new Error("no such model in the catalog");
        await app.controller.chooseModel(trow);
        return { run_with: app.controller.state().runWith, style: app.controller.state().style };
      }
      case "lastrun": {
        // M7: the newest job record, for a live check to follow its run.
        var lr = (app.ledger ? app.ledger.all() : []).slice().sort(function (x, y) {
          return String(y.created_at || "").localeCompare(String(x.created_at || ""));
        })[0];
        if (!lr) return { record: null };
        return { record: { local_id: lr.local_id, state: lr.state, model_id: lr.model_id, trained_model_ids: lr.trained_model_ids || [], cu_quoted: lr.cu_quoted, cu_charged: lr.cu_charged, job_id: lr.job_id || null, document_id: lr.placement ? lr.placement.document_id : null, error: lr.error || null } };
      }
      case "library": {
        // M7: the Library grid's search, filters, Show more and the
        // reference picker, as the panel's own controls call them.
        if (cmd.add_ref) await app.controller.addRef("library");
        if (cmd.remove_ref) app.controller.removeRef(String(cmd.remove_ref));
        if (cmd.filter) app.controller.libraryFilter(String(cmd.filter));
        if (cmd.search !== undefined) app.controller.librarySearch(String(cmd.search));
        if (cmd.more) await app.controller.libraryMore();
        return { library: app.controller.model().composer.library };
      }
      case "tool":
        if (cmd.tool && cmd.tool.to_document_id !== undefined) own(cmd.tool.to_document_id);
        return await live().tool(own(cmd.document_id), cmd.tool || {});
      case "panel":
        return await live().panel(String(cmd.name || ""), cmd.show);
      case "closedoc": {
        var ids = cmd.all ? made.slice() : [own(cmd.document_id)];
        await live().closeDocs(ids);
        made = made.filter(function (x) {
          return ids.indexOf(x) < 0;
        });
        await saveMade();
        return { closed: ids };
      }
      default:
        return null;
    }
  }

  function menu(cmd) {
    if (!o.menu) return { items: null };
    if (cmd.invoke) o.menu.invoke(cmd.invoke);
    return { items: o.menu.items() };
  }

  async function run(cmd) {
    switch (cmd.cmd) {
      case "ctxprobe": {
        // What the context read sees: the active document and the list.
        var pr = { active: null, docs: null, error: null };
        try {
          pr.active = o.host.activeDocumentId();
          pr.docs = o.host.listDocuments();
          var t0 = Date.now();
          await Promise.race([o.app.controller.refresh(), new Promise(function (r) { host.timers.setTimeout(r, 8000); })]);
          pr.refresh_ms = Date.now() - t0;
        } catch (e) {
          pr.error = (e && e.message) || String(e);
        }
        return pr;
      }
      case "ping":
        return { pong: true };
      case "reload":
        host.timers.setTimeout(function () {
          o.global.location.reload();
        }, 200);
        return { reloading: true };
      case "view":
        return view(cmd);
      case "width":
        return setWidth(cmd);
      case "scroll":
        return scroll(cmd);
      case "metrics":
        return metrics(cmd);
      case "demo":
        return demo(cmd);
      case "menu":
        return menu(cmd);
      case "probe":
        return probe(cmd);
      case "rects":
        return rects(cmd);
      default: {
        var out = await drive(cmd);
        if (out === null) throw new Error("unknown command " + cmd.cmd);
        return out;
      }
    }
  }

  async function tick() {
    if (stopped) return;
    if (!busy) {
      busy = true;
      try {
        if (!madeRead) madeRead = loadMade();
        await madeRead;
        var text = await host.readDataText(COMMAND);
        if (text) {
          await host.removeData(COMMAND);
          var cmd = null;
          var out;
          try {
            cmd = JSON.parse(text);
            out = { id: cmd.id, ok: true, result: await run(cmd) };
          } catch (e) {
            out = { id: cmd && cmd.id, ok: false, error: String((e && e.message) || e) };
          }
          await host.writeDataText(RESULT, JSON.stringify(out));
        }
      } catch (e) {
        if (o.log) o.log("dev ui loop: " + ((e && e.message) || e));
      }
      busy = false;
    }
    host.timers.setTimeout(tick, POLL_MS);
  }

  host.timers.setTimeout(tick, POLL_MS);
  if (o.log) o.log("dev build: ui loop on");
  return {
    stop: function () {
      stopped = true;
    }
  };
}

module.exports = { start: start, COMMAND: COMMAND, RESULT: RESULT };
