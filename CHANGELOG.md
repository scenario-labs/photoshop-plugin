# Changelog

All notable changes to this project are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Nothing is released yet: every version below is a development build, and the 0.3, 0.4.0 and 0.6 builds are folded into the next entry.

## Unreleased

### Fixed

Each fix is *tested automated* (Node suite, fake Photoshop, synthetic pictures). Re-tested live on 2026-10-21 (development build, one run each at the default model); the result ends each line.

- Keep take and Show take touch only the group's own takes (Scenario layers of the group's job): a layer the person added to the takes group, also a Scenario layer of another run dragged into it or a copy the person made of a take (Layer > Duplicate keeps the take's metadata), is no longer deleted by Keep take (and Refine, which keeps the shown take first) or hidden by Show take, and the Takes card does not count it as a take. Before, every other layer of the group went. *Tested automated*.
- No button in the panel answered a click (live 2026-10-21 evening, on the build with the chip fold): the panel redrew itself dozens of times a second, since Photoshop sends "resize" when the layout inside changes and each redraw changed the layout, so every button was replaced under the pointer and Photoshop ran at about 150% CPU with no document. The panel now redraws on "resize" only when its size changed, and the top's class is set only when it differs. *Verified live*: 3 redraws after a reload, then none while idle, CPU back to about 4%; *tested automated* (a resize with the same size draws nothing).
- A price check's quote is given back when the job record cannot be written, so the same button can send it once the disk works; it read "This quote was already used" until a new price check. *Tested automated*.
- Allow without asking: when the request that used up the session total is never sent, its amount comes back and the allowance resumes; it was lost with the allowance. A charge above its quote in the meantime keeps it ended. *Tested automated*.
- A job record that could not be written leaves no temporary copy behind, which after a restart read as a claimed request and blocked the same request as Unknown. *Tested automated*.
- An agent that withdraws a spend request (`cancel_prepared_job`) while the person's approval is going through gets an error saying the request may be sent; it was told "not sent". *Tested automated*.
- Extend canvas: the new frame shows through an eased band inside the original (6% of its short side, at least the overlap) instead of a 32 px ramp, and on models that take a mask the frame's tone along the old edge is matched to the original's (a `-landed.png` copy lands; the downloaded take is kept). Past the band the original is untouched. *Verified live: still broken*: a horizon step at the old edge and a figure drawn twice in the new area still show.
- Extend canvas checks read across the old edge: **Step at the old edge** and **Repeated detail past the old edge** (a feature of the original drawn again, as the doubled sun of a live run). *Verified live*: both were recorded on the live run, but Extend canvas lands as a single result card that shows no badge, so the person does not see them.
- Replace inside: a lighter or darker patch just inside the selection edge is flagged (**Lighter patch at the selection edge**, **Darker patch at the selection edge**). The seam ring outside the selection could not see it. *Verified live*: no patch appeared on a feathered ellipse in a sky (two takes, both Edges ok); the badge on a real patch was not seen live.
- The Takes card shows **Edge may show** for those badges; before, a take with a visible edge showed no badge. *Not seen live* (no take had a patch).
- The run card shows the charged price, else the price waiting for approval after a price change on upload, else the quote. It kept the first quote. *Verified live: fixed* (New angle, 1 CU to 14 CU); the composer button still shows the first quote during the approval.
- Jobs and its popover name video jobs (Animate, Frame to layer) "Video", not "Image". *Verified live: fixed* on Animate 5 s.

### Fixed after the 2026-10-23 review

- New layer covered what was under it: it landed as an opaque picture at canvas size over the lettering of a character sheet. With a selection, **New layer** is now offered in the selection context, sized to the selection and fitted inside it, and lands cut out: the request asks the model for a transparent background, and a take that still covers what is under it (GPT Image 2.5 Flare returned a painted sky at alpha 0.91 to 0.98) is cut at placement by Photoshop's own Remove Background, as an editable layer mask (no credits). Photoshop takes a small layer's whole rectangle for its subject, so the take is scaled up to the canvas for the cut and back to its frame after. A **Lands** chip switches between Cut out and Full frame. *Verified live* (a swallow kite inside a 300 x 380 selection over a painted sky: cut, no box); *tested automated*.
- Formats cut painted titles: the poster's title was cropped or gone in Wide and Square. The picture is now read without its type layers (and Split text layers), and each live title is laid out again on each artboard at the same place in the frame, inside a 4% margin, scaled with the picture and smaller only when it would not fit, still editable. *Verified live* before the placement rule changed (the title was copied and scaled into the artboard, but placed over the town); the rule now keeps the title's place in the frame, *tested automated*, not re-run live.
- Cut out subject keeps the selection's own shape (a lasso, an ellipse), not only its box. *Tested automated*.
- Keep take leaves the group named after its prompt: it kept "(4 takes)" with one take inside. *Tested automated*.
- A Free Transform after Cut out subject or Remove background showed a 1 px line of the hidden pixels along the layer's edge: a mask written over its box revealed everything outside it. A new mask now starts as Hide All. *Verified live* (a cut-out scaled 173% on a character sheet: no line); *tested automated*.
- One-click actions on a cut-out sent what its mask hides: New angle on a Cut out subject layer got the sky and a chimney back. Photoshop's pixel read leaves a layer's own mask out, so the read now keeps the mask in the alpha (a disabled mask is left out, as Photoshop shows the layer). *Verified live* (New angle then returned the figure alone); *tested automated*.
- A kept take offered only Refine, More like this, Upscale and Animate: its **More** menu now has **Remove background** and **New angle**, both on the take that is showing. *Verified live* (a kept side view cut out as a mask on the take); *tested automated*.
- After a Free Transform or a Move, the panel kept the layer's old bounds, and New angle's takes landed where the layer had been. The panel now also follows Photoshop's transform, move, duplicate and paste events. *Tested automated*; *not tested live* (the development loop's own edits do not reach the panel's listener).
- Split into layers placed a sky (a fully opaque element) as an 84 x 47 px patch in a corner: a small plain patch of a backdrop matched better than its real place. A fully opaque element is now searched at 90% of the picture's width or more. *Verified live* (the same job placed again: the sky across the top); *tested automated*.
- Place in current document (Jobs) failed on Split into layers, Remove or Split text, Formats and the other later flows when the job's own document was gone ("Open … to place this result there"); it now places in the document in front when its canvas size matches. *Verified live* (a split placed again after a panel reload); *tested automated*.
- Relight left a dull line of the original around a relit figure drawn a little narrower: the layer's own soft edge sat where the outline mask faded. The mask now grows a few pixels past the outline, so the take covers that edge. *Verified live*; *tested automated*.
- New layer in a selection read "Lands above … at canvas size" until the first price; it now says "inside the selection" from the start. *Verified live*; *tested automated*.
- Formats put the title of a second artboard outside it, at the top of the Layers panel: after the first artboard, Photoshop leaves the placed layer selected, and a title copied into a document with artboards does not keep its place. The artboard is now read from the placed layer's parent and the title is laid out from where the copy really landed. After a plugin reload, the next format is added to the open "<title> formats" document instead of a new one. *Verified live* (9:16, 4:5, 1:1 and 16:9 in one document, each title live inside its artboard); *tested automated*.
- Upscale opened its new document as "Scenario upscale upscale-layer G4xH38"; it now opens as "<source title> ×2" (or ×4). The layer keeps its Scenario name. *Verified live*; *tested automated*.
- Animate warped a poster's lettering: the clip was made from the picture with its title in it. Animate now reads the picture without its type layers (as Formats does); they stay in the document, and the landing note says so. *Verified live* (the clip has no title); the note *tested automated*.
- Create image could not be reached from a new document: it lived only in the no-document context, which Photoshop hides on its Home screen, and a blank File > New document offered Split into layers first. A blank document (one Background of a single color) now opens on **Create image**, made at the canvas's aspect and landing as a layer above the Background. *Verified live* (context and price); *tested automated* (the landing).

### Changed

- Button shapes follow the Scenario web app: the Generate button is a rounded rectangle (6 px corners), the chips and other buttons are full pills. *Verified live*.

### Fixed in the real-click pass

A verification pass on 2026-10-22 pressed the panel's controls with real macOS mouse events (Photoshop 27.11, development build, panel docked at 280 px): the dev loop's own click calls a handler from code, so it passed while no real click could land on 2026-10-21. Each fix below is *tested automated* (a test that fails on the code before it); the live result ends each line.

- The panel could not be resized: docked, it stayed at its minimum size, 280 x 420, with empty dock space under it. The manifest now gives a maximum size. *Verified live*: after a Photoshop restart the panel fills its dock column (280 x 912); resizing by hand is for the person to confirm.
- A redraw now waits while the mouse button is down in the panel, so a click lands on the node it was pressed on. Job polls, price checks, the chip fold and menu refills redraw at any moment, and a redraw between press and release lost the click. *Tested automated*; *not tested live* yet with real clicks.
- A menu opens at its top. The menu box is reused and kept the last menu's scroll: the Model menu opened on its last rows, with Recommended out of view. *Verified live* before the fix (the menu opened scrolled); the fix is *tested automated*.
- Text that an open menu covers is hidden while it is open: a one-click action's note ("Separates the lettering…") showed through the More menu. *Verified live* before the fix; the fix is *tested automated* only for the hiding rule, *not tested live*.
- The Model menu lists only models that can take the layer. On Make versions it offered Gemini 3.1, Gemini 3.0 Pro, Seedream 5.0 Pro, Gemini 3.1 Lite and Grok Imagine Image 2.0, and each one blocked the button ("This model takes no image, so it can't edit an area"). All models now refuses such a model with a note. *Verified live* before the fix (each of the five, real clicks); the fix is *tested automated*.
- An approved agent spend keeps its card, reading "Approved, sending", without its buttons, until the approval ends. The card came back with both buttons live, and Decline said nothing was spent while the charge went on. *Tested automated*.
- Settings > Agents and Connect a client are drawn again only when the link state changes: with no helper running, the link dials every 3 s and the whole box, its switches and its fields, was rebuilt each time. *Tested automated*.
- The Library reads each project's own images (its list was kept per filter only, so a switch within a minute showed the other project's images), and a Library error has **Try again** (it stayed until another filter was clicked). *Tested automated*.
- Upscale on a model with no factor setting (P-Image Upscale, Recraft Crisp Upscale) shows no factor: the chip and the button kept the factor last chosen on Topaz ("Upscale ×6") while the model upscales at its own rate, and the menu offered ×2 only. *Verified live* before the fix; the fix is *tested automated*.
- Extend canvas leaves out the ratio the canvas already has: a 3:2 document was offered 3:2, and choosing it blocked the button ("Already 3:2, pick another target"); a target chosen on another document moves to the next one. *Tested automated*; found through the dev loop.
- Extend canvas moves "+20% each side" to a ratio on a model that cannot extend per side (Photoroom Expand, Reframe): the button blocked with "This model expands around the center". *Tested automated*; found through the dev loop.
- A source over Scenario's 4 MB upload limit (Upscale, Remove background and the one-click tools) runs on the second Generate, read at the size that fits: the panel kept no reduced size, so each Generate said "click Generate again" and stopped again. *Verified live* before and after the fix (Upscale on a 1536 x 1024 layer after Extend canvas: priced again at 1638 x 922, then ran).
- A reloaded panel reads the document context at once: it showed "No document open" with a document open until Photoshop sent a document event. *Tested automated*.

### Changed

- Extend canvas defaults to Reframe at 2K, with the resolution pinned by the lane preset; GPT Image 2.5 Sunburst at Medium was the runner-up of a two-take comparison per model on the same poster and canvas, and GPT Image 2.5 Flare stays in the Model menu (it drew the main figure a second time in 3 of 4 takes). The built-in Extend prompt is unchanged: a line asking not to repeat anything from the center did not help. Reframe at 2K costs more than Flare at Low (about seven times as much at 16:9); the button shows the price before the run. *Tested automated*; *verified live* on the same poster to 16:9: one figure, no step at either old edge.

### Fixed after the re-test

*Tested automated*. Checked live on the evening of 2026-10-21 (development build, one run each at the default settings); the result ends each line, and a line without one was not checked live.

- The single result card (Extend canvas, Upscale, Remove background) shows the badge the checks gave and each check in words. It showed none, so the step and the repeated detail recorded on the live Extend run were not visible. *Verified live* on Extend canvas: the card read **Edges ok**, as the record holds.
- The composer button shows the price after the upload for the same action and settings (New angle, 1 CU to 14 CU live), where it kept the first quote during the approval and the run. *Not seen live*: in the evening check the price did not change after the upload.
- Extend canvas: the step limit is 22 (was 10), calibrated on 14 labelled real takes; at 10 it flagged clean takes. The measured scores are a fixture test. *Verified live*: a clean Reframe take read **Edges ok** (step 12.5).
- Photoshop could stay busy, and the panel showed the host's raw "host is in a modal state". The plugin's modal scopes now run one after the other, so a **Keep take** clicked while the context thumbnail is read waits for it (the first Keep after a placement did nothing); a scope Photoshop refuses as busy is tried again three times, then the panel reads "Photoshop is busy. Try again in a moment." (`PhotoshopBusy` for agents). A test holds that no modal scope wraps a network call, an upload, a poll, a download or a price check, and that no request is sent while one is open during a whole Extend run. *Verified live*: Keep sent about 3 s after a two-take landing worked on the first command, with no host text and no busy line (a click within the first second was not reproduced).
- The context card's second row of action chips was cut in half at the composer's edge (a layer card with its Select field and two chip rows, docked at about 300 px). The context card and the chips now sit outside the part that shrinks, so they keep their full height, and the composer with its button stays in view: when even an empty middle leaves too little room, the last chips fold into **More**, one at a time, down to one row. *Tested headless* in Chrome with the plugin's own page and view code on each context at 280, 320 and 360 px: every chip row whole and the button in view from 360 to 390 px high (300 for takes), where 420 px failed before in three cases; *not tested live*. *Verified live: not fixed in every case* (docked at 280 x 420): the selection and takes contexts and a plain layer card keep their rows, but with an Extend canvas result layer active the third chip row is cut in half and nothing folds into More. Fixed after that check: UXP gives the chips no size (each read 0 x 0), so the rows could not be counted; the fold now runs again once the layout has settled, one chip at a time, while the composer is out of view or the top scrolls, and two chips stay beside More. *Verified live* through the dev loop at 280 x 420 on a layer card with a long name (the detail on two lines, three chip rows before): two chips went into More, both rows whole, the composer and its button in view; a selection card was unchanged.
- The context card names a Scenario layer in plain words: "Take 1 of A paper kite" instead of "Take 1 NfpUm8 · Layer 1536 × 1024", a single result by its run's name; the id tail and the size stay in the tooltip, and a layer the person renamed keeps its name. *Verified live in part*: an Extend canvas result is titled "Extend canvas", but the detail line still names the raw layer, and a New angle run's card reads "Edit".
- New angle is priced before the upload with a blank stand-in at the capture's size; the 256 px stand-in quoted 1 CU where the real capture cost 5 to 14 CU. *Verified live*: 17 CU before the upload on a 1024 x 1536 layer, charged 17, no approval card.
- Development builds: the dev loop can open Style > **Match an image** and pick its picture (selection, layer, visible, or a file from the data folder). Release builds are unchanged.

### Documentation

- README rewritten for people installing the plugin: what it does, install from a built `.ccx`, a first generation, and links to the guides. The build-by-build technical status moved to `docs/STATUS.md`.
- `docs/USER_GUIDE.md`: quick start, every action with before and after pictures from live runs, selection edits (Inside selection or Bolder), takes, references, styles and trained models, Library, prices and approval, Jobs and recovery, settings, agents, troubleshooting.
- `docs/MCP.md`: real screenshots and a recording of an agent run, how each client was checked, and the from-checkout setup command while the helper is not on npm.
- New `docs/KNOWN_LIMITATIONS.md` and `SECURITY.md`; `PRIVACY.md` brought current for 0.7.1.
- The handbook: `npm run handbook` builds the docs into one web page with contents, search, light and dark themes and pictures that enlarge, a single HTML file with the pictures embedded (its fonts load from Google Fonts) and an A4 PDF with a cover and page numbers (`build/handbook/`). Made for photoshop.scenario.com; not published yet.
- Panel screenshots under `docs/media/screens/`, captured in Photoshop 27.11. The before and after pictures and the recordings the guides link to follow in a later pass.

## 0.7.1 - 2026-10-20

### Fixed

- Replace inside with a reference shows one line under the refs row: "Use an object or a style as the reference. A whole scene can be copied in."
- The small result note reads "Result is 2048 px for the 2304 px area".
- Library names, the place note and run names are cut on a word boundary with an ellipsis, never inside a word.
- Recent comes back after the panel reloads while Photoshop keeps running, also for a document that was never saved.

## 0.7.0 - 2026-10-20

The creation panel, the agent tools and the trained and Library work in one build.

### Added

- Creation panel: the context card reads what the document holds (no document, a layer, a cut-out, a selection, a group of takes, a split element) and leads with the actions that fit; one composer with the refs row, the prompt and Suggest, chips that show their values, and the price on the button; the Takes card, Recent, and the Jobs popover.
- Later flows: Render sketch, New angle, Relight to scene, Split into layers, Remove text and Split text, Select by description, Formats, Animate with Frame to layer, the Upscale compare at 100%, and the agent's plan card (not fed by the agent link yet).
- Replace inside and Remove on Ideogram 4.5 Precise Edit and Ideogram 4.5, with an Edit chip: Inside selection, or Bolder (GPT Image 2.5 Flare with a mask that grows over what the model drew past the selection).
- Agents: the tools of the local Scenario MCP server (`scenario-photoshop`) for documents, references, prices, generation, jobs and landing results; three switches, No-spend and Agent spending; the spend, upload and proposal cards; Photoshop commands through an allow-list; Connect a client for Claude Code, Codex, Cursor and Claude Desktop.
- Trained models: Run with, stacking on one base, trigger words; the Library grid with search, filters, Show more, Place from Library and + Reference > Library.

### Fixed

- The + Reference row shows again on Replace inside: its references go to Precise Edit's own reference input (3 at most with a selection).
- The upload and proposal cards are drawn in the panel; the stylesheet hid them with the F5 card's rule.

## 0.5.0 - 2026-10-19

### Added

- Jobs: one record per job written before anything is sent, recovery after a Photoshop restart at every step, Unknown resolution against the project's jobs, downloads with fresh links, and placement in the job's own document.

## 0.4.1 - 2026-10-19

### Added

- Edit and Enhance: selection captures with margin and mask, the three Expand routes, Upscale, Remove background, trained edits per base route, and the checks after placement.
- Image lane: references, placement as embedded smart objects, layer metadata, takes, one History state per run.

## 0.2.0 - 2026-10-19

### Added

- Sign-in with a Project API key, projects, the model catalog and picker, schema forms and exact prices from free price checks.

## 0.1.0 - 2026-10-19

### Added

- Plugin skeleton, the local helper over stdio, port election and pairing.

