"use strict";
// Tool handlers of this build. scenario_status always answers: when the plugin
// is not linked it says why instead of failing, so an agent can tell the person
// what to do. list_models, model_schema and estimate_cost are answered by the
// plugin, which holds the Scenario key; the helper relays them and the MCP
// server checks inputs and outputs against shared/catalog.json.

const { ToolError } = require("./errors.js");

const LINK_ERRORS = new Set(["NotConnected", "PairingFailed", "PortInUse", "VersionMismatch", "Timeout"]);
const PLUGIN_FIELDS = [
  "signed_in",
  "project_name",
  "plugin_version",
  "photoshop_version",
  "os",
  "switches",
  "agent_spending",
  "active_document_id",
  "open_documents",
  "uncertain_jobs"
];
const STATUS_TIMEOUT_MS = 15000;
// Plugin-side limits, under the 120 s an agent's tool call waits: a catalog
// listing reads up to two pages of 500 models; a price check may upload a
// blank stand-in, then runs one dry run.
const RELAY_TIMEOUTS_MS = { list_models: 90000, model_schema: 45000, estimate_cost: 100000 };

function createTools({ manager, version, noSpend }) {
  return {
    scenario_status: async () => {
      const base = {
        connected: false,
        helper_version: version,
        helper_role: manager.role(),
        signed_in: null,
        project_name: null,
        plugin_version: null,
        photoshop_version: null,
        os: null,
        switches: null,
        agent_spending: null,
        no_spend: noSpend,
        active_document_id: null,
        open_documents: [],
        uncertain_jobs: null
      };
      let answer;
      try {
        answer = await manager.call("scenario_status", {}, STATUS_TIMEOUT_MS);
      } catch (err) {
        if (err instanceof ToolError && LINK_ERRORS.has(err.type)) {
          return { ...base, helper_role: manager.role(), reason: err.toString() };
        }
        throw err;
      }
      const out = { ...base, connected: true, helper_role: manager.role() };
      for (const key of PLUGIN_FIELDS) {
        if (answer && Object.prototype.hasOwnProperty.call(answer, key)) out[key] = answer[key];
      }
      out.no_spend = noSpend || (answer && answer.no_spend === true);
      return out;
    },
    list_models: (args) => manager.call("list_models", args, RELAY_TIMEOUTS_MS.list_models),
    model_schema: (args) => manager.call("model_schema", args, RELAY_TIMEOUTS_MS.model_schema),
    estimate_cost: (args) => manager.call("estimate_cost", args, RELAY_TIMEOUTS_MS.estimate_cost)
  };
}

module.exports = { createTools, STATUS_TIMEOUT_MS, RELAY_TIMEOUTS_MS };
