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
    // Pages deploys need pages: write, only in the handbook workflow, which
    // runs by hand only.
    const pages = path.basename(f) === "pages.yml";
    if (pages) assert.match(text, /^on:\s*\n\s+workflow_dispatch:\s*\n(?!\s+\w)/m, `${f} runs only by hand`);
    for (const m of text.matchAll(/^\s+([a-z-]+):\s*write\s*$/gm)) {
      const allowed = ["id-token", "contents", "attestations", ...(pages ? ["pages"] : [])];
      assert.ok(allowed.includes(m[1]), `${f}: ${m[1]}: write is not expected`);
    }
    if (/actions\/checkout@/.test(text)) assert.match(text, /persist-credentials:\s*false/, `${f}: checkout keeps no credentials`);
  }
});
