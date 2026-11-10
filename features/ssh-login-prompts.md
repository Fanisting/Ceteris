# SSH login prompts

Some servers ask for a password, a Duo code or a host key confirmation. Ceteris shows a dialog for each prompt so you can answer it, and the file tree opens afterwards.

The dialog only appears when you act: you switch to the server, press retry or click a file. Background checks never interrupt you. They stop quietly and the tree shows "Sign-in needed".

A connection you have answered once is kept open while idle, so you do not get a second Duo push.

Related: [ADR-017](../docs/软件定义书.md) and [Remote file tree](remote-file-tree.md).
