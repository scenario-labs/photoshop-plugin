"use strict";
// What the panel says about the account, as plain data (SPEC 3.12, 3.13,
// 3.14, 4.2; wireframes sections 1, 2 and 13). No DOM here, so it is tested
// under Node. Texts marked "SPEC" are copied from the spec word for word.

var NOT_SIGNED_IN = "Not signed in";

var TEXT = {
  // SPEC 4.2 step 1 and wireframe 1.
  title: "Connect your Scenario account",
  disclosure: "Generative AI by Scenario.",
  // SPEC 3.13, Not signed in (the plan sentence).
  plan: "Needs a Scenario plan with API access (Starter or above).",
  // SPEC 4.2 step 2.
  create_key_help: "Create a Project key with the Editor role in the project you want to use. A CU limit on the key caps what this plugin and connected agents can spend.",
  admins_only: "Only team admins and project owners can create keys.",
  no_account: "No account, or no plan with API access?",
  paste: "Paste the key and its secret.",
  storage_note: "Keys stay in Photoshop's secure storage on this computer.",
  add_title: "Add a key for another project",
  // SPEC 4.2 step 2: what Copy a request for your admin copies.
  admin_request: "Could you create a Scenario API key for me? Type: Project key, role: Editor, project: <the one I should use>, with a CU limit if you set one for third-party tools. It is for the Scenario plugin for Photoshop.",
  // Wireframe 1, after Copy a request for your admin.
  admin_copied: "Copied. Send it to your Scenario admin, then paste the key and secret they give you here.",
  // Wireframe 2, Projects view.
  projects_note: "Switching changes trained models, the Library and where results go. Running jobs keep their project.",
  // SPEC 3.14 and wireframe 13.
  sign_out_note: "Sign out removes the key from this computer. Delete it on app.scenario.com to revoke it.",
  sign_out_confirm: "Click again to remove this project's key from this computer.",
  connected: "Connected to Scenario",
  no_name_note: "(the API returned no project name)",
  copied: "Copied."
};

// SPEC 3.13 messages and actions for each state of a sign-in check.
// Actions: enter_again, create_key, open_plans, copy_admin_request,
// copy_error, retry.
var STATES = {
  key_refused: { text: "Scenario did not accept this key and secret.", actions: ["enter_again", "create_key"] },
  no_api_access: { text: "API keys need a Starter plan or above. This team's plan has no API access.", actions: ["open_plans", "copy_admin_request"] },
  cannot_generate: { text: "This key can't run models. Create a Project key with the Editor or Admin role.", actions: ["create_key", "copy_error"], scenario: true },
  team_key: { text: "This is a team (Organization) key. Generating needs a Project key.", actions: ["create_key"] },
  offline: { text: "No connection to Scenario. Check your network.", actions: ["retry"] },
  plan_limit: { text: "This key's or this plan's CU limit is reached. Nothing was sent.", actions: ["open_plans", "copy_error"] },
  // Not in the spec: the states below cover answers it does not name.
  busy: { text: "Scenario is busy. Try again in a moment.", actions: ["retry"] },
  failed: { text: "Scenario could not check this key.", actions: ["retry", "copy_error"], scenario: true },
  storage_failed: { text: "Photoshop's secure storage did not keep the key. Nothing was saved.", actions: ["retry", "copy_error"] },
  missing: { text: "Paste the API key and its secret.", actions: [] },
  not_signed_in: { text: "No key is saved. Add a key first.", actions: [] },
  in_progress: { text: "A test is already running.", actions: [] }
};

var ACTION_LABELS = {
  enter_again: "Enter key again",
  create_key: "Create an API key",
  open_plans: "Open plans",
  copy_admin_request: "Copy a request for your admin",
  copy_error: "Copy error",
  retry: "Retry"
};

var ROLE_NAMES = { reader: "Reader", editor: "Editor", admin: "Admin" };

function keyEnding(last4) {
  return "...." + last4;
}

// The header's project label: SPEC 3.13, "No project name from the API".
function projectLabel(account) {
  if (!account) return NOT_SIGNED_IN;
  return account.project_name || "Scenario project " + keyEnding(account.key_last4);
}

// Lines of the "Connected to Scenario" block (wireframe 1).
function connectedLines(account) {
  if (account.project_name) return [TEXT.connected, "Project: " + account.project_name, "Key " + keyEnding(account.key_last4)];
  return [TEXT.connected, "Project: " + projectLabel(account), TEXT.no_name_note];
}

function testing(step, total) {
  return "Testing " + step + " of " + total;
}

// SPEC 3.13, Rate limited (429) on a read.
function retrying(seconds) {
  return "Scenario is busy. Retrying in " + seconds + " s.";
}

// outcome: from auth.saveAndTest or auth.testConnection (ok false).
// Returns { text, detail, actions, copy }: copy is the one-line Copy error text.
function describeFailure(outcome) {
  var s = STATES[outcome.state] || STATES.failed;
  var detail = null;
  if (outcome.state === "cannot_generate" && outcome.role) {
    detail = "This key's role is " + (ROLE_NAMES[outcome.role] || outcome.role) + ".";
  } else if (s.scenario && outcome.scenario_message) {
    detail = "Scenario's message: " + outcome.scenario_message;
  }
  var copy = (outcome.type || "Internal") + ": " + s.text + (detail ? " " + detail : "");
  return { text: s.text, detail: detail, actions: s.actions.slice(), copy: copy };
}

function rowLabel(account) {
  return projectLabel(account) + "   " + keyEnding(account.key_last4);
}

module.exports = {
  NOT_SIGNED_IN: NOT_SIGNED_IN,
  TEXT: TEXT,
  STATES: STATES,
  ACTION_LABELS: ACTION_LABELS,
  projectLabel: projectLabel,
  connectedLines: connectedLines,
  testing: testing,
  retrying: retrying,
  describeFailure: describeFailure,
  rowLabel: rowLabel,
  keyEnding: keyEnding
};
