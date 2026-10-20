"use strict";
// The plugin's link code (plugin/src/bridge/link.js) against a real owner and
// against programs that squat on the port. The plugin must check the owner's
// proof before it sends anything but its own proof.

const test = require("node:test");
const assert = require("node:assert/strict");
const WS = require("ws");
const { Owner } = require("../../helper/src/link/owner.js");
const hp = require("../../helper/src/link/crypto.js");
const { startFakePlugin } = require("../helpers/plugin-sim.js");
const { freePort, newToken, waitFor, sleep } = require("../helpers/fakes.js");

async function owner(port, token, limits) {
  const o = new Owner({ port, token: hp.parseToken(token), version: "0.1.0", limits, hosts: ["127.0.0.1", "::1"] });
  assert.equal((await o.bind()).ok, true);
  return o;
}

// A program on the port that speaks the first steps of the protocol badly.
// mode: "silent", "bad_owner_proof", "future_protocol", "silent_after_hello", "bad_clients"
async function squatter(port, mode, token) {
  const received = [];
  const server = new WS.Server({ host: "127.0.0.1", port });
  await new Promise((r) => server.on("listening", r));
  server.on("connection", (ws) => {
    const nonceO = hp.nonce();
    if (mode === "future_protocol") ws.send(JSON.stringify({ t: "challenge", protocol: 2, role: "owner", nonce_o: nonceO }));
    else if (mode !== "silent") ws.send(JSON.stringify({ t: "challenge", protocol: 1, role: "owner", nonce_o: nonceO }));
    ws.on("message", (data) => {
      const text = data.toString();
      received.push(text);
      let msg = null;
      try {
        msg = JSON.parse(text);
      } catch {
        return; // a signed frame after the proofs
      }
      if (!msg || msg.t !== "proof") return;
      if (mode === "bad_owner_proof") {
        ws.send(JSON.stringify({ t: "owner_proof", proof_o: hp.ownerProof(hp.parseToken(newToken()), nonceO, msg.nonce_c) }));
      } else if (mode === "bad_clients") {
        // A right proof and hello, then a clients list whose entry lacks connected_at.
        const t = hp.parseToken(token);
        ws.send(JSON.stringify({ t: "owner_proof", proof_o: hp.ownerProof(t, nonceO, msg.nonce_c) }));
        const ch = new hp.Channel(hp.sessionKey(t, nonceO, msg.nonce_c), "o2c", "c2o");
        ws.send(ch.seal({ t: "hello", protocol: 1, helper_version: "0.1.0", clients: [] }));
        setTimeout(() => ws.send(ch.seal({ t: "clients", clients: [{ session: "A".repeat(22), client_name: "x" }] })), 100);
      } else if (mode === "silent_after_hello") {
        const t = hp.parseToken(token);
        ws.send(JSON.stringify({ t: "owner_proof", proof_o: hp.ownerProof(t, nonceO, msg.nonce_c) }));
        const ch = new hp.Channel(hp.sessionKey(t, nonceO, msg.nonce_c), "o2c", "c2o");
        ws.send(ch.seal({ t: "hello", protocol: 1, helper_version: "0.1.0", clients: [] }));
        // then never answers a ping
      }
    });
  });
  return { server, received, close: () => new Promise((r) => server.close(r)) };
}

test("links to a real owner and answers scenario_status with the fake Photoshop's documents", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await owner(port, token);
  const plugin = startFakePlugin({ port, token });
  t.after(async () => {
    plugin.stop();
    await o.close();
  });
  await waitFor(() => plugin.phase() === "connected" && o.pluginInfo(), { label: "connected" });
  const r = await o.callOwn("scenario_status", {});
  assert.equal(r.photoshop_version, "27.11.0");
  assert.equal(r.signed_in, false);
  assert.deepEqual(r.open_documents, [
    { id: 101, title: "poster.psd" },
    { id: 102, title: "Untitled-1" }
  ]);
  assert.equal(r.active_document_id, 101);
  plugin.settings._set("active_document_only", true);
  const limited = await o.callOwn("scenario_status", {});
  assert.deepEqual(limited.open_documents, [{ id: 101, title: "poster.psd" }]);
  assert.equal(limited.switches.active_document_only, true);
  const states = plugin.states.map((s) => s.phase);
  assert.ok(states.includes("handshake") && states.includes("connected"));
});

test("a squatter that cannot prove the token: the plugin sends nothing after its own proof", async (t) => {
  const port = await freePort();
  const token = newToken();
  const sq = await squatter(port, "bad_owner_proof");
  const plugin = startFakePlugin({ port, token });
  t.after(async () => {
    plugin.stop();
    await sq.close();
  });
  await waitFor(() => plugin.phase() === "not_helper", { label: "not_helper" });
  await sleep(150);
  const proofs = sq.received.map((x) => JSON.parse(x));
  assert.ok(proofs.every((m) => !("protocol" in m) && typeof m.nonce_c === "string"));
  assert.ok(proofs.length >= 1);
  assert.ok(proofs.every((m) => m.t === "proof"), "only proofs ever reach the squatter");
  assert.match(plugin.link.state().detail, /not the Scenario helper/);
});

test("a squatter that never sends a challenge is reported as not the helper", async (t) => {
  const port = await freePort();
  const sq = await squatter(port, "silent");
  const plugin = startFakePlugin({ port, token: newToken(), limits: { handshake_ms: 200 } });
  t.after(async () => {
    plugin.stop();
    await sq.close();
  });
  await waitFor(() => plugin.phase() === "not_helper", { label: "not_helper" });
  assert.equal(sq.received.length, 0);
});

test("an owner with another token: the plugin shows the old-token message", async (t) => {
  const port = await freePort();
  const o = await owner(port, newToken());
  const plugin = startFakePlugin({ port, token: newToken() });
  t.after(async () => {
    plugin.stop();
    await o.close();
  });
  await waitFor(() => plugin.phase() === "pairing_failed", { label: "pairing_failed" });
  assert.equal(plugin.link.state().detail, "Copy its setup again.");
  const view = require("../../plugin/src/ui/view.js");
  assert.equal(view.describeLink(plugin.link.state()).headline, "An agent tried an old pairing token");
});

test("a helper speaking another protocol version is reported as a version mismatch", async (t) => {
  const port = await freePort();
  const sq = await squatter(port, "future_protocol");
  const plugin = startFakePlugin({ port, token: newToken() });
  t.after(async () => {
    plugin.stop();
    await sq.close();
  });
  await waitFor(() => plugin.phase() === "version_mismatch", { label: "version_mismatch" });
  assert.equal(sq.received.length, 0, "no proof is sent to a helper of another protocol");
});

test("the plugin closes a link whose owner stops answering, then dials again", async (t) => {
  const port = await freePort();
  const token = newToken();
  const sq = await squatter(port, "silent_after_hello", token);
  const plugin = startFakePlugin({ port, token, limits: { ping_ms: 50, idle_ms: 300 } });
  t.after(async () => {
    plugin.stop();
    await sq.close();
  });
  await waitFor(() => plugin.phase() === "connected", { label: "connected" });
  await waitFor(() => plugin.states.some((s) => s.phase === "waiting" && /stopped answering/.test(s.detail || "")), { label: "idle drop" });
});

test("the localhost URL is tried first; when Photoshop refuses it the plugin tries 127.0.0.1; both refused is reported", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await owner(port, token);
  t.after(() => o.close());
  const tried = [];
  const plugin = startFakePlugin({
    port,
    token,
    wsOptions: {
      refuse: (url) => {
        tried.push(url);
        return url.startsWith("ws://localhost");
      }
    }
  });
  await waitFor(() => plugin.phase() === "connected", { label: "fallback connected" });
  assert.deepEqual(tried.slice(0, 2), ["ws://localhost:9890", "ws://127.0.0.1:9890"]);
  assert.equal(plugin.link.state().url, "ws://127.0.0.1:9890");
  plugin.stop();

  const denied = startFakePlugin({ port, token, wsOptions: { refuse: () => true } });
  t.after(() => denied.stop());
  await waitFor(() => denied.phase() === "permission_denied", { label: "permission_denied" });
  assert.match(denied.link.state().detail, /Manifest entry not found/);
});

test("owner exit: the plugin redials and links to the next owner on the same port", async (t) => {
  const port = await freePort();
  const token = newToken();
  const first = await owner(port, token);
  const plugin = startFakePlugin({ port, token });
  t.after(() => plugin.stop());
  await waitFor(() => first.pluginInfo(), { label: "first owner" });
  await first.close();
  await waitFor(() => plugin.phase() !== "connected", { label: "drop seen" });
  const second = await owner(port, token);
  t.after(() => second.close());
  const started = Date.now();
  await waitFor(() => second.pluginInfo(), { label: "second owner" });
  assert.ok(Date.now() - started < 3000, "relinked within the dial interval");
});

test("token reset: the plugin drops the link, and a helper with the old token is refused", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await owner(port, token);
  const plugin = startFakePlugin({ port, token });
  t.after(async () => {
    plugin.stop();
    await o.close();
  });
  await waitFor(() => o.pluginInfo(), { label: "linked" });
  plugin.setToken(newToken());
  plugin.link.restart("Pairing token reset.");
  await waitFor(() => plugin.phase() === "pairing_failed", { label: "old helper refused" });
  assert.equal(o.pluginInfo(), null);
});

test("tool calls: unknown tools, tool errors and unexpected exceptions come back as one line", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await owner(port, token);
  const plugin = startFakePlugin({
    port,
    token,
    handlers: {
      scenario_status: async () => ({ ok: 1 }),
      typed_error: async () => {
        const e = new Error("no document is open");
        e.type = "DocumentClosed";
        throw e;
      },
      crash: async () => {
        throw new TypeError("boom");
      }
    }
  });
  t.after(async () => {
    plugin.stop();
    await o.close();
  });
  await waitFor(() => o.pluginInfo(), { label: "linked" });
  await assert.rejects(o.callOwn("generate", {}), (e) => e.type === "VersionMismatch" && /does not offer generate/.test(e.message));
  await assert.rejects(o.callOwn("typed_error", {}), (e) => e.type === "DocumentClosed" && e.message === "no document is open");
  await assert.rejects(o.callOwn("crash", {}), (e) => e.type === "Internal" && /boom/.test(e.message));
  await assert.rejects(o.callOwn("toString", {}), (e) => e.type === "VersionMismatch", "prototype names are not tools");
});

const SESSION_ENDED = "this client's session ended; call again.";

test("sessions: the plugin takes names from the clients list and refuses calls from sessions not on it", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await owner(port, token);
  const seen = [];
  const plugin = startFakePlugin({
    port,
    token,
    handlers: {
      scenario_status: async (_args, ctx) => {
        seen.push(ctx);
        return { ok: 1 };
      }
    }
  });
  t.after(async () => {
    plugin.stop();
    await o.close();
  });
  await waitFor(() => o.pluginInfo(), { label: "linked" });
  o.setOwnClientName("Claude Code");
  await waitFor(() => plugin.link.state().clients.some((c) => c.client_name === "Claude Code"), { label: "name in the list" });
  await o.callOwn("scenario_status", {});
  const own = o.clients()[0];
  assert.deepEqual(seen[0], { session: own.session, client_name: "Claude Code", connected_at: own.connected_at }, "the handler gets the listed entry");

  // A session id the plugin never saw, and a call with no session at all.
  await assert.rejects(o.callPlugin(() => "Z".repeat(22), "scenario_status", {}), (e) => e.type === "NotConnected" && e.message === SESSION_ENDED);
  await assert.rejects(o.callPlugin(() => undefined, "scenario_status", {}), (e) => e.type === "NotConnected");
  assert.equal(seen.length, 1, "refused calls never reach a handler");
});

test("sessions: an allowance ends when its session leaves the list, and every session ends when the link drops", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await owner(port, token);
  const plugin = startFakePlugin({ port, token });
  t.after(async () => {
    plugin.stop();
    await o.close();
  });
  await waitFor(() => o.pluginInfo(), { label: "linked" });
  // A second client joins through a peer link.
  const { PeerLink } = require("../../helper/src/link/peer.js");
  const peer = new PeerLink({ port, token: hp.parseToken(token) });
  t.after(() => peer.close());
  assert.equal((await peer.connect()).ok, true);
  await waitFor(() => plugin.link.state().clients.length === 2, { label: "peer listed" });
  const peerEntry = plugin.link.state().clients[1];

  plugin.settings._grant(peerEntry);
  assert.equal(plugin.settings.spending().mode, "allow");
  assert.equal(plugin.settings.spending().client.session, peerEntry.session);
  const status = await o.callOwn("scenario_status", {});
  assert.deepEqual(status.agent_spending.client, { session: peerEntry.session, client_name: null, connected_at: peerEntry.connected_at });
  const statusSchema = require("../../shared/catalog.json").tools.find((x) => x.name === "scenario_status").outputSchema;
  // The plugin's part of the answer (the helper adds connected, helper_version and helper_role).
  const spendingSchema = statusSchema.properties.agent_spending;
  assert.deepEqual(require("../../shared/schema-check.js").validate(spendingSchema, status.agent_spending), [], "an allowance matches the catalog");

  peer.close();
  await waitFor(() => plugin.link.state().clients.length === 1, { label: "peer left" });
  assert.deepEqual(plugin.ended.at(-1), { ids: [peerEntry.session], why: "left" });
  assert.equal(plugin.settings.spending().mode, "ask", "the allowance ended with its session");
  assert.equal(plugin.settings.spending().client, null);

  // Grant to the owner's own client, then drop the link: every session ends.
  const ownEntry = plugin.link.state().clients[0];
  plugin.settings._grant(ownEntry);
  await o.close();
  await waitFor(() => plugin.phase() !== "connected", { label: "link dropped" });
  assert.deepEqual(plugin.ended.at(-1), { ids: [ownEntry.session], why: "link closed" });
  assert.equal(plugin.settings.spending().mode, "ask");
  assert.deepEqual(plugin.link.state().clients, []);
});

test("sessions: calls made under an id from an earlier plugin link are refused", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await owner(port, token);
  const plugin = startFakePlugin({ port, token });
  t.after(async () => {
    plugin.stop();
    await o.close();
  });
  await waitFor(() => o.pluginInfo(), { label: "linked" });
  const before = o.clients()[0].session;
  plugin.link.restart("test relink");
  await waitFor(() => o.pluginInfo() && plugin.phase() === "connected" && o.clients()[0].session !== before, { label: "relinked" });
  await assert.rejects(o.callPlugin(() => before, "scenario_status", {}), (e) => e.type === "NotConnected" && e.message === SESSION_ENDED);
  const ok = await o.callOwn("scenario_status", {});
  assert.equal(ok.connected === undefined || ok.connected === true, true);
});

test("a second Photoshop is refused with plugin_busy and says so; the first keeps the link", async (t) => {
  const port = await freePort();
  const token = newToken();
  const o = await owner(port, token);
  const first = startFakePlugin({ port, token });
  t.after(async () => {
    first.stop();
    await o.close();
  });
  await waitFor(() => o.pluginInfo(), { label: "first linked" });
  const second = startFakePlugin({ port, token });
  t.after(() => second.stop());
  await waitFor(() => second.phase() === "plugin_busy", { label: "second refused" });
  const view = require("../../plugin/src/ui/view.js");
  assert.equal(view.describeLink(second.link.state()).headline, "Agents are connected to another Photoshop");
  assert.equal(first.phase(), "connected");
  assert.ok(o.pluginInfo());
  const r = await o.callOwn("scenario_status", {});
  assert.equal(r.photoshop_version, "27.11.0");
});

test("a malformed clients list from the helper closes the link", async (t) => {
  const port = await freePort();
  const token = newToken();
  const s = await squatter(port, "bad_clients", token);
  const plugin = startFakePlugin({ port, token, limits: { dial_interval_ms: 5000, redial_after_drop_ms: 5000 } });
  t.after(async () => {
    plugin.stop();
    await s.close();
  });
  await waitFor(() => plugin.states.some((st) => st.phase === "connected"), { label: "connected first" });
  await waitFor(() => plugin.phase() === "waiting" && /malformed client list/.test(plugin.link.state().detail || ""), { label: "closed on bad list" });
});
