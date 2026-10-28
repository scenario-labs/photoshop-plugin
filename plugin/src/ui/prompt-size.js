"use strict";
// The prompt box's height. The person drags the grip on the composer's top
// edge, as between two of Photoshop's own panels, and double-clicks it to go
// back to the stylesheet's height. The middle (the takes and Recent) gives
// the room and keeps MID_MIN; the height is kept on this computer
// (localStorage) and fitted again when the panel gets shorter or taller.

var BASE = 44; // .cp .pfield in styles.css; the field itself is 4 px taller
var MAX = 360;
var MID_MIN = 64;
var KEY = "scenario.promptHeight";

// The field's height after a drag of dy px (negative: up) from h0, with
// room px the middle can still give.
function dragHeight(h0, dy, room) {
  var max = Math.min(MAX, h0 + Math.max(0, room));
  return Math.round(Math.max(BASE, Math.min(max, h0 - dy)));
}

// The kept height, or BASE when there is none or it is not a number.
function readSaved(store) {
  try {
    var v = store ? Number(store.getItem(KEY)) : NaN;
    return isFinite(v) && v >= BASE ? Math.min(MAX, Math.round(v)) : BASE;
  } catch (e) {
    return BASE;
  }
}

// g: the panel's global (resize events, localStorage); may be absent.
function attachPromptSize(doc, g) {
  if (!doc || typeof doc.getElementById !== "function") return null;
  var grip = doc.getElementById("composer-grip");
  var field = doc.getElementById("pfield");
  var prompt = doc.getElementById("prompt");
  var body = doc.getElementById("sc-body");
  if (!grip || !field || !prompt) return null;
  var store = null;
  try {
    store = g && g.localStorage ? g.localStorage : null;
  } catch (e) {
    store = null;
  }
  var saved = readSaved(store);
  var cur = BASE;
  var drag = null;

  function bodyHeight() {
    if (!body || typeof body.getBoundingClientRect !== "function") return null;
    var r = body.getBoundingClientRect();
    return r && r.width > 0 ? r.height : null;
  }
  function apply(h) {
    cur = h;
    field.style.height = h + "px";
    prompt.style.height = h + 4 + "px";
  }
  function keep(h) {
    saved = h;
    try {
      if (store) store.setItem(KEY, String(h));
    } catch (e) {
      // A refused write keeps the height for this session only.
    }
  }
  // Toward the kept height, within what the middle can give.
  function fit() {
    var mid = bodyHeight();
    var next = mid === null ? saved : Math.max(BASE, Math.min(saved, cur + mid - MID_MIN));
    if (next !== cur) apply(next);
  }
  function end() {
    if (!drag) return;
    drag = null;
    grip.className = "cgrip";
    keep(cur);
  }

  grip.addEventListener("mousedown", function (ev) {
    var mid = bodyHeight();
    drag = { y: ev.clientY, h: cur, room: mid === null ? MAX : mid - MID_MIN };
    grip.className = "cgrip on";
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
  });
  doc.addEventListener("mousemove", function (ev) {
    if (!drag) return;
    // The button came up outside the panel: no mouseup reached it.
    if (typeof ev.buttons === "number" && ev.buttons === 0) return end();
    apply(dragHeight(drag.h, ev.clientY - drag.y, drag.room));
  });
  doc.addEventListener("mouseup", end);
  grip.addEventListener("dblclick", function () {
    apply(BASE);
    keep(BASE);
  });
  // Only a real change of the panel's size (UXP also sends "resize" when
  // the layout inside changes; create-view.js has the same guard).
  var lastSize = null;
  if (g && typeof g.addEventListener === "function") {
    g.addEventListener("resize", function () {
      var size = g.innerWidth + "x" + g.innerHeight;
      if (size === lastSize) return;
      lastSize = size;
      fit();
    });
  }
  fit();

  return {
    height: function () {
      return cur;
    },
    fit: fit
  };
}

module.exports = { attachPromptSize: attachPromptSize, dragHeight: dragHeight, readSaved: readSaved, BASE: BASE, MAX: MAX, MID_MIN: MID_MIN, KEY: KEY };
