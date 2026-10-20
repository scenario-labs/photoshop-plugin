"use strict";
// The run card's price (live on New angle, 2026-10-20: the card kept "1 CU"
// after the price changed to 6 CU after the upload and the job was charged
// 6). The card shows what was charged, else the price waiting for
// approval, else the quote.

const test = require("node:test");
const assert = require("node:assert/strict");
const ctlMod = require("../../plugin/src/panel/controller.js");

test("run card price: charged, then the reapproved price, then the quote", () => {
  assert.equal(ctlMod.cuOf({ cu_quoted: "1", cu_quoted_new: "6", cu_charged: null }), "6", "waiting for approval at the new price");
  assert.equal(ctlMod.cuOf({ cu_quoted: "6", cu_quoted_new: null, cu_charged: "6" }), "6");
  assert.equal(ctlMod.cuOf({ cu_quoted: "1", cu_quoted_new: null, cu_charged: "6" }), "6", "the charge wins over a stale quote");
  assert.equal(ctlMod.cuOf({ cu_quoted: "2", cu_charged: "0" }), "0", "a refund shows 0 CU");
  assert.equal(ctlMod.cuOf({ cu_quoted: "2" }), "2");
  assert.equal(ctlMod.cuOf(null), null);
});
