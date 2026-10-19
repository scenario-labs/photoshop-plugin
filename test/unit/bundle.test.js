"use strict";
// The bundle UXP loads (plugin/dist/main.js), run in a fresh V8 context with a
// fake UXP (test/helpers/uxp-sim.js): the uxp, photoshop, os and fs modules, a
// UXP-like WebSocket, and a DOM built from the real index.html. Also checks
// what the release bundle must not hold and the .ccx package structure.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { bundle } = require("../../plugin/scripts/build.js");
const { packagePlugin, crc32 } = require("../../plugin/scripts/package.js");
const { Owner } = require("../../helper/src/link/owner.js");
const hp = require("../../helper/src/link/crypto.js");
const P = require("../../shared/protocol.json");
const { freePort, newToken, waitFor, sleep } = require("../helpers/fakes.js");
const { startFixtureScenario } = require("../helpers/fixture-scenario.js");
const { newKeyPair, projectRecord } = require("../helpers/mock-scenario.js");
const { runBundle } = require("../helpers/uxp-sim.js");
const manifest = require("../../plugin/manifest.json");

const release = bundle({ dev: false });
const dev = bundle({ dev: true });

async function ownerOn(port, token) {
  const o = new Owner({ port, token: hp.parseToken(token), version: "0.1.0", hosts: ["127.0.0.1", "::1"] });
  assert.equal((await o.bind()).ok, true);
  return o;
}

test("the release bundle holds no development code and no run-time code generation", () => {
  assert.ok(!release.code.includes("dev-pairing-token"), "the dev token import is stubbed out");
  assert.ok(!release.code.includes("dev-api-key"), "the dev API key import is stubbed out");
  assert.ok(!release.code.includes("SCENARIO_API_SECRET"), "nothing in a release build reads a key file");
  assert.ok(!release.code.includes("dev-ui-command.json"), "the panel's dev UI loop is stubbed out");
  assert.ok(!release.code.includes("location.reload"), "a release build never reloads its panel");
  assert.ok(!release.code.includes("dev-demo"), "the panel's sample states are stubbed out");
  assert.equal(release.code.split("Release build: development-only module removed.").length - 1, 4, "the four development-only modules are stubs");
  assert.ok(release.code.includes('module.exports = {"DEV":false,"BUILD":"release"}'));
  assert.ok(dev.code.includes("dev-pairing-token"));
  assert.ok(dev.code.includes("dev-api-key"));
  assert.ok(dev.code.includes("dev-ui-command.json"));
  assert.ok(dev.code.includes("dev-demo"));
  for (const code of [release.code, dev.code]) {
    assert.ok(!/\beval\s*\(/.test(code), "no eval");
    assert.ok(!/\bnew\s+Function\s*\(/.test(code), "no new Function");
    assert.ok(!/\bFunction\s*\(\s*["']/.test(code), "no Function(string)");
    assert.ok(!/\bimport\s*\(/.test(code), "no dynamic import");
    assert.ok(!/^\s*(const|let|var|function|class)\s+(URL|WebSocket|crypto|require|document|window|console)\b/m.test(code.split("\n").slice(0, 3).join("\n")));
  }
  assert.equal(release.files.some((f) => f.includes(`${path.sep}test${path.sep}`)), false);
});

test("the release bundle boots in a fake UXP, links to a real owner and answers scenario_status", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await ownerOn(port, token);
  const files = new Map([["dev-pairing-token", newToken()]]);
  const ps = runBundle(release.code, { port, secure: new Map([[P.token.secure_storage_key, token]]), files });
  t.after(async () => {
    ps.kill();
    await o.close();
  });
  assert.equal(ps.entrypoints.length, 1, "entrypoints set up during the first synchronous run");
  assert.ok(ps.entrypoints[0].panels.scenarioPanel);
  await waitFor(() => o.pluginInfo(), { label: "plugin linked" });
  assert.equal(o.pluginInfo().plugin_version, manifest.version);
  assert.equal(o.pluginInfo().os, "darwin 25.5.0");
  o.setOwnClientName("Claude Code");
  const r = await o.callOwn("scenario_status", {});
  assert.deepEqual(r.open_documents, [
    { id: 7, title: "cover.psd" },
    { id: 8, title: "Untitled-2" }
  ]);
  assert.equal(r.active_document_id, 8);
  assert.equal(r.photoshop_version, "27.11.0");
  assert.equal(r.signed_in, false);
  assert.ok(files.has("dev-pairing-token"), "a release build ignores the dev token file");
  await waitFor(() => ps.doc.text("link-headline").startsWith("Agent connected"), { label: "panel shows the link" });
  assert.equal(ps.doc.els.get("link-dot").className, "dot on");
  assert.equal(ps.doc.text("token-value"), `....${token.slice(-4)}`);
  assert.ok(ps.doc.text("version").startsWith(`Scenario for Photoshop ${manifest.version}`));
  // The panel menu is declared with the panel: Settings and Sign Out live there.
  const panelDef = ps.entrypoints[0].panels.scenarioPanel;
  assert.equal(panelDef.menuItems.filter((i) => i.label !== "-").map((i) => i.id).join(","), "jobs,projects,settings,agents,diagnostics,help,about,signout");
  panelDef.invokeMenu("about");
  assert.ok(ps.doc.shown("view-settings"));
  ps.doc.els.get("settings-back").click();
  assert.equal(ps.doc.lanes[0].className, "tab on");
  ps.doc.lanes[3].click();
  assert.equal(ps.doc.lanes[3].className, "tab on");
  assert.equal(ps.doc.text("lane-empty-title"), "Trained models");
  assert.equal(ps.doc.lanes[3].getAttribute("selected"), "");
  assert.equal(ps.doc.lanes[0].getAttribute("selected"), null);
  await sleep(400);
  const log = ps.files.get("scenario-link.log") || "";
  assert.ok(log.includes(`plugin ${manifest.version} (release) starting; random source: getRandomValues`));
  assert.ok(!log.includes(token) && !ps.logs.join("\n").includes(token), "the token is never logged");
  assert.ok(!log.includes("cover.psd"), "document titles are never logged");
});

test("panel: Show, Copy, and a confirmed Reset that cuts off the helper holding the old token", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await ownerOn(port, token);
  const ps = runBundle(release.code, { port, secure: new Map([[P.token.secure_storage_key, token]]) });
  t.after(async () => {
    ps.kill();
    await o.close();
  });
  await waitFor(() => o.pluginInfo(), { label: "linked" });
  ps.doc.els.get("token-show").click();
  assert.equal(ps.doc.text("token-value"), token);
  assert.equal(ps.doc.text("token-show"), "Hide");
  ps.doc.els.get("token-copy").click();
  await waitFor(() => ps.clipboard.text === token, { label: "copied" });
  assert.match(ps.doc.text("token-note"), /^Copied/);
  ps.doc.els.get("token-reset").click();
  assert.equal(ps.secure.get(P.token.secure_storage_key), token, "the first click only asks for confirmation");
  assert.equal(ps.doc.text("token-reset"), "Confirm reset");
  ps.doc.els.get("token-reset").click();
  await waitFor(() => ps.secure.get(P.token.secure_storage_key) !== token, { label: "new token stored" });
  const fresh = ps.secure.get(P.token.secure_storage_key);
  assert.ok(hp.parseToken(fresh));
  assert.equal(ps.doc.text("token-value"), `....${fresh.slice(-4)}`, "the new token is masked again");
  await waitFor(() => ps.doc.text("link-headline") === "An agent tried an old pairing token", { label: "old helper refused" });
  assert.equal(ps.doc.els.get("link-dot").className, "dot warn");
  assert.equal(o.pluginInfo(), null);
});

test("first start: the plugin makes and stores a 43-character token in secure storage", async (t) => {
  const port = await freePort();
  const secure = new Map();
  const ps = runBundle(release.code, { port, secure });
  t.after(() => ps.kill());
  await waitFor(() => secure.get(P.token.secure_storage_key), { label: "token stored" });
  const made = secure.get(P.token.secure_storage_key);
  assert.equal(made.length, 43);
  assert.ok(hp.parseToken(made));
  await waitFor(() => ps.doc.text("link-headline") === "No agent connected", { label: "waiting for a helper" });
});

test("development bundle: imports dev-pairing-token from the data folder, then removes the file", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await ownerOn(port, token);
  const files = new Map([["dev-pairing-token", `${token}\n`]]);
  const secure = new Map([[P.token.secure_storage_key, newToken()]]);
  const ps = runBundle(dev.code, { port, secure, files });
  t.after(async () => {
    ps.kill();
    await o.close();
  });
  await waitFor(() => o.pluginInfo(), { label: "linked with the imported token" });
  assert.equal(secure.get(P.token.secure_storage_key), token);
  assert.equal(files.has("dev-pairing-token"), false, "the file is removed after import");
  await sleep(400);
  assert.match(files.get("scenario-link.log"), /\(dev\) starting/);
  assert.match(files.get("scenario-link.log"), /pairing token imported/);
  assert.ok(!files.get("scenario-link.log").includes(token));

  const bad = new Map([["dev-pairing-token", "not a token"]]);
  const ps2 = runBundle(dev.code, { port: await freePort(), files: bad });
  t.after(() => ps2.kill());
  await waitFor(() => !bad.has("dev-pairing-token"), { label: "bad file removed" });
  await sleep(400);
  assert.match(bad.get("scenario-link.log"), /dev-pairing-token ignored/);
});

test("development bundle: dev-api-key goes through Save and test, is stored only when accepted, and the file is removed either way", async (t) => {
  const good = newKeyPair();
  const other = newKeyPair();
  const mock = await startFixtureScenario({ accounts: [{ ...good, projects: [projectRecord(good.key, { name: "Imported project" })] }] });
  t.after(() => mock.close());

  // Accepted: signed in, the pair in secure storage, the file gone, the log
  // without the values.
  const files = new Map([["dev-api-key", `SCENARIO_API_KEY=${good.key}\nSCENARIO_API_SECRET=${good.secret}\n`]]);
  const secure = new Map([[P.token.secure_storage_key, newToken()]]);
  const ps = runBundle(dev.code, { port: await freePort(), secure, files, api: mock.origin });
  t.after(() => ps.kill());
  await waitFor(() => ps.doc.text("project-label") === "Imported project", { label: "signed in from the file" });
  assert.equal(files.has("dev-api-key"), false, "the file is removed after the import");
  assert.ok([...secure.values()].some((v) => String(v).includes(good.secret)), "the pair is in secure storage");
  await sleep(400);
  const log = files.get("scenario-link.log");
  assert.match(log, /dev build: API key imported/);
  for (const v of [good.key, good.secret]) assert.ok(!log.includes(v), "the log never holds the key or the secret");
  assert.ok(mock.requests.length > 0 && mock.requests.every((r) => r.method === "GET"), "Save and test only reads");

  // Refused by Scenario: nothing stored, the file removed, the error type logged.
  const badFiles = new Map([["dev-api-key", `export SCENARIO_API_KEY="${other.key}"\nSCENARIO_API_SECRET='${other.secret}'\n`]]);
  const badSecure = new Map([[P.token.secure_storage_key, newToken()]]);
  const ps2 = runBundle(dev.code, { port: await freePort(), secure: badSecure, files: badFiles, api: mock.origin });
  t.after(() => ps2.kill());
  await waitFor(() => !badFiles.has("dev-api-key"), { label: "refused file removed" });
  await sleep(400);
  assert.match(badFiles.get("scenario-link.log"), /dev build: API key not imported \(Unauthorized\)/);
  assert.equal(ps2.doc.text("project-label"), "Not signed in");
  assert.ok(![...badSecure.values()].some((v) => String(v).includes(other.secret)), "a refused pair is not stored");
  for (const v of [other.key, other.secret]) assert.ok(!badFiles.get("scenario-link.log").includes(v));

  // Incomplete file: nothing sent, the file removed.
  const before = mock.requests.length;
  const halfFiles = new Map([["dev-api-key", `SCENARIO_API_KEY=${good.key}\n`]]);
  const ps3 = runBundle(dev.code, { port: await freePort(), files: halfFiles, api: mock.origin });
  t.after(() => ps3.kill());
  await waitFor(() => !halfFiles.has("dev-api-key"), { label: "incomplete file removed" });
  await sleep(400);
  assert.match(halfFiles.get("scenario-link.log"), /dev-api-key ignored \(InvalidParameter\)/);
  assert.equal(mock.requests.length, before, "an incomplete file sends nothing");

  // A release build ignores the file and leaves it alone.
  const relFiles = new Map([["dev-api-key", `SCENARIO_API_KEY=${good.key}\nSCENARIO_API_SECRET=${good.secret}\n`]]);
  const ps4 = runBundle(release.code, { port: await freePort(), files: relFiles, api: mock.origin });
  t.after(() => ps4.kill());
  await waitFor(() => ps4.doc.shown("view-signin"), { label: "release build not signed in" });
  await sleep(400);
  assert.ok(relFiles.has("dev-api-key"), "a release build never reads the key file");
  assert.equal(ps4.doc.text("project-label"), "Not signed in");
});

test("both link URLs refused by Photoshop: the panel says the connection was refused", async (t) => {
  const port = await freePort();
  const ps = runBundle(release.code, { port, secure: new Map([[P.token.secure_storage_key, newToken()]]), refuse: () => true });
  t.after(() => ps.kill());
  await waitFor(() => ps.doc.text("link-headline") === "Photoshop refused the agent link", { label: "permission_denied shown" });
  assert.equal(ps.doc.els.get("link-dot").className, "dot warn");
});

test(".ccx package: a valid stored zip with the five plugin files, same bytes on every build", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-ps-pkg-"));
  const a = packagePlugin({ dev: false, outDir: path.join(dir, "a"), distFile: path.join(dir, "a", "main.js") });
  const b = packagePlugin({ dev: false, outDir: path.join(dir, "b"), distFile: path.join(dir, "b", "main.js") });
  const buf = fs.readFileSync(a.file);
  assert.ok(buf.equals(fs.readFileSync(b.file)), "reproducible");
  assert.equal(path.basename(a.file), `scenario-photoshop-${manifest.version}.ccx`);

  const names = [];
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const size = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extra = buf.readUInt16LE(off + 28);
    const name = buf.toString("utf8", off + 30, off + 30 + nameLen);
    const data = buf.subarray(off + 30 + nameLen + extra, off + 30 + nameLen + extra + size);
    assert.equal(method, 0);
    assert.equal(crc, crc32(data), `${name} CRC`);
    if (typeof zlib.crc32 === "function") assert.equal(crc, zlib.crc32(data), `${name} CRC matches zlib`);
    if (name === "dist/main.js") assert.equal(data.toString("utf8"), release.code);
    if (name === "manifest.json") assert.equal(JSON.parse(data.toString("utf8")).id, "com.scenario.photoshop");
    names.push(name);
    off += 30 + nameLen + extra + size;
  }
  assert.deepEqual(names, ["manifest.json", "index.html", "styles.css", "dist/main.js", "LICENSE"]);
  assert.equal(buf.readUInt32LE(off), 0x02014b50, "central directory follows");
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  assert.equal(buf.readUInt16LE(end + 10), 5);
  assert.equal(buf.readUInt32LE(end + 16), off, "central directory offset");

  const unzip = spawnSync("unzip", ["-tq", a.file], { encoding: "utf8" });
  if (!unzip.error) assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);

  const d = packagePlugin({ dev: true, outDir: path.join(dir, "d"), distFile: path.join(dir, "d", "main.js") });
  assert.equal(path.basename(d.file), `scenario-photoshop-${manifest.version}-dev.ccx`);
});
