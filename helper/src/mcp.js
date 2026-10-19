"use strict";
// MCP over stdio: newline-delimited JSON-RPC 2.0 on stdin and stdout.
// Written by hand to keep the helper free of runtime dependencies other than
// the WebSocket library. stdout carries protocol messages only; logs go to stderr.

const schema = require("../../shared/schema-check.js");
const { ToolError, asLine } = require("./errors.js");

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const OUTPUT_SCHEMA_SINCE = "2025-06-18";
const MAX_LINE = 16 * 1024 * 1024;

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603
};

class McpServer {
  // catalog: shared/catalog.json. handlers: { toolName: async (args, ctx) => result }.
  constructor({ input, output, catalog, handlers, version, log, onInitialize, timeouts }) {
    this.input = input;
    this.output = output;
    this.catalog = catalog;
    this.handlers = handlers;
    this.version = version;
    this.log = log || (() => {});
    this.onInitialize = onInitialize || (() => {});
    this.timeouts = timeouts || {};
    this.protocolVersion = SUPPORTED_VERSIONS[0];
    this.clientInfo = null;
    this.buffer = "";
    this.cancelled = new Set();
    this.tools = new Map(catalog.tools.map((t) => [t.name, t]));
  }

  start() {
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk) => this._onData(chunk));
    return new Promise((resolve) => {
      this.input.on("end", resolve);
      this.input.on("close", resolve);
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE && this.buffer.indexOf("\n") < 0) {
      this.buffer = "";
      this._send({ jsonrpc: "2.0", id: null, error: { code: ERR.parse, message: "Parse error: message too large" } });
      return;
    }
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim() !== "") this._onLine(line);
    }
  }

  _send(message) {
    this.output.write(JSON.stringify(message) + "\n");
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this._send({ jsonrpc: "2.0", id: null, error: { code: ERR.parse, message: "Parse error" } });
      return;
    }
    if (Array.isArray(msg)) {
      if (!msg.length) {
        this._send({ jsonrpc: "2.0", id: null, error: { code: ERR.invalidRequest, message: "Invalid Request: empty batch" } });
        return;
      }
      Promise.all(msg.map((m) => this._handle(m))).then((replies) => {
        const out = replies.filter((r) => r !== null);
        if (out.length) this.output.write(JSON.stringify(out) + "\n");
      });
      return;
    }
    this._handle(msg).then((reply) => {
      if (reply !== null) this._send(reply);
    });
  }

  // Returns the response object, or null for notifications and responses.
  async _handle(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id: null, error: { code: ERR.invalidRequest, message: "Invalid Request" } };
    }
    const isRequest = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== null && typeof msg.method === "string";
    const isNotification = !Object.prototype.hasOwnProperty.call(msg, "id") && typeof msg.method === "string";
    if (!isRequest && !isNotification) {
      // A response from the client (we send no requests), or a malformed message.
      if (typeof msg.method !== "string" && (msg.result !== undefined || msg.error !== undefined)) return null;
      return { jsonrpc: "2.0", id: msg.id === undefined ? null : msg.id, error: { code: ERR.invalidRequest, message: "Invalid Request" } };
    }
    if (isNotification) {
      if (msg.method === "notifications/cancelled" && msg.params && msg.params.requestId !== undefined) {
        this.cancelled.add(msg.params.requestId);
      }
      return null;
    }
    const id = msg.id;
    try {
      const result = await this._request(msg.method, msg.params || {}, id);
      if (this.cancelled.delete(id)) return null;
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      if (this.cancelled.delete(id)) return null;
      const code = err && Number.isInteger(err.rpcCode) ? err.rpcCode : ERR.internal;
      return { jsonrpc: "2.0", id, error: { code, message: err && err.message ? err.message : "Internal error" } };
    }
  }

  async _request(method, params, id) {
    switch (method) {
      case "initialize":
        return this._initialize(params);
      case "ping":
        return {};
      case "tools/list":
        return { tools: this._listTools() };
      case "tools/call":
        return this._callTool(params, id);
      case "resources/list":
        return { resources: [] };
      case "prompts/list":
        return { prompts: [] };
      default: {
        const e = new Error(`Method not found: ${method}`);
        e.rpcCode = ERR.methodNotFound;
        throw e;
      }
    }
  }

  _initialize(params) {
    const asked = params && typeof params.protocolVersion === "string" ? params.protocolVersion : null;
    this.protocolVersion = asked && SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
    this.clientInfo = params && params.clientInfo && typeof params.clientInfo === "object" ? params.clientInfo : null;
    const name = this.clientInfo && typeof this.clientInfo.name === "string" ? this.clientInfo.name : null;
    this.onInitialize(name);
    return {
      protocolVersion: this.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.catalog.server.name, title: this.catalog.server.title, version: this.version },
      instructions: this.catalog.server.instructions
    };
  }

  _withOutputSchema() {
    return this.protocolVersion >= OUTPUT_SCHEMA_SINCE;
  }

  _listTools() {
    return this.catalog.tools.map((t) => {
      const tool = { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations };
      if (t.outputSchema && this._withOutputSchema()) tool.outputSchema = t.outputSchema;
      return tool;
    });
  }

  async _callTool(params, id) {
    const name = params && params.name;
    const tool = typeof name === "string" ? this.tools.get(name) : undefined;
    const handler = tool && this.handlers[name];
    if (!tool || !handler) {
      const e = new Error(`Unknown tool: ${name}`);
      e.rpcCode = ERR.invalidParams;
      throw e;
    }
    let args = params.arguments;
    if (args === undefined || args === null) args = {};
    const problems = schema.validate(tool.inputSchema, args);
    if (problems.length) return this._toolError(new ToolError("InvalidParameter", problems.join("; ")));
    const limit = this.timeouts[name] || 120000;
    let timer;
    try {
      const result = await Promise.race([
        handler(args, { client_name: this.clientInfo && this.clientInfo.name, request_id: id }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ToolError("Timeout", `${name} took longer than ${Math.round(limit / 1000)} s.`)), limit);
        })
      ]);
      if (tool.outputSchema) {
        const bad = schema.validate(tool.outputSchema, result);
        if (bad.length) {
          this.log(`${name} produced output outside its schema: ${bad.join("; ")}`);
          return this._toolError(new ToolError("Internal", `${name} produced an unexpected result; update the helper and the plugin to the same version.`));
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (err) {
      return this._toolError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  _toolError(err) {
    return { content: [{ type: "text", text: asLine(err) }], isError: true };
  }
}

module.exports = { McpServer, SUPPORTED_VERSIONS };
