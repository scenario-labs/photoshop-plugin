"use strict";
// Tool handlers of this build. scenario_status always answers: when the plugin
// is not linked it says why instead of failing, so an agent can tell the person
// what to do.

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
    }
  };
}

module.exports = { createTools, STATUS_TIMEOUT_MS };
