# 生成开发期自签代码签名证书,并导入到本机信任存储。
#
# 一次性脚本:重复运行会生成新证书(旧的会留在 Cert:\CurrentUser\My 里,
# 不影响本流程,但建议手动 Get-ChildItem Cert:\CurrentUser\My | ? Subject -eq "CN=Ceteris Dev" 后 Remove-Item 清理)。
#
# 终态产物 (在 native\context-menu 根目录):
#   dev-cert.pfx  — SignTool 用,密码 "ceteris-dev"
#   dev-cert.cer  — 信任导入用
#
# 信任导入位置: Cert:\LocalMachine\TrustedPeople
# 这是 MSIX sideload 的 PE 代码签名的标准信任范围,比 Root CA 范围小得多。
# 需要管理员权限(脚本会用 Start-Process -Verb RunAs 弹 UAC)。
#
# 重要:Publisher 字段必须与 AppxManifest.xml 的 Identity Publisher 完全一致
# ("CN=Ceteris Dev"),否则 SignTool 签名后 Add-AppxPackage 会拒绝包。

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot | Split-Path -Parent
Set-Location $root

$subject = "CN=Ceteris Dev"

Write-Host "[1/4] Generating self-signed cert: $subject" -ForegroundColor Cyan
$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -CertStoreLocation Cert:\CurrentUser\My `
    -KeyUsage DigitalSignature `
    -FriendlyName "Ceteris Context Menu Dev Cert" `
    -NotAfter (Get-Date).AddYears(3) `
    -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")

Write-Host "    Thumbprint: $($cert.Thumbprint)"

$pfxPath = Join-Path $root "dev-cert.pfx"
$cerPath = Join-Path $root "dev-cert.cer"

Write-Host "[2/4] Exporting .pfx (with private key) for SignTool" -ForegroundColor Cyan
$pwd = ConvertTo-SecureString -String "ceteris-dev" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null
Write-Host "    -> $pfxPath"

Write-Host "[3/4] Exporting .cer (public only) for trust import" -ForegroundColor Cyan
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
Write-Host "    -> $cerPath"

Write-Host "[4/4] Importing .cer into Cert:\LocalMachine\TrustedPeople (requires elevation)" -ForegroundColor Cyan
Write-Host "      A UAC prompt will appear. Approve it."
$importCmd = "Import-Certificate -FilePath '$cerPath' -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null; Write-Host 'Imported successfully.' -ForegroundColor Green; Start-Sleep -Seconds 2"
$args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $importCmd)
Start-Process powershell -Verb RunAs -Wait -ArgumentList $args

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  .\scripts\build.ps1     # build + pack + sign the MSIX"
Write-Host "  .\scripts\install.ps1   # install MSIX and restart explorer"
