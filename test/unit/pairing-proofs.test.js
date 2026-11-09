"use strict";
// Pairing proofs and message MACs. The plugin (plain JavaScript) and the
// helper (node:crypto) implement the same rules separately; these tests check
// that they agree byte for byte and that each refuses tampered, replayed,
// reflected and cross-link messages.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const pp = require("../../plugin/src/bridge/protocol.js");
const hp = require("../../helper/src/link/crypto.js");
const randomMod = require("../../plugin/src/util/random.js");
const pairingMod = require("../../plugin/src/bridge/pairing.js");
const { fakeHost, newToken } = require("../helpers/fakes.js");

const V = require("../vectors/pairing.json");

const nonce = () => crypto.randomBytes(32).toString("base64url");

test("known-answer vectors: both implementations reproduce the SPEC 2.6 byte layout", () => {
  const pt = pp.parseToken(V.token);
  const ht = hp.parseToken(V.token);
  // An independent computation from the layout: label, 0x00, raw nonces.
  const raw = (b64) => Buffer.from(b64, "base64url");
  const h = (key, ...parts) => crypto.createHmac("sha256", key).update(Buffer.concat(parts)).digest();
  const Z = Buffer.from([0]);
  assert.equal(h(raw(V.token), Buffer.from("plugin"), Z, raw(V.nonce_o), raw(V.nonce_c)).toString("base64url"), V.proof_plugin);
  for (const impl of [
    [pp, pt],
    [hp, ht]
  ]) {
    const [m, t] = impl;
    assert.equal(m.connectProof(t, "plugin", V.nonce_o, V.nonce_c), V.proof_plugin);
    assert.equal(m.connectProof(t, "peer", V.nonce_o, V.nonce_c), V.proof_peer);
    assert.equal(m.ownerProof(t, V.nonce_o, V.nonce_c), V.proof_o);
    const key = m.sessionKey(t, V.nonce_o, V.nonce_c);
    assert.equal(Buffer.from(key).toString("hex"), V.session_key_hex);
    const owner = new m.Channel(key, "o2c", "c2o");
    assert.equal(owner.seal({ t: "ping" }), V.frame_o2c_1);
    const client = new m.Channel(key, "c2o", "o2c");
    assert.deepEqual(client.open(V.frame_o2c_1), { t: "ping" });
    assert.deepEqual(owner.open(V.frame_c2o_258), { t: "ping" }, "counters may skip ahead; they must increase");
    assert.throws(() => owner.open(V.frame_c2o_258), /old counter/);
  }
  assert.deepEqual([...pp.counterBytes(258)], [0, 0, 0, 0, 0, 0, 1, 2]);
  assert.deepEqual([...pp.counterBytes(2 ** 40 + 5)], [...hp.counterBytes(2 ** 40 + 5)]);
});

test("plugin and helper compute the same proofs, owner proofs and session keys", () => {
  for (let i = 0; i < 50; i++) {
    const token = newToken();
    const pt = pp.parseToken(token);
    const ht = hp.parseToken(token);
    const no = nonce();
    const nc = nonce();
    for (const role of ["plugin", "peer"]) assert.equal(pp.connectProof(pt, role, no, nc), hp.connectProof(ht, role, no, nc));
    assert.equal(pp.ownerProof(pt, no, nc), hp.ownerProof(ht, no, nc));
    assert.equal(Buffer.from(pp.sessionKey(pt, no, nc)).toString("hex"), hp.sessionKey(ht, no, nc).toString("hex"));
  }
  assert.throws(() => pp.connectProof(pp.parseToken(newToken()), "plugin", "short", nonce()), /nonce/);
  assert.throws(() => hp.connectProof(hp.parseToken(newToken()), "plugin", "short", nonce()), /nonce/);
});

test("proofs are bound to the role, the nonce order and the token", () => {
  const t = hp.parseToken(newToken());
  const no = nonce();
  const nc = nonce();
  const plugin = hp.connectProof(t, "plugin", no, nc);
  assert.notEqual(plugin, hp.connectProof(t, "peer", no, nc), "a plugin proof is not a peer proof");
  assert.notEqual(plugin, hp.connectProof(t, "plugin", nc, no), "nonce order matters");
  assert.notEqual(hp.ownerProof(t, no, nc), hp.connectProof(t, "owner", no, nc), "the owner proof swaps the nonces");
  assert.notEqual(plugin, hp.connectProof(hp.parseToken(newToken()), "plugin", no, nc), "another token gives another proof");
  assert.equal(hp.proofMatches(plugin, plugin), true);
  assert.equal(hp.proofMatches(plugin, hp.connectProof(t, "peer", no, nc)), false);
  assert.equal(pp.proofMatches(plugin, plugin), true);
  assert.equal(pp.proofMatches(plugin, "x".repeat(43)), false);
});

test("tokens: 43 base64url characters for 32 bytes, both parsers agree", () => {
  const good = newToken();
  assert.ok(pp.parseToken(good));
  assert.ok(hp.parseToken(good));
  assert.ok(pp.parseToken(`  ${good}\n`), "surrounding whitespace from a paste is accepted");
  for (const bad of ["", "short", good.slice(0, 42), good + "A", good.slice(0, 42) + "=", good.slice(0, 42) + "+", null, 12]) {
    assert.equal(pp.parseToken(bad), null, String(bad));
    assert.equal(hp.parseToken(bad), null, String(bad));
  }
  // Non-canonical last character (trailing bits set) is refused by both.
  const bytes = Buffer.from(good, "base64url");
  const canonicalLast = bytes.toString("base64url").slice(-1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const idx = alphabet.indexOf(canonicalLast);
  const altered = good.slice(0, 42) + alphabet[(idx & ~3) | ((idx + 1) & 3)];
  if (altered !== good) {
    assert.equal(pp.parseToken(altered), null);
    assert.equal(hp.parseToken(altered), null);
  }
});

function pairOfChannels(impl, key) {
  return { owner: new impl.Channel(key, "o2c", "c2o"), client: new impl.Channel(key, "c2o", "o2c") };
}

// "<counter>.<mac>.<body>" -> parts, and back.
function split(frame) {
  const i = frame.indexOf(".");
  const j = frame.indexOf(".", i + 1);
  return { n: frame.slice(0, i), m: frame.slice(i + 1, j), b: frame.slice(j + 1) };
}
const join = (f) => `${f.n}.${f.m}.${f.b}`;

test("a message sealed by one implementation opens in the other, in order", () => {
  const key = crypto.randomBytes(32);
  const helperSide = new hp.Channel(key, "o2c", "c2o");
  const pluginSide = new pp.Channel(new Uint8Array(key), "c2o", "o2c");
  for (let i = 0; i < 5; i++) {
    const msg = { t: "call", id: i, tool: "scenario_status", args: {}, note: "é 😀 . dots | pipes" };
    assert.deepEqual(pluginSide.open(helperSide.seal(msg)), msg);
    const back = { t: "result", id: i, ok: true, result: { title: "Affiche été.psd" } };
    assert.deepEqual(helperSide.open(Buffer.from(pluginSide.seal(back), "utf8")), back);
  }
});

test("the MAC covers the body bytes as received, not a re-serialization", () => {
  const key = crypto.randomBytes(32);
  const body = '{ "t" : "ping", "x" : 1.0 }';
  const mac = hp.messageMac(key, "o2c", 1, Buffer.from(body, "utf8")).toString("base64url");
  const frame = `1.${mac}.${body}`;
  assert.deepEqual(new hp.Channel(key, "c2o", "o2c").open(Buffer.from(frame)), { t: "ping", x: 1 });
  assert.deepEqual(new pp.Channel(new Uint8Array(key), "c2o", "o2c").open(frame), { t: "ping", x: 1 });
  const reserialized = `1.${mac}.${JSON.stringify(JSON.parse(body))}`;
  assert.throws(() => new hp.Channel(key, "c2o", "o2c").open(reserialized), /bad MAC/);
});

for (const [name, impl, toKey] of [
  ["helper", hp, (k) => k],
  ["plugin", pp, (k) => new Uint8Array(k)]
]) {
  test(`${name} channel refuses tampered, replayed, reordered, reflected and foreign messages`, () => {
    const rawKey = crypto.randomBytes(32);
    const key = toKey(rawKey);
    const make = () => pairOfChannels(impl, key);

    // Tampered body.
    let c = make();
    let f = split(c.owner.seal({ t: "ping" }));
    f.b = JSON.stringify({ t: "pong" });
    assert.throws(() => c.client.open(join(f)), /bad MAC/);

    // Tampered MAC.
    c = make();
    f = split(c.owner.seal({ t: "ping" }));
    f.m = (f.m[0] === "A" ? "B" : "A") + f.m.slice(1);
    assert.throws(() => c.client.open(join(f)), /bad MAC/);

    // Tampered counter.
    c = make();
    f = split(c.owner.seal({ t: "ping" }));
    f.n = "2";
    assert.throws(() => c.client.open(join(f)), /bad MAC/);

    // Replay of an accepted message.
    c = make();
    const first = c.owner.seal({ t: "ping" });
    c.client.open(first);
    assert.throws(() => c.client.open(first), /old counter/);

    // Reordered: message 2, then message 1.
    c = make();
    const m1 = c.owner.seal({ t: "ping" });
    const m2 = c.owner.seal({ t: "ping" });
    c.client.open(m2);
    assert.throws(() => c.client.open(m1), /old counter/);

    // Reflection: a message the client sent, fed back to the client.
    c = make();
    const own = c.client.seal({ t: "ping" });
    assert.throws(() => c.client.open(own), /bad MAC/);

    // Foreign: sealed under another link's key.
    const other = pairOfChannels(impl, toKey(crypto.randomBytes(32)));
    assert.throws(() => make().client.open(other.owner.seal({ t: "ping" })), /bad MAC/);

    // Malformed frames.
    c = make();
    const mac = "A".repeat(43);
    for (const bad of ["", "{}", "1..{}", `0.${mac}.{}`, `01.${mac}.{}`, `-1.${mac}.{}`, `1.${mac.slice(1)}.{}`, `1.${mac}A.{}`, `1 .${mac}.{}`, `${"9".repeat(17)}.${mac}.{}`, `1.${mac}`, JSON.stringify({ n: 1, b: "{}", m: mac })]) {
      assert.throws(() => c.client.open(bad), /malformed|bad MAC/, bad);
    }
    assert.throws(() => c.client.open(42), /not text/);

    // A valid MAC around a body that is not a message object.
    for (const body of ["[1]", "3", '{"no_type":1}', "not json", ""]) {
      c = make();
      const m = hp.messageMac(rawKey, "o2c", 1, Buffer.from(body, "utf8")).toString("base64url");
      assert.throws(() => c.client.open(`1.${m}.${body}`), /malformed message/, body);
    }
  });
}

test("handshake messages are checked against shared/protocol.json", () => {
  const ok = JSON.stringify({ t: "challenge", protocol: 1, role: "owner", nonce_o: nonce() });
  assert.ok(pp.readHandshake("challenge", ok));
  assert.ok(hp.readHandshake("challenge", ok));
  assert.ok(hp.readHandshake("proof", JSON.stringify({ t: "proof", role: "peer", nonce_c: nonce(), proof: nonce() })));
  assert.ok(pp.readHandshake("owner_proof", JSON.stringify({ t: "owner_proof", proof_o: nonce() })));
  assert.ok(pp.readHandshake("pairing_failed", '{"t":"pairing_failed"}'));
  for (const bad of [
    JSON.stringify({ t: "challenge", protocol: 1, role: "plugin", nonce_o: nonce() }),
    JSON.stringify({ t: "challenge", protocol: "1", role: "owner", nonce_o: nonce() }),
    JSON.stringify({ t: "challenge", protocol: 1, role: "owner", nonce_o: "short" }),
    JSON.stringify({ t: "challenge", protocol: 1, role: "owner", nonce: nonce() }),
    JSON.stringify({ t: "challenge", protocol: 1, role: "owner", nonce_o: nonce(), extra: true }),
    "x".repeat(5000)
  ]) {
    assert.equal(pp.readHandshake("challenge", bad), null, bad.slice(0, 80));
    assert.equal(hp.readHandshake("challenge", bad), null, bad.slice(0, 80));
  }
  assert.equal(hp.readHandshake("proof", JSON.stringify({ t: "proof", protocol: 1, role: "peer", nonce_c: nonce(), proof: nonce() })), null);
  assert.equal(hp.readHandshake("pairing_failed", '{"t":"pairing_failed","why":"x"}'), null);
});

test("random source: getRandomValues first, randomUUID fallback, refusal without either", () => {
  const real = randomMod.createRandom({ crypto: crypto.webcrypto });
  assert.equal(real.source, "getRandomValues");
  const a = real.bytes(32);
  const b = real.bytes(32);
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
  assert.equal(real.bytes(70000).length, 70000);

  const uuidOnly = randomMod.createRandom({ crypto: { randomUUID: () => crypto.randomUUID() } });
  assert.equal(uuidOnly.source, "randomUUID");
  const u1 = uuidOnly.bytes(32);
  const u2 = uuidOnly.bytes(32);
  assert.notDeepEqual(u1, u2);
  assert.equal(uuidOnly.bytes(45).length, 45);

  const broken = randomMod.createRandom({ crypto: { getRandomValues: () => {}, randomUUID: () => crypto.randomUUID() } });
  assert.equal(broken.source, "randomUUID", "an all-zero getRandomValues is not trusted");
  const throwing = randomMod.createRandom({
    crypto: {
      getRandomValues: () => {
        throw new Error("nope");
      },
      randomUUID: () => crypto.randomUUID()
    }
  });
  assert.equal(throwing.source, "randomUUID");
  assert.throws(() => randomMod.createRandom({ crypto: {} }), /No secure random source/);
  assert.throws(() => randomMod.createRandom({}), /No secure random source/);
});

test("pairing token: created once, kept in secure storage, reset makes a new one", async () => {
  const host = fakeHost();
  const random = randomMod.createRandom({ crypto: crypto.webcrypto });
  const pairing = pairingMod.createPairing(host, random);
  const first = await pairing.loadOrCreate();
  assert.equal(first.created, true);
  assert.ok(pp.parseToken(first.token));
  assert.equal(host.secure.get("scenario.pairing_token"), first.token);
  assert.equal(pairing.hint(), first.token.slice(-4));

  const again = await pairingMod.createPairing(host, random).loadOrCreate();
  assert.equal(again.created, false);
  assert.equal(again.token, first.token);

  const fresh = await pairing.reset();
  assert.notEqual(fresh, first.token);
  assert.equal(host.secure.get("scenario.pairing_token"), fresh);

  host.secure.set("scenario.pairing_token", "damaged");
  const repaired = await pairingMod.createPairing(host, random).loadOrCreate();
  assert.equal(repaired.created, true, "a damaged stored value is replaced");

  await assert.rejects(() => pairing.adopt("not a token"), /not a valid pairing token/);
  const t = newToken();
  assert.equal(await pairing.adopt(`${t}\n`), t);
});
