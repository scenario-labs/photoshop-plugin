"use strict";
// Sign in with Scenario in the panel (SPEC 4.6), in a DOM built from the
// real index.html, booted through main.js against a mock identity provider
// and a mock Scenario API with two teams of two projects and a team without
// one: the code while the browser page is open, the chooser by team, the
// header and its tooltip, Projects with Choose another project, a declined
// sign-in, Cancel, and Sign out. Tokens are made per test.

const test = require("node:test");
const assert = require("node:assert/strict");
const main = require("../../plugin/src/main.js");
const view = require("../../plugin/src/ui/account-view.js");
const { createFakeDocument } = require("../helpers/fake-dom.js");
const { startMockScenario, teamsFixture } = require("../helpers/mock-scenario.js");
const { startMockOAuth } = require("../helpers/mock-oauth.js");
const { fakeHost, uxpWebSocket, freePort, newToken, waitFor } = require("../helpers/fakes.js");

// sleep: the identity provider's poll wait (instant unless a test holds it).
async function bootPanel(t, { oauth: oauthOpts = {}, teams = teamsFixture(), sleep = async () => {} } = {}) {
  const idp = await startMockOAuth(oauthOpts);
  const box = { teams };
  const mock = await startMockScenario({ oauth: { subjectOf: (token) => idp.subjectOf(token), teams: () => box.teams } });
  const port = await freePort();
  const host = fakeHost({
    WebSocket: uxpWebSocket({ rewrite: (url) => url.replace(":9890", `:${port}`) }),
    secure: [["scenario.pairing_token", newToken()]]
  });
  const doc = createFakeDocument();
  const app = await main.boot({ host, document: doc, console: null, apiBaseUrl: mock.url, oauthTarget: idp.target, oauthSleep: sleep });
  t.after(async () => {
    app.link.stop();
    await mock.close();
    await idp.close();
  });
  return { app, host, doc, mock, idp, box };
}

function chooserRows(doc) {
  return doc.byId("choose-list").children.map((n) => (n.className === "list-team" ? `# ${n.textContent}` : n.className === "note list-none" ? `  (${n.textContent})` : `  ${n.children[1].textContent}${n.getAttribute("selected") === "" ? " *" : ""}`));
}

function rowOf(doc, projectId) {
  return doc.byId("choose-list").children.find((n) => n.getAttribute && n.getAttribute("data-project") === projectId);
}

test("Sign in with Scenario: the code while the page is open, then the chooser by team; a project signs in", async (t) => {
  // The polls wait until the test has seen the code.
  let release;
  const held = new Promise((r) => (release = r));
  const { doc, app, host, mock, idp } = await bootPanel(t, { oauth: { approveAfter: 3 }, sleep: () => held });
  assert.ok(doc.shown("view-signin"));
  assert.equal(doc.text("signin-browser"), "Sign in with Scenario");
  doc.byId("signin-browser").click();
  // While the browser page is open: the code, Open the page again, Copy code, Cancel.
  await waitFor(() => doc.shown("signin-code-box"), { label: "code shown" });
  const code = doc.text("signin-code");
  assert.match(code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal(doc.text("signin-code-label"), view.TEXT.code_label);
  assert.equal(doc.text("signin-code-wait"), view.TEXT.code_wait);
  assert.deepEqual(host.opened, [`https://sign-in.example.invalid/device?user_code=${code}`]);
  assert.ok(doc.byId("signin-browser").getAttribute("disabled") !== null && doc.byId("signin-save").getAttribute("disabled") !== null, "one sign-in at a time");
  release();

  await waitFor(() => doc.shown("view-choose"), { label: "chooser shown" });
  assert.ok(!doc.shown("signin-code-box"));
  assert.equal(doc.text("choose-note"), view.TEXT.choose_note);
  assert.deepEqual(chooserRows(doc), ["# Personal", "  Sketches", "  Tests", "# Studio", "  Film", "  Poster", "# Empty team", `  (${view.TEXT.choose_none})`]);
  assert.equal(app.auth.status().signed_in, false, "nothing saved before a project is chosen");

  rowOf(doc, "project_poster").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });
  assert.equal(doc.text("project-label"), "Poster");
  assert.equal(doc.byId("project").getAttribute("title"), "Project: Studio / Poster. Click to switch project.");
  assert.deepEqual([doc.text("account-banner-1"), doc.text("account-banner-2"), doc.text("account-banner-3")], ["Connected to Scenario", "Project: Studio / Poster", `Signed in as ${idp.state.email}`]);
  assert.deepEqual(app.auth.status(), { signed_in: true, project_name: "Poster" });
  // Reads of the signed-in panel carry the chosen project; the team list none.
  const before = mock.requests.length;
  assert.equal((await app.auth.testConnection({})).ok, true);
  assert.deepEqual(mock.requests.slice(before).map((r) => `${r.path} ${r.query.projectId || "-"}`), ["/v1/models project_poster", "/v1/teams -"]);
});

test("Projects: Choose another project lists the teams with the current one checked; Settings signs out of Scenario", async (t) => {
  const { doc, app, idp } = await bootPanel(t);
  doc.byId("signin-browser").click();
  await waitFor(() => doc.shown("view-choose"), { label: "chooser" });
  rowOf(doc, "project_film").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });

  doc.byId("project").click();
  assert.ok(doc.shown("view-projects"));
  assert.ok(doc.shown("projects-choose"), "Choose another project for a browser sign-in");
  const rows = doc.byId("projects-list").children;
  assert.deepEqual(rows.map((r) => [r.children[1].textContent, r.children[2].textContent]), [["Film", "Studio"]], "the project, then its team");
  doc.byId("projects-choose").click();
  await waitFor(() => chooserRows(doc).length > 0, { label: "chooser listed" });
  assert.ok(chooserRows(doc).includes("  Film *"), "the current project is checked");
  rowOf(doc, "project_tests").click();
  await waitFor(() => doc.text("project-label") === "Tests", { label: "switched" });
  assert.equal(idp.state.requests.filter((r) => r.path === "/oauth/device_authorization").length, 1, "the same sign-in");
  doc.byId("project").click();
  assert.deepEqual(doc.byId("projects-list").children.map((r) => [r.children[1].textContent, r.children[2].textContent]), [["Film", "Studio"], ["Tests", "Personal"]]);

  assert.equal(app.menu.invoke("settings"), true);
  assert.equal(doc.text("settings-signout-note"), view.TEXT.sign_out_browser_note);
  doc.byId("settings-signout").click();
  assert.equal(doc.text("settings-note"), view.TEXT.sign_out_browser_confirm);
  doc.byId("settings-signout").click();
  await waitFor(() => doc.text("project-label") === "Not signed in", { label: "signed out" });
  assert.equal(doc.text("settings-note"), "Signed out. Your Scenario sign-in is removed from this computer.");
  assert.equal(idp.state.revoked.length, 1);
});

test("a declined sign-in says so with Sign in again; Cancel stops waiting; Back from the chooser saves nothing", async (t) => {
  const declined = await bootPanel(t, { oauth: { outcome: "deny" } });
  declined.doc.byId("signin-browser").click();
  await waitFor(() => declined.doc.shown("signin-status"), { label: "failure shown" });
  assert.equal(declined.doc.text("signin-status-text"), "The sign-in was declined in the browser.");
  assert.ok(declined.doc.shown("signin-act-sign_in_again") && !declined.doc.shown("signin-act-retry"));
  assert.equal(declined.doc.text("signin-act-sign_in_again"), "Sign in again");
  assert.ok(!declined.doc.shown("signin-code-box"));

  const waiting = await bootPanel(t, { oauth: { approveAfter: 100000 }, sleep: () => new Promise((r) => setTimeout(r, 10)) });
  waiting.doc.byId("signin-browser").click();
  await waitFor(() => waiting.doc.shown("signin-code-box"), { label: "code shown" });
  // Cancel runs even when a check fails: the sign-in would otherwise poll on.
  try {
    waiting.doc.byId("signin-code-copy").click();
    await waitFor(() => waiting.host.clipboard === waiting.doc.text("signin-code"), { label: "code copied" });
    await waitFor(() => waiting.doc.text("signin-code-note") === view.TEXT.code_copied, { label: "copy confirmed" });
    waiting.host.clipboardWrite = async () => {
      throw new Error("the clipboard is busy");
    };
    waiting.doc.byId("signin-code-copy").click();
    await waitFor(() => waiting.doc.text("signin-code-note") === "Could not copy: the clipboard is busy.", { label: "copy failure shown" });
  } finally {
    waiting.doc.byId("signin-code-cancel").click();
  }
  await waitFor(() => !waiting.doc.shown("signin-code-box"), { label: "stopped" });
  assert.ok(waiting.doc.shown("view-signin") && !waiting.doc.shown("signin-status"), "a cancel is not a failure");
  assert.equal(waiting.doc.byId("signin-browser").getAttribute("disabled"), null);

  const back = await bootPanel(t);
  back.doc.byId("signin-browser").click();
  await waitFor(() => back.doc.shown("view-choose"), { label: "chooser" });
  back.doc.byId("choose-back").click();
  assert.ok(back.doc.shown("view-signin"));
  await waitFor(() => back.idp.state.revoked.length === 1, { label: "revoked" });
  assert.equal(back.app.auth.status().signed_in, false);
});

test("Back from Add project's sign-in view stops a browser sign-in in progress", async (t) => {
  const { doc, idp } = await bootPanel(t, { sleep: () => new Promise((r) => setTimeout(r, 10)) });
  doc.byId("signin-browser").click();
  await waitFor(() => doc.shown("view-choose"), { label: "chooser" });
  rowOf(doc, "project_film").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });

  idp.state.approveAfter = Infinity; // the second sign-in waits in the browser
  doc.byId("project").click();
  doc.byId("projects-add").click();
  assert.ok(doc.shown("signin-back"));
  doc.byId("signin-browser").click();
  await waitFor(() => doc.shown("signin-code-box"), { label: "code shown" });
  doc.byId("signin-back").click();
  assert.ok(doc.shown("view-main"));

  idp.state.approveAfter = 0; // approved in the browser after leaving
  const polls = idp.state.polls;
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(idp.state.polls - polls <= 1, "no more polling once left");
  assert.ok(!doc.shown("view-choose"));
  assert.equal(doc.text("project-label"), "Film");
});

test("leaving the sign-in view by the panel menu, Jobs or the header while the code waits stops the sign-in", async (t) => {
  const { doc, app, idp } = await bootPanel(t, { sleep: () => new Promise((r) => setTimeout(r, 10)) });
  doc.byId("signin-browser").click();
  await waitFor(() => doc.shown("view-choose"), { label: "chooser" });
  rowOf(doc, "project_film").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });

  const routes = [
    ["the panel menu", () => app.menu.invoke("settings"), "view-settings"],
    ["Jobs", () => app.menu.invoke("jobs"), "view-jobs"],
    ["the header", () => doc.byId("project").click(), "view-projects"]
  ];
  for (const [route, leave, view] of routes) {
    idp.state.approveAfter = Infinity; // the new sign-in waits in the browser
    doc.byId("project").click();
    doc.byId("projects-add").click();
    doc.byId("signin-browser").click();
    await waitFor(() => doc.shown("signin-code-box"), { label: `code shown (${route})` });
    leave();
    assert.ok(doc.shown(view), `${route} left the sign-in view`);

    idp.state.approveAfter = 0; // approved in the browser after leaving
    const polls = idp.state.polls;
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(idp.state.polls - polls <= 1, `no more polling once left by ${route}`);
    assert.ok(!doc.shown("view-choose"), `no chooser after leaving by ${route}`);
    assert.equal(doc.text("project-label"), "Film");
  }
  assert.equal(app.auth.list().length, 1);
});

test("a chosen project that is gone: Test connection says so and Choose a project opens the chooser", async (t) => {
  const { doc, app, box } = await bootPanel(t);
  doc.byId("signin-browser").click();
  await waitFor(() => doc.shown("view-choose"), { label: "chooser" });
  rowOf(doc, "project_sketches").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });
  box.teams = teamsFixture().map((team) => ({ ...team, projects: team.projects.filter((p) => p.id !== "project_sketches") }));
  assert.equal(app.menu.invoke("settings"), true);
  doc.byId("settings-test").click();
  await waitFor(() => doc.shown("settings-status"), { label: "tested" });
  assert.equal(doc.text("settings-status-text"), "The chosen project is no longer available. Choose another one.");
  assert.ok(doc.shown("settings-act-choose_project"));
  doc.byId("settings-act-choose_project").click();
  await waitFor(() => doc.shown("view-choose") && chooserRows(doc).length > 0, { label: "chooser" });
  assert.ok(!chooserRows(doc).some((r) => r.includes("Sketches")));
  rowOf(doc, "project_film").click();
  await waitFor(() => doc.text("project-label") === "Film", { label: "chosen" });
});

test("Retry on the sign-in view repeats the browser sign-in after it failed offline", async (t) => {
  let offline = true;
  const { doc, idp } = await bootPanel(t, { oauth: { handle: (r) => (offline && r.path === "/oauth/device_authorization" ? { destroy: true } : undefined) } });
  doc.byId("signin-browser").click();
  await waitFor(() => doc.shown("signin-status"), { label: "failure" });
  assert.equal(doc.text("signin-status-text"), "No connection to Scenario. Check your network.");
  offline = false;
  doc.byId("signin-act-retry").click();
  await waitFor(() => doc.shown("view-choose"), { label: "retried as a browser sign-in" });
  assert.equal(idp.state.requests.filter((r) => r.path === "/oauth/device_authorization").length, 2);
});

test("leaving the chooser by the panel menu ends the waiting sign-in; Choose another project then lists the saved one", async (t) => {
  const { doc, app, idp, box } = await bootPanel(t);
  doc.byId("signin-browser").click();
  await waitFor(() => doc.shown("view-choose"), { label: "chooser" });
  rowOf(doc, "project_film").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });

  // A second sign-in, of an account with other projects, left at its chooser.
  box.teams = [{ id: "team_other", name: "Other", projects: [{ id: "project_a", name: "A" }, { id: "project_b", name: "B" }] }];
  doc.byId("project").click();
  doc.byId("projects-add").click();
  doc.byId("signin-browser").click();
  await waitFor(() => doc.shown("view-choose") && chooserRows(doc).includes("# Other"), { label: "second chooser" });
  assert.equal(app.menu.invoke("settings"), true);
  assert.equal(app.auth.waiting(), false);
  await waitFor(() => idp.state.revoked.length === 1, { label: "the left sign-in revoked" });

  box.teams = teamsFixture();
  doc.byId("project").click();
  doc.byId("projects-choose").click();
  await waitFor(() => chooserRows(doc).length > 0, { label: "chooser listed" });
  assert.ok(chooserRows(doc).includes("  Film *"), "the saved sign-in's projects, its own checked");
  assert.ok(!chooserRows(doc).includes("# Other"));
});

test("Back while the chosen project is saved keeps that sign-in; a save that fails after the chooser was left revokes it", async (t) => {
  const { doc, app, host, idp } = await bootPanel(t);
  doc.byId("signin-browser").click();
  await waitFor(() => doc.shown("view-choose"), { label: "chooser" });
  const write = host.secureSet;
  let onWrite = () => doc.byId("choose-back").click();
  host.secureSet = async (key, value) => {
    const fn = onWrite;
    onWrite = null;
    if (fn) fn();
    return write(key, value);
  };
  rowOf(doc, "project_film").click();
  await waitFor(() => doc.shown("view-main"), { label: "signed in" });
  assert.equal(app.auth.status().signed_in, true);
  assert.equal(idp.state.revoked.length, 0, "the refresh token being saved is not revoked");

  const second = await bootPanel(t);
  second.doc.byId("signin-browser").click();
  await waitFor(() => second.doc.shown("view-choose"), { label: "second chooser" });
  second.host.secureSet = async () => {
    second.app.menu.invoke("settings");
    throw new Error("secure storage refused");
  };
  rowOf(second.doc, "project_film").click();
  await waitFor(() => second.idp.state.revoked.length === 1, { label: "revoked after the failed save" });
  assert.equal(second.app.auth.waiting(), false);
  assert.equal(second.app.auth.status().signed_in, false);
});
