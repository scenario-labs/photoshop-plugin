"use strict";
// The plugin's answers to list_models, model_schema and estimate_cost
// (MCP.md 4.2). Free: reads, and price checks that create no job. A price
// check goes through the same quote code as the panel (forms/quotes.js).
//
// estimate_cost takes one of capture_id (the agent tools' captures, which
// bind the placement target), a canvas or a new_document target, or none;
// file inputs the lane fills from the document and the agent has not
// uploaded yet are priced by the measured stand-in rules.

var errorsMod = require("../scenario/errors.js");
var map = require("../catalog/map.js");
var trainedMod = require("../catalog/trained.js");
var schemaMod = require("../forms/schema.js");
var requests = require("../forms/requests.js");

var DESCRIPTION_MAX = 300;
var LIMIT_DEFAULT = 20;
var LIMIT_MAX = 40;

function invalid(text) {
  return new errorsMod.ScenarioError("InvalidParameter", text);
}

function cut(text) {
  return text.length > DESCRIPTION_MAX ? text.slice(0, DESCRIPTION_MAX - 3) + "..." : text;
}

function maxReferences(schema) {
  if (!schema) return null;
  var n = null;
  for (var i = 0; i < schema.file_inputs.length; i++) if (schema.file_inputs[i].role === "reference") n = schema.file_inputs[i].max;
  return n;
}

function maxOutput(schema) {
  if (!schema) return null;
  if (schema.output_max_px) return schema.output_max_px;
  return schema.size_inputs.kind === "grid" ? schema.size_inputs.max : null;
}

// o: { catalog, quotes, host, settings, captureRequest(args, schema) -> req
//      (agent captures), onQuote(quote, req, args) (the agent tools keep
//      what each quote priced) }
function createCatalogTools(o) {
  // Schemas already read this session (no new reads for a listing).
  var known = {};
  function remember(s) {
    known[s.model_id] = s;
    return s;
  }

  function rowOut(row, derived) {
    var s = known[row.id] || null;
    var out = {
      model_id: row.id,
      name: row.name,
      description: cut(row.description),
      lanes: derived ? derived.lanes : map.lanesOf(row),
      // A trained model takes a mask only through a base whose route is a mask.
      accepts_mask: derived ? derived.edit_route === "mask" : map.acceptsMask(row, s),
      max_references: maxReferences(s),
      max_output: maxOutput(s),
      experimental: !!(derived && derived.edit_route)
    };
    if (derived) {
      out.trained = true;
      out.public = derived.public;
      out.trained_type = derived.trained_type;
      out.trained_kind = derived.trained_kind;
      out.base_model_ids = derived.base_model_ids;
      out.default_scale = derived.default_scale;
      out.max_loras = derived.max_loras;
      out.make_new = derived.make_new;
      out.edit_route = derived.edit_route;
      out.supported = derived.supported;
    }
    return out;
  }

  async function listModels(args) {
    var lane = args.lane === undefined || args.lane === null ? null : args.lane;
    if (lane !== null) requests.checkLane(lane);
    var source = args.source || "all";
    if (["catalog", "trained", "all"].indexOf(source) < 0) throw invalid("source must be catalog, trained or all.");
    var limit = args.limit === undefined || args.limit === null ? LIMIT_DEFAULT : args.limit;
    if (!(limit >= 1 && limit <= LIMIT_MAX) || limit % 1) throw invalid("limit must be 1 to " + LIMIT_MAX + ".");
    var offset = 0;
    if (args.cursor !== undefined && args.cursor !== null) {
      var m = /^o(\d{1,6})$/.exec(String(args.cursor));
      if (!m) throw invalid("cursor is not one this tool returned.");
      offset = Number(m[1]);
    }
    var rows = await o.catalog.ensure();
    var words = String(args.query || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    var tab = lane ? map.laneTab(lane) : null;
    var pickIds = tab ? map.picks(rows, tab) : [];
    var picked = rows.filter(function (row) {
      var tabs = map.tabsOf(row);
      if (!tabs.length) return false;
      var trained = row.type !== "custom";
      if (source === "catalog" && trained) return false;
      if (source === "trained" && !trained) return false;
      if (lane && !trained && map.lanesOf(row).indexOf(lane) < 0) return false;
      if (lane && trained && lane !== "image" && lane !== "edit") return false;
      if (words.length) {
        var hay = [row.name, row.description, row.type].concat(row.tags, row.compliant).join(" ").toLowerCase();
        for (var w = 0; w < words.length; w++) if (hay.indexOf(words[w]) < 0) return false;
      }
      return true;
    });
    picked.sort(function (a, b) {
      var ta = a.type !== "custom" ? 1 : 0;
      var tb = b.type !== "custom" ? 1 : 0;
      if (ta !== tb) return ta - tb;
      if (ta && a.project !== b.project) return a.project ? -1 : 1;
      var pa = pickIds.indexOf(a.id);
      var pb = pickIds.indexOf(b.id);
      pa = pa < 0 ? pickIds.length : pa;
      pb = pb < 0 ? pickIds.length : pb;
      if (pa !== pb) return pa - pb;
      return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
    });
    var bases = null;
    var out = [];
    var i = offset;
    // Trained rows need their bases; a lane filter on trained rows needs the
    // derived lanes, so the page is filled row by row.
    while (i < picked.length && out.length < limit) {
      var row = picked[i++];
      if (row.type === "custom") {
        out.push(rowOut(row, null));
        continue;
      }
      if (!bases) bases = await o.catalog.baseSchemas();
      var d = trainedMod.derive(row, bases);
      if (lane && d.lanes.indexOf(lane) < 0) continue;
      out.push(rowOut(row, d));
    }
    return { models: out, next_cursor: i < picked.length ? "o" + i : null };
  }

  async function modelSchema(args) {
    var s = remember(await o.catalog.schema(args.model_id));
    return schemaMod.forAgents(s);
  }

  // The document a canvas target names, with the agent switches applied.
  function canvasTarget(canvas) {
    var active = o.host.activeDocumentId();
    var id = canvas.document_id === undefined || canvas.document_id === null ? active : canvas.document_id;
    if (id === null || id === undefined) throw new errorsMod.ScenarioError("DocumentClosed", "No document is open.");
    var switches = o.settings.switches();
    if (switches.active_document_only && id !== active) throw new errorsMod.ScenarioError("DocumentNotAllowed", "Agents read the active document only.");
    var size = o.host.documentSize(id);
    if (!size) throw new errorsMod.ScenarioError("DocumentClosed", "Document " + id + " is not open.");
    var box = canvas.box;
    if (box !== undefined && box !== null) {
      if (!Array.isArray(box) || box.length !== 4 || box.some(function (n) { return typeof n !== "number" || !isFinite(n) || n % 1; })) throw invalid("canvas.box is [x, y, width, height] in whole pixels.");
      if (box[2] < 1 || box[3] < 1 || box[0] < 0 || box[1] < 0 || box[0] + box[2] > size.width || box[1] + box[3] > size.height) throw invalid("canvas.box must lie inside the document (" + size.width + " x " + size.height + ").");
    } else {
      box = [0, 0, size.width, size.height];
    }
    return { target: { kind: "canvas", document_id: id, box: box }, size: { width: box[2], height: box[3] } };
  }

  async function estimateCost(args) {
    var hasCapture = args.capture_id !== undefined && args.capture_id !== null;
    var hasCanvas = args.canvas !== undefined && args.canvas !== null;
    var hasNew = args.new_document !== undefined && args.new_document !== null;
    if ((hasCanvas ? 1 : 0) + (hasNew ? 1 : 0) + (hasCapture ? 1 : 0) > 1) throw invalid("Pass one of capture_id, canvas or new_document.");
    if (hasCapture && !o.captureRequest) throw invalid("capture_id is not available here.");
    var target = null;
    var sourceSize = null;
    if (hasCanvas) {
      var c = canvasTarget(args.canvas);
      target = c.target;
      sourceSize = c.size;
    } else if (hasNew) {
      var nd = args.new_document;
      if (!(nd.width >= 1 && nd.height >= 1) || nd.width % 1 || nd.height % 1) throw invalid("new_document needs whole-pixel width and height.");
      target = { kind: "new_document", width: nd.width, height: nd.height };
    }
    var lane = args.lane;
    requests.checkLane(lane);
    if (!sourceSize && lane !== "image") {
      // Enhance and Edit read the active document when no box is given.
      var active = o.host.activeDocumentId();
      if (active !== null && active !== undefined) {
        var size = o.host.documentSize(active);
        if (size) sourceSize = { width: size.width, height: size.height };
      }
    }
    var schema = remember(await o.catalog.schema(args.model_id));
    var req = hasCapture ? await o.captureRequest(args, schema) : requests.build(schema, { lane: lane, model_id: args.model_id, parameters: args.parameters || {}, takes: args.takes, target: target, source_size: sourceSize });
    var q = await o.quotes.estimate(req);
    if (o.onQuote) o.onQuote(q, req, args);
    return {
      quote_id: q.quote_id,
      cu_cost_exact: q.cu_cost_exact,
      cu_cost: q.cu_cost,
      price_kind: q.price_kind,
      cu_cost_max: q.cu_cost_max,
      cost_details: q.cost_details,
      expires_at: q.expires_at,
      no_refund: q.no_refund,
      needs_upload: q.needs_upload
    };
  }

  return { list_models: listModels, model_schema: modelSchema, estimate_cost: estimateCost };
}

module.exports = { createCatalogTools: createCatalogTools, LIMIT_MAX: LIMIT_MAX };
