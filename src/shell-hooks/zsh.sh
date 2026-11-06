#!/usr/bin/env zsh
# Ceteris zsh hook。macOS 把它复制成临时目录里的 .zshrc,并把 ZDOTDIR 指向那里。
#
# 关键设计:
# - 通过 precmd_functions 在每次 prompt 前打印 OSC 1337
# - 加载用户原 .zshrc

# ZDOTDIR pointed zsh here, so it skipped the user's .zshenv and must now point back.
export ZDOTDIR="${CETERIS_USER_ZDOTDIR:-$HOME}"
unset CETERIS_USER_ZDOTDIR
if [[ -f "$ZDOTDIR/.zshenv" ]]; then
    source "$ZDOTDIR/.zshenv"
fi

# 加载用户原 .zshrc
if [[ -f "$ZDOTDIR/.zshrc" ]]; then
    source "$ZDOTDIR/.zshrc"
fi

# 注入 OSC 1337 cwd hook
__ceteris_emit_cwd() {
    printf '\033]1337;CurrentDir=%s\007' "$PWD"
}
typeset -ag precmd_functions
if (( ! ${precmd_functions[(I)__ceteris_emit_cwd]} )); then
    precmd_functions+=(__ceteris_emit_cwd)
fi
