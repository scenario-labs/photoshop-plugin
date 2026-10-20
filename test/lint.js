#!/usr/bin/env node
"use strict";
// Repository checks that need no dependency: JavaScript syntax, JSON syntax,
// typography and public-content rules, and the plugin's UXP constraints.
// Exits 1 with one line per problem.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "build"]);
const TEXT = new Set([".js", ".json", ".md", ".html", ".css", ".yml", ".yaml", ".toml", ".txt", ""]);
const problems = [];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const isText = (f) => TEXT.has(path.extname(f)) && !/\.(png|jpe?g|ccx|zip)$/i.test(f);

// 1. Syntax.
for (const f of files.filter((x) => x.endsWith(".js"))) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) problems.push(`${rel(f)}: syntax error: ${(r.stderr || "").split("\n").find((l) => l.trim()) || "?"}`);
}
for (const f of files.filter((x) => x.endsWith(".json"))) {
  try {
    JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    problems.push(`${rel(f)}: invalid JSON: ${e.message}`);
  }
}

// 2. Typography and public content, in every text file.
const EMAIL_ALLOWED = new Set(["privacy@scenario.com", "support@scenario.com", "noreply@github.com"]);
const RULES = [
  [/\u2014/, "em dash (use a comma, colon or period)"],
  [/\/Users\/|\/home\/[a-z]|\/private\/(tmp|var)|[A-Z]:\\Users\\/i, "machine path"],
  [/\bD(?:[1-9]|[12][0-9])\b/, "internal decision number"]
];
// Maintainers can add words that must never ship (one per line) in a file
// outside the repository, named by LINT_DENYLIST. The list itself stays private.
if (process.env.LINT_DENYLIST) {
  for (const word of fs.readFileSync(process.env.LINT_DENYLIST, "utf8").split("\n").map((w) => w.trim()).filter(Boolean)) {
    RULES.push([new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "word from the private deny list"]);
  }
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
for (const f of files.filter(isText)) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [re, what] of RULES) if (re.test(line)) problems.push(`${rel(f)}:${i + 1}: ${what}`);
    for (const m of line.matchAll(EMAIL)) {
      const at = m.index;
      // Package specifiers such as @scope/name@1.2.3 are not addresses.
      if (line[at - 1] === "/" || /^[^@]+@\d/.test(m[0])) continue;
      // Third-party license texts keep their authors' notices verbatim.
      if (rel(f) === "THIRD_PARTY_NOTICES.md") continue;
      if (!EMAIL_ALLOWED.has(m[0].toLowerCase())) problems.push(`${rel(f)}:${i + 1}: email address ${m[0]}`);
    }
  });
}

// 3. Plugin code runs inside UXP: no run-time code generation, and no
// top-level declaration that would shadow a UXP global (a top-level
// `const URL` breaks UXP's WebSocket).
const UXP_GLOBALS = ["URL", "WebSocket", "crypto", "require", "module", "exports", "window", "document", "console", "setTimeout", "clearTimeout", "navigator", "fetch", "TextEncoder", "TextDecoder", "Blob", "File", "Image", "location", "process"];
const SHADOW = new RegExp(`^(?:const|let|var|function|class)\\s+(${UXP_GLOBALS.join("|")})\\b`);
for (const f of files.filter((x) => rel(x).startsWith("plugin/src/") && x.endsWith(".js"))) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = SHADOW.exec(line);
    if (m) problems.push(`${rel(f)}:${i + 1}: top-level ${m[1]} shadows a UXP global`);
    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(line)) problems.push(`${rel(f)}:${i + 1}: run-time code generation`);
  });
}

// 4. The manifest never asks for every network host.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin", "manifest.json"), "utf8"));
const domains = manifest.requiredPermissions && manifest.requiredPermissions.network && manifest.requiredPermissions.network.domains;
if (!Array.isArray(domains)) problems.push('plugin/manifest.json: network.domains must be a list, never "all"');

if (problems.length) {
  process.stderr.write(problems.join("\n") + `\n\n${problems.length} problem(s)\n`);
  process.exit(1);
}
process.stdout.write(`lint: ${files.length} files checked, no problems\n`);
