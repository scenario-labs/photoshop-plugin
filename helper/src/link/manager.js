"use strict";
// Port election (SPEC 2.6, items 2 and 9). Each helper first tries to own the
// port. If an address is in use it becomes a peer of the owner. When the
// owner exits, peers race to bind again: one wins, the others become its peers,
// and the plugin redials. A helper that finds a program without the token on
// the port stays blocked and retries every few seconds.
//
// The pairing token comes from loadToken(): the environment variable or the
// token file (token-file.js). The file is read again when a proof fails and
// while no token is found, so one new setup command after a token reset
// reconnects every running helper that reads the file.

const { EventEmitter } = require("node:events");
const lc = require("./crypto.js");
const { Owner } = require("./owner.js");
const { PeerLink } = require("./peer.js");
const { ToolError } = require("../errors.js");
const { PAIRING_FAILED_TEXT } = require("./owner.js");

const P = lc.P;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function jitter(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

class LinkManager extends EventEmitter {
  constructor(opts) {
    super();
    this.port = opts.port || P.port;
    this.version = opts.version;
    this.hosts = opts.hosts;
    this.limits = opts.limits || {};
    this.log = opts.log || (() => {});
    this.retryMs = opts.retryMs || 3000;
    this.quickAttempts = opts.quickAttempts || 12;
    this.state = "idle";
    this.owner = null;
    this.peer = null;
    this.blocked = null;
    this.clientName = null;
    this.nameKnown = false;
    this.electing = null;
    this.retryTimer = null;
    this.stopped = false;
    this.tokenTimer = null;
    // loadToken() -> { text, source: "env" | "file", shown, missing, problem }
    this.loadToken = opts.loadToken || (() => ({ text: opts.tokenText, source: "env" }));
    this.token = null;
    this.tokenProblem = null;
    this._readToken();
  }

  // Reads the token again. Returns "none", "same" or "changed".
  _readToken() {
    let got;
    try {
      got = this.loadToken() || {};
    } catch (e) {
      got = { problem: e.message };
    }
    const parsed = got.problem || got.missing ? null : lc.parseToken(got.text);
    if (!parsed) {
      this.token = null;
      this.tokenProblem = new ToolError("PairingFailed", this._tokenMessage(got));
      return "none";
    }
    const changed = !this.token || !Buffer.from(this.token).equals(Buffer.from(parsed));
    if (changed && this.token) this.log("the pairing token changed");
    this.token = parsed;
    this.tokenProblem = null;
    this.tokenSource = got.source || "env";
    return changed ? "changed" : "same";
  }

  _tokenMessage(got) {
    const setup = "Run the setup command from Connect a client in the Scenario panel";
    if (got.problem) return `${got.problem}. ${setup}.`;
    if (got.source === "file" && got.missing) return `no pairing token: ${P.token.env} is not set and ${got.shown || "the token file"} does not exist. ${setup}.`;
    if (got.source === "file") return `${got.shown || "the token file"} does not hold a valid pairing token. ${setup} again.`;
    const empty = got.text === undefined || got.text === null || String(got.text).trim() === "";
    if (empty) return `${P.token.env} is not set. ${setup}, or copy the pairing token from the panel into this client's config.`;
    return `${P.token.env} is not a valid pairing token (${P.token.chars} characters expected). Copy it again from the Scenario panel.`;
  }

  // No usable token: agents get PairingFailed; look again every retryMs.
  _noToken() {
    this.owner = null;
    this.peer = null;
    this.state = "no_token";
    this.blocked = this.tokenProblem;
    this.log(this.blocked.toString());
    this.emit("role", "none");
    clearTimeout(this.tokenTimer);
    const recheck = () => {
      if (this.stopped || this.state !== "no_token") return;
      if (this._readToken() === "none") {
        this.tokenTimer = setTimeout(recheck, this.retryMs);
        this.tokenTimer.unref();
        return;
      }
      this.log(`pairing token found (${this.tokenSource})`);
      this._elect();
    };
    this.tokenTimer = setTimeout(recheck, this.retryMs);
    this.tokenTimer.unref();
  }

  role() {
    if (this.state === "owner") return "owner";
    if (this.state === "peer") return "peer";
    return "none";
  }

  start() {
    return this._elect();
  }

  _elect() {
    if (this.stopped) return Promise.resolve();
    if (this.electing) return this.electing;
    clearTimeout(this.retryTimer);
    this.state = "electing";
    this.electing = this._runElection().finally(() => {
      this.electing = null;
    });
    return this.electing;
  }

  async _runElection() {
    if (this._readToken() === "none") return this._noToken();
    for (let attempt = 0; attempt < this.quickAttempts; attempt++) {
      if (this.stopped) return;
      const owner = new Owner({ port: this.port, token: this.token, version: this.version, hosts: this.hosts, limits: this.limits, log: this.log });
      const bound = await owner.bind();
      if (this.stopped) {
        if (bound.ok) await owner.close();
        return;
      }
      if (bound.ok) return this._becomeOwner(owner);
      if (bound.code !== "EADDRINUSE") {
        return this._block(new ToolError("PortInUse", `cannot open port ${this.port} on ${bound.host} (${bound.code}).`));
      }
      const peer = new PeerLink({ port: this.port, token: this.token, limits: this.limits, log: this.log });
      if (this.nameKnown) peer.setClientName(this.clientName);
      const linked = await peer.connect();
      if (this.stopped) {
        peer.close();
        return;
      }
      if (linked.ok) return this._becomePeer(peer);
      if (linked.reason === "refused") {
        await sleep(jitter(20, 200));
        continue;
      }
      // The owner refused our proof. If the token file changed meanwhile, try the new token.
      if (linked.reason === "pairing" && this._readToken() === "changed") continue;
      return this._block(this._errorFor(linked));
    }
    this._block(
      new ToolError(
        "PortInUse",
        `port ${this.port} is in use on one loopback address but nothing answers on 127.0.0.1. Another program holds it; quit it or restart the computer.`
      )
    );
  }

  _errorFor(result) {
    switch (result.reason) {
      case "pairing":
        return new ToolError("PairingFailed", PAIRING_FAILED_TEXT);
      case "version":
        return new ToolError("VersionMismatch", `the helper on port ${this.port} is another version (${result.detail}). Update every agent client to the same helper version.`);
      case "full":
        return new ToolError("PortInUse", `the helper on port ${this.port} already serves its maximum of agent clients.`);
      default:
        return new ToolError("PortInUse", `port ${this.port} is held by a program that is not the Scenario helper (${result.detail}).`);
    }
  }

  _becomeOwner(owner) {
    this.owner = owner;
    this.peer = null;
    this.blocked = null;
    this.state = "owner";
    if (this.nameKnown) owner.setOwnClientName(this.clientName);
    owner.on("plugin", (info) => this.emit("plugin", info));
    // The plugin's proof failed: after a reset the token file may hold the new token.
    owner.on("plugin_pairing_failed", () => {
      if (this.owner !== owner) return;
      if (this._readToken() === "changed") owner.setToken(this.token);
    });
    this.log(`owner of port ${this.port} on ${owner.addresses.join(" and ")}`);
    this.emit("role", "owner");
  }

  _becomePeer(peer) {
    this.peer = peer;
    this.owner = null;
    this.blocked = null;
    this.state = "peer";
    // The client may have sent initialize while the election ran.
    if (this.nameKnown) peer.setClientName(this.clientName);
    this.log(`peer of the helper that owns port ${this.port}`);
    peer.on("drop", () => {
      if (this.peer !== peer) return;
      this.peer = null;
      if (this.stopped) return;
      this.state = "electing";
      this.log("the owner left; electing a new one");
      setTimeout(() => this._elect(), jitter(0, 150)).unref();
    });
    this.emit("role", "peer");
  }

  _block(err) {
    this.owner = null;
    this.peer = null;
    this.blocked = err;
    this.state = "blocked";
    this.log(err.toString());
    this.emit("role", "none");
    if (!this.stopped) {
      this.retryTimer = setTimeout(() => this._elect(), this.retryMs);
      this.retryTimer.unref();
    }
  }

  // From the client's first initialize only (SPEC 2.6): later names are ignored.
  setClientName(name) {
    if (this.nameKnown) return;
    this.nameKnown = true;
    this.clientName = typeof name === "string" ? name : null;
    if (this.owner) this.owner.setOwnClientName(this.clientName);
    if (this.peer) this.peer.setClientName(this.clientName);
  }

  async call(tool, args, timeoutMs) {
    if ((this.state === "no_token" || this.state === "blocked") && !this.electing && this._readToken() === "changed") {
      this._elect();
    }
    if (this.state === "no_token" && !this.electing) throw this.blocked;
    if (this.state === "electing" || this.electing) {
      const deadline = Date.now() + 3000;
      while ((this.state === "electing" || this.electing) && Date.now() < deadline) {
        await Promise.race([this.electing || sleep(50), sleep(250)]);
      }
    }
    if (this.state === "owner") return this.owner.callOwn(tool, args, timeoutMs);
    if (this.state === "peer") return this.peer.call(tool, args, timeoutMs);
    throw this.blocked || new ToolError("NotConnected", "the helper is still looking for the port owner; try again in a few seconds.");
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.tokenTimer);
    if (this.electing) {
      try {
        await this.electing;
      } catch {
        // ignore
      }
    }
    if (this.owner) await this.owner.close();
    if (this.peer) this.peer.close();
    this.owner = null;
    this.peer = null;
    this.state = "stopped";
  }
}

module.exports = { LinkManager };
