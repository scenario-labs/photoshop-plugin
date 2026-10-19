"use strict";
// Layout rules of plugin/index.html and plugin/styles.css that Node can check
// without a renderer. The widths behind them were measured in UXP 9.4 on
// Photoshop 27.11 (AGENTS.md, "Panel layout"): at the 280 px minimum width the
// header holds on one row with "Not signed in" in full, and on the Not signed
// in screen the key fields and Save and test sit within the first 360 px.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const manifest = require("../../plugin/manifest.json");

const PLUGIN = path.resolve(__dirname, "..", "..", "plugin");
const html = fs.readFileSync(path.join(PLUGIN, "index.html"), "utf8");
const css = fs.readFileSync(path.join(PLUGIN, "styles.css"), "utf8");

// selector -> { property: value }, for the plain rules styles.css uses.
function rules(text) {
  const out = {};
  const body = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = {};
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    for (const sel of m[1].split(",")) out[sel.trim()] = Object.assign(out[sel.trim()] || {}, decls);
  }
  return out;
}

function classesOf(id) {
  const m = new RegExp(`<[a-z-]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(html);
  assert.ok(m, `#${id} in index.html`);
  const c = /\bclass="([^"]*)"/.exec(m[0]);
  return c ? c[1].split(/\s+/) : [];
}

const R = rules(css);

test("header: one row; the name, the dot, Jobs and Settings keep their size and never wrap", () => {
  assert.equal(R[".header"]["flex-wrap"], "nowrap");
  assert.equal(R[".header"]["display"], "flex");
  assert.equal(R[".fixed"]["flex"], "0 0 auto");
  assert.equal(R[".fixed"]["white-space"], "nowrap");
  const header = /<header class="header">([\s\S]*?)<\/header>/.exec(html)[1];
  assert.ok(/<span class="mark fixed">Scenario<\/span>/.test(header));
  for (const id of ["agent-dot", "jobs", "open-settings"]) assert.ok(classesOf(id).includes("fixed"), `#${id} is fixed`);
});

test("header: the project label shrinks on one line and ends with an ellipsis; the full name is the tooltip", () => {
  assert.ok(/<sp-action-button quiet class="project tight" id="project"><span class="project-label" id="project-label">Not signed in<\/span><\/sp-action-button>/.test(html));
  assert.equal(R[".project"]["flex"], "1 1 0");
  assert.equal(R[".project"]["min-width"], "0");
  assert.equal(R[".project"]["overflow"], "hidden");
  // UXP applies text-overflow to a block element, not to a button's own label.
  assert.equal(R[".project-label"]["display"], "block");
  assert.equal(R[".project-label"]["white-space"], "nowrap");
  assert.equal(R[".project-label"]["overflow"], "hidden");
  assert.equal(R[".project-label"]["text-overflow"], "ellipsis");
  for (const id of ["project", "jobs", "open-settings"]) assert.ok(classesOf(id).includes("tight"), `#${id} has the narrow padding`);
  assert.equal(R[".tight"]["padding-left"], "4px");
  assert.equal(R[".tight"]["padding-right"], "4px");
  const src = fs.readFileSync(path.join(PLUGIN, "src", "ui", "account-panel.js"), "utf8");
  assert.ok(/setText\("project-label", label\)/.test(src), "the label is written to the span, which keeps the button's markup");
  assert.ok(/setAttribute\("title", label\)/.test(src));
});

test("the measured minimum width is the manifest's", () => {
  assert.deepEqual(manifest.entrypoints[0].minimumSize, { width: 280, height: 420 });
});

test("Not signed in screen: the key fields and Save and test come before the help on getting a key", () => {
  const view = /<section class="view" id="view-signin">([\s\S]*?)<\/section>/.exec(html)[1];
  const at = (id) => {
    const i = view.indexOf(`id="${id}"`);
    assert.ok(i >= 0, `#${id} in the sign-in view`);
    return i;
  };
  const before = view.slice(0, at("signin-key")).match(/\bid="[^"]+"/g);
  assert.deepEqual(before, ['id="signin-back"', 'id="signin-title"', 'id="signin-disclosure"', 'id="signin-step2"']);
  assert.ok(at("signin-key") < at("signin-secret") && at("signin-secret") < at("signin-save"));
  for (const id of ["signin-step1", "signin-create-key", "signin-admins", "signin-copy-request", "signin-no-account", "signin-plan", "signin-see-plans", "signin-create-account"]) {
    assert.ok(at(id) > at("signin-save"), `#${id} follows Save and test`);
  }
  // A failed check shows its message right under the button.
  assert.ok(at("signin-status") > at("signin-save") && at("signin-status") < at("signin-step1"));
});
