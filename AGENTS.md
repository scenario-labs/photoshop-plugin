# AGENTS.md

How to build, test and change this repository. Read [docs/spec/SPEC.md](docs/spec/SPEC.md) section 2 (architecture, link and pairing) and [docs/spec/MCP.md](docs/spec/MCP.md) before changing the link or the tools.

Claims here are marked *verified live* (in Photoshop), *tested automated* (Node, no Photoshop) or *not tested*.

## Layout

| Path | What |
|---|---|
| `plugin/` | UXP plugin: `manifest.json`, `index.html`, `styles.css`, `src/` (plain JavaScript, CommonJS modules), `scripts/build.js` (bundler), `scripts/package.js` (`.ccx`) |
| `plugin/src/util/` | SHA-256, HMAC, UTF-8, base64url, canonical JSON, random source. UXP has no `TextEncoder`, `TextDecoder` or `crypto.subtle` (*verified live* on 27.11 with a probe plugin) |
| `plugin/src/bridge/` | Link to the helper (`link.js`), proofs and MACs (`protocol.js`), pairing token (`pairing.js`), `scenario_status` (`status.js`) |
| `plugin/src/scenario/` | Scenario's REST API: `client.js` (HTTP Basic to the API base only, no redirects, read retries, timeouts) and `errors.js` (status plus known texts to error types). The catalog, schemas, price checks, runs and uploads go here next, on top of `client.request` |
| `plugin/src/auth/` | Saved keys in secure storage (`accounts.js`), `key:secret` parsing (`split.js`), Save and test, Test connection, switch and sign out (`auth.js`) |
| `plugin/src/ui/` | The link and lanes panel (`panel.js`, texts in `view.js`) and the account views: sign-in, projects, settings (`account-panel.js`, texts in `account-view.js`) |
| `plugin/src/diagnostics.js` | The Copy diagnostics text and the list of recent error types |
| `helper/` | `scenario-photoshop`: stdio MCP server (`mcp.js`, `tools.js`), port owner and peer (`link/`), token file (`token-file.js`), setup command (`setup.js`, `toml-edit.js`). `npm-shrinkwrap.json` pins its dependency tree for npm users |
| `shared/` | Tool catalog (`catalog.json`), error types (`errors.json`), link protocol (`protocol.json`), enums (`enums.json`), Scenario API settings, known error texts and links (`scenario-api.json`), a small JSON Schema checker used by both sides |
| `test/unit`, `test/integration` | `npm test` runs every `*.test.js` there |
| `test/helpers/` | Fake host and UXP-like WebSocket (`fakes.js`), a DOM built from the real `index.html` (`fake-dom.js`, with the macOS masked field), a mock of Scenario's API with random keys (`mock-scenario.js`), a UXP simulator that runs the built bundle (`uxp-sim.js`) |
| `test/vectors/pairing.json` | Known-answer vectors for the proofs, the session key and two frames |
| `test/live/` | Manual checks against a running Photoshop; not part of `npm test` |

## Commands

```sh
npm ci                 # installs ws, the helper's only run-time dependency
npm test               # all unit and integration tests, about 4 s
node test/run.js setup # only the test files whose path contains "setup"
npm run lint           # node --check, JSON, no em dashes, no machine paths or addresses, UXP rules
npm run build          # plugin/dist/main.js (release bundle)
npm run build:dev      # development bundle (adds the dev token import, below)
npm run package        # build/scenario-photoshop-0.1.0.ccx
npm run package:dev    # build/scenario-photoshop-0.1.0-dev.ccx
```

`npm test` and `npm run lint` pass on Node 20 and 22 on macOS (*tested automated*). CI runs them on Node 20 and 22, on Ubuntu and macOS.

## Rules for code

- **Plugin code is plain JavaScript** with no dependency. The bundler wraps each file in its own function scope and resolves relative `require`s at build time; `uxp`, `photoshop`, `os` and `fs` go to UXP's own `require`. No `eval`, no `new Function`, no top-level declaration named like a UXP global (a top-level `const URL` breaks UXP's WebSocket, *verified live* on 27.11 with a probe plugin). `npm run lint` checks this.
- **Everything the plugin reads from UXP or Photoshop goes through `plugin/src/host.js`**, so the rest runs under Node with a fake host.
- **The link protocol lives in `shared/protocol.json`** and is implemented twice, in `plugin/src/bridge/protocol.js` (pure JavaScript) and `helper/src/link/crypto.js` (`node:crypto`). Change both and `test/vectors/pairing.json` together; `test/unit/pairing-proofs.test.js` checks they agree byte for byte.
- **The pairing token is never logged, printed, put on a command line or sent over the socket.** Tests generate tokens; none is stored in the repository.
- **Tool errors are one line, `Type: message`**, with a type from `shared/errors.json`.
- **Scenario keys** (SPEC 2.10, Credentials): the key and secret go only to `base_url` in `shared/scenario-api.json`, as HTTP Basic, with `redirect: "error"`; `client.request` takes relative paths only. A redactor removes the exact key, secret and Basic value from log lines, error texts, copied text and diagnostics. Secure storage entry names are not encrypted, so a key is stored under `scenario.key.` plus a SHA-256 prefix of the key, and the index `scenario.accounts` holds the project name and id, the hash and the last 4 characters. Of the project listing, only the project name and id and the key's own role and scope are kept: it also lists members' emails and every key id. `test/unit/secret-leak.test.js` checks all of this on the release bundle; tests use random keys against `test/helpers/mock-scenario.js`, never a real key.
- **Scenario errors**: bodies carry `reason` or `message`, no code (measured live). Classify by HTTP status plus the known texts in `shared/scenario-api.json` (an unknown key answers 403 "Given APIKey does not exists"), and show Scenario's own text otherwise. Panel texts for each sign-in state are in `plugin/src/ui/account-view.js`, worded as SPEC 3.13.
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
   When the same version is already installed, the installer reports success but keeps the old copy. Run it with `--remove Scenario` first: that also clears the plugin's data folder and secure storage (saved keys and the pairing token). Photoshop 27.11 then loaded the reinstalled plugin at once, without a restart (*verified live*).
3. `node test/live/m1-live-check.js`, then start or restart Photoshop. The script writes a fresh token as `dev-pairing-token` into the plugin's data folder; a development build adopts it at startup and deletes the file, so no one has to open the panel. The script then runs the helper with that token and calls `scenario_status` until Photoshop answers. It prints the status (document titles hidden unless `--show-titles`) and the `Host`, `Origin` and `User-Agent` the plugin's WebSocket sent.

Release builds replace the dev import with an empty stub; `test/unit/bundle.test.js` checks that the release bundle does not contain it.

## Try sign-in in Photoshop (development)

*Verified live* on 27.11: this build loads and starts signed out. The sign-in itself is *not tested* live yet. Use a Project API key with the Editor role; Save and test makes two free reads and spends nothing.

1. Install the development package as above (remove the installed copy first; Photoshop loads the new one without a restart).
2. Open **Plugins > Scenario**. The header says "Not signed in" and the sign-in view is open.
3. Paste the key into **API key**. Pasting `key:secret`, or the key and the secret on two lines, also fills **API secret**; otherwise paste the secret into **API secret**.
4. Click **Save and test**. "Testing 1 of 2", then "Testing 2 of 2"; the header then shows the project name and a "Connected to Scenario" banner appears.
5. `scenario_status` (step 3 of the link check above) now reports `signed_in: true` and `project_name`.
6. The header's project name opens Projects (add a key for another project, switch); **Settings** opens Test connection, Sign out and Copy diagnostics.

## Connecting a real client by hand

```sh
pbpaste | node helper/bin/scenario-photoshop.js setup <claude-code|codex|cursor|claude-desktop> --local --token-stdin
node helper/bin/scenario-photoshop.js setup cursor --dry-run --local   # shows what it would do
```

`--local` points the client at this checkout instead of the npm package. The helper reads `SCENARIO_PHOTOSHOP_TOKEN` when the client sets it, else the token file that setup wrote.
