# Agent state animations

Tabs show what an agent is doing, not only whether it prints something. Each tab has a wave line in the theme's main colour.

The wave changes shape with the work. It is fast and dense while the agent writes, slow and gentle while it waits, and a single pulse runs along it while it runs a command. When output stops, the wave flattens and fades.

When Claude Code or Codex waits at an approval prompt, the tab bottom and the sidebar dot breathe in a warning colour until you answer. When an agent finishes while you look elsewhere, a dot stays on its tab and in the sidebar until you open it.

Plain shells keep the simple rule: they only show whether there is output.

Related: [ADR-021](../docs/软件定义书.md).
