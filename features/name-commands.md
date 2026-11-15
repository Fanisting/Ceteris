# name: commands

Type a short name followed by a colon in Claude Code or Codex, and Ceteris turns it into a slash command. For example, `compact:` becomes `/compact`.

## Turning it on

Settings, Extensions, **name: commands**: tick Enable, then add or remove names in the list below. A name with an empty command becomes `/name`. A name can also point elsewhere, for example `plan` to `/oh-my-claudecode:plan`. Names ignore case.

## How it fires

Only a saved name at the start of a word, directly followed by a colon, is replaced, and only in a Claude Code or Codex tab. Ordinary text such as `note: ...` stays as typed. Ceteris never presses Enter for you, so you can still check the command or backspace it. Other terminals are not affected.

Related: [Software definition](../docs/软件定义书.md) (ADR-020).
