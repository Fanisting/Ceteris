# Skills panel

The sparkles button at the bottom of the sidebar, left of the file tree button, shows the skills of the agent in the selected tab. It works for Claude Code and Codex, including an agent you started by typing `claude` or `codex` in a shell tab.

The list takes the place of the file tree; only one of the two is open at a time. Skills are grouped by where they come from:

- **Project**: skills in the tab's folder and its parent folders, up to the git root; outside a git repository only the tab's own folder (`.claude/skills` for Claude Code, `.agents/skills` and `.codex/skills` for Codex).
- **Personal**: your own skills (`~/.claude/skills`, or `~/.codex/skills` and `~/.agents/skills`).
- **Plugin**: skills of each Claude Code plugin that is enabled for this folder.
- **Built in**: the skills Codex ships with.

Each row shows the skill's name and the first line of its description; hover for the whole description. Click a row to open its SKILL.md beside the terminal. Click a group title to fold it.

The panel only reads. It never types into the agent and never changes a skill. Tabs on SSH hosts are not listed.

Related: [File viewer](file-viewer.md) and [Model and effort](agent-model-effort.md).
