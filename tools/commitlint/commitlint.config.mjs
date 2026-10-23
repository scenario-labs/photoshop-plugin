// Single source of truth for commit headers and pull request titles. CI
// installs commitlint from the lockfile next to this file
// (.github/workflows/pr-name.yml and commitlint.yml); it lives here, outside
// the npm workspaces, so the root `npm ci` still installs only what the helper
// runs on. The same check locally, with Node 22.12 or later:
//
//   npm ci --prefix tools/commitlint --ignore-scripts
//   printf '%s\n' "fix(panel): keep the button in view" \
//     | tools/commitlint/node_modules/.bin/commitlint --config tools/commitlint/commitlint.config.mjs

// U+2014 written as a code point so that this file contains no em dash itself.
const EM_DASH = String.fromCharCode(0x2014);

/** @type {import('@commitlint/types').Plugin} */
const houseRules = {
  rules: {
    // House style: no em dashes anywhere, commit messages and PR titles included.
    "no-em-dash": ({ raw }) => [
      !(raw ?? "").includes(EM_DASH),
      "no em dashes in commit messages or PR titles (house style)",
    ],
  },
};

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [houseRules],
  rules: {
    // Allow longer headers than the 100-character default (same as the sibling repos).
    "header-max-length": [2, "always", 120],
    // Off: long URLs and Co-Authored-By trailers exceed the 100-character default.
    "body-max-line-length": [0, "always", 200],
    "footer-max-line-length": [0, "always", 200],
    // Off: UXP, MCP, GPT, CU and model names start many subjects.
    "subject-case": [0],
    // Warn, never fail: a change across the whole repository may have no scope.
    "scope-empty": [1, "never"],
    // The areas of the code map in AGENTS.md.
    "scope-enum": [
      2,
      "always",
      [
        "bridge", // plugin/src/bridge/: link, proofs, pairing token, status and catalog tools
        "scenario", // plugin/src/scenario/: REST client, price checks, the paid request, downloads, uploads
        "catalog", // plugin/src/catalog/: model list, tabs, trained models
        "forms", // plugin/src/forms/: schemas, validation, quotes, prices
        "auth", // plugin/src/auth/: saved keys, sign-in, projects
        "jobs", // plugin/src/jobs/: ledger, runner, recovery, Unknown jobs, charges
        "apply", // plugin/src/apply/: placement plans and the checks after an edit
        "capture", // plugin/src/capture/: captures, masks, references
        "lanes", // plugin/src/lanes/: Edit, Expand, Upscale, Remove BG and the P2 tools
        "panel", // plugin/src/panel/: actions, controller, Image path, Library reads
        "ui", // plugin/src/ui/, index.html, styles.css: the panel's look
        "agents", // plugin/src/agents/ and the agent cards: tools, allow-list, approvals
        "host", // plugin/src/host.js and host-more.js: everything read from UXP and Photoshop
        "util", // plugin/src/util/: hashes, encodings, PNG, JPEG, XMP
        "manifest", // plugin/manifest.json
        "build", // plugin/scripts/: the bundler and the .ccx package
        "dev", // plugin/src/dev/: development builds only (imports, UI loop, live entry, test hooks)
        "helper", // helper/: the scenario-photoshop MCP server, link owner, setup
        "shared", // shared/: tool catalog, protocol, catalog map, errors, API settings
        "tests", // test harness only (test/helpers, test/run.js, test/lint.js); a test for a product area keeps the product scope
        "live", // test/live/: manual checks against a running Photoshop
        "handbook", // tools/handbook/
        "docs", // README.md, docs/, PRIVACY.md, SECURITY.md
        "spec", // docs/spec/
        "ci", // .github/workflows, .github/dependabot.yml
        "deps", // pins: ws, actions, commitlint
        "release", // version fields, CHANGELOG.md
        "repo", // LICENSE, community files, templates, AGENTS.md, .agents/, .claude/, editor and lint configs
      ],
    ],
    "no-em-dash": [2, "always"],
  },
};
