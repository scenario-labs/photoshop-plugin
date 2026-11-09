"use strict";
// Pure parts of sign-in: splitting a pasted key and secret (SPEC 4.2 step 3),
// reading the key's project, scope and role from the project listing, and the
// panel texts of SPEC 3.13.

const test = require("node:test");
const assert = require("node:assert/strict");
const split = require("../../plugin/src/auth/split.js");
const { identify, cannotGenerate } = require("../../plugin/src/auth/auth.js");
const view = require("../../plugin/src/ui/account-view.js");
const { projectRecord } = require("../helpers/mock-scenario.js");

const K = "api_0123456789abcdef";
const S = "Zx9-secret_value";

test("a pasted key:secret, two lines, labeled lines or a space all split into key and secret", () => {
  const expected = { key: K, secret: S };
  for (const text of [
    `${K}:${S}`,
    `  ${K}:${S}\n`,
    `${K} : ${S}`,
    `${K}\n${S}`,
    `${K}\r\n${S}\r\n`,
    `API key: ${K}\nAPI secret: ${S}`,
    `Key: ${K}\nSecret: ${S}`,
    `${K} ${S}`,
    `${K}\t${S}`
  ]) {
    assert.deepEqual(split.splitPair(text), expected, JSON.stringify(text));
  }
});

test("text that is not exactly a key and a secret does not split", () => {
  for (const text of [K, "", "   ", `${K}:`, `:${S}`, `a b c`, `${K}\n${S}\nthird`, null, undefined, 42]) {
    assert.equal(split.splitPair(text), null, JSON.stringify(text));
  }
  assert.equal(split.looksLikePair(K), false);
  assert.equal(split.looksLikePair(`${K}:${S}`), true);
  assert.equal(split.looksLikePair(`${K} ${S}`), true);
  assert.equal(split.cleanPart(`  ${K} `), K);
  assert.equal(split.cleanPart("two words"), null);
  assert.equal(split.cleanPart(""), null);
});

test("identify: the key's own entry gives its project, scope and role; other keys are ignored", () => {
  const mine = projectRecord(K, { id: "project_a", name: "Fall campaign", role: "editor" });
  const other = projectRecord("api_other", { id: "project_b", name: "Mascot" });
  assert.deepEqual(identify([other, mine], K), { scope: "project", role: "editor", project: { id: "project_a", name: "Fall campaign" } });
  assert.deepEqual(identify([projectRecord(K, { role: "reader", id: "p", name: "R" })], K).role, "reader");
  assert.deepEqual(identify([projectRecord(K, { scope: "team", role: "admin" })], K), { scope: "team", role: "admin", project: null });
  // The per-project role wins over the key's general role.
  const custom = projectRecord(K, { id: "p1", name: "N", role: "editor" });
  custom.keys[1].projects = [{ projectId: "p1", role: "reader" }];
  assert.equal(identify([custom], K).role, "reader");
});

test("identify: without the key in the listing, one project is the key's; several give no name", () => {
  const one = projectRecord(K, { id: "p1", name: "Only one", withKeys: false });
  assert.deepEqual(identify([one], K), { scope: null, role: null, project: { id: "p1", name: "Only one" } });
  const two = [projectRecord("x", { id: "p1", withKeys: false }), projectRecord("y", { id: "p2", withKeys: false })];
  assert.deepEqual(identify(two, K), { scope: null, role: null, project: null });
  assert.deepEqual(identify(null, K), { scope: null, role: null, project: null });
  assert.deepEqual(identify([null, 3, "x"], K), { scope: null, role: null, project: null });
  assert.equal(cannotGenerate("reader"), true);
  assert.equal(cannotGenerate("Reader"), true);
  assert.equal(cannotGenerate("editor"), false);
  assert.equal(cannotGenerate("assets:read;models:run"), false, "custom roles are not judged");
  assert.equal(cannotGenerate(null), false);
});

test("panel texts: the SPEC 3.13 messages, the header label and the connected block", () => {
  const exact = {
    key_refused: "Scenario did not accept this key and secret.",
    no_api_access: "API keys need a Starter plan or above. This team's plan has no API access.",
    cannot_generate: "This key can't run models. Create a Project key with the Editor or Admin role.",
    team_key: "This is a team (Organization) key. Generating needs a Project key.",
    offline: "No connection to Scenario. Check your network.",
    plan_limit: "This key's or this plan's CU limit is reached. Nothing was sent."
  };
  for (const [state, text] of Object.entries(exact)) assert.equal(view.STATES[state].text, text, state);
  assert.deepEqual(view.STATES.key_refused.actions, ["enter_again", "create_key"]);
  assert.deepEqual(view.STATES.no_api_access.actions, ["open_plans", "copy_admin_request"]);
  assert.deepEqual(view.STATES.cannot_generate.actions, ["create_key", "copy_error"]);
  assert.deepEqual(view.STATES.team_key.actions, ["create_key"]);
  assert.deepEqual(view.STATES.offline.actions, ["retry"]);
  assert.equal(view.projectLabel(null), "Not signed in");
  assert.equal(view.projectLabel({ project_name: "Fall campaign", key_last4: "7KQ2" }), "Fall campaign");
  assert.equal(view.projectLabel({ project_name: null, key_last4: "7KQ2" }), "Scenario project ....7KQ2");
  assert.deepEqual(view.connectedLines({ project_name: "Fall campaign", key_last4: "7KQ2" }), ["Connected to Scenario", "Project: Fall campaign", "Key ....7KQ2"]);
  assert.deepEqual(view.connectedLines({ project_name: null, key_last4: "7KQ2" }), ["Connected to Scenario", "Project: Scenario project ....7KQ2", "(the API returned no project name)"]);
  assert.equal(view.testing(1, 2), "Testing 1 of 2");
  assert.equal(view.retrying(5), "Scenario is busy. Retrying in 5 s.");
  assert.equal(view.TEXT.admin_request, "Could you create a Scenario API key for me? Type: Project key, role: Editor, project: <the one I should use>, with a CU limit if you set one for third-party tools. It is for the Scenario plugin for Photoshop.");
  const d = view.describeFailure({ state: "cannot_generate", type: "KeyCannotGenerate", scenario_message: "Missing scope" });
  assert.equal(d.detail, "Scenario's message: Missing scope");
  assert.equal(d.copy, "KeyCannotGenerate: This key can't run models. Create a Project key with the Editor or Admin role. Scenario's message: Missing scope");
  assert.equal(view.describeFailure({ state: "cannot_generate", type: "KeyCannotGenerate", role: "reader" }).detail, "This key's role is Reader.");
});
