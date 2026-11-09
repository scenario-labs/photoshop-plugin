"use strict";
// A zlib stream encoder (RFC 1950) over deflate (RFC 1951), written from the
// two specifications for the PNG encoder of captures (SPEC 5.5). LZ77 with a
// hash chain, then one dynamic Huffman block per run of symbols, with code
// lengths limited to 15 bits (7 for the code length alphabet). No decoder:
// the plugin never reads compressed data back, and the tests check the
// output with Node's own zlib.

var WINDOW = 32768;
var MIN_MATCH = 3;
var MAX_MATCH = 258;
var HASH_BITS = 15;
var HASH_SIZE = 1 << HASH_BITS;
var MAX_CHAIN = 16;
var NICE = 96;
// Longer matches skip inserting their inner positions into the hash, as
// zlib's faster levels do.
var MAX_INSERT = 24;
var BLOCK_SYMBOLS = 65536;

// RFC 1951 section 3.2.5: length codes 257..285 and distance codes 0..29.
var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
// RFC 1951 section 3.2.7: the order code length code lengths are sent in.
var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

var LEN_CODE = new Uint16Array(MAX_MATCH + 1);
(function () {
  for (var c = 0; c < LEN_BASE.length; c++) {
    var top = c + 1 < LEN_BASE.length ? LEN_BASE[c + 1] : MAX_MATCH + 1;
    if (c === LEN_BASE.length - 2) top = MAX_MATCH; // 258 has its own code
    for (var l = LEN_BASE[c]; l < top; l++) LEN_CODE[l] = c;
  }
  LEN_CODE[MAX_MATCH] = 28;
})();

function distCode(d) {
  var lo = 0;
  var hi = DIST_BASE.length - 1;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function Out(capacity) {
  this.buf = new Uint8Array(Math.max(1024, capacity));
  this.pos = 0;
  this.acc = 0;
  this.n = 0;
}
Out.prototype.grow = function (need) {
  if (this.pos + need <= this.buf.length) return;
  var next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + need + 1024));
  next.set(this.buf.subarray(0, this.pos));
  this.buf = next;
};
// value's low `count` bits, least significant first.
Out.prototype.bits = function (value, count) {
  this.acc |= (value & ((1 << count) - 1)) << this.n;
  this.n += count;
  while (this.n >= 8) {
    if (this.pos >= this.buf.length) this.grow(1);
    this.buf[this.pos++] = this.acc & 255;
    this.acc >>>= 8;
    this.n -= 8;
  }
};
Out.prototype.align = function () {
  if (this.n > 0) {
    this.grow(1);
    this.buf[this.pos++] = this.acc & 255;
  }
  this.acc = 0;
  this.n = 0;
};
Out.prototype.byte = function (b) {
  this.grow(1);
  this.buf[this.pos++] = b & 255;
};
Out.prototype.result = function () {
  return this.buf.subarray(0, this.pos);
};

function reverse(code, len) {
  var r = 0;
  for (var i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

// Huffman code lengths for `freqs`, none longer than maxBits.
function codeLengths(freqs, maxBits) {
  var n = freqs.length;
  var lengths = new Uint8Array(n);
  var used = [];
  for (var i = 0; i < n; i++) if (freqs[i] > 0) used.push(i);
  if (used.length === 0) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    lengths[used[0] === 0 ? 1 : 0] = 1;
    return lengths;
  }
  // Two-queue Huffman build over the leaves sorted by frequency.
  used.sort(function (a, b) {
    return freqs[a] - freqs[b] || a - b;
  });
  var m = used.length;
  var weight = new Float64Array(2 * m);
  var parent = new Int32Array(2 * m);
  for (var k = 0; k < m; k++) weight[k] = freqs[used[k]];
  var leaf = 0;
  var inner = m;
  var next = m;
  function take() {
    if (leaf < m && (inner >= next || weight[leaf] <= weight[inner])) return leaf++;
    return inner++;
  }
  for (var j = 0; j < m - 1; j++) {
    var a = take();
    var b = take();
    weight[next] = weight[a] + weight[b];
    parent[a] = next;
    parent[b] = next;
    next++;
  }
  var root = next - 1;
  var depth = new Int32Array(2 * m);
  depth[root] = 0;
  for (var q = root - 1; q >= 0; q--) depth[q] = depth[parent[q]] + 1;
  var count = new Int32Array(Math.max(maxBits, 2 * m) + 2);
  for (var t = 0; t < m; t++) count[depth[t]]++;
  // Limit to maxBits (the adjustment zlib's trees.c describes): move
  // leaves deeper than maxBits up, then split shorter codes to keep the
  // Kraft sum at one.
  var overflow = 0;
  for (var d = maxBits + 1; d < count.length; d++) {
    overflow += count[d];
    count[maxBits] += count[d];
    count[d] = 0;
  }
  if (overflow > 0) {
    var kraft = 0;
    for (var e = 1; e <= maxBits; e++) kraft += count[e] * Math.pow(2, maxBits - e);
    var limit = Math.pow(2, maxBits);
    while (kraft > limit) {
      var bitsAt = maxBits - 1;
      while (bitsAt > 0 && count[bitsAt] === 0) bitsAt--;
      count[bitsAt]--;
      count[bitsAt + 1] += 2;
      count[maxBits]--;
      kraft -= Math.pow(2, maxBits - bitsAt) - Math.pow(2, maxBits - bitsAt - 1) * 2 + 1;
    }
  }
  // Shortest lengths to the most frequent symbols.
  var len = 1;
  for (var s = m - 1; s >= 0; s--) {
    while (len <= maxBits && count[len] === 0) len++;
    lengths[used[s]] = len;
    count[len]--;
  }
  return lengths;
}

// Canonical codes (RFC 1951 section 3.2.2), bit-reversed for writing.
function codesFor(lengths) {
  var maxLen = 0;
  for (var i = 0; i < lengths.length; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
  var blCount = new Int32Array(maxLen + 1);
  for (var j = 0; j < lengths.length; j++) if (lengths[j]) blCount[lengths[j]]++;
  var nextCode = new Int32Array(maxLen + 2);
  var code = 0;
  for (var bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  var codes = new Uint16Array(lengths.length);
  for (var k = 0; k < lengths.length; k++) {
    var l = lengths[k];
    if (l) codes[k] = reverse(nextCode[l]++, l);
  }
  return codes;
}

// Run-length codes 16, 17, 18 over the concatenated code lengths.
function rle(lengths) {
  var out = [];
  var i = 0;
  while (i < lengths.length) {
    var v = lengths[i];
    var run = 1;
    while (i + run < lengths.length && lengths[i + run] === v) run++;
    if (v === 0 && run >= 3) {
      var r = run;
      while (r >= 11) {
        var take18 = Math.min(r, 138);
        out.push([18, take18 - 11, 7]);
        r -= take18;
      }
      if (r >= 3) {
        out.push([17, r - 3, 3]);
        r = 0;
      }
      while (r-- > 0) out.push([0, 0, 0]);
    } else if (v !== 0 && run >= 4) {
      out.push([v, 0, 0]);
      var left = run - 1;
      while (left >= 3) {
        var take16 = Math.min(left, 6);
        out.push([16, take16 - 3, 2]);
        left -= take16;
      }
      while (left-- > 0) out.push([v, 0, 0]);
    } else {
      for (var k = 0; k < run; k++) out.push([v, 0, 0]);
    }
    i += run;
  }
  return out;
}

// syms: literal/length symbols with their extra values; one block.
function writeBlock(out, syms, count, last) {
  var litFreq = new Uint32Array(286);
  var distFreq = new Uint32Array(30);
  for (var i = 0; i < count; i++) {
    var s = syms[i];
    if (s < 256) litFreq[s]++;
    else {
      litFreq[257 + LEN_CODE[s >>> 16 & 0x1ff]]++;
      distFreq[distCode(s & 0xffff)]++;
    }
  }
  litFreq[256] = 1;
  var litLen = codeLengths(litFreq, 15);
  var distLen = codeLengths(distFreq, 15);
  var hasDist = false;
  for (var dd = 0; dd < 30; dd++) if (distLen[dd]) hasDist = true;
  if (!hasDist) distLen[0] = 1;
  var hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  var hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  var all = new Uint8Array(hlit + hdist);
  all.set(litLen.subarray(0, hlit), 0);
  all.set(distLen.subarray(0, hdist), hlit);
  var runs = rle(all);
  var clFreq = new Uint32Array(19);
  for (var r = 0; r < runs.length; r++) clFreq[runs[r][0]]++;
  var clLen = codeLengths(clFreq, 7);
  var hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  var clCodes = codesFor(clLen);
  var litCodes = codesFor(litLen);
  var distCodes = codesFor(distLen);

  out.bits(last ? 1 : 0, 1);
  out.bits(2, 2);
  out.bits(hlit - 257, 5);
  out.bits(hdist - 1, 5);
  out.bits(hclen - 4, 4);
  for (var c = 0; c < hclen; c++) out.bits(clLen[CL_ORDER[c]], 3);
  for (var q = 0; q < runs.length; q++) {
    var run = runs[q];
    out.bits(clCodes[run[0]], clLen[run[0]]);
    if (run[2]) out.bits(run[1], run[2]);
  }
  for (var j = 0; j < count; j++) {
    var sym = syms[j];
    if (sym < 256) {
      out.bits(litCodes[sym], litLen[sym]);
      continue;
    }
    var length = (sym >>> 16) & 0x1ff;
    var dist = sym & 0xffff;
    var lc = LEN_CODE[length];
    out.bits(litCodes[257 + lc], litLen[257 + lc]);
    if (LEN_EXTRA[lc]) out.bits(length - LEN_BASE[lc], LEN_EXTRA[lc]);
    var dc = distCode(dist);
    out.bits(distCodes[dc], distLen[dc]);
    if (DIST_EXTRA[dc]) out.bits(dist - DIST_BASE[dc], DIST_EXTRA[dc]);
  }
  out.bits(litCodes[256], litLen[256]);
}

function adler32(data) {
  var a = 1;
  var b = 0;
  var i = 0;
  var n = data.length;
  while (i < n) {
    var end = Math.min(n, i + 3800);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Raw deflate of `data` (Uint8Array).
function deflateRaw(data) {
  var n = data.length;
  var out = new Out((n >> 1) + 1024);
  if (n === 0) {
    out.bits(1, 1);
    out.bits(1, 2);
    out.bits(0, 7); // fixed-code end of block
    out.align();
    return out.result();
  }
  var head = new Int32Array(HASH_SIZE).fill(-1);
  var prev = new Int32Array(WINDOW);
  // A literal is its byte (< 256); a match is (length << 16) | distance,
  // with the 0x10000000 bit set so it is never below 256.
  var syms = new Uint32Array(BLOCK_SYMBOLS);
  var count = 0;
  function hashAt(p) {
    return (((data[p] << 10) ^ (data[p + 1] << 5) ^ data[p + 2]) * 2654435761) >>> (32 - HASH_BITS);
  }
  function insert(p) {
    var h = hashAt(p);
    prev[p & (WINDOW - 1)] = head[h];
    head[h] = p;
    return h;
  }
  var pos = 0;
  while (pos < n) {
    var bestLen = 0;
    var bestDist = 0;
    if (pos + MIN_MATCH <= n) {
      var h = hashAt(pos);
      var cand = head[h];
      var chain = MAX_CHAIN;
      var maxLen = Math.min(MAX_MATCH, n - pos);
      while (cand >= 0 && pos - cand <= WINDOW && chain-- > 0) {
        if (data[cand + bestLen] === data[pos + bestLen] && data[cand] === data[pos]) {
          var l = 0;
          while (l < maxLen && data[cand + l] === data[pos + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = pos - cand;
            if (l >= NICE || l === maxLen) break;
          }
        }
        var nextCand = prev[cand & (WINDOW - 1)];
        if (nextCand >= cand) break;
        cand = nextCand;
      }
      prev[pos & (WINDOW - 1)] = head[h];
      head[h] = pos;
    }
    if (bestLen >= MIN_MATCH) {
      syms[count++] = (0x10000000 | (bestLen << 16) | bestDist) >>> 0;
      if (bestLen <= MAX_INSERT) {
        for (var k = 1; k < bestLen; k++) if (pos + k + MIN_MATCH <= n) insert(pos + k);
      }
      pos += bestLen;
    } else {
      syms[count++] = data[pos];
      pos++;
    }
    if (count === BLOCK_SYMBOLS) {
      writeBlock(out, syms, count, false);
      count = 0;
    }
  }
  writeBlock(out, syms, count, true);
  out.align();
  return out.result();
}

// zlib stream: header 0x78 0x9c, deflate data, Adler-32 (big-endian).
function zlibCompress(data) {
  var raw = deflateRaw(data);
  var z = new Uint8Array(raw.length + 6);
  z[0] = 0x78;
  z[1] = 0x9c;
  z.set(raw, 2);
  var ad = adler32(data);
  var at = raw.length + 2;
  z[at] = (ad >>> 24) & 255;
  z[at + 1] = (ad >>> 16) & 255;
  z[at + 2] = (ad >>> 8) & 255;
  z[at + 3] = ad & 255;
  return z;
}

module.exports = { zlibCompress: zlibCompress, deflateRaw: deflateRaw, adler32: adler32, codeLengths: codeLengths };
