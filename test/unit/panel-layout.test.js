"use strict";
// Layout rules of plugin/index.html and plugin/styles.css that Node can check
// without a renderer. What UXP 9.4 on Photoshop 27.11 supports was measured
// with the probe plugin (AGENTS.md, "Panel UI"): flexbox, absolute
// positioning, width media queries and inline SVG work; CSS grid, gap,
// position: sticky and aspect-ratio do not. These tests hold the structure
// that the live captures at 280, 320 and 400 px were taken on; they cannot
// measure text, so the widths below are budgets, not renders.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const manifest = require("../../plugin/manifest.json");
const icons = require("../../plugin/src/ui/icons.js");
const view = require("../../plugin/src/ui/view.js");
const menu = require("../../plugin/src/ui/menu.js");
const lanes = require("../../plugin/src/ui/lanes.js");
const picker = require("../../plugin/src/ui/picker.js");
const jobsText = require("../../plugin/src/ui/jobs-text.js");
const accountView = require("../../plugin/src/ui/account-view.js");

const PLUGIN = path.resolve(__dirname, "..", "..", "plugin");
const html = fs.readFileSync(path.join(PLUGIN, "index.html"), "utf8");
const css = fs.readFileSync(path.join(PLUGIN, "styles.css"), "utf8");
const MIN_WIDTH = manifest.entrypoints[0].minimumSize.width;

// selector -> { property: value } for the plain rules, and the rules inside
// each @media block by its condition.
function parse(text) {
  const body = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const media = {};
  const flat = body.replace(/@media\s*([^{]+)\{((?:[^{}]*\{[^}]*\})*)\s*\}/g, (all, cond, inner) => {
    media[cond.trim()] = rules(inner);
    return "";
  });
  return { plain: rules(flat), media };
}
function rules(text) {
  const out = {};
  for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = {};
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    for (const sel of m[1].split(",")) out[sel.trim()] = Object.assign(out[sel.trim()] || {}, decls);
  }
  return out;
}

function tagOf(id) {
  const m = new RegExp(`<[a-z-]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(html);
  assert.ok(m, `#${id} in index.html`);
  return m[0];
}
function classesOf(id) {
  const c = /\bclass="([^"]*)"/.exec(tagOf(id));
  return c ? c[1].split(/\s+/) : [];
}
function section(id) {
  const m = new RegExp(`<section class="view" id="${id}">([\\s\\S]*?)</section>`).exec(html);
  assert.ok(m, `#${id}`);
  return m[1];
}
function px(v) {
  return Number(String(v).replace("px", ""));
}

const { plain: R, media: M } = parse(css);

test("the stylesheet uses only what UXP 9.4 lays out: no grid, gap, sticky or aspect-ratio", () => {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/display:\s*(inline-)?grid/.test(body));
  assert.ok(!/(^|[;{\s])(row-|column-)?gap\s*:/.test(body));
  assert.ok(!/position:\s*sticky/.test(body));
  assert.ok(!/aspect-ratio/.test(body));
  // Colors come from the host so the four brightness themes apply.
  assert.equal(R["body"]["color"], "var(--uxp-host-text-color)");
  assert.equal(R["body"]["background-color"], "var(--uxp-host-background-color)");
  assert.equal(R["body"]["font-size"], "12px");
});

test("body scrolls, prompt bar pinned: one flex column whose middle part scrolls", () => {
  assert.equal(R["html"]["overflow"], "hidden");
  assert.equal(R[".app"]["display"], "flex");
  assert.equal(R[".app"]["flex-direction"], "column");
  assert.equal(R[".app"]["height"], "100vh");
  assert.equal(R[".app"]["overflow"], "hidden");
  assert.equal(R[".view"]["flex-direction"], "column");
  assert.equal(R[".view"]["min-height"], "0");
  assert.equal(R[".scroll"]["flex"], "1 1 auto");
  assert.equal(R[".scroll"]["min-height"], "0");
  assert.equal(R[".scroll"]["overflow-y"], "auto");
  assert.equal(R[".foot"]["flex"], "0 0 auto");
  assert.equal(R[".hd"]["flex"], "0 0 auto");
  assert.equal(R[".tabs"]["flex"], "0 0 auto");
  // In the main view: tabs, then the part that scrolls, then the foot with
  // the prompt and Generate, in that order and as direct parts of the view.
  const main = section("view-main");
  const at = (id) => main.indexOf(`id="${id}"`);
  assert.ok(classesOf("main-scroll").includes("scroll"));
  assert.ok(classesOf("main-foot").includes("foot"));
  assert.ok(at("lane-tabs") < at("main-scroll") && at("main-scroll") < at("main-foot"));
  for (const id of ["prompt-bar", "prompt", "takes-select", "size-select", "generate"]) assert.ok(at(id) > at("main-foot"), `#${id} is in the pinned foot`);
  for (const id of ["model-card", "target-row", "refs-section", "lane-body", "tray"]) assert.ok(at(id) > at("main-scroll") && at(id) < at("main-foot"), `#${id} scrolls`);
  // The foot holds the prompt bar only, so results never squeeze the body.
  const foot = main.slice(main.indexOf('<div class="foot" id="main-foot">'));
  assert.ok(/^<div class="foot" id="main-foot">\s*<div class="prompt-bar" id="prompt-bar">/.test(foot), "the foot starts with the prompt bar");
  // Every other view: its header row, then one part that scrolls.
  for (const v of ["view-signin", "view-jobs", "view-projects", "view-settings"]) {
    const body = section(v);
    assert.ok(/<div class="subhead">/.test(body), `${v} has a header row`);
    assert.equal((body.match(/class="scroll"/g) || []).length, 1, `${v} scrolls once`);
  }
});

test("header: one row of a mark, the project, the agent dot and Jobs; nothing else", () => {
  assert.equal(R[".hd"]["display"], "flex");
  assert.equal(R[".hd"]["flex-wrap"], "nowrap");
  assert.equal(R[".hd"]["height"], "32px");
  const header = /<header class="hd" id="header">([\s\S]*?)<\/header>/.exec(html)[1];
  const ids = header.match(/\bid="[^"]+"/g).map((x) => x.slice(4, -1));
  assert.deepEqual(ids, ["mark", "project", "project-label", "agent-hit", "agent-dot", "jobs", "jobs-badge"]);
  // No text links: Settings, Diagnostics, Sign out and About are in the panel menu.
  assert.ok(!/Settings|Diagnostics|Sign out|About/i.test(header.replace(/title="[^"]*"/g, "")));
  for (const id of ["agent-hit", "jobs"]) assert.ok(/\btitle="[^"]+"/.test(tagOf(id)), `#${id} has a tooltip`);
  // Only the project shrinks; the fixed parts leave it room at the minimum width.
  for (const sel of [".mark", ".dot-hit", ".icon-btn"]) assert.equal(R[sel]["flex"], "0 0 auto", `${sel} keeps its size`);
  const fixed = px(R[".hd"]["padding"].split(" ")[1]) + px(R[".hd"]["padding"].split(" ")[3]) + px(R[".mark"]["width"]) + px(R[".mark"]["margin-right"]) + px(R[".dot-hit"]["width"]) + 32 + 24;
  assert.ok(MIN_WIDTH - fixed >= 160, `the project name keeps ${MIN_WIDTH - fixed} px at ${MIN_WIDTH} px`);
});

test("header: the project label shrinks on one line and ends with an ellipsis; the full name is the tooltip", () => {
  assert.equal(R[".project"]["flex"], "0 1 auto");
  assert.equal(R[".project"]["min-width"], "0");
  assert.equal(R[".project"]["overflow"], "hidden");
  // UXP applies text-overflow to a block element, not to a button's own label.
  assert.equal(R[".project-label"]["display"], "block");
  assert.equal(R[".project-label"]["white-space"], "nowrap");
  assert.equal(R[".project-label"]["overflow"], "hidden");
  assert.equal(R[".project-label"]["text-overflow"], "ellipsis");
  const src = fs.readFileSync(path.join(PLUGIN, "src", "ui", "account-panel.js"), "utf8");
  assert.ok(/setText\("project-label", label\)/.test(src), "the label is written to the span, which keeps the button's markup");
  assert.ok(/"Project: " \+ label/.test(src), "the full name is in the tooltip");
});

test("lane tabs: one row that never wraps; below 380 px only the chosen tab keeps its label", () => {
  assert.equal(R[".tabs"]["flex-wrap"], "nowrap");
  assert.equal(R[".tabs"]["overflow"], "hidden");
  assert.equal(R[".tabs"]["height"], "32px");
  const narrow = M["(max-width: 379px)"];
  assert.ok(narrow, "a width media query for narrow panels");
  assert.equal(narrow[".tab .tab-label"]["display"], "none");
  assert.equal(narrow[".tab.on .tab-label"]["display"], "inline");
  const tabs = /<nav class="tabs" id="lane-tabs">([\s\S]*?)<\/nav>/.exec(html)[1];
  const each = tabs.match(/<sp-action-button[^>]*>[\s\S]*?<\/sp-action-button>/g);
  assert.equal(each.length, view.LANES.length);
  for (const t of each) {
    assert.ok(/data-icon="[a-z-]+"/.test(t), "each tab has an icon");
    assert.ok(/title="[^"]+"/.test(t), "each tab has a tooltip");
  }
  // Budget at the minimum width: four icon tabs (18 px icon, 4 px padding
  // each side, 2 px margin) and the chosen one with the longest label
  // (7 characters at 12 px, about 7 px each) fit.
  const longest = Math.max(...view.LANES.map((l) => l.label.length));
  assert.ok(longest <= 7);
  const width = 4 * (18 + 8 + 2) + (18 + 8 + 4 + longest * 7 + 2) + 8;
  assert.ok(width <= MIN_WIDTH, `${width} px of tabs at ${MIN_WIDTH} px`);
});

test("Not signed in screen: the key fields and Save and test come before the help on getting a key", () => {
  const v = section("view-signin");
  const at = (id) => {
    const i = v.indexOf(`id="${id}"`);
    assert.ok(i >= 0, `#${id} in the sign-in view`);
    return i;
  };
  const before = v.slice(0, at("signin-key")).match(/\bid="[^"]+"/g);
  assert.deepEqual(before, ['id="signin-back"', 'id="signin-title"', 'id="signin-scroll"', 'id="signin-disclosure"', 'id="signin-step2"']);
  assert.ok(at("signin-key") < at("signin-secret") && at("signin-secret") < at("signin-save"));
  for (const id of ["signin-help-title", "signin-step1", "signin-create-key", "signin-admins", "signin-copy-request", "signin-no-account", "signin-plan", "signin-see-plans", "signin-create-account"]) {
    assert.ok(at(id) > at("signin-save"), `#${id} follows Save and test`);
  }
  // A failed check shows its message right under the button.
  assert.ok(at("signin-status") > at("signin-save") && at("signin-status") < at("signin-step1"));
  assert.equal(accountView.TEXT.no_key_title, "No key yet?");
});

test("the panel menu holds Settings, Diagnostics, About and Sign Out", () => {
  const labels = menu.items().map((i) => i.label);
  for (const l of ["Settings...", "Diagnostics...", "About Scenario for Photoshop", "Sign Out..."]) assert.ok(labels.includes(l), l);
  const seen = [];
  const m = menu.createMenu({ settings: () => seen.push("settings") });
  assert.equal(m.invoke("settings"), true);
  assert.equal(m.invoke("diagnostics"), false);
  assert.deepEqual(seen, ["settings"]);
  const main = fs.readFileSync(path.join(PLUGIN, "src", "main.js"), "utf8");
  assert.ok(/menuItems: menuMod\.items\(\)/.test(main) && /invokeMenu: function \(id\)/.test(main), "the menu is declared with the panel's entrypoint");
});

test("main views say nothing about ports, helpers or later builds", () => {
  const words = /\bport\b|helper|later build|localhost|9890/i;
  // The visible text of index.html outside Settings > Connect an AI agent > Details.
  const visible = html
    .replace(/<div class="details" id="agents-details">[\s\S]*?<\/div>\s*<\/div>/, "")
    .replace(/<[^>]+>/g, " ");
  assert.ok(/Connect an AI agent/.test(visible) && /Generate/.test(visible) && /About/.test(visible), "the rest of the page is checked");
  assert.ok(!words.test(visible), visible.match(words));
  const texts = []
    .concat(Object.values(lanes.TEXT), Object.values(picker.TEXT), Object.values(jobsText.TEXT), Object.values(accountView.TEXT))
    .concat(Object.values(accountView.STATES).map((s) => s.text))
    .concat(view.LANES.map((l) => l.purpose), [view.NOT_BUILT, view.AGENTS.intro, view.AGENTS.pair, view.AGENTS.copied, view.AGENTS.reset_confirm, view.AGENTS.reset_done])
    .concat(menu.items().map((i) => i.label));
  for (const phase of ["starting", "waiting", "handshake", "connected", "pairing_failed", "not_helper", "version_mismatch", "plugin_busy", "permission_denied", "no_token", "stopped", "other"]) {
    texts.push(view.describeLink({ phase, clients: [], detail: "" }).headline);
  }
  for (const t of texts) assert.ok(!words.test(String(t)), `"${t}"`);
  // The technical words exist, under Details only.
  assert.ok(/port 9890/.test(view.AGENTS.tech));
});

test("icons: every data-icon of the page is drawn, in the text color, from constant markup", () => {
  const used = new Set([...html.matchAll(/data-icon="([^"]+)"/g)].map((m) => m[1]));
  const names = new Set(icons.names());
  for (const n of used) assert.ok(names.has(n), `icon ${n}`);
  for (const n of icons.names()) {
    const svg = icons.markup(n);
    assert.ok(/^<svg /.test(svg) && /currentColor/.test(svg), n);
    assert.ok(!/<script|on[a-z]+=/i.test(svg), n);
  }
  assert.equal(icons.markup("no-such-icon"), "");
});

test("the measured minimum width is the manifest's", () => {
  assert.deepEqual(manifest.entrypoints[0].minimumSize, { width: 280, height: 420 });
});
