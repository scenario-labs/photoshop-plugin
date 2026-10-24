"use strict";
// Document references (FLOWS v2, "Document references"): layers a person
// pins as the document's references, each with a role. They show first in
// the refs row of every action that takes references and travel with the
// PSD, in the document's own XMP packet under the Scenario namespace (SPEC
// 9.2): one attribute, scenario:references, holding a JSON list of
// { role, layer_id, name }. Writing keeps every other field of the packet.
// The pixels are read from the layer when a run starts, so a reference
// follows the layer as the person edits it.

var xmp = require("../util/xmp.js");

var ROLES = ["Character", "Set", "Style", "Product"];
var MAX = 8;
var ATTR = /\sscenario:references\s*=\s*"([^"]*)"/;

function clean(list) {
  var out = [];
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length && out.length < MAX; i++) {
    var r = list[i] || {};
    var id = Number(r.layer_id);
    if (ROLES.indexOf(r.role) < 0 || !(id > 0) || Math.floor(id) !== id) continue;
    var dup = false;
    for (var k = 0; k < out.length; k++) if (out[k].layer_id === id) dup = true;
    if (dup) continue;
    out.push({ role: r.role, layer_id: id, name: String(r.name || "Layer").slice(0, 100) });
  }
  return out;
}

function unescapeAttr(v) {
  return String(v).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, function (all, ent) {
    if (ent === "amp") return "&";
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    if (ent === "quot") return '"';
    if (ent === "apos") return "'";
    var code = ent.charAt(1) === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
}

// packet: a document's XMP (or null). Returns the clean list.
function read(packet) {
  if (typeof packet !== "string") return [];
  var m = ATTR.exec(packet);
  if (!m) return [];
  try {
    return clean(JSON.parse(unescapeAttr(m[1])));
  } catch (e) {
    return [];
  }
}

// Returns the packet with the list written (an empty list removes the
// attribute), every other field kept.
function write(packet, list) {
  var refs = clean(list);
  var attr = refs.length ? ' scenario:references="' + xmp.escape(JSON.stringify(refs)) + '"' : "";
  if (typeof packet === "string" && packet) {
    if (ATTR.test(packet)) return packet.replace(ATTR, attr);
    if (!attr) return packet;
    var decl = 'xmlns:scenario="' + xmp.NS + '"';
    var at = packet.indexOf(decl);
    if (at >= 0) return packet.slice(0, at + decl.length) + attr + packet.slice(at + decl.length);
    var end = packet.indexOf("</rdf:RDF>");
    if (end >= 0) return packet.slice(0, end) + '<rdf:Description rdf:about="" ' + decl + attr + "/>" + packet.slice(end);
  }
  if (!attr) return typeof packet === "string" ? packet : "";
  return '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:scenario="' + xmp.NS + '"' + attr + "/></rdf:RDF></x:xmpmeta>";
}

module.exports = { read: read, write: write, clean: clean, ROLES: ROLES, MAX: MAX };
