#!/bin/sh
# BETA-003d · Debian/Ubuntu postinst —— 把 ceteris 注册为 x-terminal-emulator
# 候选,优先级 50(高于 gnome-terminal 默认的 40,低于已显式 set 的项)。
#
# 用户在 Ceteris 设置 → "设为默认终端" 调 LinuxAdapter.registerFileManagerIntegration
# 会跑 `update-alternatives --set ...`,把 ceteris 锁定为活跃项;不点也无害,
# 用户可手动 `sudo update-alternatives --config x-terminal-emulator` 切换。
set -e

# /usr/bin/ceteris 符号链接 —— 让 `ceteris` 命令在 shell 可用,ceteris.desktop 的
# Exec=ceteris --working-directory=%f 才能定位
ln -sf /opt/Ceteris/ceteris /usr/bin/ceteris

if [ -x /usr/bin/update-alternatives ]; then
    update-alternatives --install /usr/bin/x-terminal-emulator x-terminal-emulator /usr/bin/ceteris 50
fi

# 刷新 desktop database,让文件管理器立刻识别 ceteris.desktop
if [ -x /usr/bin/update-desktop-database ]; then
    update-desktop-database -q /usr/share/applications || true
fi

exit 0
