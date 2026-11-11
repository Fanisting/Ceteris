# Code and data files

R, Python, Julia, Stata, SQL and HiveQL scripts open next to the terminal, coloured by language, and you can edit and save them there. After each save, Ceteris checks Python, R and SQL files with the linter you already have installed and lists what it finds.

## What opens

Click any of these in the file tree:

- Analysis code: .py, .R, .Rmd, .qmd, .jl, .do and .ado (Stata), .m (MATLAB), .mod (Dynare), .sas, .gms (GAMS), .f and .f90 (Fortran), .cpp
- Queries: .sql and .hive
- Configuration and scripts: .yaml, .yml, .toml, .ini, .cfg, .sh, .ps1, .bib
- Data and logs as text: .csv, .tsv, .log

Code shows line numbers and keeps long lines on one line, so columns stay in line. Colours follow your theme. Files over 2 MB open as read-only pages, as before.

## Lint after save

| Files | Tool | How Ceteris finds it |
|---|---|---|
| .py | ruff | ruff on PATH, or `uvx ruff` when uv is installed |
| .R, .Rmd, .qmd | lintr | Rscript on PATH, or where the R installer put it; needs the lintr package |
| .sql, .hive | sqlfluff | sqlfluff on PATH, or `uvx sqlfluff`; .hive uses the Hive dialect unless your sqlfluff config names one |

Problems get a wavy underline; hover one to read it. A panel under the editor lists them all by line. Click a row to jump there, or Hide to fold the panel. Your project's own config (pyproject.toml, .lintr, .sqlfluff) applies, because the tool itself runs.

If the tool is missing, the panel shows one line with the command that installs it. Ceteris never installs anything itself. Julia, Stata and MATLAB files get colours only, since they have no common command-line linter.

Lint never changes your file, and it does not run while you type, only after Save.

Related: [ADR-040](../docs/软件定义书.md), [Text file editing](text-file-editing.md).
