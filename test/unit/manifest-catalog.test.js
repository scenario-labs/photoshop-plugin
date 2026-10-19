"use strict";
// Static checks on what ships: the UXP manifest, the panel page, the tool
// catalog, the error list and the panel's wording.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const manifest = require("../../plugin/manifest.json");
const catalog = require("../../shared/catalog.json");
const errors = require("../../shared/errors.json");
const P = require("../../shared/protocol.json");
const canonical = require("../../plugin/src/util/canonical-json.js");
const main = require("../../plugin/src/main.js");
const view = require("../../plugin/src/ui/view.js");
const { ToolError } = require("../../helper/src/errors.js");
const enums = require("../../shared/enums.json");
const MCP_MD = fs.readFileSync(path.join(ROOT, "docs", "spec", "MCP.md"), "utf8");
const SPEC_MD = fs.readFileSync(path.join(ROOT, "docs", "spec", "SPEC.md"), "utf8");

function section(text, from, to) {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `section ${from}`);
  return text.slice(a, b);
}

// Every network host the specification allows (SPEC 2.10). The two
// placeholders there (upload storage, api.github.com) belong to later builds.
const SPEC_DOMAINS = [
  "https://api.cloud.scenario.com",
  "https://cdn.cloud.scenario.com",
  "https://api.github.com",
  "ws://localhost:9890",
  "ws://127.0.0.1:9890"
];

test("manifest: version 5, Photoshop 26.9 or later, loaded at startup, one panel", () => {
  assert.equal(manifest.manifestVersion, 5);
  assert.equal(manifest.host.app, "PS");
  assert.equal(manifest.host.minVersion, "26.9");
  assert.deepEqual(manifest.host.data, { apiVersion: 2, loadEvent: "startup" });
  assert.equal(manifest.main, "index.html");
  assert.equal(manifest.entrypoints.length, 1);
  const panel = manifest.entrypoints[0];
  assert.equal(panel.type, "panel");
  assert.equal(panel.id, "scenarioPanel");
  assert.deepEqual(panel.minimumSize, { width: 280, height: 420 });
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(require("../../helper/package.json").version, manifest.version, "helper and plugin share a version");
});

test("manifest: the local link URL is declared, nothing broader than the specification", () => {
  const perms = manifest.requiredPermissions;
  const domains = perms.network.domains;
  assert.ok(Array.isArray(domains), "domains is a list, never \"all\"");
  assert.ok(domains.includes("ws://localhost:9890"));
  for (const url of P.plugin_urls) assert.ok(domains.includes(url), `${url} declared`);
  for (const d of domains) {
    assert.ok(SPEC_DOMAINS.includes(d), `${d} is in the specification's list`);
    assert.ok(!d.includes("*"), `${d} has no wildcard in this build`);
  }
  assert.equal(new Set(domains).size, domains.length);
  assert.equal(perms.localFileSystem, "request", "no fullAccess");
  assert.equal(perms.clipboard, "readAndWrite");
  for (const key of ["allowCodeGenerationFromStrings", "webview", "ipc", "enableUserInfo"]) {
    assert.equal(perms[key], undefined, `${key} is not requested`);
  }
  // SPEC 2.10: https opens the pages the person asks for (cursor comes with
  // section 7.4); no file extension, so no local file opens in another app.
  assert.deepEqual(perms.launchProcess.extensions, []);
  assert.ok(perms.launchProcess.schemes.length > 0);
  for (const s of perms.launchProcess.schemes) assert.ok(["https", "cursor"].includes(s), `${s} is in the specification's list`);
  assert.ok(!JSON.stringify(manifest).includes('"all"'));
});

test("panel page: local resources only, one script at the end of the body", () => {
  const html = fs.readFileSync(path.join(ROOT, "plugin", "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0][1], /src="dist\/main\.js"/);
  assert.equal(scripts[0][2].trim(), "", "no inline script");
  assert.ok(html.indexOf("<script") > html.indexOf('id="settings-agents"'), "the script runs after the elements it binds");
  assert.ok(html.indexOf("<script") > html.lastIndexOf("</section>"), "after every view");
  assert.ok(!/(src|href)="(https?:)?\/\//.test(html), "nothing loaded from the network");
  assert.ok(!/\son[a-z]+=/i.test(html), "no inline event handlers");
  for (const id of ["link-dot", "link-headline", "link-detail", "token-value", "token-show", "token-copy", "token-reset", "token-note", "version", "lane-note", "lane-source", "target-chip", "model-thumb", "refs-menu", "jobs-badge"]) {
    assert.ok(html.includes(`id="${id}"`), `#${id} exists`);
  }
  for (const lane of view.LANES) assert.ok(html.includes(`data-lane="${lane.id}"`), `lane ${lane.id} has a button`);
  const css = fs.readFileSync(path.join(ROOT, "plugin", "styles.css"), "utf8");
  assert.ok(!/url\(\s*["']?https?:/.test(css), "no remote CSS resources");
  assert.ok(!/@keyframes|animation\s*:/.test(css), "no animation");
});

test("catalog: the four tools of this build, with schemas the server can serve", () => {
  assert.equal(typeof catalog.catalog_version, "string");
  assert.equal(catalog.server.name, "scenario-photoshop");
  assert.deepEqual(catalog.tools.map((t) => t.name), ["scenario_status", "list_models", "model_schema", "estimate_cost"]);
  // Every tool name of this build is one MCP.md section 4 defines.
  for (const tool of catalog.tools) assert.ok(MCP_MD.includes("| `" + tool.name + "` |"), `${tool.name} is in MCP.md`);
  for (const tool of catalog.tools) {
    assert.match(tool.name, /^[a-z][a-z_]+$/);
    assert.ok(tool.title && tool.description);
    assert.ok(tool.description.length <= 2500);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.outputSchema.type, "object");
    for (const r of tool.outputSchema.required) assert.ok(r in tool.outputSchema.properties, `${r} is described`);
    for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) assert.equal(typeof tool.annotations[k], "boolean");
  }
  const status = catalog.tools[0];
  assert.equal(status.annotations.readOnlyHint, true);
  assert.equal(status.annotations.openWorldHint, false);
  assert.deepEqual(status.inputSchema.properties, {});
  assert.equal(status.inputSchema.additionalProperties, false);
  assert.ok(catalog.server.instructions.length <= 2000);
});

test("catalog hash: the plugin's pure-JS hash equals SHA-256 over the same canonical bytes in Node", () => {
  const body = { catalog_version: catalog.catalog_version, tools: catalog.tools };
  const text = canonical.stringify(body);
  assert.equal(main.catalogHash(), crypto.createHash("sha256").update(text, "utf8").digest("hex"));
  assert.match(main.catalogHash(), /^[0-9a-f]{64}$/);
  const reverseKeys = (v) =>
    Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
  const reordered = reverseKeys(body);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(body));
  assert.equal(canonical.hash(reordered), main.catalogHash(), "key order does not change the hash");
});

test("errors: every type the build returns is listed, one line each, and parses back", () => {
  assert.equal(errors.format, "Type: message");
  for (const type of errors.used) assert.ok(errors.types[type], `${type} is described`);
  for (const [type, text] of Object.entries(errors.types)) {
    assert.match(type, /^[A-Z][A-Za-z]+$/);
    assert.ok(!text.includes("\n"));
    const e = ToolError.parse(`${type}: something happened`);
    assert.equal(e.type, type);
    assert.equal(e.message, "something happened");
  }
  assert.equal(ToolError.parse("Nonsense: x").type, "Internal", "unknown types do not pass through");
  assert.equal(new ToolError("Timeout", "a\nb").message.includes("\n"), false, "messages stay on one line");
});

test("panel wording: every link phase has a headline, the token is masked by default", () => {
  const phases = require("../../plugin/src/bridge/link.js").PHASES;
  assert.ok(phases.includes("plugin_busy"));
  for (const phase of phases) {
    const d = view.describeLink({ phase, detail: "d", clients: [] });
    assert.ok(["on", "off", "warn"].includes(d.dot), phase);
    assert.ok(d.headline && d.headline !== phase, `${phase} has its own headline`);
  }
  assert.equal(view.describeLink({ phase: "connected", clients: [{ client_name: "Codex" }, { client_name: null }] }).headline, "Agent connected: Codex, Agent client", "a client without a name yet shows the SPEC 2.6 default");
  assert.equal(view.describeLink({ phase: "plugin_busy", detail: "d" }).headline, "Agents are connected to another Photoshop");
  assert.equal(view.describeLink({ phase: "pairing_failed", detail: "d" }).headline, "An agent tried an old pairing token");
  // The link's own words (which name the local program and its port) are the detail, shown under Details.
  assert.equal(view.describeLink({ phase: "pairing_failed", detail: "d" }).detail, "d");
  assert.equal(view.describeLink({ phase: "connected", clients: [] }).dot, "on");
  assert.equal(view.describeLink({ phase: "pairing_failed" }).dot, "warn");
  assert.equal(view.describeLink(null).headline, "No agent connected");
  const token = "A".repeat(39) + "wxyz";
  assert.equal(view.maskToken(token, false), "....wxyz");
  assert.equal(view.maskToken(token, true), token);
  assert.equal(view.maskToken(null, true), "Not created yet");
  assert.equal(view.LANES.map((l) => l.label).join(","), "Image,Edit,Enhance,Trained,Library");
  assert.match(view.NOT_BUILT, /not available in this version/i);
});

test("errors.json lists exactly the types of MCP.md section 8", () => {
  const table = section(MCP_MD, "## 8. Errors", "## 9. Examples");
  const names = [];
  for (const line of table.split("\n")) {
    const m = /^\| (`[A-Za-z]+`(?:, `[A-Za-z]+`)*) \|/.exec(line);
    if (m) for (const n of m[1].split(",")) names.push(n.trim().replace(/`/g, ""));
  }
  for (const n of ["RequestInFlight", "UncertainNeedsPerson", "DocumentNotActive", "ResultUnreachable", "ResultExpired", "Internal"]) assert.ok(names.includes(n), n);
  assert.deepEqual(Object.keys(errors.types).sort(), names.sort());
  for (const used of errors.used) assert.ok(names.includes(used), `${used} is used and defined`);
});

test("job statuses and lanes match MCP.md section 2 and SPEC 2.5", () => {
  const values = enums.job_status.map((s) => s.value);
  const specTable = section(SPEC_MD, "| Machine value | Panel label | Meaning |", "```");
  const specValues = [...specTable.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(values, specValues);
  for (const blender of ["submitting", "cancel_requested", "succeeded", "downloading", "download_failed", "ready", "applying", "apply_failed", "applied", "failed", "canceled", "uncertain"]) {
    assert.ok(values.includes(blender), `${blender} (a Blender plugin value) is kept`);
  }
  assert.deepEqual(enums.job_status.filter((s) => s.final).map((s) => s.value), ["applied", "failed", "blocked", "canceled", "not_sent"]);
  assert.deepEqual(enums.lane.v1, ["image", "edit", "upscale", "expand", "remove_background"]);
});

test("scenario_status returns the fields MCP.md section 4.1 lists, plus helper_role and reason", () => {
  const row = MCP_MD.split("\n").find((l) => l.startsWith("| `scenario_status` |"));
  assert.ok(row);
  const output = row.split("|")[4];
  const listed = [...output.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((f) => !["ask", "allow"].includes(f));
  const top = ["connected", "signed_in", "project_name", "plugin_version", "helper_version", "photoshop_version", "os", "switches", "agent_spending", "no_spend", "active_document_id", "open_documents", "uncertain_jobs"];
  for (const f of top) assert.ok(listed.includes(f), `${f} is in MCP.md`);
  const schema = catalog.tools[0].outputSchema;
  assert.deepEqual(Object.keys(schema.properties).filter((k) => !["helper_role", "reason"].includes(k)).sort(), [...top].sort());
  assert.deepEqual(Object.keys(schema.properties.switches.properties).sort(), ["active_document_only", "agents_may_modify", "agents_may_run_commands"]);
  assert.deepEqual(Object.keys(schema.properties.agent_spending.properties).sort(), ["client", "mode", "per_call_limit", "remaining", "session_total"]);
});
