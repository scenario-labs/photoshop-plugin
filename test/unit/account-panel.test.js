"use strict";
// The account panel (plugin/src/ui/account-panel.js) in a DOM built from the
// real index.html, booted through main.js against a mock Scenario API: first
// run, pasting key:secret, the macOS password field, Save and test in each
// state with the SPEC 3.13 texts, the header, Projects, Settings (Test
// connection, Sign out, Copy diagnostics) and persistence across a restart.

const test = require("node:test");
const assert = require("node:assert/strict");
const main = require("../../plugin/src/main.js");
const API = require("../../shared/scenario-api.json");
const view = require("../../plugin/src/ui/account-view.js");
const { createFakeDocument } = require("../helpers/fake-dom.js");
const { startMockScenario, newKeyPair, projectRecord } = require("../helpers/mock-scenario.js");
const { fakeHost, uxpWebSocket, freePort, newToken, waitFor } = require("../helpers/fakes.js");

async function bootPanel(t, { accounts = [], handle, host } = {}) {
  const mock = await startMockScenario({ accounts, handle });
  const port = await freePort();
  host =
    host ||
    fakeHost({
      WebSocket: uxpWebSocket({ rewrite: (url) => url.replace(":9890", `:${port}`) }),
      secure: [["scenario.pairing_token", newToken()]]
    });
  const doc = createFakeDocument();
  const app = await main.boot({ host, document: doc, console: null, apiBaseUrl: mock.url });
  t.after(async () => {
    app.link.stop();
    await mock.close();
  });
  return { app, host, doc, mock };
}

const STATUS_ACTIONS = ["enter_again", "create_key", "open_plans", "copy_admin_request", "copy_error", "retry"];
function shownActions(doc, prefix) {
  return STATUS_ACTIONS.filter((a) => doc.shown(`${prefix}-act-${a}`));
}

async function signIn(doc, pair) {
  doc.paste("signin-key", `${pair.key}:${pair.secret}`);
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("view-main") || doc.shown("signin-status"), { label: "Save and test finished" });
}

test("first run: the sign-in view with the spec's texts; header 'Not signed in'", async (t) => {
  const { doc, app } = await bootPanel(t);
  assert.equal(doc.text("project-label"), "Not signed in");
  assert.ok(doc.shown("view-signin"));
  assert.ok(!doc.shown("view-main") && !doc.shown("view-projects") && !doc.shown("view-settings"));
  assert.equal(doc.text("signin-title"), "Connect your Scenario account");
  assert.equal(doc.text("signin-disclosure"), "Generative AI by Scenario.");
  assert.equal(doc.text("signin-plan"), "Needs a Scenario plan with API access (Starter or above).");
  assert.equal(doc.text("signin-step2"), "Paste the key and its secret.");
  assert.equal(doc.text("signin-help-title"), "NO KEY YET?");
  assert.equal(doc.text("signin-step1"), "Create a Project key with the Editor role in the project you want to use. A CU limit on the key caps what this plugin and connected agents can spend.");
  assert.equal(doc.text("signin-admins"), "Only team admins and project owners can create keys.");
  assert.equal(doc.text("signin-storage"), "Keys stay in Photoshop's secure storage on this computer.");
  assert.equal(doc.byId("signin-secret").getAttribute("type"), "password");
  assert.ok(!doc.shown("signin-back"), "no Back on first run");
  assert.ok(!doc.shown("signin-status"));
  assert.deepEqual(app.auth.status(), { signed_in: false, project_name: null });

  doc.byId("open-settings").click();
  assert.ok(doc.shown("view-settings"));
  assert.equal(doc.text("settings-none"), "Not signed in.");
  assert.ok(!doc.shown("settings-test") && !doc.shown("settings-signout"));
  assert.equal(doc.text("settings-signout-note"), "Sign out removes the key from this computer. Delete it on app.scenario.com to revoke it.");
  doc.byId("settings-back").click();
  assert.ok(doc.shown("view-signin"));
});

test("paste key:secret: the secret goes to the masked field at once; Save and test signs in", async (t) => {
  const pair = newKeyPair();
  const { doc, app, host, mock } = await bootPanel(t, { accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "Fall campaign" })] }] });
  doc.paste("signin-key", `${pair.key}:${pair.secret}`);
  const keyField = doc.byId("signin-key");
  const secretField = doc.byId("signin-secret");
  assert.equal(keyField.value, pair.key, "the key field holds the key only");
  assert.equal(secretField._value, pair.secret, "the secret sits in the password field");
  assert.equal(secretField.value, "", "and reads as empty there, as on macOS");

  const progress = [];
  const orig = Object.getOwnPropertyDescriptor(doc.byId("signin-progress"), "textContent");
  Object.defineProperty(doc.byId("signin-progress"), "textContent", {
    get: orig.get,
    set(v) {
      if (v) progress.push(v);
      orig.set.call(this, v);
    }
  });
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });
  assert.deepEqual(progress, ["Testing 1 of 2", "Testing 2 of 2"]);
  assert.equal(doc.text("signin-progress"), "");
  assert.equal(doc.text("project-label"), "Fall campaign");
  assert.ok(doc.shown("account-banner"));
  assert.deepEqual([doc.text("account-banner-1"), doc.text("account-banner-2"), doc.text("account-banner-3")], ["Connected to Scenario", "Project: Fall campaign", `Key ....${pair.key.slice(-4)}`]);
  assert.equal(keyField._value, "", "fields are cleared after saving");
  assert.equal(secretField._value, "");
  assert.equal(mock.requests.length, 2);
  assert.deepEqual(app.auth.status(), { signed_in: true, project_name: "Fall campaign" });
  doc.byId("account-banner-close").click();
  assert.ok(!doc.shown("account-banner"));
  assert.ok(!host.opened.length, "no page opened by itself");
});

test("two lines without clipboard data, and a typed key and secret, both work", async (t) => {
  const a = newKeyPair();
  const b = newKeyPair();
  const { doc, app } = await bootPanel(t, {
    accounts: [
      { ...a, projects: [projectRecord(a.key, { id: "pa", name: "A" })] },
      { ...b, projects: [projectRecord(b.key, { id: "pb", name: "B" })] }
    ]
  });
  doc.paste("signin-key", `${a.key}\n${a.secret}`, { clipboardData: false });
  assert.equal(doc.byId("signin-key").value, a.key);
  assert.equal(doc.byId("signin-secret")._value, a.secret);
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("view-main"));
  assert.equal(doc.text("project-label"), "A");

  // Typed: the secret is read through the password-field workaround.
  doc.byId("project").click();
  doc.byId("projects-add").click();
  assert.ok(doc.shown("view-signin") && doc.shown("signin-back"));
  assert.equal(doc.text("signin-title"), "Add a key for another project");
  doc.type("signin-key", b.key);
  doc.type("signin-secret", b.secret);
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("view-main"));
  assert.equal(doc.text("project-label"), "B");
  assert.equal(doc.byId("signin-secret").getAttribute("type"), "password", "the field is a password field again");
  assert.deepEqual(app.auth.status(), { signed_in: true, project_name: "B" });
});

test("wrong key: the SPEC text and actions; Enter key again clears; Create an API key opens the help center", async (t) => {
  const pair = newKeyPair();
  const { doc, host } = await bootPanel(t, { accounts: [{ ...pair, projects: [] }] });
  doc.paste("signin-key", `${pair.key}:not-the-secret`);
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("signin-status"));
  assert.equal(doc.text("signin-status-text"), "Scenario did not accept this key and secret.");
  assert.deepEqual(shownActions(doc, "signin"), ["enter_again", "create_key"]);
  assert.equal(doc.text("signin-act-enter_again"), "Enter key again");
  assert.ok(doc.shown("signin-links"), "Report a problem and Get help under the error");
  assert.ok(doc.shown("view-signin"));
  assert.equal(doc.text("project-label"), "Not signed in");

  doc.byId("signin-act-create_key").click();
  doc.byId("signin-help").click();
  doc.byId("signin-report").click();
  await waitFor(() => host.opened.length === 3);
  assert.deepEqual(host.opened, [API.links.create_key, API.links.get_help, API.links.report_problem]);
  assert.equal(API.links.create_key, "https://help.scenario.com/articles/2952168846-api-keys-and-scopes");

  doc.byId("signin-act-enter_again").click();
  assert.equal(doc.byId("signin-key")._value, "");
  assert.equal(doc.byId("signin-secret")._value, "");
  assert.ok(!doc.shown("signin-status"));
  assert.equal(doc.focused, doc.byId("signin-key"));
});

test("offline, then Retry once the connection is back", async (t) => {
  const pair = newKeyPair();
  let down = true;
  const { doc } = await bootPanel(t, { accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "Back online" })] }], handle: () => (down ? { destroy: true } : undefined) });
  doc.paste("signin-key", `${pair.key}:${pair.secret}`);
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("signin-status"));
  assert.equal(doc.text("signin-status-text"), "No connection to Scenario. Check your network.");
  assert.deepEqual(shownActions(doc, "signin"), ["retry"]);
  down = false;
  doc.byId("signin-act-retry").click();
  await waitFor(() => doc.shown("view-main"), { label: "Retry signed in" });
  assert.equal(doc.text("project-label"), "Back online");
});

test("Reader key and Team key: refused with their texts; Copy error copies one line", async (t) => {
  const reader = newKeyPair();
  const team = newKeyPair();
  const { doc, host } = await bootPanel(t, {
    accounts: [
      { ...reader, projects: [projectRecord(reader.key, { role: "reader" })] },
      { ...team, projects: [projectRecord(team.key, { scope: "team", role: "admin" })] }
    ]
  });
  await signIn(doc, reader);
  assert.equal(doc.text("signin-status-text"), "This key can't run models. Create a Project key with the Editor or Admin role.");
  assert.equal(doc.text("signin-status-detail"), "This key's role is Reader.");
  assert.deepEqual(shownActions(doc, "signin"), ["create_key", "copy_error"]);
  doc.byId("signin-act-copy_error").click();
  await waitFor(() => host.clipboard);
  assert.equal(host.clipboard, "KeyCannotGenerate: This key can't run models. Create a Project key with the Editor or Admin role. This key's role is Reader.");
  assert.equal(doc.text("signin-note"), "Copied.");

  doc.byId("signin-act-enter_again");
  await signIn(doc, team);
  assert.equal(doc.text("signin-status-text"), "This is a team (Organization) key. Generating needs a Project key.");
  assert.deepEqual(shownActions(doc, "signin"), ["create_key"]);
  assert.equal(doc.text("project-label"), "Not signed in");
});

test("no API access (a text known as data): the SPEC text with Open plans and the admin request", async (t) => {
  const pair = newKeyPair();
  const { doc, host } = await bootPanel(t, { accounts: [{ ...pair }], handle: () => ({ status: 403, body: { reason: "Team plan has no API access" } }) });
  API.known_errors.texts.push({ status: 403, text: "plan has no API access", type: "NoApiAccess" });
  t.after(() => API.known_errors.texts.pop());
  await signIn(doc, pair);
  assert.equal(doc.text("signin-status-text"), "API keys need a Starter plan or above. This team's plan has no API access.");
  assert.deepEqual(shownActions(doc, "signin"), ["open_plans", "copy_admin_request"]);
  doc.byId("signin-act-open_plans").click();
  await waitFor(() => host.opened.length === 1);
  assert.equal(host.opened[0], "https://app.scenario.com/settings/organization-plans");
  doc.byId("signin-act-copy_admin_request").click();
  await waitFor(() => host.clipboard);
  assert.equal(host.clipboard, view.TEXT.admin_request);
  assert.equal(doc.text("signin-note"), "Copied. Send it to your Scenario admin, then paste the key and secret they give you here.");
});

test("a 403 on the read: 'This key can't run models.' with Scenario's own text", async (t) => {
  const pair = newKeyPair();
  const { doc } = await bootPanel(t, { accounts: [{ ...pair }], handle: () => ({ status: 403, body: { reason: "Missing scope" } }) });
  await signIn(doc, pair);
  assert.equal(doc.text("signin-status-text"), "This key can't run models. Create a Project key with the Editor or Admin role.");
  assert.equal(doc.text("signin-status-detail"), "Scenario's message: Missing scope");
});

test("Scenario busy: 'Retrying in N s.' while the read waits", async (t) => {
  const pair = newKeyPair();
  let first = true;
  const { doc } = await bootPanel(t, {
    accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "After wait" })] }],
    handle: ({ path }) => {
      if (path === "/v1/models" && first) {
        first = false;
        return { status: 429, body: {}, headers: { "retry-after": "1" } };
      }
      return undefined;
    }
  });
  doc.paste("signin-key", `${pair.key}:${pair.secret}`);
  doc.byId("signin-save").click();
  await waitFor(() => doc.text("signin-progress") === "Scenario is busy. Retrying in 1 s.", { label: "retry text" });
  await waitFor(() => doc.shown("view-main"), { timeout: 4000 });
  assert.equal(doc.text("project-label"), "After wait");
});

test("no project name readable: header 'Scenario project ....XXXX'; Settings and the header agree", async (t) => {
  const pair = newKeyPair();
  const { doc } = await bootPanel(t, { accounts: [{ ...pair }], handle: ({ path }) => (path === "/v1/projects" ? { status: 403, body: {} } : undefined) });
  await signIn(doc, pair);
  const label = `Scenario project ....${pair.key.slice(-4)}`;
  assert.equal(doc.text("project-label"), label);
  assert.deepEqual([doc.text("account-banner-1"), doc.text("account-banner-2"), doc.text("account-banner-3")], ["Connected to Scenario", `Project: ${label}`, "(the API returned no project name)"]);
});

test("Projects view: a second key, the switch, and the list", async (t) => {
  const a = newKeyPair();
  const b = newKeyPair();
  const { doc, app } = await bootPanel(t, {
    accounts: [
      { ...a, projects: [projectRecord(a.key, { id: "pa", name: "Fall campaign" })] },
      { ...b, projects: [projectRecord(b.key, { id: "pb", name: "Mascot training" })] }
    ]
  });
  await signIn(doc, a);
  doc.byId("project").click();
  assert.ok(doc.shown("view-projects"));
  assert.equal(doc.text("projects-note"), "Switching changes trained models, the Library and where results go. Running jobs keep their project.");
  doc.byId("projects-add").click();
  await signIn(doc, b);
  assert.equal(doc.text("project-label"), "Mascot training");
  doc.byId("project").click();
  const rows = doc.byId("projects-list").children;
  assert.deepEqual(rows.map((r) => r.textContent), [`Fall campaign   ....${a.key.slice(-4)}`, `Mascot training   ....${b.key.slice(-4)}`]);
  assert.deepEqual(rows.map((r) => r.getAttribute("selected")), [null, ""]);
  rows[0].click();
  await waitFor(() => doc.text("project-label") === "Fall campaign", { label: "switched" });
  assert.deepEqual(app.auth.status(), { signed_in: true, project_name: "Fall campaign" });
  assert.deepEqual(doc.byId("projects-list").children.map((r) => r.getAttribute("selected")), ["", null]);
  doc.byId("projects-back").click();
  assert.ok(doc.shown("view-main"));
});

test("Settings: Test connection, a confirmed Sign out per project, then signed out", async (t) => {
  const a = newKeyPair();
  const b = newKeyPair();
  const { doc, app, mock } = await bootPanel(t, {
    accounts: [
      { ...a, projects: [projectRecord(a.key, { id: "pa", name: "Fall campaign" })] },
      { ...b, projects: [projectRecord(b.key, { id: "pb", name: "Mascot training" })] }
    ]
  });
  await signIn(doc, a);
  doc.byId("project").click();
  doc.byId("projects-add").click();
  await signIn(doc, b);
  doc.byId("open-settings").click();
  assert.equal(doc.byId("settings-accounts").children.length, 2);
  doc.byId("settings-test").click();
  await waitFor(() => doc.shown("settings-status"));
  assert.equal(doc.text("settings-status-text"), "Connected to Scenario");
  assert.equal(doc.text("settings-status-detail"), `Project: Mascot training. Key ....${b.key.slice(-4)}`);
  assert.ok(!doc.shown("settings-links"));

  mock.setHandler(() => ({ status: 401, body: { message: "Unauthorized" } }));
  doc.byId("settings-test").click();
  await waitFor(() => doc.text("settings-status-text") === "Scenario did not accept this key and secret.");
  assert.deepEqual(shownActions(doc, "settings"), ["enter_again", "create_key"]);
  mock.setHandler(null);

  doc.byId("settings-signout").click();
  assert.equal(doc.text("settings-signout"), "Confirm sign out");
  assert.equal(app.auth.status().project_name, "Mascot training", "the first click only asks");
  doc.byId("settings-signout").click();
  await waitFor(() => doc.text("project-label") === "Fall campaign", { label: "fell back to the other project" });
  assert.equal(doc.text("settings-note"), "Signed out. Now using Fall campaign.");
  assert.equal(doc.byId("settings-accounts").children.length, 1);

  doc.byId("settings-signout").click();
  doc.byId("settings-signout").click();
  await waitFor(() => doc.text("project-label") === "Not signed in");
  assert.equal(doc.text("settings-note"), "Signed out. The key is removed from this computer.");
  assert.equal(doc.text("settings-none"), "Not signed in.");
  assert.ok(!doc.shown("settings-signout"));
  doc.byId("settings-back").click();
  assert.ok(doc.shown("view-signin"));
  assert.deepEqual(app.auth.status(), { signed_in: false, project_name: null });
});

test("Copy diagnostics shows the text first; it names no project, key or secret", async (t) => {
  const pair = newKeyPair();
  const { doc, host } = await bootPanel(t, { accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "Secret project name" })] }] });
  doc.paste("signin-key", `${pair.key}:wrong`);
  doc.byId("signin-save").click();
  await waitFor(() => doc.shown("signin-status"));
  await signIn(doc, pair);
  doc.byId("open-settings").click();
  doc.byId("diag-copy").click();
  assert.ok(doc.shown("diag-preview"));
  const text = doc.text("diag-text");
  assert.ok(text.startsWith(`plugin ${main.VERSION} (source) . helper not linked\n`));
  assert.match(text, /account: signed in, keys saved 1/);
  assert.match(text, /last errors: Unauthorized$/);
  for (const secret of [pair.key, pair.secret, "Secret project name", pair.key.slice(-4)]) assert.ok(!text.includes(secret));
  assert.equal(host.clipboard, null, "nothing copied before Copy");
  doc.byId("diag-confirm").click();
  await waitFor(() => host.clipboard === text);
  assert.ok(!doc.shown("diag-preview"));
  assert.equal(doc.text("diag-note"), "Copied.");
});

test("after a restart the saved key is used: header and status without a new sign-in", async (t) => {
  const pair = newKeyPair();
  const first = await bootPanel(t, { accounts: [{ ...pair, projects: [projectRecord(pair.key, { name: "Kept" })] }] });
  await signIn(first.doc, pair);
  first.app.link.stop();
  const again = await bootPanel(t, { accounts: [{ ...pair }], host: first.host });
  assert.equal(again.doc.text("project-label"), "Kept");
  assert.ok(again.doc.shown("view-main"));
  assert.deepEqual(again.app.auth.status(), { signed_in: true, project_name: "Kept" });
  assert.equal(again.mock.requests.length, 0, "starting makes no request to Scenario");
});
