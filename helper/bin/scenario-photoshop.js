#!/usr/bin/env node
"use strict";

const { main } = require("../src/cli.js");

main(process.argv.slice(2), { env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }).then(
  (code) => {
    process.exitCode = code;
    // Exit once stdout is flushed: open sockets must not keep the helper alive after its client left.
    process.stdout.write("", () => process.exit(code));
  },
  (err) => {
    process.stderr.write(`scenario-photoshop: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  }
);
