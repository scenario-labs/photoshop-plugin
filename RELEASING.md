# Releasing

Releases are made by `.github/workflows/release-please.yml`, which follows blender-plugin's release workflow. Nobody edits version fields, edits the release-please entries of `CHANGELOG.md`, creates a tag or publishes a release by hand.

## How a release happens

1. Pull requests are squash-merged with a Conventional Commit title (`tools/commitlint/commitlint.config.mjs`). That title is what the changelog says.
2. On each push to `main`, release-please keeps one pull request open, **chore(release): release photoshop-plugin X.Y.Z**. It sets the next version in `plugin/manifest.json`, `helper/package.json`, `helper/npm-shrinkwrap.json` and the helper's entry in `package-lock.json`, and writes the changelog entry above "Hand-written history" in `CHANGELOG.md`. Before 1.0, a `feat` raises the minor version and anything else the patch; a `Release-As: X.Y.Z` footer in a commit sets the version.
3. Merging that pull request is the decision to release. The same workflow run then:
   - creates a draft release targeting the release commit;
   - builds `scenario-photoshop-X.Y.Z.ccx` and the standalone handbook `scenario-photoshop-handbook-X.Y.Z.html` from that commit;
   - checks the package with `tools/release/check-package.js`: the five packaged files, this commit's manifest, page, styles and licence byte for byte, and a release bundle identical to a fresh build;
   - writes `SHA256SUMS`, attests the three files, and attaches them with the Sigstore bundle `scenario-photoshop-X.Y.Z.sigstore.json`;
   - adds a Contributors section to the notes (`tools/release/contributors.js`; never blocks the release);
   - checks the package again on macOS (a build there must give the same bytes);
   - publishes the draft, which creates the tag `photoshop-plugin-vX.Y.Z`;
   - opens the next release pull request.

   **Publish site** (`.github/workflows/pages.yml`) runs after this workflow, and **publish-changelog** (`.github/workflows/publish-changelog.yml`) on the published release: see [Public changelog](#public-changelog).

The first release starts from the tag `photoshop-plugin-v0.7.1` on 3132c14; there is no GitHub release before it.

## What it needs

Set once by an administrator:

- The release GitHub App installed on this repository, and the organization secrets `GH_ACTIONS_TOKEN_RETRIEVER_PUBLIC_REPO_CLIENT_ID` and `GH_ACTIONS_TOKEN_RETRIEVER_PUBLIC_REPO_PRIVATE_KEY` available to it. Without them every run stops at "Retrieve GitHub App token". Pull requests and releases are made with the App's token because GitHub starts no workflow from an event made with `GITHUB_TOKEN`: the release pull request would get no CI.
- A tag ruleset on `photoshop-plugin-v*` that only the App can bypass, as blender-plugin's "versioning".
- Immutable releases, once the first release is published and checked.
- The secret `CHANGELOG_INGEST_SECRET` available to this repository (an organization secret, as for blender-plugin and godot-plugin), and `photoshop-plugin` known to the changelog ingest of www.scenario.com as a source in the Plugins group. Without the secret publish-changelog fails; without the source the ingest answers HTTP 400.

## Check a release

```sh
gh release download photoshop-plugin-vX.Y.Z --repo scenario-labs/photoshop-plugin
sha256sum -c SHA256SUMS
gh attestation verify scenario-photoshop-X.Y.Z.ccx --repo scenario-labs/photoshop-plugin
```

## Public changelog

`.github/workflows/publish-changelog.yml`, as in blender-plugin, posts the notes of each published stable release to the changelog of www.scenario.com, where they show under Plugins with a `Plugins - Photoshop` title. It runs on `release: published` (the publish job flips the draft with the App's token, so the event starts it) or by hand with a published tag (Actions > publish-changelog > Run workflow). Notes with no `### ` section post nothing.

It checks the answer for this release's version, since an HTTP 200 alone can carry a processing error. `queued` means accepted for processing, which is asynchronous; `already exists` means the version was received before, not that it shows. Either way, check that the entry appears at [scenario.com/changelog](https://www.scenario.com/changelog). After a timeout or an ingest error, check the changelog and the run before re-running: the workflow never posts twice by itself nor asks for an overwrite. If an existing entry does not show, ask the changelog's maintainer. This recovery is apart from the release: it never rebuilds or republishes release files.

## When a release run fails

Re-run the failed jobs of that same workflow run (Actions > release-please). A draft has no tag yet, which hides it from release-please, so `tools/release/find-draft.js` hands the draft back to the run of its own commit only; a run for a later push to `main` stops with "Rerun the original release workflow for <sha>" instead of building the draft from newer code. The assets job also refuses to build anything but the release commit, so the attestation always names it. Recovery is *tested automated* (fake GitHub answers) and *not tested* on GitHub.
