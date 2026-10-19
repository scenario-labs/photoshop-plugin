# Local Scenario MCP server: tool reference (spec v1)

Status: draft for review, 2026-10-19. This is the design reference for the tools of `scenario-photoshop` 1.0. The published `docs/MCP.md` is generated from the tool definitions in `shared/` once they exist, and must match this file.

Read with [SPEC.md](SPEC.md): architecture in section 2.6, safety in section 6, agent rules in section 2.7.

## 1. Servers and transport

| Item | Value |
|---|---|
| Server name | `scenario-photoshop` |
| Client transport | stdio. The client starts `npx -y @scenario-labs/photoshop-mcp@1` or the Claude Desktop bundle |
| Helper to plugin | WebSocket on `127.0.0.1:9878`; the plugin dials `ws://localhost:9878` |
| Pairing | `SCENARIO_PHOTOSHOP_TOKEN` in the client config; the plugin checks it on each helper hello |
| Spend guard in the environment | `SCENARIO_NO_SPEND=1` makes every paid call return `NoSpend` |
| Limits | 10 MiB per message; 120 s per tool call; `wait_for_job` 45 s by default, 170 s at most |
| Hosted counterpart | Hosted Scenario MCP at mcp.scenario.com for training, usage, collection changes and workflow authoring |

Server instructions sent at `initialize`:

> Photoshop is open on this computer with the Scenario plugin. Start with `scenario_status` and `document_summary`. Price every generation with `estimate_cost` and show the price to the user before `generate`. Land results with `prepare_result_application`, then `apply_result_application`. Never repeat a `generate` with a new `idempotency_key` after a timeout: call it again with the same key, or call `job_status`. Do not drive Photoshop through another bridge for Scenario work. For training, usage, collection changes and workflow authoring, use hosted Scenario MCP.

## 2. Conventions

- **Names** follow the Scenario Blender plugin where the semantics match, verb-first snake case. The "Blender" column in each table says `same`, `similar` (same purpose, Photoshop inputs) or `new`.
- **Ids**: `local_id` (a job in the plugin's ledger), `job_id` (Scenario job), `capture_id`, `reference_id`, `quote_id`, `application_id`, `asset_id`, `layer_id` and `document_id` (Photoshop ids, valid for the current Photoshop session).
- **`document_id`** is optional on every document tool and defaults to the active document.
- **`null` means omitted.** Every optional input has a default.
- **Annotations**: read-only tools declare `readOnlyHint: true`. Tools that change the document declare `destructiveHint: true`. The paid tool says so in the first line of its description.
- **Errors** are one line, `Type: message` (section 7). They never contain credentials or paths outside the plugin's folders and the Output Folder.
- **Size**: a test caps `tools/list` at 40,000 characters and each description at 2,500.
- **Who sees what**: anything a tool returns goes to the agent's model provider. Previews contain document pixels.

**Cost column.** "Free" means no Creative Units are spent. "Spends" means the call can spend Creative Units after the checks in section 3. "Uploads" means document pixels or a file leave the machine for Scenario, without spending.

## 3. Money flow for agents

1. `estimate_cost` runs a dry run on Scenario and returns a `quote_id` and `cu_cost_exact`, a decimal string. Free.
2. The agent shows the price to the person in its own interface.
3. `generate` carries `quote_id`, `approved_cost` equal to `cu_cost_exact` character for character, and optionally an `idempotency_key`. The plugin checks:
   1. The quote exists, was issued by this plugin, is unused or used by the same key, and is less than 120 s old.
   2. `approved_cost` equals the quote's exact string.
   3. Lane, model and parameters match the quote's fingerprint.
   4. `SCENARIO_NO_SPEND` and the panel's No-spend mode are off.
   5. No Unknown job has the same fingerprint.
4. Then the Agent spending setting applies:
   - **Ask each time** (default): `generate` returns `status: "awaiting_approval"` at once. The panel shows an approval card (client name, model, takes, prompt, input thumbnails, price) with **Approve N CU** and **Decline**. The agent calls `wait_for_job`.
   - **Allow without asking, up to N CU per call**: calls at or under the allowance submit at once; calls above it get an approval card.
5. Before the request goes to Scenario, the ledger records the job as `submitting` with the idempotency key.
6. The result is `queued` (accepted), `Not sent` (Scenario refused it; nothing was charged) or `Unknown` (the connection failed after sending; a job may exist).

**Idempotency.** The key defaults to the `quote_id`. Calling `generate` again with the same key returns the same `local_id` with `replayed: true` and sends nothing, whatever state the job is in, Unknown included. The same key with a different request returns `IdempotencyConflict`. A used quote with a different key returns `QuoteUsed`. Scenario's API has no idempotency key, so this check is local; it covers lost responses between the agent, the helper and the plugin. When a response is lost between the plugin and Scenario, the job becomes Unknown and only the person can resolve it in the panel (SPEC section 6.2).

## 4. Tools (v1)

### 4.1 Document (read)

| Tool | Blender | Inputs | Output | Side effects | Cost |
|---|---|---|---|---|---|
| `scenario_status` | new | none | `connected` (plugin link), `signed_in`, `project_name`, `plugin_version`, `helper_version`, `photoshop_version`, `os`, `switches` {`agents_may_modify`, `agents_may_run_scripts`}, `agent_spending` {`mode`: `ask` or `allow`, `per_call_limit`}, `no_spend`, `active_document_id`, `open_documents`, `unknown_jobs` | None | Free |
| `document_summary` | similar (`scene_summary`) | `document_id`, `layer_limit` (default 200, max 1000), `cursor` | `document` {id, title, file name, saved, width, height, resolution, mode, bits, profile}, `selection` {bounds} or null, `quick_mask`, `active_layer_ids`, `layers` [{id, name, kind, visible, opacity, blend, bounds, parent_id, clipped, has_mask, locked, scenario {asset_id, kind} when present}], `history` {count, current}, `artboards`, `next_cursor` | None | Free |
| `layer_detail` | similar (`object_detail`) | `layer_id`, `document_id` | Layer fields above, plus smart object info {embedded, content size, transform}, mask bounds, text {content, font, size} for text layers, adjustment kind, all Scenario provenance fields | None | Free |
| `preview_document` | similar (`screenshot_viewport`) | `document_id`, `source` (`all_visible` default, or `layer`), `layer_id`, `box` [x, y, w, h], `max_px` (default 1024, max 1600), `show_selection` (default false) | JPEG image, plus {width, height, scale, box} | A short modal read; no document change | Free. The image goes to the agent's provider |

### 4.2 Scenario catalog, quotes, jobs and library (read)

| Tool | Blender | Inputs | Output | Side effects | Cost |
|---|---|---|---|---|---|
| `list_models` | same | `lane` (`image`, `edit`, `enhance`, `trained`), `query`, `source` (`catalog`, `trained`, `all`), `limit` (default 20, max 40), `cursor` | Rows {model_id, name, description, lanes, accepts_mask, max_references, max_output, trained, base_model} | None | Free |
| `model_schema` | same | `model_id` | `parameters` [{name, type, default, enum, min, max, required}], `file_inputs` [{name, kind, role: `image`, `reference` or `mask`}], `mask_polarity` {value: `alpha`, `white` or `black`, source: `schema`, `table` or `default`}, `price_affecting` [names], `variable_charge` {value, reason} | None | Free |
| `recommend_models` | new | `lane`, `prompt`, `limit` (default 5) | Rows as `list_models` plus `reason`; `source` is `scenario` or `plugin defaults` | None | Free |
| `estimate_cost` | same | `model_id`, `lane` (`image`, `edit`, `expand`, `upscale`, `remove_background`), `parameters` (file inputs as asset ids), `capture_id` (binds the placement target), `takes` | `quote_id`, `cu_cost_exact` (decimal string), `cu_cost` (number), `variable` {value, reason}, `cost_details`, `expires_at`, `needs_upload` (true when the dry run needed file inputs that are missing) | One dry run on Scenario; no job | Free |
| `job_status` | same | `local_id` or `job_id` | `local_id`, `job_id`, `status`, `remote_status`, `progress`, `cu_quoted`, `cu_charged`, `no_refund`, `approval` {state: `pending`, `approved`, `declined`}, `outputs` [{asset_id, take, file_state}], `application` {state: `none`, `pending_approval`, `committed`, `dismissed`, `rolled_back`, history_state, layer_ids}, `error`, `revision`, `actions` | None | Free |
| `wait_for_job` | same | `local_id` or `job_id`, `timeout` (0 to 170, default 45) | `job_status` fields, plus `still_running` when the wait expired | Waits without blocking Photoshop | Free |
| `list_local_jobs` | same | `filter` (`all`, `active`, `needs_attention`, `agents`), `limit` (default 20), `cursor` | Rows {local_id, job_id, status, lane, model_name, prompt_slug, cu_quoted, cu_charged, origin, created_at, revision} | None | Free |
| `list_generations` | same | `created_after`, `limit` (default 20), `cursor` | The project's jobs on Scenario: {job_id, model_id, status, created_at, asset_ids} | None | Free |
| `list_assets` | same | `collection_id`, `kind`, `limit` (default 20), `cursor` | {asset_id, name, kind, width, height, created_at} | None | Free |
| `search_assets` | same | `query`, `limit` (default 20) | As `list_assets` | None | Free |
| `list_collections` | same | `limit`, `cursor` | {collection_id, name, asset_count} | None | Free |
| `inspect_result_previews` | same | `local_id` or `job_id`, `takes` (default all), `max_px` (default 512, max 1024) | One JPEG per take, plus checks against the capture: `aspect_ok`, `edited`, `seam_bias`, `seam_residual`, `seam_ok`, `polarity_suspect` | Downloads results if needed; no document change | Free. Images go to the agent's provider |

### 4.3 Inputs

| Tool | Blender | Inputs | Output | Side effects | Cost |
|---|---|---|---|---|---|
| `capture_reference` | similar | `document_id`, `source` (`selection`, `layer`, `all_visible`, `document`), `layer_id`, `sample` (`all_visible` or `layer`, for a selection), `purpose` (`edit`, `reference`, `expand`, `upscale`, `remove_background`), `margin` (default: half the long side, at least 64 px; 0 allowed), `expand` {left, top, right, bottom, overlap default 32} for `purpose: "expand"`, `max_px` | `capture_id`, `box`, `scale`, `size`, `parts` (`context`, `mask`, `model_mask` as relevant), `mask_coverage`, `feathered`, `notes` | A short modal read; files in the plugin temp folder; records the placement target. No document change, nothing sent | Free |
| `upload_reference` | same | One of: `capture_id` with `parts` (default: the parts the purpose needs), or `path` (a file the person chose in the panel this session, or a result the plugin saved) | `reference_ids` per part, `state` (`staging`, `uploading`, `imported`, `failed`), `asset_ids` once imported | Sends the pixels to Scenario. The same capture part is uploaded once; repeats return the same reference | Uploads. Spends no Creative Units |
| `reference_upload_status` | same | `reference_id` | `state`, `asset_id`, `error` | None | Free |

Any other `path` returns `UploadRefused` before anything is read.

### 4.4 Spending

| Tool | Blender | Inputs | Output | Side effects | Cost |
|---|---|---|---|---|---|
| `generate` | same | `lane`, `model_id`, `quote_id`, `approved_cost` (exact string), `parameters` (must match the quote), `idempotency_key` (8 to 128 characters; default the `quote_id`) | `local_id`, `status` (`awaiting_approval`, `queued`, `Not sent`, `Unknown`), `job_id` when known, `replayed`, `note` | Ledger write; approval card when required; then the paid request to Scenario | Spends, after the checks in section 3 |

### 4.5 Recovery

| Tool | Blender | Inputs | Output | Side effects | Cost |
|---|---|---|---|---|---|
| `recover_local_job` | same | `local_id`, `expected_revision`, `action` (`refresh`, `resume`, `stop_download`, `recover_download`) | `status`, `revision`, `actions`, `error` | Reads job state; resumes or stops downloads. An Unknown job returns `UnknownNeedsPerson` | Free |
| `recover_cloud_job` | same | `job_id`, `model_id` | `local_id`, `status`, `revision` | Adds a finished cloud job to the ledger and downloads its results; never submits a generation; no document change | Free |
| `cancel_job` | similar | `local_id` or `job_id` | `requested`, `remote_status` after the request | Asks Scenario to cancel a running job where Scenario allows it; reports the actual outcome | Free. Whether a cancelled job is charged is Scenario's rule and shows in `cu_charged` |
| `cancel_prepared_job` | same | `local_id` of a job in `awaiting_approval` | `status: "Not sent"` | Withdraws the request; nothing was sent to Scenario | Free |

### 4.6 Document changes

Need "Agents may modify the document", except `prepare_result_application`, which changes nothing.

| Tool | Blender | Inputs | Output | Side effects | Cost |
|---|---|---|---|---|---|
| `prepare_result_application` | same | One of `local_id` (with `expected_revision`) or `library_asset_id`; `purpose` (`new_layer`, `edit_selection`, `expand`, `cutout_mask`, `new_document`); `takes` (default all) or `asset_id`; `target` {`document_id`, `insert` (`auto`, `top`, `above_layer`), `layer_id`, `fit` (`exact`, `contain`, `cover`), `box`}; `feather` (0 to 8, default 2) | `application_id` (single use, 10 minutes), `review` (text naming the document, position, layer names and History state), `target` resolved, `checks` (for `edit_selection` and `expand`), `will_create`, `warnings`, `requires_approval` | None. Refuses `edit_selection` when the canvas changed since the capture (`DocumentChanged`) | Free |
| `apply_result_application` | same | `application_id` | Switch on: `outcome` (`committed`, `rolled_back`, `not_started`, `unknown`), `layer_ids`, `group_id`, `names`, `history_state`, `outside_check` {max_diff, untouched}. Switch off: `outcome: "pending_approval"`; the person's decision appears later in `job_status.application` | One History state "Scenario agent: <action>"; a toast with **Undo** | Free |
| `select_layers` | similar (`select_objects`) | `layer_ids`, `mode` (`replace`, `add`), `document_id` | `active_layer_ids` | Changes the active layers; no pixel change | Free |
| `set_selection` | new | One of `rect` [x, y, w, h], `ellipse` [x, y, w, h], `layer_transparency` (layer_id), `subject` {sample_all_layers}, `none`; `feather`, `mode` (`replace`, `add`, `subtract`, `intersect`), `document_id` | `selection` {bounds} or null | One History state "Scenario agent: Select" | Free |
| `remove_scenario_layers` | new | `layer_ids`, `document_id` | `removed` | Deletes layers that carry Scenario metadata, in one History state. Other layers return `NotScenarioLayer` | Free |

`purpose` values and what they do:

| Purpose | Lands as | Notes |
|---|---|---|
| `new_layer` | Embedded smart object, or a group of takes, fitted to `target.box`, the capture box, or the canvas | Library assets use this purpose |
| `edit_selection` | Smart object over the capture box with a layer mask from the captured selection | Needs a job made from a `capture_id` |
| `expand` | Canvas resized and a masked smart object, in one History state | Needs an `expand` capture |
| `cutout_mask` | The result's alpha as a mask on `target.layer_id` (the source layer by default) | Refuses a layer that already has a mask unless `target.insert` asks for a new layer |
| `new_document` | A new document opened from the result | The source document does not change |

### 4.7 Scripts

Needs both switches: "Agents may modify the document" and "Agents may run Photoshop scripts".

| Tool | Blender | Inputs | Output | Side effects | Cost |
|---|---|---|---|---|---|
| `execute_batchplay` | similar (`execute_python`) | `descriptors` (array of batchPlay descriptors, at most 200), `label` (History name), `document_id` | `outcome`, `history_state`, `results` (capped at 64 KB in total) | Runs inside one modal scope and one History state. Refuses save, close, quit, export and print events, preference changes, and any file path outside the plugin temp folder and the Output Folder (`ScriptRefused`). An error in any descriptor rolls back the whole call | Free |

The refusal list is a guard against mistakes, not a security boundary: a script can still change anything in the open document. That is why the switch is separate and off by default.

## 5. Tools planned for v1.1

| Tool | Blender | Purpose |
|---|---|---|
| `list_workflows`, `workflow_schema` | same | The team's workflows and their inputs |
| `estimate_workflow`, `run_workflow` | same | Same quote and idempotency contract as `generate` |
| `workflow_job_steps`, `decide_workflow_step` | same | Approval nodes, decided only with the person's explicit choice |
| `estimate_prompt`, `approve_prompt`, `read_prompt_result` | same | Prompt helper, priced separately |
| `export_image` | new | Export a layer, the composite or a region as a new file in the Output Folder |
| `photoshop_api_help` | similar (`blender_api_help`) | Descriptor help before `execute_batchplay` |

## 6. Platform equivalents

| Local tool | Hosted Scenario MCP |
|---|---|
| `list_models` | `models_list`, `search` |
| `model_schema` | `model_schema_get` |
| `recommend_models` | `recommend` |
| `estimate_cost` | `model_run` with dry run |
| `generate` | `model_run` |
| `job_status` | `job_get` |
| `wait_for_job` | `jobs_wait` |
| `list_generations` | `jobs_list` |
| `cancel_job` | `job_cancel` |
| `upload_reference` | `upload_asset`, then `upload_asset_complete` |
| `list_assets`, `list_collections` | catalog tools for assets and collections |
| Document, capture and apply tools | none: they need the open document |

## 7. Errors

| Type | When |
|---|---|
| `NotConnected` | No plugin connected: Photoshop is closed or the plugin is not installed |
| `PairingMismatch` | The helper's token is not the plugin's current token |
| `PortInUse` | Another program holds port 9878 |
| `VersionMismatch` | Helper and plugin speak different protocol versions, or the tool is unknown to the plugin |
| `NotSignedIn` | No Scenario key saved in the plugin |
| `Unauthorized`, `Forbidden` | Scenario returned 401 or 403 |
| `RateLimited` | Scenario returned 429; the message gives the wait |
| `Offline` | No connection to Scenario |
| `InvalidParameter` | A parameter is not in the model's schema, or has the wrong type or range |
| `DryRunCreatedJob` | A price check returned a job id; price checks are stopped for the session |
| `QuoteExpired`, `QuoteMismatch`, `CostMismatch`, `QuoteUsed` | Quote checks in section 3 |
| `IdempotencyConflict` | Same key, different request |
| `UnknownBlocks` | An Unknown job with the same request exists |
| `UnknownNeedsPerson` | Only the person can resolve an Unknown job |
| `NoSpend` | `SCENARIO_NO_SPEND=1` or No-spend mode |
| `SpendDeclined` | The person declined the approval card (reported in `job_status`) |
| `InsufficientCredits` | Scenario reports too few Creative Units |
| `Blocked` | Scenario's content policy blocked the request |
| `UploadRefused` | The file was not chosen by the person or made by the plugin |
| `UnsupportedDocument` | Color mode or bit depth the lane cannot read |
| `DocumentChanged` | The canvas changed since the capture |
| `DocumentClosed` | The target document is closed |
| `ApplicationExpired`, `ApplicationUsed` | `application_id` older than 10 minutes, or already applied |
| `SwitchOff` | A tool that needs a switch was called while it is off (except `apply_result_application`, which returns a proposal) |
| `ScriptRefused` | `execute_batchplay` hit a refused event or path |
| `NotScenarioLayer` | The layer carries no Scenario metadata |
| `PhotoshopBusy` | Another plugin or a dialog holds Photoshop's modal state for more than 10 s |
| `Timeout` | The tool call exceeded 120 s; the work continues and `job_status` reports it |

## 8. Example: an agent edits a selection

1. `scenario_status`: connected, signed in, switch states.
2. `document_summary`: the selection and the layer under it.
3. `list_models(lane: "edit")`, then `model_schema(model_id)`.
4. `capture_reference(source: "selection", sample: "all_visible", purpose: "edit")` returns `capture_id`.
5. `upload_reference(capture_id)`, then `reference_upload_status` until each part is `imported`.
6. `estimate_cost(model_id, lane: "edit", parameters: {prompt, image: <asset_id>, mask: <asset_id>}, capture_id, takes: 2)` returns `quote_id` and `cu_cost_exact`.
7. The agent shows the price to the person.
8. `generate(lane: "edit", model_id, quote_id, approved_cost: <cu_cost_exact>, parameters, idempotency_key)` returns `local_id` and `awaiting_approval` (default setting); the person clicks **Approve** in the panel.
9. `wait_for_job(local_id)` until `results saved`. On a timeout, call `wait_for_job` again. If `generate` itself timed out, call it again with the same `idempotency_key`.
10. `inspect_result_previews(local_id)`: pick the take with `seam_ok` and `edited` true.
11. `prepare_result_application(local_id, expected_revision, purpose: "edit_selection", asset_id)`: review text and checks.
12. `apply_result_application(application_id)`: `committed` with `outside_check.untouched` true, or `pending_approval` when the switch is off.

## 9. What agents cannot do

- Save, close or export documents (export comes in v1.1, to new files in the Output Folder only).
- Resolve Unknown jobs, approve their own spending, or change settings and switches.
- Read the Scenario key, the secret or the pairing token.
- Upload a file the person did not choose and the plugin did not make.
- Run JavaScript. Scripts are batchPlay descriptors only.
