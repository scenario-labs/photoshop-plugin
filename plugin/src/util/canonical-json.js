"use strict";
// Canonical JSON in the style of RFC 8785 (JCS): object keys sorted by UTF-16
// code units, no whitespace, numbers as ECMAScript prints them, strings escaped
// as ES2019 JSON.stringify does (lone surrogates as \uXXXX). Used for request
// fingerprints and for the tool catalog hash, so two engines that hold the same
// data produce the same bytes. Refuses values JSON cannot carry.

var sha = require("./sha256.js");
var utf8 = require("./utf8.js");

function hex4(c) {
  var h = c.toString(16);
  while (h.length < 4) h = "0" + h;
  return "\\u" + h;
}

function quote(str) {
  var out = '"';
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += hex4(c);
    else if (c >= 0xd800 && c <= 0xdbff) {
      var d = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += str.charAt(i) + str.charAt(i + 1);
        i++;
      } else {
        out += hex4(c);
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += hex4(c);
    } else {
      out += str.charAt(i);
    }
  }
  return out + '"';
}

function compareKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value, path) {
  if (value === null) return "null";
  var t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!isFinite(value)) throw new TypeError("canonical JSON: non-finite number at " + path);
    return String(value);
  }
  if (t === "string") return quote(value);
  if (Array.isArray(value)) {
    var parts = [];
    for (var i = 0; i < value.length; i++) {
      if (value[i] === undefined) throw new TypeError("canonical JSON: undefined at " + path + "[" + i + "]");
      parts.push(serialize(value[i], path + "[" + i + "]"));
    }
    return "[" + parts.join(",") + "]";
  }
  if (t === "object") {
    var proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("canonical JSON: only plain objects at " + path);
    }
    var keys = Object.keys(value).sort(compareKeys);
    var members = [];
    for (var k = 0; k < keys.length; k++) {
      var v = value[keys[k]];
      if (v === undefined) continue;
      members.push(quote(keys[k]) + ":" + serialize(v, path + "." + keys[k]));
    }
    return "{" + members.join(",") + "}";
  }
  throw new TypeError("canonical JSON: unsupported " + t + " at " + path);
}

function stringify(value) {
  return serialize(value, "$");
}

function hash(value) {
  return sha.toHex(sha.sha256(utf8.encode(stringify(value))));
}

module.exports = { stringify: stringify, hash: hash };
