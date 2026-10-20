"use strict";
// M5, the Jobs logic: Unknown resolution (SPEC 6.2 step 5) against the
// measured jobs list and text assets, Stop download and Resume, Cancel while
// uploading, the ledger's checks on records read from disk, the Jobs view
// model (filters, rows, header, Resolve), and the release stub of the
// development test hooks.

const test = require("node:test");
const assert = require("node:assert/strict");
const { bundle } = require("../../plugin/scripts/build.js");
const ledgerMod = require("../../plugin/src/jobs/ledger.js");
const resolveMod = require("../../plugin/src/jobs/resolve.js");
const jobsApi = require("../../plugin/src/scenario/jobs-api.js");
const hooksMod = require("../../plugin/src/dev/test-hooks.js");
const { createWorld, onDisk } = require("../helpers/restart-sim.js");
const { jobsFixture } = require("../helpers/fixture-scenario.js");
const { createFakePhotoshop } = require("../helpers/fake-photoshop.js");
const hostMod = require("../../plugin/src/host.js");
const { waitFor, sleep } = require("../helpers/fakes.js");

const FLARE = "model_openai-gpt-image-2-5-flare";
const BG = "model_851-labs-background-remover";
const POSTER = { id: 7, title: "poster.psd", width: 1024, height: 1024, path: "D:/art/poster.psd" };
const id = (n) => `0000000${n}-0000-4000-8000-000000000000`;

async function startImage(app, prompt = "a quiet harbor at dawn") {
  const req = { model_id: FLARE, lane: "image", parameters: { prompt, width: 1024, height: 1024, quality: "low" }, takes: 1, pending: {}, target: { kind: "canvas", document_id: 7, box: [0, 0, 1024, 1024] } };
  const q = await app.quotes.estimate(req);
  return app.runner.start({ req, quote: q, refs: [], model_name: "GPT Image 2.5 Flare", document_title: "poster.psd" });
}

// An Unknown record as a restart leaves it, claimed `minutesAgo` ago.
function unknownRecord(n, params, extra = {}) {
  const at = new Date(Date.now() - (extra.minutesAgo || 1) * 60000).toISOString();
  return {
    local_id: id(n),
    revision: 2,
    idempotency_key: `quote_${n}`,
    fingerprint: `f${n}`,
    origin: { kind: "person" },
    project: { name: "Restart project" },
    lane: "image",
    model_id: FLARE,
    model_name: "GPT Image 2.5 Flare",
    parameters: params,
    inputs: { references: [], asset_ids: [] },
    target: { kind: "canvas", document_id: 7, document_title: "poster.psd", document_key: null, box: [0, 0, 1024, 1024] },
    state: "submitting",
    job_id: extra.job_id || null,
    cu_quoted: "2",
    outputs: [],
    created_at: at,
    claimed_at: at,
    session: "before"
  };
}

function mockJob(idv, body, minutesAgo, plan = ["success"]) {
  return { id: idv, model: FLARE, body, polls: 0, charge: 2, plan, createdAt: new Date(Date.now() - minutesAgo * 60000).toISOString() };
}

test("jobs list rows read as measured: model jobs, the prompt as a text asset, upload jobs kept apart", () => {
  const row = jobsApi.readJob({ jobId: "job_fixtureListRow0001", jobType: "custom", billing: { cuCost: 2, cuDiscount: 0 }, metadata: { input: { modelId: FLARE, height: 1024, numOutputs: 1, prompt: "asset_fixturePromptText01", quality: "low", width: 1024 }, assetIds: ["asset_fixtureOutput00001"] }, ownerId: "proj_x", authorId: "apiu_x", createdAt: "2026-10-19T07:18:03.243Z", status: "success", progress: 1 });
  assert.equal(row.job_type, "custom");
  assert.equal(row.model_id, FLARE);
  assert.equal(row.created_at, "2026-10-19T07:18:03.243Z");
  assert.equal(row.status, "succeeded");
  assert.equal(row.input.prompt, "asset_fixturePromptText01");
  assert.ok(!JSON.stringify(row).includes("proj_x") && !JSON.stringify(row).includes("apiu_x"), "owner and author ids are not kept");
  const upload = jobsApi.readJob({ jobId: "job_PnQb0000", jobType: "upload", billing: { cuCost: 0, cuDiscount: 0 }, metadata: { input: { uploadId: "upl_x", uploadType: "multipart" } }, createdAt: "2026-10-19T07:12:02.657Z", status: "success" });
  assert.equal(upload.job_type, "upload");
  assert.equal(upload.model_id, null);
  assert.equal(jobsApi.readJob(jobsFixture.final_failure.body.job).status, "failed", "no blocked text is known yet");
  assert.equal(jobsApi.readJob(jobsFixture.final_failure.body.job, ["contact support"]).status, "blocked", "a text in data makes it Blocked");
  assert.deepEqual(jobsApi.BLOCKED_TEXTS, []);
});

test("Unknown resolution: the time window, the text asset prompt, jobs another record holds left out; Mark not sent only when nothing matches", async (t) => {
  const params = { prompt: "a quiet harbor at dawn", width: 1024, height: 1024, quality: "low" };
  const w = await createWorld(t);
  w.files.set(`jobs/${id(1)}.json`, JSON.stringify(unknownRecord(1, params)));
  w.files.set(`jobs/${id(2)}.json`, JSON.stringify({ ...unknownRecord(2, { ...params, prompt: "a red bicycle" }), state: "ready", job_id: "job_mine2" }));
  w.files.set(`jobs/${id(3)}.json`, JSON.stringify(unknownRecord(3, { ...params, prompt: "nothing like it" })));
  // Scenario: the job that ran (prompt as a text asset in the list), a job
  // with other inputs, a job another record holds, and one outside the window.
  w.mock.jobs.set("job_ran", mockJob("job_ran", params, 0.5));
  w.mock.jobs.set("job_other", mockJob("job_other", { ...params, quality: "high" }, 0.8));
  w.mock.jobs.set("job_mine2", mockJob("job_mine2", { ...params, prompt: "a red bicycle" }, 0.7));
  w.mock.jobs.set("job_old", mockJob("job_old", params, 30));
  const s = await w.boot({ docs: [POSTER], active: 7, signIn: true });
  assert.equal(s.app.ledger.get(id(1)).state, "uncertain");

  const c = await s.app.runner.check(id(1));
  assert.equal(c.complete, true);
  assert.deepEqual(c.candidates.map((x) => [x.job_id, x.exact]), [["job_ran", true], ["job_other", false]]);
  assert.equal(c.preselected, "job_ran");
  const listCall = w.mock.requests.find((r) => r.path === "/v1/jobs");
  const claim = Date.parse(s.app.ledger.get(id(1)).claimed_at);
  assert.equal(Date.parse(listCall.query.createdAfter), claim - 600000, "listed from the claim time minus 10 minutes");
  assert.equal(listCall.query.pageSize, "50");
  await assert.rejects(s.app.runner.link(id(1), "job_mine2"), /already linked to another job/);
  await assert.rejects(s.app.runner.markNotSent(id(1)), (e) => e.type === "JobMayExist");

  // Record 3: other jobs in the window, none with its inputs: Mark not sent is allowed.
  const v = (await s.app.jobsModel.act(id(3), "resolve")) && (await s.app.runner.check(id(3)));
  assert.equal(v.preselected, null);
  assert.ok(v.candidates.length >= 2 && v.candidates.every((x) => !x.exact));
  const view = s.app.jobsModel.resolveView(id(3));
  assert.equal(view.note, "Jobs on Scenario around that time, none with the same inputs. Link one only if you know it is this request.");
  assert.equal(view.actions.mark_not_sent.enabled, true);
  await s.app.jobsModel.act(id(3), "mark_not_sent");
  const rec3 = s.app.ledger.get(id(3));
  assert.equal(rec3.state, "not_sent");
  assert.equal(rec3.error, "Not sent: marked not sent by you.");
  assert.equal(rec3.resolution.kind, "not_sent");
  assert.equal(onDisk(w.files)[id(3)].state, "not_sent", "durable");
  assert.equal(w.mock.paidCalls.length, 0, "resolution never sends a paid request");
});

test("Unknown resolution: an incomplete scan never allows Mark not sent; a job id already known is read directly", async (t) => {
  const params = { prompt: "a quiet harbor at dawn", width: 1024, height: 1024, quality: "low" };
  let listFails = true;
  const w = await createWorld(t, { mockOpts: { jobsList: () => (listFails ? { status: 503, body: { message: "Service Unavailable" } } : undefined) } });
  w.files.set(`jobs/${id(1)}.json`, JSON.stringify(unknownRecord(1, params)));
  w.files.set(`jobs/${id(2)}.json`, JSON.stringify({ ...unknownRecord(2, params), state: "uncertain", job_id: "job_alarm", fingerprint: "f2b" }));
  w.mock.jobs.set("job_alarm", mockJob("job_alarm", params, 1));
  const s = await w.boot({ docs: [POSTER], active: 7, signIn: true });
  await assert.rejects(s.app.runner.markNotSent(id(1)), (e) => e.type === "CheckIncomplete" && /Check again/.test(e.message));
  assert.equal(s.app.ledger.get(id(1)).state, "uncertain");
  const view = s.app.jobsModel.resolveView(id(1));
  assert.equal(view.complete, false);
  assert.equal(view.actions.mark_not_sent.enabled, false);
  assert.match(view.note, /^Could not check Scenario's jobs/);
  listFails = false;
  const c = await s.app.runner.check(id(1));
  assert.equal(c.complete, true);
  assert.equal(c.candidates.length, 0, "the alarm's job is held by another record");
  assert.equal(s.app.jobsModel.resolveView(id(1)).note, "No job on Scenario matches this request. You can mark it not sent.");

  const c2 = await s.app.runner.check(id(2));
  assert.deepEqual(c2.candidates.map((x) => [x.job_id, x.exact, x.via]), [["job_alarm", true, "job id"]]);
  await s.app.runner.link(id(2), "job_alarm");
  const rec = await waitFor(() => s.app.ledger.get(id(2)).state === "ready" && s.app.ledger.get(id(2)), { label: "alarm job downloaded" });
  assert.equal(rec.cu_charged, "2");
});

test("Unknown resolution pages the list and stops at the page limit as incomplete", async (t) => {
  const w = await createWorld(t);
  const s = await w.boot({ docs: [POSTER], active: 7, signIn: true });
  let calls = 0;
  const client = { request: async (m, p, o) => {
    calls++;
    return { status: 200, body: { jobs: [], nextPaginationToken: `t${calls}` } };
  } };
  const ledger = { get: () => unknownRecord(1, { prompt: "x" }), findByJobId: () => null };
  const r = resolveMod.createResolver({ client, ledger });
  const c = await r.check(id(1));
  assert.equal(calls, 20);
  assert.equal(c.complete, false);
  assert.equal(r.fresh(c), true);
  s.quit();
});

test("Stop download stops the attempt and removes its part file; Resume download finishes it with the saved takes kept", async (t) => {
  const w = await createWorld(t);
  const s = await w.boot({ docs: [POSTER], active: null, signIn: true });
  s.ps.setActive(null);
  s.app.hooks.arm("download_part", { action: "delay", ms: 300 });
  const out = await startImage(s.app);
  const at = await s.app.hooks.wait("download_part");
  const row = s.app.jobsModel.row(s.app.ledger.get(out.record.local_id));
  assert.deepEqual(row.actions.map((a) => [a.name, a.enabled]), [["stop_download", true], ["details", true]]);
  await s.app.jobsModel.act(out.record.local_id, "stop_download");
  const stopped = await waitFor(() => s.app.ledger.get(out.record.local_id).state === "download_failed" && s.app.ledger.get(out.record.local_id), { label: "stopped" });
  assert.equal(stopped.error, "Download stopped: stopped by you. Resume download fetches it again.");
  assert.equal(stopped.download_error_type, null);
  assert.ok(!w.files.has(at.part), "the part file is removed");
  await s.app.jobsModel.act(out.record.local_id, "resume");
  assert.equal(s.app.ledger.get(out.record.local_id).state, "ready");
  assert.equal(w.mock.paidCalls.length, 1);
});

test("Cancel while uploading: Not sent, nothing sent to generate, the upload stops", async (t) => {
  const w = await createWorld(t, { mockOpts: { answer: (m) => (m === BG ? { status: 200, body: { creativeUnitsCost: 1, creativeUnitsDiscount: 0, costDetails: {} } } : undefined) } });
  const s = await w.boot({ docs: [POSTER], active: 7, signIn: true, psOpts: { scene: true } });
  s.app.hooks.arm("upload", { action: "delay", ms: 200 });
  const p = await s.app.flow.price({ tool: "remove_background" });
  const running = s.app.flow.generate({ tool: "remove_background" }, p.quote);
  const at = await s.app.hooks.wait("upload");
  assert.deepEqual(s.app.jobsModel.row(s.app.ledger.get(at.local_id)).actions.map((a) => a.name), ["cancel_upload"]);
  await s.app.jobsModel.act(at.local_id, "cancel_upload");
  const out = await running;
  assert.equal(out.state, "not_sent");
  assert.equal(s.app.ledger.get(at.local_id).error, "Not sent: Canceled while uploading.");
  await sleep(100);
  assert.equal(w.mock.paidCalls.length, 0);
  assert.equal(s.app.ledger.get(at.local_id).state, "not_sent");
});

test("ledger: records read from disk are checked; a result path outside the Output Folder is dropped; unreadable records are skipped", async () => {
  const files = new Map();
  const base = { revision: 1, origin: { kind: "person" }, lane: "image", created_at: "2026-10-19T08:00:00.000Z" };
  files.set(`jobs/${id(1)}.json`, JSON.stringify({ ...base, local_id: id(1), state: "ready", outputs: [{ asset_id: "asset_a", state: "saved", path: "../../outside.png" }] }));
  files.set(`jobs/${id(2)}.json`, JSON.stringify({ ...base, local_id: id(2), state: "exploded" }));
  files.set(`jobs/${id(3)}.json`, JSON.stringify({ ...base, local_id: id(3), state: "generating", job_id: null }));
  files.set(`jobs/${id(4)}.json`, "{ not json");
  const ps = createFakePhotoshop({ files });
  const host = hostMod.createHost(ps.require, { setTimeout, clearTimeout });
  const ledger = ledgerMod.createLedger({ host, random: { bytes: (n) => new Uint8Array(n) }, log: () => {} });
  await ledger.load();
  assert.deepEqual(ledger.all().map((r) => r.local_id).sort(), [id(1), id(3)]);
  assert.deepEqual(ledger.get(id(1)).outputs[0], { asset_id: "asset_a", state: "pending", path: null });
  assert.equal(ledger.get(id(3)).state, "uncertain", "a running job without a job id may exist: Unknown");
  assert.match(ledger.get(id(3)).error, /job id was not saved/);
});

test("ledger: each restart transition is logged by a short id; a record recovered once is not written again at later launches", async () => {
  const files = new Map();
  const base = { revision: 1, origin: { kind: "person" }, lane: "image", created_at: "2026-10-19T08:00:00.000Z" };
  files.set(`jobs/${id(5)}.json`, JSON.stringify({ ...base, local_id: id(5), state: "submitting" }));
  files.set(`jobs/${id(6)}.json`, JSON.stringify({ ...base, local_id: id(6), state: "generating", job_id: "job_x" }));
  files.set(`jobs/${id(7)}.json`, JSON.stringify({ ...base, local_id: id(7), state: "applied", recovered_from: "generating", recovered_at: "2026-10-19T08:05:00.000Z" }));
  const ps = createFakePhotoshop({ files });
  const host = hostMod.createHost(ps.require, { setTimeout, clearTimeout });
  const lines = [];
  const ledger = ledgerMod.createLedger({ host, random: { bytes: (n) => new Uint8Array(n) }, log: (l) => lines.push(l) });
  await ledger.load();
  assert.ok(lines.includes(`jobs: restart: ${id(5).slice(0, 8)} submitting -> uncertain`), lines.join("\n"));
  assert.ok(lines.includes(`jobs: restart: ${id(6).slice(0, 8)} generating, resumes`));
  assert.ok(!lines.some((l) => l.includes(id(7).slice(0, 8))), "a finished record is left alone");
  assert.equal(JSON.parse(files.get(`jobs/${id(7)}.json`)).revision, 1, "not rewritten");
  assert.ok(lines.includes("jobs: 3 record(s) read, 2 changed by the restart"));
});

test("Jobs view model: filters, header, rows with actions and reasons, Details", async (t) => {
  const w = await createWorld(t, { mockOpts: { jobPlan: () => ["in-progress", "success"] } });
  const s = await w.boot({ docs: [POSTER], active: 7, signIn: true });
  const m = s.app.jobsModel;
  assert.equal(m.list().empty, true);
  assert.match(m.list().empty_text, /On Scenario tab/);
  s.ps.setActive(null);
  const a = await startImage(s.app);
  await waitFor(() => s.app.ledger.get(a.record.local_id).state === "ready", { label: "ready" });
  w.files.set(`jobs/${id(9)}.json`, JSON.stringify({ ...unknownRecord(9, { prompt: "x" }), state: "uncertain" }));
  const agentRec = { ...unknownRecord(8, { prompt: "an agent's job" }), state: "failed", origin: { kind: "agent", client_name: "Codex" }, cu_charged: "0", refunded: true, error: "Failed: a reason" };
  w.files.set(`jobs/${id(8)}.json`, JSON.stringify(agentRec));
  s.quit();
  const two = await w.boot({ docs: [POSTER], active: 7 });
  const m2 = two.app.jobsModel;
  const all = m2.list("all");
  assert.equal(all.rows.length, 3);
  assert.deepEqual(all.counts, { all: 3, attention: 1, agents: 1, document: 1 });
  assert.deepEqual(m2.list("agents").rows.map((r) => r.origin), ["Codex"]);
  assert.deepEqual(m2.list("attention").rows.map((r) => r.status), ["Unknown"]);
  const ready = m2.list("document").rows[0];
  assert.equal(ready.title, 'Image "quiet-harbor-dawn"');
  assert.equal(ready.status, "results saved");
  assert.equal(ready.tone, "done");
  assert.equal(ready.price, "quoted 2, charged 2 CU");
  assert.equal(ready.origin, "You");
  assert.match(ready.time, /^\d\d:\d\d$/);
  assert.match(ready.thumbnail, /^Scenario\/image\/\d{8}\/.+\.png$/);
  assert.equal(all.document.charged, "2");
  const h = m2.header();
  assert.equal(h.waiting, 1);
  assert.equal(h.badge, 1);
  assert.equal(h.tooltip, "Jobs: 1 waiting for you, 1 ready to place");
  const d = m2.details(ready.local_id);
  assert.equal(d.job_id, "job_mock1");
  assert.equal(d.prompt, "a quiet harbor at dawn");
  assert.equal(d.outputs.length, 1);
  assert.equal(await m2.act(id(8), "copy_error"), "Failed: a reason", "the error goes to the clipboard");
  assert.equal(two.ps.history.length, 0);
});

test("development test hooks: hold, delay, value and wait; a release build carries a stub", async () => {
  const h = hooksMod.create({});
  h.arm("poll", { action: "delay", ms: 10, skip: 1 });
  await h.at("poll", { n: 1 });
  const t0 = Date.now();
  await h.at("poll", { n: 2 });
  assert.ok(Date.now() - t0 >= 8);
  assert.deepEqual(await h.wait("poll"), { n: 2 });
  await h.at("poll", {});
  h.arm("price_after_upload", { add: 1000 });
  assert.equal(h.value("price_after_upload", 2000, {}), 3000);
  assert.equal(h.value("price_after_upload", 2000, {}), 2000, "fires once");
  const release = bundle({ dev: false }).code;
  const dev = bundle({ dev: true }).code;
  assert.ok(!release.includes("dev hook:"), "the hooks are stubbed out of release builds");
  assert.ok(release.includes("active: false"));
  assert.ok(dev.includes("dev hook:"));
});
