"use strict";
// The port owner (SPEC 2.6). It holds every loopback address on the port
// (127.0.0.1, and ::1 where IPv6 loopback exists) or none. It accepts one
// plugin link and up to max_peers helper links. Before any byte of the
// protocol it checks Host, Origin and User-Agent; then it speaks first with a
// challenge, checks the proof in constant time, proves the token back, and
// from then on every message carries a MAC.

const http = require("node:http");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { WebSocketServer } = require("ws");
const lc = require("./crypto.js");
const schema = require("../../../shared/schema-check.js");
const { ToolError, asLine } = require("../errors.js");

const P = lc.P;
const CLOSE = P.close_codes;
const NO_IPV6 = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT", "EINVAL"]);
// SPEC 2.6 item 4 and MCP.md section 8.
const PAIRING_FAILED_TEXT =
  "this client's token differs from the plugin's: run the setup command again (Connect a client in the Scenario panel), or update SCENARIO_PHOTOSHOP_TOKEN where this client sets it.";

function listen(server, options) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  });
}

// SPEC 2.6, Client sessions: 128 random bits, never reused by this owner.
function newSessionId(used) {
  for (;;) {
    const id = crypto.randomBytes(P.sessions.id_bytes).toString("base64url");
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

// The name a client gave at its first initialize, cut to 64 UTF-16 units
// without splitting a character.
function clientName(name) {
  if (typeof name !== "string") return null;
  let cut = name.slice(0, P.sessions.name_max_chars);
  const last = cut.charCodeAt(cut.length - 1);
  if (cut.length && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

class Owner extends EventEmitter {
  constructor(opts) {
    super();
    this.port = opts.port;
    this.token = opts.token;
    this.version = opts.version;
    this.hosts = opts.hosts || P.owner_hosts;
    this.limits = { ...P.limits, ...(opts.limits || {}) };
    this.log = opts.log || (() => {});
    this.servers = [];
    this.addresses = [];
    this.wss = null;
    this.plugin = null;
    this.peers = new Set();
    this.pendingHandshakes = 0;
    this.usedSessions = new Set();
    // This helper's own agent client. Peers carry theirs on their connection.
    this.own = { session: newSessionId(this.usedSessions), client_name: null, connected_at: new Date().toISOString(), named: false };
    this.lastPluginFailure = 0;
    this.nextCallId = 0;
    this.ready = false;
    this.closed = false;
    this.allowedHosts = new Set(P.allowed_host_headers.map((h) => `${h}:${this.port}`));
  }

  // Binds every loopback address or none. Resolves { ok } or { ok: false, code, host }.
  async bind() {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.limits.max_message_bytes,
      perMessageDeflate: false,
      clientTracking: false
    });
    const bound = [];
    for (const host of this.hosts) {
      const server = http.createServer((req, res) => {
        res.writeHead(426, { "content-type": "text/plain", connection: "close" });
        res.end("scenario-photoshop: WebSocket only\n");
      });
      server.on("upgrade", (req, socket, head) => this._onUpgrade(req, socket, head));
      server.on("clientError", (_err, socket) => socket.destroy());
      try {
        await listen(server, { host, port: this.port, exclusive: true, ipv6Only: host.includes(":") });
        bound.push(server);
      } catch (err) {
        if (host.includes(":") && NO_IPV6.has(err.code)) {
          this.log(`no IPv6 loopback here (${err.code}); serving ${bound.length ? "IPv4 only" : "nothing"}`);
          continue;
        }
        await Promise.all(bound.map(closeServer));
        this.wss.close();
        this.wss = null;
        return { ok: false, code: err.code || "EUNKNOWN", host };
      }
    }
    if (!bound.length) return { ok: false, code: "EADDRNOTAVAIL", host: this.hosts.join(",") };
    this.servers = bound;
    this.addresses = bound.map((s) => s.address().address);
    this.ready = true;
    return { ok: true };
  }

  _onUpgrade(req, socket, head) {
    const refuse = (status, why) => {
      this.log(`refused a connection (${why})`);
      try {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } catch {
        // socket already gone
      }
      socket.destroy();
    };
    if (!this.ready || this.closed) return refuse("503 Service Unavailable", "not ready");
    if (req.url !== "/") return refuse("404 Not Found", "path");
    const host = typeof req.headers.host === "string" ? req.headers.host.toLowerCase() : "";
    if (!this.allowedHosts.has(host)) return refuse("403 Forbidden", "Host header");
    const origin = req.headers.origin;
    const agent = req.headers["user-agent"] || "";
    let kind;
    if (origin === undefined) kind = P.labels.peer;
    else if (origin === P.plugin_origin && agent.startsWith(P.plugin_user_agent_prefix)) kind = P.labels.plugin;
    else return refuse("403 Forbidden", "Origin");
    // SPEC 12.3, M1: record what the UXP WebSocket sends (never secrets: these are request headers).
    if (kind === P.labels.plugin) this.log(`plugin connection: Host ${host}, Origin ${origin}, User-Agent ${agent.slice(0, 80)}`);
    if (this.pendingHandshakes >= this.limits.max_pending_handshakes) return refuse("503 Service Unavailable", "too many pending handshakes");
    this.wss.handleUpgrade(req, socket, head, (ws) => this._onConnection(ws, kind));
  }

  _onConnection(ws, kind) {
    this.pendingHandshakes += 1;
    const conn = {
      ws,
      kind,
      stage: "proof",
      nonceOwner: lc.nonce(),
      channel: null,
      closed: false,
      counted: true,
      timer: null,
      lastHeard: Date.now()
    };
    const uncount = () => {
      if (conn.counted) {
        conn.counted = false;
        this.pendingHandshakes -= 1;
      }
    };
    conn.close = (code, reason) => {
      if (conn.closed) return;
      conn.closed = true;
      uncount();
      clearTimeout(conn.timer);
      try {
        ws.close(code, reason);
      } catch {
        // already closing
      }
      setTimeout(() => ws.terminate(), 1000).unref();
      this._onClosed(conn);
    };
    conn.timer = setTimeout(() => conn.close(CLOSE.handshake_timeout, "handshake timeout"), this.limits.handshake_ms);
    ws.on("message", (data, isBinary) => this._onMessage(conn, data, isBinary));
    ws.on("close", () => {
      if (!conn.closed) {
        conn.closed = true;
        uncount();
        clearTimeout(conn.timer);
        this._onClosed(conn);
      }
    });
    ws.on("error", () => {});
    ws.send(JSON.stringify({ t: "challenge", protocol: P.protocol, role: P.labels.owner, nonce_o: conn.nonceOwner }));
  }

  _onMessage(conn, data, isBinary) {
    if (conn.closed) return;
    if (isBinary) return conn.close(CLOSE.bad_message, "binary message");
    const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data);
    if (conn.stage === "proof") return this._onProof(conn, bytes.toString("utf8"));
    let msg;
    try {
      msg = conn.channel.open(bytes);
    } catch (e) {
      this.log(`closed a ${conn.kind} link: ${e.message}`);
      return conn.close(CLOSE.bad_message, "bad message");
    }
    conn.lastHeard = Date.now();
    if (conn.kind === P.labels.plugin) this._onPluginMessage(conn, msg);
    else this._onPeerMessage(conn, msg);
  }

  _onProof(conn, text) {
    if (Buffer.byteLength(text, "utf8") > this.limits.max_handshake_message_bytes) {
      return conn.close(CLOSE.bad_message, "handshake message too large");
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return conn.close(CLOSE.bad_message, "not JSON");
    }
    if (!raw || typeof raw !== "object") return conn.close(CLOSE.bad_message, "not a proof");
    const proof = lc.readHandshake("proof", text);
    if (!proof || !lc.isNonce(proof.nonce_c)) return conn.close(CLOSE.bad_message, "malformed proof");
    if (proof.role !== conn.kind) {
      this.log(`a connection declared role ${proof.role} but its headers say ${conn.kind}`);
      return this._rejectProof(conn);
    }
    const expected = lc.connectProof(this.token, proof.role, conn.nonceOwner, proof.nonce_c);
    if (!lc.proofMatches(expected, proof.proof)) {
      this.log(`a ${conn.kind} failed the pairing proof (different pairing token)`);
      if (conn.kind === P.labels.plugin) {
        this.lastPluginFailure = Date.now();
        this.emit("plugin_pairing_failed");
      }
      return this._rejectProof(conn);
    }
    // One plugin link: another Photoshop that passes the proof is refused; the first link stays.
    if (conn.kind === P.labels.plugin && this.plugin && !this.plugin.closed) {
      this.log("refused a second plugin link (plugin_busy): agents stay with the Photoshop already linked");
      return conn.close(CLOSE.plugin_busy, "plugin_busy");
    }
    if (conn.kind === P.labels.peer && this.peers.size >= this.limits.max_peers) {
      this.log(`refused a peer: ${this.limits.max_peers} peers already`);
      return conn.close(CLOSE.too_many_peers, "too many agent clients");
    }
    clearTimeout(conn.timer);
    conn.timer = null;
    conn.stage = "open";
    conn.counted = false;
    this.pendingHandshakes -= 1;
    conn.channel = new lc.Channel(lc.sessionKey(this.token, conn.nonceOwner, proof.nonce_c), P.labels.owner_to_client, P.labels.client_to_owner);
    conn.lastHeard = Date.now();
    conn.ws.send(JSON.stringify({ t: "owner_proof", proof_o: lc.ownerProof(this.token, conn.nonceOwner, proof.nonce_c) }));
    if (conn.kind === P.labels.plugin) this._attachPlugin(conn);
    else this._attachPeer(conn);
  }

  // SPEC 2.6 item 4: say pairing_failed, then close. Unauthenticated by design.
  _rejectProof(conn) {
    try {
      conn.ws.send(JSON.stringify({ t: "pairing_failed" }));
    } catch {
      // the socket is already going
    }
    conn.close(CLOSE.pairing_failed, "pairing failed");
  }

  // The pairing token changed (the token file was rewritten after a reset).
  // Links proved with the old token are closed; new handshakes use the new one.
  setToken(token) {
    if (this.token && Buffer.from(token).equals(Buffer.from(this.token))) return false;
    this.token = token;
    this.lastPluginFailure = 0;
    for (const peer of [...this.peers]) peer.close(CLOSE.pairing_failed, "pairing token changed");
    if (this.plugin) this.plugin.close(CLOSE.pairing_failed, "pairing token changed");
    this.log("pairing token changed; links made with the old token are closed");
    return true;
  }

  _send(conn, message) {
    if (conn.closed) return false;
    try {
      conn.ws.send(conn.channel.seal(message));
      return true;
    } catch {
      conn.close(CLOSE.normal, "send failed");
      return false;
    }
  }

  _watchIdle(conn) {
    const every = Math.max(20, Math.min(5000, Math.floor(this.limits.idle_ms / 4)));
    conn.idleTimer = setInterval(() => {
      if (Date.now() - conn.lastHeard > this.limits.idle_ms) {
        this.log(`closed an idle ${conn.kind} link`);
        conn.close(CLOSE.idle, "idle");
      }
    }, every);
    conn.idleTimer.unref();
  }

  // ---- plugin link ----

  _attachPlugin(conn) {
    conn.pending = new Map();
    conn.info = null;
    conn.welcomeTimer = setTimeout(() => conn.close(CLOSE.handshake_timeout, "no welcome"), this.limits.handshake_ms);
    this.plugin = conn;
    // Session ids last for one plugin link: every client gets a new one now.
    this.own.session = newSessionId(this.usedSessions);
    for (const peer of this.peers.values()) peer.client.session = newSessionId(this.usedSessions);
    this._watchIdle(conn);
    this._send(conn, { t: "hello", protocol: P.protocol, helper_version: this.version, clients: this.clients() });
  }

  _onPluginMessage(conn, msg) {
    if (msg.t === "welcome") {
      if (conn.info || schema.validate(P.messages.welcome, msg, P).length) return conn.close(CLOSE.bad_message, "bad welcome");
      clearTimeout(conn.welcomeTimer);
      conn.info = {
        plugin_version: msg.plugin_version,
        photoshop_version: msg.photoshop_version,
        os: msg.os,
        catalog_hash: msg.catalog_hash,
        switches: msg.switches
      };
      this.lastPluginFailure = 0;
      this.log(`plugin ${msg.plugin_version} linked (Photoshop ${msg.photoshop_version || "unknown"})`);
      this.emit("plugin", conn.info);
      return;
    }
    if (!conn.info) return conn.close(CLOSE.bad_message, "message before welcome");
    if (msg.t === "result") {
      const pending = conn.pending.get(msg.id);
      if (!pending) return;
      conn.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok === true) pending.resolve(msg.result === undefined ? null : msg.result);
      else pending.reject(ToolError.parse(typeof msg.error === "string" ? msg.error : "Internal: the plugin returned an error without a message"));
    } else if (msg.t === "ping") {
      this._send(conn, { t: "pong" });
    }
  }

  pluginInfo() {
    return this.plugin && !this.plugin.closed && this.plugin.info ? this.plugin.info : null;
  }

  notConnectedError() {
    if (this.lastPluginFailure && Date.now() - this.lastPluginFailure < 10000) {
      return new ToolError("PairingFailed", PAIRING_FAILED_TEXT);
    }
    return new ToolError("NotConnected", "open Photoshop with the Scenario plugin installed.");
  }

  // A call from this helper's own client.
  callOwn(tool, args, timeoutMs) {
    return this.callPlugin(() => this.own.session, tool, args, timeoutMs);
  }

  // sessionOf() gives the caller's current session id when the call is sent.
  callPlugin(sessionOf, tool, args, timeoutMs) {
    const conn = this.plugin;
    if (!conn || conn.closed || !conn.info) return Promise.reject(this.notConnectedError());
    const limit = timeoutMs || this.limits.call_timeout_ms;
    this.nextCallId += 1;
    const id = this.nextCallId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new ToolError("Timeout", `${tool} got no answer from the plugin within ${Math.round(limit / 1000)} s.`));
      }, limit);
      conn.pending.set(id, { resolve, reject, timer });
      this._send(conn, { t: "call", id, session: sessionOf(), tool, args: args || {} });
    });
  }

  // ---- peer links ----

  _attachPeer(conn) {
    conn.client = { session: newSessionId(this.usedSessions), client_name: null, connected_at: new Date().toISOString(), named: false };
    this.peers.add(conn);
    this._watchIdle(conn);
    this._send(conn, { t: "hello", protocol: P.protocol, helper_version: this.version });
    this._broadcastClients();
  }

  _onPeerMessage(conn, msg) {
    if (msg.t === "ping") {
      this._send(conn, { t: "pong" });
    } else if (msg.t === "client_info") {
      // Set once: later names cannot change what the person has seen.
      if (conn.client.named) return;
      conn.client.named = true;
      conn.client.client_name = clientName(msg.client_name);
      this._broadcastClients();
    } else if (msg.t === "call") {
      if (!Number.isInteger(msg.id)) return;
      if (schema.validate(P.messages.call, msg, P).length) {
        this._send(conn, { t: "result", id: msg.id, ok: false, error: "InvalidParameter: malformed call" });
        return;
      }
      this.callPlugin(() => conn.client.session, msg.tool, msg.args).then(
        (result) => this._send(conn, { t: "result", id: msg.id, ok: true, result }),
        (err) => this._send(conn, { t: "result", id: msg.id, ok: false, error: asLine(err) })
      );
    }
  }

  clients() {
    const entry = (c) => ({ session: c.session, client_name: c.client_name, connected_at: c.connected_at });
    return [entry(this.own), ...[...this.peers].map((peer) => entry(peer.client))];
  }

  // The own client's name, from its first initialize. Set once.
  setOwnClientName(name) {
    if (this.own.named) return;
    this.own.named = true;
    this.own.client_name = clientName(name);
    this._broadcastClients();
  }

  // From the hello on, not only after the welcome: a client that joins while
  // the plugin is still answering hello must reach its list before its first call.
  _broadcastClients() {
    if (this.plugin && !this.plugin.closed) this._send(this.plugin, { t: "clients", clients: this.clients() });
  }

  _onClosed(conn) {
    clearInterval(conn.idleTimer);
    if (conn.kind === P.labels.plugin && this.plugin === conn) {
      this.plugin = null;
      clearTimeout(conn.welcomeTimer);
      for (const pending of conn.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new ToolError("NotConnected", "the Scenario plugin disconnected during the call."));
      }
      conn.pending.clear();
      if (conn.info) this.log("plugin link closed");
      this.emit("plugin", null);
    } else if (conn.kind === P.labels.peer && this.peers.has(conn)) {
      this.peers.delete(conn);
      this._broadcastClients();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    for (const peer of [...this.peers]) peer.close(CLOSE.shutting_down, "owner exiting");
    if (this.plugin) this.plugin.close(CLOSE.shutting_down, "owner exiting");
    await Promise.all(this.servers.map(closeServer));
    this.servers = [];
    if (this.wss) this.wss.close();
  }
}

module.exports = { Owner, PAIRING_FAILED_TEXT };
