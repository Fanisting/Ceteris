# Ceteris fish hook (BETA-003a)
#
# 通过 XDG_CONFIG_HOME 指向临时目录加载;先 source 用户原 fish 配置,
# 再注册 fish_prompt 事件回调发送 OSC 1337 cwd。
#
# 对应文档: 软件定义书.md 12.5 + ADR-013

# 加载用户原 fish 配置(用户的 XDG_CONFIG_HOME 还原,只为读那一份)
set -l __ceteris_user_xdg "$HOME/.config"
if test -n "$XDG_CONFIG_HOME"
    # 我们已经把 XDG_CONFIG_HOME 改成临时目录;用户原值通过 Ceteris 注入的
    # CETERIS_ORIG_XDG_CONFIG_HOME 保留(若未注入则用 $HOME/.config 兜底)
    if test -n "$CETERIS_ORIG_XDG_CONFIG_HOME"
        set __ceteris_user_xdg "$CETERIS_ORIG_XDG_CONFIG_HOME"
    end
end
if test -f "$__ceteris_user_xdg/fish/config.fish"
    source "$__ceteris_user_xdg/fish/config.fish"
end

# 注入 OSC 1337 cwd hook
function __ceteris_emit_cwd --on-event fish_prompt
    printf '\033]1337;CurrentDir=%s\007' (pwd)
end
