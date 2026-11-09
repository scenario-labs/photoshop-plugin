"use strict";
// PNG files, written from the PNG 1.2 specification and RFC 1950 and 1951.
//
// - blackPng: black RGB stand-ins for price checks (SPEC 6.1 item 3), blank
//   images that hold no document pixels. Every scanline is filter byte 0
//   followed by zero samples, so the image data is one run of zero bytes,
//   compressed in a single fixed-Huffman deflate block as one literal 0
//   followed by length-258, distance-1 copies. A 6144 x 6144 stand-in is
//   about 0.7 MB.
// - encodePng: captures (SPEC 5.5), gray, RGB or RGBA at 8 bits, each row
//   with the filter whose output has the smallest sum of magnitudes.
// - stripPng: a chosen file without its text, EXIF and time chunks (SPEC
//   5.2), every other chunk kept byte for byte.

var deflate = require("./deflate.js");

var MAX_SIDE = 16384;
var SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

var CRC_TABLE = (function () {
  var table = new Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start, end) {
  var c = 0xffffffff;
  for (var i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Bits go out least significant first (RFC 1951 section 3.1.1).
function BitWriter(capacity) {
  this.buf = new Uint8Array(capacity);
  this.pos = 0;
  this.acc = 0;
  this.n = 0;
}
BitWriter.prototype.bits = function (value, count) {
  for (var i = 0; i < count; i++) {
    this.acc |= ((value >>> i) & 1) << this.n;
    this.n++;
    if (this.n === 8) {
      this.buf[this.pos++] = this.acc;
      this.acc = 0;
      this.n = 0;
    }
  }
};
// Huffman codes are packed starting with their most significant bit.
BitWriter.prototype.code = function (code, length) {
  for (var i = length - 1; i >= 0; i--) this.bits((code >>> i) & 1, 1);
};
BitWriter.prototype.finish = function () {
  if (this.n > 0) this.buf[this.pos++] = this.acc;
  this.acc = 0;
  this.n = 0;
  return this.buf.subarray(0, this.pos);
};

// Fixed Huffman codes (RFC 1951 section 3.2.6): literal 0 is 0x30 in 8 bits,
// length 258 is code 285 (0xC5 in 8 bits, no extra bits), distance 1 is
// distance code 0 (5 bits), end of block is code 256 (7 zero bits).
function deflateZeros(total) {
  var copies = total > 0 ? Math.floor((total - 1) / 258) : 0;
  var tail = total > 0 ? total - 1 - copies * 258 : 0;
  var w = new BitWriter(Math.ceil((3 + 8 + copies * 13 + tail * 8 + 7) / 8) + 8);
  w.bits(1, 1); // BFINAL
  w.bits(1, 2); // BTYPE 01: fixed Huffman codes
  if (total > 0) w.code(0x30, 8);
  for (var i = 0; i < copies; i++) {
    w.code(0xc5, 8);
    w.code(0, 5);
  }
  for (var t = 0; t < tail; t++) w.code(0x30, 8);
  w.code(0, 7);
  return w.finish();
}

function u32(out, at, v) {
  out[at] = (v >>> 24) & 255;
  out[at + 1] = (v >>> 16) & 255;
  out[at + 2] = (v >>> 8) & 255;
  out[at + 3] = v & 255;
}

function chunk(type, data) {
  var out = new Uint8Array(12 + data.length);
  u32(out, 0, data.length);
  for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  u32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

// Returns the PNG file as a Uint8Array.
function blackPng(width, height) {
  if (typeof width !== "number" || typeof height !== "number" || !(width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE) || width % 1 || height % 1) {
    throw new RangeError("stand-in size out of range");
  }
  var raw = height * (1 + width * 3);
  var deflated = deflateZeros(raw);
  // zlib wrapper: CMF 0x78 (deflate, 32K window), FLG 0x01 (check bits), and
  // the Adler-32 of `raw` zero bytes: s1 stays 1, s2 adds 1 per byte.
  var z = new Uint8Array(2 + deflated.length + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  z.set(deflated, 2);
  var s2 = raw % 65521;
  u32(z, 2 + deflated.length, ((s2 << 16) | 1) >>> 0);

  var ihdr = new Uint8Array(13);
  u32(ihdr, 0, width);
  u32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  var parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  var size = 0;
  for (var p = 0; p < parts.length; p++) size += parts[p].length;
  var out = new Uint8Array(size);
  var off = 0;
  for (var q = 0; q < parts.length; q++) {
    out.set(parts[q], off);
    off += parts[q].length;
  }
  return out;
}

// Width and height from a PNG's IHDR, or null.
function pngSize(bytes) {
  if (!bytes || bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[12] !== 0x49 || bytes[13] !== 0x48) return null;
  var w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
  var h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
  return { width: w, height: h };
}

function concat(parts) {
  var size = 0;
  for (var p = 0; p < parts.length; p++) size += parts[p].length;
  var out = new Uint8Array(size);
  var off = 0;
  for (var q = 0; q < parts.length; q++) {
    out.set(parts[q], off);
    off += parts[q].length;
  }
  return out;
}

function paeth(a, b, c) {
  var p = a + b - c;
  var pa = p > a ? p - a : a - p;
  var pb = p > b ? p - b : b - p;
  var pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// image: { width, height, channels: 1 (gray), 3 (RGB) or 4 (RGBA), data:
// Uint8Array of width * height * channels samples, rows top to bottom }.
function encodePng(image) {
  var w = image.width;
  var h = image.height;
  var ch = image.channels;
  if (!(w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE) || w % 1 || h % 1) throw new RangeError("image size out of range");
  if (ch !== 1 && ch !== 3 && ch !== 4) throw new RangeError("channels must be 1, 3 or 4");
  var data = image.data;
  if (!data || data.length < w * h * ch) throw new RangeError("not enough pixel data");
  var stride = w * ch;
  var raw = new Uint8Array(h * (stride + 1));
  var trial = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (var y = 0; y < h; y++) {
    var row = y * stride;
    var up = row - stride;
    var best = 0;
    var bestSum = Infinity;
    for (var f = 0; f < 5; f++) {
      var t = trial[f];
      var sum = 0;
      for (var x = 0; x < stride; x++) {
        var cur = data[row + x];
        var left = x >= ch ? data[row + x - ch] : 0;
        var above = y > 0 ? data[up + x] : 0;
        var corner = y > 0 && x >= ch ? data[up + x - ch] : 0;
        var v;
        if (f === 0) v = cur;
        else if (f === 1) v = cur - left;
        else if (f === 2) v = cur - above;
        else if (f === 3) v = cur - ((left + above) >> 1);
        else v = cur - paeth(left, above, corner);
        v &= 255;
        t[x] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    // The chosen filter's row, computed again in full (the trial may stop early).
    var at = y * (stride + 1);
    raw[at] = best;
    for (var x2 = 0; x2 < stride; x2++) {
      var c2 = data[row + x2];
      var l2 = x2 >= ch ? data[row + x2 - ch] : 0;
      var a2 = y > 0 ? data[up + x2] : 0;
      var k2 = y > 0 && x2 >= ch ? data[up + x2 - ch] : 0;
      var o;
      if (best === 0) o = c2;
      else if (best === 1) o = c2 - l2;
      else if (best === 2) o = c2 - a2;
      else if (best === 3) o = c2 - ((l2 + a2) >> 1);
      else o = c2 - paeth(l2, a2, k2);
      raw[at + 1 + x2] = o & 255;
    }
  }
  var ihdr = new Uint8Array(13);
  u32(ihdr, 0, w);
  u32(ihdr, 4, h);
  ihdr[8] = 8;
  ihdr[9] = ch === 1 ? 0 : ch === 3 ? 2 : 6;
  return concat([new Uint8Array(SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", deflate.zlibCompress(raw)), chunk("IEND", new Uint8Array(0))]);
}

function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (var i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

function readU32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

// The chunks of a PNG file, checked for structure (not CRCs): [{type, start,
// end}], where start..end covers the whole chunk. Throws on a broken file.
function chunksOf(bytes) {
  if (!isPng(bytes)) throw new Error("not a PNG file");
  var out = [];
  var off = 8;
  while (off + 12 <= bytes.length) {
    var len = readU32(bytes, off);
    var end = off + 12 + len;
    if (len > 0x7fffffff || end > bytes.length) throw new Error("broken PNG file");
    var type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("broken PNG file");
    out.push({ type: type, start: off, end: end });
    off = end;
    if (type === "IEND") break;
  }
  if (!out.length || out[0].type !== "IHDR" || out[out.length - 1].type !== "IEND") throw new Error("broken PNG file");
  return out;
}

// Width, height and whether the pixels can hold transparency.
function pngInfo(bytes) {
  var cs = chunksOf(bytes);
  var ihdr = cs[0].start + 8;
  var colorType = bytes[ihdr + 9];
  var hasTrns = cs.some(function (c) {
    return c.type === "tRNS";
  });
  return {
    width: readU32(bytes, ihdr),
    height: readU32(bytes, ihdr + 4),
    bit_depth: bytes[ihdr + 8],
    color_type: colorType,
    alpha: colorType === 4 || colorType === 6 || hasTrns
  };
}

// Chunks a chosen file keeps: image data, palette, transparency and color.
// Everything else (tEXt, zTXt, iTXt, eXIf, tIME and any private chunk) goes.
var KEEP = { IHDR: 1, PLTE: 1, IDAT: 1, IEND: 1, tRNS: 1, gAMA: 1, cHRM: 1, sRGB: 1, iCCP: 1, sBIT: 1, pHYs: 1, cICP: 1, mDCV: 1, cLLI: 1, acTL: 0 };

function stripPng(bytes) {
  var cs = chunksOf(bytes);
  var parts = [bytes.subarray(0, 8)];
  var dropped = [];
  for (var i = 0; i < cs.length; i++) {
    if (KEEP[cs[i].type] === 1) parts.push(bytes.subarray(cs[i].start, cs[i].end));
    else dropped.push(cs[i].type);
  }
  return { bytes: concat(parts), dropped: dropped };
}

module.exports = {
  blackPng: blackPng,
  pngSize: pngSize,
  encodePng: encodePng,
  pngInfo: pngInfo,
  stripPng: stripPng,
  isPng: isPng,
  crc32: crc32,
  MAX_SIDE: MAX_SIDE
};
