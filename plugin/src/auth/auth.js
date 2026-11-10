"use strict";
// Sign-in (SPEC 4.2, 3.13): Save and test, Test connection, the project
// switch and Sign out, on top of accounts.js (storage) and the scenario
// client (requests).
//
// Save and test runs two free reads with the pasted pair, and saves it only
// when Scenario accepts it:
//   1. an authenticated read (private models): 401, or 403 "Given APIKey
//      does not exists", means the pair is wrong;
//   2. GET /v1/projects, which returns the key's project with its keys: the
//      plugin finds its own key by apiKeyId and reads its scope (team or
//      project) and role. A Reader key is refused at once.
// The listing also names the project's members (with emails) and every key
// id. Only the project name, the project id and this key's role and scope
// leave identify(); the rest is dropped and never logged or stored.
// The spec's dry run of the default Image model is not part of this build
// (price checks come with the catalog), so a key that passes says
// "Connected" without claiming it can run models.
//
// Outcomes carry a state for the panel, never the key or the secret.
//
// Sign in with Scenario (SPEC 4.6) runs the device sign-in of oauth.js:
// the panel shows the code while the browser page is open, then the
// account's teams and projects are read (GET /v1/teams, no project). One
// usable project is chosen at once; with several, the panel asks, and
// nothing is saved until a project is chosen. Test connection reads the
// models of the chosen project and the list again, so a project that is
// gone (deleted, or the role removed) says so instead of failing each call.

var API = require("../../../shared/scenario-api.json");
var split = require("./split.js");
var clientMod = require("../scenario/client.js");
var oauthMod = require("./oauth.js");
var accountsMod = require("./accounts.js");

var STEPS = 2;
// Error types that end a check at once, with the state the panel shows.
var STOP = {
  Unauthorized: "key_refused",
  Offline: "offline",
  NoApiAccess: "no_api_access",
  KeyCannotGenerate: "cannot_generate",
  PlanLimit: "plan_limit",
  InsufficientCredits: "plan_limit",
  RateLimited: "busy",
  NotSignedIn: "not_signed_in"
};
// The error type each state reports in diagnostics and Copy error.
var STATE_TYPES = {
  key_refused: "Unauthorized",
  offline: "Offline",
  no_api_access: "NoApiAccess",
  cannot_generate: "KeyCannotGenerate",
  team_key: "KeyCannotGenerate",
  plan_limit: "PlanLimit",
  busy: "RateLimited",
  failed: "Internal",
  storage_failed: "Internal",
  missing: "InvalidParameter",
  not_signed_in: "NotSignedIn",
  browser_denied: "Unauthorized",
  browser_expired: "NotSignedIn",
  browser_failed: "Internal",
  browser_check_failed: "Internal",
  session_ended: "NotSignedIn",
  no_project: "Forbidden",
  project_gone: "Forbidden"
};
// What an OAuthError's state reads as.
var OAUTH_STATES = { denied: "browser_denied", expired: "browser_expired", cancelled: "cancelled", offline: "offline", ended: "session_ended", failed: "browser_failed" };

function readString(v) {
  return typeof v === "string" && v ? v : null;
}

// What the project listing says about one key. Pure, for the tests.
// Returns { scope: "team"|"project"|null, role: string|null,
//           project: {id, name}|null }.
function identify(projects, key) {
  var list = Array.isArray(projects) ? projects.filter(function (p) { return p && typeof p === "object"; }) : [];
  var hit = null;
  var hitProject = null;
  for (var i = 0; i < list.length && !hit; i++) {
    var keys = Array.isArray(list[i].keys) ? list[i].keys : [];
    for (var j = 0; j < keys.length; j++) {
      if (keys[j] && keys[j].apiKeyId === key) {
        hit = keys[j];
        hitProject = list[i];
        break;
      }
    }
  }
  function byId(id) {
    for (var n = 0; n < list.length; n++) if (list[n].id === id) return list[n];
    return null;
  }
  function asProject(p) {
    return p ? { id: readString(p.id), name: readString(p.name) } : null;
  }
  if (hit) {
    var scope = hit.scope === "team" || hit.scope === "project" ? hit.scope : null;
    if (scope === "team") return { scope: "team", role: readString(hit.role), project: null };
    var owner = byId(hit.ownerId) || hitProject;
    var role = readString(hit.role);
    if (Array.isArray(hit.projects) && owner) {
      for (var r = 0; r < hit.projects.length; r++) {
        var entry = hit.projects[r];
        if (entry && entry.projectId === owner.id && readString(entry.role)) role = entry.role;
      }
    }
    return { scope: scope, role: role, project: asProject(owner) };
  }
  if (list.length === 1) return { scope: null, role: null, project: asProject(list[0]) };
  return { scope: null, role: null, project: null };
}

// The teams of GET /v1/teams and the projects the account may use in each,
// by name, teams without a project last: Scenario lists them in no stable
// order (live 2026-11-03, two reads minutes apart). Records without an id
// are skipped; a name falls back to the id. Pure, for the tests.
function teamsFrom(body) {
  var out = [];
  var list = body && Array.isArray(body.teams) ? body.teams : [];
  function name(r) {
    return typeof r.name === "string" && r.name.trim() ? r.name.trim() : r.id;
  }
  function byName(a, b) {
    var x = a.name.toLowerCase();
    var y = b.name.toLowerCase();
    if (x !== y) return x < y ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!t || typeof t.id !== "string" || !t.id) continue;
    var projects = [];
    var ps = Array.isArray(t.projects) ? t.projects : [];
    for (var j = 0; j < ps.length; j++) {
      if (ps[j] && typeof ps[j].id === "string" && ps[j].id) projects.push({ id: ps[j].id, name: name(ps[j]) });
    }
    out.push({ id: t.id, name: name(t), projects: projects.sort(byName) });
  }
  return out.sort(function (a, b) {
    if (!a.projects.length !== !b.projects.length) return a.projects.length ? -1 : 1;
    return byName(a, b);
  });
}

// Every (team, project) pair, as the chooser lists them.
function choicesOf(teams) {
  var out = [];
  for (var i = 0; i < teams.length; i++) {
    for (var j = 0; j < teams[i].projects.length; j++) {
      out.push({ team_id: teams[i].id, team_name: teams[i].name, project_id: teams[i].projects[j].id, project_name: teams[i].projects[j].name });
    }
  }
  return out;
}

function findChoice(teams, projectId) {
  var all = choicesOf(teams);
  for (var i = 0; i < all.length; i++) if (all[i].project_id === projectId) return all[i];
  return null;
}

function cannotGenerate(role) {
  if (!role) return false;
  return API.roles_that_cannot_generate.roles.indexOf(String(role).toLowerCase()) >= 0;
}

// o: { client, accounts, redactor, log(text), recordError(type),
//      oauth (oauth.js client), openPage(url) -> Promise (the browser),
//      now() }
function createAuth(o) {
  var client = o.client;
  var accounts = o.accounts;
  var redactor = o.redactor;
  var log = o.log || function () {};
  var recordError = o.recordError || function () {};
  var oauth = o.oauth || null;
  var now =
    o.now ||
    function () {
      return Date.now();
    };
  var busy = false;
  var attempt = null; // the browser sign-in in progress: { cancelled }
  var pending = null; // a sign-in waiting for its project: { signIn, tokens, session, teams }

  function fail(state, err, extra) {
    var out = { ok: false, state: state, type: STATE_TYPES[state] || (err && err.type) || "Internal", scenario_message: (err && err.scenarioMessage) || null, role: null };
    if (extra) for (var k in extra) out[k] = extra[k];
    recordError(out.type);
    return out;
  }

  async function listProjects(pair, hooks) {
    var cfg = API.sign_in.projects;
    var all = [];
    var pageToken = null;
    for (var page = 0; page < cfg.max_pages; page++) {
      var query = { pageSize: String(cfg.page_size) };
      if (pageToken) query.paginationToken = pageToken;
      var res = await client.request("GET", cfg.path, { query: query, credentials: pair, onWait: hooks.onWait });
      var body = res.body;
      if (!body || !Array.isArray(body.projects)) break;
      all = all.concat(body.projects);
      if (identify(all, pair.key).scope) break;
      pageToken = readString(body.nextPaginationToken);
      if (!pageToken) break;
    }
    return all;
  }

  // The two reads. Resolves an outcome; never rejects.
  async function check(pair, hooks) {
    hooks = hooks || {};
    var onStep = hooks.onStep || function () {};
    var first = null;
    onStep(1, STEPS);
    try {
      await client.request("GET", API.sign_in.auth_check.path, { query: API.sign_in.auth_check.query, credentials: pair, onWait: hooks.onWait });
    } catch (e) {
      first = e;
    }
    if (first && STOP[first.type]) return fail(STOP[first.type], first);
    if (first && first.type !== "Forbidden") return fail("failed", first);

    onStep(2, STEPS);
    var ident = null;
    var second = null;
    try {
      ident = identify(await listProjects(pair, hooks), pair.key);
    } catch (e) {
      second = e;
    }
    if (second && STOP[second.type]) return fail(STOP[second.type], second);
    if (ident && ident.scope === "team") return fail("team_key", first);
    if (first) return fail("cannot_generate", first);
    if (ident && cannotGenerate(ident.role)) return fail("cannot_generate", null, { role: String(ident.role).toLowerCase() });
    // A 403 or an odd answer on the listing leaves the name unknown, nothing more.
    var project = ident && ident.project ? ident.project : null;
    return { ok: true, project_name: project ? project.name : null, project_id: project ? project.id : null, role: ident ? ident.role : null, scope: ident ? ident.scope : null };
  }

  function guard(fn) {
    return async function () {
      if (busy) return { ok: false, state: "in_progress", type: "Internal", scenario_message: null };
      busy = true;
      try {
        return await fn.apply(null, arguments);
      } finally {
        busy = false;
      }
    };
  }

  // Save and test (SPEC 4.2 step 5). The pair is saved only if Scenario
  // accepts it and the listing does not show a key that cannot generate.
  var saveAndTest = guard(async function (keyText, secretText, hooks) {
    var key = split.cleanPart(keyText);
    var secret = split.cleanPart(secretText);
    if (!key || !secret) return { ok: false, state: "missing", type: "InvalidParameter", scenario_message: null };
    var pair = { key: key, secret: secret };
    if (redactor) {
      redactor.add(key);
      redactor.add(secret);
      redactor.add(clientMod.basicToken(pair));
    }
    log("sign-in: testing a key");
    var out = await check(pair, hooks);
    if (!out.ok) {
      log("sign-in: not saved (" + out.type + ")");
      return out;
    }
    // A key for the only project of a browser sign-in replaces that sign-in:
    // it ends at Scenario too, as Sign out ends it.
    var ending = await Promise.all(accounts.sessionsEndedBy(out.project_id).map(accounts.refreshTokenOf));
    var account;
    try {
      account = await accounts.save(pair, { project_name: out.project_name, project_id: out.project_id });
    } catch (e) {
      log("sign-in: secure storage refused the key");
      return fail("storage_failed", null);
    }
    for (var i = 0; i < ending.length; i++) if (ending[i] && oauth) await oauth.revoke(ending[i]);
    if (ending.length) log("sign-in: the key replaced a browser sign-in's only project; that sign-in ended");
    log("sign-in: key saved (" + accounts.list().length + " project(s) saved" + (account.project_name ? "" : ", no project name from the API") + ")");
    return { ok: true, account: account };
  });

  // Test connection (SPEC 3.14): the same reads with the saved pair.
  var testConnection = guard(async function (hooks) {
    var pair = accounts.credentials();
    var c = accounts.current();
    if (!pair || !c) return fail("not_signed_in", null);
    if (c.kind === "browser") {
      var b = await checkBrowser(c, hooks);
      log("test connection: " + (b.ok ? "ok" : b.type));
      return b.ok ? { ok: true, account: accounts.current() } : b;
    }
    if (redactor) redactor.add(clientMod.basicToken(pair));
    var out = await check(pair, hooks);
    if (!out.ok) {
      log("test connection: " + out.type);
      return out;
    }
    try {
      await accounts.update(c.id, { project_name: out.project_name, project_id: out.project_id });
    } catch (e) {
      // the name is display only
    }
    log("test connection: ok");
    return { ok: true, account: accounts.current() };
  });

  // ---- Sign in with Scenario ----

  async function readTeams(creds, hooks) {
    var res = await client.request("GET", API.sign_in.teams.path, { credentials: creds, unscoped: true, onWait: hooks && hooks.onWait });
    return teamsFrom(res.body);
  }

  // A browser sign-in's read that failed, in words for a sign-in, never a key.
  function browserFail(e, state) {
    if (e && (e.type === "NotSignedIn" || e.type === "Unauthorized")) return fail("session_ended", e);
    if (e && e.type !== "Forbidden" && STOP[e.type]) return fail(STOP[e.type], e);
    return fail(state, e, { scenario_message: (e && (e.scenarioMessage || e.message)) || null });
  }

  function oauthFail(e) {
    var state = (e && OAUTH_STATES[e.state]) || (e && e.type && STOP[e.type]) || "failed";
    if (state === "cancelled") return { ok: false, state: "cancelled", type: null, scenario_message: null };
    return fail(state, null, { scenario_message: e && e.message && state === "browser_failed" ? e.message : null });
  }

  // The device sign-in (SPEC 4.6). hooks: { onCode({user_code, page,
  // verification_uri, expires_at}), onStep(step, total), onWait(seconds) }.
  // Resolves { ok, account } when one project was used, { ok, choose, teams }
  // when the panel must ask, or a failure; never rejects.
  var signInWithBrowser = guard(async function (hooks) {
    hooks = hooks || {};
    if (!oauth) return fail("browser_failed", null);
    var me = { cancelled: false };
    attempt = me;
    // A sign-in still waiting for its project is replaced: its token goes.
    if (pending) {
      await oauth.revoke(pending.latest());
      pending = null;
    }
    try {
      log("browser sign-in: started");
      var device;
      try {
        device = await oauth.startDevice();
      } catch (e) {
        log("browser sign-in: did not start (" + ((e && e.state) || "failed") + ")");
        return oauthFail(e);
      }
      if (hooks.onCode) hooks.onCode({ user_code: device.user_code, page: device.page, verification_uri: device.verification_uri, expires_at: device.expires_at });
      openPage(device.page);
      var tokens;
      try {
        tokens = await oauth.waitForApproval(device, {
          cancelled: function () {
            return me.cancelled;
          },
          onWait: hooks.onWait
        });
      } catch (e) {
        log("browser sign-in: " + ((e && e.state) || "failed"));
        return oauthFail(e);
      }
      if (me.cancelled) {
        await oauth.revoke(tokens.refresh_token);
        return { ok: false, state: "cancelled", type: null, scenario_message: null };
      }
      log("browser sign-in: approved, reading teams");
      if (hooks.onStep) hooks.onStep(1, 1);
      var latest = tokens.refresh_token;
      var session = oauthMod.createSession({
        oauth: oauth,
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        expires_at: tokens.expires_at,
        now: now,
        save: async function (rt) {
          latest = rt;
        }
      });
      var teams;
      try {
        teams = await readTeams({ session: session, project_id: null }, hooks);
      } catch (e) {
        await oauth.revoke(latest);
        log("browser sign-in: teams unavailable (" + ((e && e.type) || "Internal") + ")");
        var f = browserFail(e, "browser_failed");
        return f.state === "session_ended" ? fail("browser_failed", e, { scenario_message: (e && e.message) || null }) : f;
      }
      // Left with Back or Cancel while the teams were read: nothing is saved.
      if (me.cancelled) {
        await oauth.revoke(latest);
        return { ok: false, state: "cancelled", type: null, scenario_message: null };
      }
      var signIn = { issuer: oauth.issuer, client_id: oauth.target.client_id, subject: tokens.subject, email: tokens.email || null, refresh_token: latest };
      var choices = choicesOf(teams);
      if (!choices.length) {
        await oauth.revoke(latest);
        log("browser sign-in: no usable project");
        return fail("no_project", null);
      }
      if (choices.length === 1) return await useChoice(signIn, choices[0], session, tokens);
      pending = { signIn: signIn, tokens: tokens, session: session, teams: teams, latest: function () { return latest; } };
      log("browser sign-in: " + choices.length + " projects to choose from");
      return { ok: true, choose: true, teams: teams };
    } finally {
      if (attempt === me) attempt = null;
    }
  });

  function openPage(url) {
    if (!o.openPage) return;
    Promise.resolve()
      .then(function () {
        return o.openPage(url);
      })
      .catch(function () {
        // Photoshop asked and the person said no: the code stays on screen
      });
  }

  async function useChoice(signIn, choice, session, tokens) {
    var account;
    // The same person signing in again replaces their saved sign-in: the
    // refresh token it held is revoked once the new one is saved.
    var previous = await accounts.refreshTokenOf(accountsMod.sessionId(signIn.issuer, signIn.subject));
    try {
      if (session) signIn.refresh_token = session.refreshToken();
      // The sign-in's access token is still valid: the first request needs no refresh.
      account = await accounts.saveBrowser(signIn, choice, tokens ? { access_token: tokens.access_token, expires_at: tokens.expires_at } : null);
    } catch (e) {
      log("browser sign-in: secure storage refused the sign-in");
      return fail("storage_failed", null);
    }
    pending = null;
    if (previous && previous !== signIn.refresh_token && oauth) await oauth.revoke(previous);
    log("browser sign-in: saved (" + accounts.list().length + " project(s) saved)");
    return { ok: true, account: account };
  }

  // The project chosen in the panel, for the sign-in that waits for one or
  // for the current browser sign-in (Choose another project).
  var chooseProject = guard(async function (projectId) {
    if (pending) {
      var choice = findChoice(pending.teams, projectId);
      if (!choice) return fail("project_gone", null);
      pending.signIn.refresh_token = pending.latest();
      // Back or Cancel while the choice is saved leaves it alone: its refresh
      // token is the one being saved.
      var saving = pending;
      saving.saving = true;
      try {
        return await useChoice(saving.signIn, choice, saving.session, saving.tokens);
      } finally {
        saving.saving = false;
      }
    }
    var c = accounts.current();
    if (!c || c.kind !== "browser") return fail("not_signed_in", null);
    var teams;
    try {
      teams = await readTeams({ session: await accounts.session(c.session), project_id: null });
    } catch (e) {
      return browserFail(e, "browser_check_failed");
    }
    var picked = findChoice(teams, projectId);
    if (!picked) return fail("project_gone", null);
    try {
      var account = await accounts.chooseProject(c.session, picked);
      log("project chosen (" + accounts.list().length + " project(s) saved)");
      return { ok: true, account: account };
    } catch (e) {
      return fail("storage_failed", null);
    }
  });

  // The teams and projects of the current browser sign-in, for the chooser.
  async function listChoices() {
    if (pending) return { ok: true, teams: pending.teams };
    var c = accounts.current();
    if (!c || c.kind !== "browser") return fail("not_signed_in", null);
    try {
      return { ok: true, teams: await readTeams({ session: await accounts.session(c.session), project_id: null }) };
    } catch (e) {
      return browserFail(e, "browser_check_failed");
    }
  }

  // Cancels the sign-in in progress, or forgets one waiting for its project
  // (its refresh token is revoked), unless that project is being saved.
  function cancelBrowser() {
    if (attempt) attempt.cancelled = true;
    if (pending && !pending.saving) {
      if (oauth) oauth.revoke(pending.latest());
      pending = null;
      log("browser sign-in: cancelled before choosing a project");
    }
  }

  // Test connection for a browser sign-in: the chosen project's models, then
  // the list, which also refreshes the team and project names.
  async function checkBrowser(c, hooks) {
    hooks = hooks || {};
    var creds = accounts.credentials();
    if (hooks.onStep) hooks.onStep(1, STEPS);
    try {
      await client.request("GET", API.sign_in.auth_check.path, { query: API.sign_in.auth_check.query, onWait: hooks.onWait });
    } catch (e) {
      // A 403 here can be a project that is gone: the list below tells.
      if (!e || e.type !== "Forbidden") return browserFail(e, "browser_check_failed");
    }
    if (hooks.onStep) hooks.onStep(2, STEPS);
    var teams;
    try {
      teams = await readTeams({ session: creds.session, project_id: null }, hooks);
    } catch (e) {
      return browserFail(e, "browser_check_failed");
    }
    var choice = findChoice(teams, c.project_id);
    if (!choice) return fail("project_gone", null);
    try {
      await accounts.update(c.id, { project_name: choice.project_name, project_id: choice.project_id, team_name: choice.team_name });
    } catch (e) {
      // the name is display only
    }
    return { ok: true };
  }

  async function switchTo(id) {
    var c = await accounts.switchTo(id);
    log("project switched (" + accounts.list().length + " project(s) saved)");
    return c;
  }

  async function signOut(id) {
    var target = id || (accounts.current() && accounts.current().id);
    if (!target) return accounts.summary();
    // A browser row ends its whole sign-in, at Scenario and here, with every
    // project it saved.
    var sid = accounts.sessionOf(target);
    if (sid && oauth) {
      var rt = await accounts.refreshTokenOf(sid);
      if (rt) await oauth.revoke(rt);
    }
    var s = await accounts.remove(target);
    log((sid ? "signed out of a browser sign-in" : "signed out of one project") + " (" + accounts.list().length + " still saved)");
    return s;
  }

  return {
    saveAndTest: saveAndTest,
    signInWithBrowser: signInWithBrowser,
    chooseProject: chooseProject,
    listChoices: listChoices,
    cancelBrowser: cancelBrowser,
    waiting: function () {
      return !!pending;
    },
    testConnection: testConnection,
    switchTo: switchTo,
    signOut: signOut,
    // What scenario_status reports: no key, no secret, no project id.
    status: function () {
      var s = accounts.summary();
      return { signed_in: s.signed_in, project_name: s.project_name };
    },
    current: accounts.current,
    list: accounts.list
  };
}

module.exports = { createAuth: createAuth, identify: identify, cannotGenerate: cannotGenerate, teamsFrom: teamsFrom, choicesOf: choicesOf, STATE_TYPES: STATE_TYPES };
