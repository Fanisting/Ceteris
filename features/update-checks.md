# Update checks

The stable build checks GitHub Releases shortly after start and every 6 hours. When a newer version exists, a small dot appears on the sidebar settings button. A message also pops up inside the window, "Ceteris X.Y.Z is available", with **Download** (the installer for your system) and **Details** (Settings, About). It shows once per version, and not while you are in Settings.

Open Settings and go to About to see a Download button. It links to the installer that fits your system, such as Windows Setup, a macOS build for your chip, or a Linux AppImage, deb or rpm.

Ceteris never downloads or installs anything by itself, and it shows no pop-up. You can turn the automatic check off in the same page, or press "Check now".

Beta and dev builds do not check.

Related: [ADR-018](../docs/软件定义书.md).
