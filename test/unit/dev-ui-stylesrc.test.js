"use strict";
// Development builds only (dev/ui-loop.js): Style > Match an image could
// not be driven by the dev loop, whose pop command found no chip for the
// picture menu and whose click found no row ("no such element shown",
// 2026-10-21). "pop" with kind "stylesrc" opens it from the Style menu as a
// person does; "stylesrc" picks its picture, a file read from the data
// folder in place of the dialog.

const test = require("node:test");
const assert = require("node:assert/strict");
const devUiLoop = require("../../plugin/src/dev/ui-loop.js");
const png = require("../../plugin/src/util/png.js");
const { bootGenerate } = require("../helpers/generate-sim.js");
const { waitFor } = require("../helpers/fakes.js");

async function send(host, cmd) {
  await host.writeDataText(devUiLoop.COMMAND, JSON.stringify(cmd));
  return waitFor(
    async () => {
      const text = await host.readDataText(devUiLoop.RESULT);
      const out = text ? JSON.parse(text) : null;
      return out && out.id === cmd.id ? out : null;
    },
    { label: `result of ${cmd.cmd}`, timeout: 5000 }
  );
}

test("the dev loop reaches Match an image: its menu from the Style chip, each of its pictures, and a file from the data folder", async (t) => {
  const { app, host, doc, ps } = await bootGenerate(t, { docs: [{ id: 7, title: "poster.psd", width: 1024, height: 1024 }], active: 7 });
  ps.entrypoints.panels.scenarioPanel.show();
  await waitFor(() => app.controller.state().active, { label: "panel shown" });
  await waitFor(() => doc.all.some((e) => e.getAttribute("data-pop") === "style"), { label: "the Style chip" });
  const loop = devUiLoop.start({ host, doc, global: {}, app, log: () => {}, menu: null });
  t.after(() => loop.stop());

  const opened = await send(host, { id: "1", cmd: "pop", kind: "stylesrc" });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(app.createView.popKind(), "stylesrc");
  const clicked = await send(host, { id: "2", cmd: "click", attr: "data-value", value: "layer" });
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  await waitFor(() => app.controller.state().style === "match", { label: "Match an image on" });

  const visible = await send(host, { id: "3", cmd: "stylesrc", value: "visible" });
  assert.equal(visible.ok, true, JSON.stringify(visible));
  assert.equal(app.controller.state().style, "match");

  const w = 64;
  const pic = png.encodePng({ width: w, height: w, channels: 3, data: new Uint8Array(w * w * 3).fill(120) });
  await host.writeDataBinary("dev-live/style.png", pic);
  const file = await send(host, { id: "4", cmd: "stylesrc", value: "file", path: "dev-live/style.png" });
  assert.equal(file.ok, true, JSON.stringify(file));
  assert.equal(file.result.style, "match");
  assert.equal(file.result.note, "");
  assert.equal(typeof host.chooseImageFile, "function", "the file dialog is put back");

  const bad = await send(host, { id: "5", cmd: "stylesrc", value: "elsewhere" });
  assert.equal(bad.ok, false);
});
