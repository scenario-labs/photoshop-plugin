"use strict";
// What the panel says, as plain data. No DOM here, so it is tested under Node.

var LANES = [
  { id: "image", label: "Image", purpose: "Make a new image from a prompt, with references." },
  { id: "edit", label: "Edit", purpose: "Change what is inside a selection or a layer." },
  { id: "enhance", label: "Enhance", purpose: "Upscale, expand the canvas, remove a background." },
  { id: "trained", label: "Trained", purpose: "Use the models trained in your Scenario project." },
  { id: "library", label: "Library", purpose: "Browse and place your project's images." }
];

// SPEC 2.6: a client that has not sent its name yet shows as this.
var DEFAULT_NAME = require("../../../shared/protocol.json").sessions.default_name;

var NOT_BUILT = "Not available in this early build. This build signs in to Scenario, browses models, shows prices and links agent clients to Photoshop; generation comes next.";

function clientNames(clients) {
  var names = [];
  for (var i = 0; i < clients.length; i++) {
    var n = clients[i] && clients[i].client_name;
    names.push(n ? String(n) : DEFAULT_NAME);
  }
  return names;
}

// link: the state from bridge/link.js. Returns { dot, headline, detail }.
// dot: "on" (an agent can work), "off" (nothing connected), "warn" (needs the person).
function describeLink(link) {
  var phase = link ? link.phase : "starting";
  var detail = (link && link.detail) || "";
  switch (phase) {
    case "connected": {
      var names = clientNames(link.clients || []);
      return {
        dot: "on",
        headline: names.length ? "Connected: " + names.join(", ") : "Helper connected",
        detail: names.length ? "Agents can read the open documents' titles." : "The helper is running; its agent client has not started a session yet."
      };
    }
    case "handshake":
      return { dot: "off", headline: "Connecting", detail: detail };
    case "waiting":
    case "starting":
      return { dot: "off", headline: "No agent connected", detail: detail };
    case "pairing_failed":
      return { dot: "warn", headline: "A client tried to connect with an old pairing token.", detail: detail };
    case "not_helper":
      return { dot: "warn", headline: "The program on port 9890 is not the Scenario helper.", detail: detail };
    case "version_mismatch":
      return { dot: "warn", headline: "Update needed", detail: detail };
    case "plugin_busy":
      return { dot: "warn", headline: "Agents are connected to another Photoshop.", detail: detail };
    case "permission_denied":
      return { dot: "warn", headline: "Connection refused by Photoshop", detail: detail };
    case "no_token":
      return { dot: "warn", headline: "No pairing token", detail: detail };
    case "stopped":
      return { dot: "off", headline: "Agent link stopped", detail: detail };
    default:
      return { dot: "off", headline: phase, detail: detail };
  }
}

function maskToken(token, shown) {
  if (!token) return "Not created yet";
  if (shown) return token;
  return "Ending in " + token.slice(-4);
}

module.exports = { LANES: LANES, NOT_BUILT: NOT_BUILT, describeLink: describeLink, maskToken: maskToken };
