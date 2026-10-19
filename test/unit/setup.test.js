"use strict";
// `scenario-photoshop setup <client>` (SPEC 7.4): token from the environment
// or stdin only, written to the user-only token file; the client registered
// through its CLI or its config file, never with the token; backup kept,
// atomic write, unreadable files untouched. Every test uses a temporary HOME.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable, PassThrough } = require("node:stream");
const { runSetup, configPath } = require("../../helper/src/setup.js");
const toml = require("../../helper/src/toml-edit.js");
const tf = require("../../helper/src/token-file.js");
const { newToken } = require("../helpers/fakes.js");

const POSIX = process.platform !== "win32";

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scenario-ps-setup-"));
}

function sink() {
  const s = new PassThrough();
  let text = "";
  s.on("data", (c) => (text += c));
  s.text = () => text;
  return s;
}

// cli: { claude: (args) => result, codex: ... }; a missing name means "not installed".
async function run(argv, { home = tmpHome(), env = {}, stdinText = "", cli = {} } = {}) {
  const out = sink();
  const err = sink();
  const calls = [];
  const code = await runSetup(argv, {
    env: { HOME: home, ...env },
    stdin: Readable.from([stdinText]),
    out,
    err,
    version: "0.1.0",
    platform: process.platform === "win32" ? "win32" : "darwin",
    now: new Date(2026, 9, 19, 8, 30, 0),
    run: (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts.env });
      if (!cli[cmd]) return { notFound: true, status: null, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "", ...cli[cmd](args) };
    }
  });
  return { code, out: out.text(), err: err.text(), calls, home, tokenPath: tf.tokenFilePath({ HOME: home }, POSIX ? "darwin" : "win32") };
}

function readToken(file) {
  return fs.readFileSync(file, "utf8").trim();
}

test("refuses a token given as a command argument, in both spellings", async () => {
  const token = newToken();
  for (const argv of [["claude-code", "--token", token], ["claude-code", `--token=${token}`]]) {
    const r = await run(argv);
    assert.equal(r.code, 2);
    assert.match(r.err, /never taken from a command argument/);
    assert.ok(!r.err.includes(token) && !r.out.includes(token));
    assert.equal(fs.existsSync(r.tokenPath), false);
  }
});

test("token from the environment: token file 0600 in a 0700 folder; the Cursor entry carries no token", async () => {
  const token = newToken();
  const r = await run(["cursor"], { env: { SCENARIO_PHOTOSHOP_TOKEN: token } });
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.out.includes(token), "the token is never printed");
  assert.match(r.out, /Pairing token saved in ~\/\.config\/scenario-photoshop\/token/);
  assert.equal(readToken(r.tokenPath), token);
  if (POSIX) {
    assert.equal(fs.statSync(r.tokenPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(r.tokenPath)).mode & 0o777, 0o700);
  }
  const file = path.join(r.home, ".cursor", "mcp.json");
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(token), "no token in the client config");
  assert.deepEqual(JSON.parse(text).mcpServers["scenario-photoshop"], { command: "npx", args: ["-y", "@scenario-labs/photoshop-mcp@0.1.0"] });
  assert.deepEqual(r.calls, [], "Cursor has no CLI step");
});

test("Claude Code: registered with `claude mcp add --scope user`, no token on the command line or in its environment", async () => {
  const token = newToken();
  const r = await run(["claude-code", "--no-spend"], {
    env: { SCENARIO_PHOTOSHOP_TOKEN: token, PATH: "/usr/bin" },
    cli: { claude: (args) => (args[1] === "remove" ? { status: 1, stderr: "No MCP server found" } : { status: 0 }) }
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(
    r.calls.map((c) => [c.cmd, ...c.args].join(" ")),
    [
      "claude mcp remove --scope user scenario-photoshop",
      "claude mcp add --scope user --transport stdio scenario-photoshop -e SCENARIO_NO_SPEND=1 -- npx -y @scenario-labs/photoshop-mcp@0.1.0"
    ]
  );
  for (const c of r.calls) {
    assert.ok(!c.args.join(" ").includes(token), "no token in any argument");
    assert.equal(c.env.SCENARIO_PHOTOSHOP_TOKEN, token, "the runner gets the caller's environment and strips the token itself");
  }
  assert.equal(readToken(r.tokenPath), token);
  assert.equal(fs.existsSync(path.join(r.home, ".claude.json")), false, "the CLI owns ~/.claude.json");
  assert.match(r.out, /Registered scenario-photoshop with claude/);
});

test("Codex: registered with `codex mcp add`; a failing add is reported, the token file stays", async () => {
  const token = newToken();
  const ok = await run(["codex"], { env: { SCENARIO_PHOTOSHOP_TOKEN: token }, cli: { codex: () => ({ status: 0 }) } });
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(
    ok.calls.map((c) => [c.cmd, ...c.args].join(" ")),
    ["codex mcp remove scenario-photoshop", "codex mcp add scenario-photoshop -- npx -y @scenario-labs/photoshop-mcp@0.1.0"]
  );
  const bad = await run(["codex"], {
    env: { SCENARIO_PHOTOSHOP_TOKEN: token },
    cli: { codex: (args) => (args[1] === "add" ? { status: 2, stderr: "error: config locked" } : { status: 0 }) }
  });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /codex mcp add scenario-photoshop .* failed: error: config locked/);
  assert.ok(!bad.err.includes(token));
  assert.equal(readToken(bad.tokenPath), token);
});

test("the default runner never passes the token to the client CLI", () => {
  const { defaultRun } = require("../../helper/src/setup.js");
  const env = { ...process.env, SCENARIO_PHOTOSHOP_TOKEN: newToken(), SCENARIO_MARK: "kept" };
  const r = defaultRun(process.execPath, ["-e", "process.stdout.write(String(process.env.SCENARIO_PHOTOSHOP_TOKEN) + ' ' + process.env.SCENARIO_MARK)"], {
    env,
    platform: process.platform
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "undefined kept");
  assert.equal(defaultRun("scenario-no-such-command-xyz", [], { env, platform: process.platform }).notFound, true);
});

test("client CLI not installed: setup edits the client's config file instead", async () => {
  const token = newToken();
  const cc = await run(["claude-code"], { env: { SCENARIO_PHOTOSHOP_TOKEN: token } });
  assert.equal(cc.code, 0, cc.err);
  assert.match(cc.out, /claude was not found; editing/);
  const entry = JSON.parse(fs.readFileSync(path.join(cc.home, ".claude.json"), "utf8")).mcpServers["scenario-photoshop"];
  assert.deepEqual(entry, { type: "stdio", command: "npx", args: ["-y", "@scenario-labs/photoshop-mcp@0.1.0"] });
  const cx = await run(["codex", "--no-spend"], { env: { SCENARIO_PHOTOSHOP_TOKEN: token } });
  assert.equal(cx.code, 0, cx.err);
  const text = fs.readFileSync(path.join(cx.home, ".codex", "config.toml"), "utf8");
  assert.match(text, /\[mcp_servers\.scenario-photoshop\.env\]\nSCENARIO_NO_SPEND = "1"/);
  assert.ok(!text.includes(token));
});

test("token from stdin with --config: replaces only our entry, keeps the others, and backs up the old file", async () => {
  const home = tmpHome();
  const file = path.join(home, "custom.json");
  const oldToken = newToken();
  const original = {
    numStartups: 3,
    mcpServers: { other: { command: "x" }, "scenario-photoshop": { command: "old", env: { SCENARIO_PHOTOSHOP_TOKEN: oldToken } } },
    projects: { a: 1 }
  };
  fs.writeFileSync(file, JSON.stringify(original), { mode: 0o640 });
  const token = newToken();
  const r = await run(["claude-code", "--config", file, "--token-stdin"], { home, stdinText: `${token}\n`, cli: { claude: () => ({ status: 0 }) } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls, [], "--config edits the file and runs no CLI");
  assert.match(r.out, /Replaced the scenario-photoshop entry/);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(cfg.mcpServers.other, { command: "x" });
  assert.equal(cfg.numStartups, 3);
  assert.deepEqual(cfg.projects, { a: 1 });
  assert.deepEqual(cfg.mcpServers["scenario-photoshop"], { type: "stdio", command: "npx", args: ["-y", "@scenario-labs/photoshop-mcp@0.1.0"] });
  assert.ok(!fs.readFileSync(file, "utf8").includes(oldToken), "an old entry's token is gone from the config");
  assert.equal(readToken(r.tokenPath), token);
  const backup = `${file}.scenario-backup-20261019-083000`;
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, "utf8")), original);
  if (POSIX) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o640, "the file keeps its mode");
    assert.equal(fs.statSync(backup).mode & 0o777, 0o640, "the backup keeps the mode too");
  }
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.includes("scenario-tmp")), [], "no temporary file left behind");
});

test("a config file it cannot parse is left untouched", async () => {
  const home = tmpHome();
  const dir = path.join(home, "Library", "Application Support", "Claude");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "claude_desktop_config.json");
  const broken = '{ "mcpServers": { "a": 1, } // comment';
  fs.writeFileSync(file, broken);
  const r = await run(["claude-desktop", "--config", file], { home, env: { SCENARIO_PHOTOSHOP_TOKEN: newToken() } });
  assert.equal(r.code, 1);
  assert.match(r.err, /left untouched/);
  assert.equal(fs.readFileSync(file, "utf8"), broken);
  assert.deepEqual(fs.readdirSync(dir), ["claude_desktop_config.json"], "no backup, no temporary file");
  fs.writeFileSync(file, '{"mcpServers": []}');
  assert.equal((await run(["claude-desktop", "--config", file], { home, env: { SCENARIO_PHOTOSHOP_TOKEN: newToken() } })).code, 1);
});

test("missing or malformed tokens are refused before anything is written", async () => {
  const none = await run(["cursor"]);
  assert.equal(none.code, 1);
  assert.match(none.err, /no pairing token/);
  const bad = await run(["cursor"], { env: { SCENARIO_PHOTOSHOP_TOKEN: "abc" } });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /not a pairing token/);
  for (const r of [none, bad]) {
    assert.equal(fs.existsSync(r.tokenPath), false);
    assert.equal(fs.existsSync(path.join(r.home, ".cursor")), false);
  }
  assert.equal((await run(["nope"], { env: { SCENARIO_PHOTOSHOP_TOKEN: newToken() } })).code, 1);
});

test("--dry-run says what it would do, without the token, and writes or runs nothing", async () => {
  const token = newToken();
  const r = await run(["claude-code", "--dry-run", "--local"], { env: { SCENARIO_PHOTOSHOP_TOKEN: token }, cli: { claude: () => ({ status: 0 }) } });
  assert.equal(r.code, 0);
  assert.ok(!r.out.includes(token));
  assert.match(r.out, /Would write the pairing token to ~\/\.config\/scenario-photoshop\/token/);
  assert.match(r.out, /claude mcp add --scope user --transport stdio scenario-photoshop -- .*scenario-photoshop\.js/);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(fs.readdirSync(r.home), []);
});

test("a second setup replaces the token file; a loose mode is tightened", async () => {
  const home = tmpHome();
  const first = await run(["cursor"], { home, env: { SCENARIO_PHOTOSHOP_TOKEN: newToken() } });
  if (POSIX) fs.chmodSync(first.tokenPath, 0o644);
  const second = newToken();
  const r = await run(["cursor"], { home, env: { SCENARIO_PHOTOSHOP_TOKEN: second } });
  assert.equal(r.code, 0, r.err);
  assert.equal(readToken(r.tokenPath), second);
  if (POSIX) assert.equal(fs.statSync(r.tokenPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(r.tokenPath)), ["token"], "no temporary file left behind");
});

test("default paths per client and for the token file", () => {
  const env = { HOME: "/h", APPDATA: "C:\\A" };
  assert.equal(configPath("claude-code", env, "darwin"), path.join("/h", ".claude.json"));
  assert.equal(configPath("codex", env, "darwin"), path.join("/h", ".codex", "config.toml"));
  assert.equal(configPath("codex", { ...env, CODEX_HOME: "/c" }, "darwin"), path.join("/c", "config.toml"));
  assert.equal(configPath("cursor", env, "linux"), path.join("/h", ".cursor", "mcp.json"));
  assert.equal(configPath("claude-desktop", env, "darwin"), path.join("/h", "Library", "Application Support", "Claude", "claude_desktop_config.json"));
  assert.equal(configPath("claude-desktop", env, "win32"), path.join("C:\\A", "Claude", "claude_desktop_config.json"));
  assert.equal(tf.tokenFilePath(env, "darwin"), "/h/.config/scenario-photoshop/token");
  assert.equal(tf.tokenFilePath(env, "linux"), "/h/.config/scenario-photoshop/token");
  assert.equal(tf.tokenFilePath(env, "win32"), "C:\\A\\scenario-photoshop\\token");
});

test("the helper takes SCENARIO_PHOTOSHOP_TOKEN first, else the token file, and refuses a file others can read", () => {
  const home = tmpHome();
  const file = tf.tokenFilePath({ HOME: home }, "darwin");
  const envToken = newToken();
  assert.deepEqual(tf.loadToken({ env: { HOME: home, SCENARIO_PHOTOSHOP_TOKEN: envToken }, platform: "darwin" }), { text: envToken, source: "env", file });
  const missing = tf.loadToken({ env: { HOME: home }, platform: "darwin" });
  assert.equal(missing.missing, true);
  assert.equal(missing.shown, "~/.config/scenario-photoshop/token");
  const fileToken = newToken();
  tf.writeTokenFile(file, fileToken, { platform: "darwin" });
  const got = tf.loadToken({ env: { HOME: home, SCENARIO_PHOTOSHOP_TOKEN: "  " }, platform: "darwin" });
  assert.equal(got.source, "file", "an empty variable counts as unset");
  assert.equal(got.text.trim(), fileToken);
  if (POSIX) {
    fs.chmodSync(file, 0o640);
    const loose = tf.loadToken({ env: { HOME: home }, platform: "darwin" });
    assert.match(loose.problem, /can be read by other accounts \(mode 640\)/);
    assert.equal(loose.text, undefined, "the token is not used");
  }
});

test("codex: the TOML entry is appended, then replaced, everything else kept byte for byte", async () => {
  const home = tmpHome();
  const file = path.join(home, "config.toml");
  const before = [
    'model = "gpt-5"',
    "",
    "# my servers",
    "[mcp_servers.other]",
    'command = "other-cmd"',
    "args = [",
    '  "--a",',
    '  "[not a header]",',
    "]",
    "",
    "[profiles.fast]",
    'model = "small"',
    ""
  ].join("\n");
  fs.writeFileSync(file, before);
  assert.equal((await run(["codex", "--config", file, "--no-spend"], { home, env: { SCENARIO_PHOTOSHOP_TOKEN: newToken() } })).code, 0);
  const first = fs.readFileSync(file, "utf8");
  assert.ok(first.startsWith(before.trimEnd() + "\n\n"), "the existing text is kept as is");
  assert.match(first, /\[mcp_servers\.scenario-photoshop\]\ncommand = "npx"\nargs = \["-y", "@scenario-labs\/photoshop-mcp@0\.1\.0"\]\n\n\[mcp_servers\.scenario-photoshop\.env\]\nSCENARIO_NO_SPEND = "1"\n/);

  assert.equal((await run(["codex", "--config", file], { home, env: { SCENARIO_PHOTOSHOP_TOKEN: newToken() } })).code, 0);
  const second = fs.readFileSync(file, "utf8");
  assert.equal(second.match(/\[mcp_servers\.scenario-photoshop\]/g).length, 1);
  assert.ok(!second.includes("SCENARIO_NO_SPEND"), "the env subtable went with the old entry");
  assert.ok(second.startsWith(before.trimEnd()));
});

test("codex: forms the line editor cannot change safely are refused", () => {
  const entry = { command: "npx", args: ["-y", "x"], env: { A: "b" } };
  const refuse = [
    'x = """\nmulti\n"""',
    "mcp_servers = { other = { command = 'x' } }",
    '[mcp_servers]\nscenario-photoshop = { command = "x" }',
    'mcp_servers.scenario-photoshop.command = "x"',
    "args = [\n1,\n",
    "this is not toml",
    "[[mcp_servers.scenario-photoshop]]\ncommand = 'x'"
  ];
  for (const text of refuse) assert.throws(() => toml.upsertServer(text, "scenario-photoshop", entry), toml.TomlEditError, text);
  const ok = toml.upsertServer('[mcp_servers."scenario-photoshop"]\ncommand = "old"\n[other]\nk = 1\n', "scenario-photoshop", entry);
  assert.equal(ok.replaced, true, "a quoted table name is the same table");
  assert.ok(ok.text.startsWith("[other]\nk = 1\n\n"));
  const crlf = toml.upsertServer("a = 1\r\n", "scenario-photoshop", entry);
  assert.ok(crlf.text.includes("\r\n[mcp_servers.scenario-photoshop]\r\n"), "Windows line endings are kept");
  assert.equal(toml.upsertServer("", "scenario-photoshop", entry).text.startsWith("[mcp_servers.scenario-photoshop]"), true);
  assert.deepEqual(toml.parseHeader("[a.\"b c\".d] # note"), { array: false, keys: ["a", "b c", "d"] });
  assert.equal(toml.parseHeader('  "[x]",'), null);
  assert.equal(toml.bracketDelta('args = ["[", "]]", \'[\'] # [[['), 0);
});
