# Changelog

All notable changes to this project are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Nothing is released yet: every version below is a development build, and the 0.3, 0.4.0 and 0.6 builds are folded into the next entry.

## Unreleased

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

