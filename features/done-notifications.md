# Done notifications

Ceteris can tell you through your system's notifications when an agent finishes answering, so you can work in another program while Claude Code or Codex thinks.

## Turning it on for a tab

Under the terminals, the row with the split view buttons shows the selected tab's model and effort. Next to them is a bell. Click it and the bell lights up: from now on, when this tab's agent finishes a turn, a notification appears (the Windows notification center, macOS Notification Center, or your Linux desktop's notifications). Click the bell again to turn it off.

Every tab starts with its bell off. The bell stays on when Ceteris reopens the tab at the next launch.

## What the notification says

The title is the tab's name. The text names the agent and the folder, for example "Claude Code finished in app". Click it and Ceteris comes to the front with that tab open, in the window where you last looked at it, even if that window sits behind a remote view.

No notification appears while you are in the Ceteris window where you last looked at that tab: the done dot in the sidebar already shows there. A turn counts once the agent has stayed done for a moment and you had sent it a message, so a starting or restored agent does not notify.

## Settings

Settings → Notifications has the master switch (on by default) and **Send a test notification**, which shows one notification right away so you can check that the system allows Ceteris to notify. If nothing appears, look at the system's notification settings and Do Not Disturb.

## Remote tabs

For a tab you opened over [Ceteris Link](ceteris-link.md), the notification appears on the computer in front of you, not on the Host, and follows the switch in a local window of that computer.

Related: [Software definition](../docs/软件定义书.md) (ADR-048), [Model and effort](agent-model-effort.md), [Agent state animations](agent-state-animations.md).
