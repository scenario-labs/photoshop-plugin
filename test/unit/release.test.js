"use strict";
// Release automation (.github/workflows/release-please.yml, as in
// blender-plugin): release-please's configuration against the files that hold
// the version and the changelog, the draft recovery and contributor scripts
// (tools/release/, with fake gh answers), the package check, and the
// workflow's job order.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { findDraft, main: findDraftMain } = require("../../tools/release/find-draft.js");
const { contributors, mentionList, withContributors, update, main: contributorsMain } = require("../../tools/release/contributors.js");
const { checkPackage, ENTRIES } = require("../../tools/release/check-package.js");
const { packagePlugin, zip } = require("../../plugin/scripts/package.js");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));
const CONFIG = json("release-please-config.json");
const PKG = CONFIG.packages["."];
const VERSION = json("plugin/manifest.json").version;
const WORKFLOW = read(".github/workflows/release-please.yml");

// The value at one of the JSONPath forms the configuration uses: $.a.b and
// $.a[''].b.
function at(obj, jsonpath) {
  const keys = [...jsonpath.slice(1).matchAll(/\.([A-Za-z_]+)|\['([^']*)'\]/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
  return keys.reduce((o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), obj);
}

test("release-please tags photoshop-plugin-vX.Y.Z from the manifest's version, as a draft first", () => {
  assert.equal(PKG["release-type"], "simple");
  assert.equal(PKG.component, "photoshop-plugin");
  assert.equal(PKG["include-component-in-tag"], true);
  assert.equal(PKG["include-v-in-tag"], true);
  assert.equal(PKG["tag-separator"], "-");
  assert.equal(PKG.draft, true, "the workflow attaches the files to a draft, then publishes it");
  assert.equal(PKG["bump-minor-pre-major"], true, "before 1.0, a feature bumps the minor version");
  assert.deepEqual(json(".release-please-manifest.json"), { ".": VERSION });
  // The release PR's title is its squash commit header: it must pass commitlint.
  assert.match(CONFIG["pull-request-title-pattern"], /^chore\(release\): /);
});

test("every copy of the version is one release-please updates, and they agree", () => {
  assert.deepEqual(PKG["extra-files"], [
    { type: "json", path: "plugin/manifest.json", jsonpath: "$.version" },
    { type: "json", path: "helper/package.json", jsonpath: "$.version" },
    { type: "json", path: "helper/npm-shrinkwrap.json", jsonpath: "$.version" },
    { type: "json", path: "helper/npm-shrinkwrap.json", jsonpath: "$.packages[''].version" }
  ]);
  for (const f of PKG["extra-files"]) assert.equal(at(json(f.path), f.jsonpath), VERSION, `${f.path} ${f.jsonpath}`);
  // The two private packages carry no version, so nothing else can drift;
  // pnpm-lock.yaml records no workspace package's version.
  assert.equal(json("package.json").version, undefined);
  assert.equal(json("plugin/package.json").version, undefined);
  // No other JSON file in the repository spells the version out.
  const counts = {};
  const skip = new Set(["node_modules", ".git", "build", "fixtures", "site"]);
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        if (!skip.has(name)) walk(full);
      } else if (name.endsWith(".json")) {
        const n = fs.readFileSync(full, "utf8").split(`"version": "${VERSION}"`).length - 1;
        if (n) counts[path.relative(ROOT, full).split(path.sep).join("/")] = n;
      }
    }
  })(ROOT);
  delete counts[".release-please-manifest.json"];
  assert.deepEqual(counts, { "helper/npm-shrinkwrap.json": 2, "helper/package.json": 1, "plugin/manifest.json": 1 });
});

test("manifest.json keeps the layout release-please writes back, so a release changes one line", () => {
  const text = read("plugin/manifest.json");
  assert.equal(text, JSON.stringify(JSON.parse(text), null, 2) + "\n");
});

test("the changelog takes release-please's entries above the hand-written history", () => {
  const text = read("CHANGELOG.md");
  assert.equal(text.split("\n## [Hand-written history]\n").length, 2, "one Hand-written history heading");
  // release-please inserts its entry before the first match of this pattern
  // (its default versionHeaderRegex).
  const first = text.slice(text.search(/\n###? v?[0-9[]/) + 1).split("\n")[0];
  const entry = /^## \[(\d+\.\d+\.\d+)\]\(/.exec(first);
  if (entry) assert.equal(entry[1], VERSION, "the newest release-please entry is the manifest's version");
  else assert.equal(first, "## [Hand-written history]", "before the first release-please release");
});

// ------------------------------------------------------------- find-draft.js

const REPO = "scenario-labs/photoshop-plugin";
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const APP = "gh-actions-token-retriever-public[bot]";
const draft = (over = {}) => ({ id: 7, tag_name: "photoshop-plugin-v0.8.0", draft: true, prerelease: false, target_commitish: SHA, author: { login: APP }, ...over });
const releasesAnswer = (pages) => (args) => {
  assert.deepEqual(args, ["api", `repos/${REPO}/releases?per_page=100`, "--paginate", "--slurp"]);
  return pages;
};

test("find-draft: no draft, or drafts of other tags, means a fresh release-please run", () => {
  const pages = [[draft({ draft: false }), draft({ tag_name: "blender-plugin-v0.8.0" }), { id: 1, tag_name: "v0.1.0", draft: true }]];
  assert.deepEqual(findDraft(REPO, SHA, releasesAnswer(pages)), { found: "false" });
});

test("find-draft: the original run recovers its one verified draft, from any page", () => {
  const pages = [[draft({ draft: false, tag_name: "photoshop-plugin-v0.7.9" })], [draft({ target_commitish: SHA.toUpperCase() })]];
  assert.deepEqual(findDraft(REPO, SHA, releasesAnswer(pages)), { found: "true", tag_name: "photoshop-plugin-v0.8.0", sha: SHA, release_id: "7" });
});

test("find-draft: two drafts, an unsafe draft or another commit fail instead of choosing", () => {
  assert.throws(() => findDraft(REPO, SHA, releasesAnswer([[draft(), draft({ id: 8 })]])), /Multiple Photoshop release drafts/);
  const unsafe = [
    [{ tag_name: "photoshop-plugin-v0.8" }, /stable photoshop-plugin-vX.Y.Z tag/],
    [{ prerelease: true }, /stable photoshop-plugin-vX.Y.Z tag/],
    [{ author: { login: "someone" } }, /not created by the release GitHub App/],
    [{ author: null }, /not created by the release GitHub App/],
    [{ target_commitish: "main" }, /full commit SHA, not a branch/],
    [{ id: "7" }, /no valid release ID/],
    [{ id: 0 }, /no valid release ID/]
  ];
  for (const [over, message] of unsafe) assert.throws(() => findDraft(REPO, SHA, releasesAnswer([[draft(over)]])), message, JSON.stringify(over));
  assert.throws(() => findDraft(REPO, OTHER, releasesAnswer([[draft()]])), /Rerun the original release workflow for a{40}; newer pushes must not rebuild/);
  assert.throws(() => findDraft("not a repo", SHA, releasesAnswer([])), /GH_REPO/);
  assert.throws(() => findDraft(REPO, "abc", releasesAnswer([])), /GITHUB_SHA/);
  assert.throws(() => findDraft(REPO, SHA, () => [{}]), /invalid paginated release list/);
});

test("find-draft: outputs are written only after every check, and failures print no API data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "find-draft-"));
  try {
    const out = path.join(dir, "out");
    const err = { text: "", write(s) { this.text += s; } };
    const env = { GH_REPO: REPO, GITHUB_SHA: SHA, GITHUB_OUTPUT: out };
    assert.equal(findDraftMain(env, releasesAnswer([[draft()]]), err), 0);
    assert.equal(fs.readFileSync(out, "utf8"), `found=true\ntag_name=photoshop-plugin-v0.8.0\nsha=${SHA}\nrelease_id=7\n`);
    fs.rmSync(out);
    assert.equal(findDraftMain({ ...env, GITHUB_SHA: OTHER }, releasesAnswer([[draft()]]), err), 1);
    assert.equal(fs.existsSync(out), false);
    const secret = Object.assign(new Error("HTTP 401 with token ghs_secret"), { name: "Error" });
    assert.equal(findDraftMain(env, () => { throw secret; }, err), 1);
    assert.match(err.text, /::error::Cannot recover a release draft: Rerun the original/);
    assert.match(err.text, /::error::Cannot recover a release draft: Error\n$/);
    assert.ok(!err.text.includes("ghs_secret"));
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------- contributors.js

const NOTES = [
  "## What's Changed",
  "* feat(auth): sign in by @qchantel in https://github.com/scenario-labs/photoshop-plugin/pull/7",
  "* fix(deps): Bump ws by @dependabot[bot] in https://github.com/scenario-labs/photoshop-plugin/pull/10",
  "* ci(ci): publish the site by @hervenivon in https://github.com/scenario-labs/photoshop-plugin/pull/12",
  "* docs: again by @QChantel in https://github.com/scenario-labs/photoshop-plugin/pull/15",
  "",
  "## New Contributors",
  "* @hervenivon made their first contribution in https://github.com/scenario-labs/photoshop-plugin/pull/12"
].join("\n");

test("contributors: unique human authors, sorted, with GitHub's first-contribution lines", () => {
  assert.deepEqual(contributors(NOTES), {
    logins: ["hervenivon", "qchantel"],
    first: ["* @hervenivon made their first contribution in https://github.com/scenario-labs/photoshop-plugin/pull/12"]
  });
  assert.equal(mentionList(["a"]), "@a");
  assert.equal(mentionList(["a", "b"]), "@a and @b");
  assert.equal(mentionList(["a", "b", "c"]), "@a, @b and @c");
});

test("contributors: the section follows the generated notes, once, and only for people", () => {
  assert.equal(
    withContributors("## [0.8.0](link)\n\n### Features\n\n* thing\n\n", NOTES),
    "## [0.8.0](link)\n\n### Features\n\n* thing\n\n### Contributors\n\nThanks to @hervenivon and @qchantel.\n\n* @hervenivon made their first contribution in https://github.com/scenario-labs/photoshop-plugin/pull/12\n"
  );
  assert.equal(withContributors("notes\n\n### Contributors\n\nThanks.\n", NOTES), null);
  assert.equal(withContributors("notes", "* bump by @dependabot[bot] in https://github.com/x/y/pull/1"), null);
});

// A fake gh: the draft, the release tags and the generated notes.
function fakeGh({ isDraft = true, target = SHA, tags = ["photoshop-plugin-v0.7.1"], body = "## [0.8.0](link)\n" } = {}) {
  const calls = [];
  const request = (args) => {
    calls.push(args);
    if (args[0] === "release") return { body, isDraft, targetCommitish: target };
    if (args[1] === `repos/${REPO}/git/matching-refs/tags/photoshop-plugin-v`) return [tags.map((t) => ({ ref: `refs/tags/${t}` }))];
    if (args.includes(`repos/${REPO}/releases/generate-notes`)) return { body: NOTES };
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const edits = [];
  const run = (args) => edits.push({ args, notes: fs.readFileSync(args[4], "utf8") });
  return { calls, request, run, edits };
}

test("contributors: the draft gets the authors since the highest earlier release tag", () => {
  const g = fakeGh({ tags: ["photoshop-plugin-v0.6.0", "photoshop-plugin-v0.7.1", "photoshop-plugin-v0.8.0", "photoshop-plugin-v0.10.0", "photoshop-plugin-v0.7.10x"] });
  assert.equal(update(REPO, "photoshop-plugin-v0.8.0", SHA, g.request, g.run), true);
  assert.ok(g.calls.some((a) => a.includes("previous_tag_name=photoshop-plugin-v0.7.1") && a.includes(`target_commitish=${SHA}`)));
  assert.equal(g.edits.length, 1);
  assert.deepEqual(g.edits[0].args.slice(0, 4), ["release", "edit", "photoshop-plugin-v0.8.0", "--notes-file"]);
  assert.match(g.edits[0].notes, /### Contributors\n\nThanks to @hervenivon and @qchantel\./);
  assert.equal(fs.existsSync(g.edits[0].args[4]), false, "the notes file is removed");
});

test("contributors: a published release, another commit or no earlier tag change nothing", () => {
  for (const [opts, message] of [[{ isDraft: false }, /is not the draft/], [{ target: OTHER }, /is not the draft/], [{ tags: ["photoshop-plugin-v0.8.0"] }, /No release tag before/]]) {
    const g = fakeGh(opts);
    assert.throws(() => update(REPO, "photoshop-plugin-v0.8.0", SHA, g.request, g.run), message);
    assert.equal(g.edits.length, 0);
  }
  assert.throws(() => update(REPO, "v0.8.0", SHA, fakeGh().request, fakeGh().run), /stable release tag/);
  const out = { text: "", write(s) { this.text += s; } };
  const err = { text: "", write(s) { this.text += s; } };
  const g = fakeGh({ isDraft: false });
  assert.equal(contributorsMain({ GH_REPO: REPO, TAG: "photoshop-plugin-v0.8.0", RELEASE_SHA: SHA }, g.request, g.run, out, err), 1);
  assert.equal(out.text, "");
  assert.equal(err.text, `::error::Cannot list release contributors: photoshop-plugin-v0.8.0 is not the draft for ${SHA}\n`);
});

// ---------------------------------------------------------- check-package.js

test("check-package: the release package passes; a development or altered one does not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-package-test-"));
  try {
    const release = packagePlugin({ outDir: dir, distFile: path.join(dir, "dist", "main.js") });
    assert.deepEqual(release.entries, ENTRIES);
    assert.deepEqual(checkPackage(release.file, VERSION), []);
    assert.match(checkPackage(release.file, "9.9.9").join("\n"), /expected scenario-photoshop-9\.9\.9\.ccx[\s\S]*manifest version is .*, expected 9\.9\.9/);

    const dev = packagePlugin({ dev: true, outDir: path.join(dir, "dev") });
    const devAsRelease = path.join(dir, "dev", `scenario-photoshop-${VERSION}.ccx`);
    fs.renameSync(dev.file, devAsRelease);
    assert.match(checkPackage(devAsRelease, VERSION).join("\n"), /\(release build\)[\s\S]*not the release build/);

    const bytes = fs.readFileSync(release.file);
    const damaged = path.join(dir, "damaged", `scenario-photoshop-${VERSION}.ccx`);
    fs.mkdirSync(path.dirname(damaged));
    const copy = Buffer.from(bytes);
    copy[30 + "manifest.json".length + 5] ^= 1;
    fs.writeFileSync(damaged, copy);
    assert.deepEqual(checkPackage(damaged, VERSION), [`scenario-photoshop-${VERSION}.ccx: manifest.json: checksum does not match`]);

    const extra = path.join(dir, "extra", `scenario-photoshop-${VERSION}.ccx`);
    fs.mkdirSync(path.dirname(extra));
    const entries = ENTRIES.map((name) => ({ name, data: name === "dist/main.js" ? fs.readFileSync(path.join(dir, "dist", "main.js")) : fs.readFileSync(path.join(ROOT, name === "LICENSE" ? "LICENSE" : `plugin/${name}`)) }));
    fs.writeFileSync(extra, zip([...entries, { name: "dev-oauth-target.json", data: Buffer.from("{}") }]));
    assert.match(checkPackage(extra, VERSION).join("\n"), /entries are .*dev-oauth-target\.json; expected/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ workflow

test("the release workflow runs on main, builds and checks before it publishes, then opens the next PR", () => {
  // Publish site (pages.yml) runs after this workflow by this name.
  assert.match(WORKFLOW, /^name: release-please$/m);
  assert.match(WORKFLOW, /^on:\n {2}push:\n {4}branches: \[main\]\n\n/m, "runs on pushes to main only");
  const needs = (job) => {
    const block = WORKFLOW.split(new RegExp(`^ {2}${job}:\\n`, "m"))[1].split(/^ {2}\S/m)[0];
    const m = /^ {4}needs: (.+)$/m.exec(block);
    return { block, needs: m ? m[1] : null };
  };
  assert.equal(needs("assets").needs, "release-please");
  assert.equal(needs("validate").needs, "[release-please, assets]");
  assert.equal(needs("publish").needs, "[release-please, assets, validate]");
  assert.equal(needs("release-pr").needs, "[release-please, publish]");
  // The thank-you comes before publication and never blocks it.
  const assets = needs("assets").block;
  assert.match(assets, /- name: Thank the release's contributors in the draft notes\n\s+continue-on-error: true\n[\s\S]*node tools\/release\/contributors\.js/);
  assert.match(assets, /node tools\/release\/check-package\.js "dist\/scenario-photoshop-\$\{VERSION\}\.ccx" "\$VERSION"/);
  assert.match(needs("validate").block, /node tools\/release\/check-package\.js/);
  // What the assets job attaches is what the publish job requires.
  const attached = /gh release upload "\$TAG" (.+) --clobber/.exec(assets)[1].split(" ").map((f) => f.replace(/^"?dist\//, "").replace(/"$/, "").replace("${VERSION}", "$V"));
  const publish = needs("publish").block;
  const required = ["SHA256SUMS", ...[...publish.matchAll(/--arg (?!sha )\w+ "([^"]+)"/g)].map((m) => m[1])];
  assert.deepEqual([...attached].sort(), [...required].sort());
  // Every write goes through the release App's token.
  for (const m of WORKFLOW.matchAll(/^\s+(?:token|GH_TOKEN): (.+)$/gm)) assert.equal(m[1], "${{ steps.app-token.outputs.token }}");
});
