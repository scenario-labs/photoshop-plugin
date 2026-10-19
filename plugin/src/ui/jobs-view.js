"use strict";
// The Jobs view (SPEC 3.11), On this computer: the ledger, newest first,
// with each row's status, price words, origin, time and the actions this
// build offers. Text from the ledger (prompts, document titles, Scenario's
// messages) is set with textContent only. The header's Jobs button shows the
// count of active jobs.

var text = require("./jobs-text.js");

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
    var box = byId("jobs-list");
    if (!box || typeof doc.createElement !== "function") return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var list = o.ledger.all();
    setText("jobs-empty", list.length ? "" : text.TEXT.empty);
    for (var i = 0; i < list.length; i++) {
      (function (rec) {
        var r = text.row(rec);
        var row = doc.createElement("div");
        row.setAttribute("class", "job-row");
        row.setAttribute("data-job", rec.local_id);
        var t = doc.createElement("sp-body");
        t.setAttribute("size", "S");
        t.textContent = r.title;
        row.appendChild(t);
        var m = doc.createElement("sp-body");
        m.setAttribute("size", "XS");
        m.setAttribute("class", "muted");
        m.textContent = r.meta;
        row.appendChild(m);
        if (r.detail) {
          var d = doc.createElement("sp-body");
          d.setAttribute("size", "XS");
          d.textContent = r.detail;
          row.appendChild(d);
        }
        if (r.actions.length) {
          var acts = doc.createElement("div");
          acts.setAttribute("class", "row wrap");
          for (var a = 0; a < r.actions.length; a++) {
            (function (act) {
              var b = doc.createElement("sp-action-button");
              b.setAttribute("data-action", act.name);
              b.textContent = act.name === "mark_not_sent" && armed === rec.local_id ? "Confirm: mark not sent" : act.label;
              b.addEventListener("click", function () {
                run(act.name, rec);
              });
              acts.appendChild(b);
            })(r.actions[a]);
          }
          row.appendChild(acts);
        }
        box.appendChild(row);
      })(list[i]);
    }
  }

  function renderCount() {
    var n = o.ledger.activeCount();
    var needs = o.ledger.count("uncertain") + o.ledger.count("awaiting_approval") + o.ledger.count("ready");
    setText("jobs", "Jobs" + (n ? " " + n : needs ? " (" + needs + ")" : ""));
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
