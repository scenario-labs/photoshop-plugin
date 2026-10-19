# Privacy

This page describes what the Scenario plugin for Adobe Photoshop and its local Scenario MCP server, `scenario-photoshop`, send and store. It applies to version 1.0. The plugin is a client of your own Scenario account: what Scenario does with what it receives is governed by Scenario's Terms and Privacy Policy, which this page does not replace.

Status: written against the v1 specification ([docs/spec/SPEC.md](docs/spec/SPEC.md)). It is checked against the released build before each release.

## What leaves your machine, and when

| What | When | Sent to |
|---|---|---|
| Your API key and secret | With every request to Scenario, as HTTP Basic authentication over HTTPS | Scenario API |
| Prompt, model choice and settings | While you edit a form, for price checks (shortly after you stop typing), and when you click Generate | Scenario API |
| Pixels from your document | Only when you click Generate or add a reference that needs an upload, or when an agent you connected uploads a capture. What is sent depends on the source you chose: the selected area plus a margin of surrounding pixels, one layer, or the visible composite. Edits also send a mask made from your selection | Scenario API |
| Files you pick | When you add them as references | Scenario API |
| Catalog, Library and job lookups | When you open the model picker, the Library lane or Jobs > On Scenario, and while jobs run | Scenario API |
| Download requests | When a job finishes, and for thumbnails in lists | Scenario's content delivery hosts |
| Update check | At most once a day, unless turned off in Settings > Updates | GitHub API |
| Links you click | Only when you click; Photoshop asks before opening your browser | The linked site |

Price checks never upload pixels. Pixels are sent when you click Generate. If the exact price after the upload differs from the one shown, nothing is spent and the plugin asks you again, but the upload has already happened. Uploaded images are stored by Scenario as assets of your project, like uploads made in the Scenario web app.

Before sending, the plugin converts captured pixels to sRGB at 8 bits per channel. Your document's color profile is not sent.

**Never sent by the plugin:**
- Your PSD file, or any layer or area you did not choose as a source.
- Document names, layer names, file paths or other open documents.
- Your key or secret to anyone other than Scenario's API. The helper, connected agents and the plugin's logs never receive them.
- Usage analytics or telemetry. Version 1.0 sends none. If a later version adds them, they will be off until you turn them on.

What a connected agent reads through the local server goes to that agent's model provider, not through the plugin. See "The local Scenario MCP server" below.

## Where it goes

| Destination | Purpose |
|---|---|
| `https://api.cloud.scenario.com` | Scenario's API: sign-in check, catalog, prices, uploads, generations, jobs, Library |
| Scenario's content delivery hosts (listed in the plugin manifest) | Downloads of results and thumbnails, through signed links that expire |
| `https://api.github.com` | Update check. GitHub receives an ordinary HTTPS request, which includes your IP address |
| Your browser | Pages you open from the plugin, such as the API key page on app.scenario.com |
| Agent clients you connect | Whatever they read through the local server (below) |

The plugin's network permissions are declared in its manifest. It cannot reach other hosts. Photoshop's own handling of your data is covered by Adobe's terms, not by this page.

## What is stored on your machine

| Item | Where | How to remove |
|---|---|---|
| API key and secret | Photoshop's secure storage for this plugin, encrypted under your operating system account | Settings > Account > **Sign out** |
| Pairing token | The same secure storage, and the config files of the agent clients you set up | Settings > Agents > **Reset pairing token**, then remove the `scenario-photoshop` entry from each client |
| Job records: prompts, settings, model and job ids, asset ids, prices, who started the job (you, or the name an agent client reported), target document name and position | The plugin data folder. On macOS: `~/Library/Application Support/Adobe/UXP/PluginsStorage/PHSP/<version>/External/<plugin id>/PluginData/`; the equivalent folder on Windows | Uninstall the plugin, or delete the folder |
| Captures sent to Scenario | The plugin's temporary folder | Deleted automatically 7 days after the job finishes |
| Downloaded results | The Output Folder: inside the plugin data folder by default, or the folder you chose | Delete the files; placed results are embedded in your documents and do not depend on them |
| Copy of the job records | `<Output Folder>/.scenario/jobs/`, only when you chose an Output Folder | Delete the folder |
| Model list cache, settings, agent activity log | The plugin data folder | Uninstall the plugin, or delete the folder |
| Provenance in your documents | Metadata on each result layer: model, prompt, settings, asset and job ids, price, date, and who started it | Delete the layer, or turn on Settings > Results > **Leave prompts out of layer metadata** for future results |

Layer metadata travels with the PSD when you share it. It never contains your key, secret, pairing token, team or project ids, or file paths.

## The local Scenario MCP server

- `scenario-photoshop` is a small program that your agent client (Claude Code, Codex, Cursor, Claude Desktop) starts. It listens on `127.0.0.1:9878`, which other computers cannot reach. The plugin connects to it; the server never receives your Scenario key or secret.
- Only helpers configured with the pairing token are accepted. Programs running under your own account can read client config files, so the token does not protect against them.
- With both agent switches off, a connected agent can:
  - read document information: size, mode, layers and layer names, the selection, and Scenario metadata;
  - get previews of your document, which contain its pixels;
  - list models, get prices, and read jobs and Library items;
  - capture a selection, layer or composite and upload it to Scenario;
  - request generations, which spend your Creative Units. By default the plugin asks you in the panel before each one. Setting `SCENARIO_NO_SPEND=1` in the server's environment blocks agent spending.
- Everything an agent reads goes to that agent's model provider, under your agreement with that provider.
- With **Agents may modify the document** on, agents can place results and change selections and layers, one undoable History step each. With it off, their changes arrive as proposals you apply or dismiss.
- With **Agents may run Photoshop scripts** on, agents can run batchPlay commands that change anything in the open document. The plugin refuses save, close, quit and export commands, but this is a guard against mistakes, not a security boundary.
- Agents can never read your key, secret or pairing token, save or close documents, resolve uncertain jobs, or upload files you did not choose and the plugin did not make.
- Settings > Agents > **Activity log** lists every agent action that spent, uploaded or changed a document.

## Terms

- Scenario's Terms and Privacy Policy: linked from [scenario.com](https://www.scenario.com).
- Scenario Trust Portal: [trust.scenario.com](https://trust.scenario.com).
- Scenario documentation: [docs.scenario.com](https://docs.scenario.com).
- Photoshop is covered by Adobe's terms.
- The plugin is open source under the MIT license; its network calls can be checked in this repository. Report security issues as described in `SECURITY.md`, and never paste keys or secrets in issues.
