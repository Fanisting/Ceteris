# File viewer beside the terminal

Ceteris can show a file next to your terminal, so you do not have to switch apps. It opens PDFs, images, Markdown, text, JSON and LaTeX files.

Turn on the file panel, then click a file in the tree. With one terminal open, the file appears on the left and the terminal stays on the right. Images and Markdown are read-only. Text, JSON, Markdown and LaTeX can be edited, see [Text file editing](text-file-editing.md).

PDFs, images and Markdown refresh by themselves when the file changes. This suits a LaTeX workflow where you change a line and compile again. See [Live PDF preview](live-pdf-preview.md).

Click the file name at the top of the viewer to copy the name. For text, code and Markdown files, the copy button right after the name copies the whole contents, including edits you have not saved yet. Files too large to edit are not copied.

The same viewer works for local folders and, read-only, for folders on SSH servers.

Related: [ADR-016](../docs/软件定义书.md) and [ADR-017](../docs/软件定义书.md).
