"use strict";
// The plugin's side of the helper link (SPEC 2.6). UXP cannot listen on a
// port, so the plugin dials out to the helper that owns port 9890, proves it
// holds the pairing token, checks that the helper holds it too, and then
// answers tool calls over a channel where every message carries a MAC.
//
// Everything that touches the host is injected (WebSocket class, timers,
// random bytes, token, handlers), so the same code runs in UXP and under Node.

var protocol = require("./protocol.js");
var schema = require("../../../shared/schema-check.js");
var b64 = require("../util/base64url.js");

var P = protocol.P;
var CLOSE = P.close_codes;

// Phases the panel can show. "connected" is the only one where agents work.
var PHASES = [
  "starting",
  "no_token",
  "permission_denied",
  "waiting",
  "handshake",
  "connected",
  "pairing_failed",
  "not_helper",
  "version_mismatch",
  "plugin_busy",
  "stopped"
];

function errText(e) {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  return String(e.message || e.reason || e.type || e);
}

// Tool errors are one line, "Type: message" (MCP.md section 8).
function oneLine(text) {
  return String(text).replace(/\s*[\r\n]+\s*/g, " ");
}

function formatError(err) {
  if (err && typeof err.type === "string" && /^[A-Z][A-Za-z]+$/.test(err.type) && typeof err.message === "string") return err.type + ": " + oneLine(err.message);
  return "Internal: " + oneLine(errText(err));
}

// SPEC 2.6 item 4: what the panel says for the two proof failures.
// Wording from SPEC 3.13.
var OLD_TOKEN_TEXT = "Copy its setup again.";
var BUSY_TEXT = "Quit the other Photoshop to use agents here; this one links as soon as it can.";
var SESSION_ENDED = "NotConnected: this client's session ended; call again.";
var NOT_HELPER_TEXT = "The program on port " + P.port + " is not the Scenario helper.";

function createLink(opts) {
  var WS = opts.WebSocket;
  var urls = opts.urls || P.plugin_urls;
  var limits = {};
  var k;
  for (k in P.limits) limits[k] = P.limits[k];
  if (opts.limits) for (k in opts.limits) limits[k] = opts.limits[k];
  var setT = (opts.timers && opts.timers.setTimeout) || setTimeout;
  var clearT = (opts.timers && opts.timers.clearTimeout) || clearTimeout;
  var now = (opts.timers && opts.timers.now) || function () { return Date.now(); };
  var log = opts.log || function () {};
  var handlers = opts.handlers || {};

  var state = { phase: "starting", detail: null, url: null, clients: [], helper_version: null, since: now() };
  var conn = null;
  var dialTimer = null;
  var running = false;

  function snapshot() {
    return {
      phase: state.phase,
      detail: state.detail,
      url: state.url,
      clients: state.clients.slice(),
      helper_version: state.helper_version,
      since: state.since
    };
  }

  // SPEC 2.6, Client sessions: a session ends when it leaves the list or the
  // link closes. opts.onSessionsEnded(ids, why) ends what was tied to it.
  function endSessions(ids, why) {
    if (!ids.length || !opts.onSessionsEnded) return;
    try {
      opts.onSessionsEnded(ids, why);
    } catch (e) {
      log("ending sessions failed: " + errText(e));
    }
  }

  function setClients(list) {
    var next = {};
    for (var i = 0; i < list.length; i++) next[list[i].session] = true;
    var ended = [];
    for (var j = 0; j < state.clients.length; j++) if (!next[state.clients[j].session]) ended.push(state.clients[j].session);
    state.clients = list.slice();
    endSessions(ended, "left");
  }

  function findClient(session) {
    for (var i = 0; i < state.clients.length; i++) if (state.clients[i].session === session) return state.clients[i];
    return null;
  }

  function setPhase(phase, detail, url) {
    var changed = phase !== state.phase || detail !== state.detail;
    state.phase = phase;
    state.detail = detail || null;
    if (url !== undefined) state.url = url;
    if (phase !== "connected") {
      var ended = [];
      for (var i = 0; i < state.clients.length; i++) ended.push(state.clients[i].session);
      state.clients = [];
      state.helper_version = null;
      endSessions(ended, "link closed");
    }
    if (changed) {
      state.since = now();
      log("link " + phase + (detail ? ": " + detail : ""));
    }
    if (opts.onState) opts.onState(snapshot());
  }

  function scheduleDial(ms) {
    if (dialTimer) clearT(dialTimer);
    dialTimer = null;
    if (!running) return;
    dialTimer = setT(dial, ms);
  }

  function clearTimer(c) {
    if (c.timer) clearT(c.timer);
    c.timer = null;
  }

  function armTimer(c, ms, phase, detail) {
    clearTimer(c);
    c.timer = setT(function () {
      fail(c, phase, detail, CLOSE.handshake_timeout);
    }, ms);
  }

  function finish(c) {
    c.closed = true;
    clearTimer(c);
    if (c.pingTimer) clearT(c.pingTimer);
    c.pingTimer = null;
    if (conn === c) conn = null;
  }

  function closeSocket(c, code, reason) {
    try {
      c.sock.close(code, reason);
    } catch (e) {
      try {
        c.sock.close();
      } catch (e2) {
        // already closed
      }
    }
  }

  function fail(c, phase, detail, code) {
    if (c.closed) return;
    finish(c);
    closeSocket(c, code || CLOSE.normal, phase);
    setPhase(phase, detail);
    scheduleDial(limits.dial_interval_ms);
  }

  function sendRaw(c, text) {
    try {
      c.sock.send(text);
      return true;
    } catch (e) {
      fail(c, "waiting", "Sending to the helper failed: " + errText(e), CLOSE.normal);
      return false;
    }
  }

  function sendSigned(c, message) {
    return sendRaw(c, c.channel.seal(message));
  }

  function dial() {
    dialTimer = null;
    if (!running || conn) return;
    var token = protocol.parseToken(opts.getToken());
    if (!token) {
      setPhase("no_token", "The pairing token is missing or damaged. Reset it in the panel.");
      scheduleDial(limits.dial_interval_ms);
      return;
    }
    var sock = null;
    var url = null;
    var refusals = [];
    for (var i = 0; i < urls.length && !sock; i++) {
      try {
        sock = new WS(urls[i]);
        url = urls[i];
      } catch (e) {
        refusals.push(urls[i] + ": " + errText(e));
      }
    }
    if (!sock) {
      setPhase("permission_denied", "Photoshop refused the connection. " + refusals.join("; "));
      scheduleDial(limits.dial_interval_ms);
      return;
    }
    var c = {
      sock: sock,
      url: url,
      token: token,
      stage: "challenge",
      opened: false,
      closed: false,
      nonceOwner: null,
      nonceClient: null,
      channel: null,
      timer: null,
      pingTimer: null,
      lastHeard: now(),
      error: null
    };
    conn = c;
    sock.onopen = function () {
      if (c.closed) return;
      c.opened = true;
      c.lastHeard = now();
      // Keep a failure on screen while the next attempt runs, so it does not flicker.
      if (state.phase === "waiting" || state.phase === "starting" || state.phase === "permission_denied") {
        setPhase("handshake", "Checking the program on port " + P.port + ".", url);
      }
      armTimer(c, limits.handshake_ms, "not_helper", "The program on port " + P.port + " sent no pairing challenge. It is not the Scenario helper.");
    };
    sock.onmessage = function (ev) {
      onMessage(c, ev ? ev.data : undefined);
    };
    sock.onerror = function (ev) {
      c.error = errText(ev);
    };
    sock.onclose = function (ev) {
      onClose(c, ev ? ev.code : 0, ev ? ev.reason : "");
    };
  }

  function onClose(c, code, reason) {
    if (c.closed) return;
    var stage = c.stage;
    finish(c);
    if (stage === "ready") {
      setPhase("waiting", "The helper closed the link" + (code === CLOSE.shutting_down ? " (its agent client quit)." : "."));
      scheduleDial(limits.redial_after_drop_ms);
      return;
    }
    if (code === CLOSE.pairing_failed) {
      setPhase("pairing_failed", OLD_TOKEN_TEXT);
    } else if (code === CLOSE.version_mismatch) {
      setPhase("version_mismatch", "The helper and the plugin speak different protocol versions. " + (reason || ""));
    } else if (code === CLOSE.plugin_busy) {
      setPhase("plugin_busy", BUSY_TEXT);
    } else if (code === CLOSE.shutting_down) {
      setPhase("waiting", "The helper is shutting down.");
    } else if (!c.opened) {
      setPhase("waiting", "No agent client is running. Agents connect through the scenario-photoshop helper on port " + P.port + "." + (c.error && c.error !== "error" ? " (" + c.error + ")" : ""));
    } else {
      setPhase("not_helper", "The program on port " + P.port + " is not the Scenario helper.");
    }
    scheduleDial(limits.dial_interval_ms);
  }

  function onMessage(c, data) {
    if (c.closed || c !== conn) return;
    c.lastHeard = now();
    if (typeof data !== "string") {
      fail(c, "not_helper", "The program on port " + P.port + " sent binary data. It is not the Scenario helper.", CLOSE.bad_message);
      return;
    }
    if (c.stage === "challenge") {
      var ch = protocol.readHandshake("challenge", data);
      if (!ch || !protocol.isNonce(ch.nonce_o)) {
        if (ch === null) {
          var raw = null;
          try {
            raw = JSON.parse(data);
          } catch (e) {
            raw = null;
          }
          if (raw && raw.t === "challenge" && typeof raw.protocol === "number" && raw.protocol !== P.protocol) {
            fail(c, "version_mismatch", "Helper protocol " + raw.protocol + ", plugin protocol " + P.protocol + ".", CLOSE.version_mismatch);
            return;
          }
        }
        fail(c, "not_helper", "The program on port " + P.port + " is not the Scenario helper.", CLOSE.bad_message);
        return;
      }
      if (ch.protocol !== P.protocol) {
        fail(c, "version_mismatch", "Helper protocol " + ch.protocol + ", plugin protocol " + P.protocol + ".", CLOSE.version_mismatch);
        return;
      }
      c.nonceOwner = ch.nonce_o;
      c.nonceClient = b64.encode(opts.random.bytes(P.nonce_bytes));
      var proof = protocol.connectProof(c.token, P.labels.plugin, c.nonceOwner, c.nonceClient);
      c.stage = "owner_proof";
      armTimer(c, limits.handshake_ms, "not_helper", "The program on port " + P.port + " did not prove the pairing token. It is not the Scenario helper.");
      sendRaw(c, JSON.stringify({ t: "proof", role: P.labels.plugin, nonce_c: c.nonceClient, proof: proof }));
      return;
    }
    if (c.stage === "owner_proof") {
      if (protocol.readHandshake("pairing_failed", data)) {
        fail(c, "pairing_failed", OLD_TOKEN_TEXT, CLOSE.normal);
        return;
      }
      var op = protocol.readHandshake("owner_proof", data);
      var expected = protocol.ownerProof(c.token, c.nonceOwner, c.nonceClient);
      if (!op || !protocol.proofMatches(expected, op.proof_o)) {
        fail(c, "not_helper", NOT_HELPER_TEXT + " It could not prove the pairing token.", CLOSE.pairing_failed);
        return;
      }
      c.channel = new protocol.Channel(protocol.sessionKey(c.token, c.nonceOwner, c.nonceClient), P.labels.client_to_owner, P.labels.owner_to_client);
      c.stage = "hello";
      armTimer(c, limits.handshake_ms, "not_helper", "The helper did not say hello.");
      return;
    }
    var msg;
    try {
      msg = c.channel.open(data);
    } catch (e) {
      fail(c, "waiting", "A message from the helper failed its check (" + e.message + "). Reconnecting.", CLOSE.bad_message);
      return;
    }
    if (c.stage === "hello") {
      if (msg.t !== "hello" || schema.validate(P.messages.hello, msg, P).length) {
        fail(c, "not_helper", "The helper sent an unexpected first message.", CLOSE.bad_message);
        return;
      }
      clearTimer(c);
      c.stage = "ready";
      state.helper_version = msg.helper_version;
      var info = opts.info ? opts.info() : {};
      sendSigned(c, {
        t: "welcome",
        plugin_version: info.plugin_version || "0.0.0",
        photoshop_version: info.photoshop_version || null,
        os: info.os || null,
        catalog_hash: opts.catalogHash || "",
        switches: opts.switches ? opts.switches() : {}
      });
      if (c.closed) return;
      state.helper_version = msg.helper_version;
      setPhase("connected", null, c.url);
      setClients(msg.clients || []);
      if (opts.onState) opts.onState(snapshot());
      startPing(c);
      return;
    }
    if (msg.t === "call") {
      handleCall(c, msg);
    } else if (msg.t === "clients") {
      if (schema.validate(P.messages.clients, msg, P).length) {
        fail(c, "waiting", "The helper sent a malformed client list. Reconnecting.", CLOSE.bad_message);
        return;
      }
      setClients(msg.clients);
      if (opts.onState) opts.onState(snapshot());
    } else if (msg.t === "ping") {
      sendSigned(c, { t: "pong" });
    }
    // pong and unknown message types: nothing to do (lastHeard is updated above)
  }

  function startPing(c) {
    function tick() {
      if (c.closed) return;
      if (now() - c.lastHeard > limits.idle_ms) {
        fail(c, "waiting", "The helper stopped answering. Reconnecting.", CLOSE.idle);
        return;
      }
      if (!sendSigned(c, { t: "ping" })) return;
      c.pingTimer = setT(tick, limits.ping_ms);
    }
    c.pingTimer = setT(tick, limits.ping_ms);
  }

  function reply(c, id, ok, payload) {
    if (c.closed || c !== conn || c.stage !== "ready") return;
    if (ok) sendSigned(c, { t: "result", id: id, ok: true, result: payload === undefined ? null : payload });
    else sendSigned(c, { t: "result", id: id, ok: false, error: payload });
  }

  function handleCall(c, msg) {
    if (schema.validate(P.messages.call, msg, P).length) {
      if (typeof msg.id === "number") reply(c, msg.id, false, "InvalidParameter: malformed call");
      return;
    }
    // Names come from the clients list, never from a call; unlisted sessions are refused.
    var client = msg.session ? findClient(msg.session) : null;
    if (!client) {
      reply(c, msg.id, false, SESSION_ENDED);
      return;
    }
    var handler = Object.prototype.hasOwnProperty.call(handlers, msg.tool) ? handlers[msg.tool] : null;
    if (!handler) {
      var info = opts.info ? opts.info() : {};
      reply(c, msg.id, false, "VersionMismatch: the plugin " + (info.plugin_version || "") + " does not offer " + msg.tool + " (helper " + (state.helper_version || "unknown") + ").");
      return;
    }
    var ctx = { session: client.session, client_name: client.client_name, connected_at: client.connected_at };
    Promise.resolve()
      .then(function () {
        return handler(msg.args || {}, ctx);
      })
      .then(
        function (result) {
          reply(c, msg.id, true, result);
        },
        function (err) {
          reply(c, msg.id, false, formatError(err));
        }
      );
  }

  return {
    start: function () {
      if (running) return;
      running = true;
      setPhase("waiting", "Looking for an agent client.");
      dial();
    },
    stop: function () {
      running = false;
      if (dialTimer) clearT(dialTimer);
      dialTimer = null;
      if (conn) {
        var c = conn;
        finish(c);
        closeSocket(c, CLOSE.normal, "stopped");
      }
      setPhase("stopped", null);
    },
    // After a token reset: drop the link and dial again with the new token.
    restart: function (detail) {
      if (conn) {
        var c = conn;
        finish(c);
        closeSocket(c, CLOSE.normal, "token reset");
      }
      setPhase("waiting", detail || "Reconnecting.");
      scheduleDial(0);
    },
    state: snapshot
  };
}

module.exports = { createLink: createLink, PHASES: PHASES, formatError: formatError };
