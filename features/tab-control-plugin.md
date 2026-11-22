# Tab control plugin

A Coordinator running Claude Code can manage the other tabs in its folder. It can list them, open new ones, type text or keys into them, read their screen, wait until they finish or ask for approval, rename them and close them.

For example, the Coordinator can start another Claude Code, give it a task, and come back when it is done.

There is no switch to turn on. Put a tab in the coordinator row (right-click it, Role, Coordinator) and ask it to open workers. The plugin must be installed once: run the two commands shown in Settings under Extensions. They install the ceteris-tabs plugin that ships with Ceteris. You need no extra software.

Only a tab in the coordinator row can use it, and only on its own folder. Other tabs are refused. A Coordinator cannot close or type into itself. Removing the role stops access at once.

Related: [ADR-024](../docs/软件定义书.md) and [Open file tool](open-file-tool.md).
