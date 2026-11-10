# Ceteris Link

Ceteris Link opens the terminal tabs that run on another computer, live. You see the same sessions, the same scrollback and the same running agents.

The sessions never leave the host. You can close your laptop and the agents keep working. Typing on the laptop goes straight to the host.

To start, click the Local badge in the title bar. Choose Local, a saved Tailscale host, or an SSH server. The two computers need a network path, and the guide recommends Tailscale. A pre-shared token never travels over the network, and the traffic is end-to-end encrypted.

Link works between Windows computers. It is different from SSH. SSH runs a shell on a server, and Link takes over all sessions of another Ceteris.

Related: [Remote access guide](../docs/远程访问指南.md) and the [Link protocol](../docs/ceteris-link-protocol.md).
