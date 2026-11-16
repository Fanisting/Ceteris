# Ceteris Link

Ceteris Link opens the terminal tabs that run on another computer, live. You see the same sessions, the same scrollback and the same running agents.

The sessions never leave the host. You can close your laptop and the agents keep working. Typing on the laptop goes straight to the host.

To start, click the Local badge in the title bar. Choose Local, a saved Tailscale host, or an SSH server. The two computers need a network path, and the guide recommends Tailscale. A pre-shared token never travels over the network, and the traffic is end-to-end encrypted.

When the network drops for a moment, Link reconnects on its own. The window does not reload: the terminals keep their content, the output you missed is added at the end, and the tabs and sidebar catch up with the host. A terminal that printed more than about 1 MiB while you were away redraws once. Split panes come back too.

If the host has not answered for 3 seconds, or for 1 second after you type, a "Link slow" bar appears at the top of the window and the Remote settings show "Slow". It goes away with the next reply. After 15 seconds of silence Link counts the connection as lost and reconnects, starting half a second later.

Both computers need the same Ceteris version, because the Link protocol version changed to 2.

Link works between Windows computers. It is different from SSH. SSH runs a shell on a server, and Link takes over all sessions of another Ceteris.

Related: [Remote access guide](../docs/远程访问指南.md) and the [Link protocol](../docs/ceteris-link-protocol.md).
