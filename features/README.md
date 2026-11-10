# Ceteris features

One page per user-facing feature. Each page says what the feature does, where to find it, and which settings control it.

The Version column shows the first release that contains the feature. "Next" means it is merged but not yet released. Add a row here, and a page next to this file, in the same pull request as every new feature.

## Terminal

| Feature | Summary | Version |
|---|---|---|
| [Terminal tabs and windows](terminal-tabs-and-windows.md) | Tabs grouped by folder, equal windows, terminals that outlive their windows | 0.1.0 |
| [Reopen tabs at launch](reopen-tabs-at-launch.md) | Tabs and agent conversations come back after a quit, update or crash | Next |
| [Launch templates](launch-templates.md) | Start Shell, Claude Code, Codex and more, or your own command | 0.1.0 |
| [Terminal search and paste guard](terminal-search-and-paste-guard.md) | Ctrl+F search, multi-line paste confirmation, folder drop | 0.1.0 |
| [Ghost tab quick launch](ghost-tab-quick-launch.md) | A dashed tab with one-click agent icons | 0.4.1 |
| [One folder list with tags](folder-list-and-tags.md) | A single folder list with coloured tag filters | 0.3.0 |
| [Folder blocks](folder-blocks.md) | Show sidebar folders as pebbles with status dots | 0.4.1 |
| [Status filters](status-filters.md) | Running and Needs you filters across all folders | 0.4.1 |
| [Settings export and import](settings-export-import.md) | Move your settings between machines | 0.1.0 |

## Files

| Feature | Summary | Version |
|---|---|---|
| [File viewer](file-viewer.md) | PDFs, images and Markdown beside the terminal | 0.3.0 |
| [Live PDF preview](live-pdf-preview.md) | PDFs refresh when rebuilt, keeping page and zoom | 0.4.1 |
| [Text file editing](text-file-editing.md) | Edit txt, json, md, tex, sql and hive in place | 0.3.0 |
| [Large text files](large-text-files.md) | Multi-gigabyte files open at once as read-only pages | 0.3.0 |
| [OnePage Markdown look](onepage-markdown.md) | A paper-like reading style for Markdown | 0.4.1 |
| [New file in the file tree](file-tree-new-file.md) | Create an empty file from the tree | 0.4.1 |
| [Pinned folders in the file tree](file-tree-pins.md) | Pin folders as small blocks atop the tree | 0.4.1 |
| [Open in File Explorer](file-tree-open-in-explorer.md) | Open a local folder from the file tree in the system file manager | Next |
| [Formula images for Claude Code](formula-images-claude-code.md) | Typeset formulas in Claude Code replies | 0.4.1 |
| [Formula rendering for Codex](formula-rendering-codex.md) | Typeset formulas in Codex output | 0.4.1 |

## Remote

| Feature | Summary | Version |
|---|---|---|
| [SSH profiles and remote folders](ssh-remote-folders.md) | Saved servers and remote folders in the sidebar | 0.2.0 |
| [SSH with tmux](ssh-tmux.md) | Attach or create a tmux session on launch | 0.1.0 |
| [Remote file tree](remote-file-tree.md) | Browse server folders read-only over SFTP | 0.3.0 |
| [SSH login prompts](ssh-login-prompts.md) | Answer password, Duo and host key prompts in a dialog | 0.4.1 |
| [Ceteris Link](ceteris-link.md) | Open the live terminal tabs of another computer | 0.3.0 |

## Agents

| Feature | Summary | Version |
|---|---|---|
| [Agent state animations](agent-state-animations.md) | Tab waves that show what the agent is doing | 0.4.1 |
| [Celebrations](celebrations.md) | A small burst when an agent finishes, and an optional title bar pebble | 0.4.1 |
| [Next prompt suggestions](next-prompt-suggestions.md) | A suggested next message that learns your habits | 0.3.0 |
| [Agent tab titles](agent-tab-titles.md) | Short, readable titles, optionally written by a model | 0.4.1 |
| [Coordinator, worker and fintuner roles](coordinator-and-worker-roles.md) | Give tabs a role and a row above the tab bar | 0.4.1 |
| [Coordinator tour](coordinator-tour.md) | An animated guide to roles and tab control | 0.4.1 |
| [Tab control plugin](tab-control-plugin.md) | A Coordinator opens, reads and drives other tabs | 0.4.1 |
| [Open file tool](open-file-tool.md) | Your agent shows you a file beside its tab | Next |

## Appearance

| Feature | Summary | Version |
|---|---|---|
| [Built-in themes](built-in-themes.md) | More than 90 themes, including pearl and Beamer | 0.4.1 |
| [Legado MD3 themes](legado-themes.md) | Material 3 colour sets plus live seed and Windows accent themes | 0.4.1 |
| [Pili themes](pili-themes.md) | 38 Material 3 themes from PiliPlus seed colours | Next |
| [Custom themes](custom-themes.md) | A theme is one CSS file in the themes folder | 0.4.1 |
| [Material Design 3 look](material-design-look.md) | Material shapes and motion across the app | 0.3.0 |

## Setup

| Feature | Summary | Version |
|---|---|---|
| [Windows, macOS and Linux](platforms.md) | One app on three systems | 0.1.0 |
| [Update checks](update-checks.md) | A dot and a download link when a new version exists | 0.4.1 |
| [Agent updates](agent-updates.md) | Notices and updates for the agents you use | 0.4.1 |
| [Full reload on agent update](agent-full-reload.md) | Close an agent's tabs, update it, reopen them with their conversations | Next |
| [Stable, beta and dev channels](release-channels.md) | Run several builds side by side | 0.3.0 |
