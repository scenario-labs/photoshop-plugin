# Changelog

All notable changes to this project are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Nothing is released yet: every version below is a development build, and the 0.3, 0.4.0 and 0.6 builds are folded into the next entry.

## Unreleased

### Fixed

Each fix is *tested automated* (Node suite, fake Photoshop, synthetic pictures). Re-tested live on 2026-10-21 (development build, one run each at the default model); the result ends each line.

- Keep take and Show take touch only the group's own takes (Scenario layers of the group's job): a layer the person added to the takes group, also a Scenario layer of another run dragged into it or a copy the person made of a take (Layer > Duplicate keeps the take's metadata), is no longer deleted by Keep take (and Refine, which keeps the shown take first) or hidden by Show take, and the Takes card does not count it as a take. Before, every other layer of the group went. *Tested automated*.
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

