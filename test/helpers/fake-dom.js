"use strict";
// A small DOM built from the real plugin/index.html: every element with an id
// or a data-lane, with its tag, attributes and initial text. Enough for the
// panel code (text, value, attributes, style, events, children), nothing more.
//
// macPassword (default true) imitates UXP on macOS, where a password field's
// value reads as empty (SPEC 4.2 step 4): the value can be read only while the
// field's type is "text".

const fs = require("node:fs");
const path = require("node:path");

const INDEX = path.resolve(__dirname, "..", "..", "plugin", "index.html");

function parseAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g)) attrs[m[1]] = m[2] === undefined ? "" : m[2];
  return attrs;
}

function createFakeDocument({ html = fs.readFileSync(INDEX, "utf8"), macPassword = true } = {}) {
  const els = new Map();
  const all = [];
  const lanes = [];
  const doc = { els, all, lanes, focused: null };

  function makeEl(tag, attrs = {}, text = "") {
    const handlers = {};
    const node = {
      tagName: tag.toUpperCase(),
      attrs: { ...attrs },
      style: {},
      children: [],
      parentNode: null,
      _text: text,
      _value: attrs.value || "",
      get id() {
        return node.attrs.id || "";
      },
      get textContent() {
        return node.children.length ? node.children.map((c) => c.textContent).join("") : node._text;
      },
      set textContent(v) {
        node.children = [];
        node._text = String(v);
      },
      get value() {
        if (macPassword && node.attrs.type === "password") return "";
        return node._value;
      },
      set value(v) {
        node._value = String(v);
      },
      get className() {
        return node.attrs.class || "";
      },
      set className(v) {
        node.attrs.class = String(v);
      },
      get firstChild() {
        return node.children[0] || null;
      },
      getAttribute: (k) => (k in node.attrs ? node.attrs[k] : null),
      setAttribute: (k, v) => {
        node.attrs[k] = String(v);
      },
      removeAttribute: (k) => {
        delete node.attrs[k];
      },
      addEventListener: (type, fn) => {
        (handlers[type] = handlers[type] || []).push(fn);
      },
      dispatch(type, extra = {}) {
        const ev = {
          type,
          defaultPrevented: false,
          preventDefault() {
            ev.defaultPrevented = true;
          },
          ...extra
        };
        for (const fn of handlers[type] || []) fn(ev);
        return ev;
      },
      click: () => node.dispatch("click"),
      focus: () => {
        doc.focused = node;
      },
      appendChild(child) {
        node.children.push(child);
        child.parentNode = node;
        return child;
      },
      removeChild(child) {
        node.children = node.children.filter((c) => c !== child);
        child.parentNode = null;
        return child;
      }
    };
    all.push(node);
    return node;
  }

  for (const m of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>([^<]*)/g)) {
    const attrs = parseAttrs(m[2]);
    if (!attrs.id && attrs["data-lane"] === undefined) continue;
    const el = makeEl(m[1], attrs, m[3].trim());
    if (attrs.id) els.set(attrs.id, el);
    if (attrs["data-lane"] !== undefined) lanes.push(el);
  }

  doc.getElementById = (id) => els.get(id) || null;
  doc.querySelectorAll = (sel) => (sel === "[data-lane]" ? lanes.slice() : []);
  doc.createElement = (tag) => makeEl(tag);
  doc.byId = (id) => {
    const el = els.get(id);
    if (!el) throw new Error(`no element #${id} in index.html`);
    return el;
  };
  doc.text = (id) => doc.byId(id).textContent;
  // Views, sub-views, banners, menus and disclosures are hidden by the
  // stylesheet until the code gives them a display.
  doc.shown = (id) => {
    const el = doc.byId(id);
    const hiddenByCss = /\b(view|subview|banner|menu|details)\b/.test(el.className);
    const d = el.style.display;
    return hiddenByCss ? !!d && d !== "none" : d !== "none";
  };
  // A paste into a field: the paste event with clipboard data, then, unless
  // the handler prevented it, the browser's own insert and an input event.
  doc.paste = (id, text, { clipboardData = true } = {}) => {
    const el = doc.byId(id);
    const ev = el.dispatch("paste", clipboardData ? { clipboardData: { getData: () => text } } : {});
    if (!ev.defaultPrevented) {
      el._value = text;
      el.dispatch("input");
    }
  };
  doc.type = (id, text) => {
    const el = doc.byId(id);
    el._value = text;
    el.dispatch("input");
  };
  // Every string the panel holds: texts, values and attributes.
  doc.allStrings = () => {
    const out = [];
    for (const el of all) {
      out.push(el.textContent, el._value);
      for (const v of Object.values(el.attrs)) out.push(v);
    }
    return out;
  };
  return doc;
}

module.exports = { createFakeDocument };
