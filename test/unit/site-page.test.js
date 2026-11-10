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
// Built into the site at publish time by .github/workflows/pages.yml
// (npm run handbook), so not in site/; handbook.test.js checks the build.
const BUILT = ["handbook/"];
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

test("the site publishes to photoshop.scenario.com through the Vercel proxy, as for Blender", () => {
  // GitHub Pages keeps no custom domain: it serves the site at its own
  // address, and the Vercel project on tools/site_proxy holds the domain and
  // forwards every path there, except the Web Analytics script it serves
  // itself. A domain on Pages would make it redirect the proxy's requests
  // back to the domain.
  assert.ok(!fs.existsSync(path.join(SITE, "CNAME")), "no CNAME in site/");
  const proxy = JSON.parse(fs.readFileSync(path.join(PROXY, "vercel.json"), "utf8"));
  assert.deepEqual(proxy.rewrites, [
    { source: "/handbook/page.js", destination: "https://photoshop.scenario.com/_vercel/insights/script.js" },
    { source: "/(.*)", destination: "https://scenario-labs.github.io/photoshop-plugin/$1" }
  ]);
  // Vercel serves any other file in that directory instead of forwarding its
  // path, so it holds the routing and the download-count middleware only
  // (site-proxy.test.js tests the middleware). .DS_Store is gitignored, so
  // Finder's copy never reaches Vercel.
  assert.deepEqual(fs.readdirSync(PROXY).filter((n) => n !== ".DS_Store").sort(), ["middleware.ts", "vercel.json"]);
  // Pages answers a folder without its final slash with a redirect to its
  // own address; the proxy adds the slash first for every folder the page
  // links to, so the reader stays on photoshop.scenario.com.
  const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<script defer src="\/handbook\/page\.js"><\/script>/);
  const folders = [...html.matchAll(/\b(?:src|href|poster)="([^":#?]+\/)"/g)].map((m) => m[1]);
  assert.ok(folders.includes("handbook/"));
  for (const f of folders) {
    const bare = `/${f.slice(0, -1)}`;
    assert.ok(proxy.redirects.some((r) => r.source === bare && r.destination === `${bare}/` && r.permanent), `${bare} redirects to ${bare}/`);
  }
});

test("every local file the page links to is in site/", () => {
  const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  const refs = [...html.matchAll(/\b(?:src|href|poster)="([^"]+)"/g)].map((m) => m[1]);
  const local = refs.filter((u) => !/^(?:[a-z]+:|#|\/\/)/i.test(u) && !BUILT.includes(u) && !PROXY_PATHS.includes(u));
  assert.ok(refs.includes("handbook/"), "the page links to the handbook");
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
