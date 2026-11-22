# Agent tab titles

A new agent tab is called New Tab until it has a task. A title that only names the agent, such as "Claude Code" at launch, does not replace it.

Agent tabs get short, readable titles. Spinners and symbols that an agent puts in its own title are removed, and long titles are cut to a length you choose. The default is 24 characters.

You can go further. In Settings under AI Assistant, turn on Tab titles. After each turn, a model reads your last prompt and the end of the screen, and writes a title by your rules. It names the task you asked for, not the tool output or errors on the screen. It keeps the old title while the task stays the same.

If the model stops answering (no credit, a timeout, an empty reply), the tab goes back to the title the agent sets itself, so a stale title does not stay. The model takes over again after its next answer.

This is off by default, because your last prompt and the end of the screen are sent to the model. It uses the same service and model as [Next prompt suggestions](next-prompt-suggestions.md). It covers all built-in agents.

A title you type yourself is never overwritten.

Related: [ADR-029](../docs/软件定义书.md).
