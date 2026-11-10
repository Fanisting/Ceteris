# Full reload on agent update

An agent such as Claude Code has to stop before it can be updated. On Windows the running program is locked, so the update fails while any tab runs it. Ceteris can do the whole cycle for you: close the agent's tabs, update it, and bring the tabs back with their conversations.

## Where to find it

Open the new tab page of a folder. The yellow dot beside an agent means a new version exists. Click it while that agent has tabs open and Ceteris asks:

- **Full reload** closes every tab of that agent, runs the update in a terminal, then reopens each tab in the same folder with its last conversation. Tabs that were working when they closed are sent `continue` automatically once their prompt is back and quiet, so you type nothing; the final notice has a button that opens the first such tab so you can check it carried on. Tab names you set yourself, and roles such as Coordinator, are restored.
- **Update only** just runs the update command in a new tab, as before.
- **Cancel** does nothing.

The same choice appears as a "Full reload" button on the "new version available" and "waits for tabs to close" notices, whenever that agent has tabs open in your window.

## What it does not touch

Only tabs started from that agent's own template are closed. Tabs of other agents, plain shell tabs and SSH tabs stay as they are. If a plain shell tab is running the same agent by hand, the dialog says so and leaves it to you, because such a tab can still block the update on Windows.

## After the update

Ceteris checks the installed version again before reopening anything, and the final notice says which version the reopened tabs run. If the update failed, the tabs come back on the old version and the notice says so. Tabs that were waiting for your approval are reopened without a continue message, so you decide in the reopened tab.

How a conversation is resumed depends on the agent: Claude Code uses `--continue`, Codex `resume --last`, OpenCode `--continue`, Gemini CLI `--resume latest`. An agent without such a flag reopens with a fresh conversation, and the dialog tells you that beforehand.

Related: [Agent updates](agent-updates.md), [Software definition](../docs/软件定义书.md) (ADR-037).
