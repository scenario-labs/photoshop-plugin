"use strict";
// The M3 building blocks with no I/O: the zlib encoder and the PNG encoder
// (checked by Node's zlib), metadata stripping of chosen PNG and JPEG files,
// the XMP packet (build, parse, escaping, legacy keys), names and slugs,
// the placement plan (cover fit, names, the two opt-outs) and the charge
// words.

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const deflate = require("../../plugin/src/util/deflate.js");
const png = require("../../plugin/src/util/png.js");
const jpeg = require("../../plugin/src/util/jpeg.js");
const xmp = require("../../plugin/src/util/xmp.js");
const slugMod = require("../../plugin/src/util/slug.js");
const b64 = require("../../plugin/src/util/base64url.js");
const plan = require("../../plugin/src/apply/plan.js");
const charges = require("../../plugin/src/jobs/charges.js");
const jobsApi = require("../../plugin/src/scenario/jobs-api.js");
const { fakeJpeg } = require("../helpers/fake-photoshop.js");
const { jobsFixture, solidPng } = require("../helpers/fixture-scenario.js");

function chunks(buf) {
  const out = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    out.push({ type: buf.toString("latin1", off + 4, off + 8), data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return out;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(png.crc32(td, 0, td.length) >>> 0);
  return Buffer.concat([len, td, crc]);
}

// Undoes PNG row filters (types 0 to 4) for 8-bit samples.
function unfilter(raw, w, h, bpp) {
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let p;
      if (f === 0) p = 0;
      else if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = (a + b) >> 1;
      else {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = (v + p) & 255;
    }
  }
  return out;
}

test("zlibCompress: Node's zlib inflates it back (header, Adler-32) for noise, runs, text and empty input", () => {
  const inputs = [crypto.randomBytes(70000), Buffer.alloc(200000), Buffer.from("scenario ".repeat(5000)), Buffer.alloc(0), Buffer.from([7])];
  let mixed = Buffer.alloc(0);
  for (let i = 0; i < 40; i++) mixed = Buffer.concat([mixed, crypto.randomBytes(300), Buffer.alloc(500, i)]);
  inputs.push(mixed);
  for (const input of inputs) {
    const z = Buffer.from(deflate.zlibCompress(new Uint8Array(input)));
    assert.equal(z[0], 0x78);
    assert.deepEqual(zlib.inflateSync(z), input);
  }
  assert.ok(deflate.zlibCompress(new Uint8Array(200000)).length < 2000, "runs compress");
});

test("encodePng: gray, RGB and RGBA pixels round-trip through Node's zlib; pngInfo reads the header", () => {
  for (const [w, h, channels] of [
    [1, 1, 3],
    [37, 19, 1],
    [64, 48, 3],
    [33, 65, 4]
  ]) {
    const data = new Uint8Array(w * h * channels);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 5)) & 255;
    const buf = Buffer.from(png.encodePng({ width: w, height: h, channels, data }));
    const cs = chunks(buf);
    assert.deepEqual(cs.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
    const info = png.pngInfo(buf);
    assert.deepEqual([info.width, info.height, info.bit_depth, info.alpha], [w, h, 8, channels === 4]);
    assert.deepEqual(unfilter(zlib.inflateSync(cs[1].data), w, h, channels), Buffer.from(data));
  }
});

test("stripPng: text, EXIF and time chunks go; color chunks stay; a chosen JPEG loses APP1, comments and trailing data", () => {
  const base = solidPng(8, 8);
  const cs = chunks(base);
  const ihdr = chunk("IHDR", cs[0].data);
  const extra = [chunk("iCCP", Buffer.from("profile\u0000\u0000xyz", "latin1")), chunk("tEXt", Buffer.from("Author\u0000someone", "latin1")), chunk("eXIf", Buffer.from("MM\u0000*")), chunk("tIME", Buffer.alloc(7)), chunk("pHYs", Buffer.alloc(9))];
  const file = Buffer.concat([base.subarray(0, 8), ihdr, ...extra, chunk("IDAT", cs[1].data), chunk("iTXt", Buffer.from("XML:com.adobe.xmp\u0000\u0000\u0000\u0000\u0000<x/>", "latin1")), chunk("IEND", Buffer.alloc(0))]);
  const out = png.stripPng(new Uint8Array(file));
  assert.deepEqual(chunks(Buffer.from(out.bytes)).map((c) => c.type), ["IHDR", "iCCP", "pHYs", "IDAT", "IEND"]);
  assert.deepEqual(out.dropped.sort(), ["eXIf", "iTXt", "tEXt", "tIME"]);
  assert.deepEqual(png.pngInfo(out.bytes), png.pngInfo(new Uint8Array(file)));

  const j = fakeJpeg(40, 30, 0.5);
  const withMore = Buffer.concat([j.subarray(0, j.length - 2), Buffer.from([0xff, 0xd9]), Buffer.from("trailing preview")]);
  const com = Buffer.from([0xff, 0xfe, 0x00, 0x07, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  const file2 = Buffer.concat([withMore.subarray(0, 2), com, withMore.subarray(2)]);
  const s = jpeg.stripJpeg(new Uint8Array(file2));
  const text = Buffer.from(s.bytes).toString("latin1");
  assert.ok(!text.includes("Exif") && !text.includes("hello") && !text.includes("trailing"));
  assert.ok(text.includes("JFIF"));
  assert.deepEqual(jpeg.jpegInfo(s.bytes), { width: 40, height: 30, alpha: false });
  assert.equal(s.bytes[s.bytes.length - 2], 0xff);
  assert.equal(s.bytes[s.bytes.length - 1], 0xd9);
});

test("XMP schema 1: build and parse round-trip, values escaped, legacy keys read, no packet for other layers", () => {
  const nasty = 'a "quoted" <tag> & \'apostrophe\'\nnew line, tab\there, café 世界';
  const packet = xmp.build({ schema: "1", assetId: "asset_x1", prompt: nasty, cuQuoted: "2.5", cuCharged: null, kind: "image", ignored: "nope" });
  assert.ok(packet.includes(`xmlns:scenario="${xmp.NS}"`));
  assert.ok(!packet.includes("cuCharged"), "null values are left out");
  assert.ok(!packet.includes("ignored"));
  assert.ok(!/<tag>|"quoted"/.test(packet), "escaped");
  assert.deepEqual(xmp.parse(packet), { schema: "1", assetId: "asset_x1", prompt: nasty, cuQuoted: "2.5", kind: "image" });
  assert.equal(xmp.isScenarioLayer(packet), true);
  const legacy = `<x:xmpmeta><rdf:RDF><rdf:Description xmlns:scenario="${xmp.NS}" scenario:asset_id="asset_old" scenario:model_id='model_y'><scenario:cost_cu>3</scenario:cost_cu></rdf:Description></rdf:RDF></x:xmpmeta>`;
  assert.deepEqual(xmp.parse(legacy), { assetId: "asset_old", modelId: "model_y", cuCharged: "3" });
  assert.deepEqual(xmp.parse("<x:xmpmeta/>"), {});
  assert.deepEqual(xmp.parse(null), {});
  assert.equal(xmp.isScenarioLayer(xmp.build({ schema: "1" })), false);
});

test("names: slug of the first meaningful words, ASCII, 24 characters at most; tail of the asset id", () => {
  assert.equal(slugMod.slug("A lighthouse on a rocky coast at dawn, soft watercolor"), "lighthouse-rocky-coast");
  assert.equal(slugMod.slug("Château de la Loire: été"), "chateau-de-la-loire");
  assert.equal(slugMod.slug("   "), "");
  assert.equal(slugMod.slug(null), "");
  assert.ok(slugMod.slug("supercalifragilistic expialidocious wonderland").length <= slugMod.MAX);
  assert.equal(slugMod.tail("asset_abcdefGHIJKL"), "GHIJKL");
});

test("plan: cover fit, one layer or a group of takes, History name, and the two opt-outs", () => {
  assert.deepEqual(plan.cover(1024, 1024, { left: 0, top: 0, width: 2048, height: 1024 }), { scale_pct: 200, center_x: 1024, center_y: 512, width: 2048, height: 2048 });
  assert.deepEqual(plan.cover(1536, 1024, { left: 100, top: 50, width: 300, height: 300 }), { scale_pct: (300 / 1024) * 100, center_x: 250, center_y: 200, width: 450, height: 300 });
  const rec = {
    lane: "image",
    job_id: "job_a",
    model_id: "model_m",
    model_name: "Model M",
    parameters: { prompt: "A lighthouse on a rocky coast", negativePrompt: "fog", style: "free words", quality: "low", width: 1024, height: 1024 },
    inputs: { asset_ids: ["asset_ref1"] },
    cu_quoted: "3",
    cu_charged: "3",
    created_at: "2026-10-19T08:00:00.000Z",
    target: { kind: "canvas", document_id: 7, box: [0, 0, 1024, 1024] },
    origin: { kind: "person" },
    outputs: [
      { asset_id: "asset_take1AAAAAA", path: "Scenario/image/a.png", width: 1024, height: 1024 },
      { asset_id: "asset_take2BBBBBB", path: "Scenario/image/b.png", width: 1024, height: 1024 },
      { asset_id: "asset_take3CCCCCC", path: "Scenario/image/c.png", width: 1024, height: 1024 }
    ]
  };
  const p = plan.build(rec, { version: "0.3.0", document: { id: 7, width: 1024, height: 1024 }, free_text: ["style"] });
  assert.equal(p.history_name, "Scenario: Place image");
  assert.equal(p.group.name, "Scenario image lighthouse-rocky-coast (3 takes)");
  assert.deepEqual(p.takes.map((x) => [x.name, x.visible]), [
    ["Take 1 AAAAAA", true],
    ["Take 2 BBBBBB", false],
    ["Take 3 CCCCCC", false]
  ]);
  const m = xmp.parse(p.takes[2].xmp);
  assert.equal(m.take, "3");
  assert.equal(m.inputAssetIds, "asset_ref1");
  assert.equal(m.negativePrompt, "fog");
  assert.equal(JSON.parse(m.parameters).style, "free words");

  const single = plan.build({ ...rec, outputs: rec.outputs.slice(0, 1) }, { document: null });
  assert.equal(single.group, null);
  assert.equal(single.takes[0].name, "Scenario image lighthouse-rocky-coast AAAAAA");
  assert.deepEqual(single.new_document, { width: 1024, height: 1024, name: "Scenario image lighthouse-rocky-coast AAAAAA" });

  const quiet = plan.build(rec, { document: { id: 7 }, leave_prompts: true, leave_prices: true, free_text: ["style"] });
  assert.equal(quiet.group.name, "Scenario image (3 takes)");
  for (const packet of [quiet.group.xmp, ...quiet.takes.map((x) => x.xmp)]) {
    const q = xmp.parse(packet);
    assert.equal(q.prompt, undefined);
    assert.equal(q.negativePrompt, undefined);
    assert.equal(q.cuQuoted, undefined);
    assert.equal(q.cuCharged, undefined);
    assert.deepEqual(JSON.parse(q.parameters), { height: 1024, quality: "low", width: 1024 });
    assert.ok(!packet.includes("lighthouse") && !packet.includes("fog") && !packet.includes("free words"));
  }
  assert.throws(() => plan.build({ ...rec, outputs: [] }, {}), /no saved results/);
});

test("charges: settle from the measured job reads, and the words Jobs shows", () => {
  const ok = jobsApi.readJob(jobsFixture.final_image.body.job);
  assert.deepEqual([ok.status, ok.cu_cost, ok.asset_ids], ["succeeded", 2, ["asset_fixtureImageTake"]]);
  assert.deepEqual(charges.settle("succeeded", ok), { cu_record: "2", cu_discount: "0", no_refund: false, cu_charged: "2", refunded: false });
  const failed = jobsApi.readJob(jobsFixture.final_failure.body.job);
  assert.equal(failed.status, "failed");
  assert.match(failed.hint, /width and height/);
  assert.deepEqual(charges.settle("failed", failed), { cu_record: "2", cu_discount: "0", no_refund: false, cu_charged: "0", refunded: true });
  assert.equal(charges.settle("failed", { ...failed, disable_refund: true }).cu_charged, "2");
  assert.equal(charges.settle("succeeded", { cu_cost: 2, cu_cost_details: 0.5, cu_discount: 0 }).cu_charged, "2.5");
  assert.equal(jobsApi.readJob(jobsFixture.submit_image.body.job).status, "generating");
  for (const [remote, mine] of Object.entries({ pending: "queued", queued: "queued", "warming-up": "queued", "in-progress": "generating", finalizing: "generating", success: "succeeded", failure: "failed", canceled: "canceled" })) {
    assert.equal(jobsApi.readJob({ jobId: "job_a", status: remote }).status, mine);
  }

  const r = { cu_quoted: "2", price_kind: "exact" };
  assert.equal(charges.words({ ...r, state: "queued", cu_charged: null }), "quoted 2 CU");
  assert.equal(charges.words({ ...r, state: "applied", cu_charged: "2" }), "quoted 2, charged 2 CU");
  assert.equal(charges.words({ ...r, state: "failed", cu_charged: "0", refunded: true }), "Refunded by Scenario");
  assert.equal(charges.words({ ...r, state: "failed", cu_charged: "2", no_refund: true }), "Charged 2 CU, no refund on failure");
  assert.equal(charges.words({ ...r, state: "not_sent", cu_charged: "0" }), "Nothing charged");
  assert.equal(charges.words({ cu_quoted: "1", cu_quoted_max: "4", price_kind: "range", state: "queued", cu_charged: null }), "quoted 1 to 4 CU");
});

test("base64 decoding of Photoshop's encoder output (standard alphabet, padding, line breaks)", () => {
  const bytes = crypto.randomBytes(1000);
  const text = bytes.toString("base64").replace(/(.{76})/g, "$1\n");
  assert.deepEqual(Buffer.from(b64.decodeStandard(text)), bytes);
});
