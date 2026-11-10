# Reopen tabs at launch

When Ceteris starts, the tabs you had open last time come back. This holds after a normal quit, after installing a new version from GitHub, and after a crash. Claude Code and Codex tabs continue their own conversation, so you do not type a resume command or look up an id.

## What comes back, and how

- **Plain shell tabs** open again in the same folder.
- **Claude Code and Codex** open again with the exact conversation each tab had (`claude --resume <id>`, `codex resume <id>`). Two Claude tabs in one folder each get their own conversation back. If Ceteris cannot find a tab's conversation file, that tab starts a fresh conversation instead of guessing.
- **Other built-in agents** (OpenCode, Gemini CLI, GitHub Copilot, Cursor, Aider) resume the folder's latest conversation when they were the only tab of that agent in the folder; otherwise they start fresh.
- **Custom templates, SSH tabs and the Admin Shell** do not run on their own at launch, since they may run any command, ask for a password or ask for administrator rights. They wait in the shelf at the left end of the tab row; one click opens each.

Tab names and roles such as Coordinator come back too. The tab you were looking at shows in the first window; the others wait in the tab row.

## Where to turn it off

Settings, Behavior, **Reopen tabs at launch**. It is on by default. With it off, Ceteris starts with no tabs, as before.

## How it works

Ceteris keeps a small file, `restore.json`, in its data folder up to date while it runs, about a second after any tab opens, closes or changes. An installer usually ends Ceteris without a normal quit, so the file is never written only at the end. Each channel (stable, beta, dev) has its own file.

Claude Code tabs with the ceteris-tabs plugin installed report their conversation id directly. Without the plugin, and for Codex, Ceteris looks in the agent's own transcript folder for the file that tab was writing.

Text you typed but did not send, and a pending approval prompt, are not saved; the agent itself does not keep them.

Related: [Terminal tabs and windows](terminal-tabs-and-windows.md), [Update checks](update-checks.md), [Software definition](../docs/软件定义书.md) (ADR-039).
