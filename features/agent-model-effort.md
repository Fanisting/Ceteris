# Model and effort per folder and per tab

Pick which model and effort Claude Code and Codex use. Set a default for a folder, or change it for a single running tab.

## Folder defaults

Click a folder in the sidebar. For each agent that has a tab in the folder, a row appears above the sessions, written like `CC [Opus] [high]` (**CC** is Claude Code, **CX** is Codex). Click the word in a bracket to choose: the first bracket is the model, the second the effort. Until you choose, the brackets show, in grey, what the agent uses anyway: the model and effort in its own settings (Claude Code's settings.json, Codex's config.toml). Choosing that same value again goes back to following the agent's settings.

New tabs of that agent in the folder then start with `--model` and `--effort` (Claude Code) or `-m` and `-c model_reasoning_effort=…` (Codex). Your global agent settings are not changed.

## One tab

The row with the split-view icons under the terminals shows the selected tab's model and effort as two buttons the size of those icons, for example **Opus** and **high**: no fill, a thin outline in a gradient of the theme's colours, and the same rounded corner as the split-view buttons. They start on the same column as the agent's status line in the terminal (the OMC status bar, or Codex's footer), whatever the font size or split layout. Click either to choose a new one. Ceteris exits the agent, waits for the shell, and starts it again in the same tab with the new choice, resuming the same conversation. The row says "Switching to …" for the few seconds this takes, then a notice confirms it. Only this tab changes. While the agent is working or waiting for your approval, the menu still opens but its choices are greyed out, with the reason shown.

For a tab started without a choice, the buttons show the model and effort the agent reports, read from its own files, or else the ones in its settings.

Usage numbers (5 hour and weekly limits, context) are not shown here; the OMC status line in the terminal shows them.

## Limits

Only Claude Code and Codex, and only local folders: SSH tabs show the model but cannot switch. Text you typed but did not send is cleared when a tab switches model (the agent's Ctrl+Y brings it back). If Ceteris cannot clear it, it sends nothing and asks you to clear the input box yourself. Codex prints a startup warning when an effort is set, because its `-c` flag makes it skip the shared background server; it works normally.

Related: [Software definition](../docs/软件定义书.md) (ADR-038), [Full reload on agent update](agent-full-reload.md).
