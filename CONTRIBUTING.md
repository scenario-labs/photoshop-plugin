# Contributing to Scenario for Photoshop

Thanks for helping. This guide covers what a pull request needs; the commands, rules and code map live in [AGENTS.md](AGENTS.md), which humans and coding agents both follow.

## Before you start

- For anything larger than a small fix, open a change request first ([issue chooser](https://github.com/scenario-labs/photoshop-plugin/issues/new/choose)) so the approach can be agreed before you write it.
- Read the rules for code in `AGENTS.md`, above all the money contract (a price check through the one dry-run constant first, single-use quotes, the job record written before anything is sent, a paid request sent once and never retried, No-spend and `SCENARIO_NO_SPEND=1` honored) and the secrets rules (Scenario keys go only to Scenario's API; the pairing token is never logged, printed or sent). Every change keeps them.

## Set up

- Node.js 20 or 22 and git. `npm ci` installs the helper's one run-time dependency; the tests use only Node's built-in modules.
- For changes in Photoshop: Photoshop 27.11 on macOS and a development build (`npm run package:dev`), installed as `AGENTS.md` describes.
- For the commit checks: Node.js 22.12 or later, then `npm ci --prefix tools/commitlint --ignore-scripts`.

## Run the checks

`npm test` (unit and integration tests on a fake Photoshop and a mock of Scenario's API, 0 CU) and `npm run lint` for every change, `npm run package` for build and packaging changes, and `npm run handbook -- --no-pdf` for changes to the docs the handbook is built from. CI runs `npm run lint`, `npm test` and `npm run package` on Node 20 and 22, on Ubuntu and macOS.

The checks under `test/live/` run against a live Photoshop and are not part of `npm test`. Several spend Creative Units: they need authorization for the project and budget first.

## Commits and pull requests

- Branch from `main`. Pull requests are squash-merged: the PR title becomes the commit header, so it follows Conventional Commits with a scope from `tools/commitlint/commitlint.config.mjs`, for example `fix(panel): keep the button in view on short panels`. CI checks the title and every commit message with that config.
- Keep one concern per pull request and fill the template briefly: the checks you ran, any action needed after merge and any known gap. Tick only what you ran.
- Say how each claim was checked, as the docs do: *verified live* (in Photoshop), *tested automated* or *not tested*.
- Note a change people will notice under **Unreleased** in `CHANGELOG.md`. Version fields change only for a new build.
- Show panel changes with before/after screenshots at the docked width (280 px), attached to the pull request rather than committed. Pictures for the docs go under `docs/media/`.
- The repository is public: no machine paths, personal or customer names, email addresses, secrets or em dashes. `npm run lint` checks what it can.

## Coding agents

Agents follow AGENTS.md. Name the harness in the pull request and keep accurate co-author trailers on commits and in the squash message. A human reviews the complete diff before merge.

## Licensing

The repository is under the [MIT License](LICENSE). By contributing, you agree that your contributions are licensed under the same terms. What the plugin and the helper depend on is MIT-compatible, pinned to exact versions and listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the commit checks under `tools/commitlint/` run in CI and on contributors' machines only and ship in neither. Code or assets adopted from elsewhere keep their compatible license and attribution.
