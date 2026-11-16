# Main agent

Ceteris asks once which agent you work with most. A small card appears at first start, and existing users see it once after the update. It lists the agents installed on this computer and preselects the one you open most often. Choose one, or press Later.

Your main agent then comes first:

- It moves to the front of quick launch (the ghost tab).
- The new tab page shows it as a full-width card in the Agents section, with Change to pick another.
- The remote setup guide, the Fintuner shortcut and the extension setup card start from it, instead of assuming Claude Code.

Until you choose, the first installed agent stands in. If your main agent is uninstalled or its template is deleted, Ceteris skips it and uses the first installed agent. Quick launch also hides agents whose command is not on PATH.

Codex as a coordinator now gets the same enable and setup steps as Claude Code; the setup step writes the ceteris-tabs server into Codex's config.toml.

The choice is stored in `behavior.mainAgent`.

Related: [ADR-042](../docs/软件定义书.md), [Ghost tab quick launch](ghost-tab-quick-launch.md) and [Extension setup card](extension-setup.md).
