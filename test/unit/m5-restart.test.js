"use strict";
// M5, restart recovery (SPEC 6.4, 12.2 item 9): Photoshop quits at each of
// the six points of item 9, held there by the development test hooks, and
// the plugin starts again on the same data folder and secure storage. The
// ledger is the source of truth: each job comes back in the state SPEC 6.4
// gives it, nothing is charged twice (one paid call per job, never more),
// and no paid result is lost (it downloads and waits in Jobs, then lands in
// its own document only).

const test = require("node:test");
const assert = require("node:assert/strict");
const xmp = require("../../plugin/src/util/xmp.js");
const { createWorld, onDisk } = require("../helpers/restart-sim.js");
const { waitFor, sleep } = require("../helpers/fakes.js");

const FLARE = "model_openai-gpt-image-2-5-flare";
const BG = "model_851-labs-background-remover";
const PATH = "D:/art/poster.psd";
const POSTER = (id, extra = {}) => ({ id, title: "poster.psd", width: 1024, height: 1024, path: PATH, ...extra });

function costAnswer(cu) {
  return { status: 200, body: { creativeUnitsCost: cu, creativeUnitsDiscount: 0, costDetails: { "custom-generation": cu } } };
}

// An Image lane job on the open poster, started as the panel starts it.
async function startImage(app, docId, prompt = "a quiet harbor at dawn") {
  const req = { model_id: FLARE, lane: "image", parameters: { prompt, width: 1024, height: 1024, quality: "low" }, takes: 1, pending: {}, target: { kind: "canvas", document_id: docId, box: [0, 0, 1024, 1024] } };
  const q = await app.quotes.estimate(req);
  return { req, quote: q, started: app.runner.start({ req, quote: q, refs: [], model_name: "GPT Image 2.5 Flare", document_title: "poster.psd" }) };
}

// Remove BG on 851 Labs: the capture uploads before the paid call.
async function startCutout(app) {
  const p = await app.flow.price({ tool: "remove_background" });
  assert.equal(p.state, "ready", p.reason);
  return { quote: p.quote, started: app.flow.generate({ tool: "remove_background" }, p.quote) };
}

const only = (app) => app.ledger.all()[0];
const settle = (app, id, states, label, timeout = 6000) => waitFor(() => states.includes(app.ledger.get(id).state) && app.ledger.get(id), { label, timeout });

test("restart during upload: the job is Not sent, nothing was sent to generate, nothing charged", async (t) => {
  const w = await createWorld(t, { mockOpts: { answer: (m) => (m === BG ? costAnswer(1) : undefined) } });
  const one = await w.boot({ docs: [POSTER(7)], active: 7, signIn: true, psOpts: { scene: true } });
  one.app.hooks.arm("upload", { action: "hold" });
  startCutout(one.app);
  const at = await one.app.hooks.wait("upload");
  assert.equal(onDisk(w.files)[at.local_id].state, "uploading_inputs");
  assert.equal(w.mock.uploads.filter((u) => /^photoshop-capture-/.test(u.name)).length, 1, "the capture upload went through");
  one.quit();

  const two = await w.boot({ docs: [POSTER(21)], active: 21, psOpts: { scene: true } });
  const rec = two.app.ledger.get(at.local_id);
  assert.equal(rec.state, "not_sent");
  assert.equal(rec.error, "Not sent: Interrupted by a restart.");
  assert.equal(rec.cu_charged, "0");
  assert.equal(rec.refunded, false);
  assert.equal(rec.recovered_from, "uploading_inputs");
  assert.equal(w.mock.paidCalls.length, 0, "nothing was sent to generate");
  assert.equal(two.app.jobsModel.row(rec).price, "Nothing charged");
  // The request is no longer in flight: a new price can be spent.
  const again = await startCutout(two.app);
  const out = await again.started;
  assert.notEqual(out.state, "not_sent");
});

test("restart while sending: the job is Unknown; resolution finds the job that ran, Mark not sent is refused, Link continues it; one charge only", async (t) => {
  const w = await createWorld(t);
  const one = await w.boot({ docs: [POSTER(7)], active: 7, signIn: true });
  one.app.hooks.arm("paid_answer", { action: "hold" });
  startImage(one.app, 7);
  const at = await one.app.hooks.wait("paid_answer");
  assert.equal(onDisk(w.files)[at.local_id].state, "submitting");
  assert.equal(w.mock.paidCalls.length, 1, "Scenario created the job; its answer never reached the ledger");
  one.quit();
  // Meanwhile another job ran in the same project (the web app), with other inputs.
  w.mock.jobs.set("job_web1", { id: "job_web1", model: FLARE, body: { prompt: "a red bicycle", width: 1024, height: 1024, quality: "low" }, polls: 0, charge: 2, plan: ["success"], createdAt: new Date().toISOString() });

  const two = await w.boot({ docs: [POSTER(31)], active: 31 });
  const id = at.local_id;
  assert.equal(two.app.ledger.get(id).state, "uncertain");
  assert.match(two.app.ledger.get(id).error, /^Unknown: Photoshop closed while the request was being sent/);
  const row = two.app.jobsModel.row(two.app.ledger.get(id));
  assert.deepEqual(row.actions.map((a) => a.name), ["resolve"]);

  await assert.rejects(two.app.runner.markNotSent(id), (e) => e.type === "JobMayExist");
  assert.equal(two.app.ledger.get(id).state, "uncertain", "never written off while a matching job exists");
  const view = two.app.jobsModel.resolveView(id);
  assert.equal(view.complete, true);
  assert.equal(view.candidates.length, 2, "both jobs of the window are listed");
  assert.equal(view.selected, "job_mock1", "the one exact match is pre-selected");
  assert.deepEqual(view.candidates.map((c) => c.label), ["same inputs", "other inputs"]);
  assert.equal(view.actions.mark_not_sent.enabled, false);
  assert.ok(w.mock.requests.some((r) => r.path === "/v1/jobs" && r.query.createdAfter), "listed with createdAfter");
  assert.ok(w.mock.requests.some((r) => /^\/v1\/assets\/asset_mockText/.test(r.path)), "the prompt was read from its text asset");

  await two.app.jobsModel.act(id, "link", "job_mock1");
  const done = await settle(two.app, id, ["ready", "download_failed"], "linked job downloaded");
  assert.equal(done.state, "ready");
  assert.equal(done.job_id, "job_mock1");
  assert.equal(done.cu_charged, "2");
  assert.equal(done.resolution.kind, "linked");
  assert.equal(w.mock.paidCalls.length, 1, "never charged twice");
  await sleep(100);
  assert.equal(two.ps.history.length, 0, "nothing lands by itself after a restart");
  // Place from Jobs: its document is the saved poster, open again under a new id.
  await two.app.jobsModel.act(id, "place");
  assert.equal(two.app.ledger.get(id).state, "applied");
  assert.deepEqual(two.ps.history, [{ document_id: 31, name: "Scenario: Place image" }]);
  assert.equal(xmp.parse(two.ps.doc(31).layers[0].xmp).jobId, "job_mock1");
});

test("restart while awaiting approval: the job is Not sent and the changed price is never spent", async (t) => {
  const w = await createWorld(t, { mockOpts: { answer: (m) => (m === BG ? costAnswer(1) : undefined) } });
  const one = await w.boot({ docs: [POSTER(7)], active: 7, signIn: true, psOpts: { scene: true } });
  one.app.hooks.arm("price_after_upload", { add: 1000 });
  const s = await startCutout(one.app);
  const out = await s.started;
  assert.equal(out.state, "awaiting_approval");
  const id = out.record.local_id;
  assert.equal(onDisk(w.files)[id].cu_quoted_new, "2");
  const row = one.app.jobsModel.row(one.app.ledger.get(id));
  assert.deepEqual(row.actions.map((a) => [a.name, a.label]), [["decline", "Decline"], ["approve", "Approve (2 CU)"]]);
  one.quit();

  const two = await w.boot({ docs: [POSTER(41)], active: 41, psOpts: { scene: true } });
  const rec = two.app.ledger.get(id);
  assert.equal(rec.state, "not_sent");
  assert.equal(rec.error, "Not sent: Interrupted by a restart.");
  assert.equal(rec.cu_charged, "0");
  await assert.rejects(two.app.runner.approve(id), /not waiting for approval/);
  assert.equal(w.mock.paidCalls.length, 0);
});

test("restart while generating: polling resumes, the charge is read, the result downloads and waits in Jobs", async (t) => {
  const w = await createWorld(t, { mockOpts: { jobPlan: () => ["in-progress", "in-progress", "in-progress", "success"] } });
  const one = await w.boot({ docs: [POSTER(7)], active: 7, signIn: true });
  one.app.hooks.arm("poll", { action: "hold" });
  startImage(one.app, 7);
  const at = await one.app.hooks.wait("poll");
  const disk = onDisk(w.files)[at.local_id];
  assert.equal(disk.state, "generating");
  assert.equal(disk.job_id, "job_mock1");
  assert.equal(disk.cu_charged, null, "no charge before a final status");
  one.quit();

  const two = await w.boot({ docs: [POSTER(51)], active: 51 });
  assert.equal(two.app.ledger.get(at.local_id).recovered_from, "generating");
  const rec = await settle(two.app, at.local_id, ["ready", "download_failed"], "resumed to ready");
  assert.equal(rec.state, "ready");
  assert.equal(rec.cu_charged, "2");
  assert.equal(w.mock.paidCalls.length, 1);
  await sleep(100);
  assert.equal(two.ps.history.length, 0, "Place when ready never runs for another session's job");
  assert.ok(w.files.has(rec.outputs[0].path), "the result is saved");
  const r = two.app.jobsModel.row(rec);
  assert.deepEqual(r.actions.map((a) => [a.name, a.enabled]), [["place", true], ["open", true]]);
  assert.equal(r.place.kind, "active");
});

test("restart while downloading: the download resumes with a fresh signed link; the stale part file is replaced; one charge", async (t) => {
  const w = await createWorld(t);
  const one = await w.boot({ docs: [POSTER(7)], active: 7, signIn: true });
  one.app.hooks.arm("download_part", { action: "hold" });
  startImage(one.app, 7);
  const at = await one.app.hooks.wait("download_part");
  const id = one.app.ledger.all()[0].local_id;
  assert.equal(onDisk(w.files)[id].state, "downloading");
  assert.ok(w.files.has(at.part), "the part file is on disk");
  assert.ok(!w.files.has(at.part.replace(/\.part$/, "")), "the result was not renamed yet");
  const linksBefore = w.mock.requests.filter((r) => r.path.startsWith("/v1/assets/asset_mockJob")).length;
  one.quit();

  const two = await w.boot({ docs: [POSTER(61)], active: 61 });
  const rec = await settle(two.app, id, ["ready", "download_failed"], "download resumed");
  assert.equal(rec.state, "ready");
  assert.equal(rec.outputs[0].path, at.part.replace(/\.part$/, ""));
  assert.ok(w.files.has(rec.outputs[0].path));
  assert.ok(!w.files.has(at.part), "the part file became the result");
  const linksAfter = w.mock.requests.filter((r) => r.path.startsWith("/v1/assets/asset_mockJob")).length;
  assert.equal(linksAfter, linksBefore + 1, "a fresh signed link for the new attempt");
  assert.ok(!JSON.stringify(onDisk(w.files)[id]).includes("Signature="), "signed links are never stored");
  assert.equal(w.mock.paidCalls.length, 1);
});

test("restart while placing: back to results saved; Place is held while its document is closed or behind, then lands in that document", async (t) => {
  const w = await createWorld(t);
  const one = await w.boot({ docs: [POSTER(7)], active: 7, signIn: true });
  one.app.hooks.arm("place", { action: "hold" });
  startImage(one.app, 7);
  const at = await one.app.hooks.wait("place");
  assert.equal(onDisk(w.files)[at.local_id].state, "applying");
  assert.equal(one.ps.history.length, 0);
  one.quit();

  // Photoshop starts with another file of the same name in front.
  const two = await w.boot({ docs: [{ id: 71, title: "poster.psd", width: 1024, height: 1024, path: "D:/elsewhere/poster.psd" }], active: 71 });
  const id = at.local_id;
  await sleep(50);
  assert.equal(two.app.ledger.get(id).state, "ready", "an unfinished placement rolled back with Photoshop");
  assert.equal(two.app.ledger.get(id).recovered_from, "applying");
  let row = two.app.jobsModel.row(two.app.ledger.get(id));
  const place = row.actions.find((a) => a.name === "place");
  assert.equal(place.enabled, false);
  assert.equal(place.reason, 'Open "poster.psd" to place it there.');
  assert.ok(row.actions.some((a) => a.name === "place_current" && a.enabled));
  await assert.rejects(two.app.runner.place(id), (e) => e.type === "DocumentClosed" && /Open "poster\.psd" to place this result there/.test(e.message));
  assert.equal(two.app.ledger.get(id).state, "ready", "held");
  assert.equal(two.ps.history.length, 0, "never placed in another file with the same name");

  // The person opens the poster, then brings the other file back in front.
  const opened = two.ps.openDocument({ title: "poster.psd", width: 1024, height: 1024, path: PATH });
  two.ps.setActive(71);
  await assert.rejects(two.app.runner.place(id), (e) => e.type === "DocumentNotActive");
  row = two.app.jobsModel.row(two.app.ledger.get(id));
  assert.equal(row.actions.find((a) => a.name === "place").reason, 'Bring "poster.psd" to the front to place it there.');
  assert.equal(two.app.jobsModel.list("document").rows.length, 0, "not this document's job");

  two.ps.setActive(opened.id);
  assert.equal(two.app.jobsModel.list("document").rows.length, 1);
  await two.app.jobsModel.act(id, "place");
  const rec = two.app.ledger.get(id);
  assert.equal(rec.state, "applied");
  assert.equal(rec.placement.document_id, opened.id);
  assert.deepEqual(two.ps.history, [{ document_id: opened.id, name: "Scenario: Place image" }]);
  const layer = two.ps.doc(opened.id).layers[0];
  assert.deepEqual(layer.frame, { left: 0, top: 0, width: 1024, height: 1024 }, "at the recorded box");
  assert.equal(xmp.parse(layer.xmp).assetId, rec.outputs[0].asset_id);
  assert.equal(two.ps.doc(71).layers.length, 1, "the other file is untouched");
  assert.equal(w.mock.paidCalls.length, 1);
});

test("restart while placing, when crash recovery kept the placed layer: the job reads placed and nothing lands twice", async (t) => {
  const w = await createWorld(t);
  const one = await w.boot({ docs: [POSTER(7)], active: 7, signIn: true });
  one.app.hooks.arm("place", { action: "hold" });
  startImage(one.app, 7);
  const at = await one.app.hooks.wait("place");
  const rec0 = one.app.ledger.get(at.local_id);
  one.quit();
  const packet = xmp.build({ schema: "1", assetId: rec0.outputs[0].asset_id, jobId: rec0.job_id });
  const two = await w.boot({ docs: [POSTER(81, { layers: [{ name: "Scenario image", kind: "smartObject", xmp: packet }, { name: "Background", background: true }] })], active: 81 });
  const rec = await waitFor(() => two.app.ledger.get(at.local_id).state === "applied" && two.app.ledger.get(at.local_id), { label: "found placed" });
  assert.equal(rec.placement.document_id, 81);
  assert.match(rec.placement.notes[0], /it was not placed again/);
  assert.equal(two.ps.history.length, 0);
  assert.ok(two.ps.xmpReads > 0, "the layers' metadata was read");
});

test("restart: a saved result whose file is gone goes back to download stopped and Resume download fetches it again", async (t) => {
  const w = await createWorld(t);
  const one = await w.boot({ docs: [POSTER(7)], active: 7, signIn: true });
  one.ps.setActive(null);
  const s = await startImage(one.app, 7);
  const out = await s.started;
  const rec0 = await settle(one.app, out.record.local_id, ["ready"], "ready");
  one.quit();
  w.files.delete(rec0.outputs[0].path);
  const two = await w.boot({ docs: [POSTER(91)], active: 91 });
  const rec = await settle(two.app, rec0.local_id, ["download_failed"], "missing file noticed");
  assert.match(rec.error, /missing from the Output Folder/);
  assert.equal(rec.cu_charged, "2", "the charge stays");
  assert.deepEqual(two.app.jobsModel.row(rec).actions.map((a) => a.name), ["resume", "details", "copy_error"]);
  await two.app.jobsModel.act(rec.local_id, "resume");
  assert.equal(two.app.ledger.get(rec.local_id).state, "ready");
  assert.ok(w.files.has(two.app.ledger.get(rec.local_id).outputs[0].path));
  assert.equal(w.mock.paidCalls.length, 1);
});

test("restart: a job made under another project waits for that project's key, then continues", async (t) => {
  const w = await createWorld(t, { projects: [{ name: "Other project", id: "project_other2" }], mockOpts: { jobPlan: () => ["in-progress", "in-progress", "success"] } });
  const one = await w.boot({ docs: [POSTER(7)], active: 7, signIn: true });
  one.app.hooks.arm("poll", { action: "hold" });
  startImage(one.app, 7);
  const at = await one.app.hooks.wait("poll");
  // The person switches to another project's key before quitting.
  await one.app.auth.saveAndTest(w.extra[0].key, w.extra[0].secret);
  assert.equal(one.app.accounts.current().project_name, "Other project");
  one.quit();

  const two = await w.boot({ docs: [POSTER(101)], active: 101 });
  await sleep(150);
  const id = at.local_id;
  assert.equal(two.app.ledger.get(id).state, "generating", "not read with another project's key");
  assert.match(two.app.runner.waitingFor(id), /Waiting for its project "Restart project"/);
  assert.equal(two.app.jobsModel.row(two.app.ledger.get(id)).detail, two.app.runner.waitingFor(id));
  await two.app.auth.saveAndTest(w.pair.key, w.pair.secret);
  const rec = await settle(two.app, id, ["ready"], "continued under its project");
  assert.equal(rec.cu_charged, "2");
  assert.equal(two.app.runner.waitingFor(id), null);
});
