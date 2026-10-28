"use strict";
// The page published to photoshop.scenario.com from site/ by
// .github/workflows/pages.yml: its domain, and every file it links to is in
// site/, under GitHub's 50 MB push warning.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SITE = path.resolve(__dirname, "..", "..", "site");
const MAX_BYTES = 50 * 1024 * 1024;

function files(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) files(full, out);
    else out.push(full);
  }
  return out;
}

test("the site publishes to photoshop.scenario.com", () => {
  assert.equal(fs.readFileSync(path.join(SITE, "CNAME"), "utf8"), "photoshop.scenario.com\n");
  const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  assert.match(html, /<title>[^<]+<\/title>/);
});

test("every local file the page links to is in site/", () => {
  const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  const refs = [...html.matchAll(/\b(?:src|href|poster)="([^"]+)"/g)].map((m) => m[1]);
  const local = refs.filter((u) => !/^(?:[a-z]+:|#|\/\/)/i.test(u));
  assert.ok(local.length >= 10, "the page links to its pictures and films");
  for (const u of local) {
    const p = decodeURI(u.split(/[?#]/)[0]);
    assert.ok(!path.isAbsolute(p) && !p.split("/").includes(".."), `${u} stays inside site/`);
    assert.ok(fs.existsSync(path.join(SITE, p)), `${u} resolves`);
  }
});

test("no file in site/ reaches GitHub's 50 MB warning", () => {
  for (const f of files(SITE)) assert.ok(fs.statSync(f).size < MAX_BYTES, `${path.relative(SITE, f)} is under 50 MB`);
});
