"use strict";
// Replaces one server entry in a Codex config.toml without a full TOML parser.
// It works line by line: it finds the tables named [mcp_servers.<name>] and
// [mcp_servers.<name>.<sub>], removes them, and appends the new tables at the
// end. Everything else is kept byte for byte. When the file uses a form this
// editor cannot read safely (multi-line strings, the entry written as dotted
// keys or an inline table, unbalanced brackets), it refuses and changes nothing.

class TomlEditError extends Error {}

const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const HEADER = new RegExp(String.raw`^\s*(\[\[?)\s*(${KEY}(?:\s*\.\s*${KEY})*)\s*(\]\]?)\s*(?:#.*)?$`);

function unquote(key) {
  const k = key.trim();
  if (k.startsWith('"')) {
    try {
      return JSON.parse(k);
    } catch {
      return k.slice(1, -1);
    }
  }
  if (k.startsWith("'")) return k.slice(1, -1);
  return k;
}

function splitKeys(path) {
  const keys = [];
  const re = new RegExp(KEY, "g");
  let m;
  while ((m = re.exec(path)) !== null) keys.push(unquote(m[0]));
  return keys;
}

function parseHeader(line) {
  const m = HEADER.exec(line);
  if (!m) return null;
  const open = m[1];
  const close = m[3];
  if (open.length !== close.length) return null;
  return { array: open.length === 2, keys: splitKeys(m[2]) };
}

// Net count of [ { minus ] } outside strings and comments.
function bracketDelta(line) {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "#") break;
    if (c === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "'") {
      i++;
      while (i < line.length && line[i] !== "'") i++;
      continue;
    }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth;
}

function basicString(value) {
  return JSON.stringify(String(value));
}

function sameKeys(a, b) {
  return a.length >= b.length && b.every((k, i) => a[i] === k);
}

function renderBlock(name, entry, eol) {
  const lines = [`[mcp_servers.${name}]`, `command = ${basicString(entry.command)}`, `args = [${entry.args.map(basicString).join(", ")}]`];
  const envKeys = Object.keys(entry.env || {});
  if (envKeys.length) {
    lines.push("", `[mcp_servers.${name}.env]`);
    for (const k of envKeys) lines.push(`${k} = ${basicString(entry.env[k])}`);
  }
  return lines.join(eol) + eol;
}

// Returns { text, replaced }. Throws TomlEditError when the file cannot be edited safely.
function upsertServer(text, name, entry) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new TomlEditError("server name must be a bare TOML key");
  const source = text || "";
  if (source.includes('"""') || source.includes("'''")) {
    throw new TomlEditError("the file uses multi-line strings, which this editor does not change");
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.length ? source.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const headers = [];
  let depth = 0;
  let table = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (depth === 0) {
      const h = parseHeader(line);
      if (h) {
        headers.push({ index: i, keys: h.keys, array: h.array });
        table = h.keys;
        continue;
      }
      const trimmed = line.trim();
      if (trimmed !== "" && !trimmed.startsWith("#")) {
        const keyMatch = new RegExp(String.raw`^\s*(${KEY}(?:\s*\.\s*${KEY})*)\s*=`).exec(line);
        if (keyMatch) {
          const full = table.concat(splitKeys(keyMatch[1]));
          // The entry, or the mcp_servers table, written as dotted keys or an inline table.
          if (full[0] === "mcp_servers" && (full.length === 1 || (full[1] === name && table.length < 2))) {
            throw new TomlEditError(`the file defines mcp_servers.${name} with dotted keys or an inline table, which this editor does not change`);
          }
        } else if (bracketDelta(line) === 0) {
          throw new TomlEditError(`line ${i + 1} is not a table header or a key/value pair`);
        }
      }
    }
    depth += bracketDelta(line);
    if (depth < 0) throw new TomlEditError(`unbalanced brackets near line ${i + 1}`);
  }
  if (depth !== 0) throw new TomlEditError("unbalanced brackets at the end of the file");

  const target = ["mcp_servers", name];
  const remove = new Set();
  let replaced = false;
  for (let h = 0; h < headers.length; h++) {
    if (!sameKeys(headers[h].keys, target)) continue;
    if (headers[h].array) throw new TomlEditError(`mcp_servers.${name} is an array of tables`);
    replaced = true;
    const end = h + 1 < headers.length ? headers[h + 1].index : lines.length;
    for (let i = headers[h].index; i < end; i++) remove.add(i);
  }
  const kept = lines.filter((_, i) => !remove.has(i));
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const head = kept.length ? kept.join(eol) + eol + eol : "";
  return { text: head + renderBlock(name, entry, eol), replaced };
}

module.exports = { upsertServer, TomlEditError, parseHeader, bracketDelta };
