"use strict";
// What ships and what runs in CI: the helper's pinned dependency tree, the
// notices for it, and the GitHub workflows (actions pinned by commit, least
// permissions).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const MIT_COMPATIBLE = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD"]);

test("the helper ships an npm-shrinkwrap.json that pins every package by integrity, in step with the workspace lock", () => {
  const pkg = JSON.parse(read("helper/package.json"));
  const shrink = JSON.parse(read("helper/npm-shrinkwrap.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(shrink.lockfileVersion, 3);
  assert.equal(shrink.name, pkg.name);
  assert.equal(shrink.version, pkg.version);
  assert.deepEqual(shrink.packages[""].dependencies, pkg.dependencies);
  for (const [name, range] of Object.entries(pkg.dependencies)) {
    assert.match(range, /^\d+\.\d+\.\d+$/, `${name} is pinned to an exact version`);
  }
  const deps = Object.entries(shrink.packages).filter(([k]) => k.startsWith("node_modules/"));
  assert.ok(deps.length >= 1);
  const notices = read("THIRD_PARTY_NOTICES.md");
  for (const [key, entry] of deps) {
    const name = key.slice("node_modules/".length);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, `${name} has a sha512 integrity`);
    assert.ok(entry.resolved.startsWith("https://registry.npmjs.org/"), `${name} comes from the npm registry`);
    assert.ok(MIT_COMPATIBLE.has(entry.license), `${name} has an MIT-compatible license (${entry.license})`);
    const workspace = lock.packages[key];
    assert.ok(workspace, `${name} is in the workspace lock too`);
    assert.equal(workspace.version, entry.version, `${name}: same version in both locks`);
    assert.equal(workspace.integrity, entry.integrity, `${name}: same integrity in both locks`);
    assert.ok(notices.includes(`## ${name} ${entry.version}`), `${name} ${entry.version} is in THIRD_PARTY_NOTICES.md`);
  }
});

const WORKFLOWS = fs.readdirSync(path.join(ROOT, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(".github", "workflows", f));
// Every push path the site's workflow lists: the page, the handbook's builder
// and the docs it is built from, and the workflow itself.
const SITE_PATHS = ["site/**", "tools/handbook/**", "README.md", "docs/USER_GUIDE.md", "docs/MCP.md", "docs/KNOWN_LIMITATIONS.md", "docs/media/**", "PRIVACY.md", "SECURITY.md", "CHANGELOG.md", ".github/workflows/pages.yml"];

// The keys of a workflow's top-level `on:` block, comments and blank lines
// skipped, quoted or not. Any other spelling (`on: [push]`, a flow mapping,
// another indent, a key it cannot read) gives null, no keys or an extra entry,
// so a check on the list fails rather than passes.
function triggers(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^["']?on["']?:\s*(#.*)?$/.test(l));
  if (at < 0) return null;
  const keys = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\s*(#.*)?$/.test(l)) continue;
    if (!/^\s/.test(l)) break;
    const m = /^ {2}(["']?)([A-Za-z_]+)\1\s*:/.exec(l);
    if (m) keys.push(m[2]);
    else if (/^ {2}\S/.test(l)) keys.push(l.trim());
  }
  return keys;
}

test("a workflow's triggers are read past blank lines, comments and quotes", () => {
  const on = (block) => triggers(`name: Site\n\n${block}\npermissions:\n  contents: read\n`);
  assert.deepEqual(on("on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n"), ["push", "workflow_dispatch"]);
  assert.deepEqual(on("on:\n  workflow_dispatch:\n\n  pull_request:\n"), ["workflow_dispatch", "pull_request"]);
  assert.deepEqual(on("on:\n  workflow_dispatch:\n# a comment\n  pull_request_target:\n"), ["workflow_dispatch", "pull_request_target"]);
  assert.deepEqual(on('on:\n  workflow_dispatch:\n  "pull_request":\n'), ["workflow_dispatch", "pull_request"]);
  assert.deepEqual(on("\"on\":\n  'pull_request':\n"), ["pull_request"]);
  assert.equal(on("on: [workflow_dispatch, pull_request]\n"), null);
  assert.equal(on("on: {workflow_dispatch: null, pull_request: null}\n"), null);
});

test("every GitHub workflow pins its actions by full commit and declares its permissions", () => {
  assert.ok(WORKFLOWS.length >= 2);
  for (const f of WORKFLOWS) {
    const text = read(f);
    assert.match(text, /^permissions:\s*$/m, `${f} declares top-level permissions`);
    assert.ok(!/write-all/.test(text), `${f} never asks for write-all`);
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length >= 1, `${f} uses actions`);
    for (const u of uses) {
      if (u.startsWith("./")) continue; // a local action is part of this repository
      assert.match(u, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${u} is pinned by full commit`);
    }
    // Pages deploys need pages: write, only in the one workflow that deploys
    // Pages, Publish site: the page in site/ and the handbook under /handbook/.
    // It runs after a release and on pushes to main that change either, from
    // this repository only.
    const pages = /actions\/deploy-pages@/.test(text);
    const name = (text.match(/^name:\s*(.+?)\s*$/m) || [])[1];
    if (pages) assert.equal(name, "Publish site", `${f}: the one Pages workflow is Publish site`);
    if (name === "Publish site") {
      assert.deepEqual(triggers(text), ["workflow_run", "push", "workflow_dispatch"], `${f} runs after a release, on a push and by hand, nothing else`);
      assert.match(text, /^\s+workflow_run:\s*\n\s+workflows: \[release-please\]\s*\n\s+types: \[completed\]\s*\n\s+branches: \[main\]/m, `${f} runs after release-please on main`);
      const push = text.match(/^\s+push:\s*\n\s+branches: \[main\]\s*\n\s+paths:\s*\n((?:\s+- .+\n)+)/m);
      assert.ok(push, `${f} runs on pushes to main, filtered by path`);
      assert.deepEqual([...push[1].matchAll(/- "([^"]+)"/g)].map((m) => m[1]), SITE_PATHS, `${f}: the push paths are the site, the handbook and its docs`);
      assert.match(text, /npm run handbook -- --out "\$RUNNER_TEMP\/site\/handbook"/, `${f} builds the handbook under /handbook/`);
      assert.match(text, /npm run handbook -- --no-pdf --out "\$RUNNER_TEMP\/site\/handbook"/, `${f}: a PDF failure falls back to the handbook without it`);
      assert.match(text, /github\.repository == 'scenario-labs\/photoshop-plugin'/, `${f} publishes from this repository only`);
      assert.match(text, /github\.event\.workflow_run\.conclusion == 'success'/, `${f} publishes only after a release run that succeeded`);
      assert.match(text, /ref: main\n/, `${f} builds main`);
    }
    for (const m of text.matchAll(/^\s+([a-z-]+):\s*write\s*$/gm)) {
      const allowed = ["id-token", "contents", "attestations", ...(pages ? ["pages"] : [])];
      assert.ok(allowed.includes(m[1]), `${f}: ${m[1]}: write is not expected`);
    }
    if (/actions\/checkout@/.test(text)) assert.match(text, /persist-credentials:\s*false/, `${f}: checkout keeps no credentials`);
  }
  const site = WORKFLOWS.filter((f) => f.startsWith(".github") && /^name: Publish site$/m.test(read(f)));
  assert.deepEqual(site, [path.join(".github", "workflows", "pages.yml")], "the site publishes from .github/workflows/pages.yml");
});
