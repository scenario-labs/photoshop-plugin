"use strict";
// Reframe's model record, constructed from its schema as the hosted
// Scenario MCP showed it on 2026-10-21 (an image, a prompt, an aspectRatio
// enum, a resolution enum and a 9-value position preset); not a recorded
// REST answer. The mock serves it through `extraRecords`.

const REFRAME = {
  id: "model_scenario-gemini-reframe",
  name: "Reframe",
  type: "custom",
  privacy: "public",
  status: "trained",
  capabilities: ["img2img"],
  tags: ["Image", "Outpaint", "Post Processing", "expand", "reframe", "tool"],
  inputs: [
    { name: "image", type: "file", kind: "image", costImpact: false, required: { always: true } },
    { name: "prompt", type: "string", maxLength: 4096, costImpact: false },
    { name: "aspectRatio", type: "string", allowedValues: ["21:9", "16:9", "4:3", "3:2", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16", "auto"], default: "auto", costImpact: true },
    { name: "resolution", type: "string", allowedValues: ["1K", "2K", "4K"], default: "2K", costImpact: true },
    { name: "position", type: "string", allowedValues: ["center", "top", "bottom", "center-left", "center-right", "top-left", "top-right", "bottom-left", "bottom-right"], default: "center", costImpact: false }
  ]
};

module.exports = { REFRAME };
