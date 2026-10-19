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
// (shows a view, a lane, a tool or the model picker); width (constrains the
// panel's root to a width, or shifts it left, to look at widths other than
// the docked one); scroll; metrics (the box of every element with an id);
// demo (fills a view with sample data through the panel's own render code,
// dev/ui-demo.js);
// menu (the panel menu items, and runs one of them).

var uiDemo = require("./ui-demo.js");

var COMMAND = "dev-ui-command.json";
var RESULT = "dev-ui-result.json";
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
    return out;
  }

  function setWidth(cmd) {
    var root = doc.getElementById("app") || doc.body;
    root.style.width = cmd.px ? cmd.px + "px" : "";
    root.style.marginLeft = cmd.shift ? -cmd.shift + "px" : "";
    // mark: paints the root magenta for one capture, to find the panel in
    // the window picture.
    root.style.backgroundColor = cmd.mark ? "#ff00ff" : "";
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
      if (cmd.lane && app.panel) app.panel.selectLane(cmd.lane);
      if (cmd.tool) {
        var b = doc.getElementById("tool-" + cmd.tool);
        if (b) b.click();
      }
      if (app.lanes) app.lanes.activate();
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
    var el = doc.getElementById(cmd.id);
    if (!el) throw new Error("no element " + cmd.id);
    el.scrollTop = cmd.top || 0;
    return { scrollTop: el.scrollTop };
  }

  async function demo(cmd) {
    if (cmd.what === "link") {
      o.app.panel.renderLink(cmd.args || {});
      return { demo: "link" };
    }
    return { demo: cmd.what, out: await uiDemo.run(cmd.what, cmd.args || {}, { host: host, app: o.app, doc: doc }) };
  }

  function menu(cmd) {
    if (!o.menu) return { items: null };
    if (cmd.invoke) o.menu.invoke(cmd.invoke);
    return { items: o.menu.items() };
  }

  async function run(cmd) {
    switch (cmd.cmd) {
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
      default:
        throw new Error("unknown command " + cmd.cmd);
    }
  }

  async function tick() {
    if (stopped) return;
    if (!busy) {
      busy = true;
      try {
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
