"use strict";
// M3 jobs: the ledger (atomic writes, revisions, a record that cannot be
// written sends nothing), idempotency and the quote checks on the runner,
// result downloads (.part files, the measured redirect, three attempts,
// ResultUnreachable, ResultExpired), and host.placeResults edge cases on the
// fake Photoshop (rollback, busy, not active, a mask that fails).

const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const ledgerMod = require("../../plugin/src/jobs/ledger.js");
const downloadMod = require("../../plugin/src/scenario/download.js");
const hostMod = require("../../plugin/src/host.js");
const randomMod = require("../../plugin/src/util/random.js");
const xmp = require("../../plugin/src/util/xmp.js");
const { createFakePhotoshop } = require("../helpers/fake-photoshop.js");
const { bootGenerate, ledgerFiles, FLARE } = require("../helpers/generate-sim.js");
const { solidPng } = require("../helpers/fixture-scenario.js");
const { waitFor } = require("../helpers/fakes.js");

const random = randomMod.createRandom({ crypto: webcrypto });

function hostOn(ps) {
  return hostMod.createHost(ps.require, { setTimeout, clearTimeout, crypto: webcrypto });
}

test("ledger: records written atomically (temporary file then rename), revisions grow, a failed write drops the record", async () => {
  const ps = createFakePhotoshop({ renameRefusesExisting: true });
  const host = hostOn(ps);
  const ledger = ledgerMod.createLedger({ host, random, session: "s1" });
  await ledger.load();
  const rec = await ledger.create({ state: "submitting", idempotency_key: "quote_a", fingerprint: "f", parameters: { prompt: "x" } });
  assert.match(rec.local_id, ledgerMod.LOCAL_ID);
  assert.equal(rec.revision, 1);
  assert.equal(rec.session, "s1");
  await Promise.all([ledger.update(rec.local_id, { state: "queued", job_id: "job_a" }), ledger.update(rec.local_id, { progress: 0.5 })]);
  const disk = JSON.parse(ps.files.get(`jobs/${rec.local_id}.json`));
  assert.equal(disk.revision, 3);
  assert.equal(disk.state, "queued");
  assert.equal(disk.progress, 0.5);
  assert.ok(!ps.files.has(`jobs/${rec.local_id}.json.tmp`), "the rename replaced the old file");
  assert.equal(ledger.findByKey("quote_a").local_id, rec.local_id);
  assert.equal(ledger.inFlight("f"), null, "queued is not in flight");

  // A Photoshop whose rename fails: records are written in place, results copied.
  const noRename = createFakePhotoshop({ noRename: true });
  const h3 = hostOn(noRename);
  const l3 = ledgerMod.createLedger({ host: h3, random });
  await l3.load();
  const r3 = await l3.create({ state: "submitting", idempotency_key: "quote_c", fingerprint: "h" });
  assert.equal(JSON.parse(noRename.files.get(`jobs/${r3.local_id}.json`)).state, "submitting");
  assert.ok(!noRename.files.has(`jobs/${r3.local_id}.json.tmp`));
  await h3.writeDataBinary("Scenario/x.png.part", new Uint8Array([1, 2, 3]));
  await h3.renameData("Scenario/x.png.part", "Scenario/x.png");
  assert.deepEqual([...noRename.files.get("Scenario/x.png")], [1, 2, 3]);
  assert.ok(!noRename.files.has("Scenario/x.png.part"));

  const failing = createFakePhotoshop({ failWrite: (n) => n.startsWith("jobs/") });
  const l2 = ledgerMod.createLedger({ host: hostOn(failing), random });
  await l2.load();
  await assert.rejects(l2.create({ state: "submitting", idempotency_key: "quote_b", fingerprint: "g" }));
  assert.equal(l2.all().length, 0, "a record that cannot be written is dropped, so nothing is sent for it");
});

test("runner: the quote id is the idempotency key; a replay sends nothing; another request with the key conflicts; a changed request is refused before any record", async (t) => {
  const { app, mock, ps } = await bootGenerate(t, { docs: [] });
  const req = { model_id: FLARE, lane: "image", parameters: { prompt: "a quiet harbor", width: 1024, height: 1024, quality: "low" }, takes: 1, pending: {}, target: { kind: "new_document", width: 1024, height: 1024 } };
  const q = await app.quotes.estimate(req);
  assert.equal(q.cu_cost_exact, "2");
  const first = await app.runner.start({ req, quote: q, refs: [], model_name: "GPT Image 2.5 Flare" });
  assert.equal(first.state, "queued");
  const again = await app.runner.start({ req, quote: q, refs: [] });
  assert.equal(again.replayed, true);
  assert.equal(again.record.local_id, first.record.local_id);
  await assert.rejects(app.runner.start({ req: { ...req, parameters: { ...req.parameters, prompt: "another" } }, quote: q, refs: [] }), (e) => e.type === "IdempotencyConflict");
  assert.equal(mock.paidCalls.length, 1);

  const q2 = await app.quotes.estimate(req);
  await assert.rejects(app.runner.start({ req: { ...req, target: { kind: "new_document", width: 2048, height: 2048 } }, quote: q2, refs: [] }), (e) => e.type === "QuoteMismatch");
  await assert.rejects(app.runner.start({ req, quote: { ...q2, cu_cost_exact: "2.0" }, refs: [] }), (e) => e.type === "CostMismatch");
  await assert.rejects(app.runner.start({ req, quote: { quote_id: "quote_000000000000000000000000", cu_cost_exact: "2" }, refs: [] }), (e) => e.type === "QuoteExpired");
  assert.equal(app.ledger.all().length, 1, "refused requests leave no record");
  assert.equal(mock.paidCalls.length, 1);

  // No-spend refuses at once.
  app.settings.noSpend = () => true;
  await assert.rejects(app.runner.start({ req, quote: q2, refs: [] }), (e) => e.type === "NoSpend");
  app.settings.noSpend = () => false;

  // The new-document job lands by itself when no document is open.
  await waitFor(() => app.ledger.get(first.record.local_id).state === "applied", { label: "placed in a new document" });
  assert.equal(ps.app.documents.length, 1);
  assert.equal(ps.app.documents[0].width, 1024);
  assert.equal(ledgerFiles(ps)[0].state, "applied");
});

test("runner: a request still being sent blocks a second one with the same fingerprint (RequestInFlight)", async (t) => {
  const { app, mock } = await bootGenerate(t, { docs: [], mockOpts: { paid: () => ({ status: null }) } });
  const req = { model_id: FLARE, lane: "image", parameters: { prompt: "a quiet harbor", width: 1024, height: 1024, quality: "low" }, takes: 1, pending: {}, target: { kind: "new_document", width: 1024, height: 1024 } };
  const q1 = await app.quotes.estimate(req);
  const q2 = await app.quotes.estimate(req);
  const pending = app.runner.start({ req, quote: q1, refs: [] });
  await waitFor(() => mock.paidCalls.length === 1, { label: "sent" });
  assert.equal(app.ledger.all()[0].state, "submitting", "written before the request left");
  await assert.rejects(app.runner.start({ req, quote: q2, refs: [] }), (e) => e.type === "RequestInFlight" && e.message === "This request is already being sent.");
  assert.equal(mock.paidCalls.length, 1);
  pending.catch(() => {});
});

function fakeDownloadEnv(over = {}) {
  const files = new Map();
  const log = [];
  const sleeps = [];
  const fetches = [];
  const asset = over.asset || ((id) => ({ status: 200, body: { asset: { id, url: `https://cdn.cloud.scenario.com/assets-transform/${id}?Signature=s`, mimeType: "image/png", metadata: { width: 8, height: 8 } } } }));
  const client = {
    async request(method, path) {
      const id = path.split("/").pop();
      const a = asset(id);
      if (a.status !== 200) {
        const e = new Error(`HTTP ${a.status}`);
        e.status = a.status;
        throw e;
      }
      return a;
    }
  };
  const answers = over.answers || [() => ({ status: 200, url: "https://cdn.cloud.scenario.com/assets-transform/x?Signature=t", bytes: solidPng(8, 8) })];
  const fetch = async (url, init) => {
    fetches.push({ url, init });
    const a = answers[Math.min(fetches.length - 1, answers.length - 1)]();
    if (a.throw) throw new TypeError(a.throw);
    return {
      status: a.status,
      url: a.url,
      headers: { get: (k) => (k === "content-length" ? (a.length === undefined ? String(a.bytes.length) : a.length) : null) },
      arrayBuffer: async () => Uint8Array.from(a.bytes).buffer
    };
  };
  const d = downloadMod.createDownloader({
    client,
    fetch,
    files: {
      writeBinary: async (p, b) => {
        log.push(`write ${p}`);
        files.set(p, b);
      },
      rename: async (a, b) => {
        log.push(`rename ${a} ${b}`);
        files.set(b, files.get(a));
        files.delete(a);
      },
      remove: async (p) => files.delete(p)
    },
    sleep: async (ms) => sleeps.push(ms)
  });
  return { d, files, log, sleeps, fetches };
}

test("download: written to a .part file then renamed; no key, no cookies; the redirect's final host is checked", async () => {
  const env = fakeDownloadEnv();
  const got = await env.d.download("asset_abc", "Scenario/image/20261019/2026-10-19-harbor-abc");
  assert.deepEqual(got, { path: "Scenario/image/20261019/2026-10-19-harbor-abc.png", ext: "png", mime: "image/png", width: 8, height: 8, bytes: solidPng(8, 8).length });
  assert.deepEqual(env.log, ["write Scenario/image/20261019/2026-10-19-harbor-abc.png.part", "rename Scenario/image/20261019/2026-10-19-harbor-abc.png.part Scenario/image/20261019/2026-10-19-harbor-abc.png"]);
  const init = env.fetches[0].init;
  assert.equal(init.credentials, "omit");
  assert.deepEqual(init.headers, {});
  assert.equal(init.redirect, "follow");

  const away = fakeDownloadEnv({ answers: [() => ({ status: 200, url: "https://elsewhere.example/x", bytes: solidPng(8, 8) })] });
  await assert.rejects(away.d.download("asset_abc", "a"), (e) => e.type === "ResultUnreachable");
  assert.equal(away.fetches.length, 1, "not retried");
  assert.equal(away.files.size, 0);
});

test("download: three attempts with back-off on errors, short or broken files; a link on another host or a gone asset stops at once", async () => {
  const flaky = fakeDownloadEnv({
    answers: [() => ({ status: 500, url: "https://cdn.cloud.scenario.com/x", bytes: Buffer.from("err") }), () => ({ status: 200, url: "https://cdn.cloud.scenario.com/x", bytes: solidPng(8, 8), length: "999999" }), () => ({ status: 200, url: "https://cdn.cloud.scenario.com/x", bytes: solidPng(8, 8) })]
  });
  const got = await flaky.d.download("asset_abc", "b");
  assert.equal(got.path, "b.png");
  assert.equal(flaky.fetches.length, 3);
  assert.deepEqual(flaky.sleeps, [1000, 3000]);

  const broken = fakeDownloadEnv({ answers: [() => ({ status: 200, url: "https://cdn.cloud.scenario.com/x", bytes: Buffer.from("<html>not an image</html>") })] });
  await assert.rejects(broken.d.download("asset_abc", "c"), (e) => e.downloadFailed === true && /after 3 attempts/.test(e.message));
  assert.equal(broken.fetches.length, downloadMod.ATTEMPTS);
  assert.equal(broken.files.size, 0, "nothing written for a file that is not an image");

  const offline = fakeDownloadEnv({ answers: [() => ({ throw: "network down" })] });
  await assert.rejects(offline.d.download("asset_abc", "d"), (e) => e.downloadFailed === true);

  const elsewhere = fakeDownloadEnv({ asset: (id) => ({ status: 200, body: { asset: { id, url: "https://storage.example/x" } } }) });
  await assert.rejects(elsewhere.d.download("asset_abc", "e"), (e) => e.type === "ResultUnreachable");
  assert.equal(elsewhere.fetches.length, 0, "never fetched");

  const gone = fakeDownloadEnv({ asset: () => ({ status: 404 }) });
  await assert.rejects(gone.d.download("asset_abc", "f"), (e) => e.type === "ResultExpired");
});

test("download: a result whose download stopped keeps its charge and is resumed from Jobs, then lands as Place when ready", async (t) => {
  let fail = 3;
  const { app, ps, doc } = await bootGenerate(t, {
    docs: [{ id: 7, title: "poster.psd", width: 1024, height: 1024 }],
    active: 7,
    mockOpts: { cdn: () => (fail-- > 0 ? { status: 500, body: "busy", headers: { "content-type": "text/plain" } } : undefined) }
  });
  const req = { model_id: FLARE, lane: "image", parameters: { prompt: "a quiet harbor", width: 1024, height: 1024, quality: "low" }, takes: 1, pending: {}, target: { kind: "canvas", document_id: 7, box: [0, 0, 1024, 1024] } };
  const q = await app.quotes.estimate(req);
  const out = await app.runner.start({ req, quote: q, refs: [] });
  const id = out.record.local_id;
  await waitFor(() => app.ledger.get(id).state === "download_failed", { label: "download stopped", timeout: 15000 });
  assert.equal(app.ledger.get(id).cu_charged, "2", "the charge is known even though the file is not saved");
  assert.match(app.ledger.get(id).error, /^Download stopped: Download stopped after 3 attempts/);
  doc.byId("jobs").click();
  const row = doc.byId("jobs-list").children[0];
  const main = row.children[1];
  const acts = main.children[main.children.length - 1].children;
  assert.deepEqual(acts.map((b) => b.getAttribute("data-action")), ["resume", "copy_error"]);
  acts[0].click();
  await waitFor(() => app.ledger.get(id).state === "applied", { label: "resumed and placed" });
  assert.deepEqual(ps.history, [{ document_id: 7, name: "Scenario: Place image" }]);
  const jobsText = require("../../plugin/src/ui/jobs-text.js");
  assert.deepEqual(jobsText.actions({ state: "download_failed", download_error_type: "ResultExpired" }), ["copy_error"], "an expired result cannot be resumed");
});

test("placeResults: a failure rolls the History state back; busy and not-active are reported for Place when ready; a mask that fails is a note", async () => {
  const ps = createFakePhotoshop({ docs: [{ id: 7, width: 1024, height: 1024 }, { id: 8, width: 512, height: 512 }], active: 7 });
  const host = hostOn(ps);
  ps.files.set("Scenario/image/a.png", new Uint8Array(solidPng(1024, 1024)));
  ps.files.set("Scenario/image/b.png", new Uint8Array(solidPng(1024, 1024)));
  const take = (path, i) => ({ path, asset_id: `asset_t${i}`, name: `Take ${i}`, xmp: xmp.build({ schema: "1", assetId: `asset_t${i}` }), visible: i === 1, width: 1024, height: 1024, fit: { scale_pct: 100, center_x: 512, center_y: 512, width: 1024, height: 1024 } });
  const base = { history_name: "Scenario: Place image", kind: "image", document_id: 7, new_document: null, box: { left: 0, top: 0, width: 1024, height: 1024 }, group: { name: "G", xmp: xmp.build({ schema: "1" }) }, mask: null };

  const missing = { ...base, takes: [take("Scenario/image/a.png", 1), take("Scenario/image/missing.png", 2)] };
  await assert.rejects(host.placeResults(missing, {}));
  assert.deepEqual(ps.rolledBack, [{ document_id: 7, name: "Scenario: Place image" }]);
  assert.equal(ps.history.length, 0);
  assert.deepEqual(ps.doc(7).layers.map((l) => l.name), ["Background"], "the document is as it was");

  ps.busy = 1;
  await assert.rejects(host.placeResults({ ...base, takes: [take("Scenario/image/a.png", 1)], group: null }, { auto: true }), (e) => e.busy === true);
  assert.equal(ps.history.length, 0);

  ps.setActive(8);
  await assert.rejects(host.placeResults({ ...base, takes: [take("Scenario/image/a.png", 1)], group: null }, { auto: true }), (e) => e.notActive === true);
  ps.setActive(7);

  const masked = { ...base, takes: [take("Scenario/image/a.png", 1), take("Scenario/image/b.png", 2)], mask: { left: 0, top: 0, width: 4, height: 4, data: new Uint8Array(16) } };
  ps.modules.photoshop.imaging.putLayerMask = async () => {
    throw new Error("mask refused");
  };
  const out = await host.placeResults(masked, {});
  assert.deepEqual(out.notes, ["Placed unmasked: the selection mask could not be applied."]);
  assert.equal(out.layer_ids.length, 2);
  assert.ok(out.group_id);
  assert.deepEqual(ps.history, [{ document_id: 7, name: "Scenario: Place image" }]);
});

test("references: a chosen file is stripped of its metadata; a file of 4 MB or more is refused; the dialog's cancel adds nothing", async (t) => {
  const { app, ps } = await bootGenerate(t, { docs: [{ id: 7, width: 1024, height: 1024 }], active: 7 });
  const file = solidPng(64, 32);
  ps.chosenFile = { name: "palette.png", bytes: file };
  const ref = await app.references.chooseFile(FLARE);
  assert.deepEqual([ref.label, ref.ext, ref.width, ref.height, ref.reduced, ref.source], ["palette.png", "png", 64, 32, false, "file"]);
  ps.chosenFile = { name: "huge.jpg", bytes: Buffer.concat([require("../helpers/fake-photoshop.js").fakeJpeg(3000, 2000, 0.7)]) };
  await assert.rejects(app.references.chooseFile(FLARE), (e) => e.type === "InvalidParameter" && /files must be under 4 MB/.test(e.message));
  ps.chosenFile = { name: "notes.txt", bytes: Buffer.from("hello") };
  await assert.rejects(app.references.chooseFile(FLARE), (e) => /Choose a PNG or JPEG file/.test(e.message));
  ps.chosenFile = null;
  assert.equal(await app.references.chooseFile(FLARE), null);
  await assert.rejects(app.references.capture("selection", 7, FLARE), (e) => /There is no selection/.test(e.message));
});
