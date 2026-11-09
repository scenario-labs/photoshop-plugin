"use strict";
// The panel shell: icons, the header's agent status (icon, dot and the
// agent's name, FLOWS v2), and Settings > Connect an AI agent (link status
// and the pairing token, the technical words under Details). The creation
// view itself is ui/create-view.js. No animation.

var view = require("./view.js");
var icons = require("./icons.js");
var clipMod = require("../util/clip.js");

// doc: the panel's document. actions: { copyToken(), resetToken(), token() }.
function createPanel(doc, actions, version) {
  if (!doc || typeof doc.getElementById !== "function") return null;
  var byId = function (id) {
    return doc.getElementById(id);
  };
  var tokenShown = false;
  var resetArmed = false;
  var resetTimer = null;
  var lastLink = null;
  var detailsOpen = false;

  function setText(id, text) {
    var el = byId(id);
    if (el) el.textContent = text || "";
  }
  function setTitle(id, text) {
    var el = byId(id);
    if (el && el.setAttribute) el.setAttribute("title", text || "");
  }

  icons.fill(doc);

  function renderToken() {
    setText("token-value", view.maskToken(actions.token(), tokenShown));
    setText("token-show", tokenShown ? "Hide" : "Show");
  }

  function renderLink(link) {
    lastLink = link;
    var d = view.describeLink(link);
    var dot = byId("link-dot");
    if (dot) dot.className = "dot " + d.dot;
    var headerDot = byId("agent-dot");
    if (headerDot) headerDot.className = "dot " + d.dot;
    // The header names the first connected agent (FLOWS v2: "Claude ●").
    var name = d.names && d.names.length ? d.names[0] : "";
    setText("agent-name", clipMod.clip(name, 14));
    setTitle("agent-hit", name ? d.names.join(", ") + (d.names.length > 1 ? " are" : " is") + " connected" : d.headline);
    setText("link-headline", d.headline);
    setText("link-detail", d.detail);
  }

  function note(text) {
    setText("token-note", text);
  }

  function renderDetails() {
    var el = byId("agents-details");
    if (el && el.style) el.style.display = detailsOpen ? "block" : "none";
    icons.set(byId("agents-details-icon"), detailsOpen ? "chevron-down" : "chevron-right");
  }

  function on(id, fn) {
    var el = byId(id);
    if (el) el.addEventListener("click", fn);
  }

  on("agents-details-toggle", function () {
    detailsOpen = !detailsOpen;
    renderDetails();
  });
  on("token-show", function () {
    tokenShown = !tokenShown;
    renderToken();
  });
  on("token-copy", function () {
    Promise.resolve()
      .then(function () {
        return actions.copyToken();
      })
      .then(
        function () {
          note(view.AGENTS.copied);
        },
        function (e) {
          note("Could not copy: " + ((e && e.message) || e) + ". Open Details, use Show and copy it by hand.");
        }
      );
  });
  on("token-reset", function () {
    if (!resetArmed) {
      resetArmed = true;
      setText("token-reset", "Confirm reset");
      note(view.AGENTS.reset_confirm);
      resetTimer = setTimeout(function () {
        resetArmed = false;
        setText("token-reset", "Reset");
        note("");
      }, 5000);
      return;
    }
    resetArmed = false;
    if (resetTimer) clearTimeout(resetTimer);
    setText("token-reset", "Reset");
    Promise.resolve()
      .then(function () {
        return actions.resetToken();
      })
      .then(
        function () {
          tokenShown = false;
          renderToken();
          note(view.AGENTS.reset_done);
        },
        function (e) {
          note("Reset failed: " + ((e && e.message) || e));
        }
      );
  });

  setText("agents-intro", view.AGENTS.intro);
  setText("agents-pair", view.AGENTS.pair);
  setText("agents-tech", view.AGENTS.tech);
  setText("version", "Scenario for Photoshop " + version);
  renderDetails();
  renderToken();

  return {
    renderLink: renderLink,
    renderToken: renderToken,
    // The last link state described (the agent popover's words).
    link: function () {
      return view.describeLink(lastLink);
    },
    refresh: function () {
      renderToken();
      if (lastLink) renderLink(lastLink);
    },
    openDetails: function (open) {
      detailsOpen = open !== false;
      renderDetails();
    }
  };
}

module.exports = { createPanel: createPanel };
