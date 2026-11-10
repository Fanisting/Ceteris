# Windows, macOS and Linux

Ceteris runs on all three systems from one code base. Platform differences live in a small adapter layer, so behaviour stays the same where it can.

On Windows the app lives in the system tray and offers an Explorer context menu entry. On macOS it stays in the Dock after its windows close, and your login shell's PATH reaches your terminals. Unsigned macOS builds need a right click and "Open" the first time.

On Linux the app behaves like a normal desktop app. Closing the last window quits it, and Ceteris asks first if a terminal is still running. Packages come as AppImage, deb and rpm.

Related: [ADR-013](../docs/软件定义书.md) and the [Linux installation guide](../docs/Linux安装指南-20260517.md).
