# Terminal tabs and windows

Ceteris runs your terminals as tabs. Each tab belongs to a folder, and the sidebar groups every tab by its folder.

You can open as many windows as you like. All windows are equal, and there is no main window. A tab opened in one window shows up in the others, and you can move between them freely.

Closing a window does not stop your terminals. On Windows the app stays in the system tray, and on macOS it stays in the Dock. On Linux the app closes with its last window, and it asks first if a terminal is still running.

A tab shows its state with a coloured dot: active, idle or exited. An exited tab stays on screen until you close it, so you can still read what happened.

Related: [ADR-005, ADR-006 and ADR-008](../docs/软件定义书.md) (window ownership, equal windows, folder and session rules) and [ADR-013](../docs/软件定义书.md) (Linux window behaviour).
