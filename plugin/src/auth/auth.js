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

var API = require("../../../shared/scenario-api.json");
var split = require("./split.js");
var clientMod = require("../scenario/client.js");

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
  not_signed_in: "NotSignedIn"
};

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

function cannotGenerate(role) {
  if (!role) return false;
  return API.roles_that_cannot_generate.roles.indexOf(String(role).toLowerCase()) >= 0;
}

// o: { client, accounts, redactor, log(text), recordError(type) }
function createAuth(o) {
  var client = o.client;
  var accounts = o.accounts;
  var redactor = o.redactor;
  var log = o.log || function () {};
  var recordError = o.recordError || function () {};
  var busy = false;

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
    var account;
    try {
      account = await accounts.save(pair, { project_name: out.project_name, project_id: out.project_id });
    } catch (e) {
      log("sign-in: secure storage refused the key");
      return fail("storage_failed", null);
    }
    log("sign-in: key saved (" + accounts.list().length + " project(s) saved" + (account.project_name ? "" : ", no project name from the API") + ")");
    return { ok: true, account: account };
  });

  // Test connection (SPEC 3.14): the same reads with the saved pair.
  var testConnection = guard(async function (hooks) {
    var pair = accounts.credentials();
    var c = accounts.current();
    if (!pair || !c) return fail("not_signed_in", null);
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

  async function switchTo(id) {
    var c = await accounts.switchTo(id);
    log("project switched (" + accounts.list().length + " project(s) saved)");
    return c;
  }

  async function signOut(id) {
    var target = id || (accounts.current() && accounts.current().id);
    if (!target) return accounts.summary();
    var s = await accounts.remove(target);
    log("signed out of one project (" + accounts.list().length + " still saved)");
    return s;
  }

  return {
    saveAndTest: saveAndTest,
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

module.exports = { createAuth: createAuth, identify: identify, cannotGenerate: cannotGenerate, STATE_TYPES: STATE_TYPES };
