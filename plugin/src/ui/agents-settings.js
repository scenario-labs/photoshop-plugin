"use strict";
// Settings > Agents (wireframe 13, SPEC 6.3 and 6.6): the three switches,
// No-spend mode, Agent spending (Ask each time, or Allow without asking for
// one connected client with a per-call limit and a total) and the activity
// log. Rendered into #agents-controls. Only the person changes these.

var TEXT = {
  modify: "Agents may modify the document",
  modify_note: "Off: agent changes arrive as proposals you apply.",
  commands: "Agents may run Photoshop commands",
  commands_note: "Lets agents run Photoshop commands (batchPlay) on the document in front: layers, selections, masks, adjustments, filters and transforms. Each call is one History step. Commands that save, close, export or print, play Actions, run scripts, use Adobe's generative features or change Photoshop's settings are always refused. Turn on only for agents you trust. Needs the switch above. Turns off when Photoshop quits.",
  scope: "Agents read the active document only",
  scope_note: "Agents see only the document you are working on and the jobs made from it on this computer. Images already in your Scenario project, such as generations and Library assets, stay visible to agents.",
  no_spend: "No-spend mode",
  no_spend_note: "Refuses paid calls and agent uploads.",
  spending: "Agent spending",
  ask: "Ask each time",
  allow: "Allow without asking for",
  allow_note: "until its session ends, Photoshop quits or you end it. Prices with no upper bound always ask.",
  no_client: "No agent is connected. Connect a client first.",
  log: "Activity log",
  log_empty: "Nothing yet. What agents read, send, spend and change is listed here."
};

function el(doc, tag, cls, text) {
  var e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function clear(node) {
  while (node.children && node.children.length) node.removeChild(node.children[0]);
}

function hhmm(iso) {
  var d = new Date(iso);
  var p = function (n) {
    return (n < 10 ? "0" : "") + n;
  };
  return p(d.getHours()) + ":" + p(d.getMinutes());
}

// o: { settings, approvals, clients() -> [{session, client_name,
//      connected_at}], openConnect(), log }
function createAgentsSettings(doc, o) {
  if (!doc || typeof doc.getElementById !== "function") return null;
  var box = doc.getElementById("agents-controls");
  if (!box) return null;
  var log = o.log || function () {};
  var pick = null;
  var perCall = "50";
  var total = "300";
  var logOpen = false;
  var note = "";

  function fail(e) {
    note = (e && e.message) || String(e);
    render();
  }

  function checkbox(key, label, sub, checked, disabled, fn) {
    var row = el(doc, "div", "setting");
    var c = el(doc, "sp-checkbox", null, label);
    c.setAttribute("data-switch", key);
    if (checked) c.setAttribute("checked", "");
    if (disabled) c.setAttribute("disabled", "");
    c.checked = !!checked;
    c.addEventListener("change", function (ev) {
      var v = ev && ev.target && typeof ev.target.checked === "boolean" ? ev.target.checked : !checked;
      fn(v);
    });
    row.appendChild(c);
    row.appendChild(el(doc, "div", "note", sub));
    return row;
  }

  function clientLabel(c) {
    var t = c.connected_at ? new Date(c.connected_at) : null;
    return c.client_name + (t && !isNaN(t.getTime()) ? ", since " + hhmm(t.toISOString()) : "");
  }

  function render() {
    clear(box);
    var sw = o.settings.switches();
    box.appendChild(
      checkbox("agents_may_modify", TEXT.modify, TEXT.modify_note, sw.agents_may_modify, false, function (v) {
        o.settings.setSwitch("agents_may_modify", v).then(render, fail);
      })
    );
    box.appendChild(
      checkbox("agents_may_run_commands", TEXT.commands, TEXT.commands_note, sw.agents_may_run_commands, !sw.agents_may_modify, function (v) {
        o.settings.setSwitch("agents_may_run_commands", v).then(render, fail);
      })
    );
    box.appendChild(
      checkbox("active_document_only", TEXT.scope, TEXT.scope_note, sw.active_document_only, false, function (v) {
        o.settings.setSwitch("active_document_only", v).then(render, fail);
      })
    );
    box.appendChild(
      checkbox("no_spend", TEXT.no_spend, TEXT.no_spend_note, o.settings.noSpend(), false, function (v) {
        o.settings.setNoSpend(v).then(render, fail);
      })
    );

    box.appendChild(el(doc, "div", "sub-title", TEXT.spending));
    var sp = o.settings.spending();
    var clients = o.clients() || [];
    if (sp.mode === "allow" && sp.client) {
      box.appendChild(el(doc, "div", "note", "Allowed without asking for " + clientLabel(sp.client) + ": up to " + sp.per_call_limit + " CU per call, " + sp.remaining + " of " + sp.session_total + " CU left."));
      var end = el(doc, "sp-action-button", null, "End");
      end.setAttribute("data-act", "end-allowance");
      end.addEventListener("click", function () {
        o.settings.end("ended by you");
        render();
      });
      box.appendChild(end);
    } else {
      box.appendChild(el(doc, "div", "note", "(o) " + TEXT.ask));
      if (!clients.length) {
        box.appendChild(el(doc, "div", "note", TEXT.no_client));
      } else {
        if (!pick || !clients.some(function (c) {
          return c.session === pick;
        })) pick = clients[0].session;
        var row = el(doc, "div", "actions");
        for (var i = 0; i < clients.length; i++) {
          var cb = el(doc, "sp-action-button", pick === clients[i].session ? "selected" : null, clientLabel(clients[i]));
          cb.setAttribute("data-client", clients[i].session);
          cb.addEventListener("click", (function (s) {
            return function () {
              pick = s;
              render();
            };
          })(clients[i].session));
          row.appendChild(cb);
        }
        box.appendChild(el(doc, "div", "note", TEXT.allow));
        box.appendChild(row);
        var limits = el(doc, "div", "actions");
        var pc = el(doc, "sp-textfield", null);
        pc.setAttribute("data-field", "per-call");
        pc.value = perCall;
        pc.addEventListener("input", function () {
          perCall = pc.value;
        });
        var tt = el(doc, "sp-textfield", null);
        tt.setAttribute("data-field", "total");
        tt.value = total;
        tt.addEventListener("input", function () {
          total = tt.value;
        });
        limits.appendChild(el(doc, "span", "note", "up to"));
        limits.appendChild(pc);
        limits.appendChild(el(doc, "span", "note", "CU per call and"));
        limits.appendChild(tt);
        limits.appendChild(el(doc, "span", "note", "CU in total,"));
        box.appendChild(limits);
        box.appendChild(el(doc, "div", "note", TEXT.allow_note));
        var give = el(doc, "sp-action-button", null, "Allow");
        give.setAttribute("data-act", "grant");
        give.addEventListener("click", function () {
          var c = null;
          for (var k = 0; k < clients.length; k++) if (clients[k].session === pick) c = clients[k];
          try {
            o.settings.grant(c, perCall, total);
            note = "";
          } catch (e) {
            note = e.message;
          }
          render();
        });
        box.appendChild(give);
      }
    }
    if (note) box.appendChild(el(doc, "div", "note", note));

    var actions = el(doc, "div", "actions");
    var connect = el(doc, "sp-action-button", null, "Connect a client");
    connect.setAttribute("data-act", "connect");
    connect.addEventListener("click", function () {
      if (o.openConnect) o.openConnect();
    });
    var logBtn = el(doc, "sp-action-button", null, logOpen ? "Hide activity log" : TEXT.log);
    logBtn.setAttribute("data-act", "activity");
    logBtn.addEventListener("click", function () {
      logOpen = !logOpen;
      render();
    });
    actions.appendChild(connect);
    actions.appendChild(logBtn);
    box.appendChild(actions);
    if (logOpen) {
      var items = o.approvals.activity();
      var list = el(doc, "div", "details");
      list.setAttribute("data-list", "activity");
      if (list.style) list.style.display = "block";
      if (!items.length) list.appendChild(el(doc, "div", "note", TEXT.log_empty));
      for (var j = 0; j < Math.min(items.length, 50); j++) {
        var it = items[j];
        list.appendChild(el(doc, "div", "note", hhmm(it.at) + " " + (it.client_name || "Agent") + "  " + it.what + (it.detail ? " (" + it.detail + ")" : "")));
      }
      box.appendChild(list);
    }
  }

  o.settings.onChange(function () {
    render();
  });
  o.approvals.onChange(function () {
    if (logOpen) render();
  });
  render();
  log("agents settings ready");
  return { render: render };
}

module.exports = { createAgentsSettings: createAgentsSettings, TEXT: TEXT };
