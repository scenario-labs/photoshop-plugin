"use strict";
// The account part of the panel: the sign-in view (first run, and Add a key
// for another project), the project name in the header, the Projects view,
// Settings (Account, Connect an AI agent, Diagnostics, About) and the panel
// menu items that lead there. Binds the elements of index.html; texts come
// from account-view.js. Text from Scenario (project names, messages) is set
// with textContent only. No overlays, no animation.

var view = require("./account-view.js");
var split = require("../auth/split.js");
var icons = require("./icons.js");
var uiDemo = require("../dev/ui-demo.js");

var VIEWS = ["signin", "main", "projects", "settings", "jobs"];
var STATUS_ACTIONS = ["enter_again", "create_key", "open_plans", "copy_admin_request", "copy_error", "retry"];
var CONFIRM_MS = 5000;

// SPEC 4.2 step 4: on macOS a password field's value cannot be read. The
// documented workaround switches the field to text, reads it and switches it
// back, in one synchronous step so no frame paints in between.
function readMasked(el) {
  if (!el) return "";
  var type = typeof el.getAttribute === "function" ? el.getAttribute("type") : null;
  if (type !== "password") return el.value || "";
  el.setAttribute("type", "text");
  var value = el.value;
  el.setAttribute("type", "password");
  return value || "";
}

// doc: the panel's document. actions: { auth, openLink(name), copyText(text),
// diagnostics() -> string, version }
function createAccountPanel(doc, actions) {
  if (!doc || typeof doc.getElementById !== "function") return null;
  var auth = actions.auth;
  var st = {
    view: null,
    adding: false,
    pastedSecret: null,
    running: false,
    failure: { signin: null, settings: null },
    signOutArmed: false,
    signOutTimer: null
  };

  function byId(id) {
    return doc.getElementById(id);
  }
  function setText(id, text) {
    var el = byId(id);
    if (el) el.textContent = text || "";
  }
  function show(id, on, how) {
    var el = byId(id);
    if (!el || !el.style) return;
    el.style.display = on ? how || "" : "none";
  }
  function enable(id, on) {
    var el = byId(id);
    if (!el) return;
    if (on) el.removeAttribute("disabled");
    else el.setAttribute("disabled", "");
  }
  function bind(id, type, fn) {
    var el = byId(id);
    if (el) el.addEventListener(type, fn);
  }
  function clear(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }
  function fail(e) {
    return { ok: false, state: "failed", type: "Internal", scenario_message: null, error: e };
  }

  // ---- views ----

  // Each view is a flex column: its own header row, then a part that scrolls.
  function showView(name) {
    for (var i = 0; i < VIEWS.length; i++) show("view-" + VIEWS[i], VIEWS[i] === name, "flex");
    st.view = name;
    if (name === "projects" || name === "settings") renderLists();
    if (name === "signin") renderSignInMode();
    var sc = byId(name + "-scroll");
    if (sc) sc.scrollTop = 0;
  }

  // Shows Settings at one of its sections (the panel menu's items).
  function showSection(id) {
    showView("settings");
    var el = byId(id);
    if (el && typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView();
      } catch (e) {
        // the section stays where it is
      }
    }
  }

  function homeView() {
    return auth.current() ? "main" : "signin";
  }

  // The label sits in its own span so that a long project name stays on one
  // line and ends with an ellipsis (styles.css); the full name is the tooltip.
  function renderHeader() {
    var label = view.projectLabel(auth.current());
    setText("project-label", label);
    var el = byId("project");
    if (el && el.setAttribute) el.setAttribute("title", auth.current() ? "Project: " + label + ". Click to switch project." : "Sign in to Scenario");
  }

  function renderSignInMode() {
    var adding = st.adding && !!auth.current();
    setText("signin-title", adding ? view.TEXT.add_title : view.TEXT.title);
    show("signin-back", adding);
  }

  function renderList(containerId, errorId) {
    var box = byId(containerId);
    if (!box || typeof doc.createElement !== "function") return;
    clear(box);
    var list = auth.list();
    for (var i = 0; i < list.length; i++) {
      (function (a) {
        // A row like Photoshop's lists: a check on the current project, the
        // name (cut with an ellipsis) and the key's last characters.
        var row = doc.createElement("div");
        row.className = a.current ? "list-row current" : "list-row";
        row.setAttribute("data-account", a.id);
        row.setAttribute("title", a.current ? "Current project" : "Switch to this project");
        if (a.current) row.setAttribute("selected", "");
        row.appendChild(icons.icon(doc, a.current ? "check" : "blank"));
        var name = doc.createElement("span");
        name.className = "name";
        name.textContent = view.projectLabel(a);
        row.appendChild(name);
        var key = doc.createElement("span");
        key.className = "key";
        key.textContent = view.keyEnding(a.key_last4);
        row.appendChild(key);
        row.addEventListener("click", function () {
          pick(a, errorId);
        });
        box.appendChild(row);
      })(list[i]);
    }
  }

  function renderLists() {
    renderList("projects-list", "projects-error");
    renderList("settings-accounts", "settings-note");
    var signedIn = !!auth.current();
    setText("settings-none", auth.list().length ? (signedIn ? "" : view.NOT_SIGNED_IN + ".") : view.NOT_SIGNED_IN + ".");
    show("settings-test", signedIn);
    show("settings-signout", signedIn);
  }

  function refresh() {
    renderHeader();
    if (st.view === "projects" || st.view === "settings") renderLists();
    if (st.view === "signin") renderSignInMode();
  }

  function pick(account, errorId) {
    if (account.current) return;
    setText(errorId, "");
    Promise.resolve()
      .then(function () {
        return auth.switchTo(account.id);
      })
      .then(
        function () {
          refresh();
        },
        function (e) {
          setText(errorId, (e && e.message) || "The project could not be switched.");
          refresh();
        }
      );
  }

  // ---- status boxes (sign-in and Settings > Account) ----

  function renderFailure(prefix, outcome) {
    if (!outcome) {
      st.failure[prefix] = null;
      show(prefix + "-status", false);
      return;
    }
    var d = view.describeFailure(outcome);
    st.failure[prefix] = d;
    setText(prefix + "-status-text", d.text);
    setText(prefix + "-status-detail", d.detail || "");
    for (var i = 0; i < STATUS_ACTIONS.length; i++) show(prefix + "-act-" + STATUS_ACTIONS[i], d.actions.indexOf(STATUS_ACTIONS[i]) >= 0);
    show(prefix + "-links", true);
    show(prefix + "-status", true, "block");
  }

  function renderConnected(prefix, account) {
    var lines = view.connectedLines(account);
    st.failure[prefix] = null;
    setText(prefix + "-status-text", lines[0]);
    setText(prefix + "-status-detail", lines.slice(1).join(". "));
    for (var i = 0; i < STATUS_ACTIONS.length; i++) show(prefix + "-act-" + STATUS_ACTIONS[i], false);
    show(prefix + "-links", false);
    show(prefix + "-status", true, "block");
  }

  function showBanner(account) {
    var lines = view.connectedLines(account);
    setText("account-banner-1", lines[0]);
    setText("account-banner-2", lines[1]);
    setText("account-banner-3", lines[2]);
    show("account-banner", true, "block");
  }

  // ---- sign-in ----

  function clearFields() {
    var k = byId("signin-key");
    var s = byId("signin-secret");
    if (k) k.value = "";
    if (s) s.value = "";
    st.pastedSecret = null;
  }

  function applyPair(pair) {
    var k = byId("signin-key");
    var s = byId("signin-secret");
    if (k) k.value = pair.key;
    if (s) s.value = pair.secret;
    st.pastedSecret = pair.secret;
    renderFailure("signin", null);
  }

  function readSecret() {
    var v = readMasked(byId("signin-secret"));
    if (!v && st.pastedSecret) v = st.pastedSecret;
    return v;
  }

  function startAdding() {
    st.adding = true;
    clearFields();
    renderFailure("signin", null);
    setText("signin-note", "");
    showView("signin");
  }

  async function save() {
    if (st.running) return;
    st.running = true;
    enable("signin-save", false);
    renderFailure("signin", null);
    setText("signin-note", "");
    var out;
    try {
      var keyEl = byId("signin-key");
      out = await auth.saveAndTest(keyEl ? keyEl.value : "", readSecret(), {
        onStep: function (step, total) {
          setText("signin-progress", view.testing(step, total));
        },
        onWait: function (seconds) {
          setText("signin-progress", view.retrying(seconds));
        }
      });
    } catch (e) {
      out = fail(e);
    } finally {
      st.running = false;
      enable("signin-save", true);
      setText("signin-progress", "");
    }
    if (out.ok) {
      clearFields();
      st.adding = false;
      renderHeader();
      showBanner(out.account);
      showView("main");
    } else {
      renderFailure("signin", out);
    }
  }

  // ---- Settings > Account ----

  async function testConnection() {
    if (st.running) return;
    st.running = true;
    enable("settings-test", false);
    renderFailure("settings", null);
    var out;
    try {
      out = await auth.testConnection({
        onStep: function (step, total) {
          setText("settings-progress", view.testing(step, total));
        },
        onWait: function (seconds) {
          setText("settings-progress", view.retrying(seconds));
        }
      });
    } catch (e) {
      out = fail(e);
    } finally {
      st.running = false;
      enable("settings-test", true);
      setText("settings-progress", "");
    }
    if (out.ok) renderConnected("settings", out.account);
    else renderFailure("settings", out);
    refresh();
  }

  function disarmSignOut() {
    st.signOutArmed = false;
    if (st.signOutTimer) clearTimeout(st.signOutTimer);
    st.signOutTimer = null;
    setText("settings-signout", "Sign out");
    setText("settings-note", "");
  }

  function signOut() {
    if (!st.signOutArmed) {
      st.signOutArmed = true;
      setText("settings-signout", "Confirm sign out");
      setText("settings-note", view.TEXT.sign_out_confirm);
      st.signOutTimer = setTimeout(disarmSignOut, CONFIRM_MS);
      return;
    }
    disarmSignOut();
    renderFailure("settings", null);
    Promise.resolve()
      .then(function () {
        return auth.signOut();
      })
      .then(
        function () {
          var now = auth.current();
          setText("settings-note", now ? "Signed out. Now using " + view.projectLabel(now) + "." : "Signed out. The key is removed from this computer.");
          show("account-banner", false);
          refresh();
        },
        function (e) {
          setText("settings-note", "Sign out failed: " + ((e && e.message) || e));
          refresh();
        }
      );
  }

  // ---- actions shared by both status boxes ----

  function copy(text, noteId, note) {
    Promise.resolve()
      .then(function () {
        return actions.copyText(text);
      })
      .then(
        function () {
          setText(noteId, note);
        },
        function (e) {
          setText(noteId, "Could not copy: " + ((e && e.message) || e) + ".");
        }
      );
  }

  function link(name) {
    Promise.resolve()
      .then(function () {
        return actions.openLink(name);
      })
      .catch(function () {
        // Photoshop shows its own consent dialog; a refusal needs no message
      });
  }

  function runAction(prefix, name) {
    var noteId = prefix + "-note";
    if (name === "enter_again") {
      if (prefix === "settings") return startAdding();
      clearFields();
      renderFailure("signin", null);
      var k = byId("signin-key");
      if (k && typeof k.focus === "function") k.focus();
    } else if (name === "create_key") link("create_key");
    else if (name === "open_plans") link("plans");
    else if (name === "copy_admin_request") copy(view.TEXT.admin_request, noteId, view.TEXT.admin_copied);
    else if (name === "copy_error") copy(st.failure[prefix] ? st.failure[prefix].copy : "", noteId, view.TEXT.copied);
    else if (name === "retry") {
      if (prefix === "settings") testConnection();
      else save();
    }
  }

  // ---- wiring ----

  function setStatic() {
    var T = view.TEXT;
    setText("signin-disclosure", T.disclosure);
    setText("signin-plan", T.plan);
    setText("signin-help-title", T.no_key_title);
    setText("signin-step1", T.create_key_help);
    setText("signin-admins", T.admins_only);
    setText("signin-no-account", T.no_account);
    setText("signin-step2", T.paste);
    setText("signin-storage", T.storage_note);
    setText("projects-note", T.projects_note);
    setText("settings-signout-note", T.sign_out_note);
    setText("settings-about", T.disclosure + " Open source, MIT license.");
    for (var i = 0; i < STATUS_ACTIONS.length; i++) {
      setText("signin-act-" + STATUS_ACTIONS[i], view.ACTION_LABELS[STATUS_ACTIONS[i]]);
      setText("settings-act-" + STATUS_ACTIONS[i], view.ACTION_LABELS[STATUS_ACTIONS[i]]);
    }
  }

  bind("project", "click", function () {
    showView(auth.current() ? "projects" : "signin");
  });
  bind("settings-back", "click", function () {
    disarmSignOut();
    showView(homeView());
  });
  bind("projects-back", "click", function () {
    showView(homeView());
  });
  bind("signin-back", "click", function () {
    st.adding = false;
    clearFields();
    renderFailure("signin", null);
    showView(homeView());
  });
  bind("projects-add", "click", startAdding);
  bind("settings-add", "click", startAdding);
  bind("signin-save", "click", save);
  bind("settings-test", "click", testConnection);
  bind("settings-signout", "click", signOut);
  bind("account-banner-close", "click", function () {
    show("account-banner", false);
  });
  bind("signin-create-key", "click", function () {
    link("create_key");
  });
  bind("signin-see-plans", "click", function () {
    link("plans");
  });
  bind("signin-create-account", "click", function () {
    link("create_account");
  });
  bind("signin-privacy", "click", function () {
    link("privacy");
  });
  bind("signin-copy-request", "click", function () {
    copy(view.TEXT.admin_request, "signin-note", view.TEXT.admin_copied);
  });
  ["signin", "settings"].forEach(function (prefix) {
    STATUS_ACTIONS.forEach(function (name) {
      bind(prefix + "-act-" + name, "click", function () {
        runAction(prefix, name);
      });
    });
    bind(prefix + "-report", "click", function () {
      link("report_problem");
    });
    bind(prefix + "-help", "click", function () {
      link("get_help");
    });
  });
  bind("settings-privacy", "click", function () {
    link("privacy");
  });
  bind("settings-get-help", "click", function () {
    link("get_help");
  });

  // SPEC 4.2 step 3: "key:secret" or two lines pasted into the key field are
  // split on the paste event; the secret goes to the masked field at once.
  bind("signin-key", "paste", function (ev) {
    var data = ev && ev.clipboardData;
    var text = null;
    if (data && typeof data.getData === "function") text = data.getData("text/plain") || data.getData("text");
    var pair = split.splitPair(text);
    if (!pair) return; // a plain key; or no clipboard data: the input handler splits
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    applyPair(pair);
  });
  bind("signin-key", "input", function () {
    var el = byId("signin-key");
    var value = el ? el.value : "";
    if (!split.looksLikePair(value)) return;
    var pair = split.splitPair(value);
    if (pair) applyPair(pair);
  });
  bind("signin-secret", "input", function () {
    st.pastedSecret = null;
  });

  // Diagnostics: the text is shown before it is copied (SPEC 3.14).
  var diagText = "";
  bind("diag-copy", "click", function () {
    diagText = actions.diagnostics();
    setText("diag-text", diagText);
    setText("diag-note", "");
    show("diag-preview", true, "block");
  });
  bind("diag-cancel", "click", function () {
    show("diag-preview", false);
  });
  bind("diag-confirm", "click", function () {
    show("diag-preview", false);
    copy(diagText, "diag-note", view.TEXT.copied);
  });

  setStatic();
  renderHeader();
  showView(homeView());

  // The panel menu's items that lead to the account views (ui/menu.js).
  var menuHandlers = {
    projects: function () {
      showView(auth.current() ? "projects" : "signin");
    },
    settings: function () {
      showSection("settings-account");
    },
    agents: function () {
      showSection("settings-agents");
    },
    diagnostics: function () {
      showSection("settings-diagnostics");
    },
    about: function () {
      showSection("settings-about-section");
    },
    help: function () {
      link("get_help");
    },
    // Sign out asks first: the menu opens Settings with the confirm armed.
    signout: function () {
      showSection("settings-account");
      if (auth.current() && !st.signOutArmed) signOut();
    }
  };

  return {
    // Development builds only (a stub in release): sample states.
    dev: uiDemo.hook("account", { renderFailure: renderFailure, renderConnected: renderConnected, showBanner: showBanner, startAdding: startAdding }),
    refresh: refresh,
    showView: showView,
    showSection: showSection,
    menuHandlers: menuHandlers,
    homeView: homeView,
    view: function () {
      return st.view;
    }
  };
}

module.exports = { createAccountPanel: createAccountPanel, readMasked: readMasked };
