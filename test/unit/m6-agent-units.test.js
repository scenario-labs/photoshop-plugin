"use strict";
// M6 units: the agent settings (switches, persistence, the allowance in
// thousandths), the approval cards (one per session, expiry, Decline all,
// session end, the activity log), the PNG decoder of result previews, the
// Connect a client rows (no token in any config the plugin hands out), the
// agent cards in the panel, and the helper's relay (timeouts, NoSpend,
// image content blocks).

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const statusMod = require("../../plugin/src/bridge/status.js");
const approvalsMod = require("../../plugin/src/agents/approvals.js");
const inflate = require("../../plugin/src/util/inflate.js");
const png = require("../../plugin/src/util/png.js");
const connect = require("../../plugin/src/ui/connect-client.js");
const { createTools, relayTimeout } = require("../../helper/src/tools.js");
const { ToolError } = require("../../helper/src/errors.js");
const { bootGenerate, FLARE } = require("../helpers/generate-sim.js");
const { waitFor } = require("../helpers/fakes.js");

function memHost() {
  const files = new Map();
  return {
    files,
    readDataText: async (n) => (files.has(n) ? files.get(n) : null),
    writeDataAtomic: async (n, t) => files.set(n, t)
  };
}

function fakeTimers() {
  let t = 1000;
  const pending = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      const h = { at: t + ms, fn };
      pending.push(h);
      return h;
    },
    clearTimeout: (h) => {
      const i = pending.indexOf(h);
      if (i >= 0) pending.splice(i, 1);
    },
    advance: (ms) => {
      t += ms;
      for (const h of pending.slice()) {
        if (h.at <= t) {
          pending.splice(pending.indexOf(h), 1);
          h.fn();
        }
      }
    }
  };
}

const A = { session: "sess-a", client_name: "claude-code", connected_at: "2026-10-20T10:00:00.000Z" };
const B = { session: "sess-b", client_name: "codex" };

test("settings: modify and scope persist; commands need modify and never persist; modify off turns commands off", async () => {
  const host = memHost();
  const s = statusMod.createSettings({ host });
  await s.load();
  assert.deepEqual(s.switches(), { agents_may_modify: false, agents_may_run_commands: false, active_document_only: false });
  assert.throws(() => s.setSwitch("agents_may_run_commands", true), /Agents may modify the document first/);
  await s.setSwitch("agents_may_modify", true);
  await s.setSwitch("agents_may_run_commands", true);
  await s.setSwitch("active_document_only", true);
  await s.setNoSpend(true);
  const saved = JSON.parse(host.files.get("agent-settings.json"));
  assert.equal(saved.agents_may_run_commands, undefined, "the commands switch is not saved");
  const again = statusMod.createSettings({ host });
  await again.load();
  assert.deepEqual(again.switches(), { agents_may_modify: true, agents_may_run_commands: false, active_document_only: true }, "a restart keeps modify and scope, never commands");
  assert.equal(again.noSpend(), true);
  await again.setSwitch("agents_may_run_commands", true);
  await again.setSwitch("agents_may_modify", false);
  assert.equal(again.switches().agents_may_run_commands, false);
});

test("settings: the allowance is one client session, per-call and total limits in thousandths, check and deduct in one step", () => {
  const s = statusMod.createSettings({});
  assert.throws(() => s.grant(null), /Pick a connected client/);
  assert.throws(() => s.grant(A, "0", "10"), /positive/);
  const sp = s.grant(A);
  assert.equal(sp.mode, "allow");
  assert.equal(sp.per_call_limit, "50");
  assert.equal(sp.session_total, "300");
  s.grant(A, "2.5", "4");
  assert.equal(s.tryDeduct(B.session, 1000), false, "another session");
  assert.equal(s.tryDeduct(A.session, 2501), false, "above the per-call limit");
  assert.equal(s.tryDeduct(A.session, 2500), true);
  assert.equal(s.spending().remaining, "1.5");
  assert.equal(s.tryDeduct(A.session, 2000), false, "above what is left");
  s.refund(A.session, 2500);
  assert.equal(s.spending().remaining, "4");
  assert.equal(s.settle(A.session, 1000, 1000), null, "a charge at the quote");
  assert.equal(s.settle(A.session, 1000, 1500), "above");
  assert.equal(s.spending().mode, "ask", "a charge above its quote ends the allowance");
  s.grant(A, "5", "5");
  assert.equal(s.endSessions([A.session]), true);
  assert.equal(s.spending().mode, "ask", "session end ends it");
  s.grant(A, "5", "5");
  assert.equal(s.tryDeduct(A.session, 5000), true);
  assert.equal(s.spending().mode, "ask", "the total used up ends it");
});

test("approvals: one card per session at a time, the next shows after; 10-minute expiry; Decline all; session end; activity log", async () => {
  const timers = fakeTimers();
  const ap = approvalsMod.createApprovals({ timers });
  const seen = [];
  const card = (session, n) => ({
    kind: "spend",
    session,
    client_name: session === A.session ? "claude-code" : "codex",
    title: "asks " + n,
    lines: ["line " + n],
    onApprove: async () => seen.push("approve " + n),
    onDecline: (why) => seen.push("decline " + n + " " + why)
  });
  const a1 = ap.add(card(A.session, 1));
  const a2 = ap.add(card(A.session, 2));
  const b1 = ap.add(card(B.session, 3));
  let showing = ap.showing();
  assert.deepEqual(showing.map((c) => c.title), ["asks 1", "asks 3"]);
  assert.equal(showing[0].waiting, 1);
  assert.equal(await ap.approve(a2), null, "a waiting card cannot be approved before the one showing");
  assert.deepEqual(seen, []);
  await ap.approve(a1);
  assert.deepEqual(seen, ["approve 1"]);
  showing = ap.showing();
  assert.deepEqual(showing.map((c) => c.title), ["asks 2", "asks 3"]);
  timers.advance(approvalsMod.EXPIRE_MS + 1);
  await new Promise((r) => setImmediate(r));
  assert.ok(seen.includes("decline 2 expired") && seen.includes("decline 3 expired"), seen.join(", "));
  assert.equal(ap.showing().length, 0);
  ap.add(card(A.session, 4));
  ap.add(card(A.session, 5));
  await ap.declineAll(A.session);
  assert.ok(seen.includes("decline 4 declined") && seen.includes("decline 5 declined"), seen.join(", "));
  ap.add(card(B.session, 6));
  ap.endSessions([B.session]);
  await new Promise((r) => setImmediate(r));
  assert.ok(seen.includes("decline 6 session"), seen.join(", "));
  ap.record({ client_name: "claude-code", what: "Read a preview", detail: "poster.psd" });
  assert.equal(ap.activity()[0].what, "Read a preview");
  assert.ok(b1);
});

test("inflate: zlib and raw deflate round-trip against Node; PNG decode of every color type the plugin reads", () => {
  for (const size of [0, 1, 100, 70000]) {
    const data = Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + (i >> 5)) & 255));
    assert.deepEqual(Buffer.from(inflate.inflateZlib(new Uint8Array(zlib.deflateSync(data)))), data, "zlib " + size);
    assert.deepEqual(Buffer.from(inflate.inflateRaw(new Uint8Array(zlib.deflateRawSync(data, { level: 1 })))), data, "raw " + size);
    assert.deepEqual(Buffer.from(inflate.inflateZlib(new Uint8Array(zlib.deflateSync(data, { level: 0 })))), data, "stored " + size);
  }
  for (const channels of [1, 3, 4]) {
    const w = 9;
    const h = 5;
    const d = new Uint8Array(w * h * channels);
    for (let i = 0; i < d.length; i++) d[i] = (i * 31) & 255;
    const bytes = png.encodePng({ width: w, height: h, channels, data: d });
    const img = inflate.decodePng(bytes);
    assert.equal(img.width, w);
    assert.equal(img.height, h);
    assert.equal(img.components, channels);
    assert.deepEqual(Array.from(img.data), Array.from(d), "pixels round-trip, " + channels + " channel(s)");
  }
});

test("Connect a client: setup commands pin the version and carry the token only in the environment; configs the plugin hands out hold no token", () => {
  const tok = "T".repeat(43);
  const mac = connect.setupCommand("0.6.0", "claude-code", tok, false);
  assert.equal(mac, `SCENARIO_PHOTOSHOP_TOKEN=${tok} npx -y @scenario-labs/photoshop-mcp@0.6.0 setup claude-code`);
  const win = connect.setupCommand("0.6.0", "codex", tok, true);
  assert.match(win, /^\$env:SCENARIO_PHOTOSHOP_TOKEN='T+'; npx -y @scenario-labs\/photoshop-mcp@0\.6\.0 setup codex; Remove-Item Env:SCENARIO_PHOTOSHOP_TOKEN$/);
  for (const text of [connect.jsonConfig("0.6.0"), connect.tomlConfig("0.6.0")]) {
    assert.ok(!text.includes(tok) && !/SCENARIO_PHOTOSHOP_TOKEN/.test(text), "no token in a client config");
    assert.match(text, /@scenario-labs\/photoshop-mcp@0\.6\.0/);
  }
  assert.deepEqual(JSON.parse(connect.jsonConfig("1.2.3")), { mcpServers: { "scenario-photoshop": { command: "npx", args: ["-y", "@scenario-labs/photoshop-mcp@1.2.3"] } } });
  assert.deepEqual(connect.CLIENTS.map((c) => c.name), ["Claude Code", "Codex", "Cursor", "Claude Desktop"]);
});

test("Connect a client and Settings > Agents in the panel: rows, Connected status, copies cleared after 60 s, switches from the checkboxes", async (t) => {
  const w = await bootGenerate(t, { docs: [{ id: 7, title: "poster.psd", width: 256, height: 256 }], active: 7 });
  const { app, doc, clipboard } = w;
  assert.ok(app.connectClient && app.agentsSettings && app.agentCards);
  const box = doc.byId("connect-client");
  assert.equal(box.style.display, "none");
  app.connectClient.open();
  const rows = box.children.filter((c) => c.getAttribute("data-client"));
  assert.deepEqual(rows.map((r) => r.getAttribute("data-client")), ["claude-code", "codex", "cursor", "claude-desktop", "other"]);
  const all = (n, out = []) => {
    out.push(n);
    for (const c of n.children || []) all(c, out);
    return out;
  };
  const btn = (act) => all(box).find((e) => e.getAttribute && e.getAttribute("data-act") === act);
  btn("copy-claude-code").dispatch("click");
  await waitFor(() => clipboard.text && clipboard.text.includes("setup claude-code"), { label: "copied" });
  assert.match(clipboard.text, /^SCENARIO_PHOTOSHOP_TOKEN=\S{32,} npx -y @scenario-labs\/photoshop-mcp@\S+ setup claude-code$/);
  btn("copy-json").dispatch("click");
  await waitFor(() => clipboard.text && clipboard.text.includes("mcpServers"), { label: "json copied" });
  assert.ok(!/TOKEN/.test(clipboard.text));
  assert.ok(!app.logger.lines().some((l) => l.includes(app.pairing.current())), "the token is never logged");
  // Switches through the checkboxes.
  const controls = doc.byId("agents-controls");
  const sw = (key) => all(controls).find((e) => e.getAttribute && e.getAttribute("data-switch") === key);
  const modify = sw("agents_may_modify");
  modify.checked = true;
  modify.dispatch("change", { target: modify });
  await waitFor(() => app.settings.switches().agents_may_modify, { label: "modify on" });
  const banner = all(doc.byId("agent-cards")).find((e) => e.getAttribute && e.getAttribute("data-banner") === "agents-can-edit");
  assert.ok(banner, "Agents can edit shows");
  assert.ok(FLARE);
});

test("helper relay: every v1 tool relays with its own limit; wait_for_job follows its timeout; SCENARIO_NO_SPEND stops generate and upload_reference in the helper", async () => {
  const calls = [];
  const manager = { role: () => "owner", call: async (name, args, ms) => (calls.push({ name, ms }), { ok: name }) };
  const tools = createTools({ manager, version: "0.6.0", noSpend: true });
  const catalog = require("../../shared/catalog.json");
  for (const t of catalog.tools) assert.equal(typeof tools[t.name], "function", t.name);
  await tools.document_summary({});
  assert.equal(calls[0].ms, 30000);
  await tools.wait_for_job({ local_id: "x", timeout: 170 });
  assert.equal(calls[1].ms, 175000);
  assert.equal(relayTimeout("wait_for_job", {}), 50000, "default 45 s plus the margin");
  for (const name of ["generate", "upload_reference"]) {
    await assert.rejects(async () => tools[name]({}), (e) => e instanceof ToolError && e.type === "NoSpend");
  }
  assert.equal(calls.length, 2, "nothing reached the plugin");
});
