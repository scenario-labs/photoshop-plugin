# Support

Scenario for Photoshop is an open-source Photoshop plugin and local agent helper maintained by Scenario. This page says where to look and whom to ask.

## Using the plugin

- Start with the [User Guide](docs/USER_GUIDE.md), including [Troubleshooting](docs/USER_GUIDE.md#troubleshooting), and [Known limitations](docs/KNOWN_LIMITATIONS.md) for what this build does not do yet.
- For agents (Claude Code, Codex, Cursor, Claude Desktop), see [Agents and the Scenario MCP](docs/MCP.md).
- For models, Creative Units and account settings, see the [Scenario Knowledge Base](https://help.scenario.com).
- For changes between builds, read the [changelog](CHANGELOG.md). Nothing is released yet: every build is a development build.

## Bugs, change requests and questions

Use the [issue chooser](https://github.com/scenario-labs/photoshop-plugin/issues/new/choose). Search the [existing issues](https://github.com/scenario-labs/photoshop-plugin/issues) first. For a question, open a blank issue with a title starting with "Question:".

Before filing a bug, collect:

- The Photoshop version (Help > About Photoshop on Windows, Photoshop > About Photoshop on macOS) and your operating system.
- The plugin version from **About Scenario for Photoshop** in the panel menu, and whether you installed a release or a development `.ccx`.
- For an agent problem, the helper version (`scenario-photoshop --version`) and the agent client.
- The action, model and steps to reproduce, what you expected and what happened.
- The report from **Copy diagnostics** (Settings, or **Diagnostics…** in the panel menu): versions, switch states, job counts and the last error types, without prompts, names, ids, paths, keys or tokens.

Public issues and attachments are visible to everyone. Never include an API key, an API secret, the pairing token, a signed download URL, team or project ids, or artwork you do not want published.

## Account, billing, credits, API keys and security

Keep these matters out of public issues. Write to [support@scenario.com](mailto:support@scenario.com) or use in-app support at [app.scenario.com](https://app.scenario.com). Report security vulnerabilities as described in [SECURITY.md](SECURITY.md).

## What to expect

Plugin issues are handled on a best-effort basis, without a response-time commitment. Support for your Scenario account or subscription goes through the Scenario channels above.
