# Responsive terminals under heavy output

When a program prints a lot at once (`cat` of a large file, a long build log, an AI agent redrawing its screen), your keystrokes, their echo and Ctrl+C still get through at once. This works the same in local windows and in Ceteris Link windows on another computer.

## What you notice

- **Ctrl+C stops a flood quickly.** Ceteris no longer lets megabytes of output pile up between the program and the screen, so the interrupt and the program's reaction are not stuck behind them.
- **Typing feels quicker.** The first output after a quiet moment, such as the echo of the key you just pressed, goes to the screen right away instead of waiting for the next 8 ms batch.
- **Agent redraws arrive whole.** Claude Code and Codex mark each screen redraw as one frame (DEC synchronized output). Ceteris sends such a frame to the screen in one piece, so you do not see half of a redraw.

There is nothing to turn on or off.

## How it works

Ceteris counts the output it has sent to the window showing a terminal. That window confirms what it has drawn, in steps of about 5 KB. When more than about 100 KB is sent but not yet confirmed, Ceteris pauses reading from the program; the program waits until the window catches up, then continues. Ceteris never pauses a terminal that no window shows, never pauses before the window has confirmed once, and lifts any pause that sees no confirmation for 2 seconds, so a slow, minimized or disconnected window can never stall a build or an agent for long. A minimized or covered window confirms output as it arrives.

A redraw frame is held for at most 50 ms or 256 KiB; after that it is shown anyway.

Related: [Terminal tabs and windows](terminal-tabs-and-windows.md), [Ceteris Link](ceteris-link.md), [Software definition](../docs/软件定义书.md) (ADR-051).
