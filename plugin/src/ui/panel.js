"use strict";
// The panel shell: icons, lane tabs (their bodies are ui/lanes.js), the
// header's agent dot, and Settings > Connect an AI agent (link status and the
// pairing token, the technical words under Details). Uses Spectrum UXP
// widgets from index.html; this file only binds them. No overlays, no
// animation.

var view = require("./view.js");
var icons = require("./icons.js");

// doc: the panel's document. actions: { copyToken(), resetToken(), token(),
// onLane(id) (optional: a lane tab was chosen) }.
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

  function selectLane(id) {
    var lane = null;
    for (var i = 0; i < view.LANES.length; i++) if (view.LANES[i].id === id) lane = view.LANES[i];
    if (!lane) return;
    var buttons = doc.querySelectorAll ? doc.querySelectorAll("[data-lane]") : [];
    for (var b = 0; b < buttons.length; b++) {
      var on = buttons[b].getAttribute("data-lane") === id;
      if (on) buttons[b].setAttribute("selected", "");
      else buttons[b].removeAttribute("selected");
      // The chosen tab keeps its label at narrow widths (styles.css).
      buttons[b].className = on ? "tab on" : "tab";
    }
    // The lane bodies (ui/lanes.js) fill the rest; without them, a placeholder.
    if (actions.onLane) actions.onLane(id);
    else setText("lane-note", view.NOT_BUILT);
  }

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
    setTitle("agent-hit", d.headline);
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

  var laneButtons = doc.querySelectorAll ? doc.querySelectorAll("[data-lane]") : [];
  for (var i = 0; i < laneButtons.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        selectLane(btn.getAttribute("data-lane"));
      });
    })(laneButtons[i]);
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
  // Each tab's tooltip says what the lane is for (icons only at narrow widths).
  for (var t = 0; t < laneButtons.length; t++) {
    for (var l = 0; l < view.LANES.length; l++) if (view.LANES[l].id === laneButtons[t].getAttribute("data-lane")) laneButtons[t].setAttribute("title", view.LANES[l].purpose);
  }
  renderDetails();
  selectLane("image");
  renderToken();

  return {
    renderLink: renderLink,
    renderToken: renderToken,
    selectLane: selectLane,
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
