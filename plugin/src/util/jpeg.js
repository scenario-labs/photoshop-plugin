"use strict";
// JPEG files, read by marker segments (ITU T.81 annex B), never decoded.
//
// - jpegInfo: width and height from the frame header (SOFn).
// - stripJpeg: a chosen file without its metadata (SPEC 5.2): APP1 (EXIF
//   and XMP), APP13 (IPTC), comments and the other application segments go;
//   APP0 (JFIF), APP14 (Adobe color transform) and APP2 segments holding an
//   ICC profile stay, so colors read the same. Anything after the end of the
//   image (appended previews) goes too.

function isJpeg(bytes) {
  return !!bytes && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function u16(bytes, at) {
  return (bytes[at] << 8) | bytes[at + 1];
}

function isSof(m) {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

function startsWith(bytes, at, text) {
  for (var i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function keepSegment(bytes, marker, at, len) {
  if (marker === 0xe0 || marker === 0xee) return true;
  if (marker === 0xe2) return len >= 14 && startsWith(bytes, at + 4, "ICC_PROFILE\u0000");
  if (marker >= 0xe0 && marker <= 0xef) return false;
  if (marker === 0xfe) return false;
  return true;
}

// Walks the file. Returns { segments: [{marker, start, end, keep}], end }
// where `end` is just past the end-of-image marker.
function walk(bytes) {
  if (!isJpeg(bytes)) throw new Error("not a JPEG file");
  var segs = [{ marker: 0xd8, start: 0, end: 2, keep: true }];
  var off = 2;
  var n = bytes.length;
  while (off < n) {
    if (bytes[off] !== 0xff) throw new Error("broken JPEG file");
    var marker = bytes[off + 1];
    if (marker === 0xff) {
      off++; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      segs.push({ marker: marker, start: off, end: off + 2, keep: true });
      return { segments: segs, end: off + 2 };
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      segs.push({ marker: marker, start: off, end: off + 2, keep: true });
      off += 2;
      continue;
    }
    if (off + 4 > n) throw new Error("broken JPEG file");
    var len = u16(bytes, off + 2);
    var end = off + 2 + len;
    if (len < 2 || end > n) throw new Error("broken JPEG file");
    segs.push({ marker: marker, start: off, end: end, keep: keepSegment(bytes, marker, off, len) });
    off = end;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is not a stuffed
      // zero or a restart marker.
      var p = off;
      while (p + 1 < n) {
        if (bytes[p] === 0xff) {
          var next = bytes[p + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            p += next === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        p++;
      }
      segs.push({ marker: -1, start: off, end: p, keep: true });
      off = p;
      if (p + 1 >= n) throw new Error("broken JPEG file");
    }
  }
  throw new Error("broken JPEG file");
}

function jpegInfo(bytes) {
  var w = walk(bytes);
  for (var i = 0; i < w.segments.length; i++) {
    var s = w.segments[i];
    if (isSof(s.marker)) return { width: u16(bytes, s.start + 7), height: u16(bytes, s.start + 5), alpha: false };
  }
  throw new Error("broken JPEG file");
}

function stripJpeg(bytes) {
  var w = walk(bytes);
  var size = 0;
  var dropped = [];
  for (var i = 0; i < w.segments.length; i++) {
    if (w.segments[i].keep) size += w.segments[i].end - w.segments[i].start;
    else dropped.push("0x" + w.segments[i].marker.toString(16));
  }
  var out = new Uint8Array(size);
  var off = 0;
  for (var j = 0; j < w.segments.length; j++) {
    var s = w.segments[j];
    if (!s.keep) continue;
    out.set(bytes.subarray(s.start, s.end), off);
    off += s.end - s.start;
  }
  if (w.end < bytes.length) dropped.push("trailing data");
  return { bytes: out, dropped: dropped };
}

module.exports = { isJpeg: isJpeg, jpegInfo: jpegInfo, stripJpeg: stripJpeg };
