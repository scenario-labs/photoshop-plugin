# AGENTS.md

How to build, test and change this repository. Read [docs/spec/SPEC.md](docs/spec/SPEC.md) section 2 (architecture, link and pairing) and [docs/spec/MCP.md](docs/spec/MCP.md) before changing the link or the tools.

Claims here are marked *verified live* (in Photoshop), *tested automated* (Node, no Photoshop) or *not tested*.

## Layout

| Path | What |
|---|---|
| `plugin/` | UXP plugin: `manifest.json`, `index.html`, `styles.css`, `src/` (plain JavaScript, CommonJS modules), `scripts/build.js` (bundler), `scripts/package.js` (`.ccx`) |
| `plugin/src/util/` | SHA-256, HMAC, UTF-8, base64url, canonical JSON, random source. UXP has no `TextEncoder`, `TextDecoder` or `crypto.subtle` (*verified live* on 27.11 with a probe plugin) |
| `plugin/src/bridge/` | Link to the helper (`link.js`), proofs and MACs (`protocol.js`), pairing token (`pairing.js`), `scenario_status` (`status.js`) |
| `helper/` | `scenario-photoshop`: stdio MCP server (`mcp.js`, `tools.js`), port owner and peer (`link/`), token file (`token-file.js`), setup command (`setup.js`, `toml-edit.js`). `npm-shrinkwrap.json` pins its dependency tree for npm users |
| `shared/` | Tool catalog (`catalog.json`), error types (`errors.json`), link protocol (`protocol.json`), enums (`enums.json`), a small JSON Schema checker used by both sides |
| `test/unit`, `test/integration` | `npm test` runs every `*.test.js` there |
| `test/vectors/pairing.json` | Known-answer vectors for the proofs, the session key and two frames |
| `test/live/` | Manual checks against a running Photoshop; not part of `npm test` |

## Commands

```sh
npm ci                 # installs ws, the helper's only run-time dependency
npm test               # all unit and integration tests, about 3 s
node test/run.js setup # only the test files whose path contains "setup"
npm run lint           # node --check, JSON, no em dashes, no machine paths or addresses, UXP rules
npm run build          # plugin/dist/main.js (release bundle)
npm run build:dev      # development bundle (adds the dev token import, below)
npm run package        # build/scenario-photoshop-0.1.0.ccx
npm run package:dev    # build/scenario-photoshop-0.1.0-dev.ccx
```

`npm test` and `npm run lint` pass on Node 22 on macOS (*tested automated*). CI runs them on Node 20 and 22, on Ubuntu and macOS.

## Rules for code

- **Plugin code is plain JavaScript** with no dependency. The bundler wraps each file in its own function scope and resolves relative `require`s at build time; `uxp`, `photoshop`, `os` and `fs` go to UXP's own `require`. No `eval`, no `new Function`, no top-level declaration named like a UXP global (a top-level `const URL` breaks UXP's WebSocket, *verified live* on 27.11 with a probe plugin). `npm run lint` checks this.
- **Everything the plugin reads from UXP or Photoshop goes through `plugin/src/host.js`**, so the rest runs under Node with a fake host.
- **The link protocol lives in `shared/protocol.json`** and is implemented twice, in `plugin/src/bridge/protocol.js` (pure JavaScript) and `helper/src/link/crypto.js` (`node:crypto`). Change both and `test/vectors/pairing.json` together; `test/unit/pairing-proofs.test.js` checks they agree byte for byte.
- **The pairing token is never logged, printed, put on a command line or sent over the socket.** Tests generate tokens; none is stored in the repository.
- **Tool errors are one line, `Type: message`**, with a type from `shared/errors.json`.
- **Client sessions** (SPEC 2.6): the owner gives each client a 16-byte session id when it connects and new ids to every client each time a plugin link opens; a name is set once, at the first `initialize`, cut to 64 characters. Calls carry only the session; the plugin takes names from the `clients` list and refuses a session it does not list. When a session leaves the list or the link drops, the plugin ends what was granted to it (in this build, the spending allowance). `test/unit/owner-checks.test.js` and `test/unit/plugin-link.test.js` cover this.
- **Dependencies**: MIT-compatible only, pinned to exact versions, listed in `THIRD_PARTY_NOTICES.md`; change `package-lock.json` and `helper/npm-shrinkwrap.json` together. Workflows pin each action by full commit and declare least permissions. `test/unit/supply-chain.test.js` checks all of this.
- The helper's tool list comes from `shared/catalog.json`. A test caps `tools/list` at 40,000 characters and each description at 2,500.
- Public repository: no machine paths, personal or customer names, email addresses, internal decision numbers or secrets. No em dashes in docs or comments. `npm run lint` checks what it can; maintainers can add a private word list with `LINT_DENYLIST=<file>`.

## Try the link in Photoshop (development)

*Verified live* on Photoshop 27.11 (macOS) with this build: the dev token is adopted and its file removed, `scenario_status` comes back from the live Photoshop through the helper, and the random source is `getRandomValues`. The plugin's WebSocket sent `Host: localhost:9890`, `Origin: file://` and `User-Agent: WebSocket++/0.8.2`. The panel's look and 26.x were not checked.

1. `npm run package:dev`.
2. Install the package with Adobe's installer (macOS path shown; the plugin loads at the next Photoshop launch). The installer needs an absolute path: a relative one fails with status -160 (*verified live* on 27.11).
   ```sh
   "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent" --install "$PWD/build/scenario-photoshop-0.1.0-dev.ccx"
   ```
3. `node test/live/m1-live-check.js`, then start or restart Photoshop. The script writes a fresh token as `dev-pairing-token` into the plugin's data folder; a development build adopts it at startup and deletes the file, so no one has to open the panel. The script then runs the helper with that token and calls `scenario_status` until Photoshop answers. It prints the status (document titles hidden unless `--show-titles`) and the `Host`, `Origin` and `User-Agent` the plugin's WebSocket sent.

Release builds replace the dev import with an empty stub; `test/unit/bundle.test.js` checks that the release bundle does not contain it.

## Connecting a real client by hand

```sh
pbpaste | node helper/bin/scenario-photoshop.js setup <claude-code|codex|cursor|claude-desktop> --local --token-stdin
node helper/bin/scenario-photoshop.js setup cursor --dry-run --local   # shows what it would do
```

`--local` points the client at this checkout instead of the npm package. The helper reads `SCENARIO_PHOTOSHOP_TOKEN` when the client sets it, else the token file that setup wrote.
