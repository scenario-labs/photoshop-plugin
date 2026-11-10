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
const { build, CHAPTERS } = require("../../tools/handbook/build.js");
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
  // The site at the root holds the domain; the handbook is published under it.
  assert.ok(!fs.existsSync(path.join(out, "CNAME")), "no CNAME");
  // Built without the PDF, no page links to or names it.
  assert.ok(!html.includes(".pdf"), "no PDF link without the PDF");
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

test("Publish site's handbook links to the release and checks those links in the release's tree", () => {
  // .github/workflows/pages.yml builds a release's docs on main's checkout:
  // HANDBOOK_GITHUB_REF names the tag the links open, so each linked file must
  // be in that tree, not only in main's; HANDBOOK_COMMIT names the release's
  // commit instead of main's.
  const { spawnSync } = require("node:child_process");
  const root = path.resolve(__dirname, "..", "..");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const run = (ref) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "handbook-ref-"));
    const code = `const r = require(${JSON.stringify(path.join(root, "tools/handbook/build.js"))}).build({ out: ${JSON.stringify(out)}, pdf: false }); process.stdout.write(JSON.stringify(r));`;
    const p = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HANDBOOK_GITHUB_REF: ref, HANDBOOK_COMMIT: "abc1234" } });
    assert.equal(p.status, 0, p.stderr);
    const r = JSON.parse(p.stdout);
    const html = r.problems.length ? "" : fs.readFileSync(path.join(out, "index.html"), "utf8");
    fs.rmSync(out, { recursive: true, force: true });
    return { r, html };
  };
  const ok = run(head);
  assert.deepEqual(ok.r.problems, []);
  assert.ok(ok.html.includes(`/blob/${head}/`), "links open the given ref");
  assert.match(ok.html, /<code>abc1234<\/code>/);
  // Git's empty tree holds none of the linked files.
  const empty = run("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  assert.ok(empty.r.problems.some((p) => / in 4b825dc642cb6eb9a060e54bf8d69288fbee4904$/.test(p)), empty.r.problems.join("\n"));
});
