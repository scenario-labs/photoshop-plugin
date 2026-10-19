#!/usr/bin/env node
"use strict";
// Runs every *.test.js under test/unit and test/integration with Node's
// built-in test runner (no test framework dependency).

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const dirs = ["unit", "integration"];
const files = [];
for (const d of dirs) {
  const dir = path.join(ROOT, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).sort()) if (f.endsWith(".test.js")) files.push(path.join(dir, f));
}
const filter = process.argv.slice(2);
const selected = filter.length ? files.filter((f) => filter.some((x) => f.includes(x))) : files;
if (!selected.length) {
  process.stderr.write("no test files matched\n");
  process.exit(1);
}
const r = spawnSync(process.execPath, ["--test", "--test-timeout=30000", "--test-reporter=spec", ...selected], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
