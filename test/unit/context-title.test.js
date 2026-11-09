"use strict";
// Live 2026-10-21: a take layer's context card read "Take 1 NfpUm8 · Layer
// 1536..." (the asset id tail and the size, cut by the ellipsis). The card
// names a Scenario result in plain words; the id tail and the size stay in
// the tooltip; a layer the person named keeps its name.

const test = require("node:test");
const assert = require("node:assert/strict");
const ctl = require("../../plugin/src/panel/controller.js");

const take = { assetId: "asset_abcdefNfpUm8", take: "1", prompt: "A paper kite over the dunes", kind: "image" };

test("a take keeps its number and gets its run's name", () => {
  assert.equal(ctl.layerTitle("Take 1 NfpUm8", take), "Take 1 of A paper kite over the dunes");
  assert.equal(ctl.layerTitle("Take 3 NfpUm8", { ...take, take: "3" }), "Take 3 of A paper kite over the dunes");
  // A Suggest run keeps the person's short prompt as its name.
  assert.equal(ctl.layerTitle("Take 2 NfpUm8", { ...take, runName: "Kite" }), "Take 2 of Kite");
  // No prompt: the kind of run.
  assert.equal(ctl.layerTitle("Take 1 NfpUm8", { assetId: take.assetId, kind: "expand" }), "Take 1 of Extend canvas");
});

test("one result outside a group reads as its run's name", () => {
  assert.equal(ctl.layerTitle("Scenario image a-paper-kite NfpUm8", { ...take, take: undefined }), "A paper kite over the dunes");
});

test("other layers keep their own name", () => {
  assert.equal(ctl.layerTitle("Hero", null), "Hero");
  assert.equal(ctl.layerTitle("Background", {}), "Background");
  assert.equal(ctl.layerTitle("Kite, final", take), "Kite, final", "renamed by the person");
  assert.equal(ctl.layerTitle("Take 1 XXXXXX", take), "Take 1 XXXXXX", "not this layer's id");
});
