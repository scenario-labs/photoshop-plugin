"use strict";
// M3 on the release bundle UXP loads, run in the fake UXP over the fake
// Photoshop modules against the fixture mock: after sign-in, Generate in the
// Image lane sends one paid request with no query string, polls the job,
// downloads the result from the CDN host the manifest declares (no key),
// and places it as an embedded smart object in one History state with its
// XMP packet. Nothing goes to any other host; the key never reaches the
// data folder.

const test = require("node:test");
const assert = require("node:assert/strict");
const { bundle } = require("../../plugin/scripts/build.js");
const { runBundle, CDN_ORIGIN } = require("../helpers/uxp-sim.js");
const { startFixtureScenario } = require("../helpers/fixture-scenario.js");
const { newKeyPair, projectRecord } = require("../helpers/mock-scenario.js");
const { freePort, newToken, waitFor } = require("../helpers/fakes.js");
const xmp = require("../../plugin/src/util/xmp.js");
const P = require("../../shared/protocol.json");

const release = bundle({ dev: false });

test("release bundle: Generate places the result in one History state, after one paid call without the flag and a keyless CDN download", async (t) => {
  const pair = newKeyPair();
  const mock = await startFixtureScenario({ accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "Bundle project" })] }], paid: true, cdnBase: CDN_ORIGIN });
  const port = await freePort();
  const ps = runBundle(release.code, { port, secure: new Map([[P.token.secure_storage_key, newToken()]]), api: mock.origin, cdn: mock.origin, photoshop: { docs: [{ id: 8, title: "Untitled-2", width: 1024, height: 1024 }], active: 8 } });
  t.after(async () => {
    ps.kill();
    await mock.close();
  });
  const { doc } = ps;
  await waitFor(() => doc.shown("view-signin"), { label: "the sign-in view" });
  doc.paste("signin-key", `${pair.key}:${pair.secret}`);
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });
  ps.entrypoints[0].panels.scenarioPanel.show();
  await waitFor(() => doc.text("generate") === "Generate (2 CU)", { label: "price on the button", timeout: 5000 });
  doc.byId("generate").click();
  await waitFor(() => doc.text("tray-status") === "Placed: 1 take", { label: "placed", timeout: 8000 });

  assert.equal(mock.paidCalls.length, 1);
  for (const r of mock.requests.filter((x) => x.path.startsWith("/v1/generate"))) {
    if (r.search === "") assert.ok(!Object.keys(r.body).some((k) => k.toLowerCase() === "dryrun"));
    else assert.equal(r.search, "?dryRun=true");
  }
  assert.deepEqual(mock.violations, []);
  assert.equal(mock.cdnRequests.length, 2, "the measured 302, then the file");
  for (const r of mock.cdnRequests) assert.equal(r.authorization, null);
  assert.deepEqual(ps.elsewhere, []);

  assert.deepEqual(ps.ps.history, [{ document_id: 8, name: "Scenario: Place image" }]);
  const layer = ps.ps.doc(8).layers[0];
  assert.equal(layer.kind, "smartObject");
  assert.match(layer.name, /^Scenario image lighthouse-rocky-coast [A-Za-z0-9]{6}$/);
  const meta = xmp.parse(layer.xmp);
  assert.equal(meta.jobId, "job_mock1");
  assert.equal(meta.cuCharged, "2");

  const stored = [...ps.files.entries()].map(([k, v]) => `${k}\n${typeof v === "string" ? v : ""}`).join("\n");
  for (const value of [pair.key, pair.secret]) assert.ok(!stored.includes(value), "a credential reached the data folder");
  assert.ok(!stored.includes("Signature="), "no signed link is stored");
  assert.ok([...ps.files.keys()].some((k) => /^Scenario\/image\/\d{8}\/.+\.png$/.test(k)), "the result is in the Output Folder");
});
