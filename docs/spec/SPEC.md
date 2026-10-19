# Scenario for Photoshop: Spec v1

Status: draft for review, 2026-10-19. Scope: the Scenario plugin 1.0 for Adobe Photoshop (a UXP panel) and its local Scenario MCP server `scenario-photoshop` 1.0.

Companion files: [wireframes.md](wireframes.md), [MCP.md](MCP.md), [PRIVACY.md](../../PRIVACY.md).

**Evidence tags.** Every platform claim carries one of these:

| Tag | Meaning |
|---|---|
| verified live (27.11) | Measured in Photoshop 27.11.0 with UXP 9.4.1 on macOS. When the measurement ran through ExtendScript rather than UXP, the claim says so. |
| verified live (Scenario API) | Measured against the Scenario REST API. |
| documented | Stated in Adobe, Scenario or client documentation. Not measured for this spec. |
| assumed, to verify in Phase 3 | A design assumption. The build tests it before release, and this spec changes if it fails. |

"Phase 3" is the build and test phase that follows this spec. "The toolkits" are the Photoshop scripts of the Scenario skills pack (`skills/dcc/photoshop/` in `scenario-labs/skills`: `ps_io`, `ps_generative`, `ps_upscale`, `ps_composite`, `ps_gates`, `ps_review`, `ps_audit`, `ps_run`). They drive Photoshop through ExtendScript and were verified live on 27.11. The plugin reimplements their behavior in UXP (section 2.8).

## Decisions this spec relies on

| Id | Decision |
|---|---|
| D1 | Public repository `scenario-labs/photoshop-plugin` under the MIT license. Nothing internal goes in it. |
| D7 | The manifest declares `ws://localhost:<port>` and the panel connects there. A `ws://127.0.0.1:<port>` entry is declared as a fallback for when the `localhost` constructor throws. The helper binds `127.0.0.1` only. Never `"domains": "all"`. |
| D8 | `host.minVersion` "26.0", `manifestVersion` 5. Primary test target 27.11; re-test on 28.0. |
| D9 | A Node server `scenario-photoshop` serves agent clients over stdio. The first instance owns the fixed loopback port; later instances proxy through it. The panel dials out over WebSocket, checks a pairing token, and sends its host info and tool catalog. Generation, quotes and spend run in the panel with the panel's credentials; the helper never receives the Scenario key. Platform-wide work (training, usage, collection admin, workflow authoring) stays on hosted Scenario MCP at mcp.scenario.com. |
| D10 | Sign-in is API key + secret entered in the panel, stored with `secureStorage`, with **Test connection**. Key creation is one click away. Browser sign-in (authorization code + PKCE with a paste-code page) is planned; device code needs a first-party client on Scenario's side. |
| D13 | Masking happens in Photoshop. Any image-to-image model whose output is aligned with its input can make a selection-scoped edit: the plugin masks the result by the captured selection. Seam gate: tone bias < 12 and alignment residual < 6, measured on blurred images in a ring outside the mask. |

The choices this spec makes where the research left options open are listed at the end, in "Open choices made in this spec".

---

## 1. Goals, non-goals, users

### 1.1 Goals

1. Put Scenario's catalog and the team's trained models inside Photoshop for the jobs Photoshop users do most with generated images: edit inside a selection, upscale, generate from references, make plates for compositing and key art, cut out, expand.
2. Land every result non-destructively: a new embedded smart object, masked when it is an edit, traced to its generation in layer metadata, removed with one Ctrl+Z.
3. Show the price before any spend, never charge twice for one intent, and keep every paid job recoverable across Photoshop restarts.
4. Give agents the engine the panel uses, through local tools that read the document, generate and apply results. Document changes by agents are off by default.
5. First generation within 2 minutes of a fresh install, sign-in included. Photoshop never freezes: network and file work stay outside modal scopes.

### 1.2 Non-goals (v1)

- Replacing Photoshop's own tools (selection, retouching, layout). The plugin feeds them generated pixels.
- Calling Adobe's generative features (Generative Fill, Generative Upscale). The plugin runs Scenario models only.
- Training models from document content. The plugin offers no training action (Adobe Developer Terms 6.16, section 6.8). Training stays on Scenario's web app and hosted Scenario MCP.
- A cloud relay between agents and Photoshop. Documents stay on the machine except what the person, or an agent they allowed, sends to generate.
- Video timeline editing and any audio work inside Photoshop.
- Print prepress. CMYK documents get the nearest design in section 5.4, nothing more.
- Visible disclosure marks on results. Provenance lives in metadata.
- A Marketplace listing. Distribution is GitHub releases and npm until a maintainer decides otherwise (section 10).

### 1.3 Users

| User | First jobs | Lanes | What they need most |
|---|---|---|---|
| Retoucher | Replace or fix an area, extend a background, upscale a client file, restore an old photo | Edit, Enhance | Tight masks, nothing changed outside the selection, color fidelity in their working space |
| Concept and game artist | Variations, paintover of 3D renders, textures, sprites, UI parts | Image, Edit, Trained | Their own trained styles, many takes fast, references taken from layers |
| Brand and marketing designer | Product shots, campaign plates, mockups, social formats | Image, Enhance, Library | Brand models, exact canvas sizes, clean cutouts |
| Art director | Review takes, pick one, check cost and origin | Jobs, Library | Takes side by side, provenance per layer, spend visible |
| Pipeline and agent automation | Agents that build key art, mockups and texture sets from a brief | Local Scenario MCP tools | Safe defaults, quotes, a ledger, results that land where expected |

### 1.4 Use cases and v1 coverage

Ranked by the Phase 0 research on how people use Photoshop with generated images.

| Rank | Use case | Coverage | Release |
|---|---|---|---|
| 1 | Selection edit (inpaint) | Edit lane, any aligned image-to-image model (D13) | v1 |
| 2 | Upscale and detail repair | Enhance > Upscale | v1 |
| 3 | References and consistency | Reference slots in Image and Edit from selection, layer, all visible, Library or file; Trained lane | v1 |
| 4 | Compositing plates | Image lane places plates as smart objects; the craft goes through the compositing skill | v1 |
| 5 | Key art and thumbnails | Image lane at the canvas aspect; layout through the key-art skill | v1 |
| 6 | Cutout | Enhance > Remove BG as a mask on the source layer | v1 |
| 7 | Retouch of generated portraits | Edit lane; skin work through the compositing skill | v1 |
| 8 | Mockups | Image and Library place designs; fit and warp through the mockups skill | v1 |
| 9 | Expand | Enhance > Expand | v1 |
| 10 | Game textures | Image lane; tile checks through the game-art skill | v1 (in-panel seamless check v1.1) |
| 11 | Layer decomposition | Enhance > Layers | v1.1 |
| 12 | Batch over many files | Agents over open documents; recorded Actions | v1 (agents), later (Actions) |
| 13 | Camera angle change | Edit lane on a whole layer; unaligned result placed unmasked | v1 |
| 14 | Restoration and colorize | Edit lane on a whole layer | v1 (alignment check v1.1) |
| 15 | Paintover from 3D | Edit lane with the render layer as source | v1 |
| 16 | Image to video | Video lane, files plus open as document | v1.1 |

---

## 2. Platform and architecture

### 2.1 Platform choice

A UXP plugin (panel plus startup code) and a small Node helper process. Nothing native.

| Fact | Consequence | Basis |
|---|---|---|
| The Window menu has no Extensions (Legacy) entry | UXP is the only panel technology | verified live (27.11) |
| UXP cannot listen on a port | An outside process serves agents; the panel dials out to it | documented for UXP in Premiere; assumed, to verify in Phase 3, for Photoshop |
| Photoshop listens on no TCP port of its own | There is no Adobe bridge to reuse | verified live (27.11) |
| `ws://localhost:<port>` and `ws://localhost` connect; every `ws://127.0.0.1` form is refused, synchronously, by the WebSocket constructor | Manifest entry and URL use `localhost` (D7); the constructor is wrapped | verified live (27.11) |
| `loadEvent: "startup"` runs plugin code at launch with the panel closed; the socket connected 4 to 5 s after launch | Jobs resume and agents connect without the panel open | verified live (27.11) |
| HTTPS from the plugin to `api.cloud.scenario.com` works | All Scenario calls run in the plugin | verified live (27.11) |
| `process.env` exists and is empty | The plugin cannot read environment variables (section 4.4) | verified live (27.11) |
| No `TextEncoder`, `TextDecoder` or `crypto.subtle`; `crypto.randomUUID`, `Blob`, `FormData`, `AbortController`, `atob`, `fetch`, `WebSocket` exist | Bundle a JS SHA-256 and a UTF-8 codec | verified live (27.11) |
| A top-level `const URL` breaks `new WebSocket()` | Bundle as modules; lint against shadowed globals | verified live (27.11) |
| The imaging encoder writes JPEG only | Bundle a PNG encoder and decoder | documented |
| Imaging handles RGB, Gray and Lab documents only | Other modes take the path in section 5.4 | documented |
| Imaging calls throw outside a modal scope | Every pixel read and write runs inside `executeAsModal` | verified live (27.11) |
| `executeAsModal`: one plugin at a time, a progress bar after 2 s, cancellation only at `await` points | Short modal scopes; no network inside them | documented |
| A plugin above 600 MB of memory gets a warning | Read pixels at upload size; release buffers at once | documented |
| A `.psjs` opened from outside with `open -g` runs nothing | No headless script entry (section 2.9) | verified live (27.11) |
| `openExternal`, `openPath` and link clicks show a consent dialog every time | Links only where the person asks for them | documented |
| Text fields render above every other element | No overlays above forms: the model picker is a full view | documented |
| No CSS transitions; `devicePixelRatio` reports 1; no `<input type="file">` | Static loading states; 2x thumbnails; pickers through `localFileSystem` | documented |
| Photoshop 27.9 changed the UI backend | Panels are tested on 27.9 or later | documented |

### 2.2 Components

```
 Agent clients: Claude Code, Codex, Cursor, Claude Desktop
        | stdio, one helper process per client
        v
 +---------------------------+    peer link     +-------------------+
 | scenario-photoshop helper |<---------------->| scenario-photoshop|
 | owner: binds 127.0.0.1    |  127.0.0.1:9878  | helper (peer)     |
 | port 9878                 |                  +-------------------+
 +-------------^-------------+
               | WebSocket. The plugin dials ws://localhost:9878.
               | Helper hello carries the pairing token. No Scenario secrets.
 +-------------+------------------------------------------------+
 | UXP plugin "Scenario" (panel + startup code)                 |
 |  ui | catalog | forms and quotes | jobs and ledger           |
 |  capture | apply | bridge (tool catalog, switches, approvals)|
 +------+---------------------------------------+---------------+
        | HTTPS, key + secret (Basic auth)      | executeAsModal,
        v                                       | batchPlay, imaging
 api.cloud.scenario.com, Scenario CDN           v
                                         Photoshop documents
```

### 2.3 Plugin modules

| Module | Owns | Notes |
|---|---|---|
| `auth` | Key and secret in `secureStorage`, Test connection, 401 handling | The secret is never shown again after save and never logged |
| `scenario` | REST client: catalog, schemas, dry runs, runs, jobs, assets, uploads, downloads | Retries reads only (section 6.1) |
| `catalog` | Model cache, private models, picker search | Private models filtered client-side (section 3.3) |
| `forms` | Form generated from the model schema, validation, quotes | Validates names and types before any dry run |
| `jobs` | Ledger, state machine, polling, downloads, recovery | Durable in the plugin data folder |
| `capture` | Sources, selection mask, context margin, PNG encoding | Modal only while reading pixels |
| `apply` | Place, mask, XMP, takes, checks, History | Modal; one History state per apply |
| `bridge` | Helper link, pairing, tool dispatch, approvals, activity log | Calls the same command layer as the UI |
| `ui` | Lanes, picker, prompt bar, Jobs, settings, states | Spectrum UXP widgets |
| `util` | SHA-256, UTF-8, PNG, canonical JSON, atomic file writes | Pure JS, unit-tested under Node |

### 2.4 Threading rules

1. Network and file IO run outside `executeAsModal`, as plain async code.
2. A modal scope does one thing: read pixels for one capture, or write one result. It opens, works, closes.
3. PNG encoding of a large capture runs after the modal scope has closed, in chunks that yield to the event loop between row bands.
4. When another plugin or a dialog holds the modal state, the call retries with back-off for up to 10 s, then the panel shows "Photoshop is busy. Placing when it is free." and keeps the work queued. Agents get `PhotoshopBusy`.
5. Inside a modal scope, cancellation (Escape on Photoshop's progress bar) is checked at each `await`. A cancelled apply resumes its History suspension without committing and reports `rolled_back`.

Basis: documented (`executeAsModal`, `hostControl.suspendHistory`); timings and Escape behavior assumed, to verify in Phase 3 (Live Check 5 was not run).

### 2.5 Job layer

One JSON file per job in `PluginData/jobs/<local_id>.json`, written atomically (write `<file>.tmp`, then rename). An index file is rebuilt from the job files at startup.

| Field | Content |
|---|---|
| `local_id` | UUID from `crypto.randomUUID` |
| `idempotency_key` | Quote id or the agent's key (section 6.2) |
| `fingerprint` | SHA-256 of the canonical request (section 6.1) |
| `origin` | `person` or `agent`, plus the client name the agent reported |
| `lane`, `model_id`, `model_name`, `parameters` | Canonical JSON, file inputs as asset ids |
| `inputs` | Capture ids, uploaded asset ids, Library asset ids |
| `target` | Document id and title, canvas size and resolution, capture box, sample mode, insert point, mask file |
| `state`, `revision` | Plugin status (below) and a counter bumped on each write |
| `job_id`, `remote_status`, `progress` | From Scenario |
| `cu_quoted`, `cu_charged`, `no_refund` | Decimal strings; `no_refund` from the job's `disableRefund` flag |
| `outputs` | Asset ids, file paths, download state per file |
| `placement` | Layer ids, group id, History state name, check results |
| `error` | `Type: message`, as shown to the person |
| `claimed_at`, `submitted_at`, `finished_at` | ISO 8601 |

Plugin statuses reuse the vocabulary of the other Scenario plugins, plus "awaiting approval", "Not sent" and "placed":

```
draft -> uploading inputs -> [awaiting approval] -> submitting
submitting -> queued | Not sent | Unknown
queued -> generating -> finished on Scenario -> downloading results
       -> results saved -> placed
queued, generating -> Failed | Blocked | Canceled
```

| Scenario job status | Plugin status |
|---|---|
| `pending`, `queued`, `warming-up` | queued |
| `in-progress`, `finalizing` | generating |
| `success` | finished on Scenario, then downloading results, then results saved |
| `failure` | Failed, or Blocked when the failure is moderation |
| `canceled` | Canceled |

Basis: status values documented in the Scenario API reference.

### 2.6 Helper and plugin link

1. An agent client starts the helper over stdio: `npx -y @scenario-labs/photoshop-mcp@1`, or the Claude Desktop bundle. The client config passes `SCENARIO_PHOTOSHOP_TOKEN` (written by Connect a client, section 7.4) and optionally `SCENARIO_NO_SPEND=1`.
2. The helper tries to bind `127.0.0.1:9878`. On success it is the owner. If the port is taken, it connects to `ws://127.0.0.1:9878` as a peer (Node is not bound by the UXP rule) and sends its token. If the holder does not answer the Scenario handshake within 2 s, every tool call returns `PortInUse: port 9878 is used by another program`.
3. The plugin's startup code dials `ws://localhost:9878` every 3 s while disconnected. If the `localhost` constructor throws, it tries `ws://127.0.0.1:9878` (D7 fallback).
4. The helper sends `hello {protocol, helper_version, token, clients}`. The plugin compares the token with the one in `secureStorage` (constant-time) and answers `welcome {plugin_version, photoshop_version, os, catalog_hash, switches}`, or closes with `PairingMismatch`.
5. Each tool call travels as `{id, session, client_name, tool, args}` and returns `{id, ok, result | error}`. The owner relays peer calls unchanged, with each peer's token; the plugin checks the token of each session.
6. When the owner exits, peers race to bind the port. The plugin reconnects within 3 s.
7. The helper serves `tools/list` from the catalog packaged with it, so a client sees the full list even when Photoshop is closed. Calls without a plugin return `NotConnected: open Photoshop with the Scenario plugin installed`. If the plugin's catalog hash differs, calls to tools the plugin does not know return `VersionMismatch` with both versions.

Limits: 10 MiB per message; idle peer connections close after 60 s without a ping; the Host header must name `127.0.0.1`, `localhost` or `[::1]`; any `Origin` starting with `http://` or `https://` is refused. What Origin the UXP WebSocket sends is assumed, to verify in Phase 3.

Threat model. The token keeps out processes that did not receive it through Connect a client: another account on the same machine, unrelated software holding the port, and web pages (with the Host and Origin checks). It does not stop software running under the same account, which can read client config files. Agents reach only the tools in MCP.md, under the switches in section 6.6.

### 2.7 How agents act safely

1. **Pairing.** Only clients configured with the current token reach the plugin. **Reset pairing token** in Settings disconnects all of them.
2. **Reading.** Once paired, agents may read document state, layer details and previews. What they read goes to the agent's model provider (PRIVACY.md).
3. **Spending.** Quote first, exact approved cost, idempotency key, then the Agent spending setting: ask in the panel each time by default (sections 6.1 to 6.3).
4. **Document changes.** Only through prepare and apply, and only while "Agents may modify the document" is on. Otherwise the apply becomes a proposal card the person applies or dismisses.
5. **Scripts.** `execute_batchplay` sits behind a second switch, off by default, which needs the first. It refuses save, close, quit and export events.
6. **Never.** Agents cannot save or close documents, resolve Unknown jobs, change settings or switches, read credentials, or upload files the person did not choose and the plugin did not make.
7. **Visible.** Every agent call that spends, uploads or changes the document appears in the activity log and as a toast, with the client name the client reported.

### 2.8 Toolkit behavior the plugin relies on

| Behavior | Toolkit (ExtendScript, verified live (27.11)) | UXP implementation | Where UXP differs | Basis of the UXP path |
|---|---|---|---|---|
| Capture with context margin | `ps_generative.capture`: box = selection bounds grown by half the long side, at least 64 px, clipped to the canvas; writes context, edit mask (white = selected) and the model mask in the model's polarity | `imaging.getPixels` with `sourceBounds`, `targetSize`, `colorProfile` sRGB and `componentSize` 8; `imaging.getSelection` for the mask | The toolkit converts a duplicate (32 to 16 bit, profile to sRGB relative colorimetric, then 8 bit) and steps History back. UXP reads and converts without touching the document, so no History step | documented; conversion of 16-bit, 32-bit and Lab assumed, to verify in Phase 3 |
| Place as an embedded smart object | `ps_io.place`: `placeEvent`, frame read from `smartObjectMore.transform`, fit exact, contain or cover | batchPlay `placeEvent` with a session token for a file in the plugin temp folder, then a `transform` to the target box | Same descriptors | verified live (27.11): lands embedded (`linked: false`) at native size, centered; `layer.bounds` reports the non-transparent box, so the frame comes from `smartObjectMore` |
| XMP provenance | `ps_io.place(xmp=...)`, `layer_xmp`, namespace `https://scenario.com/ns/photoshop/1.0/` | batchPlay `set` of `XMPMetadataAsUTF8` on the layer | Same | verified live (27.11): round-trips through save, close and reopen |
| Mask by selection | `ps_generative.place_edit`: mask rebuilt from the saved edit mask, feather 2 px, created with an Action Manager `make` on the mask channel | `imaging.putLayerMask` with the capture mask, feathered in JS | Different call. The plugin never creates masks with descriptors | verified live (27.11): `putLayerMask` creates the mask on a layer without one |
| One named History state per applied result | `ps_run` wraps each job in `suspendHistory` | `executeAsModal` + `hostControl.suspendHistory` / `resumeHistory` | Same | verified live (27.11): place + rename, replace + scale, mask, and opacity + new layer each showed as one entry |
| Outside-the-mask check | `ps_generative.verify`: outside the mask, max difference <= 2 means untouched | Composite reads of the capture box before and after the apply, at <= 1024 px long side | Reads downscaled; same threshold | assumed, to verify in Phase 3 |
| Seam and edit checks | `ps_generative.check`: ring 12 px, blur 4 px; bias < 12, residual < 6; `edited` when the inside mean difference >= 3; `aspect_ok`; `polarity_suspect` | Same math in JS on <= 512 px buffers, before the apply | Same | thresholds are authoring-time values from two real takes of one image (D13); assumed for other models |
| Replace contents | `placedLayerReplaceContents` keeps the transform and renames the layer; the toolkit restores the name | Same | Same | verified live (27.11) |
| Expand | `ps_generative.expand(left, top, right, bottom, overlap=32)` | Canvas resize and masked place inside one History suspension | Same | assumed, to verify in Phase 3 |
| Insert above a clipping chain | Inserting between a base and its clipped layers unclips the chain; insert above the chain top | Same rule | Same | verified live (27.11), ExtendScript |

Other UXP differences the build must respect:
- No `eval` without the `allowCodeGenerationFromStrings` permission, which the plugin does not request (documented). Agent scripts are batchPlay descriptor lists (section 7).
- Imaging returns 16-bit values from 0 to 32768 unless asked for full range (documented). The plugin always requests 8-bit components.
- Captures read the composite or one layer through imaging; the toolkits' read-only captures duplicate and step History back, which the plugin never does.

### 2.9 Headless and batch

- Photoshop has no headless mode for plugins. A `.psjs` opened from outside runs nothing, and Photoshop listens on no port (verified live (27.11)). Batch work therefore needs Photoshop open with the plugin loaded.
- v1: agents batch through the local tools on open documents. Every document tool takes an optional `document_id`. Jobs run in parallel on Scenario; applies run one at a time.
- Later: plugin steps recorded into Actions with `action.recordAction` (Photoshop 25.0 and later, documented), so File > Automate > Batch can replay "Scenario: Upscale" across a folder. Spend inside a recorded Action needs its own approval design (a budget approved for the whole batch), so it is not in v1.
- Outside Photoshop: pipelines without a document use the Scenario REST API or hosted Scenario MCP, with credentials from the environment.

### 2.10 Manifest

```json
{
  "manifestVersion": 5,
  "id": "<assigned at packaging>",
  "name": "Scenario",
  "version": "1.0.0",
  "main": "index.html",
  "host": { "app": "PS", "minVersion": "26.0", "data": { "apiVersion": 2, "loadEvent": "startup" } },
  "entrypoints": [
    {
      "type": "panel",
      "id": "scenarioPanel",
      "label": { "default": "Scenario" },
      "minimumSize": { "width": 280, "height": 420 },
      "preferredDockedSize": { "width": 320, "height": 640 },
      "preferredFloatingSize": { "width": 360, "height": 720 }
    }
  ],
  "requiredPermissions": {
    "network": {
      "domains": [
        "https://api.cloud.scenario.com",
        "https://<scenario-cdn-host>",
        "https://api.github.com",
        "ws://localhost:9878",
        "ws://127.0.0.1:9878"
      ]
    },
    "localFileSystem": "request",
    "launchProcess": { "schemes": ["https", "cursor"], "extensions": [] },
    "clipboard": "readAndWrite"
  }
}
```

- The CDN host list comes from real asset URLs in Phase 3 (assumed, to verify in Phase 3). Downloads go only to hosts in this list.
- `api.github.com` serves the update check (section 10.6), which a setting turns off.
- Not requested: `fullAccess`, `allowCodeGenerationFromStrings`, `webview`, `ipc`. Basis for the permission model: documented (manifest v5).
- Dev builds add a mock API host for tests. Release builds are checked in CI for the exact list above.

### 2.11 Repository layout

```
photoshop-plugin/
  plugin/        UXP plugin: manifest.json, index.html, src/<modules>, icons/
  helper/        scenario-photoshop: Node 20+, stdio server, port owner and peer, setup command
  shared/        tool catalog (JSON Schema), error types, protocol types
  docs/          USER_GUIDE.md, MCP.md (generated from shared/), KNOWN_LIMITATIONS.md, spec/
  test/          unit (Node), integration (fake plugin, mock Scenario API), live scripts
  PRIVACY.md  SECURITY.md  SUPPORT.md  RELEASING.md  CHANGELOG.md  README.md
  LICENSE  THIRD_PARTY_NOTICES.md
```

---

## 3. UX

Wireframes for every screen named here are in [wireframes.md](wireframes.md).

### 3.1 Panel layout

Default docked width 320 px, minimum 280 px. Top to bottom:

1. **Header**: Scenario mark (black and white), project name, agent status dot, **Jobs** with the count of active jobs, settings.
2. **Lane tabs**: Image, Edit, Enhance, Trained, Library.
3. **Lane body** (scrolls): source chip, model card, references, lane options, **Advanced** (every other schema parameter).
4. **Results tray**: takes of the latest job of this lane.
5. **Prompt bar** (fixed at the bottom): prompt, takes, size, and the Generate button carrying the price.

### 3.2 Lanes

| Lane | Tools | Release | Notes |
|---|---|---|---|
| Image | Text to image, with references | v1 | Lands fitted to the selection box (masked) or to the canvas |
| Edit | Selection edit, whole-layer edit | v1 | Any image-to-image model (D13); native mask input used when the model has one |
| Enhance | Upscale, Expand, Remove BG | v1 | One tool selector at the top of the lane |
| Enhance | Vectorize, Layers (decomposition) | v1.1 | SVG output; layered output |
| Trained | The team's trained models, run as Image or Edit | v1 | Edit through Photoshop masking is assumed, to verify in Phase 3 (D13 was not yet tested on a trained model) |
| Library | Team assets and collections | v1 | Place, use as reference, open as document |
| Workflows | Team workflows whose inputs are images | v1.1 | Each workflow input maps to a Photoshop source |
| Video | Image to video from a layer or selection | v1.1 | Files in the Output Folder; open as document |
| Audio | None in the panel | later | No Photoshop surface for audio; hosted Scenario MCP covers it |

Lanes that have not shipped are not shown. Lane order follows the use-case ranking.

### 3.3 Model picker

Opens from **Change** on the model card, as a full panel view with a back arrow. (Text fields render above overlays, so a floating picker would be covered by the prompt field.)

1. **Search**: filters locally on name, description, tags and base model.
2. **Type tabs**: Image, Edit, Enhance, Trained. The current lane's tab is selected. Each tab lists models whose catalog capabilities fit that lane.
3. **Category chips**: the catalog's own categories and tags (data, never hard-coded), plus three plugin chips: **Mask input**, **References**, **Favorites**.
4. **Rows**: 56 px thumbnail loaded at 2x, name, two-line description, badges (Mask input, up to N references, max output size, Trained). A star marks a favorite (stored locally).
5. **Order**: favorites, then Scenario's recommendation for the lane, then the newest. The recommendation source in REST is assumed, to verify in Phase 3; without it the order is favorites, then newest.
6. Choosing a model returns to the lane, fetches its schema and runs a price check.

The catalog is cached in the plugin data folder and refreshed in the background every 24 h and on demand. Private models come from the general list and are filtered locally, because a `filters.type` filter on private models is refused (verified live (Scenario API)). Model records are large, so the cache keeps display fields only.

### 3.4 Prompt bar

- Multi-line field that grows to 4 lines. Enter generates when the button shows a current price; Shift+Enter adds a line.
- **Takes**: 1, 2 or 4, within the model's limit. **Size**: presets from the schema; the default matches the target box aspect.
- Generate button labels:

| Label | When |
|---|---|
| `Generate N CU` | Exact price from a current quote |
| `Generate from N CU` | The charge can exceed the quote (section 6.1, step 6) |
| `Checking price...` | Dry run in flight |
| `Generate (price after upload)` | The model's dry run needs the input file (section 6.1, step 3) |
| `Price unavailable` | Disabled; the reason shows under the button |
| `Confirm N CU` | Second click in the price-after-upload case |

- Prices show up to three decimals, trailing zeros dropped.
- Up and Down in an empty field recall the last 20 prompts (stored locally).
- Prompt helper (Prompt Spark, priced separately): v1.1.

### 3.5 Source chip and selection-aware editing

The source chip states what the lane will read: `Selection 928 x 928`, `Layer "Background copy"`, `All visible`. It updates on Photoshop notifications (select, set, make, delete, open, close, document switch) through `action.addNotificationListener` (documented), coalesced at 200 ms. Its menu offers **All visible** (default) and **Current layer**.

Flow for a selection edit by a person:

1. The person selects an area with any tool, feathered or not. The chip reads `Selection W x H` and `Sample: All visible`.
2. They type a prompt. The button shows the price.
3. They click Generate. The plugin records the target: document id and title, canvas size and resolution, capture box, insert point, sample mode, and the selection mask (saved to the plugin temp folder).
4. Capture, in a short modal scope: the context box (selection bounds plus margin) read as sRGB 8-bit at upload size, and the mask.
5. Outside the modal scope: encode, then upload the context and, when the model has a mask input, the mask in the model's polarity.
6. Second dry run with the real asset ids. A different price stops the run and shows the new price for approval.
7. Ledger write, then submit. The panel stays free while the job runs.
8. On success: download the takes, run the checks, and place them (section 3.6).

| Situation | Behavior |
|---|---|
| No selection | The edit covers the current layer's bounds or the canvas; the result lands unmasked |
| Quick Mask is on | Chip reads "Quick Mask is on"; Generate is disabled; **Use Quick Mask as selection** leaves Quick Mask |
| Selection partly outside the canvas | Clipped to the canvas; "Selection is outside the canvas" when nothing remains |
| Selection smaller than 16 px | "Selection is too small to edit" |
| Selection changes after Generate | The job keeps the selection recorded at step 3 |
| Canvas size or resolution changed before the result lands | Masked placement is refused: "The canvas changed since this edit started." Offers **Place unmasked** and **Open as document** |
| Document closed | Results stay saved: **Place in current document**, **Open as document** |
| Insert point deleted | The result goes to the top of the stack |
| Insert point inside a clipping chain | The result goes above the chain's top layer (verified live (27.11), ExtendScript) |

Insert point: with **All visible**, the result goes to the top of the document, so adjustment layers are not applied twice. With **Current layer**, it goes directly above that layer, inside its group.

### 3.6 Results tray and takes

- **Place when ready** (on by default): when a person's job finishes, its document is still open and Photoshop is idle, the results land without a click. Otherwise they wait in the tray with **Place**. Results never land by themselves after a Photoshop restart, and agents' results never land by themselves.
- Several takes land as a group `Scenario <kind> <slug> (<n> takes)` with take 1 visible and the others hidden. Clicking a thumbnail in the tray shows that take. Visibility changes are not History states under Photoshop's default preference (verified live (27.11): stepping History does not restore visibility). **Keep this take** deletes the hidden takes in one History state.
- One take lands as a single layer.
- Each tray card: thumbnail, check badges, and **Place**, **Open as document**, **Use as reference**, **Details**, **Copy error**.

| Check badge | Condition |
|---|---|
| `Seam ok` | bias < 12 and residual < 6 |
| `Edge tone differs` | bias >= 12 |
| `May be misaligned` | residual >= 6 or aspect mismatch above 1% |
| `Unchanged inside` | inside mean difference < 3; with `polarity_suspect`, the text adds "the model may have read the mask inverted" |
| `Changed outside` | outside-the-mask check failed after the apply; card offers **Undo** |

### 3.7 Jobs view

Two tabs.

**On this computer** (the ledger). Newest first, filters All, Needs attention, Agents. Each row: thumbnail, title (lane and prompt slug), status, CU quoted and charged, origin ("You" or the client name), time.

| Status | Actions |
|---|---|
| uploading inputs, queued, generating | **Cancel** (sent to Scenario where Scenario allows it), **Details** |
| awaiting approval | **Approve N CU**, **Decline** |
| finished on Scenario, downloading results | **Stop download**, **Details** |
| results saved | **Place**, **Open as document**, **Use as reference**, **Show files** |
| placed | **Select layer**, **Details** |
| download stopped or incomplete | **Resume download** |
| Failed, Blocked, Not sent, Canceled | **Details**, **Copy error**, **Edit and retry** (a new quote) |
| Unknown | **Resolve** (section 6.2) |

**On Scenario**: the project's recent jobs from the jobs list, paged, including jobs made in the web app or other plugins. Actions: **Place results**, **Open as document**, **Use as reference**, **Add to this computer**. Nothing here spends.

### 3.8 First run

| Step | What the person does | Target |
|---|---|---|
| 1 | Installs the `.ccx` (double-click, or the command in the guide) | 20 s |
| 2 | Opens Plugins > Scenario | 5 s |
| 3 | Clicks **Create an API key**; the browser opens the key page; they create a key and copy it | 45 s |
| 4 | Pastes key and secret, clicks **Save and test** | 10 s |
| 5 | Reads the three-step ready card: pick a lane, select an area, describe the change | 5 s |
| 6 | Types a prompt in the Image lane with the default model and generates | 30 s plus generation time |

The target is under 2 minutes in total. The default model of each lane is Scenario's recommendation for speed when the API provides one (assumed, to verify in Phase 3), else a default chosen at release from the catalog and shipped as data. After the first placed result, a one-time card points to **Connect a client**.

### 3.9 Empty, loading and error states

| State | Message | Actions |
|---|---|---|
| Not signed in | "Connect your Scenario account to generate." | **Create an API key**, key fields |
| Key refused (401) | "Scenario did not accept this key and secret." | **Enter key again**, **Create an API key** |
| Forbidden (403) | Scenario's own message, prefixed "Scenario refused this request:" | **Copy error** |
| Not enough Creative Units | "Not enough Creative Units for this job." | **Open plans** |
| Rate limited (429) on a read | "Scenario is busy. Retrying in N s." | none (automatic) |
| Rate limited (429) on a paid call | "Not sent: Scenario asked to wait N s." | **Try again** (new quote) |
| Offline | Header banner "Offline. Price checks paused; jobs resume when the connection returns." | none |
| Catalog failed | "Models could not load." | **Retry** |
| No models for the lane | "No models in this lane match these filters." | **Clear filters** |
| No trained models | "Your team has no trained models yet. Train one on app.scenario.com." | **Open Scenario** |
| Library empty | "No assets in this project yet." | none |
| No jobs | "Jobs you start here or from an agent appear here." | none |
| Unsupported color mode | "This lane reads RGB, Gray or Lab documents." | **Make RGB copy** |
| 32-bit document | "32-bit documents are not supported yet. Convert a copy to 16-bit." | none |
| Photoshop busy | "Photoshop is busy. Placing when it is free." | none |
| Blocked | "Scenario blocked this request (content policy)." | **Details** |
| Failed | Scenario's failure text, plus "Charged N CU" when the job record shows a charge | **Copy error**, **Edit and retry** |
| Download failed 3 times | "Download stopped after 3 attempts." | **Resume download** |
| Result expired on Scenario | "This result is no longer available on Scenario." | **Details** |
| Agent port in use | "Agent connection unavailable: port 9878 is used by another program." | **Copy diagnostics** |

Loading: skeleton rows in lists, text next to every progress bar ("Uploading selection", "Generating 1 of 4", "Downloading 2 of 4"). No spinner without words.

### 3.10 Settings

| Section | Contents |
|---|---|
| Account | Project name, key shown as its last 4 characters, **Test connection**, **Sign out** |
| Spending | **Confirm above N CU** (default 100), **No-spend mode** |
| Results | Output Folder, **Place when ready**, **Leave prompts out of layer metadata**, mask feather (0 to 8 px, default 2) |
| Agents | Connection status, the two switches, Agent spending, **Connect a client**, activity log, **Reset pairing token** |
| Updates | **Check for updates on start** (on) |
| Diagnostics | **Run self-test** (free, section 12.2), **Copy diagnostics** (versions and states, never secrets) |
| About | License, privacy notice, Scenario terms |

### 3.11 Visual language

- Spectrum UXP widgets (`sp-button`, `sp-action-button`, `sp-textfield`, `sp-picker`, `sp-checkbox`, `sp-progressbar`), with Photoshop's theme variables so the panel follows the four interface brightness settings (documented).
- 8 px grid; 12 px body text, 11 px labels.
- No animation (UXP has no CSS transitions). State changes are immediate and labelled.
- Original icons that read in dark themes (Marketplace rule, documented). Black-and-white Scenario mark.

---

## 4. Sign-in and credentials

### 4.1 Options compared

| Option | Steps for the person | Works today | Fits UXP | Verdict |
|---|---|---|---|---|
| API key + secret | Create a key on the web, paste two values | Yes: REST accepts Basic auth (verified live (Scenario API)) | Yes | v1 |
| Device code | Click, see a code, approve in the browser; the panel polls | No: a dynamically registered client loses the device grant (verified live (Scenario API)); needs a first-party client | Yes: polling needs no redirect | v1.1, once Scenario provides the client |
| Authorization code + PKCE with a paste-code page | Click, sign in, copy a code, paste it | Not tested | Yes | v1.1 candidate |
| Loopback redirect | Click, sign in | n/a | No: UXP cannot listen | Not possible |

Two blockers apply to every OAuth option: bearer tokens work on hosted Scenario MCP only, not on REST (verified live (Scenario API)), and the plugin's calls are REST calls. Device code is the easiest flow for the person and is the target once Scenario provides a first-party client and REST accepts its tokens. Until then, key + secret with key creation one click away (D10).

### 4.2 Flow

1. The first-run screen reads "Connect your Scenario account".
2. **Create an API key** opens the key page on app.scenario.com in the default browser. Photoshop asks for consent on each such click (documented).
3. Two fields: API key and API secret. Pasting `key:secret`, or two lines, into the key field fills both.
4. The secret field is masked. On macOS a password field's value cannot be read; the documented workaround switches the field type to text while reading it (documented; assumed, to verify in Phase 3).
5. **Save and test** calls an authenticated read. On success the pair goes to `secureStorage` and the panel shows "Connected" with the project name if the API returns it (assumed, to verify in Phase 3). On 401: "Scenario did not accept this key and secret." Offline: "No connection to Scenario. Check your network."
6. The secret is never shown again. The key shows as its last 4 characters.
7. **Sign out** removes both values from `secureStorage`.

### 4.3 Where secrets live

| Secret | Stored in | Never in |
|---|---|---|
| API key and secret | `secureStorage`, per plugin (documented); persists across Photoshop restarts (verified live (27.11)) | Documents, XMP, the ledger, logs, diagnostics, the clipboard, the helper |
| Pairing token | `secureStorage`, and the client config the person creates | Documents, logs |
| Signed CDN URLs | Memory and the ledger (they expire) | Logs, XMP |

Logs redact `Authorization` headers and any token-like string of 32 characters or more. `secureStorage` and plugin data may not carry over to the next Photoshop major version (forum report; assumed, to verify on 28.0). If they do not, the panel asks for the key again; jobs on Scenario are unaffected.

### 4.4 Environment variables and automation

The brief asks for environment variables for automation. On the measured platform the plugin cannot read them: `process.env` is empty (verified live (27.11)). The helper can read its environment, but D9 keeps Scenario credentials out of the helper. The requirement is met in part:

| Variable | Read by | Effect | Release |
|---|---|---|---|
| `SCENARIO_NO_SPEND=1` | Helper | Every paid tool returns `NoSpend` before reaching the plugin | v1 |
| `SCENARIO_PHOTOSHOP_TOKEN` | Helper | Pairs the helper with the plugin | v1 |
| `SCENARIO_API_KEY`, `SCENARIO_API_SECRET` | Not read | The plugin uses the pair saved in its own storage | not provided |

Nearest design for automation: sign in once per machine and user in the panel; the key persists across restarts. Pipelines with no open document use the Scenario REST API or hosted Scenario MCP, which read the usual environment variables. Passing credentials from the environment to the plugin would mean the helper reading the key and forwarding it, which D9 rejects.

---

## 5. Capability matrix

### 5.1 Scenario capabilities

| Capability | Lane | Input from Photoshop | Result lands as | Release |
|---|---|---|---|---|
| Text to image | Image | Prompt; optional references | Embedded smart object fitted to the selection box (masked) or the canvas; takes as a group; or new document | v1 |
| Image to image, whole layer (restyle, camera angle, relight, restore, colorize) | Edit | Current layer or all visible; box = layer bounds or canvas | Smart object above the source, unmasked | v1 |
| Selection edit (inpaint; any aligned image-to-image model, D13) | Edit | Selection plus context margin; mask in the model's polarity when the model takes one | Smart object with a layer mask from the captured selection, feather 2 px | v1 |
| Expand (outpaint) | Enhance | All visible plus the new canvas area | Canvas resized and a masked smart object, in one History state | v1 |
| Upscale | Enhance | All visible, current layer or selection box | New document (default) or smart object holding the larger pixels | v1 |
| Remove background | Enhance | Current layer, or the selection box | Layer mask on the source layer (default) or a new cutout layer | v1 |
| Vectorize | Enhance | Current layer or all visible | SVG file; open as document or place as smart object | v1.1 |
| Layer decomposition | Enhance | All visible | Group of named, positioned smart objects | v1.1 |
| Trained models | Trained | As Image or Edit | As Image or Edit | v1 |
| References and consistency | Image, Edit | Selection, layer, all visible, Library asset, file | Input only | v1 |
| Library | Library | none | Smart object, reference, or new document | v1 |
| Image to video | Video | First frame from layer, all visible or selection | MP4 in the Output Folder; open as document (video layer) | v1.1 |
| Video to video, video upscale | Video | Needs the video file of a video layer | Files | later |
| Text to audio, music, sound effects | none | Prompt | Files only | later |
| 3D | none | Image as input | Files only | later |
| Textures and material maps | Image | Prompt, references | Smart object; extra maps as files | v1 (maps as files v1.1) |
| Skybox and 360 | Image | Prompt | New document at 2:1 | later |
| Workflows | Workflows | Each image input mapped to a source | Per output type, as above | v1.1 |
| Prompt helper (Prompt Spark) | Prompt bar | Prompt text | Prompt text, priced separately | v1.1 |
| Caption and describe | Library | Asset | Text | later |
| Usage and limits | Settings | none | Read-only display from the team limits endpoint | v1.1 |
| Model training | not offered | none | none | later, not planned (section 6.8) |
| Realtime generation | none | none | none | later (not probed) |

### 5.2 Input sources

| Source | How it is read | Release | Basis |
|---|---|---|---|
| Selection (any tool, feathered) | `imaging.getSelection` for the mask; box from the selection bounds plus margin | v1 | documented |
| Current layer (pixels, smart object, text, shape) | `imaging.getPixels` with `layerID` (rendered pixels) | v1 | documented |
| All visible | `imaging.getPixels` without `layerID` (composite) | v1 | documented; read speed verified live (27.11) |
| Whole document | Composite, capped to the model's input size | v1 | documented |
| Quick Mask | Converted to a selection on the person's click | v1 | documented (`quickMaskMode`) |
| Layer mask or alpha channel as the edit region | `imaging.getLayerMask` or channel read | v1.1 | verified live (27.11) that `getLayerMask` runs only inside a modal scope |
| Artboard | Artboard bounds as the box | v1.1 | documented (`artboards` read-only) |
| Smart object contents (inside the object) | none | later | |
| Video layer frame | none | later | |
| Library asset | Asset id, no upload | v1 | |
| File from disk | `localFileSystem` picker | v1 | documented |

### 5.3 Where results land

| Landing | How | Release | Basis |
|---|---|---|---|
| New embedded smart object layer | `placeEvent`, then transform to the target box | v1 | verified live (27.11) |
| Group of takes | Group with one visible take | v1 | assumed, to verify in Phase 3 |
| Layer mask from the selection | `imaging.putLayerMask` | v1 | verified live (27.11) |
| Mask on the source layer from a cutout's alpha | `imaging.putLayerMask` with the alpha | v1 | assumed for smart object layers |
| Replacement of selection contents | Masked smart object above the source; source pixels untouched. Pixel replacement is left to the person (merge down) | v1 | |
| New document | `app.open` of the downloaded file | v1 | documented |
| Replace contents of an existing Scenario layer | `placedLayerReplaceContents`, name restored | v1.1 | verified live (27.11) |
| New artboard | batchPlay artboard creation (the DOM is read-only) | v1.1 | assumed, to verify in Phase 3 |
| Linked smart object | none | later | |
| Rasterized pixel layer | Setting, off | v1.1 | |
| Video file | Output Folder; **Open as document** creates a video layer | v1.1 | assumed, to verify in Phase 3 |
| Video on the timeline | none: no timeline DOM | later | documented |
| Audio file | none | later | |

### 5.4 Color management

| Case | Behavior | Release | Basis |
|---|---|---|---|
| Capture from an RGB document | Pixels converted to sRGB, 8-bit, at read time, because Scenario uploads drop the ICC profile (a Display P3 image shifts) and reduce 16-bit to 8-bit | v1 | documented (imaging options); upload behavior verified live (Scenario API) |
| Results | Generated PNGs are untagged 8-bit and treated as sRGB. Before placing, the plugin inserts an sRGB `iCCP` chunk so Photoshop converts the smart object into the document's space | v1 | Scenario side verified live (Scenario API); Photoshop's conversion of the tagged file assumed, to verify in Phase 3 |
| Wide-gamut documents (Display P3, Adobe RGB, ProPhoto) | Colors outside sRGB clip in the capture. Outside the mask nothing changes. **Details** notes "sRGB result in a Display P3 document" | v1 | assumed, to verify in Phase 3 |
| 16-bit documents | Capture at 8-bit; the result is 8-bit inside a smart object. Smooth gradients inside an edit may band | v1 | documented (16-bit range), assumed for the rendering |
| 32-bit documents | Refused with a message in v1; capture through a 16-bit conversion in v1.1 | v1.1 | assumed, to verify in Phase 3 |
| Gray and Lab documents | Capture converted to sRGB; Photoshop converts the placed result for display | v1 | documented (modes), assumed for conversion |
| CMYK, Indexed, Multichannel, Bitmap, Duotone | Imaging cannot read them. v1: Image and Library lanes place results normally; capture lanes offer **Make RGB copy** (a new sRGB document). Capture through a temporary RGB duplicate | v1 (copy), v1.1 (duplicate) | documented |
| Untagged documents | Read as the working RGB space | v1 | assumed, to verify in Phase 3 |
| Content Credentials | The plugin keeps downloaded files byte for byte except the inserted color chunk. Some results carry a provider manifest; whether Photoshop keeps it on place is not tested | later | Live Check 19 not run |

### 5.5 Resolution and size limits

| Item | Rule | Release | Basis |
|---|---|---|---|
| Capture long side | The model's maximum input from its schema, else 2048 px; scale factor recorded; masks scaled the same | v1 | |
| Read cost and memory | Reads at upload size: a full 8000 x 8000 composite read took 317 ms, the same read at a 1024 px target 6 ms. One capture buffer at a time, at most 4096 px on the long side; `imageData.dispose()` after use | v1 | read times verified live (27.11), 8-bit; 600 MB warning documented |
| Result smaller than the box | Placed scaled up into the box; badge "Result is N px for an M px area" with **Upscale this take** | v1 | |
| Upscale factor | Output kept within the model's maximum and 30,000 px per side (PSD limit); beyond that, a note about PSB | v1 | documented |
| Expand | New canvas within 30,000 px per side; added area per side capped by the model's maximum output | v1 | documented |
| Upload size | PNG; the upload limit for large captures is checked against Scenario's limits in Phase 3 | v1 | assumed, to verify in Phase 3 |
| 16-bit pixel values | Always request 8-bit components | v1 | documented |
| Very large documents (20,000 px and up) | Captures read at upload size; applies place one smart object; tested in Phase 3 | v1 | assumed, to verify in Phase 3 |

### 5.6 Alpha

| Case | Behavior | Release | Basis |
|---|---|---|---|
| Layer or composite with transparency | Sent as RGBA PNG | v1 | verified live (Scenario API): uploads keep alpha |
| Mask polarity | Models differ: transparent = edit, white = edit, or black = edit. Source order: the schema's field description, then a polarity table shipped as plugin data, else white = edit. The `polarity_suspect` check flags a probable inversion | v1 | verified live (Scenario API) that polarity varies |
| Models with no mask input | The context goes alone; the mask is applied in Photoshop (D13) | v1 | verified live (27.11) on one model |
| Results with alpha | Placed as is; position from `smartObjectMore` | v1 | verified live (27.11) |
| Cutout to mask | Result alpha becomes the source layer's mask | v1 | assumed for smart object layers |

### 5.7 Non-destructive options

| Option | Default | Release |
|---|---|---|
| Every result is an embedded smart object | Always | v1 |
| Layer mask from the selection, feather 0 to 8 px | On for selection edits, 2 px | v1 |
| Takes as a group, switched by visibility | On | v1 |
| Remove BG as a mask on the source layer | On | v1 |
| Upscale to a new document | On | v1 |
| Prompt kept in layer metadata | On (setting to leave it out) | v1 |
| Swap a take into a transformed layer with Replace Contents | none | v1.1 |
| Rasterize on place | Off | v1.1 |
| Linked smart objects | none | later |

---

## 6. Safety and trust

### 6.1 Money contract

1. **A price check is a dry run.** `POST /v1/generate/custom/{modelId}?dryRun=true` returns `creativeUnitsCost` and creates no job (verified live (Scenario API)). It is free, runs 400 ms after the form stops changing, and never carries the `ipDetection` flag, whose fee is charged even on a dry run (documented).
2. **Parameters are validated before the dry run** against the model schema: names, types, enums, ranges, required inputs. Dry runs accept unknown parameter names (verified live (Scenario API)), so an unchecked typo would be priced and then run with defaults.
3. **Inputs.** Price checks upload nothing. If a model's dry run accepts the request without its file inputs, that price goes on the button. At Generate the inputs upload, and a second dry run with the real asset ids must return the same price; otherwise the run stops and shows the new price for approval. If the dry run needs the file, the button reads `Generate (price after upload)`: the first click uploads and prices, the second click spends. Whether dry runs price without file inputs is assumed, to verify in Phase 3, per model family.
4. **A dry run that returns a job id is an alarm.** Price checks stop for the session, the job id enters Jobs as Unknown, and the panel says "A price check created a job on Scenario."
5. **A quote is single use and expires after 120 s.** It is bound to a SHA-256 fingerprint of the model id, the canonical JSON of the parameters, the input asset ids, the capture record (document, canvas, box), the project, and a hash of the key id. Any change invalidates it.
6. **Display.** Up to three decimals. "from N CU" when the charge can exceed the quote: per-output or per-layer pricing, `quality: auto` (quoted at the highest price), and repeated steps. Some models quote a flat price while the charge varies with size; once known, Jobs shows "quoted N, charged M".
7. **Approval** follows section 6.3.
8. **Paid calls are never retried automatically.** Reads (catalog, schemas, job status, assets) retry with back-off and honor `Retry-After`.
9. **Response classes for the paid call:**

| Response | Plugin status | Reason |
|---|---|---|
| 2xx with a job id | queued | Accepted |
| 400, 401, 403, 404, 409, 422, 429 | Not sent | Scenario refused the request; no job exists |
| Credit errors | Not sent, "Not enough Creative Units" | No job exists |
| Timeout, connection lost, 5xx, unreadable body | Unknown | A job may exist |

10. **Moderation** shows as Blocked and is never retried.
11. **Failed jobs.** Scenario refunds failed generations unless the job carries `disableRefund` (documented). The plugin shows the charge from the job record and "No refund on failure" when the flag is set.
12. **Guards.** Confirm above N CU (default 100) for the person; **No-spend mode** in the panel; `SCENARIO_NO_SPEND=1` in the helper for agents; team caps from Scenario shown as errors. The plugin adds no cap of its own.

### 6.2 No double charge

Scenario's run endpoint takes no idempotency key (documented: none in the API reference). The plugin builds the guarantee locally.

1. Every submission has an idempotency key: the quote id for a person's click, or the agent's `idempotency_key` (the quote id when omitted).
2. Before the POST, the ledger writes the job with state `submitting`, the key, the fingerprint and the claim time, atomically.
3. A second `generate` with the same key returns the existing job with `replayed: true` and sends nothing. The same key with a different fingerprint returns `IdempotencyConflict`.
4. The POST result is classified as in section 6.1, step 9.
5. While a job is Unknown, any request with the same fingerprint is blocked: "A matching request may already be running. Resolve it in Jobs first."
6. Resolution, by the person only, in Jobs:
   1. The plugin lists jobs with `createdAfter` set to the claim time minus 10 minutes (this filter cannot be combined with `status` or `type`, documented) and pages until the claim time plus 60 minutes.
   2. Candidates are jobs with the same model id. The plugin pre-selects one only when its `metadata.input` matches the recorded parameters exactly, including the uploaded asset ids, which are unique per capture, and no other candidate matches.
   3. The person clicks **Link this job** (the job continues: polling, download, placement) or **Mark not sent** (durable; unblocks the fingerprint).
   4. With no candidate: **Check again** and **Mark not sent**.
7. At startup, every `submitting` record becomes Unknown.
8. Agents cannot resolve Unknown jobs. Recovery tools return `UnknownNeedsPerson`.

Prompt-only image jobs have no unique asset ids, so matching rests on model, parameters and time. The plugin pre-selects only a single exact match and never links without the person's click.

### 6.3 Approvals

| Who | Action | Approval |
|---|---|---|
| Person | Paid generation | The click on a priced Generate button; a confirm dialog above the threshold |
| Person | Document change | **Place when ready** for their own jobs, or a **Place** click; each change is one History state |
| Agent | Paid generation | Always: a quote from `estimate_cost` and `approved_cost` equal to its exact string. Then the Agent spending setting: **Ask each time** (default; an approval card in the panel), or **Allow without asking, up to N CU per call, until Photoshop quits** |
| Agent | Upload | Plugin-made captures and files the person chose in the panel this session; no card; logged |
| Agent | Document change | Switch on: applied as one History state "Scenario agent: ...". Switch off: proposal card |
| Agent | batchPlay | Second switch, off by default, requires the first |
| Agent | Resolve Unknown, change settings, save or close | Never |

The `approved_cost` check runs in the plugin and applies even when the person allows spending without asking. An agent's own statement of a price is never authorization.

With **Ask each time**, `generate` returns `awaiting_approval` at once with a `local_id`; the agent waits with `wait_for_job`. If the quote expired before the person approves, the plugin prices again on **Approve**: the same price submits; a different price updates the card and needs a new click.

### 6.4 Restart survival and downloads

1. The ledger lives in the plugin data folder, one file per job, atomic writes.
2. At Photoshop launch (startup code): `submitting` becomes Unknown; queued and generating jobs resume polling; downloads resume; saved results wait in the tray. Nothing lands in a document by itself after a restart.
3. Downloads come only from the Scenario CDN hosts in the manifest, into `<name>.part`, renamed after a header and size check. Three attempts with back-off. An expired signed URL is re-requested from the asset record. A partial file restarts from zero, or resumes with a Range request where the CDN supports it (assumed, to verify in Phase 3).
4. **Stop download** and **Resume download** in Jobs.
5. Polling every 2 s for the first minute, 5 s until 10 minutes, then 15 s. Paused while offline.
6. The plugin data path includes the Photoshop major version (`.../PHSP/27/...`, verified live (27.11)), and plugin data may not carry over to the next major (forum report; assumed, to verify on 28.0). When the person has chosen an Output Folder, the ledger is mirrored to `<Output Folder>/.scenario/jobs/`, and the first launch on a new major offers to import it (the person picks the folder again if Photoshop dropped the plugin's access to it). The On Scenario tab can re-add any finished job in all cases.

### 6.5 Undo

| Operation | History | Ctrl+Z |
|---|---|---|
| Place results, masked edit, cutout mask, upscale as a layer | One state, "Scenario: Place <kind>" | Removes all of it |
| Expand (canvas size and place) | One state, "Scenario: Expand" | Restores the canvas and removes the layer |
| Keep this take | One state, "Scenario: Keep take" | Restores the hidden takes |
| Agent apply | One state, "Scenario agent: <action>" | Removes it |
| Agent batchPlay | One state, "Scenario agent: <label>" | Reverts it |
| Remove Scenario layers (agent) | One state, "Scenario agent: Remove layers" | Restores them |
| Switching takes | Visibility only, not a History state by Photoshop's default | n/a |
| Open as document | A new document; the source document does not change | Close it |
| Generation | Not undoable: the job and its charge stay in Jobs | n/a |

Basis: one suspension giving one entry is verified live (27.11) for place, replace, mask, and opacity plus new layer. The Expand combination is assumed, to verify in Phase 3. After every apply of an edit, the outside-the-mask check runs; on failure the panel shows "Pixels outside the selection changed" with **Undo**.

### 6.6 The "Agents may modify the document" switch

- In Settings > Agents and on the Agents screen. Off by default. The person's choice persists across restarts. While it is on, the header shows "Agents can edit".
- **Off**: `apply_result_application` returns `pending_approval` and the panel shows a proposal card: client name, preview, target document and position, History name, **Apply** and **Dismiss**. A card expires after 10 minutes or when the canvas changes.
- **On**: the apply runs at once as one History state and shows a toast with **Undo**.
- A second switch, **Agents may run Photoshop scripts**, is off by default, needs the first, and carries this text: "Scripts can change anything Photoshop can change, except saving, closing and exporting. Turn on only for agents you trust."
- Switches apply to all documents, for the current Photoshop user.

### 6.7 What leaves the machine

Full text in [PRIVACY.md](../../PRIVACY.md). In short:
- To Scenario: the key and secret on each request; prompts and parameters, including during price checks; the pixels the person or a permitted agent chooses to send (the capture box with its margin, a layer, the composite, a file); downloads of results.
- To the agent's model provider: whatever a connected agent reads through the local tools, under the person's agreement with that provider.
- To GitHub: an update check at most once a day, which a setting turns off.
- Telemetry: none in v1. Any later telemetry is opt-in, off by default.
- Inside the PSD: layer metadata with the prompt and model, which travels with the file when it is shared.
- Uploads are named `photoshop-<purpose>-<date>-<short id>`. Document names, layer names and file paths are never sent to Scenario.

### 6.8 Adobe policy checks

| Rule | How v1 meets it | Basis |
|---|---|---|
| Privacy notice in the listing and in the plugin (Developer Terms 6.10) | PRIVACY.md, linked from Settings > About | documented |
| No use of content from Adobe software to create, train, test or improve AI (6.16) | No training action in the plugin. Before any Marketplace submission, Scenario confirms in writing how content uploaded through the plugin is used | documented; open item |
| Significant functionality beyond Adobe's own (6.9) | Scenario's catalog, trained models, the ledger | documented |
| Own end-user license (6.15) | MIT license plus Scenario's terms; a Marketplace EULA is written when a listing is decided | documented |
| No silent failures | Every failure has a message (section 3.9) | documented |
| No destructive or non-undoable AI action without consent | Results are new layers; one History state each; nothing overwrites pixels | documented |
| Original icons, readable in dark themes | Own icon set | documented |

---

## 7. Local Scenario MCP design

The full tool reference is [MCP.md](MCP.md). This section states the shape.

### 7.1 Principles

1. **Blender names where the semantics match**: `list_models`, `model_schema`, `estimate_cost`, `generate`, `job_status`, `wait_for_job`, `list_local_jobs`, `list_generations`, `recover_local_job`, `recover_cloud_job`, `cancel_job`, `cancel_prepared_job`, `capture_reference`, `upload_reference`, `reference_upload_status`, `inspect_result_previews`, `prepare_result_application`, `apply_result_application`, `list_assets`, `search_assets`, `list_collections`. Photoshop tools are verb-first in the same style: `document_summary`, `layer_detail`, `preview_document`, `select_layers`, `set_selection`, `remove_scenario_layers`, `execute_batchplay`.
2. **Small definitions**: a test caps `tools/list` at 40,000 characters and each description at 2,500.
3. **Every mutating tool reports what changed**: layer ids and names, History state name, check results, files written. A call that changed nothing returns an error that says so.
4. **No dialogs.** Anything that would open a Photoshop dialog returns an error with the reason.
5. **`null` means omitted.** Optional fields have defaults.
6. **Annotations**: read-only tools declare `readOnlyHint`; mutating tools `destructiveHint`; paid tools say so in the first line of their description.
7. **Errors** are one line, `Type: message`, with no secrets and no paths outside the plugin's folders and the Output Folder.
8. **Time limits**: 120 s per tool call; `wait_for_job` 45 s by default, 170 s at most.

### 7.2 Two servers

The server `instructions` say: start with `scenario_status` and `document_summary`; price with `estimate_cost` before `generate`; land results with `prepare_result_application` then `apply_result_application`; never drive Photoshop through another bridge for a Scenario job; use hosted Scenario MCP (mcp.scenario.com) for training, usage, collection changes and workflow authoring.

### 7.3 Tool groups

| Group | Tools | Release |
|---|---|---|
| Document (read) | `scenario_status`, `document_summary`, `layer_detail`, `preview_document` | v1 |
| Scenario (read, free) | `list_models`, `model_schema`, `recommend_models`, `estimate_cost`, `job_status`, `wait_for_job`, `list_local_jobs`, `list_generations`, `list_assets`, `search_assets`, `list_collections`, `inspect_result_previews` | v1 |
| Inputs (uploads, free) | `capture_reference`, `upload_reference`, `reference_upload_status` | v1 |
| Spending | `generate` | v1 |
| Recovery | `recover_local_job`, `recover_cloud_job`, `cancel_job`, `cancel_prepared_job` | v1 |
| Document changes (switch) | `prepare_result_application`, `apply_result_application`, `select_layers`, `set_selection`, `remove_scenario_layers` | v1 |
| Scripts (second switch) | `execute_batchplay` | v1 |
| Workflows | `list_workflows`, `workflow_schema`, `estimate_workflow`, `run_workflow`, `workflow_job_steps`, `decide_workflow_step` | v1.1 |
| Prompt helper | `estimate_prompt`, `approve_prompt`, `read_prompt_result` | v1.1 |
| Export | `export_image` (new files in the Output Folder only) | v1.1 |

### 7.4 Connect a client

The brief asks for buttons that set up Claude Code, Codex, Cursor and Claude Desktop. In the Blender plugin those buttons write each client's config file. A UXP plugin with `localFileSystem: "request"` can write outside its folders only through a file picker; writing `~/.claude.json` directly would need `fullAccess`, which this plugin does not request (documented; D7 keeps the permission list narrow). The nearest design gives each client the shortest path that works from the panel:

| Client | Primary button | What happens | Basis |
|---|---|---|---|
| Claude Code | **Copy command** | Copies `claude mcp add --scope user scenario-photoshop -e SCENARIO_PHOTOSHOP_TOKEN=<token> -- npx -y @scenario-labs/photoshop-mcp@1`; the person pastes it in a terminal | documented (client CLI); assumed, to verify in Phase 3 |
| Codex | **Copy command** | Copies `codex mcp add scenario-photoshop --env SCENARIO_PHOTOSHOP_TOKEN=<token> -- npx -y @scenario-labs/photoshop-mcp@1` | documented (client CLI); assumed, to verify in Phase 3 |
| Cursor | **Add to Cursor** | Opens Cursor's server install link with the `scenario-photoshop` entry (one Photoshop consent dialog, then Cursor's own confirmation) | documented (Cursor install links); assumed, to verify in Phase 3 |
| Claude Desktop | **Get the extension** | Opens the release page of `scenario-photoshop-<version>.mcpb`; double-clicking installs it in Claude Desktop, which asks for the pairing token (**Copy token** next to the button) | documented (Claude Desktop extensions); assumed, to verify in Phase 3 |
| Any | **Copy JSON**, **Copy TOML** | The server entry for manual setup | |
| Any, with Node | **Copy setup command** | `npx -y @scenario-labs/photoshop-mcp@1 setup <client> --token <token>`: replaces only the `scenario-photoshop` entry, backs up the file as `<file>.scenario-backup-<time>`, writes atomically, and leaves a file it cannot parse untouched | design |

- Each row shows "Connected, last call 2 min ago" or "Not connected", from the clients the helper reports. Rows show for all four clients, because the plugin cannot check which config files exist.
- `npx` needs Node 20 or later. The Claude Desktop bundle runs on the Node that ships with Claude Desktop (documented), so a Photoshop-only user can connect an agent without installing Node.
- The token in a copied command lands in the person's shell history and the client's config file. It grants access to the local plugin link only. **Reset pairing token** invalidates it.

---

## 8. Skills integration

The Photoshop skills pack in `scenario-labs/skills` (`skills/dcc/photoshop/`) has a lead skill, `scenario-photoshop-expert`, and six specialists: generative-edit, upscale-restore, compositing, key-art, mockups and game-art. Today the toolkits drive Photoshop through ExtendScript sent by AppleScript (`ps_run`, macOS only) and call Scenario through hosted Scenario MCP.

| Skill | Changes when the plugin is connected | Stays |
|---|---|---|
| `scenario-photoshop-expert` (lead) | Detects the `scenario-photoshop` server (`scenario_status`); routes generation, capture and placement through it; falls back to the current path when it is absent | Audits (`ps_audit`), gates (`ps_gates`), review sheets (`ps_review`) |
| generative-edit | `capture`, `place_edit` and `verify` become `capture_reference`, `prepare_result_application(purpose="edit_selection")` and the apply read-back with its checks | Prompting and selection craft, the seam gate thresholds |
| upscale-restore | Input and placement through the Upscale tool and `prepare_result_application` | The comparison stack (Preserve Details 2.0 baseline, crops) and alignment checks |
| compositing | Plates and cutouts land through the plugin | Masking, Blend If, tone and grain matching, skin work |
| key-art | Plates land through the plugin | Canvases, type layout, export under a byte cap |
| mockups | Designs land through the plugin | Placeholder fit, warp, lighting, Displace |
| game-art | Textures land through the plugin | Tile checks, texture export, 9-slice |

- A new core skill `scenario-photoshop` teaches agents the local server: setup, tool order (read the document, pick and price, generate, wait, prepare, apply, check), the money rules, placement rules, and common mistakes. It is updated in the same release cycle as any tool change.
- With `execute_batchplay` (v1, behind its switch), toolkit steps that are Action Manager descriptors can run inside the plugin, which also makes them work on Windows. Porting the toolkits to batchPlay is v1.1 work in the skills repo.
- **Bundling.** The plugin does not bundle or install skills. Connect a client shows `npx skills add scenario-labs/skills` as a copy command. Reasons: skills ship on their own cycle, a bundled copy would drift, and the plugin cannot write to client skill folders without broad file access.

---

## 9. Asset conventions

### 9.1 Names

| Item | Pattern | Example |
|---|---|---|
| Layer (one take) | `Scenario <kind> <slug> <tail6>` | `Scenario edit blue-iris a1b2c3` |
| Group (several takes) | `Scenario <kind> <slug> (<n> takes)` | `Scenario image forest-plate (4 takes)` |
| Take inside a group | `Take <i> <tail6>` | `Take 2 d4e5f6` |
| Library item | `Scenario library <asset-slug> <tail6>` | `Scenario library logo-mark 0a9b8c` |
| History state (person) | `Scenario: <action>` | `Scenario: Place edit` |
| History state (agent) | `Scenario agent: <action>` | `Scenario agent: Place image` |

- Kinds: `image`, `edit`, `expand`, `upscale`, `cutout`, `library`; later `vector`, `layers`, `video`.
- Slug: the first four meaningful words of the prompt, lowercase, hyphenated, at most 24 characters. Tail: the last six characters of the asset id.
- The person can rename freely. The plugin finds its layers by layer id and XMP, never by name.

### 9.2 Layer metadata

Namespace `https://scenario.com/ns/photoshop/1.0/`, prefix `scenario`, written on each result layer (and on the group for takes) through `XMPMetadataAsUTF8` (verified live (27.11)).

| Field | Content |
|---|---|
| `scenario:schema` | `1` |
| `scenario:assetId`, `scenario:jobId` | Scenario ids of this result |
| `scenario:modelId`, `scenario:modelName` | Model at generation time |
| `scenario:prompt`, `scenario:negativePrompt` | Left out when **Leave prompts out of layer metadata** is on |
| `scenario:parameters` | Canonical JSON, file inputs as asset ids |
| `scenario:inputAssetIds` | Uploaded or Library inputs |
| `scenario:cuQuoted`, `scenario:cuCharged` | Decimal strings |
| `scenario:createdAt` | ISO 8601 |
| `scenario:kind`, `scenario:take` | As in 9.1 |
| `scenario:captureBox`, `scenario:sample` | `x,y,w,h` in document pixels; `allVisible` or `layer` |
| `scenario:origin` | `person` or `agent:<client name>` |
| `scenario:pluginVersion` | Plugin version |

Never written: credentials, signed URLs, team or project ids, local file paths. A shared PSD carries these fields, so prompts travel with it unless the setting is on. **Details** on a layer reads them back.

### 9.3 Output folders

- Output Folder default: `Scenario/` inside the plugin data folder, which needs no permission prompt. **Choose Output Folder** picks any folder and keeps access with a persistent token (documented).
- Layout: `<Output Folder>/<kind>/<YYYYMMDD>/<YYYY-MM-DD>-<slug>-<tail6>[-take<i>].<ext>`.
- Captures: plugin temp folder, `captures/<local_id>/` with `context.png`, `mask.png`, `model-mask.png`, `capture.json`. Removed 7 days after the job reaches a final state.
- Ledger: plugin data folder, `jobs/`.
- Placed results are embedded, so a PSD does not depend on the Output Folder.

---

## 10. Packaging, versioning, release, distribution

### 10.1 Release artifacts

| Artifact | Contents |
|---|---|
| `scenario-photoshop-plugin-X.Y.Z.ccx` | The UXP plugin, packaged with the UXP Developer Tool CLI (documented) |
| `@scenario-labs/photoshop-mcp@X.Y.Z` on npm | The helper, published with npm provenance |
| `scenario-photoshop-X.Y.Z.mcpb` | Claude Desktop extension wrapping the helper |
| `scenario-photoshop-handbook-X.Y.Z.html` | The user guide as one page |
| `SHA256SUMS` | Checksums of every file above |
| Build attestation | GitHub artifact attestation for each file |

### 10.2 Install

- Double-click the `.ccx`: Creative Cloud desktop installs it after a "not verified" warning (documented).
- Command line: the Unified Plugin Installer Agent installs and removes a `.ccx` with no admin or "not verified" prompt (verified live (27.11) on a machine with Developer Mode on; without Developer Mode, assumed, to verify in Phase 3). The guide gives the exact commands for macOS and Windows.

### 10.3 Versioning

- SemVer. Plugin, helper and bundle share one version. The manifest version mirrors it.
- The plugin-helper protocol has its own integer version. A different protocol version gets "Update the agent helper to X.Y" in the panel and `VersionMismatch` for agents.
- Before 1.0, features bump the minor version. 1.0.0 is set deliberately with a `Release-As` footer.

### 10.4 Release automation

- release-please on `main` opens the release PR; merging it publishes. Tag `photoshop-plugin-vX.Y.Z`. RELEASING.md describes the steps and recovery.
- The release workflow builds and packages the `.ccx`, publishes the npm package, builds the `.mcpb` and the handbook, writes `SHA256SUMS`, and attests each artifact.
- CI on every pull request: lint (including shadowed globals and secret patterns), unit tests, helper integration tests, the `tools/list` size test, MCP.md regeneration diff, manifest permission check, link check, and a public-content check that rejects internal names and ids.

### 10.5 Platforms

macOS on Apple silicon and Intel is the tested platform. Windows 10 and 11 run the same code and the same helper; Windows stays in KNOWN_LIMITATIONS as not tested until a Windows pass is done.

### 10.6 Distribution plan

| Channel | v1 | Later |
|---|---|---|
| GitHub releases | All artifacts | |
| npm | Helper | |
| photoshop.scenario.com (planned) | Handbook and download links | Update feed |
| Adobe Marketplace | Not in v1 | After a maintainer decision and the section 6.8 checks |
| Update check | The plugin reads the latest release from the GitHub API at most once a day and shows "Update available" with a link; it never installs anything | A signed update manifest |

---

## 11. Licensing

- MIT (D1). `LICENSE` at the repository root, "Copyright (c) 2026 Scenario".
- Dependencies under MIT, Apache-2.0 or BSD licenses only. `THIRD_PARTY_NOTICES.md` is generated in CI. Expected: the Model Context Protocol TypeScript SDK, `ws`, a deflate library for PNG. The exact list is fixed in Phase 3.
- No code from the Scenario Blender plugin (GPL-3.0) or from other projects. Everything is written from this spec and public documentation.
- Use of Scenario is governed by Scenario's terms. Use of Photoshop APIs by Adobe's developer terms. "Photoshop" is used descriptively; no Adobe logos.

---

## 12. Test plan, milestones, risks

### 12.1 Automated tests

| Area | Covers | Runs in |
|---|---|---|
| util | SHA-256 test vectors, UTF-8, PNG encode and decode round trip, `iCCP` insertion that keeps other chunks, canonical JSON | Node |
| forms and quotes | Schema validation, fingerprint binding, 120 s expiry, alarm on a dry run that returns a job | Node with a mock API |
| idempotency | Replay with the same key, conflict on a changed payload, block while Unknown | Node |
| jobs | State machine with restart transitions; 401, 403, 429, 5xx, timeouts, offline; `.part` files, rename, three attempts, expired URLs; failed job with a charge | Node with a mock API |
| Unknown resolution | Exact match pre-selected; two matches pre-select nothing; prompt-only jobs | Node |
| checks | Seam, edited, aspect, polarity and outside-the-mask math on synthetic shifts, scales and tints | Node |
| helper | stdio protocol, owner and peer election, token checks, Host and Origin checks, 10 MiB cap, `tools/list` size cap, `null` handling, error format, `NoSpend`, setup command (backup, atomic write, invalid file untouched) | Node |
| docs | MCP.md equals the generated file; links; public-content check | CI |

### 12.2 Live tests in Photoshop

Run on 27.11 first; on a 26.x build when one can be installed; on 28.0 when it ships. Each item is recorded as verified live, tested automated, or not tested.

1. Install from `.ccx` by double-click and by command line; first launch with the panel closed (startup code connects).
2. Sign-in: create key, paste, test; wrong key; offline; sign out; persistence across restart.
3. Picker: search, chips, trained models, favorites.
4. Price display: exact, "from", price after upload, confirm above threshold, no-spend mode.
5. Every v1 lane with real generations at the smallest settings: Image, Edit (selection, feathered selection, no selection, Quick Mask), Expand, Upscale (new document and layer), Remove BG (mask and layer), Trained (image and selection edit), Library.
6. Color: sRGB, Display P3, Adobe RGB, 16-bit, Gray, Lab documents; CMYK message and **Make RGB copy**.
7. Large documents: 8000 x 8000 and 20,000 x 20,000; panel stays responsive; memory warning absent.
8. Undo and redo for every operation in section 6.5; one History entry each.
9. Restart recovery: quit Photoshop during upload, while `submitting` (test hook delays the response), while generating, while downloading.
10. Error paths: 401, 403, 429, offline, partial download, expired URL, Blocked, failed with charge.
11. Agent session driven by a real client: pairing, every v1 tool, approval cards, proposal cards, both switches, `NoSpend`, two clients at once, owner exit and peer takeover.
12. Connect a client for each of the four clients from a clean machine.
13. Open platform items: `executeAsModal` timing and Escape (Live Check 5), drag and drop onto the panel (Live Check 18; drag stays out of v1 until it passes), Content Credentials on placed results (Live Check 19), Origin header of the UXP WebSocket, dry runs without file inputs, password field workaround.
14. **Run self-test** (Settings > Diagnostics), free: on a scratch document, place a bundled image, mask it, write and read XMP, check one History entry, run the outside-the-mask check, close the document without saving.

A reviewer installs the plugin from scratch following only the docs and reports every friction point, against the 2-minute first-generation target.

### 12.3 Milestones

| Milestone | Content | Exit |
|---|---|---|
| M1 Skeleton | Manifest, panel shell, startup code, helper stdio, port election, pairing | Agent sees `scenario_status` from a live Photoshop |
| M2 Account and catalog | Sign-in, catalog cache, picker, schema forms, price checks | Exact price on the button for three model families |
| M3 Image lane | Capture of references, place, XMP, takes, one History state | First generation under 2 minutes from install |
| M4 Edit and Enhance | Selection capture, masks, checks, Expand, Upscale, Remove BG | Outside-the-mask check passes on real takes |
| M5 Jobs | Ledger, recovery, Unknown resolution, downloads | Restart tests in 12.2 item 9 pass |
| M6 Agents | All v1 tools, switches, approval and proposal cards, Connect a client | Real agent session passes 12.2 item 11 |
| M7 Trained and Library | Trained lane, Library lane | Trained selection edit tested live |
| M8 Release | Docs, packaging, release workflow, live pass, reviews | Review exit criteria met; PR opened |

### 12.4 Risks

| Risk | Mitigation | Basis |
|---|---|---|
| Quote differs from the charge | "from N CU"; Jobs shows quoted and charged; per-model notes in KNOWN_LIMITATIONS | verified live (Scenario API) |
| Dry runs need file inputs for many models | "Price after upload" path | assumed, to verify in Phase 3 |
| Unknown jobs linked to the wrong cloud job | Exact match only; person confirms | design |
| Trained models do not return aligned output | Seam and aspect checks; unmasked fallback; result labelled | assumed, to verify in Phase 3 |
| Color shift in wide-gamut documents | `iCCP` tagging; tests in 12.2 item 6 | assumed, to verify in Phase 3 |
| Plugin data and key lost on the next Photoshop major | Ledger mirror in the Output Folder; On Scenario tab | assumed, to verify on 28.0 |
| Localhost rule changes in a later UXP | D7 fallback entry; error shown with the port | verified live (27.11) for the current rule |
| Modal contention with other plugins | Back-off, queued applies, `PhotoshopBusy` | documented |
| Memory on very large documents | Upload-size reads, one buffer, dispose | documented |
| PNG encoding blocks the UI on large captures | Chunked encoding; measured in Phase 3 | assumed, to verify in Phase 3 |
| Helper setup friction | Copy commands, Cursor link, Claude Desktop bundle; status per client | design |
| Agent spending prompts slow autonomous runs | Session allowance per call | design |
| Marketplace terms on AI training | No training action; written confirmation before any submission | documented |
| Windows not tested | Listed in KNOWN_LIMITATIONS until a pass | |
| Photoshop 28.0 changes UXP behavior | Re-run 12.2 on release day | documented release timing |

---

## Open choices made in this spec

| Choice | Decision | Reason |
|---|---|---|
| Loopback port (D9 left open) | 9878, fixed, no hopping | Distinct from 9876, 8791 and 9877 used by the other Scenario plugins. A fixed port keeps client configs and the manifest entry valid, and the manifest cannot list a range |
| Helper distribution (D9 left open) | npm package for `npx`, plus a Claude Desktop `.mcpb` bundle; no standalone binaries in v1 | `npx` covers the three CLI-based clients. The bundle gives Photoshop-only users a path without Node. Standalone binaries need code signing to pass Gatekeeper and SmartScreen, so they wait |
| Pairing | A token generated in the plugin, carried in the client config as `SCENARIO_PHOTOSHOP_TOKEN`, checked by the plugin on each helper hello | The plugin dials out, so it must verify who holds the port. A token in the client config costs the person nothing after Connect a client |
| Connect a client | Copy commands, a Cursor install link and a Claude Desktop bundle instead of direct config writes | Writing client files from UXP needs `fullAccess`, which this plugin avoids |
| Environment credentials | Not supported in the plugin; `SCENARIO_NO_SPEND` honored by the helper | `process.env` is empty in UXP and D9 keeps the key out of the helper |
| Agent spending default | Ask in the panel each time; optional per-call allowance until Photoshop quits | The brief requires in-product approval before spend. The allowance keeps long agent runs possible |
| Pricing before upload | Dry run without file inputs; exact re-check after upload before submitting | No pixels leave before the person clicks Generate, and the spend still matches a shown price |
| Idempotency | Quote id as the default key, optional `idempotency_key`, local replay | Scenario has no idempotency key. A replayed call returning the same job covers lost responses on the stdio and socket hops |
| Unknown resolution | Pre-select only one exact `metadata.input` match; the person confirms; "Mark not sent" is durable | A wrong link either hides a charge or downloads someone else's job. Durable marks keep the decision after a restart |
| After a restart | Polling and downloads resume by themselves; nothing lands in a document | Polling and downloads cost nothing. Document changes need a fresh decision |
| Place when ready | On for the person's own jobs while the document is open and Photoshop is idle; never for agents | Matches how Photoshop's own generation lands results, while keeping agent changes under the switch |
| Output Folder default | Inside the plugin data folder | `~/Downloads` would need a picker or `fullAccess`. Results are embedded in the PSD anyway |
| Takes | A group with one visible take; switching by visibility | Cheap to switch, every take stays inspectable, and **Keep this take** cleans up in one History state |
| Agent scripts | batchPlay descriptor lists only | `eval` needs `allowCodeGenerationFromStrings`, a permission that widens review and risk. Descriptors cover what the toolkits do |
| CMYK and other modes | **Make RGB copy** in v1; capture through a temporary duplicate in v1.1 | Imaging cannot read these modes, and a hidden duplicate on large print files needs testing first |
| Result color tagging | Insert an sRGB `iCCP` chunk before placing | Results arrive untagged; tagging makes Photoshop convert into the document's space instead of guessing |
| Lanes in v1 | Image, Edit, Enhance (Upscale, Expand, Remove BG), Trained, Library, plus Jobs | They cover use cases 1 to 10, 13 and 15. Workflows, Video, Vectorize and Layers need their own landing designs and tests |
| Panel width | 320 px docked by default, 280 px minimum | Five lane tabs fit at 64 px each, and the panel shares a dock column with Layers |
| Startup code | `loadEvent: "startup"` | Jobs resume and agents connect without the panel open (verified live (27.11)) |
| Update check | GitHub releases API, once a day, can be turned off | Lets people learn about fixes without a marketplace; sends only a request to GitHub |
| Skills | Not bundled; a copy command for `npx skills add scenario-labs/skills` | Skills ship on their own cycle, and the plugin cannot write client skill folders |
