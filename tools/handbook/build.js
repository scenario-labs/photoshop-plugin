#!/usr/bin/env node
"use strict";
// Builds the Scenario for Photoshop handbook from the repository's Markdown
// docs, so the handbook never says something the docs do not.
//
//   npm run handbook                 web page, single-file HTML and PDF
//   npm run handbook -- --no-pdf     skip the PDF (no Chrome needed)
//   npm run handbook -- --out <dir>  write somewhere other than build/handbook
//
// Outputs: <out>/index.html with its media under <out>/media/, a
// self-contained <out>/scenario-photoshop-handbook-<version>.html, and
// <out>/scenario-photoshop-handbook-<version>.pdf printed by headless Google
// Chrome (CHROME_PATH, or the default install location). The PDF contents
// carry page numbers when Poppler's pdftotext is on the PATH.
//
// The chapters below say which doc sections go where. Pictures are whatever
// the docs reference under docs/media/, so new media shows up on a rebuild.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const md = require("./markdown.js");
const { CSS } = require("./style.js");
const { SCRIPT } = require("./script.js");
const EM_DASH = new RegExp(String.fromCharCode(0x2014));

const ROOT = path.resolve(__dirname, "..", "..");
const REPO_URL = "https://github.com/scenario-labs/photoshop-plugin";
const GITHUB_REF = process.env.HANDBOOK_GITHUB_REF || "main";
const BLOB = `${REPO_URL}/blob/${GITHUB_REF}/`;
const APP_URL = "https://app.scenario.com/";
// The public address of the site (GitHub Pages custom domain, served at the root).
const SITE_HOST = "photoshop.scenario.com";

// ---------------------------------------------------------------- options

function parseArgs(argv) {
  const opts = { out: path.join(ROOT, "build", "handbook"), pdf: true, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--no-pdf") opts.pdf = false;
    else if (argv[i] === "--quiet") opts.quiet = true;
    else if (argv[i] === "--out") opts.out = path.resolve(argv[++i]);
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return opts;
}

// ---------------------------------------------------------------- chapters
// Each chapter is one h2 of the handbook. A part takes a whole doc (its h1
// dropped, its h2s become h3s) or one h2 section of a doc (its content only).

const CHAPTERS = [
  { id: "what-it-does", title: "What it does", newPage: true, parts: [{ file: "README.md", section: "What it does" }], gallery: true },
  { id: "install", title: "Install", parts: [{ file: "README.md", section: "Install" }] },
  { id: "downloads", title: "Downloads", generated: "downloads" },
  { id: "quick-start", title: "Quick start", newPage: true, parts: [{ file: "docs/USER_GUIDE.md", section: "Quick start" }] },
  { id: "find-your-way-around", title: "Find your way around", parts: [{ file: "docs/USER_GUIDE.md", section: "Find your way around" }] },
  { id: "actions", title: "Actions", newPage: true, parts: [{ file: "docs/USER_GUIDE.md", section: "Actions" }] },
  { id: "selection-edits-inside-selection-or-bolder", title: "Selection edits: Inside selection or Bolder", parts: [{ file: "docs/USER_GUIDE.md", section: "Selection edits: Inside selection or Bolder" }] },
  { id: "takes", title: "Takes", parts: [{ file: "docs/USER_GUIDE.md", section: "Takes" }] },
  { id: "references", title: "References", parts: [{ file: "docs/USER_GUIDE.md", section: "References" }] },
  { id: "style-and-trained-models", title: "Style and trained models", parts: [{ file: "docs/USER_GUIDE.md", section: "Style and trained models" }] },
  { id: "library", title: "Library", parts: [{ file: "docs/USER_GUIDE.md", section: "Library" }] },
  { id: "jobs-and-recovery", title: "Jobs and recovery", parts: [{ file: "docs/USER_GUIDE.md", section: "Jobs and recovery" }] },
  { id: "settings", title: "Settings", parts: [{ file: "docs/USER_GUIDE.md", section: "Settings" }] },
  { id: "agents", title: "Agents (Scenario MCP)", newPage: true, parts: [{ file: "docs/MCP.md" }], alias: [["docs/USER_GUIDE.md", "agents"]] },
  { id: "costs", title: "Costs", newPage: true, parts: [{ file: "docs/USER_GUIDE.md", section: "Prices and approval" }] },
  { id: "what-leaves-your-machine", title: "What leaves your machine", parts: [{ file: "PRIVACY.md", skip: ["What is stored on your machine"] }] },
  { id: "files-and-folders", title: "Files and folders", newPage: true, parts: [{ file: "docs/USER_GUIDE.md", section: "Where results are saved" }, { file: "PRIVACY.md", only: "What is stored on your machine" }] },
  { id: "troubleshooting", title: "Troubleshooting", parts: [{ file: "docs/USER_GUIDE.md", section: "Troubleshooting" }] },
  { id: "known-limits", title: "Known limits", newPage: true, parts: [{ file: "docs/KNOWN_LIMITATIONS.md" }], alias: [["docs/USER_GUIDE.md", "not-in-this-build"]] },
  { id: "security", title: "Security", newPage: true, parts: [{ file: "SECURITY.md" }] },
  { id: "changelog", title: "Changelog", parts: [{ file: "CHANGELOG.md" }] },
  { id: "licence", title: "Licence", parts: [{ file: "README.md", section: "License" }], generated: "licence" }
];

// The names shown for links whose text is a bare file name.
const FILE_NAMES = {
  "README.md": "README",
  "docs/USER_GUIDE.md": "User Guide",
  "docs/MCP.md": "Agents (Scenario MCP)",
  "docs/KNOWN_LIMITATIONS.md": "Known limits",
  "docs/STATUS.md": "build status",
  "docs/spec/MCP.md": "Scenario MCP tool reference",
  "docs/spec/SPEC.md": "design specification",
  "PRIVACY.md": "Privacy",
  "SECURITY.md": "Security",
  "CHANGELOG.md": "Changelog",
  "AGENTS.md": "contributor guide",
  LICENSE: "LICENSE",
  "THIRD_PARTY_NOTICES.md": "third-party notices"
};

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const posix = (p) => p.split(path.sep).join("/");

function imageSize(file) {
  const b = fs.readFileSync(file);
  if (b.slice(1, 4).toString() === "PNG") return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.slice(0, 3).toString() === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4" };

function gitInfo() {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function formatDate(d) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------- docs

function splitSections(blocks) {
  const intro = [];
  const sections = [];
  let cur = null;
  for (const b of blocks) {
    if (b.type === "heading" && b.level === 1) continue;
    if (b.type === "heading" && b.level === 2) {
      cur = { title: b.text, slug: md.slug(b.text), blocks: [] };
      sections.push(cur);
      continue;
    }
    (cur ? cur.blocks : intro).push(b);
  }
  return { intro, sections };
}

function loadDocs() {
  const docs = {};
  for (const file of new Set(CHAPTERS.flatMap((c) => (c.parts || []).map((p) => p.file)))) {
    const blocks = md.parse(read(file));
    docs[file] = { file, blocks, ...splitSections(blocks) };
  }
  return docs;
}

function headingClone(b, level, file) {
  return { type: "heading", level, text: b.text, file, origSlug: md.slug(b.text) };
}

// Turns the chapter config into a list of chapters with their blocks, each
// block tagged with the doc it came from, and every heading given an id.
function assemble(docs) {
  const ids = new Set();
  const anchors = {}; // file -> original slug -> id
  const fileHome = {}; // file -> chapter id where it starts
  const reserved = new Set(CHAPTERS.map((c) => c.id));
  const take = (id, prefix) => {
    let v = id;
    if (prefix && (ids.has(v) || reserved.has(v))) v = `${prefix}-${id}`;
    for (let n = 2; ids.has(v); n++) v = `${id}-${n}`;
    ids.add(v);
    return v;
  };
  const mapAnchor = (file, s, id) => {
    anchors[file] = anchors[file] || {};
    if (!(s in anchors[file])) anchors[file][s] = id;
  };
  const chapters = [];
  for (const c of CHAPTERS) {
    const ch = { ...c, id: c.id, blocks: [] };
    ids.add(c.id);
    for (const part of c.parts || []) {
      const doc = docs[part.file];
      const tag = (b) => ({ ...b, file: part.file });
      if (!(part.file in fileHome)) fileHome[part.file] = ch.id;
      if (part.section) {
        const sec = doc.sections.find((s) => s.title === part.section);
        if (!sec) throw new Error(`${part.file}: no section "${part.section}"`);
        mapAnchor(part.file, sec.slug, ch.id);
        ch.blocks.push(...sec.blocks.map(tag));
      } else if (part.only) {
        const sec = doc.sections.find((s) => s.title === part.only);
        if (!sec) throw new Error(`${part.file}: no section "${part.only}"`);
        ch.blocks.push(headingClone({ text: sec.title }, 3, part.file), ...sec.blocks.map(tag));
      } else {
        ch.blocks.push(...doc.intro.map(tag));
        for (const sec of doc.sections) {
          if ((part.skip || []).includes(sec.title)) continue;
          ch.blocks.push(headingClone({ text: sec.title }, 3, part.file), ...sec.blocks.map(tag));
        }
      }
    }
    for (const [file, s] of c.alias || []) mapAnchor(file, s, ch.id);
    // Headings inside the chapter: h3 and deeper keep their level, at least h3.
    for (const b of ch.blocks) {
      if (b.type !== "heading") continue;
      if (b.level < 3) b.level = 3;
      b.origSlug = b.origSlug || md.slug(b.text);
      b.id = take(b.origSlug, ch.id);
      mapAnchor(b.file, b.origSlug, b.id);
    }
    chapters.push(ch);
  }
  return { chapters, anchors, fileHome, ids };
}

// ---------------------------------------------------------------- rendering

class Renderer {
  constructor(ctx) {
    this.ctx = ctx; // { anchors, fileHome, assets, problems, mode }
  }

  // A link or image target in doc `file`, resolved for the handbook.
  resolve(file, href, kind) {
    if (/^(https?:|mailto:)/.test(href)) return href;
    const [p, frag] = href.split("#");
    if (!p) return this.anchor(file, frag, href);
    const target = posix(path.normalize(path.join(path.dirname(file), p)));
    if (target.startsWith("docs/media/")) return this.asset(target, kind);
    if (this.ctx.anchors[target] || this.ctx.fileHome[target]) {
      if (frag) return this.anchor(target, frag, href, file);
      if (this.ctx.fileHome[target]) return `#${this.ctx.fileHome[target]}`;
    }
    if (!fs.existsSync(path.join(ROOT, target))) this.ctx.problems.push(`${file}: link to a missing file ${href}`);
    return BLOB + target + (frag ? `#${frag}` : "");
  }

  anchor(file, frag, href, from) {
    const id = this.ctx.anchors[file] && this.ctx.anchors[file][frag];
    if (!id) {
      this.ctx.problems.push(`${from || file}: link ${href} has no target in the handbook`);
      return `#${frag}`;
    }
    return `#${id}`;
  }

  asset(target, kind) {
    const abs = path.join(ROOT, target);
    if (!fs.existsSync(abs)) {
      this.ctx.problems.push(`missing media ${target}`);
      return target;
    }
    const rel = target.slice("docs/".length);
    this.ctx.assets.set(rel, abs);
    if (this.ctx.mode === "web") return rel;
    if (kind === "img") return `data:${MIME[path.extname(abs).toLowerCase()]};base64,${fs.readFileSync(abs).toString("base64")}`;
    return BLOB + target;
  }

  imgTag(file, src, alt, width) {
    const abs = path.join(ROOT, posix(path.normalize(path.join(path.dirname(file), src))));
    const size = fs.existsSync(abs) ? imageSize(abs) : null;
    return { src: this.resolve(file, src, "img"), alt, width, size, repoPath: posix(path.relative(ROOT, abs)) };
  }

  // Inline Markdown to HTML. Code spans and images are set aside first so
  // their text is never read as emphasis or links.
  inline(text, file) {
    const keep = [];
    const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
    let s = String(text).replace(/\n/g, " ");
    s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
    s = s.replace(/<img\b[^>]*>/gi, (tag) => {
      const a = attrs(tag);
      const im = this.imgTag(file, a.src || "", a.alt || "", a.width);
      return hold(`<img src="${esc(im.src)}" alt="${esc(im.alt)}" loading="lazy">`);
    });
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
      const im = this.imgTag(file, src, unesc(alt));
      return hold(`<img src="${esc(im.src)}" alt="${esc(im.alt)}" loading="lazy">`);
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const raw = unesc(href);
      const url = this.resolve(file, raw, "link");
      let shown = label;
      const bare = restore(label, keep).replace(/<\/?code>/g, "");
      const target = /^https?:/.test(raw) ? null : posix(path.normalize(path.join(path.dirname(file), raw.split("#")[0] || path.basename(file))));
      if (target && FILE_NAMES[target] && (bare === raw || bare === path.basename(target) || bare === target || bare === raw.split("#")[0])) shown = esc(FILE_NAMES[target]);
      const ext = /^https?:/.test(url) ? ' rel="noopener"' : "";
      return hold(`<a href="${esc(url)}"${ext}>${shown}</a>`);
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, (_, pre, t) => {
      const claim = claimClass(restore(t, keep));
      return `${pre}<em${claim ? ` class="claim ${claim}"` : ""}>${t}</em>`;
    });
    return restore(s, keep);
  }

  // A paragraph made only of pictures, as a figure.
  figure(b, caption) {
    const imgs = [];
    const rest = b.text
      .replace(/<img\b[^>]*>/gi, (tag) => {
        const a = attrs(tag);
        imgs.push(this.imgTag(b.file, a.src || "", a.alt || "", a.width));
        return "";
      })
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
        imgs.push(this.imgTag(b.file, src, alt));
        return "";
      });
    if (rest.trim() || !imgs.length) return null;
    const kind = (im) => (/before-after\//.test(im.repoPath) ? "ba" : /\.gif$/i.test(im.repoPath) ? "clip" : /screens\//.test(im.repoPath) ? "screen" : "wide");
    const cap = caption ? `<p class="fig-note">${this.inline(caption, b.file)}</p>` : "";
    if (imgs.every((im) => kind(im) === "screen")) {
      const shots = imgs
        .map((im) => `<figure class="shot">${zoomable(im)}<figcaption>${esc(im.alt)}</figcaption></figure>`)
        .join("");
      return `<div class="shots n${imgs.length}">${shots}${cap}</div>`;
    }
    return imgs
      .map((im) => {
        const k = kind(im);
        const label = k === "ba" ? "Before and after" : k === "clip" ? "Recording" : "";
        return `<figure class="fig fig-${k}">${zoomable(im)}<figcaption>${label ? `<span class="fig-label">${label}</span> ` : ""}${esc(im.alt)}${cap ? "" : ""}</figcaption>${cap}</figure>`;
      })
      .join("");
  }

  blocks(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.type === "para") {
        const next = list[i + 1];
        const cap = next && next.type === "para" && /^\*[^*][\s\S]*[^*]\*$|^\*[^*][\s\S]*\*\*[^*]+\*\*[^*]*\*$/.test(next.text.trim()) ? next.text.trim().slice(1, -1) : null;
        const fig = this.figure(b, cap);
        if (fig) {
          out.push(fig);
          if (cap) i++;
          continue;
        }
        out.push(`<p>${this.inline(b.text, b.file)}</p>`);
      } else if (b.type === "heading") {
        const h = `h${Math.min(b.level, 6)}`;
        out.push(`<${h} id="${b.id}">${this.inline(b.text, b.file)}<a class="anchor" href="#${b.id}" aria-label="Link to this section">#</a></${h}>`);
      } else if (b.type === "code") {
        out.push(`<pre><code${b.lang ? ` class="lang-${esc(b.lang)}"` : ""}>${esc(b.text)}</code></pre>`);
      } else if (b.type === "quote") {
        out.push(`<aside class="callout">${this.blocks(b.children.map((c) => tagFile(c, b.file)))}</aside>`);
      } else if (b.type === "table") {
        const head = b.head.map((c) => `<th scope="col">${this.inline(c, b.file)}</th>`).join("");
        const rows = b.rows.map((r) => `<tr>${r.map((c, k) => (k === 0 ? `<th scope="row">${this.inline(c, b.file)}</th>` : `<td>${this.inline(c, b.file)}</td>`)).join("")}</tr>`).join("");
        const emptyHead = b.head.every((c, k) => k > 0 ? !c.trim() : true) && b.head.length > 1 && !b.head[1].trim();
        out.push(`<div class="table-wrap"><table${emptyHead ? ' class="kv"' : ""}><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`);
      } else if (b.type === "list") {
        const tag = b.ordered ? "ol" : "ul";
        const items = b.items
          .map((item) => {
            const kids = item.map((c) => tagFile(c, b.file));
            if (kids.length === 1 && kids[0].type === "para" && !this.figure(kids[0])) return `<li>${this.inline(kids[0].text, b.file)}</li>`;
            if (kids.length && kids[0].type === "para" && !this.figure(kids[0])) return `<li>${this.inline(kids[0].text, b.file)}${this.blocks(kids.slice(1))}</li>`;
            return `<li>${this.blocks(kids)}</li>`;
          })
          .join("");
        out.push(`<${tag}${b.ordered && b.start !== 1 ? ` start="${b.start}"` : ""}>${items}</${tag}>`);
      }
    }
    return out.join("\n");
  }
}

function tagFile(b, file) {
  const t = { ...b, file };
  if (b.type === "list") t.items = b.items.map((it) => it.map((c) => tagFile(c, file)));
  if (b.type === "quote") t.children = b.children.map((c) => tagFile(c, file));
  return t;
}

function attrs(tag) {
  const a = {};
  for (const m of tag.matchAll(/([\w-]+)="([^"]*)"/g)) a[m[1].toLowerCase()] = m[2];
  return a;
}

function unesc(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function restore(s, keep) {
  let out = s;
  for (let n = 0; n < 4 && out.includes("\u0000"); n++) out = out.replace(/\u0000(\d+)\u0000/g, (_, k) => keep[Number(k)]);
  return out;
}

function claimClass(text) {
  const t = text.replace(/<[^>]+>/g, "").trim().toLowerCase();
  if (/^(verified live|seen live)/.test(t)) return "claim-live";
  if (/^not verified live|^not tested/.test(t)) return "claim-none";
  if (/^tested (automated|headless)/.test(t)) return "claim-auto";
  return "";
}

function zoomable(im, eager) {
  const size = im.size ? ` width="${im.size.w}" height="${im.size.h}"` : "";
  const load = eager ? ' fetchpriority="high"' : ' loading="lazy" decoding="async"';
  return `<button type="button" class="zoom" data-zoom aria-label="Enlarge: ${esc(im.alt)}"><img src="${esc(im.src)}" alt="${esc(im.alt)}"${size}${load}></button>`;
}

function blockText(list) {
  const parts = [];
  for (const b of list) {
    if (b.type === "para" || b.type === "heading") parts.push(md.plain(b.text));
    else if (b.type === "list") for (const it of b.items) parts.push(blockText(it));
    else if (b.type === "quote") parts.push(blockText(b.children));
    else if (b.type === "table") parts.push(md.plain([...b.head, ...b.rows.flat()].join(" ")));
    else if (b.type === "code") parts.push(b.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- generated parts

function heroDiagram() {
  const col = (cls, label, items) =>
    `<div class="flow-col ${cls}"><p class="flow-label">${label}</p><ul>${items.map(([t, href]) => `<li>${href ? `<a href="${href}">${t}</a>` : t}</li>`).join("")}</ul></div>`;
  const actions = [
    ["Replace inside", "#selection-actions"],
    ["Remove", "#selection-actions"],
    ["Make versions", "#layer-and-image-actions"],
    ["New layer", "#layer-and-image-actions"],
    ["Upscale", "#layer-and-image-actions"],
    ["Remove background", "#layer-and-image-actions"],
    ["Extend canvas", "#layer-and-image-actions"],
    ["Render sketch", "#layer-and-image-actions"],
    ["New angle", "#layer-and-image-actions"],
    ["Split into layers", "#layer-and-image-actions"],
    ["Formats", "#layer-and-image-actions"],
    ["Animate", "#layer-and-image-actions"]
  ];
  return `<div class="flow" role="group" aria-label="How Scenario for Photoshop works">
${col("flow-in", "From your document", [
  ["A selection, drawn with any tool", "#selection-actions"],
  ["The active layer or a cut-out", "#layer-and-image-actions"],
  ["The whole canvas"],
  ["References: a layer, a file or a Library image", "#references"],
  ["Your prompt, or none for one-click actions"]
])}
<div class="flow-col flow-mid"><p class="flow-label">Scenario models</p><ul class="flow-actions">${actions.map(([t, h]) => `<li><a href="${h}">${t}</a></li>`).join("")}</ul><p class="flow-price"><a href="#costs">Price on the button</a> checked free before you click. <a href="#style-and-trained-models">Trained models and styles</a> too.</p></div>
${col("flow-out", "Back in Photoshop", [
  ["Smart object layers, masked to your selection", "#selection-actions"],
  ["Takes as a group to compare", "#takes"],
  ["A mask on the layer for Remove background", "#layer-and-image-actions"],
  ["One History state per run", "#find-your-way-around"],
  ["Artboards in a new document for Formats", "#layer-and-image-actions"],
  ["A clip as a new document for Animate", "#layer-and-image-actions"],
  ["Scenario metadata on every layer", "#files-and-folders"]
])}
<p class="flow-agents"><a href="#agents">Agents</a> Claude Code, Codex, Cursor or Claude Desktop work in this Photoshop through the Scenario MCP, with a card in the panel before any credit is spent.</p>
</div>`;
}

function gallery(chapters, r) {
  // Every before and after picture in the Actions chapter, with the action
  // named in the paragraph just above it.
  const ch = chapters.find((c) => c.id === "actions");
  const cards = [];
  let lastAction = null;
  let lastHeading = "actions";
  for (const b of ch.blocks) {
    if (b.type === "heading") lastHeading = b.id;
    if (b.type !== "para") continue;
    const lead = /^\*\*([^*]+)\*\*/.exec(b.text);
    if (lead) lastAction = lead[1];
    const m = /^!\[([^\]]*)\]\(([^)\s]*before-after\/[^)\s]+)\)$/.exec(b.text.trim());
    if (m) {
      const im = r.imgTag(b.file, m[2], m[1]);
      cards.push(`<li class="ba-card"><a href="#${lastHeading}"><span class="ba-img"><img src="${esc(im.src)}" alt="" loading="lazy"${im.size ? ` width="${im.size.w}" height="${im.size.h}"` : ""}></span><span class="ba-title">${esc(lastAction || "Before and after")}</span><span class="ba-text">${esc(m[1])}</span></a></li>`);
    }
  }
  if (!cards.length) return "";
  return `<div class="gallery screen-only"><p class="eyebrow">Before and after, from live runs</p><ul class="ba-grid">${cards.join("")}</ul></div>`;
}

function downloads(meta, mode) {
  const link = (file, text) => (mode === "web" ? `<a href="${file}">${text}</a>` : `<strong>${text}</strong> (<code>${file}</code>)`);
  return `<ul>
<li>This handbook, ${meta.version}: ${link(meta.pdfName, "PDF for print, A4")} and ${link(meta.htmlName, "one HTML file that works offline")}.</li>
<li>The plugin is not on the Adobe Marketplace yet. Build the <code>.ccx</code> from the source and install it as described in <a href="#install">Install</a>.</li>
<li>The agent helper is not on npm yet. Agent clients run it from a checkout; see <a href="#agents">Agents (Scenario MCP)</a>.</li>
<li>Source code, issues and the changelog: <a href="${REPO_URL}" rel="noopener">github.com/scenario-labs/photoshop-plugin</a>, MIT license.</li>
</ul>`;
}

function licenceExtra(meta) {
  return `<p>The Scenario logo is a trademark of Scenario and is not covered by the MIT license.</p>
<p class="build-note">This handbook is generated from the Markdown docs in the repository (<code>npm run handbook</code>), version ${meta.version}${meta.commit ? `, commit <code>${meta.commit}</code>` : ""}, ${meta.date}.</p>`;
}

// ---------------------------------------------------------------- page

function page(meta, chapters, docs, mode, extra = {}) {
  const ctx = { anchors: meta.anchors, fileHome: meta.fileHome, assets: meta.assets, problems: meta.problems, mode };
  const r = new Renderer(ctx);
  const readme = docs["README.md"];
  const lede = readme.intro.find((b) => b.type === "para" && !/^!\[/.test(b.text.trim()));
  const heroBlock = readme.intro.find((b) => b.type === "para" && /^!\[[^\]]*\]\([^)]*hero\.[a-z]+\)$/.test(b.text.trim()));
  const notice = readme.intro.find((b) => b.type === "quote");
  const guideIntro = docs["docs/USER_GUIDE.md"].intro.find((b) => b.type === "para");
  const hero = heroBlock ? /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(heroBlock.text.trim()) : null;
  const heroImg = hero ? r.imgTag("README.md", hero[2], hero[1]) : null;
  const logo = fs.readFileSync(path.join(__dirname, "scenario-logo.svg"), "utf8").replace(/<!--[\s\S]*?-->\s*/, "").replace("<svg ", '<svg role="img" aria-label="Scenario" ');

  const index = [];
  const toc = [];
  const body = chapters
    .map((ch, n) => {
      let html = r.blocks(ch.blocks);
      if (ch.generated === "downloads") html = downloads(meta, mode);
      if (ch.generated === "licence") html += licenceExtra(meta);
      if (ch.gallery) html += gallery(chapters, r);
      const subs = ch.blocks.filter((b) => b.type === "heading" && b.level === 3);
      toc.push({ id: ch.id, title: ch.title, subs: subs.map((s) => ({ id: s.id, title: md.plain(s.text) })) });
      // Search entries: the chapter, then each of its h3 sections.
      const segs = [];
      let cur = { id: ch.id, title: ch.title, blocks: [] };
      for (const b of ch.blocks) {
        if (b.type === "heading" && b.level === 3) {
          segs.push(cur);
          cur = { id: b.id, title: md.plain(b.text), blocks: [] };
        } else cur.blocks.push(b);
      }
      segs.push(cur);
      for (const s of segs) index.push({ id: s.id, t: s.title, c: s.id === ch.id ? "" : ch.title, x: blockText(s.blocks).slice(0, 1600) });
      const num = String(n + 1).padStart(2, "0");
      return `<section class="chapter${ch.newPage ? " new-page" : ""}" aria-labelledby="${ch.id}">
<h2 id="${ch.id}"><span class="num" aria-hidden="true">${num}</span><span class="title">${esc(ch.title)}</span><a class="anchor" href="#${ch.id}" aria-label="Link to this section">#</a></h2>
${html}
</section>`;
    })
    .join("\n");

  const tocHtml = `<ol class="toc-list">${toc
    .map((t) => `<li><a href="#${t.id}">${esc(t.title)}</a>${t.subs.length ? `<ol>${t.subs.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`).join("")}</ol>` : ""}</li>`)
    .join("")}</ol>`;

  const pages = extra.pages || {};
  const printToc = `<nav class="print-toc print-only" aria-label="Contents"><h2 class="print-toc-title">Contents</h2><ol>${toc
    .map((t, n) => `<li><a href="#${t.id}"><span class="pt-num">${String(n + 1).padStart(2, "0")}</span><span class="pt-title">${esc(t.title)}</span><span class="pt-dots"></span><span class="pt-page">${pages[t.id] || "00"}</span></a></li>`)
    .join("")}</ol></nav>`;

  const cover = `<section class="cover print-only">
<div class="cover-logo">${logo}</div>
<div class="cover-main"><p class="eyebrow">Handbook</p><h1 class="cover-title">Scenario for Photoshop</h1><p class="cover-sub">${lede ? r.inline(lede.text, "README.md") : ""}</p></div>
${heroImg ? `<img class="cover-img" src="${esc(heroImg.src)}" alt="">` : ""}
<dl class="cover-meta"><div><dt>Version</dt><dd>${meta.version}, development build</dd></div><div><dt>Date</dt><dd>${meta.date}</dd></div><div><dt>Photoshop</dt><dd>2026 (27.x), tested on 27.11 on macOS</dd></div></dl>
</section>`;

  const notes = `<div class="notes">
${notice ? `<aside class="callout">${r.blocks(notice.children.map((c) => tagFile(c, "README.md")))}</aside>` : ""}
${guideIntro ? `<p>${r.inline(guideIntro.text, "docs/USER_GUIDE.md")}</p>` : ""}
<p>Screenshots may show earlier layouts, and the prices in them are examples, not quotes. Select a screenshot to enlarge it.</p>
</div>`;

  const intro = `<header class="hero" id="top">
<p class="eyebrow">Handbook <span class="dot" aria-hidden="true"></span> ${meta.version}</p>
<h1>Scenario for Photoshop</h1>
${lede ? `<p class="lede">${r.inline(lede.text, "README.md")}</p>` : ""}
<p class="hero-cta"><a class="button" href="#install">Install</a> <a class="button quiet" href="#quick-start">Quick start</a></p>
${heroImg ? `<figure class="fig fig-hero">${zoomable(heroImg, true)}<figcaption>${esc(heroImg.alt)}</figcaption></figure>` : ""}
${heroDiagram()}
${notes}
</header>`;

  const fonts = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">`;
  const searchJson = JSON.stringify(index).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html lang="en"${mode === "print" ? ' class="for-print" data-theme="light"' : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scenario for Photoshop Handbook</title>
<meta name="description" content="User handbook for Scenario for Photoshop ${meta.version}: install, every action with before and after pictures, prices and approval, agents through the Scenario MCP, privacy and known limits.">
<meta name="color-scheme" content="light dark">
${fonts}
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#guide">Skip to the handbook</a>
${cover}
${printToc}
<header class="topbar">
<div class="bar">
<a class="brand" href="#top" aria-label="Scenario for Photoshop, top of the handbook">${logo}<span class="product">for Photoshop</span></a>
<span class="version" title="Development build">${meta.version}</span>
<div class="search" role="search">
<label class="visually-hidden" for="q">Search the handbook</label>
<input id="q" type="search" placeholder="Search" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="q-results" aria-autocomplete="list">
<kbd class="search-key" aria-hidden="true">/</kbd>
<div class="search-panel" id="q-panel" hidden><ul id="q-results" role="listbox" aria-label="Matching sections"></ul><p class="search-status" id="q-status" aria-live="polite"></p></div>
</div>
<nav class="nav" aria-label="Site">
<a class="opt" href="#install">Install</a>
<a class="opt" href="#downloads">Downloads</a>
<a class="opt" href="#changelog">Changelog</a>
<a class="opt" href="${REPO_URL}" rel="noopener">GitHub</a>
<a class="button small" href="${APP_URL}" rel="noopener">App Login</a>
<button type="button" class="theme" id="theme" aria-label="Switch between light and dark" title="Light or dark"><span aria-hidden="true"></span></button>
</nav>
</div>
</header>
<div class="layout">
<nav class="side" aria-label="Contents">
<details class="side-box" id="side-box" open><summary>Contents</summary>${tocHtml}</details>
</nav>
<main id="guide" tabindex="-1">
${intro}
<article class="handbook">
${body}
</article>
<footer class="foot"><p>Scenario for Photoshop ${meta.version}${meta.commit ? `, built from commit <code>${meta.commit}</code>` : ""}, ${meta.date}. <a href="${REPO_URL}" rel="noopener">GitHub</a>, <a href="${APP_URL}" rel="noopener">app.scenario.com</a>, <a href="mailto:support@scenario.com">support@scenario.com</a>.</p><p>Adobe and Photoshop are trademarks of Adobe. This project is not affiliated with or endorsed by Adobe.</p></footer>
</main>
</div>
<dialog class="lightbox" id="lightbox" aria-label="Enlarged picture"><form method="dialog"><button class="lb-close" aria-label="Close">Close</button></form><img alt=""><p class="lb-cap"></p></dialog>
<script type="application/json" id="search-index">${searchJson}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
  return html;
}

// ---------------------------------------------------------------- checks

function check(full, outDir, label, problems, later = []) {
  const html = full.replace(/<script[\s\S]*?<\/script>/g, " ");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/href="#([^"]*)"/g)) if (m[1] && !ids.has(m[1])) problems.push(`${label}: link #${m[1]} has no target`);
  for (const m of html.matchAll(/\s(?:src|href)="([^"#][^"]*)"/g)) {
    const u = m[1];
    if (/^(https?:|mailto:|data:)/.test(u) || later.includes(u)) continue;
    if (!fs.existsSync(path.join(outDir, u))) problems.push(`${label}: ${u} does not resolve`);
  }
  for (const m of html.matchAll(/href="(https:\/\/github\.com\/scenario-labs\/photoshop-plugin\/blob\/[^/]+\/([^"#]+))/g)) {
    if (!fs.existsSync(path.join(ROOT, m[2]))) problems.push(`${label}: GitHub link to a file not in the repository: ${m[2]}`);
  }
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ");
  if (EM_DASH.test(text)) problems.push(`${label}: em dash`);
  if (/\/Users\/|\/home\/[a-z]|[A-Z]:\\Users\\/.test(text.replace(/data:[^"]+/g, ""))) problems.push(`${label}: machine path`);
  for (const m of text.replace(/data:[^"]+/g, "").matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
    if (m[0].toLowerCase() !== "support@scenario.com") problems.push(`${label}: email address ${m[0]}`);
  }
  // "Scenario MCP", never a bare "MCP", in what a reader sees (code aside).
  const visible = text.replace(/<code>[\s\S]*?<\/code>/g, " ").replace(/<[^>]+>/g, " ");
  for (const m of visible.matchAll(/(.{0,9})\bMCP\b/g)) if (!/Scenario $/.test(m[1])) problems.push(`${label}: bare "MCP" after "${m[1].trim()}"`);
}

// ---------------------------------------------------------------- PDF

function findChrome() {
  const c = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
  return c.find((p) => fs.existsSync(p)) || null;
}

function printPdf(chrome, htmlFile, pdfFile, profile) {
  const r = spawnSync(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--mute-audio",
      "--hide-scrollbars",
      `--user-data-dir=${profile}`,
      "--no-pdf-header-footer",
      "--virtual-time-budget=20000",
      "--run-all-compositor-stages-before-draw",
      `--print-to-pdf=${pdfFile}`,
      `file://${htmlFile}`
    ],
    { encoding: "utf8", timeout: 180000 }
  );
  if (r.status !== 0 || !fs.existsSync(pdfFile)) throw new Error(`Chrome could not print the PDF: ${(r.stderr || "").split("\n").slice(-3).join(" ")}`);
}

// The page each chapter starts on, read back from the printed PDF.
function chapterPages(pdfFile, chapters) {
  const r = spawnSync("pdftotext", ["-layout", pdfFile, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const pages = r.stdout.split("\f");
  const found = {};
  let from = 0;
  // Skip the cover and the contents pages.
  const tocEnd = pages.findIndex((p, i) => i > 0 && !/Contents/.test(p) && /\S/.test(p));
  from = Math.max(1, tocEnd);
  for (const [n, ch] of chapters.entries()) {
    const num = String(n + 1).padStart(2, "0");
    for (let p = from; p < pages.length; p++) {
      const hit = pages[p].split("\n").some((l) => l.trim().replace(/\s+/g, " ") === `${num} ${ch.title}`);
      if (hit) {
        found[ch.id] = p + 1;
        from = p;
        break;
      }
    }
  }
  return { found, count: pages.filter((p) => p.trim() || true).length - (pages[pages.length - 1].trim() ? 0 : 1) };
}

// ---------------------------------------------------------------- main

function build(opts) {
  const pkg = JSON.parse(read("package.json"));
  const when = process.env.HANDBOOK_DATE ? new Date(process.env.HANDBOOK_DATE) : new Date();
  const docs = loadDocs();
  const { chapters, anchors, fileHome } = assemble(docs);
  const meta = {
    version: pkg.version,
    date: formatDate(when),
    commit: gitInfo(),
    anchors,
    fileHome,
    assets: new Map(),
    problems: [],
    pdfName: `scenario-photoshop-handbook-${pkg.version}.pdf`,
    htmlName: `scenario-photoshop-handbook-${pkg.version}.html`
  };
  fs.mkdirSync(opts.out, { recursive: true });

  const web = page(meta, chapters, docs, "web");
  for (const [rel, abs] of meta.assets) {
    const dest = path.join(opts.out, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
  fs.writeFileSync(path.join(opts.out, "index.html"), web);
  fs.writeFileSync(path.join(opts.out, "CNAME"), `${SITE_HOST}\n`);
  const single = page(meta, chapters, docs, "single");
  fs.writeFileSync(path.join(opts.out, meta.htmlName), single);

  const problems = meta.problems;
  check(web, opts.out, "index.html", problems, [meta.pdfName]);
  check(single, opts.out, meta.htmlName, problems);
  if (/\s(?:src)="(?!data:|https:)/.test(single)) problems.push(`${meta.htmlName}: a picture is not embedded`);
  const result = { out: opts.out, version: meta.version, pages: null, pdf: null, problems: [...new Set(problems)] };
  if (result.problems.length) return result;

  if (opts.pdf) {
    const chrome = findChrome();
    if (!chrome) {
      result.problems.push("Google Chrome not found: set CHROME_PATH, or build with --no-pdf");
      return result;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-handbook-"));
    const printFile = path.join(tmp, "print.html");
    const pdfFile = path.join(opts.out, meta.pdfName);
    const printHtml = page(meta, chapters, docs, "print");
    check(printHtml, opts.out, "print", result.problems);
    fs.writeFileSync(printFile, printHtml);
    printPdf(chrome, printFile, pdfFile, path.join(tmp, "profile"));
    const first = chapterPages(pdfFile, chapters);
    if (first && Object.keys(first.found).length === chapters.length) {
      fs.writeFileSync(printFile, page(meta, chapters, docs, "print", { pages: first.found }));
      printPdf(chrome, printFile, pdfFile, path.join(tmp, "profile"));
      const second = chapterPages(pdfFile, chapters);
      result.pages = second ? second.count : null;
      if (second && JSON.stringify(second.found) !== JSON.stringify(first.found)) result.problems.push("PDF contents page numbers moved between passes");
    } else if (first) {
      result.pages = first.count;
      result.problems.push(`PDF contents: page numbers not found for ${chapters.filter((c) => !first.found[c.id]).map((c) => c.title).join(", ")}`);
    }
    result.pdf = pdfFile;
    check(web, opts.out, "index.html", result.problems);
  }
  return result;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const r = build(opts);
  if (r.problems.length) {
    process.stderr.write(r.problems.join("\n") + `\n\nhandbook: ${r.problems.length} problem(s)\n`);
    process.exit(1);
  }
  if (!opts.quiet) {
    process.stdout.write(`handbook ${r.version}: ${path.relative(ROOT, r.out) || "."}/index.html\n`);
    if (r.pdf) process.stdout.write(`pdf: ${path.relative(ROOT, r.pdf)}${r.pages ? `, ${r.pages} pages` : ""}\n`);
  }
}

module.exports = { build, CHAPTERS, SITE_HOST };
