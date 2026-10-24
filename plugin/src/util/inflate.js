"use strict";
// zlib inflate (RFC 1950, 1951) and an 8-bit PNG decoder, in plain
// JavaScript: inspect_result_previews reads saved PNG results to make small
// previews and run the capture checks without opening them in Photoshop.
// Written from the RFCs and the PNG specification.

var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
var CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Canonical Huffman table: counts per length and symbols in code order.
function table(lengths) {
  var counts = new Uint16Array(16);
  for (var i = 0; i < lengths.length; i++) counts[lengths[i]]++;
  counts[0] = 0;
  var offs = new Uint16Array(16);
  for (var l = 1; l < 16; l++) offs[l] = offs[l - 1] + counts[l - 1];
  var syms = new Uint16Array(lengths.length);
  for (var s = 0; s < lengths.length; s++) if (lengths[s]) syms[offs[lengths[s]]++] = s;
  return { counts: counts, syms: syms };
}

function Growable(n) {
  this.buf = new Uint8Array(Math.max(1024, n));
  this.len = 0;
}
Growable.prototype.need = function (n) {
  if (this.len + n <= this.buf.length) return;
  var size = this.buf.length * 2;
  while (size < this.len + n) size *= 2;
  var next = new Uint8Array(size);
  next.set(this.buf.subarray(0, this.len));
  this.buf = next;
};

function inflateRaw(data, sizeHint) {
  var pos = 0;
  var bit = 0;
  var out = new Growable(sizeHint || data.length * 4);
  function bits(n) {
    var v = 0;
    for (var i = 0; i < n; i++) {
      if (pos >= data.length) throw new Error("inflate: data ended early");
      v |= ((data[pos] >> bit) & 1) << i;
      if (++bit === 8) {
        bit = 0;
        pos++;
      }
    }
    return v;
  }
  function decode(t) {
    var code = 0;
    var first = 0;
    var index = 0;
    for (var len = 1; len < 16; len++) {
      code |= bits(1);
      var count = t.counts[len];
      if (code - count < first) return t.syms[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("inflate: bad code");
  }
  var fixedL = null;
  var fixedD = null;
  var last = 0;
  while (!last) {
    last = bits(1);
    var type = bits(2);
    if (type === 0) {
      if (bit) {
        bit = 0;
        pos++;
      }
      var len = data[pos] | (data[pos + 1] << 8);
      pos += 4;
      if (pos + len > data.length) throw new Error("inflate: stored block ends early");
      out.need(len);
      out.buf.set(data.subarray(pos, pos + len), out.len);
      out.len += len;
      pos += len;
      continue;
    }
    var lt;
    var dt;
    if (type === 1) {
      if (!fixedL) {
        var ll = new Uint8Array(288);
        for (var a = 0; a < 288; a++) ll[a] = a < 144 ? 8 : a < 256 ? 9 : a < 280 ? 7 : 8;
        fixedL = table(ll);
        var dl = new Uint8Array(30);
        for (var b = 0; b < 30; b++) dl[b] = 5;
        fixedD = table(dl);
      }
      lt = fixedL;
      dt = fixedD;
    } else if (type === 2) {
      var hlit = bits(5) + 257;
      var hdist = bits(5) + 1;
      var hclen = bits(4) + 4;
      var cl = new Uint8Array(19);
      for (var c = 0; c < hclen; c++) cl[CLORDER[c]] = bits(3);
      var ct = table(cl);
      var lens = new Uint8Array(hlit + hdist);
      var n = 0;
      while (n < hlit + hdist) {
        var sym = decode(ct);
        if (sym < 16) lens[n++] = sym;
        else {
          var rep = 0;
          var val = 0;
          if (sym === 16) {
            if (!n) throw new Error("inflate: repeat with no length");
            val = lens[n - 1];
            rep = 3 + bits(2);
          } else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (n + rep > hlit + hdist) throw new Error("inflate: too many lengths");
          while (rep--) lens[n++] = val;
        }
      }
      lt = table(lens.subarray(0, hlit));
      dt = table(lens.subarray(hlit));
    } else throw new Error("inflate: bad block type");
    for (;;) {
      var s = decode(lt);
      if (s < 256) {
        out.need(1);
        out.buf[out.len++] = s;
      } else if (s === 256) break;
      else {
        s -= 257;
        if (s >= 29) throw new Error("inflate: bad length");
        var length = LBASE[s] + bits(LEXT[s]);
        var ds = decode(dt);
        if (ds >= 30) throw new Error("inflate: bad distance");
        var dist = DBASE[ds] + bits(DEXT[ds]);
        if (dist > out.len) throw new Error("inflate: distance too far");
        out.need(length);
        for (var k = 0; k < length; k++) {
          out.buf[out.len] = out.buf[out.len - dist];
          out.len++;
        }
      }
    }
  }
  return out.buf.subarray(0, out.len);
}

function inflateZlib(data, sizeHint) {
  if (data.length < 2 || (data[0] & 15) !== 8 || ((data[0] << 8) | data[1]) % 31) throw new Error("inflate: not a zlib stream");
  return inflateRaw(data.subarray(2), sizeHint);
}

function u32(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

// An 8-bit PNG (gray, gray + alpha, RGB, RGBA or palette, not interlaced)
// as { width, height, components (1 to 4), data }. Throws on anything else.
function decodePng(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  var sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (var s = 0; s < 8; s++) if (bytes[s] !== sig[s]) throw new Error("png: not a PNG file");
  var pos = 8;
  var w = 0;
  var h = 0;
  var depth = 0;
  var ctype = 0;
  var interlace = 0;
  var palette = null;
  var trns = null;
  var idat = [];
  var idatLen = 0;
  while (pos + 8 <= bytes.length) {
    var len = u32(bytes, pos);
    var type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    var body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = u32(body, 0);
      h = u32(body, 4);
      depth = body[8];
      ctype = body[9];
      interlace = body[12];
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") {
      idat.push(body);
      idatLen += body.length;
    } else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error("png: only 8-bit, non-interlaced files are read");
  var ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!ch || !(w > 0 && h > 0)) throw new Error("png: unsupported color type");
  var z = new Uint8Array(idatLen);
  var at = 0;
  for (var i = 0; i < idat.length; i++) {
    z.set(idat[i], at);
    at += idat[i].length;
  }
  var raw = inflateZlib(z, (w * ch + 1) * h);
  var stride = w * ch;
  if (raw.length < (stride + 1) * h) throw new Error("png: image data ends early");
  var px = new Uint8Array(stride * h);
  for (var y = 0; y < h; y++) {
    var f = raw[y * (stride + 1)];
    var src = y * (stride + 1) + 1;
    var dst = y * stride;
    for (var x = 0; x < stride; x++) {
      var a = x >= ch ? px[dst + x - ch] : 0;
      var b = y ? px[dst - stride + x] : 0;
      var c = y && x >= ch ? px[dst - stride + x - ch] : 0;
      var v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        var p = a + b - c;
        var pa = Math.abs(p - a);
        var pb = Math.abs(p - b);
        var pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error("png: bad filter");
      px[dst + x] = v & 255;
    }
  }
  if (ctype === 3) {
    if (!palette) throw new Error("png: palette missing");
    var outP = new Uint8Array(w * h * 4);
    for (var q = 0; q < w * h; q++) {
      var idx = px[q];
      outP[q * 4] = palette[idx * 3];
      outP[q * 4 + 1] = palette[idx * 3 + 1];
      outP[q * 4 + 2] = palette[idx * 3 + 2];
      outP[q * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
    return { width: w, height: h, components: 4, data: outP };
  }
  return { width: w, height: h, components: ch === 2 ? 2 : ch, data: px };
}

module.exports = { inflateRaw: inflateRaw, inflateZlib: inflateZlib, decodePng: decodePng };
