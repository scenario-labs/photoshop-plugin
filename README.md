# Scenario for Photoshop

A UXP plugin that brings [Scenario](https://www.scenario.com) generation into Adobe Photoshop, and a local MCP server, `scenario-photoshop`, that lets agent clients (Claude Code, Codex, Cursor, Claude Desktop) work with it.

**Status: early build (milestone M2). It signs in to Scenario, browses the model catalog and shows exact prices, but cannot generate anything yet.** Its Scenario calls are reads (the key check, the model list and model schemas), free price checks (dry runs, which create no job and spend nothing), and, for models whose price needs an image input, one blank stand-in image uploaded to the project and hidden from the Library. The Generate button stays disabled.

Each statement below carries how it was checked: *verified live* (in Photoshop), *tested automated* (Node test suite, no Photoshop), or *not tested*.

## What this build does

- **Plugin** (`plugin/`): a panel with the five lane tabs (Image, Edit, Enhance and Trained work as below; Library is a placeholder), the agent link status and the pairing token (Show, Copy, Reset). Its startup code runs when Photoshop launches, even with the panel closed, and dials the helper on `ws://localhost:9890`; it calls Scenario only once the panel is shown or an agent asks. *Tested automated* (the built bundle runs in a fake UXP host). *Verified live* on Photoshop 27.11: the development build loads at launch and links to the helper. The panel itself was not looked at.
- **Sign-in**: paste a Project API key and its secret (pasting `key:secret` or the two on two lines fills both fields), then **Save and test**. The plugin makes two free reads on Scenario's API, an authenticated read and the project listing, and saves the key in UXP secure storage only when both pass. The panel header then shows the project name, or `Scenario project ....` and the key's last 4 characters when no name is readable. A key for another project can be added and switched from the header; Settings has **Test connection**, **Sign out** (the current project's key) and **Copy diagnostics**. A refused key, a Reader key, a team (Organization) key and no connection each get their own message. *Tested automated* against a mock of Scenario's API that answers as the live API did, including a test that the key, the secret and the listing's member emails and key ids never reach logs, files, the helper, `scenario_status`, the panel or the clipboard. *Not tested* in Photoshop: the sign-in itself, reading the masked secret field on macOS, paste handling and secure storage removal.
- **Model catalog**: the model list (the project's own models, then Scenario's public catalog) is read when the panel is first shown, cached in the plugin's data folder and refreshed in the background once a day. Models are sorted into the Image, Edit, Enhance (Upscale, Expand, Remove BG) and Trained tabs from their tags and capabilities; deprecated models are hidden. **Change model** opens the picker: search, chips (All, Favorites, Recommended, and per tab References, Mask input, the Enhance tools, This project or Public), a tag menu, and favorites kept in the data folder. Recommended lists the lane defaults, then models Scenario features. Trained models (LoRAs and compositions) can be browsed, with their kind and base model, but not used yet. *Tested automated*. *Not tested* in Photoshop.
- **Lanes and prices**: each lane opens on its default model (Image and Edit: GPT Image 2.5 Flare at low quality; Upscale: Topaz Image Upscale at 2x; Remove BG: 851 Labs) with a prompt, a size, takes and, for Upscale, the factor. The form is checked against the model's schema before any price check, then priced 400 ms after the last change, and the price shows on the button: `Generate (2 CU)`. Prices can be exact, a range or a `from` price. The button stays disabled with "Generation comes in the next build."; Expand and Trained say why they show no price yet. *Tested automated* in a DOM built from the panel's HTML, against a mock of Scenario's API that answers with responses recorded from the live API: Image default 2 CU, Edit default with a mask 3 CU, Remove BG 1 CU, Upscale 10 to 60 CU by document size. *Not tested* in Photoshop.
- **Price checks**: the dry-run flag is written once, in one constant, and the plugin's API client refuses any other request to Scenario's generation endpoint, so this build cannot start a paid job. Tests assert the exact query string of every price check. Image inputs a lane fills from the document later are priced without document pixels: by count where the price follows the number of files, or with a blank image of the right size where it follows their size. A price check that comes back with a job stops all price checks and says so in the panel. Each price is a quote that lasts 120 s, is used once and is bound to the exact request. *Tested automated*.
- **Helper** (`helper/`, npm package `@scenario-labs/photoshop-mcp`, command `scenario-photoshop`): an MCP server over stdio with four tools. `scenario_status` reports whether the plugin is linked, the Photoshop and plugin versions, whether the plugin is signed in and the project name (never the key), the agent switches and spending settings, and the open documents (ids and titles). `list_models` and `model_schema` read the catalog; `estimate_cost` validates a request and returns a quote from a free price check. *Tested automated*, through a real helper process. *Verified live* on Photoshop 27.11: this build loads, links and answers `scenario_status`. The catalog tools were not run live: the panel was not signed in.
- **Several clients at once**: the first helper owns port 9890 on `127.0.0.1` and `::1`; later helpers relay through it; when the owner exits, another takes over and the plugin reconnects. Each client gets a session (a random 128-bit id, new each time the plugin links) and keeps the name it gave at its first `initialize`; the panel lists clients by that name, and the plugin refuses calls from a session that is not on its list. *Tested automated* (macOS). *Not tested* on Windows.
- **One Photoshop at a time**: if a second Photoshop with the plugin reaches the helper, it is refused and its panel says "Agents are connected to another Photoshop."; the first keeps the link. *Tested automated*.
- **Pairing**: the plugin makes a 256-bit token and keeps it in UXP secure storage. The token never travels over the socket: both sides prove they hold it with HMAC-SHA-256 over fresh nonces, then every message carries a MAC and a counter. The helper also checks the `Host`, `Origin` and `User-Agent` headers before any protocol byte. *Tested automated*, including wrong tokens, replayed and tampered messages, programs squatting on the port, and browser-like connections.

## Connect an agent client (development)

The setup command reads the pairing token from the `SCENARIO_PHOTOSHOP_TOKEN` environment variable (or stdin with `--token-stdin`), never from a command argument. It writes the token to a file only your account can read (`~/.config/scenario-photoshop/token`, or `%APPDATA%\scenario-photoshop\token`), then registers the server with the client without the token: through `claude mcp add` or `codex mcp add`, or in the Cursor or Claude Desktop config file (with a backup of the old file).

```sh
# Token copied from the Scenario panel; nothing is written to your shell's argument list.
pbpaste | node helper/bin/scenario-photoshop.js setup claude-code --local --token-stdin
```

*Tested automated* with temporary home folders and a stand-in for the client CLIs. *Not tested* against the real `claude` and `codex` CLIs or on Windows. The npm package is not published yet.

## Build and test

Node 20 or later.

```sh
npm ci
npm test          # unit and integration tests (Node's built-in test runner)
npm run lint      # syntax, typography and public-content checks
npm run package   # build/scenario-photoshop-0.2.0.ccx
```

Details for contributors and coding agents: [AGENTS.md](AGENTS.md). Design: [docs/spec/SPEC.md](docs/spec/SPEC.md) and the tool reference [docs/spec/MCP.md](docs/spec/MCP.md).

## Privacy

This build sends your API key and secret only to Scenario's API (`https://api.cloud.scenario.com`), as HTTP Basic authentication over HTTPS; it never follows a redirect with them. Of the project listing it keeps the project name, the project id and the key's own role; the listing's member emails and other keys are dropped at once. Price checks send the prompt, the model and its settings to Scenario's API, and never pixels from your documents: where a price needs an image, the plugin uploads a blank image (`photoshop-standin-<width>x<height>.png`) once per project and size, hidden from the Library. The model list, the stand-ins' asset ids and your favorites are kept in the plugin's data folder. Links you click open in your browser after Photoshop asks. Otherwise the only network use is the loopback link between the plugin and the helper. See [PRIVACY.md](PRIVACY.md) for the full design.

## License

MIT, see [LICENSE](LICENSE). Third-party code: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Adobe and Photoshop are trademarks of Adobe. This project is not affiliated with or endorsed by Adobe.
