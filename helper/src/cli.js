"use strict";
// Entry point: with no command, serve MCP over stdio; `setup <client>` writes
// a client config entry; `--version` prints the version.

const pkg = require("../package.json");
const catalog = require("../../shared/catalog.json");
const P = require("../../shared/protocol.json");
const { LinkManager } = require("./link/manager.js");
const { McpServer } = require("./mcp.js");
const { createTools, STATUS_TIMEOUT_MS } = require("./tools.js");
const { runSetup } = require("./setup.js");
const tokenFile = require("./token-file.js");

const VERSION = pkg.version;

function truthy(value) {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function makeLog(stream, quiet) {
  return (text) => {
    if (!quiet) stream.write(`scenario-photoshop: ${text}\n`);
  };
}

async function serve({ env, stdin, stdout, stderr }) {
  const log = makeLog(stderr, truthy(env.SCENARIO_PHOTOSHOP_QUIET));
  // SCENARIO_PHOTOSHOP_PORT exists for the test suite. The plugin always dials 9890.
  const port = env.SCENARIO_PHOTOSHOP_PORT ? Number(env.SCENARIO_PHOTOSHOP_PORT) : P.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    stderr.write("scenario-photoshop: SCENARIO_PHOTOSHOP_PORT is not a port number\n");
    return 2;
  }
  const noSpend = truthy(env.SCENARIO_NO_SPEND);
  // The token: SCENARIO_PHOTOSHOP_TOKEN when the client sets it, else the token file (read again when needed).
  const platform = process.platform;
  const loadToken = () => tokenFile.loadToken({ env, platform });
  const first = loadToken();
  log(`pairing token from ${first.source === "env" ? P.token.env : first.shown || "the token file"}`);
  const manager = new LinkManager({ port, loadToken, version: VERSION, log });
  const server = new McpServer({
    input: stdin,
    output: stdout,
    catalog,
    handlers: createTools({ manager, version: VERSION, noSpend }),
    version: VERSION,
    log,
    timeouts: { scenario_status: STATUS_TIMEOUT_MS + 2000 },
    onInitialize: (name) => manager.setClientName(name)
  });
  log(`${VERSION} starting${noSpend ? " (no-spend)" : ""}`);
  const done = server.start();
  manager.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await manager.stop();
  };
  process.once("SIGINT", () => stop().then(() => process.exit(0)));
  process.once("SIGTERM", () => stop().then(() => process.exit(0)));
  await done;
  await stop();
  return 0;
}

async function main(argv, io) {
  const cmd = argv[0];
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    io.stdout.write(
      [
        `scenario-photoshop ${VERSION}: local MCP server for the Scenario plugin in Photoshop.`,
        "",
        "  scenario-photoshop            serve MCP over stdio (agent clients start it this way)",
        "  scenario-photoshop setup ...  add this server to an agent client's config",
        "  scenario-photoshop --version",
        "",
        "Pairing token: SCENARIO_PHOTOSHOP_TOKEN when the client sets it, else the token file that setup writes",
        "(~/.config/scenario-photoshop/token, or %APPDATA%\\scenario-photoshop\\token on Windows).",
        "SCENARIO_NO_SPEND=1 refuses every paid call and upload."
      ].join("\n") + "\n"
    );
    return 0;
  }
  if (cmd === "setup") {
    return runSetup(argv.slice(1), { env: io.env, stdin: io.stdin, out: io.stdout, err: io.stderr, version: VERSION });
  }
  if (cmd === undefined || cmd === "serve") return serve(io);
  io.stderr.write(`scenario-photoshop: unknown command ${cmd}. Try --help.\n`);
  return 2;
}

module.exports = { main, VERSION };
