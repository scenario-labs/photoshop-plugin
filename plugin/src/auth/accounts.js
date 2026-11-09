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

var sha = require("../util/sha256.js");
var utf8 = require("../util/utf8.js");

var INDEX_ENTRY = "scenario.accounts";
var KEY_ENTRY_PREFIX = "scenario.key.";
var NAME_MAX = 100;

function keyHash(key) {
  return sha.toHex(sha.sha256(utf8.encode(key)));
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
  return a && typeof a.id === "string" && /^[0-9a-f]{32}$/.test(a.id) && typeof a.key_hash === "string" && typeof a.key_last4 === "string";
}

// host: { secureGet, secureSet, secureRemove }. redactor: util/redact.js.
function createAccounts(host, redactor) {
  var index = { v: 1, current: null, accounts: [] };
  var pair = null; // { key, secret } of the current project
  var listeners = [];

  function find(id) {
    for (var i = 0; i < index.accounts.length; i++) if (index.accounts[i].id === id) return index.accounts[i];
    return null;
  }

  function entryName(id) {
    return KEY_ENTRY_PREFIX + id;
  }

  function remember(p) {
    if (!redactor || !p) return;
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

  async function readPair(id) {
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
    try {
      await host.secureRemove(entryName(id));
    } catch (e) {
      // removal is best effort; the index no longer points at it
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
    return { id: a.id, project_name: a.project_name || null, key_last4: a.key_last4, current: a.id === index.current };
  }

  function current() {
    var a = index.current ? find(index.current) : null;
    if (!a || !pair) return null;
    return { id: a.id, key_hash: a.key_hash, project_name: a.project_name || null, project_id: a.project_id || null, key_last4: a.key_last4 };
  }

  function summary() {
    var c = current();
    return { signed_in: !!c, project_name: c ? c.project_name : null, count: index.accounts.length };
  }

  // Saves a tested pair and makes it the current project. One key per
  // project: a key for a project that already has one replaces it.
  async function save(p, info) {
    info = info || {};
    var hash = keyHash(p.key);
    var id = hash.slice(0, 32);
    var projectId = typeof info.project_id === "string" && info.project_id ? info.project_id : null;
    remember(p);
    await host.secureSet(entryName(id), JSON.stringify({ v: 1, key: p.key, secret: p.secret }));
    var next = copyIndex();
    var replaced = [];
    next.accounts = next.accounts.filter(function (a) {
      var same = a.id === id || (projectId && a.project_id === projectId);
      if (same && a.id !== id) replaced.push(a.id);
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
    if (name === (a.project_name || null) && projectId === (a.project_id || null)) return;
    var next = copyIndex();
    for (var i = 0; i < next.accounts.length; i++) {
      if (next.accounts[i].id === id) {
        if (name) next.accounts[i].project_name = name;
        next.accounts[i].project_id = projectId;
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

  // Sign out: removes the key and secret of one project from this computer.
  // When it was the current project, the next saved project becomes current.
  async function remove(id) {
    if (!find(id)) return summary();
    await removeEntry(id);
    var next = copyIndex();
    next.accounts = next.accounts.filter(function (a) {
      return a.id !== id;
    });
    var wasCurrent = next.current === id;
    if (wasCurrent) next.current = null;
    await writeIndex(next);
    if (wasCurrent) {
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
    notify();
    return summary();
  }

  return {
    load: load,
    save: save,
    update: update,
    switchTo: switchTo,
    remove: remove,
    current: current,
    summary: summary,
    list: function () {
      return index.accounts.map(view);
    },
    // The pair for Scenario requests. Only the scenario client calls this.
    credentials: function () {
      return pair ? { key: pair.key, secret: pair.secret } : null;
    },
    onChange: function (fn) {
      listeners.push(fn);
    }
  };
}

module.exports = { createAccounts: createAccounts, keyHash: keyHash, cleanName: cleanName, INDEX_ENTRY: INDEX_ENTRY, KEY_ENTRY_PREFIX: KEY_ENTRY_PREFIX };
