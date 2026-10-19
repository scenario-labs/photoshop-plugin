"use strict";
// The Jobs view (SPEC 3.11), On this computer: the ledger, newest first,
// with each row's status, price words, origin, time and the actions this
// build offers. Text from the ledger (prompts, document titles, Scenario's
// messages) is set with textContent only. The header's Jobs icon carries a
// count badge.

var text = require("./jobs-text.js");
var icons = require("./icons.js");
var thumbs = require("./thumbs.js");
var uiDemo = require("../dev/ui-demo.js");

var CONFIRM_MS = 5000;

// o: { ledger, runner, showView(name), homeView() -> name, copyText(text),
//      timers, log }
function createJobsView(doc, o) {
  if (!doc || typeof doc.getElementById !== "function") return null;
  var timers = o.timers || { setTimeout: setTimeout, clearTimeout: clearTimeout };
  var armed = null;
  var armTimer = null;
  var shown = false;

  function byId(id) {
    return doc.getElementById(id);
  }
  function setText(id, t) {
    var el = byId(id);
    if (el) el.textContent = t || "";
  }
  function bind(id, fn) {
    var el = byId(id);
    if (el) el.addEventListener("click", fn);
  }
  function show(id, on, display) {
    var el = byId(id);
    if (el && el.style) el.style.display = on ? display || "" : "none";
  }

  function note(t) {
    setText("jobs-note", t);
  }

  function run(name, rec) {
    var id = rec.local_id;
    var p;
    if (name === "place") p = o.runner.place(id, {});
    else if (name === "open") p = o.runner.place(id, { new_document: true });
    else if (name === "resume") p = o.runner.resumeDownload(id);
    else if (name === "decline") p = o.runner.decline(id);
    else if (name === "approve") p = o.runner.approve(id);
    else if (name === "copy_error") p = o.copyText(rec.error || text.statusLabel(rec.state));
    else if (name === "mark_not_sent") {
      if (armed !== id) {
        armed = id;
        if (armTimer) timers.clearTimeout(armTimer);
        armTimer = timers.setTimeout(function () {
          armed = null;
          render();
        }, CONFIRM_MS);
        note(text.TEXT.mark_confirm);
        render();
        return;
      }
      armed = null;
      p = o.runner.markNotSent(id);
    }
    note("");
    Promise.resolve(p).then(
      function () {
        if (name === "copy_error") note("Copied.");
        render();
      },
      function (e) {
        note((e && e.message) || String(e));
        render();
      }
    );
  }

  function render() {
    renderCount();
    if (!shown) return;
    renderList(o.ledger.all());
  }

  // One row per job: the first take's picture, the title and status, a
  // line of who, price and time, a detail when there is one, the actions.
  function renderList(list) {
    var box = byId("jobs-list");
    if (!box || typeof doc.createElement !== "function") return;
    while (box.firstChild) box.removeChild(box.firstChild);
    setText("jobs-empty", list.length ? "" : text.TEXT.empty);
    show("jobs-empty-box", !list.length, "flex");
    for (var i = 0; i < list.length; i++) {
      (function (rec) {
        var r = text.row(rec);
        var row = doc.createElement("div");
        row.setAttribute("class", "job-row");
        row.setAttribute("data-job", rec.local_id);
        var th = doc.createElement("div");
        th.className = "job-thumb";
        th.appendChild(icons.icon(doc, rec.lane === "image" || !rec.lane ? "image" : rec.lane === "edit" ? "edit" : "enhance"));
        var first = (rec.outputs || [])[0];
        var img = doc.createElement("img");
        img.className = "thumb-img";
        img.setAttribute("alt", "");
        th.appendChild(img);
        thumbs.show(img, first && first.state === "saved" ? thumbs.resultThumb(first.path) : null);
        row.appendChild(th);
        var main = doc.createElement("div");
        main.className = "job-main";
        var head = doc.createElement("div");
        head.className = "job-head";
        var t = doc.createElement("span");
        t.className = "job-title";
        t.textContent = r.name;
        t.setAttribute("title", r.name);
        head.appendChild(t);
        var stEl = doc.createElement("span");
        stEl.className = r.attention ? "job-status attention" : "job-status";
        // The shared labels are lower case (agents read them mid-sentence);
        // the row shows them as a status word.
        stEl.textContent = r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : "";
        head.appendChild(stEl);
        main.appendChild(head);
        var m = doc.createElement("div");
        m.className = "note one-line";
        m.textContent = r.meta;
        m.setAttribute("title", r.meta);
        main.appendChild(m);
        if (r.detail) {
          var d = doc.createElement("div");
          d.className = "note";
          d.textContent = r.detail;
          main.appendChild(d);
        }
        if (r.actions.length) {
          var acts = doc.createElement("div");
          acts.setAttribute("class", "actions");
          for (var a = 0; a < r.actions.length; a++) {
            (function (act) {
              var b = doc.createElement("sp-action-button");
              b.setAttribute("size", "s");
              b.setAttribute("data-action", act.name);
              b.textContent = act.name === "mark_not_sent" && armed === rec.local_id ? "Confirm: mark not sent" : act.label;
              b.addEventListener("click", function () {
                run(act.name, rec);
              });
              acts.appendChild(b);
            })(r.actions[a]);
          }
          main.appendChild(acts);
        }
        row.appendChild(main);
        box.appendChild(row);
      })(list[i]);
    }
  }

  // The header's Jobs icon: a count badge for running jobs, or for jobs
  // that wait for the person; the words are in its tooltip.
  function renderCount() {
    var n = o.ledger.activeCount();
    var waiting = o.ledger.count("uncertain") + o.ledger.count("awaiting_approval");
    var ready = o.ledger.count("ready");
    var badge = n || waiting + ready;
    setText("jobs-badge", badge ? String(badge) : "");
    var b = byId("jobs-badge");
    if (b) {
      b.className = !n && waiting ? "badge attention" : "badge";
      if (b.style) b.style.display = badge ? "block" : "none";
    }
    var words = [];
    if (n) words.push(n + " running");
    if (waiting) words.push(waiting + " waiting for you");
    if (ready) words.push(ready + " ready to place");
    var el = byId("jobs");
    if (el && el.setAttribute) el.setAttribute("title", "Jobs" + (words.length ? ": " + words.join(", ") : ""));
  }

  bind("jobs", function () {
    shown = true;
    o.showView("jobs");
    render();
  });
  bind("jobs-back", function () {
    shown = false;
    note("");
    o.showView(o.homeView());
  });

  o.ledger.onChange(function () {
    render();
  });
  renderCount();

  return {
    // Development builds only (a stub in release): sample rows.
    dev: uiDemo.hook("jobs", { renderList: renderList, renderCount: renderCount }),
    render: render,
    open: function () {
      shown = true;
      o.showView("jobs");
      render();
    },
    hidden: function () {
      shown = false;
    }
  };
}

module.exports = { createJobsView: createJobsView };
