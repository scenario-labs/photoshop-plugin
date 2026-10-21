# Known limitations

Development build 0.7.1. This page lists what the build does not do yet, what it does imperfectly, and what was not tested. The evidence: the Node test suite (435 tests, with a mock of Scenario's API and a fake Photoshop: *tested automated*), and live passes in Photoshop 27.11 on macOS, one paid run per action at its default model, with the panel docked at 320 px (*verified live*). Everything the live passes did not reach is marked *not tested*. Each part of the plugin and how it was checked: [STATUS.md](STATUS.md).

## Not in this build

- **Start a set** (several images from one brief), **Same action on each** (one action over several layers or documents) and **Run a workflow** (Scenario workflows) are not built.
- **Drag and drop**: onto the panel, or from the Library grid into a document.
- **Update check**, the **Output Folder** setting, and the **Leave prompts out** and **Leave prices out** settings described in [PRIVACY.md](../PRIVACY.md). Results always go to the plugin data folder, and layer metadata always holds the prompt and prices.
- **Large uploads**: every upload goes through Scenario's API and stays under 4,000,000 bytes as sent. A capture over the limit is reduced in 10% steps; when the result's size follows the capture (Upscale, for example), the panel stops first and shows the new size and price. A reference file still over 4 MB without its metadata is refused.
- **Log and capture rotation** after 7 days.
- **The agent's plan card** is built, but the agent link does not send plans yet.
- **Not on the Adobe Marketplace, and the helper is not on npm.** You build the `.ccx` from this repository, and agent clients run the helper from a checkout (see [MCP.md](MCP.md)).

## Runtime and authentication

- **Windows**: built for it, *not tested*.
- **Photoshop versions** other than 27.11: *not tested*.
- **The panel is hidden on Photoshop's Home screen.** Photoshop hides docked panels there, so the panel shows once a document is open. The panel's own "no document" screen was never seen live.
- **Document events while Photoshop is in the background.** With Photoshop in the background, its document events did not reach the panel, so the context card can show the previous document or selection until the panel reads the document again.
- **Sign-in**: typing or pasting into the key and secret fields, and the error screens for a refused key or a plan without API access, were *not tested* live (the live passes signed in through a development key import). The pictures of those screens in the User Guide are drawn from the panel's own failure copy.
- **Release package and first-run time.** The live passes installed development builds; installing the release `.ccx` and the time from install to a first image were *not tested* live.
- **One Photoshop at a time.** Two Photoshop instances on one computer sharing the helper's port: *not tested*.

## Creation and application

- **Color-managed documents** (a profile other than sRGB, 16-bit, CMYK or Lab), **large documents** (over about 8000 px on a side) and **Undo and Redo** of a landed result were *not tested* live. Each run is one History state (*verified live*), so Undo is expected to remove it in one step.

- **Extend canvas can show seams.** In two live runs on 0.7.1 (16:9 and 3:2), the original image was placed over a new frame the model had drawn again, and the joins showed: a doubled sun and a step where the old edge was. The seam check did not flag them. Fixed after 0.7.1, *tested automated* on synthetic pictures that reproduce both, *not verified live*: the new frame now shows through an eased band inside the original (6% of its short side, at least the overlap); on models that take a mask, its tone along the old edge is matched to the original's (a `-landed.png` copy lands, the downloaded take is kept); past the band the original is untouched. The checks now read across the old edge and give **Step at the old edge** and **Repeated detail past the old edge** (shown as "Edge may show" on the take). A feature the model draws twice is flagged, not removed, and a step drawn inside the new frame itself (a model that keeps the original's pixels and paints the new area in another tone) is flagged, not hidden. Look at the result before keeping it, or extend in smaller steps.
- **Inside selection can leave a lighter patch.** Replace inside with Inside selection and a feathered elliptical selection left a lighter oval on the surface around the new object in two of three live takes on 0.7.1 (the new glass's reflection, cut by the selection), and the take showed no badge: the check measured a ring outside the selection, which a masked edit leaves as the original, and the Takes card had no badge for the tone change it did report. Fixed after 0.7.1, *tested automated*: the check now also reads a ring just inside the selection and gives **Lighter patch at the selection edge** or **Darker patch at the selection edge** ("Edge may show" on the take). Measured on the four saved live takes of that scene, it flags three, including both rejected ones; *not verified live* in the panel. The patch itself is still there: the 2 px feather stays, since the patch comes from what the model drew. An object taller than the selection is cut at its edge. Draw the selection to the size of the new object, or use **Bolder**.
- **The edge checks do not catch every visible patch.** The badges (Edges ok, Edge may show, May not line up, May be misaligned, Part unchanged) look at tone and alignment around the edge. Treat "Edges ok" as a hint, not a guarantee.
- **A reference of the same scene can be copied into the selection** on Replace inside. The panel warns under the references row; *tested automated* (the note), seen live on 0.7.0.
- **A price can change after the upload.** For models whose price depends on the image, the exact price is known only once the capture is uploaded (New angle: 1 CU before, 6 CU after, live). Nothing is spent: the panel asks again. The upload itself has happened by then.
- **Trained models**: the Z-Image route and a run stacking a trained style and a trained model were *not tested* live.
- **Relight to scene** was verified live on an earlier build (0.6.2), not on 0.7.1.
- **Select Subject with Photoshop's Image Processing preference set to Cloud** (when an agent changes a selection): Photoshop sends the image to Adobe. *Not tested*.

## Interface and capture

- **The run card could keep the first price.** On New angle (0.7.1, live), the card kept "1 CU" after the price changed to 6 CU and the job was charged 6. Fixed after 0.7.1, *tested automated*, *not verified live*: the card shows the charged price, else the price waiting for approval, else the quote.
- **Jobs labeled a video job "Image"** in the popover and in Jobs (0.7.1, live). Fixed after 0.7.1, *tested automated*, *not verified live*: Animate and Frame to layer jobs are named "Video".
- **The agent's proposal card shows no picture** of the result: it names the client, the model, the target document and the History step.
- **Library thumbnails** of recent assets can stay gray for a long time or not load, and the grid can leave its third column empty at 320 px. Search matches asset names, which are often not the words in the prompt ("sneaker" found nothing in a project holding a sneaker image).
- **Model menu**: some catalog rows show no price until their price check comes back, and some stay without one.
- **Opening a clip or a new document can rearrange the panel layout.** After Animate or Formats opened a document, Photoshop moved other docked panels above the Scenario panel in one session.
- **Offline**: the development sample of the offline state did not show in the main view. Losing the connection during a run was *not tested* live; the recovery it leads to (an Unknown job looked up on Scenario) is *tested automated*.
- **Agent progress**: an agent's `wait_for_job` call returns once the job moves on or after its timeout (45 s by default, 170 s at most). While the call is held, the client gets no progress updates.

## Verification

- **Agent clients**: Claude Code was *verified live* (headless sessions through the helper over stdio, with the spend card and the proposal card approved in the panel). Codex was *tested headless* (the setup command through the real `codex` CLI), with no session against Photoshop. Cursor and Claude Desktop: config writing *tested automated*; the clients themselves *not tested*, nor the Claude Desktop `.mcpb` extension.
- **Two agent clients at once** on one Photoshop: *not tested*.
- **The upload card** (before an agent first sends pixels) was not seen on screen live: the live agent session that uploaded (M6) approved it through the development loop while a stylesheet rule hid the card, fixed since.
- **Install by double-clicking the `.ccx`** through Creative Cloud: *not tested* (the live passes installed with Creative Cloud's command-line installer).
- **Recovery after a restart** was verified live on 0.5.0 (six restart points), not repeated on 0.7.1. The look-up of Unknown jobs is *tested automated*.
- **Widths**: the live passes on 0.7.x docked the panel at 320 px. Other widths were *not tested* on 0.7.1.
