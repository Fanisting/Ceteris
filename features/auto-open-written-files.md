# Auto open written files

When Claude Code writes or edits a file, the file opens beside its tab in the file viewer. You do not have to ask for it. Code, Markdown, text and data files open in the editor or as a rendered page, just like a click in the file tree.

PDFs open too. When Claude Code builds a document with latexmk, pdflatex, xelatex, lualatex, tectonic, typst, pandoc or quarto, the finished PDF appears beside the tab. Later builds refresh it in place through the [live PDF preview](live-pdf-preview.md).

The agent's own bookkeeping stays hidden: its memory, its plans, scratch files in the temp folder, and anything inside `.git` or `.omc`.

This needs version 0.4.0 of the ceteris-tabs plugin. Update it with `claude plugin update ceteris-tabs@ceteris`, or from Settings under Extensions. To stop it, disable the ceteris-tabs plugin in Claude Code's `/plugin` menu.

Codex has no such hook. It opens the files it writes by calling the [open file tool](open-file-tool.md) itself. Folders on SSH servers are not supported yet.

Related: [ADR-058](../docs/软件定义书.md), [Open file tool](open-file-tool.md), [Code files](code-files.md) and [File viewer](file-viewer.md).
