<!--
The PR title becomes the squash commit header: type(scope): summary.
Use an imperative summary, no trailing period, and at most 120 characters.
Scopes: bridge, scenario, catalog, forms, auth, jobs, apply, capture, lanes,
panel, ui, agents, host, util, manifest, build, dev, helper, shared, tests,
live, handbook, docs, spec, ci, deps, release, repo
(see tools/commitlint/commitlint.config.mjs).
Example: fix(panel): keep the button in view on short panels

Keep one concern per PR and the description short. Tick only checks you did;
leave the rest unticked without comment. Never claim review, results or
authorization that has not happened.
-->

## What does this PR change?

<!--
One to three sentences: the problem and what changes. Add a before/after only
for a behavior change. Name any action needed after merge and any known gap.
Closes #n for complete issue scope; Refs #n otherwise, saying what remains.
Show a visible change with screenshots of the panel, before/after for UI.
-->

## Validation

- [ ] `npm test` and `npm run lint` pass; commands and results are listed below.
- [ ] Build or packaging changes pass `npm run package`, and the `.ccx` contents were inspected.
- [ ] Docs changes build with `npm run handbook -- --no-pdf`.
- [ ] Panel or Photoshop changes were tried in Photoshop with a development build; Photoshop and OS versions are listed, with before/after screenshots of the panel for UI.
- [ ] Each claim says how it was checked (*verified live*, *tested automated* or *not tested*); any paid run had prior authorization for its project and budget.

Commands and results:

<!-- One line per command run and its result. Keep the line above: it stops
GitHub merging this list into the checklist. -->

## Public content

- [ ] No credentials, pairing tokens, signed URL query strings, or private account, project, job or asset IDs are included.
- [ ] No machine paths, personal or customer names, email addresses, agent session IDs or spend anecdotes are included.

## Rules

- [ ] The money contract in `AGENTS.md` still holds (a price check through the one dry-run constant first, single-use quotes, the job record before anything is sent, paid requests sent once and never retried, No-spend and `SCENARIO_NO_SPEND` honored).
- [ ] Scenario keys go only to Scenario's API, and the pairing token is never logged, printed or sent.
- [ ] No unrelated version or changelog edits; documentation matches the resulting behavior.

## Authorship and licensing

- [ ] Human review of the complete diff is recorded before merge.
- [ ] Adopted third-party code or assets keep their compatible licenses and attribution; original contributions are licensed under MIT, the repository license.

<!-- If an agent contributed, name the harness and keep accurate co-author
trailers on commits and in the final squash message. -->
