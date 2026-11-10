# Agent updates

Ceteris can tell you when the coding agents on your machine have a new version. It checks each built-in agent at start and every 6 hours.

When a new version exists, a notice offers Update and "Skip this version". The update runs in a terminal that closes when it succeeds, and you get a done or failed notice afterwards.

Ceteris updates an agent with the same tool that installed it, such as npm, Homebrew, winget, scoop, bun or pnpm. This avoids a second copy that could shadow the first. If it cannot tell, it falls back to the agent's own update command.

In Settings under Shell, you can turn the check off, press "Check now", or turn on automatic updates. Automatic updates are off by default and always wait 30 seconds with a way to cancel.

Related: [Software definition](../docs/软件定义书.md).
