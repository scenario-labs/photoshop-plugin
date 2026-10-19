"use strict";
// The panel's icons: 18 px outline drawings in the panel's text color
// (currentColor), so they follow Photoshop's four interface brightness
// themes. Elements carrying data-icon="<name>" get their drawing at startup;
// rows built later call icon(). The markup is constant: no text from
// Scenario, a document or a person ever goes through innerHTML.

var OUTLINE = 'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"';

var PATHS = {
  image: '<rect x="2.5" y="3.5" width="13" height="11" rx="1.5"/><circle cx="6.5" cy="7.5" r="1.3"/><path d="M3 13.5l4-4 3 3 2-2 3 3"/>',
  edit: '<path d="M3 15l.9-3.4 7.7-7.7a1.5 1.5 0 0 1 2.2 2.1l-7.7 7.8z"/><path d="M10.4 5.1l2.4 2.4"/>',
  enhance: '<path d="M10.5 3H15v4.5"/><path d="M15 3l-5 5"/><path d="M7.5 15H3v-4.5"/><path d="M3 15l5-5"/>',
  trained: '<path d="M9 2.5l6 3.3v6.4L9 15.5l-6-3.3V5.8z"/><path d="M3 5.8l6 3.3 6-3.3"/><path d="M9 9.1v6.4"/>',
  library: '<rect x="2.5" y="5.5" width="10" height="10" rx="1"/><path d="M5.5 3h9a1 1 0 0 1 1 1v9"/><path d="M3 13l3-3 2 2 1.5-1.5 3 3"/>',
  jobs: '<circle cx="9" cy="9" r="6.5"/><path d="M9 5.5V9l2.5 1.5"/>',
  "chevron-down": '<path d="M5 7l4 4 4-4"/>',
  "chevron-left": '<path d="M11 4L6 9l5 5"/>',
  "chevron-right": '<path d="M7 4l5 5-5 5"/>',
  plus: '<path d="M9 4v10"/><path d="M4 9h10"/>',
  close: '<path d="M5 5l8 8"/><path d="M13 5l-8 8"/>',
  check: '<path d="M4 9.5l3 3 7-7"/>',
  selection: '<path d="M3 6V3h3"/><path d="M12 3h3v3"/><path d="M15 12v3h-3"/><path d="M6 15H3v-3"/><path d="M8 3h2"/><path d="M8 15h2"/><path d="M3 8v2"/><path d="M15 8v2"/>',
  canvas: '<rect x="3" y="3" width="12" height="12" rx="1"/>',
  newdoc: '<path d="M5 2.5h5.5L14 6v9.5H5z"/><path d="M10.5 2.5V6H14"/><path d="M9.5 8.5v4.5"/><path d="M7.25 10.75h4.5"/>',
  layer: '<path d="M9 3l6.5 3.5L9 10 2.5 6.5z"/><path d="M2.5 9.5L9 13l6.5-3.5"/>',
  visible: '<path d="M9 2.5l6.5 3.5L9 9.5 2.5 6z"/><path d="M2.5 9L9 12.5 15.5 9"/><path d="M2.5 12L9 15.5l6.5-3.5"/>',
  file: '<path d="M5 2.5h5.5L14 6v9.5H5z"/><path d="M10.5 2.5V6H14"/>',
  star: '<path d="M9 2.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L9 12.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
  upscale: '<rect x="2.5" y="8.5" width="7" height="7" rx="1"/><path d="M11 3h4v4"/><path d="M15 3l-5 5"/>',
  expand: '<rect x="6" y="6" width="6" height="6" rx=".5"/><path d="M3 6V3h3"/><path d="M12 3h3v3"/><path d="M15 12v3h-3"/><path d="M6 15H3v-3"/>',
  removebg: '<circle cx="9" cy="6.5" r="2.5"/><path d="M4.5 15c.6-2.6 2.3-4 4.5-4s3.9 1.4 4.5 4"/><path d="M2.5 2.5l13 13"/>',
  info: '<circle cx="9" cy="9" r="6.5"/><path d="M9 8.2V12.5"/><path d="M9 5.6v.1"/>',
  warning: '<path d="M9 2.8l6.6 11.7H2.4z"/><path d="M9 7.3v3.4"/><path d="M9 12.6v.1"/>',
  refresh: '<path d="M14.5 9a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/>',
  agent: '<rect x="3.5" y="6" width="11" height="8.5" rx="2"/><path d="M9 3.5V6"/><path d="M7 10h.1"/><path d="M11 10h.1"/>',
  more: '<path d="M4.5 9h.1"/><path d="M9 9h.1"/><path d="M13.5 9h.1"/>'
};

// Filled drawings: the star when a model is a favorite, and the Scenario
// mark (four stacked layers, monochrome, after the black-and-white logo on
// scenario.com).
var FILLED = {
  "star-filled": '<svg width="18" height="18" viewBox="0 0 18 18"><path fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M9 2.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L9 12.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>',
  mark:
    '<svg width="16" height="16" viewBox="0 0 246 252">' +
    '<path fill="currentColor" opacity="0.85" d="M122.6 108.2L241.3 178.1 122.6 248 4 178.1z"/>' +
    '<path fill="currentColor" opacity="0.55" d="M122.6 73.2L241.3 143.1 122.6 213 4 143.1z"/>' +
    '<path fill="currentColor" opacity="0.35" d="M122.6 38.2L241.3 108.2 122.6 178.1 4 108.2z"/>' +
    '<path fill="currentColor" opacity="0.15" d="M122.6 3.3L241.3 73.2 122.6 143.1 4 73.2z"/>' +
    "</svg>"
};

function markup(name) {
  if (Object.prototype.hasOwnProperty.call(FILLED, name)) return FILLED[name];
  if (!Object.prototype.hasOwnProperty.call(PATHS, name)) return "";
  return '<svg width="18" height="18" viewBox="0 0 18 18" ' + OUTLINE + ">" + PATHS[name] + "</svg>";
}

function names() {
  return Object.keys(PATHS).concat(Object.keys(FILLED));
}

// A span holding the drawing, for rows built at run time.
function icon(doc, name, cls) {
  var span = doc.createElement("span");
  span.className = "ico" + (cls ? " " + cls : "");
  span.setAttribute("data-icon", name);
  span.innerHTML = markup(name);
  return span;
}

// Swaps the drawing of an element that carries data-icon.
function set(el, name) {
  if (!el) return;
  if (el.getAttribute && el.getAttribute("data-icon") === name && el.firstChild) return;
  el.setAttribute("data-icon", name);
  el.innerHTML = markup(name);
}

// Draws every [data-icon] element of the panel.
function fill(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return 0;
  var all = doc.querySelectorAll("[data-icon]");
  for (var i = 0; i < all.length; i++) all[i].innerHTML = markup(all[i].getAttribute("data-icon"));
  return all.length;
}

module.exports = { markup: markup, icon: icon, set: set, fill: fill, names: names };
