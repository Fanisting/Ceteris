@echo off
REM !!! KEEP THIS FILE PURE ASCII -- DO NOT add non-ASCII characters !!!
REM
REM cmd.exe reads .bat files using the system OEM code page (CP936 on a
REM Chinese-locale machine). Our UTF-8 multi-byte sequences get
REM mis-decoded into stray structural bytes that can break cmd parsing.
REM Same class of bug as pwsh.ps1 / ENC-1 (v0.1.0-beta.1 hotfix).
REM Regression guard: src/main/shipped-scripts-ascii.test.ts.
REM
REM Ceteris cmd.exe hook (formerly EasyTerm, renamed v1.5).
REM
REM cmd.exe has no prompt function, so we cannot wrap it the way we wrap
REM PowerShell's $prompt. Ceteris sets the PROMPT environment variable
REM directly via WindowsAdapter.buildShellLaunchParams to embed the
REM OSC 1337 sequence:
REM
REM   PROMPT=$E]1337;CurrentDir=$P$E\$P$G
REM
REM Where:
REM   $E = ESC (0x1b)
REM   $P = current path
REM   $G = '>' (greater-than)
REM   ESC \ = ST (string terminator, OSC sequence terminator)
REM
REM This file is kept only for documentation, cross-platform
REM PlatformAdapter interface completeness, and for a possible future
REM switch to a 'cmd /K hook.bat' approach.
REM
REM Corresponding docs: software-definition.md 5.1.8, 12.5; ADR-003, ADR-008

echo [Ceteris] cmd.exe hook is configured via PROMPT environment variable, not this batch file.
