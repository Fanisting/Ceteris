# SSH with tmux

When you launch a tab on an SSH server, Ceteris can start or attach to a tmux session there. Your work then survives a dropped connection.

The tmux session name comes from the folder, so the same folder always returns to the same session. When you leave tmux, the tab falls back to the plain remote shell instead of closing.

Ceteris uses its own tmux server on the remote host. A beta or dev build cannot attach to a session of your stable build.

Related: [SSH profiles and remote folders](ssh-remote-folders.md) and [Release channels](release-channels.md).
