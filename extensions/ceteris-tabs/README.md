# ceteris-tabs

A Claude Code plugin that ships with [Ceteris](https://github.com/Fanisting/ceteris). It lets Claude Code in any Ceteris tab show a file it wrote next to that tab, and lets Claude Code in a coordinator tab manage the other tabs of the same folder.

## What it does

Claude Code gets nine tools:

| Tool             | Does                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_tabs`      | Lists the folder's tabs with state and agent phase (working, blocked, done)                                                                                                             |
| `list_templates` | Lists the launch templates, for example `shell`, `claude-code`, `codex`                                                                                                                 |
| `open_tab`       | Opens a tab in the background; with `prompt`, waits until the agent is ready and sends it                                                                                               |
| `send_input`     | Types text, presses named keys (`escape`, `down`, `enter`, `ctrl-c`, ...), then Enter                                                                                                   |
| `read_tab`       | Returns the last lines of a tab's screen                                                                                                                                                |
| `wait_for_tab`   | Waits until an agent is done or blocked, a shell goes quiet, or the tab exits                                                                                                           |
| `rename_tab`     | Renames a tab                                                                                                                                                                           |
| `close_tab`      | Closes a tab and ends its process                                                                                                                                                       |
| `open_file`      | Shows a file in the Ceteris viewer beside a tab (its own by default): Markdown as a rendered page, `.txt` / `.json` / `.tex` as text, PDFs and images as themselves. Works from any tab |

It also has one hook. On every session start it tells Ceteris the Claude Code session id, so a tab that Ceteris puts in its shelf (Settings, Behavior, Shelve idle tabs, or right-click a tab) comes back with `claude --resume` and the conversation continues. Without the plugin Ceteris looks for the newest transcript of the tab's folder in `~/.claude/projects` instead, which is right most of the time but cannot tell two Claude Code tabs of the same folder apart when both were quiet.

## Who may use it

`open_file` works from every Ceteris tab, with no setting to turn on. Tell Claude Code "display your answer in md and open it as a tab in Ceteris": it writes the file and the rendered page appears beside the terminal. You can switch it to the editor like any file from the file tree.

The tab tools work only from a tab you marked as coordinator (right-click the tab, tick Coordinator), and only while Settings, Extensions, Coordinator tab control is on. Ceteris checks this on every call, so unmarking the tab cuts it off at once. A coordinator sees only the tabs of its own folder and cannot close or type into itself.

## Install

Ceteris shows both commands in Settings, Extensions, and can type them into a new terminal for you:

```
claude plugin marketplace add "<Ceteris install folder>\resources\extensions"
claude plugin install ceteris-tabs@ceteris
```

Then start Claude Code in the coordinator tab.

## How it works

Ceteris listens on a private named pipe and gives every tab the pipe name and its own token in `CETERIS_CONTROL_PIPE` and `CETERIS_CONTROL_TOKEN`. The MCP server in `server/` forwards each tool call over that pipe. It has no dependencies and runs on Ceteris's own executable (`CETERIS_CONTROL_NODE` with `ELECTRON_RUN_AS_NODE=1`), so no separate Node.js is needed. Outside Ceteris it offers no tools.

The SessionStart hook in `hooks/` sends one `agent-session` request over the same pipe with the session id Claude Code hands it on stdin. It runs on the same executable, exits at once outside Ceteris, and never writes to stdout, so it adds nothing to Claude's context.

The wire format is documented in the Ceteris repository, `docs/ipc-protocol.md`, appendix D.
