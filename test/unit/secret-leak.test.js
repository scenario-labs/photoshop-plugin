"use strict";
// The key and secret never leave the plugin except in the Authorization header
// to Scenario's API (SPEC 2.10, Credentials). The release bundle runs in a fake
// UXP (test/helpers/uxp-sim.js), linked to a real helper owner, against a mock
// Scenario API whose error texts echo the key, the secret and the header back.
// Through the panel it fails one sign-in, signs in with another key, copies
// the error, tests the connection against a failing server, copies the
// diagnostics, and answers scenario_status. Then every place a value could
// end up is searched: the plugin log and every data file (where the activity
// log will live), the console, secure storage entry names and the account
// index, every frame sent to the helper and every message the helper read,
// the helper's log, scenario_status, the panel's texts and fields, the
// clipboard, and the requests that left the plugin. The project listing's
// member emails and other key ids are searched for too.

const test = require("node:test");
const assert = require("node:assert/strict");
const { bundle } = require("../../plugin/scripts/build.js");
const { Owner } = require("../../helper/src/link/owner.js");
const hp = require("../../helper/src/link/crypto.js");
const P = require("../../shared/protocol.json");
const { runBundle } = require("../helpers/uxp-sim.js");
const { startMockScenario, newKeyPair, projectRecord, basic, MEMBER_EMAIL, OTHER_KEY_ID } = require("../helpers/mock-scenario.js");
const { freePort, newToken, waitFor, sleep } = require("../helpers/fakes.js");

const release = bundle({ dev: false });

test("the key, the secret and the project listing never reach logs, files, the helper, scenario_status, the panel or the clipboard", async (t) => {
  const good = newKeyPair();
  const bad = newKeyPair();
  const projectId = "project_leakCheck0001";
  const mock = await startMockScenario({
    accounts: [{ ...good, projects: [projectRecord(good.key, { id: projectId, name: "Leak check" })] }],
    // A key Scenario refuses, with an error text that repeats it.
    handle: ({ authorization }) => (authorization === basic(bad) ? { status: 403, body: { reason: `Key ${bad.key} with secret ${bad.secret} (${authorization}) has no scope` } } : undefined)
  });
  const port = await freePort();
  const token = newToken();
  const helperLog = [];
  const o = new Owner({ port, token: hp.parseToken(token), version: "0.1.0", hosts: ["127.0.0.1", "::1"], log: (line) => helperLog.push(String(line)) });
  assert.equal((await o.bind()).ok, true);
  const received = [];
  const onPluginMessage = o._onPluginMessage.bind(o);
  o._onPluginMessage = (conn, msg) => {
    received.push(JSON.stringify(msg));
    return onPluginMessage(conn, msg);
  };
  const ps = runBundle(release.code, { port, secure: new Map([[P.token.secure_storage_key, token]]), api: mock.origin });
  t.after(async () => {
    ps.kill();
    await o.close();
    await mock.close();
  });
  const { doc } = ps;
  await waitFor(() => o.pluginInfo(), { label: "plugin linked" });
  o.setOwnClientName("Claude Code");

  // 1. A refused key whose error text repeats it; Copy error; Enter key again.
  doc.paste("signin-key", `${bad.key}:${bad.secret}`);
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("signin-status"), { label: "refused" });
  assert.equal(doc.text("signin-status-text"), "This key can't run models. Create a Project key with the Editor or Admin role.");
  assert.equal(doc.text("signin-status-detail"), "Scenario's message: Key [redacted] with secret [redacted] (Basic [redacted]) has no scope");
  doc.byId("signin-act-copy_error").click();
  await waitFor(() => ps.clipboard.history.length === 1, { label: "error copied" });
  doc.byId("signin-act-enter_again").click();

  // 2. The working key, pasted as two lines.
  doc.paste("signin-key", `${good.key}\n${good.secret}`);
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });
  assert.equal(doc.text("project"), "Leak check");
  const signedIn = await o.callOwn("scenario_status", {});
  assert.equal(signedIn.signed_in, true);
  assert.equal(signedIn.project_name, "Leak check");

  // 3. Test connection against a server that echoes everything; Copy error.
  mock.setHandler(({ authorization }) => ({ status: 500, body: { message: `upstream refused ${authorization} for ${good.key}:${good.secret}` } }));
  doc.byId("open-settings").click();
  doc.byId("settings-test").click();
  await waitFor(() => doc.shown("settings-status"), { label: "test failed" });
  assert.equal(doc.text("settings-status-text"), "Scenario could not check this key.");
  assert.match(doc.text("settings-status-detail"), /^Scenario's message: upstream refused Basic \[redacted\] for \[redacted\]:\[redacted\]$/);
  doc.byId("settings-act-copy_error").click();
  await waitFor(() => ps.clipboard.history.length === 2, { label: "second error copied" });
  mock.setHandler(null);

  // 4. Diagnostics: preview, then Copy.
  doc.byId("diag-copy").click();
  doc.byId("diag-confirm").click();
  await waitFor(() => ps.clipboard.history.length === 3, { label: "diagnostics copied" });
  const status = await o.callOwn("scenario_status", {});
  await sleep(400); // the log file is written in batches

  const forbidden = {
    "the key": good.key,
    "the secret": good.secret,
    "the Basic header": basic(good).slice(6),
    "the refused key": bad.key,
    "the refused secret": bad.secret,
    "the refused key's header": basic(bad).slice(6),
    "a member's email": MEMBER_EMAIL,
    "another key id": OTHER_KEY_ID
  };
  function clean(where, text) {
    for (const [what, value] of Object.entries(forbidden)) assert.ok(!String(text).includes(value), `${what} reached ${where}`);
  }

  // Files the plugin writes (the link log today, the activity log later).
  assert.ok(ps.files.get("scenario-link.log"), "the plugin log was written");
  for (const [name, text] of ps.files) {
    clean(`the file name ${name}`, name);
    clean(`the data file ${name}`, text);
  }
  clean("the console", ps.logs.join("\n"));
  // Secure storage: entry names are stored unencrypted; the index holds no key.
  const keyEntries = [...ps.secure.keys()].filter((k) => k.startsWith("scenario.key."));
  assert.equal(keyEntries.length, 1, "one key saved; the refused one was not");
  for (const [name, value] of ps.secure) {
    clean(`the secure entry name ${name}`, name);
    if (name === keyEntries[0]) {
      assert.deepEqual(JSON.parse(value), { v: 1, key: good.key, secret: good.secret }, "the key entry holds the pair only");
    } else {
      clean(`the secure entry ${name}`, value);
    }
  }
  const index = JSON.parse(ps.secure.get("scenario.accounts"));
  assert.deepEqual(Object.keys(index.accounts[0]).sort(), ["id", "key_hash", "key_last4", "project_id", "project_name", "saved_at"]);
  // The helper: frames as sent, messages as read, its log, and the status.
  assert.ok(ps.frames.length > 3 && received.length > 0);
  for (const where of [
    ["a frame sent to the helper", ps.frames.join("\n")],
    ["a message the helper read", received.join("\n")],
    ["the helper's log", helperLog.join("\n")],
    ["scenario_status", JSON.stringify([signedIn, status])],
    ["the plugin info the helper keeps", JSON.stringify(o.pluginInfo())]
  ]) {
    clean(where[0], where[1]);
    assert.ok(!where[1].includes(projectId), `the project id reached ${where[0]}`);
  }
  assert.deepEqual(Object.keys(status).filter((k) => /key|secret|project/.test(k)), ["project_name"]);
  // The panel, once the fields are cleared, and everything copied.
  clean("the panel", doc.allStrings().join("\n"));
  assert.equal(ps.clipboard.history.length, 3);
  clean("the clipboard", ps.clipboard.history.join("\n"));
  assert.match(ps.clipboard.history[2], /account: signed in, keys saved 1/);
  assert.ok(!ps.clipboard.history[2].includes("Leak check") && !ps.clipboard.history[2].includes(good.key.slice(-4)), "diagnostics name no project and no key ending");
  // Requests: Scenario's API only; the header only with the key being tested.
  assert.deepEqual(ps.elsewhere, [], "no request to another host");
  assert.ok(mock.requests.length >= 4);
  assert.ok(mock.requests.some((r) => r.authorization === basic(good)) && mock.requests.some((r) => r.authorization === basic(bad)), "both keys did reach the API");
  for (const r of mock.requests) {
    assert.ok(r.path.startsWith("/v1/"), r.path);
    assert.ok([basic(good), basic(bad)].includes(r.authorization), "every request carries a key being tested");
  }
});
