"use strict";
// Layer metadata (SPEC 9.2): one XMP packet per result layer, namespace
// https://scenario.com/ns/photoshop/1.0/, prefix `scenario`, camelCase keys,
// scenario:schema 1. The packet has the shape the skills toolkit writes
// (ps_io.provenance_xmp): one rdf:Description whose fields are attributes,
// every value XML-escaped. Reading accepts the older snake_case keys too and
// returns plain strings, which the panel shows as text only.

var NS = "https://scenario.com/ns/photoshop/1.0/";

// Written in this order; anything else is ignored.
var FIELDS = [
  "schema",
  "assetId",
  "jobId",
  "modelId",
  "modelName",
  "trainedModelIds",
  "prompt",
  "negativePrompt",
  "parameters",
  "inputAssetIds",
  "cuQuoted",
  "cuCharged",
  "createdAt",
  "kind",
  "take",
  "captureBox",
  "sample",
  "origin",
  "pluginVersion"
];

// Older keys some layers carry (SPEC 9.2, Reading).
var LEGACY = {
  asset_id: "assetId",
  asset: "assetId",
  job_id: "jobId",
  model: "modelId",
  model_id: "modelId",
  date: "createdAt",
  cost: "cuCharged",
  cost_cu: "cuCharged"
};

function escape(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

function unescape(value) {
  return String(value).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, function (all, ent) {
    if (ent === "amp") return "&";
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    if (ent === "quot") return '"';
    if (ent === "apos") return "'";
    var code = ent.charAt(1) === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
}

// fields: {name: string | number}; null, undefined and "" are left out.
function build(fields) {
  var attrs = [];
  for (var i = 0; i < FIELDS.length; i++) {
    var k = FIELDS[i];
    var v = fields[k];
    if (v === null || v === undefined || v === "") continue;
    attrs.push("scenario:" + k + '="' + escape(v) + '"');
  }
  return (
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:scenario="' +
    NS +
    '" ' +
    attrs.join(" ") +
    "/></rdf:RDF></x:xmpmeta>"
  );
}

// Reads scenario:* attributes and elements, with the legacy names mapped.
// Returns {} for anything that is not Scenario metadata.
function parse(packet) {
  var out = {};
  if (typeof packet !== "string" || packet.indexOf(NS) < 0 && !/scenario:/.test(packet)) return out;
  var re = /scenario:([A-Za-z_]+)\s*=\s*"([^"]*)"|scenario:([A-Za-z_]+)\s*=\s*'([^']*)'|<scenario:([A-Za-z_]+)>([^<]*)<\/scenario:\5>/g;
  var m;
  while ((m = re.exec(packet))) {
    var key = m[1] || m[3] || m[5];
    var value = unescape(m[2] !== undefined ? m[2] : m[4] !== undefined ? m[4] : m[6]);
    if (Object.prototype.hasOwnProperty.call(LEGACY, key)) key = LEGACY[key];
    if (FIELDS.indexOf(key) < 0) continue;
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
  }
  return out;
}

// A "Scenario layer" carries an asset id (SPEC 9.2).
function isScenarioLayer(packet) {
  return !!parse(packet).assetId;
}

module.exports = { build: build, parse: parse, isScenarioLayer: isScenarioLayer, escape: escape, NS: NS, FIELDS: FIELDS };
