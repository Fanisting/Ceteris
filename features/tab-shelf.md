# Tab shelf

Idle tabs move into a shelf to free memory, and come back with their conversation when you click them.

## Turning it on

Settings, Behavior, **Shelve idle tabs**: pick 1, 3 or 5 hours, or 1, 3 or 5 days. A tab with no output and no typing for that long has its process ended, and the tab slides into a grey box at the left end of the tab bar. You can also right-click a tab and choose **Put in the shelf** at any time.

Ceteris never shelves an agent that is working, a Coordinator or Fintuner tab, or a tab some window is showing.

## Getting a tab back

Click the box to see the shelved tabs, with their icon, name, folder and how long ago they were shelved. Click a row to reopen it in this window. Claude Code and Codex resume the same conversation; a shell reopens in the same folder. The × at the end of a row removes it, and **Clear** empties the shelf. The shelf survives a restart.

Claude Code with the ceteris-tabs plugin reports its conversation id to Ceteris (update the plugin with `claude plugin update ceteris-tabs@ceteris`). For Codex, and for Claude Code without the plugin, Ceteris finds the conversation in the agent's own records by folder and time.

Related: [Software definition](../docs/软件定义书.md) (ADR-036), [Reopen tabs at launch](reopen-tabs-at-launch.md).
