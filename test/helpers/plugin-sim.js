"use strict";
// Runs the plugin's own link code (plugin/src/bridge/link.js) under Node as a
// fake plugin: real WebSocket, real pairing proofs and MACs, fake Photoshop.

const link = require("../../plugin/src/bridge/link.js");
const status = require("../../plugin/src/bridge/status.js");
const randomMod = require("../../plugin/src/util/random.js");
const main = require("../../plugin/src/main.js");
const { uxpWebSocket, fakeHost } = require("./fakes.js");

const FAST = {
  handshake_ms: 1000,
  dial_interval_ms: 100,
  redial_after_drop_ms: 50,
  ping_ms: 200,
  idle_ms: 2000
};

// opts: { port, token, host, limits, wsOptions, handlers }
function startFakePlugin(opts) {
  const host = opts.host || fakeHost();
  const settings = status.createSettings();
  const random = randomMod.createRandom({ crypto: require("node:crypto").webcrypto });
  const states = [];
  const ended = [];
  let token = opts.token;
  const WebSocket = uxpWebSocket({
    rewrite: (url) => url.replace(":9890", `:${opts.port}`),
    ...(opts.wsOptions || {})
  });
  const l = link.createLink({
    WebSocket,
    getToken: () => token,
    random,
    info: () => ({ plugin_version: main.VERSION, photoshop_version: host.photoshopVersion(), os: host.osName() }),
    catalogHash: main.catalogHash(),
    switches: settings.switches,
    handlers: opts.handlers || { scenario_status: status.createStatusHandler(host, settings, main.VERSION) },
    timers: host.timers,
    limits: { ...FAST, ...(opts.limits || {}) },
    onState: (s) => states.push(s),
    // As in main.js: an ended session ends the allowance given to it.
    onSessionsEnded: (ids, why) => {
      ended.push({ ids: ids.slice(), why });
      settings.endSessions(ids);
    },
    log: () => {}
  });
  l.start();
  return {
    link: l,
    host,
    settings,
    states,
    ended,
    setToken(t) {
      token = t;
    },
    phase: () => l.state().phase,
    stop: () => l.stop()
  };
}

module.exports = { startFakePlugin, FAST };
