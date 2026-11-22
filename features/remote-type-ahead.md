# Type ahead on remote agent tabs

On a [Ceteris Link](ceteris-link.md) window, what you type into a Claude Code or Codex tab stays on your computer until you press Enter. Typing never waits on the network or on a busy agent.

The text appears where the agent's input cursor is, with a small "sends on Enter" mark after it. Enter sends the whole text to the host in one message, then presses Enter there.

While you type:

- Shift+Enter adds a line.
- Backspace, Ctrl+U and Ctrl+W edit your text; Ctrl+C clears it.
- Paste, dropped files and the next prompt suggestion join your text in order.
- A paste of more than 3 lines goes to the agent at once as one block, after anything you typed before it. The agent shows it folded, as "[Pasted text #1 +N lines]", and you go on typing your question. A small "Sending N lines" pill with a loading animation sits in the corner until the agent has drawn the paste.
- `/`, `!` or `#` at the start, or `@` anywhere, opens the agent's own menu, so the rest of that message goes key by key as before.
- Arrow keys, Tab and Home or End first send your text, then act in the agent.
- Esc reaches the agent at once and your text stays. Press Esc twice to clear your text.
- When the agent asks for approval or shows a choice, keys go to it at once. Your text waits, hidden, and comes back when the input box does.

If the link drops before you press Enter, your text is still there after the reconnect. If a send fails, the text comes back and a message says so.

This also works with Claude Code's fullscreen mode (`"tui": "fullscreen"`) and when the footer shows no shortcut hint: Ceteris recognises the input box itself.

Selecting text in a Link window happens on your computer. A plain drag selects at once, even when the agent tracks the mouse; copy with Ctrl+C, the right-click menu or the copy on select setting. The wheel still scrolls the agent. Hold Alt to click or drag inside the agent as before.

Shell tabs (including a tab where the agent has exited), full-screen programs such as vim, and tabs on your own computer send each key as before.

Related: [Ceteris Link](ceteris-link.md), [`name:` commands](name-commands.md). Design: ADR-047 in the [software definition](../docs/软件定义书.md).
