# Launch templates

A launch template is a ready-made way to start a tab. Ceteris ships templates for Shell and for 22 coding agents: Claude Code, Codex, OpenCode, Gemini CLI, GitHub Copilot, Cursor, Aider, Pi, Oh My Pi, Qwen Code, Amp, Crush, Kimi CLI, Goose, Droid, Kiro CLI, Cline, Auggie, Kilo Code, CodeBuddy, Qoder CLI and Letta Code. On Windows there is also an Admin Shell.

Click the new tab button to see the list. Pick a template and the tab opens in the selected folder.

For a folder on this computer, the Agents section shows only the agents whose command Ceteris finds on PATH. Install one and press the refresh button beside Agents, and it appears. SSH and WSL folders still show every agent, because their agents live on another machine.

You can add your own templates in Settings under Shell. A template is just a name and a command, so any tool you run from a terminal can have one.

The Admin Shell asks Windows for elevation. If Windows sudo is turned on in inline mode, it runs inside the tab. Otherwise it opens in a separate window after you confirm the system prompt.

Related: [Software definition, launch templates and ADR-034](../docs/软件定义书.md).
