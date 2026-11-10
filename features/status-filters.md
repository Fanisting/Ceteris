# Status filters

Two filters sit at the start of the sidebar tag bar: Running and Needs you.

Running lists the terminals that are busy right now, across all folders. An agent counts while it works. A shell such as pwsh, cmd or bash counts from the moment you press Enter until its prompt comes back, so a quiet `npm run dev`, an ssh login or a long build stays in the list. Typing at the prompt does not count.

Needs you lists tabs that finished a round you have not looked at yet, plus Claude Code and Codex tabs that wait at an approval prompt. For an agent a round is one turn; for a shell it is one command. Opening the tab removes it from Needs you.

When you pick a filter, the sidebar shows only the folders that have matching terminals. It expands them and lists only the matching tabs.

You can combine a status filter with your folder tags. The two filters cannot be renamed, recoloured or deleted.

Related: [ADR-023](../docs/软件定义书.md) and [Agent state animations](agent-state-animations.md).
