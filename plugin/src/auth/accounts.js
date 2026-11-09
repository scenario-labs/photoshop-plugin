"use strict";
// Saved Scenario keys (SPEC 2.3 `auth`, 4.3 and 4.5).
//
// - One secureStorage entry per project key, named by a hash of the key id,
//   because entry names are stored unencrypted (documented). Its value holds
//   the key and the secret.
// - The list of saved projects (project name and id, the key's last 4
//   characters, which one is current) is itself a secureStorage value, so no
//   project name is written in clear either.
// - Only the current project's pair is kept in memory. Nothing here is
//   written to plugin data files, logs or the helper link.
// - A browser sign-in (oauth.js) is one secureStorage entry per signed-in
//   person, named by a hash of the issuer and the subject, holding the
//   refresh token; each project chosen with it is a row of the list (kind
//   "browser") with no key. Its key_hash is a hash of the issuer, the subject
//   and the project id, so quotes and jobs stay apart per project as they do
//   per key. The access token never reaches this module.

var sha = require("../util/sha256.js");
var utf8 = require("../util/utf8.js");

var INDEX_ENTRY = "scenario.accounts";
var KEY_ENTRY_PREFIX = "scenario.key.";
var SESSION_ENTRY_PREFIX = "scenario.session.";
var NAME_MAX = 100;

function keyHash(key) {
  return sha.toHex(sha.sha256(utf8.encode(key)));
}

// A browser sign-in's identity: who signed in, at which issuer. Not a secret.
function sessionId(issuer, subject) {
  return keyHash("session\n" + issuer + "\n" + subject).slice(0, 32);
}

// What stands for the key of a project chosen with a browser sign-in.
function browserHash(issuer, subject, projectId) {
  return keyHash("browser\n" + issuer + "\n" + subject + "\n" + projectId);
}

function cleanName(name) {
  if (typeof name !== "string") return null;
  var out = name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!out) return null;
  return out.length > NAME_MAX ? out.slice(0, NAME_MAX - 3) + "..." : out;
}

function parseJson(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function validAccount(a) {
  if (!a || typeof a.id !== "string" || !/^[0-9a-f]{32}$/.test(a.id) || typeof a.key_hash !== "string" || typeof a.key_last4 !== "string") return false;
  if (a.kind === "browser") return typeof a.session === "string" && /^[0-9a-f]{32}$/.test(a.session) && typeof a.project_id === "string" && !!a.project_id;
  return a.kind === undefined;
}

function validSession(s) {
  return s && typeof s.issuer === "string" && typeof s.client_id === "string" && typeof s.subject === "string" && typeof s.refresh_token === "string" && !!s.refresh_token;
}

// host: { secureGet, secureSet, secureRemove }. redactor: util/redact.js.
// opts.openSession(stored, save(refreshToken), onEnd()) -> a session of
// oauth.js for a stored browser sign-in; without it, browser rows are kept
// but cannot send requests.
function createAccounts(host, redactor, opts) {
  opts = opts || {};
  var index = { v: 1, current: null, accounts: [] };
  var pair = null; // { key, secret } of the current project, or { session, project_id }
  var sessions = {}; // session id -> { stored, live } for the sessions in the list
  var listeners = [];

  function find(id) {
    for (var i = 0; i < index.accounts.length; i++) if (index.accounts[i].id === id) return index.accounts[i];
    return null;
  }

  function entryName(id) {
    return KEY_ENTRY_PREFIX + id;
  }

  function remember(p) {
    if (!redactor || !p || !p.key) return;
    redactor.add(p.key);
    redactor.add(p.secret);
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i]();
      } catch (e) {
        // a listener failing must not stop the others
      }
    }
  }

  async function writeIndex(next) {
    await host.secureSet(INDEX_ENTRY, JSON.stringify(next));
    index = next;
  }

  function copyIndex() {
    return { v: 1, current: index.current, accounts: index.accounts.map(function (a) { return Object.assign({}, a); }) };
  }

  async function readSession(sid) {
    var stored = null;
    try {
      stored = parseJson(await host.secureGet(SESSION_ENTRY_PREFIX + sid));
    } catch (e) {
      stored = null;
    }
    if (!validSession(stored) || sessionId(stored.issuer, stored.subject) !== sid) return null;
    return stored;
  }

  // The live session of a stored sign-in, made once per Photoshop start.
  function liveSession(sid, stored) {
    var known = sessions[sid];
    if (known && known.live) return known.live;
    if (redactor) redactor.add(stored.refresh_token);
    var live = opts.openSession
      ? opts.openSession(
          stored,
          function (refreshToken) {
            return saveRefreshToken(sid, refreshToken);
          },
          function () {
            return removeSession(sid);
          },
          known ? known.initial : null
        )
      : null;
    sessions[sid] = { stored: stored, live: live };
    return live;
  }

  async function saveRefreshToken(sid, refreshToken) {
    var known = sessions[sid];
    if (!known) return;
    var next = Object.assign({}, known.stored, { refresh_token: refreshToken });
    if (redactor) redactor.add(refreshToken);
    await host.secureSet(SESSION_ENTRY_PREFIX + sid, JSON.stringify(next));
    known.stored = next;
  }

  async function readPair(id) {
    var acc0 = find(id);
    if (acc0 && acc0.kind === "browser") {
      var stored0 = await readSession(acc0.session);
      if (!stored0) return null;
      if (browserHash(stored0.issuer, stored0.subject, acc0.project_id) !== acc0.key_hash) return null;
      return { session: liveSession(acc0.session, stored0), session_id: acc0.session, project_id: acc0.project_id };
    }
    var stored = null;
    try {
      stored = parseJson(await host.secureGet(entryName(id)));
    } catch (e) {
      stored = null;
    }
    if (!stored || typeof stored.key !== "string" || typeof stored.secret !== "string" || !stored.key || !stored.secret) return null;
    var acc = find(id);
    if (acc && keyHash(stored.key) !== acc.key_hash) return null;
    return { key: stored.key, secret: stored.secret };
  }

  async function removeEntry(id) {
    var a = find(id);
    if (a && a.kind === "browser") return; // the session entry goes with the last of its rows
    try {
      await host.secureRemove(entryName(id));
    } catch (e) {
      // removal is best effort; the index no longer points at it
    }
  }

  async function removeSessionEntry(sid) {
    delete sessions[sid];
    try {
      await host.secureRemove(SESSION_ENTRY_PREFIX + sid);
    } catch (e) {
      // removal is best effort; no row points at it any more
    }
  }

  // Reads the saved projects and the current pair. A damaged index counts as
  // no key saved; an entry that cannot be read is dropped from the list.
  async function load() {
    var raw = null;
    try {
      raw = parseJson(await host.secureGet(INDEX_ENTRY));
    } catch (e) {
      raw = null;
    }
    var accounts = raw && Array.isArray(raw.accounts) ? raw.accounts.filter(validAccount) : [];
    index = { v: 1, current: raw && typeof raw.current === "string" ? raw.current : null, accounts: accounts };
    pair = null;
    var dropped = false;
    while (index.current) {
      var p = await readPair(index.current);
      if (p) {
        pair = p;
        remember(p);
        break;
      }
      var gone = index.current;
      index.accounts = index.accounts.filter(function (a) {
        return a.id !== gone;
      });
      index.current = index.accounts.length ? index.accounts[0].id : null;
      dropped = true;
    }
    if (dropped) {
      try {
        await writeIndex(copyIndex());
      } catch (e) {
        // keep the in-memory view
      }
    }
    notify();
    return summary();
  }

  function view(a) {
    var out = { id: a.id, project_name: a.project_name || null, key_last4: a.key_last4, current: a.id === index.current };
    if (a.kind === "browser") {
      out.kind = "browser";
      out.team_name = a.team_name || null;
      out.email = sessions[a.session] && sessions[a.session].stored ? sessions[a.session].stored.email || null : null;
    }
    return out;
  }

  function current() {
    var a = index.current ? find(index.current) : null;
    if (!a || !pair) return null;
    var out = { id: a.id, key_hash: a.key_hash, project_name: a.project_name || null, project_id: a.project_id || null, key_last4: a.key_last4 };
    if (a.kind === "browser") {
      out.kind = "browser";
      out.session = a.session;
      out.team_id = a.team_id || null;
      out.team_name = a.team_name || null;
      var known = sessions[a.session];
      out.email = known && known.stored ? known.stored.email || null : null;
    }
    return out;
  }

  function summary() {
    var c = current();
    return { signed_in: !!c, project_name: c ? c.project_name : null, count: index.accounts.length };
  }

  // Saves a tested pair and makes it the current project. One key per
  // project: a key for a project that already has one replaces it.
  // The browser sign-ins whose only project is projectId: a key saved for
  // that project replaces their last row, so they end with it.
  function sessionsEndedBy(projectId) {
    if (!projectId) return [];
    var out = [];
    index.accounts.forEach(function (a) {
      if (a.kind !== "browser" || out.indexOf(a.session) >= 0) return;
      var rows = index.accounts.filter(function (b) {
        return b.kind === "browser" && b.session === a.session;
      });
      var ends = rows.every(function (b) {
        return b.project_id === projectId;
      });
      if (ends) out.push(a.session);
    });
    return out;
  }

  async function save(p, info) {
    info = info || {};
    var hash = keyHash(p.key);
    var id = hash.slice(0, 32);
    var projectId = typeof info.project_id === "string" && info.project_id ? info.project_id : null;
    var ending = sessionsEndedBy(projectId);
    remember(p);
    await host.secureSet(entryName(id), JSON.stringify({ v: 1, key: p.key, secret: p.secret }));
    var next = copyIndex();
    var replaced = [];
    next.accounts = next.accounts.filter(function (a) {
      var same = a.id === id || (projectId && a.project_id === projectId);
      if (same && a.id !== id && a.kind !== "browser") replaced.push(a.id);
      return !same;
    });
    next.accounts.push({
      id: id,
      key_hash: hash,
      project_name: cleanName(info.project_name),
      project_id: projectId,
      key_last4: p.key.slice(-4),
      saved_at: new Date().toISOString()
    });
    next.current = id;
    try {
      await writeIndex(next);
    } catch (e) {
      await removeEntry(id);
      throw e;
    }
    for (var i = 0; i < replaced.length; i++) await removeEntry(replaced[i]);
    for (var j = 0; j < ending.length; j++) await removeSessionEntry(ending[j]);
    pair = { key: p.key, secret: p.secret };
    notify();
    return current();
  }

  // After Test connection: keep the project name and id up to date.
  async function update(id, info) {
    var a = find(id);
    if (!a) return;
    var name = cleanName(info.project_name);
    var projectId = typeof info.project_id === "string" && info.project_id ? info.project_id : a.project_id || null;
    // A browser sign-in's project keeps its id; its team can be renamed.
    if (a.kind === "browser") projectId = a.project_id;
    var team = a.kind === "browser" ? cleanName(info.team_name) : null;
    if (name === (a.project_name || null) && projectId === (a.project_id || null) && (!team || team === (a.team_name || null))) return;
    var next = copyIndex();
    for (var i = 0; i < next.accounts.length; i++) {
      if (next.accounts[i].id === id) {
        if (name) next.accounts[i].project_name = name;
        next.accounts[i].project_id = projectId;
        if (team) next.accounts[i].team_name = team;
      }
    }
    await writeIndex(next);
    notify();
  }

  async function switchTo(id) {
    if (!find(id)) throw new Error("No key is saved for that project.");
    var p = await readPair(id);
    if (!p) {
      var next = copyIndex();
      next.accounts = next.accounts.filter(function (a) {
        return a.id !== id;
      });
      if (next.current === id) next.current = null;
      await writeIndex(next);
      if (!next.current) pair = null;
      notify();
      throw new Error("The saved key for that project could not be read. Add it again.");
    }
    var n = copyIndex();
    n.current = id;
    await writeIndex(n);
    pair = p;
    remember(p);
    notify();
    return current();
  }

  function cleanEmail(v) {
    return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(v) ? v : null;
  }

  // Makes a project of a browser sign-in the current project: a row of the
  // list, added once per project.
  async function addBrowserRow(sid, stored, choice) {
    var hash = browserHash(stored.issuer, stored.subject, choice.project_id);
    var id = hash.slice(0, 32);
    var next = copyIndex();
    next.accounts = next.accounts.filter(function (a) {
      return a.id !== id;
    });
    next.accounts.push({
      id: id,
      kind: "browser",
      session: sid,
      key_hash: hash,
      key_last4: "",
      project_id: choice.project_id,
      project_name: cleanName(choice.project_name),
      team_id: typeof choice.team_id === "string" && choice.team_id ? choice.team_id : null,
      team_name: cleanName(choice.team_name),
      saved_at: new Date().toISOString()
    });
    next.current = id;
    await writeIndex(next);
    pair = { session: liveSession(sid, stored), session_id: sid, project_id: choice.project_id };
    notify();
    return current();
  }

  // After a browser sign-in: saves who signed in and the refresh token, then
  // the chosen project. tokens (optional): the sign-in's own access token, so
  // the first request needs no refresh.
  // signIn: { issuer, client_id, subject, email, refresh_token }
  // choice: { team_id, team_name, project_id, project_name }
  async function saveBrowser(signIn, choice, tokens) {
    if (!choice || typeof choice.project_id !== "string" || !choice.project_id) throw new Error("Choose a project first.");
    var sid = sessionId(signIn.issuer, signIn.subject);
    var stored = { v: 1, issuer: signIn.issuer, client_id: signIn.client_id, subject: signIn.subject, email: cleanEmail(signIn.email), refresh_token: signIn.refresh_token };
    if (!validSession(stored)) throw new Error("The sign-in gave no refresh token.");
    if (redactor) redactor.add(stored.refresh_token);
    await host.secureSet(SESSION_ENTRY_PREFIX + sid, JSON.stringify(stored));
    // A new sign-in of the same person replaces the session made with the old refresh token.
    sessions[sid] = { stored: stored, live: null, initial: tokens || null };
    try {
      return await addBrowserRow(sid, stored, choice);
    } catch (e) {
      var used = index.accounts.some(function (a) {
        return a.session === sid;
      });
      if (!used) await removeSessionEntry(sid);
      throw e;
    }
  }

  // Another project of a saved browser sign-in (the project chooser).
  async function chooseProject(sid, choice) {
    if (!choice || typeof choice.project_id !== "string" || !choice.project_id) throw new Error("Choose a project first.");
    var known = sessions[sid];
    var stored = known && known.stored ? known.stored : await readSession(sid);
    if (!stored) throw new Error("The Scenario sign-in is no longer saved on this computer. Sign in again.");
    return addBrowserRow(sid, stored, choice);
  }

  // The live session of a browser sign-in, for its team and project reads.
  async function session(sid) {
    var known = sessions[sid];
    var stored = known && known.stored ? known.stored : await readSession(sid);
    return stored ? liveSession(sid, stored) : null;
  }

  // Forgets a browser sign-in: its refresh token and every project chosen
  // with it. Sign out calls it after revoking the token; a refresh the
  // identity provider refuses calls it too. The next saved project, if any,
  // becomes current.
  async function removeSession(sid) {
    var next = copyIndex();
    var wasCurrent = false;
    next.accounts = next.accounts.filter(function (a) {
      var gone = a.kind === "browser" && a.session === sid;
      if (gone && a.id === next.current) wasCurrent = true;
      return !gone;
    });
    if (wasCurrent) next.current = null;
    await removeSessionEntry(sid);
    await writeIndex(next);
    if (wasCurrent) await pickNext();
    notify();
    return summary();
  }

  // The browser sign-in a saved project belongs to, or null for a key.
  function sessionOf(id) {
    var a = find(id);
    return a && a.kind === "browser" ? a.session : null;
  }

  // The refresh token of a saved browser sign-in, for revocation at sign out.
  function refreshTokenOf(sid) {
    var known = sessions[sid];
    if (known && known.live && typeof known.live.refreshToken === "function") return known.live.refreshToken();
    return known && known.stored ? known.stored.refresh_token : null;
  }

  async function pickNext() {
    pair = null;
    var candidates = index.accounts.map(function (a) {
      return a.id;
    });
    for (var i = 0; i < candidates.length && !pair; i++) {
      try {
        await switchTo(candidates[i]);
      } catch (e) {
        // an unreadable entry is dropped by switchTo; try the next one
      }
    }
  }

  // Sign out: removes the key and secret of one project from this computer.
  // When it was the current project, the next saved project becomes current.
  // A project of a browser sign-in signs out of that sign-in.
  async function remove(id) {
    var target = find(id);
    if (!target) return summary();
    if (target.kind === "browser") return removeSession(target.session);
    await removeEntry(id);
    var next = copyIndex();
    next.accounts = next.accounts.filter(function (a) {
      return a.id !== id;
    });
    var wasCurrent = next.current === id;
    if (wasCurrent) next.current = null;
    await writeIndex(next);
    if (wasCurrent) await pickNext();
    notify();
    return summary();
  }

  return {
    load: load,
    save: save,
    saveBrowser: saveBrowser,
    chooseProject: chooseProject,
    session: session,
    removeSession: removeSession,
    sessionsEndedBy: sessionsEndedBy,
    refreshTokenOf: refreshTokenOf,
    sessionOf: sessionOf,
    update: update,
    switchTo: switchTo,
    remove: remove,
    current: current,
    summary: summary,
    list: function () {
      return index.accounts.map(view);
    },
    // What signs Scenario requests: the key pair, or the browser session and
    // the chosen project. Only the scenario client calls this.
    credentials: function () {
      if (!pair) return null;
      if (pair.session_id) return { session: pair.session, project_id: pair.project_id };
      return { key: pair.key, secret: pair.secret };
    },
    onChange: function (fn) {
      listeners.push(fn);
    }
  };
}

module.exports = { createAccounts: createAccounts, keyHash: keyHash, cleanName: cleanName, sessionId: sessionId, browserHash: browserHash, INDEX_ENTRY: INDEX_ENTRY, KEY_ENTRY_PREFIX: KEY_ENTRY_PREFIX, SESSION_ENTRY_PREFIX: SESSION_ENTRY_PREFIX };
