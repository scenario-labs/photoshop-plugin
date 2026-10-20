"use strict";
// Tool handlers. scenario_status always answers: when the plugin is not
// linked it says why instead of failing, so an agent can tell the person what
// to do. Every other v1 tool (MCP.md section 4) is answered by the plugin,
// which holds the Scenario key and the document; the helper relays it and the
// MCP server checks inputs (and outputs, where the catalog has a schema)
// against shared/catalog.json. SCENARIO_NO_SPEND=1 refuses generate and
// upload_reference here, before anything reaches the plugin.

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
const RELAY_TIMEOUTS_MS = {
  list_models: 90000,
  model_schema: 45000,
  estimate_cost: 100000,
  document_summary: 30000,
  layer_detail: 20000,
  preview_document: 45000,
  recommend_models: 60000,
  job_status: 20000,
  list_local_jobs: 20000,
  list_generations: 45000,
  list_assets: 45000,
  search_assets: 90000,
  list_collections: 45000,
  inspect_result_previews: 100000,
  capture_reference: 60000,
  upload_reference: 100000,
  reference_upload_status: 15000,
  generate: 100000,
  recover_local_job: 60000,
  recover_cloud_job: 100000,
  cancel_prepared_job: 20000,
  prepare_result_application: 60000,
  apply_result_application: 100000,
  select_layers: 30000,
  set_selection: 60000,
  remove_scenario_layers: 30000,
  execute_batchplay: 100000
};
// wait_for_job waits up to its timeout (default 45 s, at most 170 s) in the plugin.
const WAIT_MARGIN_MS = 5000;
const SPENDING = new Set(["generate", "upload_reference"]);

function waitMs(args) {
  const t = args && typeof args.timeout === "number" ? args.timeout : 45;
  return Math.min(170, Math.max(0, t)) * 1000 + WAIT_MARGIN_MS;
}

// The relay's own limit for a call: the MCP server's limit is 2 s more.
function relayTimeout(name, args) {
  if (name === "wait_for_job") return waitMs(args);
  return RELAY_TIMEOUTS_MS[name] || 30000;
}

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
    ...relays()
  };

  function relays() {
    const out = {};
    for (const name of Object.keys(RELAY_TIMEOUTS_MS).concat(["wait_for_job"])) {
      out[name] = async (args) => {
        if (noSpend && SPENDING.has(name)) throw new ToolError("NoSpend", "SCENARIO_NO_SPEND=1 is set for this helper. Nothing was sent.");
        return manager.call(name, args, relayTimeout(name, args));
      };
    }
    return out;
  }
}

module.exports = { createTools, STATUS_TIMEOUT_MS, RELAY_TIMEOUTS_MS, relayTimeout };
