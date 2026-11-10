# Ceteris

> Your terminal sessions shouldn't die just because you closed the window.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/Fanisting/ceteris/releases)
[![Status](https://img.shields.io/badge/status-alpha-orange)](#roadmap)
[![中文文档](https://img.shields.io/badge/中文文档-README.zh--CN.md-red)](README.zh-CN.md)

A path-centric, AI-agent-friendly terminal manager for Windows, macOS and Linux. Built for developers who run multiple long-running tasks (including Claude Code, Codex, OpenCode, and other AI coding agents) across many local or SSH working directories, and who refuse to lose them when the window closes.

> **Fork note**: Ceteris is a fork of [Marina](https://github.com/Liyue-Cheng/marina) by Liyue-Cheng, which began as EasyTerm.

---

## The Problem

If you've ever:

- 🤖 Run 5 AI coding agents in 5 different projects and **forgotten which one was waiting for your input**
- 💀 Accidentally closed your terminal window and **killed a 2-hour build / a long pytest run / an agent mid-task**
- 🌀 Spent 10 seconds typing `cd D:\projects\company\some\deeply\nested\path` for the third time today
- 🔐 Jumped between remote servers and wished SSH sessions were organized by path, not by a pile of terminal tabs
- 📑 Tried to organize your work in Windows Terminal profiles and given up

...Ceteris is for you.

## The Solution

Ceteris rethinks how terminal sessions should be managed:

- **🔒 Sessions survive window closure.** Close every window. Sessions keep running in the background. Reopen any window to see them.
- **📍 Paths are first-class.** Keep working directories in one list and filter it by tag. Sessions are organized by where they live, not by which profile spawned them.
- **🖱️ Mouse-first.** No keyboard shortcuts to memorize. No `cd` typing. Click paths in the sidebar — that's the workflow.
- **🪟 All windows are equal.** No "main window" concept. Open as many as you want, close any of them — the app keeps running.

## Screenshots

> Screenshots coming with the first stable release. Below is a layout sketch.

```
┌────────────────────────────────────────────────────────────────────┐
│ Ceteris — Window 1                                    [_] [□] [×]  │
├──────────────────────┬─────────────────────────────────────────────┤
│ [Folders] [Tags]     │  ┌─[claude] [shell] [pytest] [codex⚪]┐    │
│                      │  └────────────────────────────────────┘   │
│                      │                                              │
│ ▼ ⌘ ~/projects/auth  │   ┌──────────────────────────────────────┐  │
│   ├─ ● claude code   │   │ $ claude                             │  │
│   ├─ ◐ shell         │   │ ✻ Welcome to Claude Code             │  │
│   └─ ○ pytest        │   │                                      │  │
│ ▼ ⌘ ~/projects/web   │   │ How can I help you today?            │  │
│   └─ ● codex         │   │ █                                    │  │
│ ▶ ⌘ ~/scripts        │   │                                      │  │
│                      │   │                                      │  │
│                      │   │                                      │  │
│ ▼ ⌚ ~/Downloads     │   │                                      │  │
│   └─ ○ shell         │   │                                      │  │
│                      │   │                                      │  │
│                      │   │                                      │  │
│ • ~/test123          │   │                                      │  │
│ • D:\old\project     │   └──────────────────────────────────────┘  │
│                      │                                             │
│ [⚙] Settings         │                                             │
└──────────────────────┴─────────────────────────────────────────────┘
```

Ceteris ships with two title-bar styles (**Windows** controls on the right, **macOS** traffic-light on the left) selectable from Settings.

## Why Not Just Use [X]?

| Feature | Windows Terminal | Tabby | Wave | Warp | **Ceteris** |
|---------|:---:|:---:|:---:|:---:|:---:|
| Sessions survive window closure | ❌ | ❌ | ✅ | ❌ | ✅ |
| Path-centric organization | ❌ | ❌ | ❌ | ❌ | ✅ |
| Auto cwd tracking (⚠ on drift) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Multi-window with shared session pool | ❌ | ❌ | ❌ | ❌ | ✅ |
| Close window without killing sessions | ❌ | ❌ | ✅ | ❌ | ✅ |
| Remote path bookmarks | ❌ | ❌ | ❌ | ❌ | ✅ |
| One-click remote tmux launch | ❌ | ❌ | ❌ | ❌ | ✅ |
| Built specifically for AI agent workflows | ❌ | ❌ | ❌ | ❌ | ✅ |
| Native Windows-first | ✅ | ✅ | ❌ | ❌ | ✅ |
| Mouse-first UI (no required shortcuts) | ❌ | ❌ | ❌ | ❌ | ✅ |

## For AI Agent Users

Ceteris was born from the frustration of running multiple Claude Code / Codex / OpenCode sessions concurrently and losing track of which one was idle, which one was waiting for input, and which one I'd accidentally killed by closing the wrong window.

If your workflow looks like this:

- One agent in `~/projects/frontend` working on the new dashboard
- Another agent in `~/projects/backend` refactoring the auth module
- A third agent in `~/scripts` running a long migration
- A fourth in `D:\client-work\report-tool` debugging a flaky test
- A fifth on `prod:~/repo` attached to a remote tmux session
- ...and you can't remember which is which

Ceteris gives you:

- **A persistent sidebar** showing every agent grouped by its project path
- **Status indicators** so you can see at a glance which agents are working vs. idle
- **CWD tracking** — when an agent `cd`s somewhere, the tab shows ⚠ with the real cwd in tooltip
- **SSH path bookmarks** — save remote profiles and bookmark remote working directories alongside local paths
- **Remote tmux launch** — start or attach to tmux on a remote host, and return to the remote shell when tmux exits
- **Templates** for Claude Code, Codex, OpenCode, Gemini CLI, GitHub Copilot, Cursor and Aider built in, with full custom template support for your own commands
- **Session immortality** — close a window by accident and your agent keeps running. Reopen and continue where you left off.

## Quick Start

> ⚠️ Ceteris is in **Alpha**. Expect rough edges. See the [Roadmap](#roadmap) for what's planned.

### Install

Download the file for your system from the [latest release](https://github.com/Fanisting/ceteris/releases/latest) (v0.4.1):

| System | Download |
|---|---|
| Windows 10/11 (x64) | [Ceteris-Setup-0.4.1-x64.exe](https://github.com/Fanisting/ceteris/releases/download/v0.4.1/Ceteris-Setup-0.4.1-x64.exe) |
| macOS, Apple Silicon | [Ceteris-0.4.1-arm64.dmg](https://github.com/Fanisting/ceteris/releases/download/v0.4.1/Ceteris-0.4.1-arm64.dmg) |
| macOS, Intel | [Ceteris-0.4.1-x64.dmg](https://github.com/Fanisting/ceteris/releases/download/v0.4.1/Ceteris-0.4.1-x64.dmg) |
| Linux (x64), any distribution | [Ceteris-0.4.1-x86_64.AppImage](https://github.com/Fanisting/ceteris/releases/download/v0.4.1/Ceteris-0.4.1-x86_64.AppImage) |
| Ubuntu or Debian (x64) | [Ceteris-0.4.1-amd64.deb](https://github.com/Fanisting/ceteris/releases/download/v0.4.1/Ceteris-0.4.1-amd64.deb) |

- **Windows**: run the installer, then launch Ceteris from the Start Menu or your desktop. The installer is not code signed yet, so SmartScreen may warn: choose **More info**, then **Run anyway**.
- **macOS**: open the `.dmg` and drag Ceteris into Applications. The app is not signed yet, so the first time, right-click it and choose **Open**.
- **Linux**: run `chmod +x Ceteris-0.4.1-x86_64.AppImage` and start it, or install the `.deb` with `sudo apt install ./Ceteris-0.4.1-amd64.deb`. See the [Linux install guide](docs/Linux安装指南-20260517.md).

Windows gets the most testing. The macOS and Linux builds are newer, so please [open an issue](https://github.com/Fanisting/ceteris/issues) if something breaks.

### First-Run

- A window opens. The sidebar is empty.
- Click the **+** next to "Folders" and pick a folder to add it
- Or drag a folder from File Explorer directly onto the sidebar (or onto the terminal area)
- Double-click a folder to open a terminal there
- Click `+` in the tab bar to start a Claude Code / Codex / shell session
- For remote work, add an SSH profile in Settings, bookmark a remote path such as `~/repo`, then connect normally or with tmux from the path view

### Try the Magic

To experience what makes Ceteris different:

1. Open 2-3 sessions in different paths
2. Close the window (the × button)
3. Look at your system tray: Ceteris is still running
4. Click the tray icon: a new window opens, and all sessions are still there

On macOS Ceteris stays in the Dock instead. On Linux it runs as a regular desktop app and asks before you close the last window while sessions are running.

That's it. That's the product.

## Preview PDFs that live on a server

Writing a LaTeX paper (or anything that produces a PDF) on a remote machine? Ceteris can show the PDF next to your terminal and keep it up to date.

1. Add the server as an SSH profile (Settings → Remote). Pick the same key you use for `ssh`.
2. Turn on the file tree and open a folder on the server.
3. If the server asks for a password, a Duo code or a host-key confirmation, Ceteris shows a dialog. Answer it once.
4. Click a `.pdf`. Whenever the file changes on the server, the preview refreshes by itself and stays on the same page and zoom.

Zoom with the buttons in the header or Ctrl + mouse wheel. Images and markdown files refresh the same way, and so do local files.

## Core Features

Every feature has its own page with what it does and where to find it: see the [features folder](features/README.md).

### V1 (current alpha)

- ✅ **Runs on Windows, macOS and Linux**: on macOS the app stays in the Dock when its windows close; on Linux it runs as a regular desktop app ([ADR-013](docs/软件定义书.md#adr-013))
- ✅ **Path management**: one folder list with renaming; any folder you open stays listed
- ✅ **Tags**: colour tags shown as dots on folders; filter the list by one or more tags
- ✅ **Remote paths**: SSH profiles, remote bookmarks, and sidebar labels that show profile + remote path context
- ✅ **Session lifecycle**: `active / idle / exited`; exited sessions stay visible until you close them manually (no time-based eviction, per ADR-008)
- ✅ **Launch templates**: built in (Shell, Claude Code, Codex, OpenCode, Gemini CLI, GitHub Copilot, Cursor, Aider, and Admin Shell on Windows) plus your own; your quick-launch picks sit in a dashed tab at the end of the tab bar, one click each
- ✅ **SSH tmux mode**: per-launch attach-or-create tmux flow, directory-derived tmux session names, and shell fallback after tmux exits
- ✅ **Multi-window**: any number of equal windows; close-to-tray; cross-window session visibility
- ✅ **Ceteris Link (remote attach)**: open the terminal tabs running on another Windows machine, live. Same sessions, same scrollback, same running agents; the sessions never leave the host. End-to-end encrypted (X25519 + AES-256-GCM) with a pre-shared token that never travels over the wire. See [docs/远程访问指南.md](docs/远程访问指南.md)
- ✅ **CWD tracking**: OSC 1337 hooks for PowerShell and cmd.exe
- ✅ **57 themes**: Light Pink (default), Ceteris Dark, Ceteris Light, Rose Pine (3 variants), Catppuccin (2), Tokyo Night (2), Dracula, One Dark Pro, Cutie, Light Pink, Fairyfloss, Business, Ubuntu, Windows Terminal, Meizi, 7 Pearl themes from colour palettes (Lapis, Sapphire, Rose Dew, Ember, Jade, Moonlight, Frost), and 6 from LaTeX Beamer templates (Metropolis, Metropolis Dark, Madrid, CambridgeUS, AnnArbor, Spruce), and 26 Legado MD3 themes, four of them generated live from a seed colour or the Windows accent colour. Drop your own `.css` files into the `themes` folder to add custom themes
- ✅ **Window style**: Windows or macOS (sets title-bar layout — not theme colors)
- ✅ **Settings**: live-applied, no save button; export/import config (with secrets-redaction option)
- ✅ **System tray**: persistent menu with running-sessions submenu; honest quit confirmation
- ✅ **Drop folder onto terminal area** to spawn a new session in that path
- ✅ **Multi-line paste guard** (confirm prompt prevents accidentally executing pasted scripts)
- ✅ **Terminal search** (Ctrl+F) with match count
- ✅ **File panel**: browse the current folder (local, or over SFTP for SSH sessions) and open PDFs, images and markdown beside the terminal; they refresh when the file changes
- ✅ **Edit txt, json, md and tex** in place, with unsaved drafts kept across reconnects; files over 2 MB open as fast read-only pages; markdown reads in the OnePage style; create new files from the file tree
- ✅ **See what agents are doing**: the tab wave changes with the agent's phase, short AI titles name each agent tab, and a small burst marks an agent that finished while you looked elsewhere
- ✅ **Running and Needs you filters** at the front of the tab bar, plus coordinator tabs that stay in view across folders and can manage the other tabs in their folder
- ✅ **Formulas as images**: LaTeX that Claude Code and Codex print shows as rendered formulas in the terminal
- ✅ **Update check**: Ceteris looks for a newer GitHub release and offers the right download for your system
- ✅ **Material Design 3 look** across windows, menus, dialogs and settings
- ✅ **Chinese and English UI**, following the system language by default
- ✅ **Persistent logs** in the app data folder (`%APPDATA%\Ceteris\logs\` on Windows)

### V1.1 (Planned)

- Status indicators for "waiting for input" / "error" via OSC 1337 command-completion events
- System notifications on session state changes
- Code signing

### V1.2 (Planned)

- Explorer right-click integration ("Open in Ceteris")
- Tab drag-and-drop reordering
- Tab tear-out to new window

### Later

- WSL session integration
- (Candidate) Daemon architecture: split the Electron main process into a background daemon and a UI viewer, so sessions survive UI crashes and updates on all three platforms. Not committed; it will be evaluated if losing sessions to crashes or upgrades becomes a frequent complaint.

## Architecture (TL;DR)

Ceteris is built on **Electron 31 + TypeScript + React 18 + node-pty + xterm.js**.

- The **main process** is the daemon: it owns all PTYs, all data, and the system tray
- Each **window is a renderer process** with its own React UI
- Windows are pure observers — closing them never affects sessions
- Communication is via Electron IPC with a strict typed protocol (`docs/ipc-protocol.md`)

For details:

- [Software Definition (软件定义书)](docs/软件定义书.md) — what Ceteris is and why
- [IPC Protocol](docs/ipc-protocol.md) — the contract between main and renderer
- [AGENTS.md](AGENTS.md) — for AI agents contributing to this codebase

## Building from Source

```bash
# Prerequisites: Node.js 20+ on Windows 10/11, macOS or Linux
git clone https://github.com/Fanisting/ceteris.git
cd ceteris
npm install
npm run dev      # development mode with hot reload
npm run build    # produces installer under release/
npm test         # runs the backend test suite
```

## Help Wanted

Ceteris is built and maintained by one person. **The architecture is cross-platform by design** (see [`src/main/platform/`](src/main/platform/) and the `PlatformAdapter.lifecycleModel` field), and Windows, macOS and Linux builds ship today. Contributions are welcome, especially:

### High Priority

- [ ] **macOS and Linux testing**: both builds are new and see far less daily use than Windows
- [ ] **WSL session integration**

### Medium Priority

- [ ] Fish / Nushell shell hooks
- [ ] Tab drag-and-drop
- [ ] More themes (17 ship today, but feel free)
- [ ] i18n beyond Chinese + English

### Low Priority

- [ ] Restore-on-launch for "important" sessions (user-marked)
- [ ] Performance benchmarks

If any of these speak to you, see `CONTRIBUTING.md` (TBD) for the platform abstraction philosophy and how to add new platforms without touching core code.

## Design Philosophy

If you want to understand why Ceteris makes the choices it does, the four principles are:

1. **Path is stable, Session is cheap, UI is temporary** — work flows by path, sessions come and go, windows are throwaway observers
2. **Don't make users type paths, make them click paths** — the `cd` command is a 1971 design that should be optional
3. **Minimize user decisions** — auto-categorize, auto-track, auto-resize; the user picks paths and templates, the rest is automatic
4. **Window and app are decoupled** — closing a window is free; the app lives in the tray until you explicitly quit it

Full reasoning in the [Software Definition (软件定义书)](docs/软件定义书.md), Section 2.

## What Ceteris is NOT

To save you time:

- ❌ **Not a terminal emulator replacement** — we use xterm.js like everyone else
- ❌ **Not a tmux competitor** — tmux is a TUI, Ceteris is a GUI; different audiences
- ❌ **Not a project management tool** — no kanban, no team features, no workspace concepts
- ❌ **Not a full SSH client suite** — Ceteris supports path-centric SSH sessions, but it is not trying to replace dedicated SSH managers with port forwarding, file transfer, or remote host administration workflows
- ❌ **Not a code editor**: txt and json files can be edited in place, but for code, open `code .` in a session
- ❌ **Not a "tile-everything" power-user tool** — if you love vim keybindings in your terminal manager, you'll find Ceteris's mouse-first approach annoying. That's a feature, not a bug.

## Roadmap

| Phase | What | When |
|-------|------|------|
| Phase 1 | V1: daily use on Windows, macOS and Linux | In progress |
| Phase 2 | Open-source release, polish | After V1 stable |
| Phase 3 | V1.x: status indicators, notifications, Explorer integration | Post-release |
| Phase 4 | V2.0: WSL integration, candidate daemon architecture | TBD |

This is a personal project built in spare time. There's no business behind it, no SLA, no committed timeline. If it solves your problem, great. If not, fork it.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

Ceteris stands on the shoulders of:

- [Electron](https://www.electronjs.org/) — the application framework
- [electron-vite + Vite](https://electron-vite.org/) — build tooling
- [xterm.js](https://xtermjs.org/) — the terminal renderer
- [node-pty](https://github.com/microsoft/node-pty) — PTY bindings (Microsoft)
- [React](https://react.dev/) — UI framework
- [Material Symbols](https://fonts.google.com/icons): UI icons (Apache 2.0)
- [OnePage](https://github.com/ivaneye/OnePage) by ivaneye, built on [Cupertino](https://github.com/aaaaalexis/Obsidian-Cupertino) by aaaaalexis: the look of rendered Markdown files, ported from these Obsidian themes (MIT; notice kept in `src/renderer/styles/markdown-onepage.css`)
- [Rose Pine](https://rosepinetheme.com/) — color palette inspiration
- [legado-with-MD3](https://github.com/HapeLee/legado-with-MD3): the Legado MD3 themes use its Material 3 colour schemes
- [PiliPlus](https://github.com/bggRGjQaUbCoE/PiliPlus): the Pili themes are generated from its theme colours and its default Material 3 colour algorithm
- [LXGW WenKai (霞鹜文楷)](https://github.com/lxgw/LxgwWenKai) — UI font

And inspiration from:

- [Wave Terminal](https://www.waveterm.dev/) — for showing that session persistence is possible in a polished GUI
- [tmux](https://github.com/tmux/tmux) — for proving sessions should outlive their UIs
- [iTerm2](https://iterm2.com/) — for OSC 1337, the unsung hero of cwd tracking

---

> Built because Windows Terminal had four years to ship close-to-tray and didn't.
