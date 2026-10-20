"use strict";
// What the panel says, as plain data. No DOM here, so it is tested under Node.
// Main views carry short words for a person; how the agent link works
// (helper, port, token) is said only under Settings > Connect an AI agent >
// Details.

// SPEC 2.6: a client that has not sent its name yet shows as this.
var DEFAULT_NAME = require("../../../shared/protocol.json").sessions.default_name;

var AGENTS = {
  intro: "Let an AI agent such as Claude Code, Codex or Cursor use Scenario in this Photoshop.",
  pair: "Paste this token when your agent's setup asks for it.",
  tech: "Technical: agents run a small local program, scenario-photoshop, which talks to this panel on this computer only (localhost, port 9890). The token proves it is yours.",
  copied: "Copied. Paste it into your agent's setup. The clipboard clears in 60 s.",
  reset_confirm: "Resetting disconnects every agent that uses this token. Click again to confirm.",
  reset_done: "New token made. Agents need it in their setup before they can connect again."
};

function clientNames(clients) {
  var names = [];
  for (var i = 0; i < clients.length; i++) {
    var n = clients[i] && clients[i].client_name;
    names.push(n ? String(n) : DEFAULT_NAME);
  }
  return names;
}

// link: the state from bridge/link.js. Returns { dot, headline, detail }.
// dot: "on" (an agent can work), "off" (nothing connected), "warn" (needs the
// person). The headline is the header dot's tooltip and the status line in
// Settings; the detail (link.js's own words, which name the helper and the
// port) goes under Details.
function describeLink(link) {
  var phase = link ? link.phase : "starting";
  var detail = (link && link.detail) || "";
  switch (phase) {
    case "connected": {
      var names = clientNames(link.clients || []);
      return {
        dot: "on",
        names: names,
        headline: names.length ? "Agent connected: " + names.join(", ") : "Agent link ready",
        detail: names.length ? "Agents can read the open documents' titles." : "The agent link is running; its agent has not started a session yet."
      };
    }
    case "handshake":
      return { dot: "off", headline: "Connecting an agent", detail: detail };
    case "waiting":
    case "starting":
      return { dot: "off", headline: "No agent connected", detail: detail };
    case "pairing_failed":
      return { dot: "warn", headline: "An agent tried an old pairing token", detail: detail };
    case "not_helper":
      return { dot: "warn", headline: "Another program blocks the agent link", detail: detail };
    case "version_mismatch":
      return { dot: "warn", headline: "The agent link needs an update", detail: detail };
    case "plugin_busy":
      return { dot: "warn", headline: "Agents are connected to another Photoshop", detail: detail };
    case "permission_denied":
      return { dot: "warn", headline: "Photoshop refused the agent link", detail: detail };
    case "no_token":
      return { dot: "warn", headline: "No pairing token yet", detail: detail };
    case "stopped":
      return { dot: "off", headline: "Agent link stopped", detail: detail };
    default:
      return { dot: "off", headline: "No agent connected", detail: detail || String(phase) };
  }
}

function maskToken(token, shown) {
  if (!token) return "Not created yet";
  if (shown) return token;
  return "...." + token.slice(-4);
}

module.exports = { AGENTS: AGENTS, describeLink: describeLink, maskToken: maskToken };
