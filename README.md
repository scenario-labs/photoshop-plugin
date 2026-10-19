# Scenario for Photoshop

A UXP plugin that brings [Scenario](https://www.scenario.com) generation into Adobe Photoshop, and a local MCP server, `scenario-photoshop`, that lets agent clients (Claude Code, Codex, Cursor, Claude Desktop) work with it.

**Status: early build (milestone M2, first part). It signs in to Scenario but cannot generate anything yet.** Its only Scenario calls are the two free reads that check a key. The rest is the plumbing every later feature uses: the plugin's panel shell and startup code, the helper process, and the paired link between them.

Each statement below carries how it was checked: *verified live* (in Photoshop), *tested automated* (Node test suite, no Photoshop), or *not tested*.

## What this build does

- **Plugin** (`plugin/`): a panel with the five lane tabs as placeholders, the agent link status and the pairing token (Show, Copy, Reset). Its startup code runs when Photoshop launches, even with the panel closed, and dials the helper on `ws://localhost:9890`. *Tested automated* (the built bundle runs in a fake UXP host). *Not tested* in Photoshop with this build.
- **Sign-in**: paste a Project API key and its secret (pasting `key:secret` or the two on two lines fills both fields), then **Save and test**. The plugin makes two free reads on Scenario's API, an authenticated read and the project listing, and saves the key in UXP secure storage only when both pass. The panel header then shows the project name, or `Scenario project ....` and the key's last 4 characters when no name is readable. A key for another project can be added and switched from the header; Settings has **Test connection**, **Sign out** (the current project's key) and **Copy diagnostics**. A refused key, a Reader key, a team (Organization) key and no connection each get their own message. *Tested automated* against a mock of Scenario's API that answers as the live API did, including a test that the key, the secret and the listing's member emails and key ids never reach logs, files, the helper, `scenario_status`, the panel or the clipboard. *Not tested* in Photoshop: the sign-in itself, reading the masked secret field on macOS, paste handling and secure storage removal.
- **Helper** (`helper/`, npm package `@scenario-labs/photoshop-mcp`, command `scenario-photoshop`): an MCP server over stdio with one tool, `scenario_status`, which reports whether the plugin is linked, the Photoshop and plugin versions, whether the plugin is signed in and the project name (never the key), the agent switches and spending settings, and the open documents (ids and titles). *Tested automated*.
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
npm run package   # build/scenario-photoshop-0.1.0.ccx
```

Details for contributors and coding agents: [AGENTS.md](AGENTS.md). Design: [docs/spec/SPEC.md](docs/spec/SPEC.md) and the tool reference [docs/spec/MCP.md](docs/spec/MCP.md).

## Privacy

This build sends your API key and secret only to Scenario's API (`https://api.cloud.scenario.com`), as HTTP Basic authentication over HTTPS, for the two sign-in reads; it never follows a redirect with them. Of the project listing it keeps the project name, the project id and the key's own role; the listing's member emails and other keys are dropped at once. Links you click open in your browser after Photoshop asks. Otherwise the only network use is the loopback link between the plugin and the helper. See [PRIVACY.md](PRIVACY.md) for the full design.

## License

MIT, see [LICENSE](LICENSE). Third-party code: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Adobe and Photoshop are trademarks of Adobe. This project is not affiliated with or endorsed by Adobe.
