# Choice notice

When Claude Code stops to ask you something, Ceteris tells you which tab is waiting, even if you are looking at another tab or another window.

## When it appears

Claude Code sometimes asks you to pick from a list ("Which colour do you prefer? 1. Red 2. Blue"), or to approve a step. If that tab is not on your screen, a notice appears: "X is waiting for your decision". The tab itself breathes in the warning colour, the same as for an approval.

The notice goes away by itself when the agent carries on, when you look at the tab, or when the tab closes. Tabs that were already waiting when a window opened do not raise a notice.

## Answering from the notice

**Go to tab** takes you to the tab, the same way a click in the sidebar does. If another window holds the tab, that window comes to the front.

**Options** opens the question inside the notice. The notice widens to the tab page, leaving 16 px on each side, and shows the question exactly as Claude Code draws it in the tab: the tool header, the command or the diff, the preview box beside the choices, its colours and marks. Click any row of a choice and Ceteris answers it in the tab. Ceteris reads the screen again first and sends nothing if the question has changed. "Type something" and "Chat about this" open a text field under the question. Multi select questions and questions spread over several pages work too.

Notices now use your theme's own surface: dark on dark themes, light on light ones.

There is no setting. Related: [Software definition](../docs/软件定义书.md) (ADR-035), [Agent state animations](agent-state-animations.md).
