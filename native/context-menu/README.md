# Ceteris Context Menu (Win11 新右键菜单)

Rust 实现的 `IExplorerCommand` COM DLL,通过 Sparse Package 注册到 Win11 新版(圆角)右键菜单。
完整背景见 `docs/issues/win11-new-context-menu.md`。

## 状态

**最小可运行版本** — 仅限本机开发自测,未集成进 `npm run build`。生产证书 + NSIS 集成留给后续里程碑。

## 前提

- Rust msvc toolchain (`x86_64-pc-windows-msvc`)
- Windows 11 SDK 10.0.22621.0+ 装在 `C:\Program Files (x86)\Windows Kits\10\`(含 MakeAppx + SignTool)
- Win11 22H2+

## 一次性准备

```powershell
cd native\context-menu
.\scripts\dev-cert.ps1
```

会生成自签证书,导出 `dev-cert.pfx` / `dev-cert.cer`,然后弹 UAC 把 `.cer` 导入 `LocalMachine\TrustedPeople`。**点是,不然 MSIX 装不上。**

## 构建 + 安装

```powershell
.\scripts\build.ps1    # cargo build → MakeAppx pack → SignTool sign → build\CeterisContextMenu.msix
.\scripts\install.ps1  # Add-AppxPackage + 重启 explorer
```

## 让 DLL 找到 Ceteris.exe

DLL 在 Invoke 时按以下顺序找 Ceteris 可执行文件:

1. 环境变量 `MARINA_EXE`(开发期推荐)
2. 注册表 `HKCU\Software\Ceteris\InstallLocation` + `\Ceteris.exe`(生产期 NSIS 写)

开发期最快路径:

```powershell
[Environment]::SetEnvironmentVariable('MARINA_EXE', 'E:\projects\terminal\out\main\...\Ceteris.exe', 'User')
```

注意环境变量改完后 explorer / dllhost 要重启才能读到新值。

## 验证

```powershell
# 重启 explorer 让菜单缓存失效
Stop-Process -Name explorer -Force

# 右键任意文件夹 → 在新菜单(圆角那个,不是「显示更多选项」)里看到「在 Ceteris 终端中打开」
```

## 卸载

```powershell
Get-AppxPackage Ceteris.ContextMenu | Remove-AppxPackage
Stop-Process -Name explorer -Force
```

## 故障排查

新菜单不显示时按这个顺序查:

1. `Get-AppxPackage Ceteris.ContextMenu` — 确认已安装
2. `Get-AppPackageLog -ActivityID <id>` 或 Event Viewer → Applications and Services Logs → Microsoft → Windows → AppXDeployment-Server / Operational
3. `procmon.exe`(SysInternals)过滤 `dllhost.exe` 看是否尝试加载 DLL
4. 检查 manifest 里的 CLSID 与 `src/guid.rs` 是否完全一致(大小写无关但字符必须 match)
5. 确认 `dev-cert.cer` 已导入 `Cert:\LocalMachine\TrustedPeople`(签名链断裂会被 Explorer 静默拒绝)

## 已知限制(留给后续里程碑)

- 不集成进 `npm run build`/electron-builder/NSIS — 完整版规划见备忘录 M3
- 不做跨 Win11 版本测试(22H2 / 23H2 / 24H2)— 完整版 M4
- panic 防护是基础版本,未做穷举 fuzz — 完整版 M4
- 自签证书,SmartScreen 仍会拦 Ceteris 主程序 — 完整版需要 OV/EV 商业证书
- ARM64 不支持

## 文件布局

```
Cargo.toml              cdylib 输出 marina_context_menu.dll
src/
  lib.rs                DllMain + DllGetClassObject + DllCanUnloadNow
  guid.rs               固定 CLSID
  factory.rs            IClassFactory
  command.rs            IExplorerCommand + Invoke 拉起 Ceteris
package/
  AppxManifest.xml      Sparse Package 清单
  assets/*.png          占位图标
scripts/
  dev-cert.ps1          自签证书生成 + 信任(一次性)
  build.ps1             cargo build → MSIX
  install.ps1           Add-AppxPackage --ExternalLocation + 重启 explorer
build/
  staging/              MakeAppx 输入目录(被 .gitignore)
  *.msix                输出包(被 .gitignore)
```
