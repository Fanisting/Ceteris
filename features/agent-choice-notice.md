# Choice notice

When Claude Code stops to ask you something, Ceteris tells you which tab is waiting, even if you are looking at another tab or another window.

## When it appears

Claude Code sometimes asks you to pick from a list ("Which colour do you prefer? 1. Red 2. Blue"), or to approve a step. If that tab is not on your screen, a notice appears: "X is waiting for your decision". The tab itself breathes in the warning colour, the same as for an approval.

The notice goes away by itself when the agent carries on, when you look at the tab, or when the tab closes. Tabs that were already waiting when a window opened do not raise a notice.

## Answering from the notice

**Go to tab** takes you to the tab, the same way a click in the sidebar does. If another window holds the tab, that window comes to the front.

**Options** opens the question inside the notice. Click a choice and Ceteris answers it in the tab. Ceteris reads the screen again first and sends nothing if the question has changed. Choices that need typing, such as "Type something" or "Chat about this", take you to the tab instead. Multi select questions and questions spread over several pages work too.

Notices now use your theme's own surface: dark on dark themes, light on light ones.

There is no setting. Related: [Software definition](../docs/软件定义书.md) (ADR-035), [Agent state animations](agent-state-animations.md).
