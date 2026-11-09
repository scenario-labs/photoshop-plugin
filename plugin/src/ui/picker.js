"use strict";
// The model picker (SPEC 3.3): a full view inside the main view with a back
// button, search, the four type tabs, chips, a Tags menu, rows with the
// model's picture, badges and a favorite star, 30 rows per page with Load
// more. Favorites are kept in the plugin data folder. Text from Scenario
// (names, descriptions, tags) is set with textContent only.

var map = require("../catalog/map.js");
var trainedMod = require("../catalog/trained.js");
var icons = require("./icons.js");
var thumbs = require("./thumbs.js");

var PAGE = 30;
var FAVORITES_FILE = "favorites.json";
var SHORT_DESCRIPTION = 160;

var TEXT = {
  loading: "Loading models",
  failed: "Models could not load.",
  empty: "No models in this lane match these filters.",
  trained_none: "No trained models in this project yet. Scenario's public trained models are listed below; models trained in other projects appear when you switch project.",
  trained_later: "This trained model's type has no base model in this version of the plugin.",
  trained_loading: "Reading the base models of trained models…",
  run_with: "Run with",
  all_tags: "All tags",
  use: "Use this model"
};

// o: { catalog, host, onChoose(row), onClose(), log }
function createPicker(doc, o) {
  if (!doc || typeof doc.getElementById !== "function") return null;
  var st = { open: false, tab: "image", chip: "all", tag: "", query: "", shown: PAGE, favorites: [], expanded: null, bases: null, basesLoading: false };

  function byId(id) {
    return doc.getElementById(id);
  }
  function setText(id, text) {
    var el = byId(id);
    if (el) el.textContent = text || "";
  }
  function show(id, on, display) {
    var el = byId(id);
    if (el && el.style) el.style.display = on ? display || "" : "none";
  }
  function bind(id, type, fn) {
    var el = byId(id);
    if (el) el.addEventListener(type, fn);
  }
  function clear(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }
  function el(tag, text, cls) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  async function loadFavorites() {
    try {
      var v = JSON.parse((await o.host.readDataText(FAVORITES_FILE)) || "null");
      if (v && v.v === 1 && Array.isArray(v.ids)) st.favorites = v.ids.filter(function (x) { return typeof x === "string"; });
    } catch (e) {
      st.favorites = [];
    }
  }

  function toggleFavorite(id) {
    var i = st.favorites.indexOf(id);
    if (i >= 0) st.favorites.splice(i, 1);
    else st.favorites.push(id);
    o.host.writeDataText(FAVORITES_FILE, JSON.stringify({ v: 1, ids: st.favorites }));
    render();
  }

  function derived(row) {
    if (row.type === "custom" || !st.bases) return null;
    return trainedMod.derive(row, st.bases);
  }

  function badges(row, d) {
    var out = [];
    if (d) {
      out.push(trainedMod.kindLabel(d));
      if (!row.project) out.push("Public");
      if (row.trigger) out.push("Trigger " + row.trigger);
      if (d.edit_route) out.push("Edit: Experimental");
      return out;
    }
    if (map.acceptsMask(row, null)) out.push("Mask input");
    var tools = map.toolsOf(row);
    for (var i = 0; i < tools.length; i++) out.push(map.TOOL_LABELS[tools[i]]);
    if (row.no_refund) out.push("No refund if it fails");
    return out;
  }

  // A row like a Photoshop list item: picture, name and star, one line of
  // description (a click shows all of it), one line of badges. A click on
  // the row uses the model.
  function renderRow(list, row) {
    var d = derived(row);
    var trained = row.type !== "custom";
    // A trained row runs with its base (Run with, M7) once its bases are
    // known and one of them takes it; an unknown type stays grayed.
    var usable = !trained || !!(d && d.supported && d.lanes.length);
    var box = el("div", null, usable ? "model-row" : "model-row off");
    box.setAttribute("data-model", row.id);
    box.setAttribute("title", !usable ? (d ? TEXT.trained_later : TEXT.trained_loading) : trained ? TEXT.run_with + ": " + row.name + " (" + trainedMod.kindLabel(d) + (row.trigger ? ", trigger " + row.trigger : "") + ")" : TEXT.use + ": " + row.name);
    var th = el("div", null, "model-thumb");
    th.appendChild(icons.icon(doc, trained ? "trained" : "image"));
    var img = el("img", null, "thumb-img");
    img.setAttribute("alt", "");
    th.appendChild(img);
    thumbs.show(img, thumbs.modelThumb(row));
    box.appendChild(th);
    var main = el("div", null, "model-main");
    var head = el("div", null, "model-head");
    var name = el("span", row.name, "model-title");
    head.appendChild(name);
    var fav = st.favorites.indexOf(row.id) >= 0;
    var star = el("div", null, fav ? "star on" : "star");
    star.setAttribute("data-star", row.id);
    star.setAttribute("title", fav ? "Remove from favorites" : "Add to favorites");
    star.appendChild(icons.icon(doc, fav ? "star-filled" : "star"));
    star.addEventListener("click", function (ev) {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      toggleFavorite(row.id);
    });
    head.appendChild(star);
    main.appendChild(head);
    var full = st.expanded === row.id;
    var text = row.description;
    if (!full && text.length > SHORT_DESCRIPTION) text = text.slice(0, SHORT_DESCRIPTION - 3) + "...";
    var desc = el("div", text, full ? "note" : "note one-line");
    desc.setAttribute("data-desc", row.id);
    desc.addEventListener("click", function (ev) {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      st.expanded = st.expanded === row.id ? null : row.id;
      render();
    });
    main.appendChild(desc);
    var b = badges(row, d);
    if (b.length) main.appendChild(el("div", b.join(" · "), "note one-line badges"));
    box.appendChild(main);
    if (usable) {
      box.addEventListener("click", function () {
        close();
        o.onChoose(row);
      });
    }
    list.appendChild(box);
  }

  function renderChips() {
    var box = byId("picker-chips");
    if (!box) return;
    clear(box);
    var chips = map.CHIPS[st.tab];
    for (var i = 0; i < chips.length; i++) {
      (function (chip) {
        var b = el("sp-action-button", map.CHIP_LABELS[chip]);
        b.setAttribute("size", "s");
        b.setAttribute("quiet", "");
        b.setAttribute("data-chip", chip);
        if (chip === st.chip) b.setAttribute("selected", "");
        b.addEventListener("click", function () {
          st.chip = chip;
          st.shown = PAGE;
          render();
        });
        box.appendChild(b);
      })(chips[i]);
    }
  }

  // The Tags menu (an sp-picker: the chosen item carries `selected`, and
  // the items are rebuilt only when they change).
  var tagsKey = null;
  function renderTags(rows) {
    var sel = byId("picker-tags");
    if (!sel) return;
    var options = [{ value: "", label: TEXT.all_tags }].concat(
      map.tagMenu(rows, st.tab).map(function (t) {
        return { value: t.tag, label: t.tag + " (" + t.count + ")" };
      })
    );
    var k = JSON.stringify([options, st.tag]);
    if (k === tagsKey) return;
    tagsKey = k;
    clear(sel);
    var menu = el("sp-menu");
    menu.setAttribute("slot", "options");
    for (var i = 0; i < options.length; i++) {
      var opt = el("sp-menu-item", options[i].label);
      opt.setAttribute("value", options[i].value);
      if (options[i].value === st.tag) opt.setAttribute("selected", "");
      menu.appendChild(opt);
    }
    sel.appendChild(menu);
    try {
      sel.value = st.tag;
    } catch (e) {
      // the selected item already says it
    }
  }

  function ensureBases() {
    if (st.bases || st.basesLoading) return;
    st.basesLoading = true;
    o.catalog.baseSchemas().then(
      function (b) {
        st.bases = b;
        st.basesLoading = false;
        if (st.open) render();
      },
      function () {
        st.basesLoading = false;
      }
    );
  }

  function render() {
    if (!st.open) return;
    for (var t = 0; t < map.TABS.length; t++) {
      var tb = byId("picker-tab-" + map.TABS[t]);
      if (!tb) continue;
      if (map.TABS[t] === st.tab) tb.setAttribute("selected", "");
      else tb.removeAttribute("selected");
      tb.className = map.TABS[t] === st.tab ? "seg-btn on" : "seg-btn";
    }
    renderChips();
    var status = o.catalog.status();
    var rows = o.catalog.rows();
    var list = byId("picker-list");
    clear(list);
    renderTags(rows);
    if (!rows.length) {
      setText("picker-status", status.status === "failed" ? TEXT.failed + (status.error ? " " + status.error.message : "") : TEXT.loading);
      show("picker-more", false);
      return;
    }
    if (st.tab === "trained") ensureBases();
    var picked = map.select(rows, { tab: st.tab, chip: st.chip, tag: st.tag, query: st.query, favorites: st.favorites });
    var note = "";
    if (!picked.length) note = TEXT.empty;
    else if (st.tab === "trained" && !picked.some(function (r) { return r.project; }) && st.chip !== "public") note = TEXT.trained_none;
    if (status.status === "loading") note = (note ? note + " " : "") + TEXT.loading + "...";
    setText("picker-status", note);
    for (var i = 0; i < picked.length && i < st.shown; i++) renderRow(list, picked[i]);
    show("picker-more", picked.length > st.shown);
  }

  function open(tab, tool) {
    st.open = true;
    st.tab = map.TABS.indexOf(tab) >= 0 ? tab : "image";
    st.chip = tool && map.CHIPS[st.tab].indexOf(tool) >= 0 ? tool : "all";
    st.shown = PAGE;
    // The picker takes the main view's place: context, middle and composer hide.
    show("sc-top", false);
    show("mid", false);
    show("composer", false);
    show("view-picker", true, "flex");
    var sc = byId("picker-scroll");
    if (sc) sc.scrollTop = 0;
    render();
    o.catalog.ensure().then(render, render);
  }

  function close() {
    st.open = false;
    show("view-picker", false);
    show("sc-top", true, "flex");
    show("mid", true, "flex");
    show("composer", true, "flex");
    if (o.onClose) o.onClose();
  }

  bind("picker-back", "click", close);
  for (var t = 0; t < map.TABS.length; t++) {
    (function (tab) {
      bind("picker-tab-" + tab, "click", function () {
        st.tab = tab;
        st.chip = "all";
        st.tag = "";
        st.shown = PAGE;
        render();
      });
    })(map.TABS[t]);
  }
  bind("picker-search", "input", function () {
    st.query = byId("picker-search").value || "";
    st.shown = PAGE;
    render();
  });
  bind("picker-tags", "change", function () {
    st.tag = byId("picker-tags").value || "";
    st.shown = PAGE;
    render();
  });
  bind("picker-more", "click", function () {
    st.shown += PAGE;
    render();
  });
  bind("picker-clear", "click", function () {
    st.chip = "all";
    st.tag = "";
    st.query = "";
    var s = byId("picker-search");
    if (s) s.value = "";
    st.shown = PAGE;
    render();
  });
  bind("picker-refresh", "click", function () {
    setText("picker-status", TEXT.loading + "...");
    o.catalog.refresh().then(render, render);
  });
  o.catalog.onChange(function () {
    if (st.open) render();
  });

  show("view-picker", false);
  var ready = loadFavorites();

  return {
    open: open,
    close: close,
    ready: ready,
    state: function () {
      return { open: st.open, tab: st.tab, chip: st.chip, tag: st.tag, query: st.query, favorites: st.favorites.slice() };
    }
  };
}

module.exports = { createPicker: createPicker, TEXT: TEXT, PAGE: PAGE, FAVORITES_FILE: FAVORITES_FILE };
