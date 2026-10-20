"use strict";
// The agent cards in the creation view (wireframes 10 and 13): the spend
// request goes to the F5 approval card above the composer (controller
// .showAgentRequest); upload and proposal cards, a second client's request,
// "Decline all from <client>", the "Agents can edit" banner and the
// allowance line render in #agent-cards. Each card's buttons call the
// approvals module (agents/approvals.js); nothing here decides anything.

function el(doc, tag, cls, text) {
  var e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function onClick(e, fn) {
  e.addEventListener("click", function (ev) {
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    fn();
  });
}

function clear(node) {
  while (node.children && node.children.length) node.removeChild(node.children[0]);
  if (!node.children) node.textContent = "";
}

// The F5 card writes "Approve · <cu> CU": the price without its unit.
function cuOf(label) {
  if (!label) return "";
  var m = /^from (\S+) CU/.exec(label);
  if (m) return "from " + m[1];
  return label.replace(/ CU$/, "");
}

// o: { approvals, controller, settings, log }
function createAgentCards(doc, o) {
  if (!doc || typeof doc.getElementById !== "function") return null;
  var box = doc.getElementById("agent-cards");
  var log = o.log || function () {};
  var shownSpend = null;

  function act(p) {
    Promise.resolve(p).catch(function (e) {
      log("agent card: " + ((e && e.message) || e));
      render();
    });
  }

  function button(text, blue, id, fn) {
    var b = el(doc, "div", blue ? "btn blue" : "btn");
    var l = el(doc, "span", "bl", text);
    b.appendChild(l);
    b.setAttribute("data-act", id);
    onClick(b, fn);
    return b;
  }

  function cardNode(c) {
    var n = el(doc, "div", "agentcard");
    n.setAttribute("data-card", c.kind);
    var who = el(doc, "div", "who");
    who.appendChild(el(doc, "span", "dot on"));
    who.appendChild(el(doc, "span", null, c.title));
    n.appendChild(who);
    for (var i = 0; i < c.lines.length; i++) n.appendChild(el(doc, "div", "what", c.lines[i]));
    if (c.data && c.data.prompt) n.appendChild(el(doc, "div", "q", c.data.prompt));
    if (c.note) n.appendChild(el(doc, "div", "meta", c.note));
    if (c.kind === "upload") n.appendChild(el(doc, "div", "meta", "Later uploads from it by this client are listed in the activity log."));
    var dis = c.disabled;
    if (dis) n.appendChild(el(doc, "div", "meta", dis));
    if (c.error) n.appendChild(el(doc, "div", "meta", c.error));
    n.appendChild(el(doc, "div", "meta", "Expires in 10 min"));
    var row = el(doc, "div", "actions");
    row.appendChild(
      button(c.decline_label || "Decline", false, "decline", function () {
        act(o.approvals.decline(c.id));
      })
    );
    var ap = button(c.approve_label || "Approve", true, "approve", function () {
      if (c.disabled) return;
      act(o.approvals.approve(c.id));
    });
    if (dis) ap.setAttribute("disabled", "");
    row.appendChild(ap);
    n.appendChild(row);
    return n;
  }

  function render() {
    var list = o.approvals.showing();
    // The F5 card shows the oldest spend request.
    var spend = null;
    for (var i = 0; i < list.length; i++) if (list[i].kind === "spend" && !spend) spend = list[i];
    if (spend && (!shownSpend || shownSpend.id !== spend.id || shownSpend.approve_label !== spend.approve_label || shownSpend.busy !== spend.busy)) {
      shownSpend = spend;
      var id = spend.id;
      o.controller.showAgentRequest({
        client_name: spend.client_name,
        what: spend.lines.join(" ") + (spend.note ? ". " + spend.note : "") + (/no upper bound/.test(spend.price_label || "") ? ". " + spend.price_label + "." : ""),
        prompt: spend.data ? spend.data.prompt : null,
        model_name: spend.data ? spend.data.model_name : null,
        cu: cuOf(spend.price_label),
        approve: function () {
          act(o.approvals.approve(id));
        },
        decline: function () {
          act(o.approvals.decline(id));
        }
      });
    } else if (!spend && shownSpend) {
      shownSpend = null;
      o.controller.showAgentRequest(null);
    }
    if (!box) return;
    clear(box);
    var sw = o.settings.switches();
    if (sw.agents_may_modify) {
      var ban = el(doc, "div", "note", "Agents can edit");
      ban.setAttribute("data-banner", "agents-can-edit");
      box.appendChild(ban);
    }
    var sp = o.settings.spending();
    if (sp.mode === "allow" && sp.client) {
      var line = el(doc, "div", "actions");
      line.setAttribute("data-banner", "allowance");
      line.appendChild(el(doc, "span", "note", "Agent allowance: " + sp.client.client_name + ", " + sp.remaining + " of " + sp.session_total + " CU left"));
      line.appendChild(
        button("End", false, "end-allowance", function () {
          o.settings.end("ended by you");
        })
      );
      box.appendChild(line);
    }
    for (var k = 0; k < list.length; k++) {
      var c = list[k];
      if (c === spend) {
        if (c.waiting > 0) {
          box.appendChild(
            button("Decline all from " + c.client_name, false, "decline-all", (function (s) {
              return function () {
                act(o.approvals.declineAll(s));
              };
            })(c.session))
          );
        }
        continue;
      }
      var n = cardNode(c);
      if (c.waiting > 0) {
        n.appendChild(
          button("Decline all from " + c.client_name, false, "decline-all", (function (s) {
            return function () {
              act(o.approvals.declineAll(s));
            };
          })(c.session))
        );
      }
      box.appendChild(n);
    }
    if (box.style) box.style.display = box.children && box.children.length ? "block" : "none";
  }

  o.approvals.onChange(render);
  o.settings.onChange(render);
  render();
  return { render: render };
}

module.exports = { createAgentCards: createAgentCards, cuOf: cuOf };
