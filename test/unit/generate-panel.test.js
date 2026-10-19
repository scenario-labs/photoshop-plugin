"use strict";
// M3, the Image lane end to end in the panel: the plugin source on the real
// host adapter over the fake Photoshop modules, against the fixture mock with
// paid generation on. Generate at the price shown, one paid call with no
// price-check flag, polling, the download through the CDN's redirect with no
// key, placement as an embedded smart object in one History state, the XMP
// packet, the ledger, the tray, the confirm limit, references, Unknown jobs
// and the restart transitions.

const test = require("node:test");
const assert = require("node:assert/strict");
const lanesMod = require("../../plugin/src/ui/lanes.js");
const jobsText = require("../../plugin/src/ui/jobs-text.js");
const xmp = require("../../plugin/src/util/xmp.js");
const main = require("../../plugin/src/main.js");
const { bootGenerate, ledgerFiles, FLARE } = require("../helpers/generate-sim.js");
const { waitFor, sleep } = require("../helpers/fakes.js");

const T = lanesMod.TEXT;
const POSTER = { id: 7, title: "poster.psd", width: 1024, height: 1024 };
const button = (doc) => doc.text("generate");
async function priced(doc, label) {
  await waitFor(() => button(doc) === label, { label: `button reads ${label}`, timeout: 4000 });
}
// After a change: waits for a new quote (the old label may still show
// until the debounced price check starts).
function quoteId(app) {
  const p = app.lanes.state().price;
  return p && p.quote ? p.quote.quote_id : null;
}
async function repriced(app, doc, label, old) {
  await waitFor(() => app.lanes.state().price.state === "ready" && quoteId(app) !== old && button(doc) === label, { label: `a new price, ${label}`, timeout: 6000 });
}
async function trayReads(doc, text) {
  await waitFor(() => doc.text("tray-status") === text, { label: `tray reads ${text}`, timeout: 6000 });
}

// A Jobs row: [picture, [head: [title, status], meta, detail?, actions?]].
function rowActions(row) {
  const main = row.children[1];
  const last = main.children[main.children.length - 1];
  return last && last.getAttribute("class") === "actions" ? last.children : [];
}
const enabled = (doc, id) => doc.byId(id).getAttribute("disabled") === null;

test("Image lane end to end: one paid call at the shown price, no price-check flag, CDN without the key, one History state, XMP and the ledger", async (t) => {
  const { app, doc, mock, ps, pair } = await bootGenerate(t, { docs: [POSTER], active: 7 });
  assert.ok(doc.shown("ready-banner"), "first run: the ready banner");
  ps.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
  assert.ok(enabled(doc, "generate"));
  assert.equal(mock.paidCalls.length, 0, "nothing paid before the click");

  doc.byId("generate").click();
  await trayReads(doc, "Placed: 1 take");
  assert.ok(!doc.shown("ready-banner"), "the ready banner goes at the first Generate");
  assert.ok(doc.shown("meta-banner"), "the metadata note after the first placed result");
  assert.equal(doc.text("meta-banner-text"), jobsText.TEXT.meta_banner);

  // The paid request: once, no query string, no flag in the body, the key in the header.
  assert.equal(mock.paidCalls.length, 1);
  const paidReq = mock.requests.filter((r) => r.method === "POST" && r.path === `/v1/generate/custom/${FLARE}` && r.search === "");
  assert.equal(paidReq.length, 1);
  assert.deepEqual(paidReq[0].body, { prompt: T.sample_prompt, quality: "low", width: 1024, height: 1024, numOutputs: 1 });
  for (const k of Object.keys(paidReq[0].body)) assert.notEqual(k.toLowerCase(), "dryrun");
  assert.ok(paidReq[0].authorization.startsWith("Basic "));
  for (const r of mock.requests.filter((x) => x.path.startsWith("/v1/generate") && x.search !== "")) assert.equal(r.search, "?dryRun=true");
  assert.deepEqual(mock.violations, []);
  assert.ok(mock.requests.some((r) => r.path === "/v1/jobs/job_mock1"), "polled");

  // The CDN: the measured 302, then the file; never the Authorization header.
  assert.equal(mock.cdnRequests.length, 2);
  for (const r of mock.cdnRequests) assert.equal(r.authorization, null);

  // Placement: one History state, an embedded smart object covering the canvas.
  assert.deepEqual(ps.history, [{ document_id: 7, name: "Scenario: Place image" }]);
  assert.deepEqual(ps.rolledBack, []);
  const d = ps.doc(7);
  const layer = d.layers[0];
  assert.equal(layer.kind, "smartObject");
  const rec = app.ledger.all()[0];
  const assetId = rec.outputs[0].asset_id;
  assert.equal(layer.name, `Scenario image lighthouse-rocky-coast ${assetId.slice(-6)}`);
  assert.deepEqual(layer.frame, { left: 0, top: 0, width: 1024, height: 1024 });
  assert.equal(d.layers[1].name, "Background");
  assert.equal(d.activeLayers[0].name, "Background", "Place when ready gives the person's active layer back");

  // The XMP packet (schema 1).
  const meta = xmp.parse(layer.xmp);
  assert.equal(meta.schema, "1");
  assert.equal(meta.assetId, assetId);
  assert.equal(meta.jobId, "job_mock1");
  assert.equal(meta.modelId, FLARE);
  assert.equal(meta.modelName, "GPT Image 2.5 Flare");
  assert.equal(meta.prompt, T.sample_prompt);
  assert.equal(meta.cuQuoted, "2");
  assert.equal(meta.cuCharged, "2");
  assert.equal(meta.kind, "image");
  assert.equal(meta.take, "1");
  assert.equal(meta.captureBox, "0,0,1024,1024");
  assert.equal(meta.origin, "person");
  assert.equal(meta.pluginVersion, main.VERSION);
  assert.deepEqual(JSON.parse(meta.parameters), { height: 1024, numOutputs: 1, prompt: T.sample_prompt, quality: "low", width: 1024 });

  // The ledger on disk.
  const files = ledgerFiles(ps);
  assert.equal(files.length, 1);
  const r = files[0];
  assert.equal(r.state, "applied");
  assert.equal(r.idempotency_key, rec.idempotency_key);
  assert.match(r.idempotency_key, /^quote_[0-9a-f]{24}$/);
  assert.equal(r.job_id, "job_mock1");
  assert.equal(r.cu_quoted, "2");
  assert.equal(r.cu_charged, "2");
  assert.equal(r.refunded, false);
  assert.equal(r.target.document_title, "poster.psd");
  assert.equal(r.placement.history, "Scenario: Place image");
  assert.match(r.outputs[0].path, /^Scenario\/image\/\d{8}\/\d{4}-\d{2}-\d{2}-lighthouse-rocky-coast-[A-Za-z0-9]{6}\.png$/);
  assert.ok(ps.binary(r.outputs[0].path) instanceof Uint8Array, "the result file is saved");
  assert.ok(![...ps.files.keys()].some((k) => k.endsWith(".part") || k.endsWith(".tmp")), "no part or temporary file left");
  const disk = [...ps.files.values()].map((v) => (typeof v === "string" ? v : "")).join("\n");
  for (const secret of [pair.key, pair.secret]) assert.ok(!disk.includes(secret), "a credential reached the data folder");
  assert.ok(!(ps.files.get("scenario-link.log") || "").includes(T.sample_prompt), "prompts are never logged");
  assert.ok(!disk.includes("Signature="), "signed links are never stored");

  // The tray: the take's picture from the saved file, marked as the visible layer; the header's Jobs icon has no badge.
  assert.equal(doc.text("tray-detail"), "GPT Image 2.5 Flare · quoted 2, charged 2 CU");
  const take = doc.byId("tray-takes").children[0];
  assert.equal(take.className, "take kept");
  assert.equal(take.children.find((c) => c.tagName === "IMG").getAttribute("src"), "plugin-data:/" + r.outputs[0].path);
  assert.equal(doc.text("jobs-badge"), "");
  assert.equal(doc.byId("jobs").getAttribute("title"), "Jobs");
  assert.match(app.diagnostics.text(), /jobs: applied 1/);
});

test("two takes land as a group, take 1 on top and visible, each with its own packet; Open as document makes a new document", async (t) => {
  const { app, doc, ps, mock } = await bootGenerate(t, { docs: [{ ...POSTER, width: 2048, height: 1024 }], active: 7 });
  ps.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Price unavailable");
  assert.equal(doc.byId("size-select").value, "2048x1152", "the preset nearest the 2:1 canvas; the mock has no measured answer for it");
  doc.byId("size-select").value = "1024x1024";
  doc.byId("size-select").dispatch("change");
  await priced(doc, "Generate (2 CU)");
  doc.byId("takes-select").value = "2";
  doc.byId("takes-select").dispatch("change");
  await priced(doc, "Generate (3 CU)");
  doc.byId("generate").click();
  await trayReads(doc, "Placed: 2 takes");
  assert.equal(mock.paidCalls[0].body.numOutputs, 2);
  const d = ps.doc(7);
  const group = d.layers[0];
  assert.equal(group.kind, "group");
  assert.equal(group.name, "Scenario image lighthouse-rocky-coast (2 takes)");
  const rec = app.ledger.all()[0];
  const ids = rec.outputs.map((o) => o.asset_id);
  assert.deepEqual(group.layers.map((l) => [l.name, l.visible]), [
    [`Take 1 ${ids[0].slice(-6)}`, true],
    [`Take 2 ${ids[1].slice(-6)}`, false]
  ]);
  // Cover fit of a 1024 square result on the 2048 x 1024 canvas.
  assert.deepEqual(group.layers[0].frame, { left: 0, top: -512, width: 2048, height: 2048 });
  assert.equal(xmp.parse(group.layers[1].xmp).take, "2");
  assert.equal(xmp.parse(group.layers[1].xmp).assetId, ids[1]);
  assert.equal(xmp.parse(group.xmp).assetId, undefined, "the group packet names no single take");
  assert.equal(xmp.parse(group.xmp).jobId, "job_mock1");
  assert.deepEqual(ps.history, [{ document_id: 7, name: "Scenario: Place image" }]);
  assert.match(rec.outputs[1].path, /-take2\.png$/);

  doc.byId("tray-open").click();
  await waitFor(() => ps.app.documents.length === 2, { label: "a new document" });
  const nd = ps.app.documents[1];
  assert.equal(nd.width, 1024);
  assert.equal(nd.height, 1024);
  assert.equal(nd.profile, "sRGB IEC61966-2.1");
  assert.equal(nd.layers[0].name, "Scenario image lighthouse-rocky-coast (2 takes)");
  assert.equal(ps.history.length, 2);
});

test("the confirm limit: above 100 CU Generate asks first; Cancel sends nothing; the card's Generate sends once", async (t) => {
  const { doc, mock, ps } = await bootGenerate(t, {
    docs: [POSTER],
    active: 7,
    mockOpts: { answer: (model) => (model === FLARE ? { status: 269, body: { creativeUnitsCost: 150, creativeUnitsDiscount: 0, costDetails: { "custom-generation": 150 } } } : null), charge: () => 150 }
  });
  ps.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (150 CU)");
  doc.byId("generate").click();
  assert.ok(doc.shown("confirm-card"));
  assert.equal(doc.text("confirm-text"), "This generation costs 150 CU, above your confirm limit of 100 CU.");
  assert.equal(doc.text("confirm-ok"), "Generate (150 CU)");
  assert.ok(!enabled(doc, "generate"), "the button waits for the card");
  doc.byId("confirm-cancel").click();
  assert.ok(!doc.shown("confirm-card"));
  await sleep(100);
  assert.equal(mock.paidCalls.length, 0, "Cancel sends nothing");
  doc.byId("generate").click();
  doc.byId("confirm-ok").click();
  await trayReads(doc, "Placed: 1 take");
  assert.equal(mock.paidCalls.length, 1);
});

test("a selection: the result covers the selection's box and lands masked to it", async (t) => {
  const { doc, ps, app } = await bootGenerate(t, { docs: [{ ...POSTER, selection: { left: 100, top: 200, width: 512, height: 512 } }], active: 7 });
  ps.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
  assert.equal(doc.text("lane-source"), "Selection 512 \u00d7 512");
  assert.equal(doc.byId("target-icon").getAttribute("data-icon"), "selection");
  assert.equal(doc.byId("target-chip").getAttribute("title"), T.selection_note, "the chip's tooltip says it lands masked");
  doc.byId("generate").click();
  await trayReads(doc, "Placed: 1 take");
  const layer = ps.doc(7).layers[0];
  assert.deepEqual(layer.frame, { left: 100, top: 200, width: 512, height: 512 });
  assert.deepEqual(layer.mask, { width: 512, height: 512, left: 100, top: 200 });
  assert.equal(xmp.parse(layer.xmp).captureBox, "100,200,512,512");
  assert.deepEqual(app.ledger.all()[0].target.box, [100, 200, 512, 512]);

  // The selection changes: the panel prices again before the next click.
  const checks = () => ps.played.length;
  const before = checks();
  ps.doc(7).selection = { left: 0, top: 0, width: 300, height: 600 };
  ps.fire("set");
  await waitFor(() => doc.text("lane-source") === "Selection 300 \u00d7 600", { label: "new selection" });
  assert.ok(checks() > before);
});

test("references: a capture reduced to fit 4 MB shows Input reduced; it uploads at Generate as JPEG; a different price after upload waits for approval", async (t) => {
  let afterUpload = 5;
  const { doc, ps, mock, app } = await bootGenerate(t, {
    docs: [{ ...POSTER, width: 4096, height: 4096, pattern: "noise" }],
    active: 7,
    psOpts: { jpegBytesPerPixel: 1.5 },
    mockOpts: {
      answer: (model, body) => {
        if (model !== FLARE || !body.referenceImages) return null;
        return { status: 269, body: { creativeUnitsCost: afterUpload, creativeUnitsDiscount: 0, costDetails: { "custom-generation": afterUpload } } };
      }
    }
  });
  ps.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
  assert.ok(doc.shown("refs-section"));
  assert.equal(doc.text("refs-title"), "References");
  assert.equal(doc.text("refs-count"), "Up to 10");
  const first = quoteId(app);
  // One "+" opens the sources menu; choosing a source closes it.
  const tile = () => doc.byId("refs-list").children.at(-1);
  assert.equal(tile().getAttribute("id"), "refs-add");
  assert.ok(!doc.shown("refs-menu"));
  tile().click();
  assert.ok(doc.shown("refs-menu"));
  doc.byId("refs-add-visible").click();
  assert.ok(!doc.shown("refs-menu"));
  const chip = () => doc.byId("refs-list").children[0];
  await waitFor(() => chip().className === "ref", { label: "reference added", timeout: 8000 });
  assert.equal(chip().getAttribute("title"), "All visible, sent at 1492 \u00d7 1492. Input reduced to fit the model.");
  assert.ok(chip().children.some((c) => c.className === "ref-badge"));
  assert.match(chip().children.find((c) => c.tagName === "IMG").getAttribute("src"), /^blob:/, "the chip shows the captured picture");
  assert.equal(doc.text("refs-count"), "1 of 10");
  assert.deepEqual(ps.reads.map((r) => r.width), [2048, 1843, 1658, 1492], "read again 10% smaller until it fits");
  assert.equal(mock.uploads.length, 0, "nothing uploads before Generate");
  await repriced(app, doc, "Generate (2 CU)", first);

  doc.byId("generate").click();
  await waitFor(() => doc.shown("confirm-card"), { label: "the price-changed card" });
  assert.equal(doc.text("confirm-text"), "Price changed after upload. Now 5 CU (was 2 CU). Nothing was spent.");
  assert.equal(mock.paidCalls.length, 0);
  assert.equal(mock.uploads.length, 1);
  assert.equal(mock.uploads[0].mime, "image/jpeg");
  assert.ok(mock.uploads[0].bytes < 4000000);
  assert.match(mock.uploads[0].name, /^photoshop-reference-\d{8}-[0-9a-z]+\.jpg$/);
  assert.equal(app.ledger.all()[0].state, "awaiting_approval");
  assert.match(doc.text("tray-status"), /Price changed after upload/);

  doc.byId("confirm-ok").click();
  await trayReads(doc, "Placed: 1 take");
  assert.equal(mock.paidCalls.length, 1);
  assert.deepEqual(mock.paidCalls[0].body.referenceImages, [mock.uploads[0].id]);
  const rec = app.ledger.all()[0];
  assert.equal(rec.cu_quoted, "5");
  assert.equal(rec.inputs.references[0].reduced, true);
  assert.match(doc.text("tray-badges"), /Input reduced \(1492 x 1492\)/);
  assert.equal(xmp.parse(ps.doc(7).layers[0].xmp).inputAssetIds, mock.uploads[0].id);
});

test("a declined price change sends nothing; the uploaded reference stays on Scenario only", async (t) => {
  const { doc, ps, mock, app } = await bootGenerate(t, {
    docs: [POSTER],
    active: 7,
    mockOpts: { answer: (model, body) => (model === FLARE && body.referenceImages ? { status: 269, body: { creativeUnitsCost: 4, creativeUnitsDiscount: 0, costDetails: {} } } : null) }
  });
  ps.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
  const first = quoteId(app);
  doc.byId("refs-add-layer").click();
  await waitFor(() => String(doc.byId("refs-list").children[0].getAttribute("title")).startsWith('Layer "Background", sent at 1024 \u00d7 1024'), { label: "layer reference" });
  await repriced(app, doc, "Generate (2 CU)", first);
  doc.byId("generate").click();
  await waitFor(() => doc.shown("confirm-card"), { label: "the price-changed card" });
  doc.byId("confirm-cancel").click();
  await waitFor(() => app.ledger.all()[0].state === "not_sent", { label: "declined" });
  assert.equal(app.ledger.all()[0].error, "Not sent: Declined.");
  assert.equal(app.ledger.all()[0].cu_charged, "0");
  assert.equal(mock.paidCalls.length, 0);
});

test("an answer that may hide a job is Unknown: never retried, blocks the same request until marked not sent in Jobs", async (t) => {
  let fail = true;
  const { doc, ps, mock, app } = await bootGenerate(t, {
    docs: [POSTER],
    active: 7,
    mockOpts: { paid: () => (fail ? { status: 503, body: { message: "Service Unavailable" } } : undefined) }
  });
  ps.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
  doc.byId("generate").click();
  await waitFor(() => app.ledger.all()[0] && app.ledger.all()[0].state === "uncertain", { label: "Unknown" });
  assert.equal(mock.paidCalls.length, 1, "a 503 on the paid call is never retried");
  assert.equal(doc.text("tray-detail"), jobsText.TEXT.unknown_help);
  // The header's Jobs icon: a badge in the warning color, the words in its tooltip.
  assert.equal(doc.text("jobs-badge"), "1");
  assert.equal(doc.byId("jobs-badge").className, "badge attention");
  assert.equal(doc.byId("jobs").getAttribute("title"), "Jobs: 1 waiting for you");

  await repriced(app, doc, "Generate (2 CU)", app.ledger.all()[0].idempotency_key);
  doc.byId("generate").click();
  await waitFor(() => doc.text("generate-note") === "A matching request may already be running. Resolve it in Jobs first.", { label: "in flight" });
  assert.equal(mock.paidCalls.length, 1);

  doc.byId("jobs").click();
  assert.ok(doc.shown("view-jobs"));
  const row = () => doc.byId("jobs-list").children[0];
  const action = (name) => rowActions(row()).find((b) => b.getAttribute("data-action") === name);
  const head = row().children[1].children[0];
  assert.equal(head.children[0].textContent, 'Image "lighthouse-rocky-coast"');
  assert.equal(head.children[1].textContent, "Unknown");
  assert.equal(head.children[1].className, "job-status attention");
  action("mark_not_sent").click();
  assert.equal(doc.text("jobs-note"), jobsText.TEXT.mark_confirm);
  assert.equal(app.ledger.all()[0].state, "uncertain", "one click only arms it");
  action("mark_not_sent").click();
  await waitFor(() => app.ledger.all()[0].state === "not_sent", { label: "marked not sent" });
  doc.byId("jobs-back").click();

  fail = false;
  const before = quoteId(app);
  doc.type("prompt", "A lighthouse on a rocky coast at dusk");
  await repriced(app, doc, "Generate (2 CU)", before);
  doc.byId("generate").click();
  await trayReads(doc, "Placed: 1 take");
  assert.equal(mock.paidCalls.length, 2);
});

test("402 and 429 are not sent: nothing charged, and a 429 pauses Generate for Retry-After", async (t) => {
  let answer = { status: 402, body: { message: "Payment Required" } };
  const { doc, ps, mock, app } = await bootGenerate(t, { docs: [POSTER], active: 7, mockOpts: { paid: () => answer } });
  ps.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
  doc.byId("generate").click();
  await waitFor(() => doc.text("generate-note") === "Not enough CU for this job. Nothing was sent.", { label: "402" });
  assert.equal(app.ledger.all()[0].state, "not_sent");
  assert.equal(app.ledger.all()[0].cu_charged, "0");
  assert.equal(jobsText.tray(app.ledger.all()[0]).detail, "GPT Image 2.5 Flare · Nothing charged");

  answer = { status: 429, body: { message: "Too Many Requests" }, headers: { "retry-after": "30" } };
  await repriced(app, doc, "Generate (2 CU)", app.ledger.all()[0].idempotency_key);
  doc.byId("generate").click();
  await waitFor(() => /^Not sent: Scenario asked to wait (29|30) s\.$/.test(doc.text("generate-reason")), { label: "paused" });
  assert.ok(!enabled(doc, "generate"));
  assert.equal(mock.paidCalls.length, 2);
  assert.equal(app.runner.pausedFor() > 0, true);
});

test("a failed job is refunded and shows Scenario's hint", async (t) => {
  const { doc, ps, app } = await bootGenerate(t, { docs: [POSTER], active: 7, mockOpts: { jobPlan: () => ["in-progress", "failure"] } });
  ps.entrypoints.panels.scenarioPanel.show();
  await priced(doc, "Generate (2 CU)");
  doc.byId("generate").click();
  await waitFor(() => app.ledger.all()[0] && app.ledger.all()[0].state === "failed", { label: "failed" });
  const rec = app.ledger.all()[0];
  assert.equal(rec.cu_charged, "0");
  assert.equal(rec.refunded, true);
  assert.match(rec.error, /^Failed: Ensure that both width and height/);
  assert.equal(jobsText.tray(rec).detail, "GPT Image 2.5 Flare · Refunded by Scenario");
});

test("restart: submitting becomes Unknown, uploading becomes not sent, a queued job resumes polling and waits in Jobs to be placed", async (t) => {
  const id = (n) => `0000000${n}-0000-4000-8000-000000000000`;
  const base = { origin: { kind: "person" }, lane: "image", model_id: FLARE, model_name: "GPT Image 2.5 Flare", parameters: { prompt: "a quiet harbor", width: 1024, height: 1024, quality: "low", numOutputs: 1 }, inputs: { references: [], asset_ids: [] }, target: { kind: "canvas", document_id: 7, document_title: "poster.psd", box: [0, 0, 1024, 1024], session: "previous" }, session: "previous", cu_quoted: "2", outputs: [], revision: 3, created_at: "2026-10-19T08:00:00.000Z" };
  const files = new Map([
    [`jobs/${id(1)}.json`, JSON.stringify({ ...base, local_id: id(1), state: "submitting", idempotency_key: "quote_a", fingerprint: "a" })],
    [`jobs/${id(2)}.json`, JSON.stringify({ ...base, local_id: id(2), state: "uploading_inputs", idempotency_key: "quote_b", fingerprint: "b" })],
    [`jobs/${id(3)}.json`, JSON.stringify({ ...base, local_id: id(3), state: "queued", job_id: "job_mock1", idempotency_key: "quote_c", fingerprint: "c", submitted_at: "2026-10-19T08:00:01.000Z" })],
    [`jobs/${id(4)}.json.tmp`, JSON.stringify({ ...base, local_id: id(4), state: "applying", idempotency_key: "quote_d", fingerprint: "d", revision: 9 })],
    [`jobs/${id(4)}.json`, JSON.stringify({ ...base, local_id: id(4), state: "downloading", idempotency_key: "quote_d", fingerprint: "d", revision: 8 })]
  ]);
  const { app, ps, mock, doc } = await bootGenerate(t, { docs: [POSTER], active: 7, psOpts: { files } });
  // The mock knows job_mock1 once a paid call made it; this one comes from before the restart.
  mock.jobs.set("job_mock1", { id: "job_mock1", model: FLARE, body: base.parameters, polls: 0, charge: 2, plan: ["success"] });
  const get = (n) => app.ledger.get(id(n));
  assert.equal(get(1).state, "uncertain");
  assert.match(get(1).error, /^Unknown: Photoshop closed while the request was being sent/);
  assert.equal(get(2).state, "not_sent");
  assert.equal(get(2).error, "Not sent: Interrupted by a restart.");
  assert.equal(get(4).state, "ready", "the newer temporary record wins; applying goes back to ready");
  await waitFor(() => get(3).state === "ready" || get(3).state === "download_failed", { label: "resumed", timeout: 6000 });
  assert.equal(get(3).state, "ready");
  assert.equal(get(3).cu_charged, "2");
  await sleep(200);
  assert.equal(ps.history.length, 0, "nothing lands by itself after a restart");
  doc.byId("jobs").click();
  const rows = doc.byId("jobs-list").children;
  const row3 = rows.find((r) => r.getAttribute("data-job") === id(3));
  const acts = rowActions(row3).map((b) => b.getAttribute("data-action"));
  assert.deepEqual(acts, ["place", "open"]);
  rowActions(row3)[0].click();
  await waitFor(() => get(3).state === "applied", { label: "placed from Jobs" });
  assert.deepEqual(ps.history, [{ document_id: 7, name: "Scenario: Place image" }]);
  assert.equal(get(3).placement.notes.length, 1, "another session's job lands over the canvas, with a note");
});
