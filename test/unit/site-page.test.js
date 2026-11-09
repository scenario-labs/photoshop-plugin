"use strict";
// The page published from site/ by .github/workflows/pages.yml to GitHub
// Pages, which photoshop.scenario.com serves through the Vercel project in
// tools/site_proxy/: the proxy, and every file the page links to is in site/,
// under GitHub's 50 MB push warning.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SITE = path.resolve(__dirname, "..", "..", "site");
const PROXY = path.resolve(__dirname, "..", "..", "tools", "site_proxy");
const MAX_BYTES = 50 * 1024 * 1024;
// Served by the Vercel project, not by Pages: the Web Analytics script.
const PROXY_PATHS = ["/handbook/page.js"];

function files(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) files(full, out);
    else out.push(full);
  }
  return out;
}

test("photoshop.scenario.com is the Vercel proxy in front of Pages, as for Blender", () => {
  // Pages has no custom domain: Vercel serves the domain, so site/ claims none.
  assert.ok(!fs.existsSync(path.join(SITE, "CNAME")), "no CNAME in site/");
  // Vercel would serve any other file in the proxy's directory instead of forwarding its path.
  assert.deepEqual(fs.readdirSync(PROXY), ["vercel.json"]);
  const config = JSON.parse(fs.readFileSync(path.join(PROXY, "vercel.json"), "utf8"));
  assert.deepEqual(config.rewrites, [
    { source: "/handbook/page.js", destination: "https://photoshop.scenario.com/_vercel/insights/script.js" },
    { source: "/(.*)", destination: "https://scenario-labs.github.io/photoshop-plugin/$1" }
  ]);
  const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<script defer src="\/handbook\/page\.js"><\/script>/);
});

test("every local file the page links to is in site/", () => {
  const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  const refs = [...html.matchAll(/\b(?:src|href|poster)="([^"]+)"/g)].map((m) => m[1]);
  const local = refs.filter((u) => !/^(?:[a-z]+:|#|\/\/)/i.test(u) && !PROXY_PATHS.includes(u));
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
