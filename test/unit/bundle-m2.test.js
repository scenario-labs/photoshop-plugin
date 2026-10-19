"use strict";
// M2 exit on the release bundle UXP loads, run in the fake UXP against the
// M2.0 fixture mock and linked to a real helper owner: after sign-in the
// panel shows the price on the Generate button once it is shown, and an
// agent client gets the same exact prices through estimate_cost for the three
// families (Image default, Edit default with a mask, an Enhance model). Every
// request to /generate is a price check with the flag from the one constant;
// the key and the secret never reach a frame sent to the helper.

const test = require("node:test");
const assert = require("node:assert/strict");
const { bundle } = require("../../plugin/scripts/build.js");
const { Owner } = require("../../helper/src/link/owner.js");
const hp = require("../../helper/src/link/crypto.js");
const P = require("../../shared/protocol.json");
const { runBundle } = require("../helpers/uxp-sim.js");
const { startFixtureScenario } = require("../helpers/fixture-scenario.js");
const { newKeyPair, projectRecord, basic } = require("../helpers/mock-scenario.js");
const { freePort, newToken, waitFor, sleep } = require("../helpers/fakes.js");

const release = bundle({ dev: false });

test("release bundle: the panel and estimate_cost give the exact prices of the three families, through price checks only", async (t) => {
  const pair = newKeyPair();
  const mock = await startFixtureScenario({ accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "Bundle project" })] }] });
  const port = await freePort();
  const token = newToken();
  const o = new Owner({ port, token: hp.parseToken(token), version: "0.2.0", hosts: ["127.0.0.1", "::1"] });
  assert.equal((await o.bind()).ok, true);
  const ps = runBundle(release.code, { port, secure: new Map([[P.token.secure_storage_key, token]]), api: mock.origin });
  t.after(async () => {
    ps.kill();
    await o.close();
    await mock.close();
  });
  const { doc } = ps;
  await waitFor(() => o.pluginInfo(), { label: "plugin linked" });
  o.setOwnClientName("Claude Code");

  doc.paste("signin-key", `${pair.key}:${pair.secret}`);
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });
  await sleep(500);
  assert.equal(mock.requests.filter((r) => r.path.startsWith("/v1/generate")).length, 0, "no price check before the panel is shown");

  ps.entrypoints[0].panels.scenarioPanel.show();
  await waitFor(() => doc.text("generate") === "Generate (2 CU)", { label: "Image price on the button", timeout: 5000 });
  assert.equal(doc.byId("generate").getAttribute("disabled"), "");
  assert.equal(doc.text("generate-note"), "Generation comes in the next build.");

  const listed = await o.callOwn("list_models", { lane: "remove_background", limit: 5 });
  assert.equal(listed.models[0].model_id, "model_851-labs-background-remover");

  const prompt = "a red fox in snow";
  const image = await o.callOwn("estimate_cost", { model_id: "model_openai-gpt-image-2-5-flare", lane: "image", parameters: { prompt, quality: "low", width: 1024, height: 1024 }, takes: 1 });
  const edit = await o.callOwn("estimate_cost", { model_id: "model_openai-gpt-image-2-5-flare", lane: "edit", parameters: { prompt, quality: "low", width: 1024, height: 1024 }, takes: 2 });
  const enhance = await o.callOwn("estimate_cost", { model_id: "model_851-labs-background-remover", lane: "remove_background" });
  assert.deepEqual(
    [image, edit, enhance].map((q) => [q.cu_cost_exact, q.price_kind, q.needs_upload]),
    [
      ["2", "exact", false],
      ["3", "exact", true],
      ["1", "exact", true]
    ]
  );
  // needs_upload: the capture (and the source image) are still to upload at generation time.
  for (const q of [image, edit, enhance]) assert.match(q.quote_id, /^quote_[0-9a-f]{24}$/);

  await sleep(400);
  const generate = mock.requests.filter((r) => r.path.startsWith("/v1/generate"));
  assert.ok(generate.length >= 4);
  for (const r of generate) assert.equal(`${r.method} ${r.search}`, "POST ?dryRun=true");
  assert.deepEqual(mock.violations, []);
  const frames = ps.frames.join("\n");
  for (const value of [pair.key, pair.secret, basic(pair).slice(6)]) assert.ok(!frames.includes(value), "a credential reached the helper");
  assert.ok(!(ps.files.get("scenario-link.log") || "").includes(prompt), "prompts are never logged");
});
