"use strict";
// Tool errors travel as one line, "Type: message" (docs/spec/MCP.md section 8).

const errors = require("../../shared/errors.json");

class ToolError extends Error {
  constructor(type, message) {
    super(String(message).replace(/\s*[\r\n]+\s*/g, " "));
    this.type = errors.types[type] ? type : "Internal";
    this.name = "ToolError";
  }

  toString() {
    return `${this.type}: ${this.message}`;
  }

  // Reads "Type: message" back into a ToolError. Unknown types become Internal.
  static parse(line) {
    const text = typeof line === "string" ? line : String(line);
    const i = text.indexOf(": ");
    if (i > 0 && errors.types[text.slice(0, i)]) return new ToolError(text.slice(0, i), text.slice(i + 2));
    return new ToolError("Internal", text);
  }
}

function asLine(err) {
  if (err instanceof ToolError) return err.toString();
  if (err && typeof err.type === "string" && errors.types[err.type]) return `${err.type}: ${err.message}`;
  return `Internal: ${(err && err.message) || String(err)}`;
}

module.exports = { ToolError, asLine };
