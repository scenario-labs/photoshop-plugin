"use strict";
// The handbook builder (tools/handbook): it reads every doc section it names,
// resolves every link and picture, and keeps the public-content rules.
// The PDF step needs Chrome and is left to `npm run handbook`.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const md = require("../../tools/handbook/markdown.js");
const { build, CHAPTERS, SITE_HOST } = require("../../tools/handbook/build.js");
const EM_DASH = new RegExp(String.fromCharCode(0x2014));

test("the Markdown reader handles the subset the docs use", () => {
  const t = md.parse("# T\n\n1. **One**\n\n   <img src=\"a.png\" alt=\"A\">\n\n2. Two\n   lazy\n\n| A | B |\n|---|---|\n| `x\\|y` | z |\n\n> **Note.** text\n>\n> ```sh\n> run\n> ```\n");
  assert.equal(t[0].type, "heading");
  assert.equal(t[1].type, "list");
  assert.equal(t[1].items.length, 2);
  assert.equal(t[1].items[0].length, 2);
  assert.equal(t[1].items[1][0].text, "Two\nlazy");
  assert.equal(t[2].type, "table");
  assert.deepEqual(t[2].rows[0], ["`x|y`", "z"]);
  assert.equal(t[3].type, "quote");
  assert.equal(t[3].children[1].type, "code");
  assert.equal(md.slug("Selection edits: Inside selection or Bolder"), "selection-edits-inside-selection-or-bolder");
});

test("the handbook builds from the docs with every link and picture resolved", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "handbook-test-"));
  const r = build({ out, pdf: false });
  assert.deepEqual(r.problems, []);
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  for (const c of CHAPTERS) assert.ok(html.includes(`<h2 id="${c.id}">`), `chapter ${c.id}`);
  assert.equal(fs.readFileSync(path.join(out, "CNAME"), "utf8").trim(), SITE_HOST);
  // Every picture the docs show is copied next to the page.
  for (const m of html.matchAll(/<img src="(media\/[^"]+)"/g)) assert.ok(fs.existsSync(path.join(out, m[1])), m[1]);
  assert.ok(/media\/before-after\//.test(html), "before and after pictures");
  // The single file embeds its pictures and links nothing relative.
  const single = fs.readFileSync(path.join(out, `scenario-photoshop-handbook-${r.version}.html`), "utf8");
  assert.ok(!/<img src="(?!data:)/.test(single));
  assert.ok(!/href="(?!#|https:|mailto:)/.test(single));
  // Claims keep their marking, and the product names stay right.
  assert.ok(/class="claim claim-live">verified live/i.test(html));
  assert.ok(/class="claim claim-none">not tested/i.test(html));
  assert.ok(!EM_DASH.test(html));
});
