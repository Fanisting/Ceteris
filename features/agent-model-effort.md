# Model and effort per folder and per tab

Pick which model and effort Claude Code and Codex use. Set a default for a folder, change it for a single running tab, and see how much of your limits and context that tab has used.

## Folder defaults

Click a folder in the sidebar. Above its sessions there is a row with one chip per agent: **CC** for Claude Code and **CX** for Codex. Each chip shows what new tabs in this folder start with, for example "Opus · high". Click it to pick a model from the list and an effort level below it. **Default** means the agent's own setting, so Ceteris adds nothing.

New tabs in that folder then start with `--model` and `--effort` (Claude Code) or `-m` and `-c model_reasoning_effort=…` (Codex). Your global agent settings are not changed.

## One tab

Claude Code and Codex tabs have a thin strip under the terminal. The chip at its left shows the tab's model and effort, and the share of the context window in use. Click it to open a panel like the OMC status line:

- **Model** and **Effort**: pick one to switch this tab. Ceteris exits the agent, waits for the shell, and starts it again in the same tab with the new model, resuming the same conversation. It takes a few seconds and changes only this tab. The choices are greyed while the agent is working or waiting for your approval.
- **5h**, **wk** and **ctx**: the five hour and weekly limits with their reset times, and the context window in use. Context turns yellow at 70 % and red at 85 %, and suggests `/compact` from 80 %.
- **Details** (folded): how long the session has run, when you sent the last prompt, how many prompts, tool, subagent and skill calls, the todo count, and the cost.

## Where the numbers come from

Ceteris only reads the agents' own files and never goes online. Codex writes everything to its session files. Claude Code writes the conversation and context, and its limits and cost come from the OMC status line cache when OMC is installed; without it, 5h and wk show "—".

## Limits

Only Claude Code and Codex, and only local folders: SSH tabs show neither the panel numbers nor the switch. Text you typed but did not send is lost when a tab switches model. Codex prints a startup warning when an effort is set, because its `-c` flag makes it skip the shared background server; it works normally.

Related: [Software definition](../docs/软件定义书.md) (ADR-038), [Full reload on agent update](agent-full-reload.md).
