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

const fs = require("node:fs");
const path = require("node:path");
const { startMockScenario } = require("./mock-scenario.js");

const DIR = path.resolve(__dirname, "..", "fixtures", "m2.0");
const measured = JSON.parse(fs.readFileSync(path.join(DIR, "measured.json"), "utf8"));
const catalogRows = JSON.parse(fs.readFileSync(path.join(DIR, "catalog-public.json"), "utf8")).models;
const records = {};
for (const f of fs.readdirSync(path.join(DIR, "models"))) {
  const rec = JSON.parse(fs.readFileSync(path.join(DIR, "models", f), "utf8")).model;
  records[rec.id] = rec;
}

function pngSize(b64) {
  const buf = Buffer.from(String(b64), "base64");
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// opts: { accounts, pageSize (the mock's page size, to test paging),
//         project: [rows of the project's own models], extraRecords }
async function startFixtureScenario(opts = {}) {
  const assets = new Map(Object.entries(measured.assets).map(([id, a]) => [id, { width: a.width, height: a.height }]));
  const uploads = [];
  const priceChecks = [];
  const violations = [];
  const recs = { ...records, ...(opts.extraRecords || {}) };
  let n = 0;

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
      const size = r.body && pngSize(r.body.image);
      if (!size || r.body.hide !== true || typeof r.body.name !== "string") return { status: 400, body: { reason: "Invalid upload" } };
      const id = `asset_mockUpload${++n}`;
      assets.set(id, size);
      uploads.push({ id, name: r.body.name, width: size.width, height: size.height, bytes: size.bytes });
      return { status: 200, body: { asset: { id, ...measured.upload_shape, metadata: { ...measured.upload_shape.metadata, width: size.width, height: size.height } } } };
    }
    const g = /^\/v1\/generate\/custom\/([^/]+)$/.exec(r.path);
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
  return Object.assign(mock, { uploads, priceChecks, violations, assets, catalogRows, records: recs });
}

module.exports = { startFixtureScenario, measured, catalogRows, records, pngSize };
