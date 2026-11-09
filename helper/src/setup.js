"use strict";
// `scenario-photoshop setup <client>` (SPEC 7.4).
//
// 1. Reads the pairing token from SCENARIO_PHOTOSHOP_TOKEN, or from stdin with
//    --token-stdin. Never from a command argument: other accounts on the same
//    machine can list a process's arguments, not its environment.
// 2. Writes the helper's token file (folder 0700, file 0600), see token-file.js.
// 3. Registers the server with the client, without the token:
//    Claude Code and Codex through their own CLI (`claude mcp add`,
//    `codex mcp add`); Cursor and Claude Desktop by replacing only the
//    scenario-photoshop entry of their config file, with a backup of the old
//    file, an atomic write, and a file it cannot parse left untouched.
//    --config <file> edits that file directly for any client, and so does a
//    missing client CLI.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const lc = require("./link/crypto.js");
const toml = require("./toml-edit.js");
const tokenFile = require("./token-file.js");

const SERVER_NAME = "scenario-photoshop";
const CLIENTS = ["claude-code", "codex", "cursor", "claude-desktop"];
const PACKAGE = "@scenario-labs/photoshop-mcp";
const CLI = { "claude-code": "claude", codex: "codex" };

class SetupError extends Error {}

function configPath(client, env, platform) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  switch (client) {
    case "claude-code":
      return path.join(home, ".claude.json");
    case "codex":
      return path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
    case "cursor":
      return path.join(home, ".cursor", "mcp.json");
    case "claude-desktop":
      if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
      return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json");
    default:
      throw new SetupError(`unknown client "${client}". Use one of: ${CLIENTS.join(", ")}`);
  }
}

// The command a client runs to start the helper. No token in it.
function launchCommand({ version, local }) {
  if (local) return { command: process.execPath, args: [path.resolve(__dirname, "..", "bin", "scenario-photoshop.js")] };
  return { command: "npx", args: ["-y", `${PACKAGE}@${version}`] };
}

function serverEntry({ client, version, local, noSpend }) {
  const { command, args } = launchCommand({ version, local });
  const entry = { command, args };
  if (noSpend) entry.env = { SCENARIO_NO_SPEND: "1" };
  if (client === "claude-code") return { type: "stdio", ...entry };
  return entry;
}

// The client CLI calls: remove our old entry (it may not exist), then add it.
function cliCalls({ client, version, local, noSpend }) {
  const { command, args } = launchCommand({ version, local });
  if (client === "claude-code") {
    const add = ["mcp", "add", "--scope", "user", "--transport", "stdio", SERVER_NAME];
    if (noSpend) add.push("-e", "SCENARIO_NO_SPEND=1");
    return [
      { cmd: "claude", args: ["mcp", "remove", "--scope", "user", SERVER_NAME], mayFail: true },
      { cmd: "claude", args: [...add, "--", command, ...args] }
    ];
  }
  if (client === "codex") {
    const add = ["mcp", "add", SERVER_NAME];
    if (noSpend) add.push("--env", "SCENARIO_NO_SPEND=1");
    return [
      { cmd: "codex", args: ["mcp", "remove", SERVER_NAME], mayFail: true },
      { cmd: "codex", args: [...add, "--", command, ...args] }
    ];
  }
  return null;
}

function shellQuote(a) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`;
}

function showCall(call) {
  return [call.cmd, ...call.args].map(shellQuote).join(" ");
}

// Default runner. The child gets this environment without the token.
function defaultRun(cmd, args, { env, platform }) {
  const childEnv = { ...env };
  delete childEnv[lc.P.token.env];
  const win = platform === "win32";
  const r = spawnSync(cmd, win ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args, {
    env: childEnv,
    encoding: "utf8",
    shell: win,
    windowsHide: true,
    timeout: 60000
  });
  const notFound = (r.error && r.error.code === "ENOENT") || (win && r.status === 9009);
  return { status: r.status, notFound, error: r.error ? r.error.message : null, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function backup(file, now) {
  let target = `${file}.scenario-backup-${stamp(now)}`;
  let n = 1;
  while (fs.existsSync(target)) target = `${file}.scenario-backup-${stamp(now)}-${n++}`;
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  const mode = fs.statSync(file).mode & 0o777;
  fs.chmodSync(target, mode);
  return target;
}

function atomicWrite(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.scenario-tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function updateJson(text, entry) {
  let obj = {};
  if (text !== null && text.trim() !== "") {
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new SetupError(`the file is not valid JSON (${e.message})`);
    }
    if (!isPlainObject(obj)) throw new SetupError("the file does not hold a JSON object");
  }
  if (obj.mcpServers !== undefined && !isPlainObject(obj.mcpServers)) throw new SetupError('"mcpServers" is not an object');
  const replaced = !!(obj.mcpServers && Object.prototype.hasOwnProperty.call(obj.mcpServers, SERVER_NAME));
  obj.mcpServers = obj.mcpServers || {};
  obj.mcpServers[SERVER_NAME] = entry;
  return { text: JSON.stringify(obj, null, 2) + "\n", replaced };
}

// Writes the entry into a config file. Returns { file, backup, replaced }.
function writeEntry({ format, file, entry, now }) {
  let text = null;
  let mode = 0o600;
  try {
    text = fs.readFileSync(file, "utf8");
    mode = fs.statSync(file).mode & 0o777;
  } catch (e) {
    if (e.code !== "ENOENT") throw new SetupError(`cannot read ${file}: ${e.message}`);
  }
  let next;
  try {
    next = format === "toml" ? toml.upsertServer(text, SERVER_NAME, entry) : updateJson(text, entry);
  } catch (e) {
    if (e instanceof SetupError || e instanceof toml.TomlEditError) {
      throw new SetupError(`${file} was left untouched: ${e.message}. Add the scenario-photoshop entry by hand.`);
    }
    throw e;
  }
  const saved = text !== null ? backup(file, now || new Date()) : null;
  atomicWrite(file, next.text, mode);
  return { file, backup: saved, replaced: next.replaced };
}

function readStdin(stream) {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => {
      data += c;
      if (data.length > 4096) reject(new SetupError("stdin holds more than a pairing token"));
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

function usage() {
  return [
    "Usage: scenario-photoshop setup <client> [--token-stdin] [--config <file>] [--local] [--no-spend] [--dry-run]",
    "",
    `Clients: ${CLIENTS.join(", ")}`,
    "",
    "Reads the pairing token from SCENARIO_PHOTOSHOP_TOKEN or, with --token-stdin, from stdin, and writes it",
    "to the helper's token file (~/.config/scenario-photoshop/token, or %APPDATA%\\scenario-photoshop\\token).",
    "The token is never accepted as a command argument and never written into a client config.",
    "Then registers the server: `claude mcp add` or `codex mcp add` for Claude Code and Codex, the config file",
    "for Cursor and Claude Desktop.",
    "",
    "--token-stdin    read the token from stdin (for example: pbpaste | ... --token-stdin)",
    "--config <file>  edit this config file instead of using the client's CLI or default config",
    "--local          run this checkout's helper with this Node instead of npx (development)",
    "--no-spend       start the helper with SCENARIO_NO_SPEND=1",
    "--dry-run        print what would be done; write nothing, run nothing"
  ].join("\n");
}

// Returns an exit code. Writes messages to out and err; never prints the token.
// io.run(cmd, args, { env, platform }) runs a client CLI (tests replace it).
async function runSetup(argv, { env, stdin, out, err, version, platform, now, run }) {
  platform = platform || process.platform;
  run = run || defaultRun;
  const args = [...argv];
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    out.write(usage() + "\n");
    return args.length ? 0 : 2;
  }
  if (args.some((a) => a === "--token" || a.startsWith("--token="))) {
    err.write("setup: the pairing token is never taken from a command argument (other accounts can list process arguments). Set SCENARIO_PHOTOSHOP_TOKEN or pipe it with --token-stdin.\n");
    return 2;
  }
  const client = args.shift();
  const opts = { tokenStdin: false, config: null, local: false, noSpend: false, dryRun: false };
  while (args.length) {
    const a = args.shift();
    if (a === "--token-stdin") opts.tokenStdin = true;
    else if (a === "--local") opts.local = true;
    else if (a === "--no-spend") opts.noSpend = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--config") {
      opts.config = args.shift();
      if (!opts.config) {
        err.write("setup: --config needs a file path\n");
        return 2;
      }
    } else {
      err.write(`setup: unknown option ${a}\n${usage()}\n`);
      return 2;
    }
  }
  try {
    if (!CLIENTS.includes(client)) throw new SetupError(`unknown client "${client}". Use one of: ${CLIENTS.join(", ")}`);
    let tokenText = env[lc.P.token.env];
    if (opts.tokenStdin) tokenText = await readStdin(stdin);
    if (tokenText === undefined || tokenText === null || String(tokenText).trim() === "") {
      throw new SetupError("no pairing token. Copy it from the Scenario panel, then set SCENARIO_PHOTOSHOP_TOKEN or pipe it with --token-stdin.");
    }
    if (!lc.parseToken(String(tokenText))) {
      throw new SetupError(`that is not a pairing token (${lc.P.token.chars} characters from the Scenario panel expected).`);
    }
    const token = String(tokenText).trim();
    const tokenPath = tokenFile.tokenFilePath(env, platform);
    const shownToken = tokenFile.displayPath(tokenPath, env);
    const spec = { client, version, local: opts.local, noSpend: opts.noSpend };
    const calls = opts.config ? null : cliCalls(spec);
    const file = opts.config ? path.resolve(opts.config) : configPath(client, env, platform);
    const format = client === "codex" ? "toml" : "json";
    const entry = serverEntry(spec);

    if (opts.dryRun) {
      out.write(`Would write the pairing token to ${shownToken} (mode 600)\n`);
      if (calls) {
        out.write(`Would run:\n${calls.map((c) => `  ${showCall(c)}`).join("\n")}\n`);
        out.write(`(if ${CLI[client]} is not found: edit ${file})\n`);
      } else {
        out.write(`Would edit ${file}:\n${JSON.stringify({ [SERVER_NAME]: entry }, null, 2)}\n`);
      }
      return 0;
    }

    tokenFile.writeTokenFile(tokenPath, token, { platform });
    out.write(`Pairing token saved in ${shownToken} (readable by this account only).\n`);

    let registered = false;
    if (calls) {
      for (const call of calls) {
        const r = run(call.cmd, call.args, { env, platform });
        if (r.notFound) {
          out.write(`${call.cmd} was not found; editing ${file} instead.\n`);
          break;
        }
        if (r.status !== 0 && !call.mayFail) {
          const detail = (r.stderr || r.stdout || r.error || "").trim().split("\n").slice(-3).join(" ");
          throw new SetupError(`\`${showCall(call)}\` failed${detail ? `: ${detail}` : ""}. Run it yourself, or rerun setup with --config <file>.`);
        }
        if (!call.mayFail) {
          registered = true;
          out.write(`Registered ${SERVER_NAME} with ${CLI[client]}: ${showCall(call)}\n`);
        }
      }
    }
    if (!registered) {
      const result = writeEntry({ format, file, entry, now });
      out.write(`${result.replaced ? "Replaced" : "Added"} the ${SERVER_NAME} entry in ${result.file}\n`);
      if (result.backup) out.write(`Backup of the previous file: ${result.backup}\n`);
    }
    out.write(`Restart ${client} so it starts the helper. Other clients set up this way share the token file.\n`);
    return 0;
  } catch (e) {
    if (e instanceof SetupError) {
      err.write(`setup: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

module.exports = { runSetup, defaultRun, configPath, serverEntry, cliCalls, updateJson, writeEntry, SetupError, CLIENTS, SERVER_NAME };
