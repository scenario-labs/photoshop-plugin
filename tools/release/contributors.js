#!/usr/bin/env node
"use strict";
// Thanks a draft release's pull request authors, as GitHub's generated notes
// list them: release-please's notes name no authors. Ported from
// blender-plugin's tools/release_contributors.py. The workflow runs it with
// continue-on-error: a missing thank-you never holds back a release.
//
//   GH_REPO=owner/repo TAG=photoshop-plugin-vX.Y.Z RELEASE_SHA=<sha> node tools/release/contributors.js
//
// The notes cover the pull requests since the highest earlier release tag.
// blender-plugin takes the latest published release instead; the first
// Photoshop release has none, only the photoshop-plugin-v0.7.1 tag.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PREFIX, REPO_RE, SHA_RE, TAG_RE, ReleaseError, gh, ghJson, tagVersion, compareVersions, failure } = require("./github.js");

const HEADING = "### Contributors";
const AUTHOR_RE = / by @([A-Za-z0-9-]+(?:\[bot\])?) in https:\/\/\S+$/;
const FIRST_RE = /^\* @([A-Za-z0-9-]+) made their first contribution in https:\/\/\S+$/;

// The human authors (sorted, one spelling each) and GitHub's first-contribution
// lines, from generated notes.
function contributors(notes) {
  const authors = new Map();
  const first = [];
  for (const raw of notes.split("\n")) {
    const line = raw.trim();
    const author = AUTHOR_RE.exec(line);
    if (author) {
      if (!author[1].endsWith("[bot]") && !authors.has(author[1].toLowerCase())) authors.set(author[1].toLowerCase(), author[1]);
    } else if (FIRST_RE.test(line)) {
      first.push(line);
    }
  }
  return { logins: [...authors.keys()].sort().map((k) => authors.get(k)), first };
}

function mentionList(logins) {
  const names = logins.map((l) => `@${l}`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// The body with a Contributors section, or null when there is nothing to add.
function withContributors(body, notes) {
  if (new RegExp(`^${HEADING}\\s*$`, "m").test(body)) return null;
  const { logins, first } = contributors(notes);
  if (!logins.length) return null;
  let section = `${HEADING}\n\nThanks to ${mentionList(logins)}.\n`;
  if (first.length) section += `\n${first.join("\n")}\n`;
  return `${body.trimEnd()}\n\n${section}`;
}

// The highest release tag below `tag`.
function previousTag(repo, tag, request) {
  const pages = request(["api", `repos/${repo}/git/matching-refs/tags/${PREFIX}`, "--paginate", "--slurp"]);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new ReleaseError("GitHub returned an invalid tag list");
  const current = tagVersion(tag);
  let best = null;
  for (const ref of pages.flat()) {
    const name = typeof (ref || {}).ref === "string" ? ref.ref.replace(/^refs\/tags\//, "") : "";
    const v = tagVersion(name);
    if (v && compareVersions(v, current) < 0 && (!best || compareVersions(v, best.v) > 0)) best = { name, v };
  }
  if (!best) throw new ReleaseError(`No release tag before ${tag}`);
  return best.name;
}

function update(repo, tag, sha, request = ghJson, run = gh) {
  if (!REPO_RE.test(repo || "")) throw new ReleaseError("GH_REPO must identify an owner/repository");
  if (!TAG_RE.test(tag || "") || !SHA_RE.test(sha || "")) throw new ReleaseError("TAG and RELEASE_SHA must be a stable release tag and a full commit SHA");
  const draft = request(["release", "view", tag, "--json", "body,isDraft,targetCommitish"]);
  if (draft.isDraft !== true || String(draft.targetCommitish || "").toLowerCase() !== sha.toLowerCase()) {
    throw new ReleaseError(`${tag} is not the draft for ${sha}`);
  }
  const previous = previousTag(repo, tag, request);
  const notes = request([
    "api", "--method", "POST", `repos/${repo}/releases/generate-notes`,
    "-f", `tag_name=${tag}`, "-f", `target_commitish=${sha}`, "-f", `previous_tag_name=${previous}`
  ]).body || "";
  const body = withContributors(draft.body || "", notes);
  if (body === null) return false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-"));
  try {
    const file = path.join(dir, "notes.md");
    fs.writeFileSync(file, body);
    run(["release", "edit", tag, "--notes-file", file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

function main(env = process.env, request = ghJson, run = gh, out = process.stdout, err = process.stderr) {
  try {
    const changed = update(env.GH_REPO, env.TAG, env.RELEASE_SHA, request, run);
    out.write(changed ? "Added the Contributors section\n" : "No Contributors section to add\n");
    return 0;
  } catch (error) {
    err.write(failure("Cannot list release contributors", error));
    return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { contributors, mentionList, withContributors, previousTag, update, main };
