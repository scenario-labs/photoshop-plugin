# Security Policy

## Reporting a vulnerability

Do not report security vulnerabilities through public GitHub issues, discussions or pull requests: everything posted there is public and permanent.

Report privately instead, through either channel:

- Email support@scenario.com with "security" in the subject line.
- Use in-app support at [app.scenario.com](https://app.scenario.com).

Include what an investigation needs: the affected part (the Photoshop plugin, the local `scenario-photoshop` helper, or the Scenario platform), the plugin version (Settings > About), the Photoshop version and operating system, reproduction steps, and the impact you see. **Copy diagnostics** in Settings gives the versions and recent error types without prompts, names, paths, keys or tokens. Scenario support routes security reports to the right team and follows up through the same channel.

## Supported versions

Nothing is released yet. Every build in this repository is a development build; fixes go into the next one. Once a release ships, security fixes go into the latest release only.

## Scope

Reports that belong here include:

- the plugin or the helper sending your Scenario key or secret anywhere other than Scenario's API, or writing it to a file, log, layer or clipboard;
- the pairing token leaking (into a client config, a process argument, a log), or a program that does not hold it acting as the plugin or as the helper;
- an agent getting past the panel's switches or cards: spending credits, uploading pixels or changing a document without the approval this build promises (see [docs/MCP.md](docs/MCP.md));
- a Photoshop command (batchPlay) outside the allow-list being run for an agent, such as one that saves, closes, exports, plays Actions or runs scripts;
- the plugin reaching a host not listed in [PRIVACY.md](PRIVACY.md), or a download accepted from a host other than Scenario's CDN;
- a web page or another computer reaching the helper's local port;
- a supply-chain concern with the repository's dependencies, build or package.

Vulnerabilities in the Scenario platform itself (app.scenario.com, the public API, the Scenario MCP server at mcp.scenario.com) go through the same private channels, not through this repository's issue tracker. Problems in Photoshop or UXP go to Adobe.

## What the design relies on

These are the limits of what the plugin can protect, written out so a report can say which one failed:

- **Your key** stays in Photoshop's secure storage for this plugin and goes only to `https://api.cloud.scenario.com` over HTTPS. The helper and agents never receive it. *Tested automated*.
- **The local link** listens on the loopback interface only (port 9890). The plugin and each helper prove they hold the pairing token without sending it, and every message carries a code only token holders can produce. Messages are authenticated, not encrypted. *Tested automated*; pairing *verified live*.
- **Programs running under your own account** can read the token file and client configs. Agent clients that run commands on your computer (Claude Code, Codex, Cursor) run under your account. The switches and cards govern what agents do through the helper; they cannot stop a program that already runs as you. A CU limit on your API key, set on app.scenario.com, caps spending either way.
- **Spending** needs the exact quoted price: a changed price or an expired quote is refused before anything is sent, and a price that changes after an upload asks again. *Tested automated*; *verified live* in the panel and through an agent.

## Secrets in issues and pull requests

Never paste API keys, secrets, the pairing token or signed asset links (they are credentials) into issues or pull requests. If you spot a secret already exposed in this repository, report it privately rather than pointing to it in a public issue.
