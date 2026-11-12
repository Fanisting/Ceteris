# Open file tool

Your own Claude Code or Codex can show you a file in Ceteris. Ask it to write the answer as a Markdown file and open it in Ceteris. The file appears beside your tab in the file viewer, as if you had clicked it in the tree.

It works from any tab. It needs no Coordinator role and no extension switch. Claude Code needs the ceteris-tabs plugin, which Settings under Extensions shows how to install and update. For Codex, Ceteris adds the ceteris-tabs server to Codex's config.toml from the same place, or from the [extension setup card](extension-setup.md).

A tab of the same folder can be named as the target. The tool opens Markdown, text, JSON, LaTeX, PDF and image files. Folders on SSH servers are not supported yet.

Related: [ADR-033](../docs/软件定义书.md), [File viewer](file-viewer.md) and [Tab control plugin](tab-control-plugin.md).
