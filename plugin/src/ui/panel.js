"use strict";
// The panel shell: header, lane tabs (placeholders in this build), and the
// agent link status with the pairing token. Uses Spectrum UXP widgets from
// index.html; this file only binds them. No overlays, no animation.

var view = require("./view.js");

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

  function setText(id, text) {
    var el = byId(id);
    if (el) el.textContent = text || "";
  }

  function selectLane(id) {
    var lane = null;
    for (var i = 0; i < view.LANES.length; i++) if (view.LANES[i].id === id) lane = view.LANES[i];
    if (!lane) return;
    var buttons = doc.querySelectorAll ? doc.querySelectorAll("[data-lane]") : [];
    for (var b = 0; b < buttons.length; b++) {
      if (buttons[b].getAttribute("data-lane") === id) buttons[b].setAttribute("selected", "");
      else buttons[b].removeAttribute("selected");
    }
    setText("lane-title", lane.label);
    setText("lane-purpose", lane.purpose);
    setText("lane-note", view.NOT_BUILT);
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
    if (headerDot) {
      headerDot.className = "dot " + d.dot;
      headerDot.setAttribute("title", d.headline);
    }
    setText("link-headline", d.headline);
    setText("link-detail", d.detail);
  }

  function note(text) {
    setText("token-note", text);
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
          note("Copied. Paste it into your agent client's config as SCENARIO_PHOTOSHOP_TOKEN.");
        },
        function (e) {
          note("Could not copy: " + ((e && e.message) || e) + ". Use Show and copy it by hand.");
        }
      );
  });
  on("token-reset", function () {
    if (!resetArmed) {
      resetArmed = true;
      setText("token-reset", "Confirm reset");
      note("Resetting disconnects every agent client that uses this token. Click again to confirm.");
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
          note("New token made. Agent clients need it in their config before they can connect.");
        },
        function (e) {
          note("Reset failed: " + ((e && e.message) || e));
        }
      );
  });

  setText("version", "Scenario for Photoshop " + version + " · Generative AI by Scenario");
  selectLane("image");
  renderToken();

  return {
    renderLink: renderLink,
    renderToken: renderToken,
    refresh: function () {
      renderToken();
      if (lastLink) renderLink(lastLink);
    }
  };
}

module.exports = { createPanel: createPanel };
