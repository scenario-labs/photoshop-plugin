"use strict";
// Settings > Agents > Connect a client (SPEC 7.4, wireframe 14): one row
// per client with the shortest path that works from the panel. Commands pin
// the exact helper version and pass the pairing token in an environment
// variable, never as an argument; the setup command writes the token file
// and registers the server without the token, so no client config the
// plugin hands out holds the token. Cursor takes the setup command too: its
// install link would put the token in Cursor's own config file (M6). Copied
// text that holds the token is cleared from the clipboard after 60 s.
// Rendered into #connect-client.

var PKG = "@scenario-labs/photoshop-mcp";
var SERVER = "scenario-photoshop";
var RELEASES = "https://github.com/scenario-labs/photoshop-plugin/releases/tag/v";

var CLIENTS = [
  { id: "claude-code", name: "Claude Code", match: /claude[- ]?code/i, button: "Copy command" },
  { id: "codex", name: "Codex", match: /codex/i, button: "Copy command" },
  { id: "cursor", name: "Cursor", match: /cursor/i, button: "Copy command" },
  { id: "claude-desktop", name: "Claude Desktop", match: /claude[- ]?(ai|desktop)/i, button: "Get the extension" }
];

function setupCommand(version, client, token, windows) {
  var run = "npx -y " + PKG + "@" + version + " setup " + client;
  if (windows) return "$env:SCENARIO_PHOTOSHOP_TOKEN='" + token + "'; " + run + "; Remove-Item Env:SCENARIO_PHOTOSHOP_TOKEN";
  return "SCENARIO_PHOTOSHOP_TOKEN=" + token + " " + run;
}

// The server entry for other clients: no token. The helper reads the token
// file any setup command writes.
function serverEntry(version) {
  return { command: "npx", args: ["-y", PKG + "@" + version] };
}

function jsonConfig(version) {
  var servers = {};
  servers[SERVER] = serverEntry(version);
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

function tomlConfig(version) {
  return ["[mcp_servers." + SERVER + "]", 'command = "npx"', 'args = ["-y", "' + PKG + "@" + version + '"]', ""].join("\n");
}

function el(doc, tag, cls, text) {
  var e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function clear(node) {
  while (node.children && node.children.length) node.removeChild(node.children[0]);
}

// o: { version, token() -> string | null, copySecret(text) (clears the
//      clipboard after 60 s), copyText(text), openExternal(url),
//      clients() -> [{client_name, connected_at}], windows (bool), log }
function createConnectClient(doc, o) {
  if (!doc || typeof doc.getElementById !== "function") return null;
  var box = doc.getElementById("connect-client");
  if (!box) return null;
  var open = false;
  var message = "";
  var log = o.log || function () {};

  function done(text) {
    message = text;
    render();
  }

  function failed(e) {
    message = "Could not copy: " + ((e && e.message) || e) + ".";
    render();
  }

  function copy(text, after, secret) {
    Promise.resolve()
      .then(function () {
        return secret ? o.copySecret(text) : o.copyText(text);
      })
      .then(function () {
        done(after);
      }, failed);
  }

  function needToken() {
    var t = o.token();
    if (!t) throw new Error("no pairing token yet");
    return t;
  }

  function action(label, id, fn) {
    var b = el(doc, "sp-action-button", null, label);
    b.setAttribute("data-act", id);
    b.addEventListener("click", function () {
      try {
        fn();
      } catch (e) {
        failed(e);
      }
    });
    return b;
  }

  function status(c) {
    var list = o.clients() || [];
    for (var i = 0; i < list.length; i++) if (c.match.test(String(list[i].client_name || ""))) return "Connected";
    return "Not connected";
  }

  var COPIED = function (name) {
    return "Copied. Paste it in a terminal, then restart " + name + ". The row turns to Connected on the first call. The clipboard is cleared in 60 s.";
  };

  function render() {
    clear(box);
    if (box.style) box.style.display = open ? "block" : "none";
    if (!open) return;
    var v = o.version;
    box.appendChild(el(doc, "div", "sub-title", "Connect a client"));
    box.appendChild(el(doc, "div", "note", "Agents reach Photoshop through the " + SERVER + " helper " + v + ", which runs on this computer."));
    for (var i = 0; i < CLIENTS.length; i++) {
      var c = CLIENTS[i];
      var row = el(doc, "div", "client-row");
      row.setAttribute("data-client", c.id);
      var head = el(doc, "div", "kv");
      head.appendChild(el(doc, "span", "text", c.name));
      head.appendChild(el(doc, "span", "note", status(c)));
      row.appendChild(head);
      var acts = el(doc, "div", "actions");
      if (c.id !== "claude-desktop") {
        acts.appendChild(
          action(c.button, "copy-" + c.id, (function (cl) {
            return function () {
              copy(setupCommand(v, cl.id, needToken(), o.windows), COPIED(cl.name), true);
            };
          })(c))
        );
      } else {
        acts.appendChild(
          action(c.button, "get-extension", function () {
            Promise.resolve(o.openExternal(RELEASES + v)).then(function () {
              done("Download scenario-photoshop-" + v + ".mcpb and double-click it. Claude Desktop asks for the pairing token: use Copy token.");
            }, failed);
          })
        );
        acts.appendChild(
          action("Copy token", "copy-token", function () {
            copy(needToken(), "Token copied. The clipboard is cleared in 60 s.", true);
          })
        );
        acts.appendChild(
          action("Copy setup command", "setup-claude-desktop", function () {
            copy(setupCommand(v, "claude-desktop", needToken(), o.windows), COPIED("Claude Desktop"), true);
          })
        );
      }
      row.appendChild(acts);
      box.appendChild(row);
    }
    var other = el(doc, "div", "client-row");
    other.setAttribute("data-client", "other");
    other.appendChild(el(doc, "div", "text", "Other clients"));
    var oa = el(doc, "div", "actions");
    oa.appendChild(
      action("Copy JSON", "copy-json", function () {
        copy(jsonConfig(v), "Copied. It holds no token.", false);
      })
    );
    oa.appendChild(
      action("Copy TOML", "copy-toml", function () {
        copy(tomlConfig(v), "Copied. It holds no token.", false);
      })
    );
    other.appendChild(oa);
    other.appendChild(el(doc, "div", "note", "The entry holds no token: the helper reads the token file that any setup command above writes, so run one of them once. Add the entry to your user-level client config."));
    var sk = el(doc, "div", "actions");
    sk.appendChild(
      action("Copy skills command", "copy-skills", function () {
        copy("npx skills add scenario-labs/skills", "Copied.", false);
      })
    );
    other.appendChild(sk);
    box.appendChild(other);
    box.appendChild(el(doc, "div", "note", "Commands need Node 20 or later; the Claude Desktop extension does not. The token grants access to this plugin's agent link only."));
    if (message) {
      var m = el(doc, "div", "note", message);
      m.setAttribute("data-message", "");
      box.appendChild(m);
    }
    var close = action("Close", "close-connect", function () {
      open = false;
      message = "";
      render();
    });
    box.appendChild(close);
  }

  render();
  log("connect a client ready");
  return {
    open: function () {
      open = true;
      render();
    },
    render: render,
    isOpen: function () {
      return open;
    }
  };
}

module.exports = { createConnectClient: createConnectClient, setupCommand: setupCommand, jsonConfig: jsonConfig, tomlConfig: tomlConfig, CLIENTS: CLIENTS };
