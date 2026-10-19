# Privacy

This page describes what the Scenario plugin for Adobe Photoshop and its local Scenario MCP server, `scenario-photoshop`, send and store. It applies to the first public release, 0.1.0. The plugin is a client of your own Scenario account: what Scenario does with what it receives is governed by Scenario's [Terms](https://www.scenario.com) and [Privacy Policy](https://www.scenario.com/privacy-policy), which this page does not replace.

Status: written against the v1 specification ([docs/spec/SPEC.md](docs/spec/SPEC.md)). It is checked against the released build before each release. It sits at the root of the repository so the panel's About link points to one short path.

## What leaves your machine, and when

| What | When | Sent to |
|---|---|---|
| Your API key and secret | With every request to Scenario's API, as HTTP Basic authentication over HTTPS. Never with downloads or uploads to other hosts | Scenario's API |
| Prompt, model choice and settings | While you edit a form, for price checks (shortly after you stop typing), and when you click Generate | Scenario's API |
| Pixels from your document | When you click Generate, or when an agent you allowed uploads a capture (below). What is sent depends on the source: the selected area plus a margin of surrounding pixels, one layer, or the visible composite. Edits also send a mask made from your selection. References are captured when you add them and sent when you click Generate | Scenario's API for small images (under 4 MB as sent); Scenario's upload storage for larger ones |
| Files you pick | When you click Generate with them as references. PNG and JPEG only, with their EXIF, XMP, IPTC and text metadata (such as GPS position, camera serial or author) removed first | As above |
| Catalog, Library and job lookups | When you open the model picker, the Library lane or Jobs > On Scenario, and while jobs run | Scenario's API |
| Download requests | When a job finishes, and for thumbnails in lists | Scenario's download hosts |
| Update check | At most once a day, unless turned off in Settings > Updates | GitHub API |
| Links you click | Only when you click; Photoshop asks before opening your browser | The linked site |

Price checks never upload pixels. If the exact price after the upload differs from the one shown, nothing is spent and the plugin asks you again, but the upload has already happened. Uploaded images are stored by Scenario as assets of your project, like uploads made in the Scenario web app, and the members of that project can see them.

Before sending, the plugin converts captured pixels to sRGB at 8 bits per channel. Your document's color profile is not sent. Uploads are named `photoshop-<purpose>-<date>-<short id>`.

**Never sent to Scenario by the plugin:**
- Your PSD file, or any layer or area that was not chosen as a source.
- Document names, layer names or file paths.
- Usage analytics or telemetry. This release sends none. If a later version adds them, they will be off until you turn them on.

**Never sent to anyone but Scenario's API:** your key and secret. The helper, connected agents and the plugin's logs never receive them.

**When you connect an agent**, that changes. A connected agent can read the names, layers, text and previews of every open document (only the active one if you turn on **Agents read the active document only**), and what it reads goes to the agent's model provider. After you allow it for a document, once per document in each agent session, it can also upload captures from that document to your Scenario project. See "The local Scenario MCP server" below.

## Where it goes

| Destination | Purpose |
|---|---|
| `https://api.cloud.scenario.com` | Scenario's API: sign-in check, catalog, prices, uploads under 4 MB, generations, jobs, Library |
| Scenario's upload storage (the host is listed in the plugin manifest) | Uploads of 4 MB and more, through upload links that Scenario signs |
| Scenario's download hosts (listed in the plugin manifest, which never allows all hosts) | Downloads of results and thumbnails, through signed links that expire |
| `https://api.github.com` | Update check. GitHub receives an ordinary HTTPS request, which includes your IP address |
| Your browser | Pages you open from the plugin, such as the API key page on app.scenario.com |
| Agent clients you connect | Whatever they read through the local server (below) |

The UXP plugin can reach only the hosts declared in its manifest. The local server opens only a socket on your computer's loopback interface; when your agent client starts it with `npx`, npx contacts the npm registry to fetch it. Photoshop's own handling of your data is covered by Adobe's terms, not by this page.

**What Scenario does with it.** Scenario runs your request with the provider of the model you chose. Scenario lists its sub-processors and model providers at [trust.scenario.com](https://trust.scenario.com). Scenario's Privacy Policy (last updated July 16, 2026) says Scenario may use your content to operate, secure and improve its services and AI models. Enterprise customers with a signed agreement get the commitments set out in that agreement instead. Read the policy for the details that apply to your plan.

## What is stored on your machine

| Item | Where | How to remove |
|---|---|---|
| API keys and secrets | Photoshop's secure storage for this plugin, one entry per project, encrypted under your operating system account | Settings > Account > **Sign out**. This removes the key from this computer only; delete the key on app.scenario.com to revoke it |
| Pairing token | The same secure storage; the helper's token file, readable by your account only (`~/.config/scenario-photoshop/token` on macOS, `%APPDATA%\scenario-photoshop\token` on Windows); the config of clients that keep it themselves (Cursor, Claude Desktop, a manual entry); your shell history if you pasted a setup command; your clipboard for up to 60 s after you copy it | Settings > Agents > **Reset pairing token**, then delete the token file and remove the `scenario-photoshop` entry from each client |
| Job records: prompts, settings, model and job ids, asset ids, prices quoted and charged, who started the job (you, or the name an agent client reported), target document name and position | The plugin data folder. On macOS: `~/Library/Application Support/Adobe/UXP/PluginsStorage/PHSP/<version>/External/<plugin id>/PluginData/`; the equivalent folder on Windows | Delete the folder. Uninstalling the plugin may not remove it |
| Captures sent to Scenario | The plugin's temporary folder | Deleted automatically 7 days after the job finishes |
| Downloaded results | The Output Folder: inside the plugin data folder by default, or the folder you chose | Delete the files; placed results are embedded in your documents and do not depend on them |
| Copy of the job records | `<Output Folder>/.scenario/jobs/`, only when you chose an Output Folder. It holds prompts and document names, and travels with the folder if the folder is synced or shared | Delete the folder |
| Logs | The plugin data folder, `logs/`: kept 7 days, at most 5 MB. Keys, secrets, tokens and request and response bodies are never written | Delete the folder |
| Model list cache, settings, agent activity log | The plugin data folder | Delete the folder |
| Provenance in your documents | Metadata on each result layer: model, prompt, settings, asset and job ids, prices, date, and who started it. Layer names include the first words of the prompt | Delete the layer. For future results, Settings > Results > **Leave prompts out of documents** removes the prompt, every free-text setting and the prompt words in layer names; **Leave prices out of documents** removes the prices |

Signed download and upload links are kept in memory only, never on disk.

Layer metadata travels with the PSD when you share it. It never contains your key, secret, pairing token, team or project ids, or file paths. The Scenario skills for Photoshop write the same metadata, so the panel can read layers placed either way.

**Copy diagnostics** (Settings > Diagnostics) shows its text before copying it. It holds versions, your operating system, switch states, job counts and recent error types, and no prompts, document or project names, ids, paths, keys or tokens.

## Deleting your data

- **On this computer:** sign out, reset the pairing token, and delete the plugin data folder and any Output Folder you chose (paths above).
- **On Scenario:** delete uploaded images and results from your project in the Scenario web app. For anything else Scenario holds about you, including deletion of your account data, write to privacy@scenario.com as Scenario's Privacy Policy describes.
- **API keys:** delete them on app.scenario.com. Signing out of the plugin does not revoke a key.
- **Agent providers:** what an agent read is held under your agreement with that provider.

## The local Scenario MCP server

- `scenario-photoshop` is a small program that your agent client (Claude Code, Codex, Cursor, Claude Desktop) starts. The first one listens on port 9890 of your computer's loopback interface (`127.0.0.1` and `::1`), which other computers cannot reach. The plugin connects to it. It never receives your Scenario key or secret.
- **Pairing.** The plugin and each helper prove to each other that they hold the pairing token, without sending it, and every later message carries a code that only holders of the token can produce. Web pages are refused by the origin checks. A program that does not hold the token cannot act as the plugin or as the helper; it can only take port 9890 first and block agents, which the panel reports. Messages are authenticated, not encrypted. Programs running under your own account can read the token file and client config files, so the token does not protect against them. Setup commands pass the token in an environment variable, which other accounts on the computer cannot list.
- **With all agent switches off**, a connected agent can:
  - read document information: size, mode, layers and layer names, text layers, the selection, and Scenario metadata;
  - get previews of your documents, which contain their pixels;
  - list models, get prices, and read jobs and Library items;
  - capture a selection, layer or composite and, after you allow it in the panel for that document in that session, upload it to Scenario;
  - request generations, which spend your CU. By default the plugin asks you in the panel before each one. You can instead give one connected client an allowance with a limit per call and a total; prices with no upper bound still ask you; it ends when that client disconnects, when Photoshop quits or when you end it;
  - cancel jobs it started, and add a finished job of your project to the plugin's list;
  - run Select Subject, which follows Photoshop's Image Processing preference: if you set it to Cloud, Photoshop sends the image to Adobe for processing.
- `SCENARIO_NO_SPEND=1` in the server's environment, or **No-spend mode** in the panel, blocks agent spending and uploads.
- Everything an agent reads goes to that agent's model provider, under your agreement with that provider.
- **Agents may modify the document**: agents can place results and change selections and layers, one undoable History step each. With it off, their changes arrive as proposals you apply or dismiss.
- **Agents may run Photoshop commands** (off by default, turns off when Photoshop quits): agents can run batchPlay commands on open documents: layers, selections, masks, adjustments, filters and transforms, one undoable History step per call. Commands outside an allow-list are refused, including any that save, close, export or print, create documents, play Actions, run scripts, use Adobe's generative features or change Photoshop's settings. File paths are removed from what these commands return.
- Agents can never read your key, secret or pairing token, save, close or export documents, resolve uncertain jobs, approve their own spending or uploads, cancel jobs they did not start, or upload files you did not choose and the plugin did not make.
- Settings > Agents > **Activity log** lists every agent preview read, upload, spend and document change.

## Terms and contact

- Scenario's [Privacy Policy](https://www.scenario.com/privacy-policy) and Terms: linked from [scenario.com](https://www.scenario.com).
- Scenario Trust Portal: [trust.scenario.com](https://trust.scenario.com).
- Scenario documentation: [docs.scenario.com](https://docs.scenario.com).
- Privacy requests to Scenario: privacy@scenario.com.
- Photoshop is covered by Adobe's terms.
- The plugin is open source under the MIT license; its network calls can be checked in this repository. Report security issues privately as described in `SECURITY.md` (shipped with the first release), and never paste keys or secrets in issues.
