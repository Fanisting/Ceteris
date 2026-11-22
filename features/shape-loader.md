# Shape loader

While Ceteris waits for something, a small filled shape morphs through seven Material shapes and turns slowly. It is the Material 3 Expressive loading indicator, the same one legado-with-MD3 uses, and it takes its colours from your theme.

## Where it appears

- **Opening a file** beside the terminal: a filled circle with the shape inside, and "Opening…" under it.
- **A new tab before it prints anything**: a new agent tab, a tab reopened at launch, or a tab reopened after an agent update. The loader sits in the middle of the empty terminal and goes away with the first output. It never covers text and clicks pass through it.
- **Connecting to a remote**: in the SSH folder picker, at the top of the file tree while SFTP connects, and in the Ceteris Link banner and status while it connects or reconnects.
- **Changing a tab's model or effort**: the tab dims behind a light veil, in every window that shows it, with the loader and "Switching to Opus 5.5…" in the middle. You do not see the agent exit and start again; the veil lifts once the agent's input box is back.
- **The file tree while a folder loads**: at the top while the folder list is read, and under a folder you open until its contents arrive. This matters on network drives, WSL paths, online-only cloud files and Link remotes.

## When it does not appear

Waits shorter than 0.3 seconds show nothing, so fast local folders and files never flash a loader. Link connecting and reconnecting show it at once, because those always take a while.

With Windows "Animation effects" turned off (prefers-reduced-motion), the shape stays still.

There is no setting. Related: [Software definition](../docs/软件定义书.md) (ADR-054), [Material Design 3 look](material-design-look.md).
