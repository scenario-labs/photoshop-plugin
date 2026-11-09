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

// A workflow's triggers: the keys of its top-level `on:` block, at the block's
// first indentation, past blank and comment lines, quoted or not; with the
// block's text for checks on a trigger's settings. An inline `on:` value is
// split as a list; a flow mapping (`on: {...}`) yields null, so it fails.
function workflowTriggers(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l));
  if (at < 0) return null;
  const inline = lines[at].replace(/^["']?on["']?\s*:/, "").replace(/\s#.*$/, "").trim();
  if (inline) {
    if (inline.includes("{")) return null;
    const names = inline.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    return { names: names.filter(Boolean), body: "" };
  }
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\S/.test(l) && !/^#/.test(l)) break;
    body.push(l);
  }
  const keyed = body.filter((l) => !/^\s*(#.*)?$/.test(l));
  if (!keyed.length) return null;
  const indent = Math.min(...keyed.map((l) => l.match(/^\s*/)[0].length));
  const names = keyed
    .filter((l) => l.match(/^\s*/)[0].length === indent)
    .map((l) => (l.trim().match(/^["']?([^"':\s]+)["']?/) || [])[1]);
  return { names, body: body.join("\n") };
}

// Pages deploys need pages: write, so a Pages workflow runs by hand or on a
// push to main, never on a pull request.
function pagesTriggersAllowed(text) {
  const on = workflowTriggers(text);
  if (!on || !on.names.length) return false;
  if (!on.names.every((n) => n === "workflow_dispatch" || n === "push")) return false;
  return !on.names.includes("push") || /^\s+branches:\s*\[main\]\s*$/m.test(on.body);
}

test("a Pages workflow trigger other than a hand run or a push to main is refused, however it is written", () => {
  const ok = (on) => pagesTriggersAllowed(`name: Site\n\n${on}\npermissions:\n  contents: read\n`);
  assert.ok(ok("on:\n  workflow_dispatch:\n"));
  assert.ok(ok('on:\n  push:\n    branches: [main]\n    paths:\n      - "site/**"\n  workflow_dispatch:\n'));
  assert.ok(!ok("on:\n  workflow_dispatch:\n\n  pull_request:\n"), "after a blank line");
  assert.ok(!ok("on:\n  workflow_dispatch:\n# a comment\n  pull_request_target:\n"), "after a column-0 comment");
  assert.ok(!ok('on:\n  workflow_dispatch:\n  "pull_request":\n'), "quoted");
  assert.ok(!ok("on: [workflow_dispatch, pull_request]\n"), "inline list");
  assert.ok(!ok("on: {workflow_dispatch: null, pull_request: null}\n"), "flow mapping");
  assert.ok(!ok("on:\n  push:\n    branches: [feature]\n"), "a push to another branch");
  assert.ok(!ok("on:\n  push:\n"), "a push to any branch");
});

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

// The handbook's Pages workflow waits in tools/handbook/ until it is turned
// on by copying it into .github/workflows/; it is held to the same rules.
const WORKFLOWS = [
  ...fs.readdirSync(path.join(ROOT, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(".github", "workflows", f)),
  path.join("tools", "handbook", "pages.yml")
];

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
    // Pages deploys need pages: write, only in the Pages workflows, which run
    // by hand or on a push to main, never on a pull request.
    const pages = path.basename(f) === "pages.yml";
    if (pages) assert.ok(pagesTriggersAllowed(text), `${f} runs by hand or on a push to main only`);
    for (const m of text.matchAll(/^\s+([a-z-]+):\s*write\s*$/gm)) {
      const allowed = ["id-token", "contents", "attestations", ...(pages ? ["pages"] : [])];
      assert.ok(allowed.includes(m[1]), `${f}: ${m[1]}: write is not expected`);
    }
    if (/actions\/checkout@/.test(text)) assert.match(text, /persist-credentials:\s*false/, `${f}: checkout keeps no credentials`);
  }
});
