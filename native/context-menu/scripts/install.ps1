# 安装 MSIX + 重启 Explorer 让新菜单缓存失效。
#
# TIT-3: 不再用 sparse package + -ExternalLocation 模式。AppxManifest.xml
# 已经删掉 AllowExternalContent 声明, MSIX 自包含 DLL/exe/assets, 走标准
# Add-AppxPackage 路径, 装到 C:\Program Files\WindowsApps\...
#
# 重启 explorer 是因为 Explorer 启动时缓存 AppX manifest 解析结果,
# 不重启的话 manifest 变更要等下次开机才生效。

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot | Split-Path -Parent

$msix = Join-Path $root 'build\CeterisContextMenu.msix'

if (-not (Test-Path $msix)) {
    throw "MSIX missing at $msix. Run .\scripts\build.ps1 first."
}

Write-Host "[1/3] Uninstalling old version (if any)" -ForegroundColor Cyan
$existing = Get-AppxPackage -Name 'Ceteris.ContextMenu' -ErrorAction SilentlyContinue
if ($existing) {
    $existing | Remove-AppxPackage
    Write-Host "    Removed: $($existing.PackageFullName)"
} else {
    Write-Host "    None present."
}

Write-Host "[2/3] Add-AppxPackage" -ForegroundColor Cyan
Add-AppxPackage -Path $msix -ForceApplicationShutdown
$pkg = Get-AppxPackage -Name 'Ceteris.ContextMenu'
if (-not $pkg) {
    throw "Package not registered after Add-AppxPackage"
}
Write-Host "    Installed: $($pkg.PackageFullName)"
Write-Host "    InstallLocation: $($pkg.InstallLocation)"

Write-Host "[3/3] Restarting Explorer to flush context-menu cache" -ForegroundColor Cyan
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
# explorer.exe auto-restarts via Windows shell. If not, start it manually:
if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) {
    Start-Process explorer
}

Write-Host ""
Write-Host "Done. Right-click any folder in Explorer." -ForegroundColor Green
Write-Host "Expect '在 Ceteris 终端中打开' in the MODERN (rounded) menu — not in 'Show more options'."
Write-Host ""
Write-Host "If menu does NOT appear:" -ForegroundColor Yellow
Write-Host "  1. Get-AppxPackage Ceteris.ContextMenu          # confirm installed"
Write-Host "  2. Event Viewer -> AppXDeployment-Server log   # check deploy errors"
Write-Host "  3. Check `$env:CETERIS_EXE` is set (needed for Invoke to find Ceteris.exe)"
