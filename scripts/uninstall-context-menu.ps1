# !!! KEEP THIS FILE PURE ASCII -- DO NOT add non-ASCII characters !!!
# See src/shell-hooks/pwsh.ps1 header for the full rationale (ENC-1).
# Regression guard: src/main/shipped-scripts-ascii.test.ts.
#
# ---------------------------------------------------------------------------
# scripts/uninstall-context-menu.ps1
#
# Uninstall the Ceteris Win11 right-click menu. Removes the MSIX package
# only; the cert is kept (avoids a UAC prompt on next install).
#
# Triggered by Settings -> "Win11 new menu -> Disable" and by the Ceteris
# uninstaller (installer.nsh calls powershell + Get-AppxPackage|Remove).
#
# Package-not-installed is treated as success (idempotent). Failures go
# to stderr with non-zero exit.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$pkg = Get-AppxPackage -Name 'Ceteris.ContextMenu' -ErrorAction SilentlyContinue
if ($null -eq $pkg) {
    Write-Output "Ceteris.ContextMenu is not installed, skipping."
    exit 0
}

Write-Output "Removing $($pkg.Name) $($pkg.Version)"
try {
    Remove-AppxPackage -Package $pkg.PackageFullName -ErrorAction Stop
    Write-Output "Done."
    exit 0
} catch {
    Write-Error "Remove-AppxPackage failed: $($_.Exception.Message)"
    exit 4
}
