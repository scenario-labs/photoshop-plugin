"use strict";
// A helper that found the port taken connects to the owner as a peer. It
// checks the owner's proof before it sends anything but its own proof, then
// relays its agent client's calls over a channel where every message has a MAC.

const { EventEmitter } = require("node:events");
const WebSocket = require("ws");
const lc = require("./crypto.js");
const schema = require("../../../shared/schema-check.js");
const { ToolError } = require("../errors.js");

const P = lc.P;
const CLOSE = P.close_codes;
// Nobody is listening: the port is free again, or an owner is still binding.
const REFUSED = new Set(["ECONNREFUSED", "ECONNRESET", "EADDRNOTAVAIL"]);

class PeerLink extends EventEmitter {
  constructor(opts) {
    super();
    this.port = opts.port;
    this.token = opts.token;
    this.limits = { ...P.limits, ...(opts.limits || {}) };
    this.log = opts.log || (() => {});
    this.ws = null;
    this.channel = null;
    this.helperVersion = null;
    this.pending = new Map();
    this.nextId = 0;
    this.ready = false;
    this.closed = false;
    this.clientName = null;
    this.nameKnown = false;
    this.nameSent = false;
  }

  // Resolves { ok: true } once the owner said hello, or { ok: false, reason, detail }.
  // reason: "refused" (nobody listening, try to bind again), "not_helper",
  // "pairing" (the owner refused our proof), "version", "full".
  connect() {
    return new Promise((resolve) => {
      let settled = false;
      let opened = false;
      let stage = "challenge";
      let nonceOwner = null;
      let nonceClient = null;
      let errorCode = null;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const giveUp = (reason, detail, code) => {
        settle({ ok: false, reason, detail });
        try {
          ws.close(code || CLOSE.normal, reason);
        } catch {
          // not open yet
        }
        setTimeout(() => ws.terminate(), 500).unref();
      };
      const ws = new WebSocket(`ws://${P.peer_url_host}:${this.port}/`, {
        perMessageDeflate: false,
        maxPayload: this.limits.max_message_bytes,
        handshakeTimeout: this.limits.handshake_ms
      });
      this.ws = ws;
      const timer = setTimeout(() => giveUp("not_helper", "no pairing challenge in time", CLOSE.handshake_timeout), this.limits.handshake_ms * 2);

      ws.on("open", () => {
        opened = true;
      });
      ws.on("unexpected-response", (_req, res) => {
        // 503: an owner that is still binding its addresses. Try again soon.
        if (res.statusCode === 503) giveUp("refused", "the owner is not ready");
        else giveUp("not_helper", `HTTP ${res.statusCode} instead of a WebSocket`);
      });
      ws.on("error", (err) => {
        errorCode = err && err.code;
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return giveUp("not_helper", "binary message", CLOSE.bad_message);
        const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data);
        const text = stage === "challenge" || stage === "owner_proof" ? bytes.toString("utf8") : null;
        if (stage === "challenge") {
          let raw = null;
          try {
            raw = JSON.parse(text);
          } catch {
            raw = null;
          }
          if (raw && raw.t === "challenge" && Number.isInteger(raw.protocol) && raw.protocol !== P.protocol) {
            return giveUp("version", `the owner speaks protocol ${raw.protocol}, this helper ${P.protocol}`, CLOSE.version_mismatch);
          }
          const ch = lc.readHandshake("challenge", text);
          if (!ch || !lc.isNonce(ch.nonce_o)) return giveUp("not_helper", "no valid pairing challenge", CLOSE.bad_message);
          nonceOwner = ch.nonce_o;
          nonceClient = lc.nonce();
          stage = "owner_proof";
          ws.send(
            JSON.stringify({
              t: "proof",
              role: P.labels.peer,
              nonce_c: nonceClient,
              proof: lc.connectProof(this.token, P.labels.peer, nonceOwner, nonceClient)
            })
          );
          return;
        }
        if (stage === "owner_proof") {
          if (lc.readHandshake("pairing_failed", text)) {
            return giveUp("pairing", "the owner refused this helper's pairing proof", CLOSE.normal);
          }
          const op = lc.readHandshake("owner_proof", text);
          if (!op || !lc.proofMatches(lc.ownerProof(this.token, nonceOwner, nonceClient), op.proof_o)) {
            return giveUp("not_helper", "the owner could not prove the pairing token", CLOSE.pairing_failed);
          }
          this.channel = new lc.Channel(lc.sessionKey(this.token, nonceOwner, nonceClient), P.labels.client_to_owner, P.labels.owner_to_client);
          stage = "hello";
          return;
        }
        let msg;
        try {
          msg = this.channel.open(bytes);
        } catch (e) {
          this.log(`closed the link to the owner: ${e.message}`);
          if (!settled) return giveUp("not_helper", e.message, CLOSE.bad_message);
          return this._drop(CLOSE.bad_message, e.message);
        }
        if (stage === "hello") {
          if (msg.t !== "hello" || schema.validate(P.messages.hello, msg, P).length) {
            return giveUp("not_helper", "unexpected first message", CLOSE.bad_message);
          }
          stage = "ready";
          this.helperVersion = msg.helper_version;
          this.ready = true;
          this.lastHeard = Date.now();
          this._startPing();
          if (this.nameKnown) this._sendName();
          settle({ ok: true });
          return;
        }
        this.lastHeard = Date.now();
        this._onMessage(msg);
      });
      ws.on("close", (code) => {
        if (!settled) {
          if (code === CLOSE.pairing_failed) settle({ ok: false, reason: "pairing", detail: "the owner refused this helper's pairing proof" });
          else if (code === CLOSE.version_mismatch) settle({ ok: false, reason: "version", detail: "the owner speaks another protocol version" });
          else if (code === CLOSE.too_many_peers) settle({ ok: false, reason: "full", detail: "the owner already serves its maximum of agent clients" });
          else if (code === CLOSE.shutting_down || (!opened && REFUSED.has(errorCode))) settle({ ok: false, reason: "refused", detail: errorCode || "the owner is shutting down" });
          else settle({ ok: false, reason: "not_helper", detail: `closed with code ${code}` });
          return;
        }
        if (stage === "ready") this._drop(code, "closed");
      });
    });
  }

  _send(message) {
    if (!this.ready || this.closed || !this.ws) return false;
    try {
      this.ws.send(this.channel.seal(message));
      return true;
    } catch {
      return false;
    }
  }

  _startPing() {
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > this.limits.idle_ms) {
        this.log("the owner stopped answering");
        this._drop(CLOSE.idle, "idle");
        return;
      }
      this._send({ t: "ping" });
    }, this.limits.ping_ms);
    this.pingTimer.unref();
  }

  _onMessage(msg) {
    if (msg.t === "result") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok === true) pending.resolve(msg.result === undefined ? null : msg.result);
      else pending.reject(ToolError.parse(typeof msg.error === "string" ? msg.error : "Internal: error without a message"));
    } else if (msg.t === "ping") {
      this._send({ t: "pong" });
    }
  }

  _drop(code, why) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    clearInterval(this.pingTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ToolError("NotConnected", "the link to the helper that owns the port closed during the call."));
    }
    this.pending.clear();
    if (!this.ws) return;
    try {
      this.ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : CLOSE.normal, why);
    } catch {
      // already closed
    }
    const ws = this.ws;
    setTimeout(() => ws.terminate(), 500).unref();
    this.emit("drop", code);
  }

  // The name from the client's first initialize, sent to the owner once.
  setClientName(name) {
    if (this.nameKnown) return;
    this.nameKnown = true;
    this.clientName = typeof name === "string" ? name : null;
    if (this.ready) this._sendName();
  }

  _sendName() {
    if (this.nameSent) return;
    this.nameSent = true;
    this._send({ t: "client_info", client_name: this.clientName });
  }

  call(tool, args, timeoutMs) {
    if (!this.ready || this.closed) return Promise.reject(new ToolError("NotConnected", "the link to the helper that owns the port is not open."));
    const limit = timeoutMs || this.limits.call_timeout_ms;
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      // The owner times out first; this timer only covers a stalled owner.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError("Timeout", `${tool} got no answer within ${Math.round(limit / 1000)} s.`));
      }, limit + 1000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this._send({ t: "call", id, tool, args: args || {} })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ToolError("NotConnected", "the link to the helper that owns the port is not open."));
      }
    });
  }

  close() {
    this._drop(CLOSE.normal, "peer exiting");
  }
}

module.exports = { PeerLink };
