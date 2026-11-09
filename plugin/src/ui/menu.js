"use strict";
// The panel menu (the flyout behind the icon at the panel's top right):
// what Photoshop users look for there, kept out of the header. UXP draws the
// menu from these items (entrypoints.setup, panels.<id>.menuItems) and calls
// invokeMenu(id) when one is chosen. A label "-" is a separator.

var ITEMS = [
  { id: "jobs", label: "Jobs" },
  { id: "projects", label: "Projects..." },
  { id: "sep1", label: "-" },
  { id: "settings", label: "Settings..." },
  { id: "agents", label: "Connect an AI Agent..." },
  { id: "diagnostics", label: "Diagnostics..." },
  { id: "sep2", label: "-" },
  { id: "help", label: "Scenario Help" },
  { id: "about", label: "About Scenario for Photoshop" },
  { id: "sep3", label: "-" },
  { id: "signout", label: "Sign Out..." }
];

function items() {
  return ITEMS.map(function (i) {
    return { id: i.id, label: i.label };
  });
}

// handlers: { [id]: function () } for the items above; an id without a
// handler is ignored.
function createMenu(handlers) {
  return {
    items: items,
    invoke: function (id) {
      var fn = handlers && Object.prototype.hasOwnProperty.call(handlers, id) ? handlers[id] : null;
      if (typeof fn === "function") fn();
      return !!fn;
    }
  };
}

module.exports = { ITEMS: ITEMS, items: items, createMenu: createMenu };
