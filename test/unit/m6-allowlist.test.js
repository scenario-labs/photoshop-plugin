"use strict";
// The batchPlay allow-list (SPEC 6.6, the three allow-list rows of SPEC
// 12.1): the descriptor check under Node, then the file-path rules and the
// target-not-active rule through execute_batchplay on the fake Photoshop.

const test = require("node:test");
const assert = require("node:assert/strict");
const allow = require("../../plugin/src/agents/allowlist.js");
const xmp = require("../../plugin/src/util/xmp.js");
const { bootGenerate } = require("../helpers/generate-sim.js");

const T = 7; // the target document
const LAYERS = new Set([11, 12]); // layers of the target
const OTHER_LAYER = 81; // a layer of the second document only
const ctx = {
  document_id: T,
  has: (cls, id) => LAYERS.has(id) && ["layer", "contentLayer", "adjustmentLayer", "channel", "path"].includes(cls),
  file: (p) => (p === "captures/cap-ok/context.png" ? { ok: true, ref: "token-1" } : { ok: false, reason: "not a file of a capture of this document" })
};
const px = (v) => ({ _unit: "pixelsUnit", _value: v });

function ok(descs, label) {
  assert.doesNotThrow(() => allow.check(descs, ctx), label);
  return allow.check(descs, ctx);
}
function refused(descs, label, re) {
  assert.throws(
    () => allow.check(descs, ctx),
    (e) => {
      assert.equal(e.type, "CommandRefused", label);
      assert.match(e.message, /^descriptor \d+: /, label);
      if (re) assert.match(e.message, re, label);
      return true;
    },
    label
  );
}

test("allow-list: every listed event passes in a plain shape; dialogs are forced off", () => {
  const sel = [{ _ref: "channel", _property: "selection" }];
  const layer = [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }];
  for (const ev of allow.ALLOW.events) {
    const d = { _obj: ev, _target: ev === "get" ? [{ _property: "name" }, layer[0]] : ["expand", "contract", "feather", "smoothness", "inverse", "intersectWith", "addTo", "subtractFrom"].includes(ev) ? sel : layer };
    const out = ok([d], ev);
    assert.deepEqual(out[0]._options, { dialogOptions: "silent" }, ev);
  }
  assert.ok(allow.ALLOW.events.length >= 45);
  // No "$" code anywhere in the list.
  for (const ev of allow.ALLOW.events) assert.ok(!ev.startsWith("$"), ev);
});

test("allow-list: always refused (SPEC 12.1 allow-list row)", () => {
  const layer = [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }];
  const cases = [
    [{ _obj: "play", _target: [{ _ref: "action", _name: "Save it" }, { _ref: "actionSet", _name: "Set" }] }, "play of an Action"],
    [{ _obj: "AdobeScriptAutomation Scripts", javaScript: { _path: "/tmp/x.jsx" } }, "a script event"],
    [{ _obj: "runScript" }, "runScript"],
    [{ _obj: "syntheticFill", _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }], prompt: "x" }, "syntheticFill"],
    [{ _obj: "save", as: { _obj: "photoshop35Format" }, in: { _path: "/tmp/a.psd" } }, "save"],
    [{ _obj: "saveAs" }, "saveAs"],
    [{ _obj: "close", saving: { _enum: "yesNo", _value: "no" } }, "close"],
    [{ _obj: "exportDocumentAs" }, "export"],
    [{ _obj: "exportSelectionAsFileTypePressed" }, "export selection"],
    [{ _obj: "quickExport" }, "quick export"],
    [{ _obj: "splitChannels" }, "splitChannels"],
    [{ _obj: "make", new: { _obj: "document", width: px(100), height: px(100) } }, "make of a document"],
    [{ _obj: "make", _target: [{ _ref: "document" }] }, "make of a document by class"],
    [{ _obj: "delete", _target: [{ _ref: "application", _enum: "ordinal", _value: "targetEnum" }] }, "an application-level delete"],
    [{ _obj: "select", _target: [{ _ref: "historyState", _offset: -1 }] }, "a History state reference"],
    [{ _obj: "select", _target: [{ _ref: "snapshotClass", _name: "Snapshot 1" }] }, "a snapshot"],
    [{ _obj: "invert", _target: layer, _options: { dialogOptions: "display" } }, "a dialog option"],
    [{ _obj: "gaussianBlur", radius: px(2), _isCommand: true }, "_isCommand"],
    [{ _obj: "copyEvent" }, "copy"],
    [{ _obj: "copyMerged" }, "copy merged"],
    [{ _obj: "cut" }, "cut"],
    [{ _obj: "paste" }, "paste"],
    [{ _obj: "pasteInto" }, "paste into"],
    [{ _obj: "open", null: { _path: "/tmp/a.psd" } }, "open"],
    [{ _obj: "placeEvent", null: { _path: "/tmp/a.png" } }, "placeEvent"],
    [{ _obj: "print" }, "print"],
    [{ _obj: "quit" }, "quit"],
    [{ _obj: "batch" }, "batch"],
    [{ _obj: "multiGet" }, "multiGet"],
    [{ _obj: "notAnEvent" }, "an unlisted event"]
  ];
  for (const [d, label] of cases) refused([d], label);
  // A refusal in the third descriptor names its index; nothing is played.
  refused([{ _obj: "invert", _target: layer }, { _obj: "invert", _target: layer }, { _obj: "save" }], "index", /^descriptor 2: save is always refused/);
});

test("allow-list: file paths only through the capture resolver (../, symlink and other captures are the resolver's refusals)", () => {
  const sel = [{ _ref: "channel", _property: "selection" }];
  const out = ok([{ _obj: "placedLayerReplaceContents", null: { _path: "captures/cap-ok/context.png" } }], "a capture file of this document");
  assert.equal(out[0].null._path, "token-1", "the path is swapped for the host's file reference");
  refused([{ _obj: "placedLayerReplaceContents", null: { _path: "captures/../jobs/a.json" } }], "../", /file path refused/);
  refused([{ _obj: "placedLayerReplaceContents", null: { _path: "/Volumes/Work/a.png" } }], "an absolute path", /file path refused/);
  refused([{ _obj: "set", _target: sel, to: { _path: "captures/cap-other/context.png" } }], "another capture", /file path refused/);
});

test("allow-list: get results lose paths at any depth; results are capped at 64 KB", () => {
  const r = allow.strip({ name: "Logo", smartObject: { fileReference: "logo.psb", link: { _path: "/Volumes/Work/logo.psb" }, size: 3 }, XMPMetadataAsUTF8: "<x/>", layers: [{ fullName: "/a/b", ok: 1 }] });
  assert.deepEqual(r, { name: "Logo", smartObject: { link: {}, size: 3 }, layers: [{ ok: 1 }] });
  const big = Array.from({ length: 10 }, () => ({ s: "x".repeat(10000) }));
  const c = allow.cap(big);
  assert.equal(c.truncated, true);
  assert.ok(JSON.stringify(c.results).length <= 65536 + 200);
  assert.deepEqual(c.results[c.results.length - 1], { _truncated: true });
});

test("allow-list: target active (SPEC 12.1 row 2): refusals", () => {
  const doc = (f) => [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }, { _ref: "document", ...f }];
  const forms = [{ _index: 1 }, { _name: "other.psd" }, { _offset: 1 }, { _id: 8 }, { _enum: "ordinal", _value: "first" }, { _enum: "ordinal", _value: "last" }, { _enum: "ordinal", _value: "front" }];
  for (const f of forms) {
    const label = JSON.stringify(f);
    refused([{ _obj: "get", _target: doc(f) }], "in get " + label, /document/);
    refused([{ _obj: "applyImage", with: { _obj: "calculation", to: { _ref: [{ _ref: "channel", _enum: "channel", _value: "RGB" }, { _ref: "document", ...f }] } } }], "in Apply Image's source " + label);
    refused([{ _obj: "hide", _target: doc(f) }], "as a _target " + label);
    refused([{ _obj: "hide", null: doc(f) }], "under null " + label);
  }
  refused([{ _obj: "get", _target: [{ _ref: "document", _id: T, _enum: "ordinal" }] }], "a document element with _id and a lone _enum", /exactly one form key/);
  refused([{ _obj: "select", _target: [{ _ref: "layer", _id: OTHER_LAYER }] }], "a layer id only in the second document", /not in the target document/);
  refused([{ _obj: "get", _target: [{ _ref: "document" }] }], "the class form {_ref: document}");
  refused([{ _obj: "hide", _target: [{ _ref: "layer" }] }], "a class form outside make");
  refused([{ _obj: "select", _target: [{ _ref: "document", _id: T }] }], "select of a document", /select of a document is refused/);
  refused([{ _obj: "duplicate", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: { _ref: [{ _ref: "document", _name: "other.psd" }] } }], "duplicate of a layer to another document");
  refused([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _ref: [{ _ref: "channel", _enum: "channel", _value: "transparencyEnum" }, { _ref: "layer", _id: OTHER_LAYER }] } }], "Load Selection from another document's channel");
  refused([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _ref: [{ _ref: "channel", _enum: "channel", _value: "mask" }, { _ref: "document", _index: 2 }] } }], "Load Selection naming another document");
  refused([{ _obj: "get", _target: [{ _ref: "$Dcmn", _index: 1 }] }], "$Dcmn in get", /four-character/);
  refused([{ _obj: "select", _target: [{ _ref: "$Dcmn", _offset: 1 }] }], "$Dcmn in select", /four-character/);
  refused([{ _obj: "applyImage", with: { _obj: "calculation", to: { _ref: [{ _ref: "channel", _enum: "channel", _value: "RGB" }, { _ref: "$Dcmn", _index: 2 }] } } }], "$Dcmn in Apply Image's source", /four-character/);
  for (const code of ["$capp", "$HstS", "$SnpS"]) refused([{ _obj: "select", _target: [{ _ref: code, _enum: "ordinal", _value: "targetEnum" }] }], code, /four-character/);
  refused([{ _obj: "$Mk  ", _target: [{ _ref: "layer" }] }], "a $ event", /four-character/);
  refused([{ _obj: "hide", $Nm: "x", _target: [{ _ref: "layer", _id: 11 }] }], "a $ key", /four-character/);
  refused([{ _obj: "hide", _target: [{ _ref: "layer", _id: 11, _index: 2 }] }], "an element with two form keys", /exactly one form key/);
  refused([{ _obj: "hide", _target: [{ _ref: "textLayer", _id: 11 }] }], "an unlisted class", /not on the list/);
  refused([{ _obj: "get", _target: [{ _property: "name" }, { _property: "title" }] }], "a chain of _property elements only", /resolves from the application/);
});

test("allow-list: target active (SPEC 12.1 row 2): accepted forms", () => {
  ok([{ _obj: "get", _target: [{ _property: "title" }, { _ref: "document", _id: T }] }], "the target's _id");
  ok([{ _obj: "get", _target: [{ _property: "title" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }] }], "the ordinal with _value");
  ok([{ _obj: "get", _target: [{ _property: "title" }, { _ref: "document", _enum: "ordinal" }] }], "the ordinal without _value");
  ok([{ _obj: "make", _target: [{ _ref: "adjustmentLayer" }], using: { _obj: "adjustmentLayer", type: { _obj: "curves" } } }], "{_ref: adjustmentLayer} in make");
  ok([{ _obj: "make", null: [{ _ref: "layer" }] }], "{_ref: layer} under null in make");
  ok([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _obj: "rectangle", top: px(0), left: px(0), bottom: px(10), right: px(10) } }], "the selection reference");
  ok([{ _obj: "hide", null: [{ _ref: "layer", _id: 11 }, { _ref: "document", _id: T }] }], "the target under null");
  ok([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _ref: [{ _ref: "channel", _enum: "channel", _value: "transparencyEnum" }, { _ref: "layer", _id: 12 }] } }], "Load Selection from a layer of the target");
});

// Through execute_batchplay on the fake: file paths, the target not active.
const POSTER = { id: 7, title: "poster.psd", width: 512, height: 512, selection: { left: 100, top: 100, width: 200, height: 200 } };
const OTHER = { id: 8, title: "other.psd", width: 256, height: 256 };
const A = { session: "sess-a", client_name: "claude-code" };

function extraPlay(d, { doc, makeLayer }) {
  if (d._obj === "make" && d._target && d._target[0]._ref === "layer") {
    const l = makeLayer(doc, { name: "Layer " + (doc.layers.length + 1) });
    doc.layers.unshift(l);
    doc.activeLayers = [l];
    return {};
  }
  if (["hide", "invert", "gaussianBlur", "placedLayerReplaceContents"].includes(d._obj)) return {};
  if (d._obj === "duplicate") return {};
  return undefined;
}

async function bootCommands(t, psOpts = {}) {
  const w = await bootGenerate(t, { docs: [POSTER, OTHER], active: 7, psOpts: { extraPlay, ...psOpts } });
  await w.app.settings.setSwitch("agents_may_modify", true);
  await w.app.settings.setSwitch("agents_may_run_commands", true);
  return { ...w, h: w.app.agentTools.handlers };
}

async function rejectsType(fn, type, label) {
  await assert.rejects(async () => fn(), (e) => {
    assert.equal(e.type, type, `${label}: ${e.type} ${e.message}`);
    return true;
  });
}

test("execute_batchplay file paths: a capture of this document in this session passes; another document's, an earlier session's, a symlink and ../ are refused", async (t) => {
  const symlinks = new Set();
  const { app, h, ps } = await bootCommands(t, { symlinks });
  const FLARE = "model_openai-gpt-image-2-5-flare";
  const cap = await h.capture_reference({ purpose: "edit", source: "selection", model_id: FLARE }, A);
  const files = [...ps.files.keys()].filter((k) => k.startsWith(`captures/${cap.capture_id}/`) && !k.endsWith("capture.json"));
  assert.ok(files.length, "the capture's files are in its folder");
  const good = files[0];
  const r = await h.execute_batchplay({ descriptors: [{ _obj: "placedLayerReplaceContents", null: { _path: good } }], label: "Replace" }, A);
  assert.equal(r.outcome, "committed");
  // The same capture folder name, but recorded for document 8.
  const metaPath = `captures/${cap.capture_id}/capture.json`;
  const meta = JSON.parse(ps.files.get(metaPath));
  ps.files.set(metaPath, JSON.stringify({ ...meta, document_id: 8 }));
  await rejectsType(() => h.execute_batchplay({ descriptors: [{ _obj: "placedLayerReplaceContents", null: { _path: good } }] }, A), "CommandRefused", "another document's capture");
  // An earlier Photoshop session with the same document id.
  ps.files.set(metaPath, JSON.stringify({ ...meta, session: "an-earlier-session" }));
  await rejectsType(() => h.execute_batchplay({ descriptors: [{ _obj: "placedLayerReplaceContents", null: { _path: good } }] }, A), "CommandRefused", "an earlier session's capture");
  ps.files.set(metaPath, JSON.stringify(meta));
  symlinks.add(good);
  await rejectsType(() => h.execute_batchplay({ descriptors: [{ _obj: "placedLayerReplaceContents", null: { _path: good } }] }, A), "CommandRefused", "a symlink");
  symlinks.clear();
  await rejectsType(() => h.execute_batchplay({ descriptors: [{ _obj: "placedLayerReplaceContents", null: { _path: `captures/${cap.capture_id}/../../jobs/x.json` } }] }, A), "CommandRefused", "../");
  await rejectsType(() => h.execute_batchplay({ descriptors: [{ _obj: "placedLayerReplaceContents", null: { _path: metaPath } }] }, A), "CommandRefused", "capture.json itself");
  assert.ok(app.approvals.activity().some((x) => x.what === "Command refused"), "refusals are in the activity log");
});

test("execute_batchplay, target not active (SPEC 12.1 row 3): DocumentNotActive before any descriptor runs, History unchanged, no other document named", async (t) => {
  const { app, h, ps } = await bootCommands(t);
  const target = 8; // not active
  const calls = [
    [{ _obj: "invert" }],
    [{ _obj: "hide", _target: [{ _ref: "layer", _index: 1 }] }],
    [{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _ref: [{ _ref: "channel", _enum: "channel", _value: "mask" }] } }],
    [{ _obj: "hide", _target: [{ _ref: "contentLayer", _id: 5 }] }],
    [{ _obj: "duplicate", _target: [{ _ref: "layer", _index: 1 }], to: { _ref: [{ _ref: "document", _id: target }] } }],
    [{ _obj: "get", _target: [{ _property: "title" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }] }],
    [{ _obj: "get", _target: [{ _property: "title" }, { _ref: "document", _id: target }] }]
  ];
  const history = ps.history.length;
  const played = ps.played.length;
  for (const descriptors of calls) {
    await assert.rejects(
      async () => h.execute_batchplay({ descriptors, document_id: target }, A),
      (e) => {
        assert.equal(e.type, "DocumentNotActive");
        assert.ok(!/other\.psd|poster\.psd/.test(e.message), "names no document");
        return true;
      }
    );
  }
  assert.equal(ps.history.length, history, "History unchanged");
  assert.equal(ps.played.length, played, "no descriptor ran");
  // A switch between the call start and the modal scope.
  ps.beforeModal = () => {
    ps.setActive(8);
    ps.beforeModal = null;
  };
  await rejectsType(() => h.execute_batchplay({ descriptors: [{ _obj: "invert" }], document_id: 7 }, A), "DocumentNotActive", "switch before the modal scope");
  ps.setActive(7);
  ps.beforeModal = () => {
    ps.setActive(8);
    ps.beforeModal = null;
  };
  await rejectsType(() => h.select_layers({ layer_ids: [ps.doc(7).layers[0].id], document_id: 7 }, A), "DocumentNotActive", "select_layers");
  ps.setActive(7);
  ps.beforeModal = () => {
    ps.setActive(8);
    ps.beforeModal = null;
  };
  const top = ps.doc(7).layers[0];
  top.xmp = xmp.build({ assetId: "asset_x", kind: "generation" });
  await rejectsType(() => h.remove_scenario_layers({ layer_ids: [top.id], document_id: 7 }, A), "DocumentNotActive", "remove_scenario_layers");
  assert.ok(ps.doc(7).layers.includes(top), "the layer stays");
  // Under read scope the other document is not allowed at all.
  ps.setActive(7);
  await app.settings.setSwitch("active_document_only", true);
  await rejectsType(() => h.execute_batchplay({ descriptors: [{ _obj: "invert" }], document_id: 8 }, A), "DocumentNotAllowed", "read scope");
  assert.equal(ps.history.length, history);
});
