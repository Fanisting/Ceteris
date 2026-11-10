# Model and effort per folder and per tab

Pick which model and effort Claude Code and Codex use. Set a default for a folder, change it for a single running tab, and see how much of your limits and context that tab has used.

## Folder defaults

Click a folder in the sidebar. For each agent that has a tab in the folder, a row appears above the sessions, written like `CC [Opus] [high]` (**CC** is Claude Code, **CX** is Codex). Click the word in a bracket to choose: the first bracket is the model, the second the effort. **Default** means the agent's own setting, so Ceteris adds nothing.

New tabs of that agent in the folder then start with `--model` and `--effort` (Claude Code) or `-m` and `-c model_reasoning_effort=…` (Codex). Your global agent settings are not changed.

## One tab

The row with the split-view icons under the terminals shows the selected tab on its left:

`Sonnet - high - 3% (5h) - 10% (wk) - 10% (ctx)`

- Click the **model** or the **effort** to choose a new one. Ceteris exits the agent, waits for the shell, and starts it again in the same tab with the new choice, resuming the same conversation. The line says "Switching to …" for the few seconds this takes, then a notice confirms it. Only this tab changes. While the agent is working or waiting for your approval, the menu still opens but its choices are greyed out, with the reason shown.
- The percentages are the five hour limit, the weekly limit and the context window in use. They turn yellow from 70 % and red from 85 % (context) or 90 % (limits). Click them for the details: reset times, context tokens, how long the session has run, the last prompt, prompt and call counts, todos and cost.

## Where the numbers come from

Ceteris only reads the agents' own files and never goes online. Codex writes everything to its session files. Claude Code writes the conversation and context, and its limits and cost come from the OMC status line cache when OMC is installed; without it, the limits show "—".

## Limits

Only Claude Code and Codex, and only local folders: SSH tabs show the model but cannot switch. Text you typed but did not send is cleared when a tab switches model. Codex prints a startup warning when an effort is set, because its `-c` flag makes it skip the shared background server; it works normally.

Related: [Software definition](../docs/软件定义书.md) (ADR-038), [Full reload on agent update](agent-full-reload.md).
