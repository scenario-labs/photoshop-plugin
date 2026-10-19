"use strict";
// Black RGB PNGs for price-check stand-ins (SPEC 6.1 item 3): blank images
// that hold no document pixels. Written from the PNG and zlib specifications
// (RFC 1950, RFC 1951, PNG 1.2): every scanline is filter byte 0 followed by
// zero samples, so the image data is one run of zero bytes, compressed in a
// single fixed-Huffman deflate block as one literal 0 followed by length-258,
// distance-1 copies. A 6144 x 6144 stand-in is about 0.7 MB.

var MAX_SIDE = 16384;

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

module.exports = { blackPng: blackPng, pngSize: pngSize, crc32: crc32, MAX_SIDE: MAX_SIDE };
