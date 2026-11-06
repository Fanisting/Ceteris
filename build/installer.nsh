; Ceteris NSIS 安装器自定义脚本
;
; electron-builder 提供 5 个 hook macro:
;   customHeader / preInit / customInit / customInstall / customUnInstall
;
; customInstall — 写 HKCU\Software\Ceteris\InstallLocation。
;   Win11 新菜单 DLL(native/context-menu)启动 Ceteris.exe 前会按此键值
;   定位 exe;不写就只能依赖 CETERIS_EXE 环境变量(开发期用)。生产期必写,
;   否则用户启用新菜单后点击"在 Ceteris 终端中打开"会无反应(DLL panic 兜底)。
;
; customUnInstall — 清掉:
;   1. Explorer 右键经典集成的 HKCU 注册表项(旧 install 的 command 指向已删 exe
;      会让 Explorer 弹 "Error launching app: unable to find electron app at ...")
;   2. customInstall 写入的 InstallLocation
;   3. MSIX 右键集成包(若用户启用过)
;
; HKCU\Software\Classes\Directory\shell\Ceteris             (含 command 子 key)
; HKCU\Software\Classes\Directory\Background\shell\Ceteris  (含 command 子 key)
;
; DeleteRegKey /ifempty 会递归删除子 key。

!macro customInstall
  ; Win11 新菜单 DLL 通过此键定位 Ceteris.exe(详见 native/context-menu/src/command.rs)。
  WriteRegStr HKCU "Software\Ceteris" "InstallLocation" "$INSTDIR"
!macroend

!macro customUnInstall
  ; 经典右键菜单 HKCU 项
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Ceteris"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Ceteris"
  ; v1.5 改名前的 EasyTerm 残留兜底
  DeleteRegKey HKCU "Software\Classes\Directory\shell\EasyTerm"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\EasyTerm"
  ; 清掉 customInstall 写入的 InstallLocation
  DeleteRegValue HKCU "Software\Ceteris" "InstallLocation"
  DeleteRegKey /ifempty HKCU "Software\Ceteris"
  ; Win11 新菜单 MSIX 包(用户可能没启用过,Get-AppxPackage 不存在直接跳过;
  ;   证书保留不动,下次安装免 UAC)。-NonInteractive 防 PS 弹任何交互;
  ;   -WindowStyle Hidden 抑制 conhost 窗口闪烁;不阻塞卸载 — 失败也只是
  ;   残留,reg 项已经清完了。
  ExecWait 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Get-AppxPackage -Name Ceteris.ContextMenu -ErrorAction SilentlyContinue | Remove-AppxPackage -ErrorAction SilentlyContinue"'
!macroend
