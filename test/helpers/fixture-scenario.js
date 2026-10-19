"use strict";
// A mock of Scenario's REST API that answers from the M2.0 measurements
// (test/fixtures/m2.0, scrubbed raw responses of 2026-10-19):
// - GET /v1/models?privacy=public pages through the catalog rows;
//   GET /v1/models (the project's models) answers `project` rows;
// - GET /v1/models/{id} answers the recorded model records;
// - POST /v1/assets reads the PNG's size from its header and returns a new
//   asset id, in the measured answer shape;
// - POST /v1/generate/custom/{id} answers a recorded dry run when the request
//   matches one: same model, same body, with the prompt text ignored and each
//   asset id compared by the size of its image. Any other request to
//   /generate, and any query string other than the price-check flag, is
//   recorded as a violation and answered 500, so a test sees it.
// - With opts.paid, POST /v1/generate/custom/{id} with no query string is the
//   paid request: recorded in `paidCalls` and answered like the measured
//   submit (test/fixtures/m2.0/jobs.json), or by opts.paid(call) when it
//   returns an answer. GET /v1/jobs/{id} then walks the job through
//   opts.jobPlan(job) (default: in-progress, then success), GET
//   /v1/assets/{id} gives each result a signed-looking CDN link, and the CDN
//   (same server, no /v1 prefix) answers 302 to itself, then the PNG, as
//   measured. CDN requests are recorded in `cdnRequests`.
// - GET /v1/jobs lists the jobs newest first, as measured (150, 151):
//   `createdAfter`, `pageSize` and `paginationToken` in, `jobs` and
//   `nextPaginationToken` out, model jobs with jobType `custom`, the prompt
//   replaced by a text asset id that GET /v1/assets/{id} answers with the
//   text in metadata.preview (153). opts.jobsList(request) can answer
//   instead (errors); `mock.jobs` rows without `createdAt` read as now.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { startMockScenario } = require("./mock-scenario.js");
const jpeg = require("../../plugin/src/util/jpeg.js");

const DIR = path.resolve(__dirname, "..", "fixtures", "m2.0");
const measured = JSON.parse(fs.readFileSync(path.join(DIR, "measured.json"), "utf8"));
const catalogRows = JSON.parse(fs.readFileSync(path.join(DIR, "catalog-public.json"), "utf8")).models;
const jobsFixture = JSON.parse(fs.readFileSync(path.join(DIR, "jobs.json"), "utf8"));
const records = {};
for (const f of fs.readdirSync(path.join(DIR, "models"))) {
  const rec = JSON.parse(fs.readFileSync(path.join(DIR, "models", f), "utf8")).model;
  records[rec.id] = rec;
}

function pngSize(b64) {
  const buf = Buffer.from(String(b64), "base64");
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length, mime: "image/png" };
}

// The size of an uploaded PNG or JPEG (base64), or null.
function imageSize(b64) {
  const p = pngSize(b64);
  if (p) return p;
  const buf = Buffer.from(String(b64), "base64");
  if (!jpeg.isJpeg(buf)) return null;
  try {
    const j = jpeg.jpegInfo(buf);
    return { width: j.width, height: j.height, bytes: buf.length, mime: "image/jpeg" };
  } catch {
    return null;
  }
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

// A solid-colour RGB PNG made with Node's zlib: a result the CDN serves.
function solidPng(w, h, rgb = [40, 90, 160]) {
  const row = Buffer.alloc(1 + 3 * w);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + 3 * x);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// opts: { accounts, pageSize (the mock's page size, to test paging),
//         project: [rows of the project's own models], extraRecords,
//         answer(model, body) (a price-check answer instead of the table),
//         paid (true, or (call) -> answer | undefined), jobPlan(job) ->
//         [remote statuses], charge(body) -> CU, cdnBase (the origin the
//         asset links name; the mock's own by default), cdn(request) ->
//         answer | undefined, resultSize(body) -> {width, height},
//         jobsList(request) -> answer | undefined, jobRead(request, job) ->
//         answer | undefined (a status read's answer), assetRead(request,
//         id) -> answer | undefined }
async function startFixtureScenario(opts = {}) {
  const assets = new Map(Object.entries(measured.assets).map(([id, a]) => [id, { width: a.width, height: a.height }]));
  const uploads = [];
  const priceChecks = [];
  const violations = [];
  const paidCalls = [];
  const jobs = new Map();
  const results = new Map();
  const cdnRequests = [];
  const recs = { ...records, ...(opts.extraRecords || {}) };
  let n = 0;
  let jobN = 0;
  const texts = new Map();
  const textIds = new Map();
  const textId = (text) => {
    if (!textIds.has(text)) {
      const id = `asset_mockText${textIds.size + 1}`;
      textIds.set(text, id);
      texts.set(id, text);
    }
    return textIds.get(text);
  };
  let mockOrigin = null;
  const copy = (v) => JSON.parse(JSON.stringify(v));

  function jobBody(job) {
    const status = job.plan[Math.min(job.polls, job.plan.length - 1)];
    const tpl = copy(status === "failure" ? jobsFixture.final_failure.body.job : jobsFixture.final_image.body.job);
    tpl.jobId = job.id;
    tpl.status = status;
    tpl.progress = status === "success" || status === "failure" ? 1 : status === "in-progress" ? 0.5 : 0;
    tpl.billing = { cuCost: job.charge, cuDiscount: 0 };
    if (job.disableRefund) tpl.billing.disableRefund = true;
    if (job.error && status === "failure") tpl.metadata.error = job.error;
    if (job.hint !== undefined && status === "failure") tpl.metadata.hint = job.hint;
    tpl.metadata.input = { modelId: job.model, ...job.body };
    if (status === "success") {
      if (!job.assets) {
        const size = opts.resultSize ? opts.resultSize(job.body) : { width: Number(job.body.width) || 1024, height: Number(job.body.height) || 1024 };
        job.assets = Array.from({ length: Number(job.body.numOutputs) || 1 }, (_, i) => {
          const id = `asset_mockJob${job.id.slice(8)}Take${i + 1}`;
          results.set(id, { ...size, job: job.id });
          return id;
        });
      }
      tpl.metadata.assetIds = job.assets;
    } else if (status !== "failure") tpl.metadata.assetIds = [];
    return { job: tpl };
  }

  // A row of GET /v1/jobs: the record with jobType, createdAt, and the
  // prompt as its text asset id (measured: processed jobs list it so).
  function jobRow(job) {
    const status = job.plan[Math.min(job.polls, job.plan.length - 1)];
    const row = jobBody({ ...job, polls: job.polls }).job;
    row.jobType = job.jobType || "custom";
    row.createdAt = job.createdAt || new Date().toISOString();
    row.status = status;
    if (row.metadata && row.metadata.input && typeof row.metadata.input.prompt === "string" && !/^asset_/.test(row.metadata.input.prompt)) row.metadata.input.prompt = textId(row.metadata.input.prompt);
    return row;
  }

  function shape(body) {
    const out = {};
    for (const [k, v] of Object.entries(body || {})) {
      if (k === "prompt" && typeof v === "string" && v) out[k] = "<prompt>";
      else if (typeof v === "string" && assets.has(v)) out[k] = `<${assets.get(v).width}x${assets.get(v).height}>`;
      else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" && assets.has(x) ? `<${assets.get(x).width}x${assets.get(x).height}>` : x));
      else out[k] = v;
    }
    return canonical(out);
  }
  const table = measured.dry_runs.map((d) => ({ model: d.model_id, key: shape(d.body), status: d.status, response: d.response }));

  function page(rows, query) {
    const size = opts.pageSize || Number(query.pageSize) || 500;
    const start = query.paginationToken ? Number(query.paginationToken.slice(1)) : 0;
    const next = start + size < rows.length ? `p${start + size}` : null;
    return { models: rows.slice(start, start + size), nextPaginationToken: next };
  }

  const handle = (r) => {
    if (r.path.startsWith("/assets-transform/") || r.path.startsWith("/assets/")) {
      cdnRequests.push({ path: r.path, query: r.query, authorization: r.authorization });
      if (opts.cdn) {
        const custom = opts.cdn(r);
        if (custom) return custom;
      }
      const id = decodeURIComponent(r.path.split("/")[2] || "");
      const res = results.get(id);
      if (!res) return { status: 403, body: "<Error>AccessDenied</Error>", headers: { "content-type": "application/xml" } };
      if (r.query.hop !== "2") return { status: 302, body: "", headers: { location: `${r.path}${r.search}&hop=2`, "content-type": "application/json" } };
      return { status: 200, body: solidPng(res.width, res.height), headers: { "content-type": "image/png" } };
    }
    if (!r.account) return undefined; // the base mock answers 401 or 403
    if (r.method === "GET" && r.path === "/v1/models") {
      if (r.query.pageSize === "1" && !r.query.privacy) return { status: 200, body: { models: [], nextPaginationToken: null } };
      if (r.query.privacy === "public") return { status: 200, body: page(catalogRows, r.query) };
      return { status: 200, body: page(opts.project || [], r.query) };
    }
    const m = /^\/v1\/models\/([^/]+)$/.exec(r.path);
    if (r.method === "GET" && m) {
      const rec = recs[decodeURIComponent(m[1])];
      return rec ? { status: 200, body: { model: rec } } : { status: 404, body: { reason: `Model ${m[1]} not found` } };
    }
    if (r.method === "POST" && r.path === "/v1/assets") {
      const size = r.body && imageSize(r.body.image);
      if (!size || r.body.hide !== true || typeof r.body.name !== "string") return { status: 400, body: { reason: "Invalid upload" } };
      const id = `asset_mockUpload${++n}`;
      assets.set(id, size);
      uploads.push({ id, name: r.body.name, width: size.width, height: size.height, bytes: size.bytes, mime: size.mime });
      return { status: 200, body: { asset: { id, ...measured.upload_shape, metadata: { ...measured.upload_shape.metadata, width: size.width, height: size.height } } } };
    }
    const g = /^\/v1\/generate\/custom\/([^/]+)$/.exec(r.path);
    if (opts.paid && r.method === "POST" && g && r.search === "") {
      const call = { model: g[1], body: r.body, search: r.search, n: paidCalls.length + 1 };
      paidCalls.push(call);
      if (typeof opts.paid === "function") {
        const custom = opts.paid(call);
        if (custom !== undefined) return custom;
      }
      jobN++;
      const job = { id: `job_mock${jobN}`, model: g[1], body: r.body || {}, polls: 0, charge: opts.charge ? opts.charge(r.body) : 2, createdAt: new Date().toISOString() };
      job.plan = opts.jobPlan ? opts.jobPlan(job) : ["in-progress", "success"];
      jobs.set(job.id, job);
      const submit = copy(jobsFixture.submit_image.body);
      submit.job.jobId = job.id;
      submit.job.status = "in-progress";
      submit.job.billing = { cuCost: job.charge, cuDiscount: 0 };
      submit.job.metadata.input = { modelId: g[1], ...job.body };
      return { status: 200, body: submit };
    }
    if (r.method === "GET" && r.path === "/v1/jobs") {
      if (opts.jobsList) {
        const custom = opts.jobsList(r);
        if (custom) return custom;
      }
      const after = r.query.createdAfter ? Date.parse(r.query.createdAfter) : -Infinity;
      const rows = [...jobs.values()]
        .map((j) => {
          if (!j.createdAt) j.createdAt = new Date().toISOString();
          return j;
        })
        .filter((j) => Date.parse(j.createdAt) > after)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (b.id < a.id ? -1 : 1))
        .map(jobRow);
      const size = Number(r.query.pageSize) || 10;
      const start = r.query.paginationToken ? Number(String(r.query.paginationToken).slice(1)) : 0;
      const body = { jobs: rows.slice(start, start + size) };
      if (start + size < rows.length) body.nextPaginationToken = `t${start + size}`;
      return { status: 200, body };
    }
    const jm = /^\/v1\/jobs\/([^/]+)$/.exec(r.path);
    if (r.method === "GET" && jm) {
      const job = jobs.get(jm[1]);
      if (opts.jobRead) {
        const custom = opts.jobRead(r, job);
        if (custom) return custom;
      }
      if (!job) return { status: 404, body: { reason: `Job ${jm[1]} not found` } };
      const out = jobBody(job);
      job.polls++;
      return { status: 200, body: out };
    }
    const am = /^\/v1\/assets\/([^/]+)$/.exec(r.path);
    if (r.method === "GET" && am) {
      const id = decodeURIComponent(am[1]);
      if (opts.assetRead) {
        const custom = opts.assetRead(r, id);
        if (custom) return custom;
      }
      if (texts.has(id)) {
        const text = texts.get(id);
        return { status: 200, body: { asset: { id, url: `${opts.cdnBase || mockOrigin}/assets/${id}?Key-Pair-Id=k&Policy=p&Signature=s`, mimeType: "text/plain", metadata: { type: "uploaded-text", kind: "text", preview: text, hasFullPreview: true, charCount: text.length, size: text.length }, kind: "text" } } };
      }
      const res = results.get(id);
      if (!res) return { status: 404, body: { reason: `Asset ${id} not found` } };
      const rec = copy(jobsFixture.result_record.body);
      rec.asset.id = id;
      rec.asset.url = `${opts.cdnBase || mockOrigin}/assets-transform/${id}?Key-Pair-Id=k&Policy=p&Signature=s`;
      rec.asset.metadata.width = res.width;
      rec.asset.metadata.height = res.height;
      return { status: 200, body: rec };
    }
    if (r.path.startsWith("/v1/generate")) {
      if (r.method !== "POST" || !g || r.search !== "?dryRun=true") {
        violations.push(`${r.method} ${r.path}${r.search}`);
        return { status: 500, body: { reason: "the mock refuses anything but a price check" } };
      }
      const key = shape(r.body);
      const hit = table.find((x) => x.model === g[1] && x.key === key);
      priceChecks.push({ model: g[1], search: r.search, body: r.body, key, matched: !!hit });
      if (opts.answer) {
        const custom = opts.answer(g[1], r.body);
        if (custom) return custom;
      }
      if (!hit) return { status: 500, body: { reason: `no measured answer for ${g[1]} ${key}` } };
      return { status: hit.status, body: hit.response };
    }
    return undefined;
  };

  const mock = await startMockScenario({ accounts: opts.accounts || [], handle });
  mockOrigin = mock.origin;
  return Object.assign(mock, { uploads, priceChecks, violations, assets, catalogRows, records: recs, paidCalls, jobs, results, cdnRequests, texts, textId });
}

module.exports = { startFixtureScenario, measured, catalogRows, records, pngSize, solidPng, jobsFixture };
