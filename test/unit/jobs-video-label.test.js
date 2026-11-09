"use strict";
// Jobs named an Animate run "Image" (live, 2026-10-20: 'Image
// "steam-rises-slowly-tea"' in the popover and in Jobs). A video job is
// named "Video".

const test = require("node:test");
const assert = require("node:assert/strict");
const jobsText = require("../../plugin/src/ui/jobs-text.js");
const viewModel = require("../../plugin/src/jobs/view-model.js");

const VIDEO = { local_id: "v1", lane: "video", state: "applied", created_at: "2026-10-20T20:10:00Z", cu_quoted: "20", cu_charged: "20", parameters: { prompt: "steam rises slowly from the tea" }, target: { kind: "video" } };

test("Jobs popover and Jobs: a video job is named Video, an image job Image", () => {
  const rows = jobsText.popRows([VIDEO, { ...VIDEO, local_id: "i1", lane: "image", target: { kind: "new_document" } }], 6);
  assert.match(rows[0].label, /^Video "/);
  assert.match(rows[1].label, /^Image "/);
  assert.match(viewModel.title(VIDEO), /^Video "/);
  assert.equal(jobsText.title({ ...VIDEO, parameters: {} }), "Video");
});
