"use strict";
// The creation panel's view (FLOWS v2, SPEC 3): draws the controller's
// model (panel/controller.js) into index.html's main view: the context
// card, the action chips and More, the Takes card, Recent, and the pinned
// composer (references, prompt, chips that show their value, settings,
// "<Action> · N CU"), and the popovers the chips open. Every control is a
// plain element: UXP 9.4 draws Spectrum pickers without their value and
// stacks an action button's icon over its label (AGENTS.md, "Panel UI").
// Text from Scenario, a document or a person is set with textContent only.

var icons = require("./icons.js");
var thumbs = require("./thumbs.js");

var TILE_GAP = 8;
var REFINE_TIP = "Keeps this take, then edits it";

// o: { openPicker(lane), openJobs(), openSettings(), log }
function createCreateView(doc, ctl, o) {
  if (!doc || typeof doc.getElementById !== "function" || !ctl) return null;
  o = o || {};
  var log = o.log || function () {};
  var pop = { kind: null, anchor: null, seq: 0 };
  var promptFocused = false;
  var lastAction = null;
  var drawing = false;

  function byId(id) {
    return doc.getElementById(id);
  }
  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function show(node, on, display) {
    if (node && node.style) node.style.display = on ? display || "flex" : "none";
  }
  function setText(id, t) {
    var e = byId(id);
    if (e) e.textContent = t || "";
  }
  function onClick(node, fn) {
    node.addEventListener("click", function (ev) {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      try {
        var r = fn(ev);
        if (r && typeof r.then === "function") r.then(null, report);
      } catch (e) {
        report(e);
      }
    });
    return node;
  }
  function report(e) {
    log("panel: an action failed (" + ((e && e.message) || e) + ")");
  }
  function rect(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") return null;
    var r = node.getBoundingClientRect();
    return r && r.width > 0 ? r : null;
  }
  function panelWidth() {
    var r = rect(byId("app"));
    return r ? r.width : 320;
  }

  // An image that covers a box of w x h without stretching (no object-fit
  // in UXP): scaled to the larger ratio and centered inside the clipping box.
  function cover(box, src, bw, bh, iw, ih) {
    var img = el("img", "cov");
    img.setAttribute("alt", "");
    if (iw > 0 && ih > 0) {
      var s = Math.max(bw / iw, bh / ih);
      var w = Math.round(iw * s);
      var h = Math.round(ih * s);
      img.style.width = w + "px";
      img.style.height = h + "px";
      img.style.left = Math.round((bw - w) / 2) + "px";
      img.style.top = Math.round((bh - h) / 2) + "px";
    } else {
      img.style.width = bw + "px";
      img.style.height = bh + "px";
      img.style.left = "0px";
      img.style.top = "0px";
    }
    box.appendChild(img);
    thumbs.show(img, src);
    return img;
  }

  // Like cover, for the part crop (fractions of the image) only.
  function coverCrop(box, src, bw, bh, iw, ih, crop) {
    var img = el("img", "cov");
    img.setAttribute("alt", "");
    var s = Math.max(bw / (iw * crop.w), bh / (ih * crop.h));
    img.style.width = Math.round(iw * s) + "px";
    img.style.height = Math.round(ih * s) + "px";
    img.style.left = Math.round(-crop.x * iw * s + (bw - crop.w * iw * s) / 2) + "px";
    img.style.top = Math.round(-crop.y * ih * s + (bh - crop.h * ih * s) / 2) + "px";
    box.appendChild(img);
    thumbs.show(img, src);
    return img;
  }

  // ---- context card ----

  function renderCtx(c) {
    var thumb = byId("ctx-thumb");
    if (thumb) thumb.className = "ctx-thumb" + (c.checker ? " chk" : "");
    icons.set(byId("ctx-icon"), c.icon === "selection" ? "selection" : c.icon === "layer" ? "layer" : c.icon === "image" ? "image" : "file");
    var img = byId("ctx-img");
    if (img) {
      // The thumbnail box is 44 px, 36 px on short panels (styles.css).
      var tr = rect(thumb);
      var tb = tr && tr.width > 0 ? Math.round(tr.width) : 44;
      if (c.thumb && c.thumb_size) {
        var s = Math.max(tb / c.thumb_size.width, tb / c.thumb_size.height);
        img.style.width = Math.round(c.thumb_size.width * s) + "px";
        img.style.height = Math.round(c.thumb_size.height * s) + "px";
        img.style.left = Math.round((tb - c.thumb_size.width * s) / 2) + "px";
        img.style.top = Math.round((tb - c.thumb_size.height * s) / 2) + "px";
      } else {
        img.style.width = tb + "px";
        img.style.height = tb + "px";
        img.style.left = "0px";
        img.style.top = "0px";
      }
      thumbs.show(img, c.thumb || null);
    }
    var cnt = byId("ctx-count");
    if (cnt) {
      cnt.textContent = c.count ? String(c.count) : "";
      show(cnt, !!c.count);
    }
    setText("ctx-title", c.title);
    var ct = byId("ctx-title");
    if (ct) ct.setAttribute("title", c.title || "");
    var d = byId("ctx-detail");
    if (d) {
      d.textContent = c.detail || "";
      d.className = c.running ? "ctx-detail run" : "ctx-detail";
    }
    var sw = byId("ctx-sel");
    var sf = byId("ctx-select");
    if (sw) show(sw, !!c.select, "flex");
    if (sf && c.select) {
      if (!selectFocused && sf.value !== c.select.value) sf.value = c.select.value;
      sf.setAttribute("title", c.select.title || "");
    }
    var p = byId("ctx-prog");
    if (p) {
      show(p, c.running, "block");
      p.style.width = Math.round(Math.max(0, Math.min(1, c.progress || 0)) * 100) + "%";
    }
  }

  // ---- action chips ----

  function renderActs(chips, more) {
    var box = byId("acts");
    if (!box) return;
    clear(box);
    for (var i = 0; i < chips.length; i++) {
      (function (c) {
        var b = el("div", c.on ? "chip on" : "chip");
        b.setAttribute("data-act", c.id);
        b.setAttribute("title", c.id === "refine" ? REFINE_TIP : c.label);
        b.appendChild(el("span", "cl", c.label));
        onClick(b, function () {
          closePop();
          ctl.selectAction(c.id);
        });
        box.appendChild(b);
      })(chips[i]);
    }
    if (more) {
      var m = el("div", more.on ? "chip more on" : "chip more");
      m.setAttribute("data-act", "more");
      m.setAttribute("data-pop", "more");
      m.setAttribute("title", "More actions");
      m.appendChild(el("span", "ml", more.label));
      m.appendChild(icons.icon(doc, "chevron-down", "chev", 12));
      onClick(m, function () {
        togglePop(m, "more");
      });
      box.appendChild(m);
    }
  }

  // ---- middle: the Takes card, Recent ----

  function tileWidth() {
    var r = rect(byId("mid-card"));
    var w = r ? r.width : panelWidth() - 24;
    // The card's padding and border, then two columns and their gap.
    return Math.max(40, Math.floor((w - 22 - TILE_GAP) / 2));
  }

  function btn(label, cls, fn, data) {
    var b = el("div", cls ? "btn " + cls : "btn");
    b.appendChild(el("span", "bl", label));
    if (data) b.setAttribute("data-btn", data);
    onClick(b, fn);
    return b;
  }

  // maxTile: the tallest a tile may be, so the card and its buttons fit the
  // middle on a short panel (fitMid); null draws tiles at their own ratio.
  function renderCard(card, maxTile) {
    var box = byId("mid-card");
    if (!box) return;
    clear(box);
    show(box, !!card, "block");
    if (!card) return;
    var sec = el("div", "card");
    sec.setAttribute("data-card", card.kind);
    var h = el("div", "card-h");
    var h3 = el("span", "h3", card.title);
    h3.setAttribute("title", card.title);
    h.appendChild(h3);
    if (card.by) {
      var by = el("span", "by");
      by.appendChild(el("span", "dot"));
      by.appendChild(el("span", null, "by " + card.by));
      h.appendChild(by);
    }
    if (card.meta) h.appendChild(el("span", "meta", card.meta));
    sec.appendChild(h);
    if (card.sub) sec.appendChild(el("div", "card-sub", card.sub));
    if (card.kind === "takes") {
      var grid = el("div", "tiles");
      var tw = tileWidth();
      for (var i = 0; i < card.takes.length; i++) {
        (function (t, i) {
          var tile = el("div", "tile" + (t.on ? " on" : "") + (i % 2 ? "" : " l") + (i >= 2 ? " r2" : ""));
          tile.setAttribute("data-take", String(i));
          tile.setAttribute("title", (t.on ? "Showing take " : "Show take ") + t.n);
          tile.style.width = tw + "px";
          var size = t.size || { width: 1, height: 1 };
          var cw = t.crop ? size.width * t.crop.w : size.width;
          var ch = t.crop ? size.height * t.crop.h : size.height;
          var th = Math.max(40, Math.min(Math.round(tw * 1.25), Math.round((tw * ch) / cw)));
          if (maxTile) th = Math.max(40, Math.min(th, maxTile));
          var w = el("div", "tw");
          w.style.width = tw - 4 + "px";
          w.style.height = th + "px";
          if (t.crop) coverCrop(w, t.thumb, tw - 4, th, size.width, size.height, t.crop);
          else cover(w, t.thumb, tw - 4, th, size.width, size.height);
          var num = el("span", "num");
          if (t.on) num.appendChild(icons.icon(doc, "eye", "eye", 12));
          num.appendChild(el("span", null, String(t.n)));
          w.appendChild(num);
          if (t.badge) {
            var b = el("span", "chk-b" + (t.badge.tone === "warn" ? " warn" : ""));
            b.appendChild(icons.icon(doc, t.badge.tone === "warn" ? "warning" : "check", null, 12));
            b.appendChild(el("span", "bt", t.badge.text));
            w.appendChild(b);
          }
          tile.appendChild(w);
          if (card.clickable)
            onClick(tile, function () {
              return ctl.showTake(i);
            });
          grid.appendChild(tile);
        })(card.takes[i], i);
      }
      sec.appendChild(grid);
      var row = el("div", "btnrow");
      if (card.keep)
        row.appendChild(
          btn(card.keep, "pri", function () {
            return ctl.keep();
          }, "keep")
        );
      var rf = btn("Refine", null, function () {
        return ctl.refine();
      }, "refine");
      rf.setAttribute("title", REFINE_TIP);
      row.appendChild(rf);
      row.appendChild(
        btn("More like this", null, function () {
          return ctl.moreLike();
        }, "more_like")
      );
      sec.appendChild(row);
    } else {
      var one = el("div", "single");
      if (card.compare) {
        var cmp = el("div", "cmp");
        [card.compare.before, card.compare.after].forEach(function (side) {
          var col = el("div", "cmp-col");
          var tile = el("div", "tw");
          tile.style.width = card.compare.tile.width + "px";
          tile.style.height = card.compare.tile.height + "px";
          coverCrop(tile, side.thumb, card.compare.tile.width, card.compare.tile.height, side.size.width, side.size.height, side.crop);
          col.appendChild(tile);
          col.appendChild(el("span", "cmp-l", side.label));
          cmp.appendChild(col);
        });
        sec.appendChild(cmp);
      } else if (card.thumb) {
        var tb = el("div", "tw");
        tb.style.width = "96px";
        tb.style.height = "64px";
        cover(tb, card.thumb, 96, 64, card.thumb_size ? card.thumb_size.width : 0, card.thumb_size ? card.thumb_size.height : 0);
        one.appendChild(tb);
      }
      var txt = el("div", "txt");
      if (card.line) txt.appendChild(el("span", card.tone === "warn" ? "warn" : null, card.line));
      one.appendChild(txt);
      sec.appendChild(one);
      var r2 = el("div", "btnrow");
      (card.actions || []).forEach(function (ca) {
        r2.appendChild(
          btn(ca.label, null, function () {
            return ctl.cardAction(ca.id);
          }, ca.id)
        );
      });
      if (card.place)
        r2.appendChild(
          btn("Place", "pri", function () {
            return ctl.placeCard();
          }, "place")
        );
      r2.appendChild(
        btn("Done", null, function () {
          return ctl.closeCard();
        }, "done")
      );
      sec.appendChild(r2);
    }
    box.appendChild(sec);
  }

  // compact: one row of 28 px thumbnails (fitMid, short panels).
  function renderRecent(list, compact) {
    var box = byId("recent");
    var row = byId("recent-row");
    show(box, list.length > 0, "block");
    if (box) box.className = "recent" + (compact ? " compact" : "");
    if (!row) return;
    var tw = compact ? 26 : 42;
    clear(row);
    for (var i = 0; i < list.length; i++) {
      (function (r) {
        var t = el("div", "rthumb");
        t.setAttribute("data-recent", r.local_id);
        t.setAttribute("title", r.title);
        t.appendChild(icons.icon(doc, r.lane === "image" ? "image" : r.lane === "edit" ? "edit" : "enhance", "ri", 16));
        cover(t, r.thumb, tw, tw, r.size ? r.size.width : 0, r.size ? r.size.height : 0);
        onClick(t, function () {
          return ctl.openRecent(r.local_id);
        });
        row.appendChild(t);
      })(list[i]);
    }
  }

  // ---- composer ----

  function chipEl(c) {
    var b = el("div", "cc cc-" + c.kind);
    b.setAttribute("data-pop", c.kind);
    b.setAttribute("title", c.title || "");
    if (c.thumb) {
      var tb = el("div", "th");
      if (c.mono) tb.appendChild(el("span", "tm", c.mono));
      cover(tb, c.thumb, 16, 16, 0, 0);
      b.appendChild(tb);
    } else if (c.mono) b.appendChild(el("span", "mono", c.mono));
    else if (c.icon) b.appendChild(icons.icon(doc, c.icon, "ci", 14));
    if (c.key_first && c.key_text) b.appendChild(el("span", "k", c.key_text));
    b.appendChild(el("span", "v", c.value));
    if (!c.key_first && c.key_text) b.appendChild(el("span", "k", c.key_text));
    onClick(b, function () {
      togglePop(b, c.kind);
    });
    return b;
  }

  // Suggest sits in the prompt box's own footer, under the field: UXP draws
  // the field above anything placed over it, so the button cannot overlap
  // the text area itself.
  function suggestEl() {
    var b = el("div", "sug");
    b.setAttribute("data-pop", "suggest");
    b.setAttribute("title", "Suggest prompts with Prompt Spark, free");
    b.appendChild(icons.icon(doc, "wand", null, 12));
    b.appendChild(el("span", null, "Suggest"));
    onClick(b, function () {
      togglePop(b, "suggest");
    });
    return b;
  }

  function renderSuggest(on) {
    var foot = byId("pfoot");
    if (!foot) return;
    clear(foot);
    show(foot, on);
    if (on) foot.appendChild(suggestEl());
  }

  function renderRefs(r) {
    var box = byId("refs");
    if (!box) return;
    clear(box);
    show(box, !!r);
    if (!r) return;
    for (var i = 0; i < r.drefs.length; i++) {
      (function (d) {
        var b = el("div", d.on ? "dref" : "dref off");
        b.setAttribute("data-dref", String(d.layer_id));
        b.setAttribute("title", d.title);
        b.appendChild(icons.icon(doc, "layer", "th", 16));
        b.appendChild(el("span", "rl", d.role));
        onClick(b, function () {
          ctl.toggleDocRef(d.layer_id);
        });
        box.appendChild(b);
      })(r.drefs[i]);
    }
    for (var k = 0; k < r.items.length; k++) {
      (function (it) {
        // The style picture (Match an image) reads like a document
        // reference: its picture, then its role.
        if (it.role) {
          var sr = el("div", "dref sref");
          sr.setAttribute("data-ref", it.id);
          sr.setAttribute("title", it.label);
          var st0 = el("div", "th");
          if (it.url) cover(st0, it.url, 24, 24, it.width || 0, it.height || 0);
          sr.appendChild(st0);
          sr.appendChild(el("span", "rl", it.role));
          var sx = el("div", "sx");
          sx.setAttribute("title", "Remove the style picture");
          sx.appendChild(icons.icon(doc, "close", null, 10));
          onClick(sx, function () {
            ctl.removeRef(it.id);
          });
          sr.appendChild(sx);
          box.appendChild(sr);
          return;
        }
        var b = el("div", "ref");
        b.setAttribute("data-ref", it.id);
        b.setAttribute("title", it.label);
        if (it.url) cover(b, it.url, 28, 28, it.width || 0, it.height || 0);
        else b.appendChild(icons.icon(doc, it.icon || "image", "ri", 16));
        if (it.removable) {
          var x = el("div", "rx");
          x.setAttribute("title", "Remove reference");
          x.appendChild(icons.icon(doc, "close", null, 10));
          onClick(x, function () {
            ctl.removeRef(it.id);
          });
          b.appendChild(x);
        }
        box.appendChild(b);
      })(r.items[k]);
    }
    if (r.add) {
      var add = el("div", "ref-add");
      add.setAttribute("data-pop", "addref");
      add.setAttribute("title", "Add a reference");
      add.appendChild(icons.icon(doc, "plus", null, 14));
      if (r.add_label) add.appendChild(el("span", null, r.add_label));
      onClick(add, function () {
        togglePop(add, "addref");
      });
      box.appendChild(add);
    }
    if (r.hint) box.appendChild(el("span", "hint", r.hint));
  }

  function renderComposer(c) {
    var agent = byId("agent-card");
    show(agent, !!c.agent);
    if (c.agent) {
      setText("agent-who", c.agent.client_name + " wants to");
      setText("agent-what", c.agent.what);
      setText("agent-q", c.agent.prompt || "");
      show(byId("agent-q"), !!c.agent.prompt, "block");
      setText("agent-meta", (c.agent.model_name ? c.agent.model_name + " · " : "") + "asked through the Scenario MCP");
      setText("agent-approve-label", "Approve · " + c.agent.cu + " CU");
    }
    var plan = byId("plan-card");
    show(plan, !!c.plan);
    if (c.plan) {
      setText("plan-who", c.plan.who);
      var ps = byId("plan-steps");
      if (ps) {
        clear(ps);
        c.plan.steps.forEach(function (stp) {
          var r = el("div", "plan-step");
          r.appendChild(el("span", "pn", stp.n + ". " + stp.label));
          r.appendChild(el("span", "pc", [stp.cu, stp.state].filter(Boolean).join(" · ")));
          ps.appendChild(r);
        });
      }
      setText("plan-all-label", c.plan.total);
      show(byId("plan-btns"), c.plan.pending, "flex");
    }
    var declined = c.message && c.message === ctl.TEXT.declined;
    setText("declined", declined ? c.message : "");
    show(byId("declined"), declined, "block");

    renderLibrary(c.library);
    var noteOnly = !!c.note;
    show(byId("c-note"), noteOnly);
    setText("c-note-text", c.note || "");
    renderRefs(noteOnly ? null : c.refs);
    show(byId("pbox"), !noteOnly && !!c.prompt);
    renderSuggest(!noteOnly && !!c.prompt && !!c.suggest);
    show(byId("noprompt"), !noteOnly && !!c.none);
    setText("noprompt-text", c.none || "");
    var pr = byId("prompt");
    if (pr) {
      // While a popover is open the field stays hidden behind its stand-in
      // (cover): UXP draws text fields above everything else.
      if (pop.covered) pop.promptShown = !noteOnly && !!c.prompt;
      else show(pr, !noteOnly && !!c.prompt, "block");
      if (c.prompt) {
        if (pr.getAttribute("placeholder") !== c.prompt.placeholder) pr.setAttribute("placeholder", c.prompt.placeholder);
        var changed = lastAction !== c.action;
        if ((changed || !promptFocused) && pr.value !== c.prompt.value) pr.value = c.prompt.value;
      }
    }
    lastAction = c.action;
    var chips = byId("cchips");
    if (chips) {
      clear(chips);
      show(chips, !noteOnly && c.chips.length > 0);
      if (!noteOnly) for (var i = 0; i < c.chips.length; i++) chips.appendChild(chipEl(c.chips[i]));
    }
    var cf = byId("confirm-card");
    show(cf, !!c.confirm, "block");
    if (c.confirm) {
      setText("confirm-text", c.confirm.text);
      setText("confirm-detail", c.confirm.detail || "");
      setText("confirm-ok-label", c.confirm.ok);
    }
    show(byId("gorow"), !noteOnly);
    var g = c.go || { label: "", cu: "", enabled: false };
    var go = byId("go");
    if (go) {
      go.className = g.enabled ? "go" : "go off";
      go.setAttribute("title", g.title || g.label);
      go.setAttribute("aria-disabled", g.enabled ? "false" : "true");
    }
    setText("go-label", g.label);
    setText("go-cu", g.cu);
    show(byId("go-cu"), !!g.cu, "block");
    show(byId("gear"), !noteOnly && c.gear);
    setText("go-reason-text", g.reason || "");
    show(byId("go-reason"), !noteOnly && !!g.reason);
    var msg = c.message && !declined ? c.message : "";
    setText("c-message-text", msg);
    show(byId("c-message"), !!msg);
    fitLibrary();
  }

  // The Library grid: a search field, the filters, three columns of square
  // tiles (the name and size in the tooltip), Show more; a click opens the
  // image, places it as a layer or adds it as a reference.
  function renderLibrary(m) {
    var box = byId("lib");
    if (!box) return;
    show(box, !!m, "flex");
    var top = byId("lib-top");
    var body = byId("lib-body");
    var fl = byId("lib-filters");
    if (top) clear(top);
    if (body) clear(body);
    if (fl) clear(fl);
    if (!m || !body) return;
    if (m.title && top) {
      var head = el("div", "lib-head");
      head.appendChild(el("span", "lib-t", m.title));
      var x = el("span", "lib-x", "Cancel");
      onClick(x, function () {
        ctl.libraryCancel();
      });
      head.appendChild(x);
      top.appendChild(head);
    }
    var sf = byId("lib-search");
    if (sf && !libFocused && sf.value !== (m.query || "")) sf.value = m.query || "";
    if (sf && !pop.covered) sf.style.display = "block";
    if (fl)
      (m.filters || []).forEach(function (f) {
        var c = el("div", f.on ? "lib-f on" : "lib-f", f.label);
        c.setAttribute("data-lib-filter", f.key);
        onClick(c, function () {
          return ctl.libraryFilter(f.key);
        });
        fl.appendChild(c);
      });
    if (m.state === "loading" && !m.items.length) body.appendChild(el("div", "lib-note", "Loading the project's images…"));
    if (m.error) body.appendChild(el("div", "lib-note warn", m.error));
    if (m.empty) body.appendChild(el("div", "lib-note", m.empty));
    // Three columns from the grid's own width (each tile keeps a 4 px
    // margin on its right); the grid scrolls inside the composer so the
    // panel keeps its header and context card (M7 layout check: 12 tiles
    // made the composer taller than a 420 px panel).
    var bw = rect(body);
    var inner = bw && bw.width > 0 ? bw.width - 8 : panelWidth() - 24 - 16 - 8;
    var w = Math.max(60, Math.floor(inner / 3) - 4);
    var ar = rect(byId("app"));
    libTile = w;
    body.style.maxHeight = Math.max(w + 8, Math.round((ar && ar.height ? ar.height : 600) * (m.mode === "ref" ? 0.3 : 0.45))) + "px";
    var row = el("div", "lib-grid");
    m.items.forEach(function (it) {
      var t = el("div", "tw lib-tile");
      t.style.width = w + "px";
      t.style.height = w + "px";
      t.setAttribute("title", it.title || it.name);
      t.setAttribute("data-lib", it.asset_id);
      if (it.thumb) cover(t, it.thumb, w, w, it.size ? it.size.width : 0, it.size ? it.size.height : 0);
      onClick(t, function () {
        return ctl.libraryPick(it.asset_id);
      });
      row.appendChild(t);
    });
    body.appendChild(row);
    if (m.more) {
      var mo = el("div", "lib-more", m.state === "loading" ? "Loading…" : "Show more");
      mo.setAttribute("data-lib-more", "1");
      onClick(mo, function () {
        return ctl.libraryMore();
      });
      body.appendChild(mo);
    }
  }

  // The grid gives way when the composer would cover the context chips:
  // its height shrinks by the overlap, down to one row of tiles.
  var libTile = 0;
  function fitLibrary() {
    var lib = byId("lib");
    var body = byId("lib-body");
    var acts = byId("acts");
    var comp = byId("composer");
    if (!lib || !body || !acts || !comp || lib.style.display === "none" || !libTile) return;
    var last = acts.children && acts.children.length ? rect(acts.children[acts.children.length - 1]) : rect(acts);
    var c = rect(comp);
    var b = rect(body);
    if (!last || !c || !b) return;
    var over = Math.ceil(last.bottom + 8 - c.top);
    if (over > 0) body.style.maxHeight = Math.max(Math.round(libTile * 0.6), Math.floor(b.height - over)) + "px";
  }

  // ---- popovers ----

  function closePop() {
    pop.kind = null;
    pop.anchor = null;
    pop.seq++;
    var p = byId("pop");
    if (p) clear(p);
    show(p, false);
    show(byId("pop-scrim"), false);
    coverPrompt(false);
  }

  // UXP draws an sp-textarea above every other element, so an open popover
  // would show the prompt through it (verified live on 27.11). While one is
  // open, the field is hidden and a plain stand-in of the same size shows its
  // text, so the layout does not move.
  function coverPrompt(on) {
    // The Select… field is a native field too: hidden while a popover is
    // open (its row keeps its height, so nothing moves).
    var sf = byId("ctx-select");
    if (sf) sf.style.display = on ? "none" : "block";
    var lf = byId("lib-search");
    if (lf) lf.style.display = on ? "none" : "block";
    var t = byId("prompt");
    var g = byId("prompt-ghost");
    var comp = byId("composer");
    if (!t || !g) return;
    if (on && !pop.covered) {
      var shown = t.style.display !== "none";
      pop.covered = true;
      pop.promptShown = shown;
      if (comp) comp.className = "composer covered";
      if (!shown) return;
      var r = t.getBoundingClientRect ? t.getBoundingClientRect() : null;
      g.style.height = (r && r.height ? Math.round(r.height) : 46) + "px";
      g.textContent = t.value || t.getAttribute("placeholder") || "";
      g.className = t.value ? "prompt-ghost" : "prompt-ghost ph";
      g.style.display = "block";
      t.style.display = "none";
    } else if (!on && pop.covered) {
      pop.covered = false;
      if (comp) comp.className = "composer";
      g.style.display = "none";
      t.style.display = pop.promptShown ? "block" : "none";
    }
  }

  function togglePop(anchor, kind) {
    if (pop.kind === kind && pop.anchor === anchor) {
      closePop();
      return;
    }
    openPop(anchor, kind);
  }

  // A chip's own menu (takes, size, factor...) is narrow, as the prototype
  // draws it; More, Jobs, the agent and the reference sources take 280.
  var WIDE = { more: 1, jobs: 1, agent: 1, addref: 1, model: 1, style: 1, stylesrc: 1, suggest: 1, adv: 1 };

  function place(p, anchor, kind) {
    var app = rect(byId("app"));
    // A composer chip read as an empty box on 27.11 while its row had one:
    // the row then stands in for it.
    var r = rect(anchor) || rect(anchor && anchor.parentNode);
    var W = app ? app.width : 320;
    var width = Math.max(180, Math.min(WIDE[kind] ? 280 : 220, W - 16));
    p.style.height = "";
    p.style.width = width + "px";
    if (!app || !r) {
      p.style.left = "8px";
      p.style.top = "48px";
      return;
    }
    // A narrow menu ends at its chip's right edge when it does not fit
    // from its left edge.
    var left = Math.min(Math.max(8, r.left - app.left), W - width - 8);
    if (!WIDE[kind] && r.right - app.left - width >= 8 && r.left - app.left + width > W - 8) left = r.right - app.left - width;
    p.style.left = Math.max(8, Math.round(left)) + "px";
    // A popover opening upward stops under the header: header text was seen
    // drawn through it on 27.11.
    var hdr = rect(byId("header"));
    var floor = hdr ? hdr.bottom : app.top;
    var above = r.top - floor;
    var below = app.bottom - r.bottom;
    pop.upAt = null;
    if (above > below) {
      pop.upAt = r.top - app.top - 6;
      p.style.top = "auto";
      p.style.bottom = Math.round(app.bottom - r.top + 6) + "px";
      p.style.maxHeight = Math.max(120, Math.round(above - 14)) + "px";
    } else {
      p.style.bottom = "auto";
      p.style.top = Math.round(r.bottom - app.top + 6) + "px";
      p.style.maxHeight = Math.max(120, Math.round(below - 14)) + "px";
    }
  }

  function openPop(anchor, kind) {
    var seq = ++pop.seq;
    pop.kind = kind;
    pop.anchor = anchor;
    return Promise.resolve(kind === "agent" || kind === "jobs" ? localMenu(kind) : ctl.menu(kind)).then(
      function (m) {
        if (seq !== pop.seq) return;
        var p = byId("pop");
        if (!p) return;
        clear(p);
        fillPop(p, kind, m || {});
        // The clicked chip may have been drawn again meanwhile, leaving the
        // old one without a box (seen live on 27.11): anchor on the new one.
        if (!rect(anchor)) anchor = findAnchor(kind) || anchor;
        pop.anchor = anchor;
        place(p, anchor, kind);
        coverPrompt(true);
        show(byId("pop-scrim"), true, "block");
        show(p, true);
        fitPop(p);
        // Prices still checking show "…"; the menu is drawn again with them.
        if (m && m.later && typeof m.later.then === "function") {
          m.later.then(function () {
            if (seq !== pop.seq || pop.kind !== kind) return null;
            return Promise.resolve(ctl.menu(kind)).then(function (m2) {
              if (seq !== pop.seq || pop.kind !== kind || !m2) return;
              var keep = p.scrollTop;
              clear(p);
              fillPop(p, kind, m2);
              fitPop(p);
              p.scrollTop = keep;
            });
          }).then(null, report);
        }
      },
      function (e) {
        report(e);
        closePop();
      }
    );
  }

  // UXP stretched a popover anchored by its bottom up to its max height
  // (seen live on 27.11): give it the height of its rows when they need less.
  // Measured once UXP has laid the rows out (right after display they
  // still read the stretched box).
  function fitPop(p) {
    var seq = pop.seq;
    var tries = 0;
    function again() {
      if (seq !== pop.seq || !pop.kind) return;
      if (!rect(pop.anchor)) {
        var a = findAnchor(pop.kind);
        if (a) pop.anchor = a;
      }
      if (!rect(pop.anchor) && ++tries < 12) {
        setTimeout(again, 50);
        return;
      }
      if (rect(pop.anchor)) place(p, pop.anchor, pop.kind);
      fitNow(p);
    }
    setTimeout(again, 30);
  }

  function fitNow(p) {
    var need = Math.ceil((p.scrollHeight || 0) + 8);
    var max = parseFloat(p.style.maxHeight) || 0;
    if (!(need > 20 && (!max || need < max))) return;
    p.style.height = need + "px";
    // Its bottom was ignored once the height was set (seen live on 27.11):
    // an upward menu is placed by its top, just above its chip.
    if (pop.upAt !== null && pop.upAt !== undefined) {
      p.style.top = Math.round(pop.upAt - need) + "px";
      p.style.bottom = "";
    }
  }

  function localMenu(kind) {
    if (kind === "agent") return o.agentMenu ? o.agentMenu() : { title: "Agent", text: "No agent connected." };
    if (kind === "jobs") return o.jobsMenu ? o.jobsMenu() : { title: "Jobs", rows: [] };
    return { title: null };
  }

  function h5(p, t) {
    p.appendChild(el("div", "h5", t));
  }

  function mi(it, fn) {
    var b = el("div", "mi");
    if (it.disabled) b.setAttribute("aria-disabled", "true");
    if (it.title) b.setAttribute("title", it.title);
    var chk = el("span", "chkm");
    if (it.checked) chk.appendChild(icons.icon(doc, "check", null, 14));
    b.appendChild(chk);
    if (it.thumb) {
      // The model's letters sit under its picture: a model without one, or
      // a picture that does not load, still shows who it is.
      var tb = el("div", "th");
      if (it.mono) tb.appendChild(el("span", "tm", it.mono));
      cover(tb, it.thumb, 28, 28, 0, 0);
      b.appendChild(tb);
    } else if (it.mono) b.appendChild(el("span", "mono", it.mono));
    var mt = el("div", "mt");
    mt.appendChild(el("span", "mn", it.label));
    if (it.sub) mt.appendChild(el("span", "ms", it.sub));
    if (it.tag) mt.appendChild(el("span", "tag", it.tag));
    b.appendChild(mt);
    if (it.right) b.appendChild(el("span", "r", it.right));
    if (fn && !it.disabled) onClick(b, fn);
    return b;
  }

  function choose(kind, value) {
    closePop();
    ctl.choose(kind, value);
  }

  function fillPop(p, kind, m) {
    p.setAttribute("data-menu", kind);
    if (kind === "more") {
      for (var g = 0; g < (m.groups || []).length; g++) {
        h5(p, m.groups[g].title);
        for (var i = 0; i < m.groups[g].items.length; i++) {
          (function (it) {
            var row = el("div", "mrow");
            row.setAttribute("data-pick", it.id);
            row.appendChild(
              mi({ label: it.label, sub: it.sub, right: it.right, checked: it.selected }, function () {
                closePop();
                ctl.selectAction(it.id);
              })
            );
            var pin = el("div", it.pinned ? "pin on" : it.can_pin ? "pin" : "pin off");
            pin.setAttribute("data-pin", it.id);
            pin.setAttribute("title", it.pinned ? "Unpin from the chips" : it.can_pin ? "Pin to the chips" : "Up to 6 chips: unpin one first");
            pin.appendChild(icons.icon(doc, "pin", null, 14));
            if (it.can_pin)
              onClick(pin, function () {
                ctl.togglePin(it.id);
                var fresh = ctl.menu("more");
                Promise.resolve(fresh).then(function (m2) {
                  if (pop.kind !== "more") return;
                  clear(p);
                  fillPop(p, "more", m2);
                });
              });
            row.appendChild(pin);
            p.appendChild(row);
          })(m.groups[g].items[i]);
        }
      }
      return;
    }
    if (kind === "suggest") {
      h5(p, m.title || "Suggest");
      if (m.from && (m.items || []).length) p.appendChild(el("div", "ptxt", m.from));
      if (m.text) p.appendChild(el("div", "ptxt", m.text));
      for (var si = 0; si < (m.items || []).length; si++) {
        (function (text, i) {
          var b = el("div", "mi sp3");
          b.setAttribute("data-value", String(i));
          b.setAttribute("data-sug", String(i));
          b.setAttribute("title", text);
          var mt = el("div", "mt");
          mt.appendChild(el("span", "mn", text));
          b.appendChild(mt);
          onClick(b, function () {
            choose("suggest", i);
          });
          p.appendChild(b);
        })(m.items[si], si);
      }
      if (m.note) {
        p.appendChild(el("div", "sep"));
        p.appendChild(el("div", "ptxt", m.note));
      }
      return;
    }
    if (kind === "adv") {
      h5(p, m.title || "Advanced");
      var rows = m.rows || [];
      if (!rows.length) p.appendChild(el("div", "ptxt", "Nothing to set for this model."));
      for (var r = 0; r < rows.length; r++) {
        (function (row) {
          var line = el("div", "row");
          line.appendChild(el("span", "rk", row.label));
          var opts = el("div", "presets");
          for (var k = 0; k < row.options.length; k++) {
            (function (op) {
              var b = el("div", op[0] === row.value ? "pb on" : "pb", op[1]);
              b.setAttribute("data-adv", row.name + ":" + op[0]);
              onClick(b, function () {
                ctl.choose("adv", { name: row.name, value: op[0] });
                Promise.resolve(ctl.menu("adv")).then(function (m2) {
                  if (pop.kind !== "adv") return;
                  clear(p);
                  fillPop(p, "adv", m2);
                });
              });
              opts.appendChild(b);
            })(row.options[k]);
          }
          line.appendChild(opts);
          p.appendChild(line);
        })(rows[r]);
      }
      return;
    }
    if (kind === "jobs") {
      h5(p, m.title || "Jobs");
      var rows = m.rows || [];
      if (!rows.length) p.appendChild(el("div", "ptxt", m.empty || ""));
      for (var jr = 0; jr < rows.length; jr++) {
        (function (row) {
          var b = mi({ label: row.label, sub: row.sub, checked: row.done }, function () {
            closePop();
            if (o.openJobs) o.openJobs();
          });
          b.setAttribute("data-job", row.local_id);
          if (row.attention) b.setAttribute("class", "mi attention");
          p.appendChild(b);
        })(rows[jr]);
      }
      p.appendChild(el("div", "sep"));
      if (m.note) p.appendChild(el("div", "ptxt", m.note));
      var all = mi({ label: m.all || "All jobs", sub: m.all_sub || "" }, function () {
        closePop();
        if (o.openJobs) o.openJobs();
      });
      all.setAttribute("data-value", "all");
      p.appendChild(all);
      return;
    }
    if (kind === "agent") {
      h5(p, m.title || "Agent");
      p.appendChild(el("div", "ptxt", m.text || ""));
      if (o.openSettings) {
        p.appendChild(el("div", "sep"));
        p.appendChild(
          mi({ label: "Connect an AI agent", sub: "Settings" }, function () {
            closePop();
            o.openSettings();
          })
        );
      }
      return;
    }
    var groups = m.groups || [{ title: m.title, items: m.items || [] }];
    for (var gi = 0; gi < groups.length; gi++) {
      if (gi > 0) p.appendChild(el("div", "sep"));
      if (groups[gi].title) h5(p, groups[gi].title);
      for (var ii = 0; ii < groups[gi].items.length; ii++) {
        (function (it) {
          var b = mi(it, function () {
            // Match an image asks for the picture next, from the same chip.
            if (kind === "style" && it.value === "match") return openPop(pop.anchor, "stylesrc");
            if (kind === "addref") {
              closePop();
              var v = String(it.value);
              if (v.indexOf("pin:") === 0) return ctl.pinDocRef(v.slice(4));
              return ctl.addRef(v);
            }
            choose(kind, it.value);
          });
          b.setAttribute("data-value", it.value === null || it.value === undefined ? "" : typeof it.value === "object" ? String(it.value.id) : String(it.value));
          p.appendChild(b);
        })(groups[gi].items[ii]);
      }
    }
    if (kind === "model" && m.all && o.openPicker) {
      p.appendChild(el("div", "sep"));
      p.appendChild(
        mi({ label: "All models…", sub: "Search the catalog" }, function () {
          closePop();
          o.openPicker(m.lane || null);
        })
      );
    }
    if (m.note) {
      p.appendChild(el("div", "sep"));
      p.appendChild(el("div", "ptxt", m.note));
    }
  }

  // ---- the middle on short panels ----

  // Recent on this document collapses gracefully (AGENTS.md, Panel UI,
  // "Short panels"): the middle shows Recent at full size when it fits
  // under the Takes card, else one row of small thumbnails, else nothing
  // (the Takes card wins, Recent comes back when there is room). The empty
  // line goes first: it shows only when it fits whole. Needs layout boxes: skipped where
  // there are none (tests).
  var lastRecent = [];
  var lastCard = null;
  // UXP did not always report the overflow in scrollHeight (seen on 27.11
  // at the 420 px dock), so the boxes of the middle's shown children are
  // compared with its own as well.
  function overflows(mid) {
    if (typeof mid.scrollHeight === "number" && typeof mid.clientHeight === "number" && mid.clientHeight > 0 && mid.scrollHeight > mid.clientHeight + 1) return true;
    var r = rect(mid);
    if (!r) return false;
    var kids = mid.children || [];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.style && k.style.display === "none") continue;
      var kr = rect(k);
      if (kr && kr.height > 0 && kr.bottom > r.bottom + 1) return true;
    }
    return false;
  }
  function fitMid() {
    var mid = byId("mid");
    var r = rect(mid);
    if (!r || !(r.height > 0)) return;
    var empty = byId("mid-empty");
    if (empty && empty.style && empty.style.display !== "none" && overflows(mid)) show(empty, false);
    // The Takes card's buttons stay in view: its tiles get shorter first.
    var cardBox = byId("mid-card");
    var cr = rect(cardBox);
    if (lastCard && lastCard.kind === "takes" && cr && cr.bottom > r.bottom + 1) {
      var tile = cardBox.querySelector ? cardBox.querySelector(".tw") : null;
      var tr = rect(tile);
      if (tr) {
        var rows = lastCard.takes.length > 2 ? 2 : 1;
        var over = cr.bottom - r.bottom + 2;
        var cap = Math.floor(tr.height - over / rows);
        if (cap >= 40 && cap < tr.height) renderCard(lastCard, cap);
      }
    }
    var box = byId("recent");
    if (lastRecent.length && box && overflows(mid)) {
      renderRecent(lastRecent, true);
      if (overflows(mid)) show(box, false);
    }
  }

  // ---- drawing ----

  function render() {
    if (drawing) return;
    drawing = true;
    try {
      var m = ctl.model();
      renderCtx(m.ctx);
      renderActs(m.chips, m.more);
      lastCard = m.card || null;
      renderCard(m.card);
      lastRecent = m.recent || [];
      renderRecent(lastRecent, false);
      var empty = byId("mid-empty");
      if (empty) {
        empty.textContent = m.empty_mid || "";
        show(empty, !!m.empty_mid, "block");
      }
      renderComposer(m.composer);
      fitMid();
      // An open chip menu follows its chip (the composer was drawn again).
      if (pop.kind && pop.anchor && !pop.anchor.parentNode) {
        var a = findAnchor(pop.kind);
        if (a) {
          pop.anchor = a;
          var p = byId("pop");
          // The new chip has no box until UXP lays it out (it read as none
          // and the menu jumped under the header, seen live on 27.11).
          if (p)
            setTimeout(function () {
              if (pop.anchor !== a || !pop.kind) return;
              place(p, a, pop.kind);
              fitNow(p);
            }, 30);
        } else closePop();
      }
    } catch (e) {
      report(e);
    } finally {
      drawing = false;
    }
  }

  function findAnchor(kind) {
    var ids = ["cchips", "acts", "refs", "pfoot"];
    for (var i = 0; i < ids.length; i++) {
      var box = byId(ids[i]);
      var kids = box ? box.children || [] : [];
      for (var k = 0; k < kids.length; k++) if (kids[k].getAttribute && kids[k].getAttribute("data-pop") === kind) return kids[k];
    }
    if (kind === "adv") return byId("gear");
    if (kind === "agent") return byId("agent-hit");
    if (kind === "jobs") return byId("jobs");
    return null;
  }

  // ---- static controls ----

  var pr0 = byId("prompt");
  if (pr0) {
    pr0.addEventListener("input", function () {
      ctl.setPrompt(pr0.value);
    });
    pr0.addEventListener("focus", function () {
      promptFocused = true;
    });
    pr0.addEventListener("blur", function () {
      promptFocused = false;
    });
  }
  var libFocused = false;
  var lib0 = byId("lib-search");
  if (lib0) {
    lib0.addEventListener("input", function () {
      ctl.librarySearch(lib0.value);
    });
    lib0.addEventListener("focus", function () {
      libFocused = true;
    });
    lib0.addEventListener("blur", function () {
      libFocused = false;
    });
  }
  var selectFocused = false;
  var sel0 = byId("ctx-select");
  if (sel0) {
    sel0.addEventListener("input", function () {
      ctl.setSelect(sel0.value);
    });
    sel0.addEventListener("focus", function () {
      selectFocused = true;
    });
    sel0.addEventListener("blur", function () {
      selectFocused = false;
    });
    sel0.addEventListener("keydown", function (ev) {
      if (ev && (ev.key === "Enter" || ev.keyCode === 13)) {
        closePop();
        ctl.go();
      }
    });
  }
  var go0 = byId("go");
  if (go0)
    onClick(go0, function () {
      closePop();
      return ctl.go();
    });
  var gear0 = byId("gear");
  if (gear0)
    onClick(gear0, function () {
      togglePop(gear0, "adv");
    });
  var scrim = byId("pop-scrim");
  if (scrim) onClick(scrim, closePop);
  var ok0 = byId("confirm-ok");
  if (ok0)
    onClick(ok0, function () {
      return ctl.confirmOk();
    });
  var cancel0 = byId("confirm-cancel");
  if (cancel0)
    onClick(cancel0, function () {
      ctl.confirmCancel();
    });
  var ap0 = byId("agent-approve");
  if (ap0)
    onClick(ap0, function () {
      ctl.agentDecision(true);
    });
  var de0 = byId("agent-decline");
  if (de0)
    onClick(de0, function () {
      ctl.agentDecision(false);
    });
  [["plan-all", "all"], ["plan-steps-btn", "steps"], ["plan-decline", "decline"]].forEach(function (pb) {
    var b = byId(pb[0]);
    if (b)
      onClick(b, function () {
        ctl.planDecision(pb[1]);
      });
  });
  var agentHit = byId("agent-hit");
  if (agentHit)
    onClick(agentHit, function () {
      togglePop(agentHit, "agent");
    });
  var jobsHit = byId("jobs");
  if (jobsHit && o.jobsMenu)
    onClick(jobsHit, function () {
      togglePop(jobsHit, "jobs");
    });

  ctl.onChange(render);
  // A resized panel or dock fits the middle again.
  if (o.global && typeof o.global.addEventListener === "function") {
    o.global.addEventListener("resize", function () {
      if (!drawing) render();
    });
  }
  closePop();
  render();

  return {
    render: render,
    closePop: closePop,
    openPop: function (kind) {
      var a = findAnchor(kind);
      return a ? openPop(a, kind) : Promise.resolve(null);
    },
    popKind: function () {
      return pop.kind;
    }
  };
}

module.exports = { createCreateView: createCreateView };
