# Tab control plugin

A Coordinator running Claude Code can manage the other tabs in its folder. It can list them, open new ones, type text or keys into them, read their screen, wait until they finish or ask for approval, rename them and close them.

For example, the Coordinator can start another Claude Code, give it a task, and come back when it is done.

It is off by default. Turn it on in Settings under Extensions, then run the two commands shown there once. They install the ceteris-tabs plugin that ships with Ceteris. You need no extra software.

Only a tab marked as Coordinator can use it, and only on its own folder. Other tabs are refused. A Coordinator cannot close or type into itself. Removing the role stops access at once.

Related: [ADR-024](../docs/软件定义书.md) and [Open file tool](open-file-tool.md).
