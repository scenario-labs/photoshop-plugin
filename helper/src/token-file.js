"use strict";
// Where the helper finds the pairing token (SPEC 2.6 item 1, 7.4).
// SCENARIO_PHOTOSHOP_TOKEN wins when the agent client sets it. Otherwise the
// helper reads its token file, which the setup command writes:
//   macOS and Linux: ~/.config/scenario-photoshop/token (0600, folder 0700)
//   Windows:         %APPDATA%\scenario-photoshop\token
// The token never comes from a command argument.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const P = require("../../shared/protocol.json");

const FOLDER = "scenario-photoshop";
const FILE = "token";

function tokenFilePath(env, platform) {
  if (platform === "win32") {
    const appData = env.APPDATA || path.win32.join(env.USERPROFILE || os.homedir(), "AppData", "Roaming");
    return path.win32.join(appData, FOLDER, FILE);
  }
  const home = env.HOME || os.homedir();
  return path.posix.join(home, ".config", FOLDER, FILE);
}

// For messages: the home folder shown as "~" so no user name goes to an agent.
function displayPath(file, env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return home && file.startsWith(home + path.sep) ? "~" + file.slice(home.length) : file;
}

// Returns { text } or { missing: true } or { problem }.
function readTokenFile(file, { platform = process.platform, env = process.env } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return { missing: true };
    return { problem: `cannot read ${displayPath(file, env)} (${e.code || e.message})` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { problem: `${displayPath(file, env)} is not a file` };
    if (st.size > 4096) return { problem: `${displayPath(file, env)} holds more than a pairing token` };
    if (platform !== "win32") {
      if ((st.mode & 0o077) !== 0) {
        return {
          problem: `${displayPath(file, env)} can be read by other accounts (mode ${(st.mode & 0o777).toString(8)}); run the setup command again to rewrite it with mode 600`
        };
      }
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
        return { problem: `${displayPath(file, env)} belongs to another account` };
      }
    }
    return { text: fs.readFileSync(fd, "utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

// What the helper uses: { text, source: "env" | "file", file } or
// { source, file, missing } or { source, file, problem }.
function loadToken({ env = process.env, platform = process.platform } = {}) {
  const fromEnv = env[P.token.env];
  const file = tokenFilePath(env, platform);
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return { text: fromEnv, source: "env", file };
  return { source: "file", file, shown: displayPath(file, env), ...readTokenFile(file, { platform, env }) };
}

// Writes the token file atomically: folder 0700, file 0600, never a partial file.
function writeTokenFile(file, token, { platform = process.platform } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, `.${FILE}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, `${token}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (platform !== "win32") fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { tokenFilePath, displayPath, readTokenFile, loadToken, writeTokenFile };
