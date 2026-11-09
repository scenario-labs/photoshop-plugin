"use strict";
// plugin/src/main.js boot() under Node with a fake host: the copied token
// leaves the clipboard after the delay, and the log never holds anything
// token-like (SPEC 4.3).

const test = require("node:test");
const assert = require("node:assert/strict");
const main = require("../../plugin/src/main.js");
const { fakeHost, uxpWebSocket, freePort, newToken, waitFor, sleep } = require("../helpers/fakes.js");

async function bootWith(over = {}) {
  const port = await freePort();
  const host = fakeHost({
    WebSocket: uxpWebSocket({ rewrite: (url) => url.replace(":9890", `:${port}`) }),
    secure: [["scenario.pairing_token", newToken()]],
    ...over
  });
  const app = await main.boot({ host, document: null, console: null, clipboardClearMs: 80 });
  return { app, host };
}

test("Copy token: the clipboard is cleared after the delay if it still holds the token", async (t) => {
  const { app, host } = await bootWith();
  t.after(() => app.link.stop());
  const token = app.pairing.current();
  await app.copyToken();
  assert.equal(host.clipboard, token);
  await waitFor(() => host.clipboard === "", { label: "cleared", timeout: 2000 });

  await app.copyToken();
  host.clipboard = "something the person copied since";
  await sleep(200);
  assert.equal(host.clipboard, "something the person copied since", "other clipboard content is left alone");
});

test("the plugin log redacts token-like strings and never holds the token", async (t) => {
  const { app, host } = await bootWith();
  t.after(() => app.link.stop());
  const token = app.pairing.current();
  app.logger.log(`a message that carries ${token} by mistake`);
  await waitFor(() => (host.files.get("scenario-link.log") || "").includes("by mistake"), { label: "log written" });
  const log = host.files.get("scenario-link.log");
  assert.ok(!log.includes(token));
  assert.match(log, /carries \[redacted\] by mistake/);
  assert.ok(log.includes(`plugin ${main.VERSION} (source) starting; random source: getRandomValues`));
});
