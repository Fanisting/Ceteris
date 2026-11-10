# Remote file tree

A tab connected to an SSH server gets the same file tree as a local tab. You browse the server's folders and open files beside the terminal.

The tree is read-only. Ceteris reads the server over SFTP and needs no extra software on the server. It signs in the same way your terminal does, through your ssh config, keys or agent.

PDFs, images and Markdown files on the server open in the viewer. PDFs refresh when the server file changes, see [Live PDF preview](live-pdf-preview.md).

Related: [SSH login prompts](ssh-login-prompts.md) and [ADR-017](../docs/软件定义书.md).
