# Ceteris

> 你的终端会话不应该因为关掉窗口就死掉。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/Fanisting/ceteris/releases)
[![状态](https://img.shields.io/badge/状态-Alpha-orange)](#路线图)
[![English](https://img.shields.io/badge/English-README.md-blue)](README.md)

一个**以路径为中心、对 AI agent 友好**的 Windows 终端管理器。为同时运行多个长时间任务(包括 Claude Code、Codex、OpenCode 等 AI 编码助手)、需要在多个工作目录之间频繁切换、又不愿意因为关错窗口前功尽弃的开发者打造。

> **Fork 说明**:Ceteris 是 Liyue-Cheng 的 [Marina](https://github.com/Liyue-Cheng/marina) 的 fork,Marina 的前身是 EasyTerm。

---

## 痛点

如果你曾经:

- 🤖 同时跑了 5 个 AI agent 在 5 个项目里干活,**忘记了哪一个还在等你确认**
- 💀 不小心关错了窗口,**杀掉了一个跑了 2 小时的构建 / 一个长时间 pytest / 一个干到一半的 agent**
- 🌀 第三次手敲 `cd D:\projects\company\some\deeply\nested\path` 还打错了
- 📑 试图用 Windows Terminal 的 profile 来组织工作流,最后放弃了

...Ceteris 是为你做的。

## 解决方案

Ceteris 重新思考了"终端会话应该怎么管理"这个问题:

- **🔒 会话独立于 UI 存活** —— 关掉所有窗口,session 仍在守护进程里跑;打开任意窗口又能看到它们
- **📍 路径是一等公民** —— 收藏工作目录,session 按"在哪干活"组织,而不是按"用了哪个 profile 启动"
- **🖱️ 鼠标优先** —— 不需要记快捷键,不需要敲 `cd`,所有操作就是在侧栏点路径
- **🪟 所有窗口完全平等** —— 没有"主窗口"概念。开任意多个,关任意一个,应用照常运行

## 截图

> 第一个稳定版会附正式截图。下面是布局示意(实际侧栏图标用 Material Symbols,这里仅 ASCII 占位)。

```
┌────────────────────────────────────────────────────────────────────┐
│ Ceteris — Window 1                                    [_] [□] [×]  │
├──────────────────────┬─────────────────────────────────────────────┤
│ [收藏] [临时] [最近] │  ┌─[claude] [shell] [pytest] [codex灰]┐    │
│                      │  └────────────────────────────────────┘   │
│ ▼ ⌘ ~/projects/auth  │   ┌──────────────────────────────────────┐  │
│   ├─ ● claude code   │   │ $ claude                             │  │
│   ├─ ◐ shell         │   │ ✻ Welcome to Claude Code             │  │
│   └─ ○ pytest        │   │                                      │  │
│ ▼ ⌘ ~/projects/web   │   │ How can I help you today?            │  │
│   └─ ● codex         │   │ █                                    │  │
│ ▶ ⌘ ~/scripts        │   │                                      │  │
│                      │   │                                      │  │
│ ───── 临时 ─────     │   │                                      │  │
│ ▼ ⌚ ~/Downloads     │   │                                      │  │
│   └─ ○ shell         │   │                                      │  │
│                      │   │                                      │  │
│ ───── 最近 ─────     │   │                                      │  │
│ • ~/test123          │   │                                      │  │
│ • D:\old\project     │   └──────────────────────────────────────┘  │
│                      │                                             │
│ [⚙] 设置             │                                             │
└──────────────────────┴─────────────────────────────────────────────┘
```

Ceteris 支持两套窗口风格 — **Windows**(控制按钮在右,方形)与 **macOS**(三色 traffic light 在左,圆形) — 在"设置 → 外观"切换。

## 为什么不用 [其它]?

| 特性 | Windows Terminal | Tabby | Wave | Warp | **Ceteris** |
|---------|:---:|:---:|:---:|:---:|:---:|
| 关窗不杀 session | ❌ | ❌ | ✅ | ❌ | ✅ |
| 路径中心组织 | ❌ | ❌ | ❌ | ❌ | ✅ |
| CWD 跟踪(漂移 ⚠ 提示) | ❌ | ❌ | ✅ | ✅ | ✅ |
| 多窗口共享 session 池 | ❌ | ❌ | ❌ | ❌ | ✅ |
| 关闭窗口不影响 session | ❌ | ❌ | ✅ | ❌ | ✅ |
| 为 AI agent 工作流设计 | ❌ | ❌ | ❌ | ❌ | ✅ |
| Windows 原生优先 | ✅ | ✅ | ❌ | ❌ | ✅ |
| 鼠标优先(不强制快捷键) | ❌ | ❌ | ❌ | ❌ | ✅ |

## 给 AI agent 用户

Ceteris 的起源是同时跑多个 Claude Code / Codex / OpenCode 时频繁迷失 — 哪个还在跑?哪个 idle 了?哪个被我关错窗口杀了?

如果你的工作流是:

- 一个 agent 在 `~/projects/frontend` 重构 dashboard
- 一个 agent 在 `~/projects/backend` 改 auth 模块
- 一个 agent 在 `~/scripts` 跑长 migration
- 一个 agent 在 `D:\client-work\report-tool` 修 flaky test
- ...而你已经忘了哪个是哪个

Ceteris 给你:

- **持久侧栏** — 所有 agent 按所在 path 分组
- **状态指示** — 一眼看出谁还在干活、谁空闲了
- **CWD 跟踪** — agent 在 session 里 cd 了,tab 上自动出 ⚠,悬停看真实 cwd
- **启动模板** — `claude` / `codex` / `opencode` 内置;支持自定义模板,环境变量带遮罩(防止 API key 被旁人扫到)
- **Session 不灭** — 不小心关掉窗口,agent 继续跑;重开窗口接着用

## 快速开始

> ⚠️ Ceteris 处于 **Alpha** 阶段,边角会有点糙。路线图见下。

### 安装

1. 从 [Releases](https://github.com/Fanisting/ceteris/releases) 下载最新安装包
2. 跑 `Ceteris-Setup-x.y.z.exe`
3. 从开始菜单或桌面启动

### 第一次跑

- 窗口出现,侧栏是空的
- 点"收藏"右边的 **+** 选一个文件夹加入
- 或者直接从资源管理器拖一个文件夹到侧栏(或终端区)
- 双击收藏路径,在该目录开终端
- 点 tab bar 的 `+` 选模板(Claude Code / Codex / Shell …)

### 试试"魔法"

体验 Ceteris 的独特之处:

1. 在不同路径开 2-3 个 session
2. 关掉窗口(右上角 ×)
3. 看系统托盘 — Ceteris 还活着
4. 点托盘图标 — 重开窗口,所有 session 还在原位

就这样。这就是产品。

## 核心特性

### V1(当前 alpha)

- ✅ **路径管理**:收藏 / 重命名 / 排序;"临时" 与 "最近" 自动跟
- ✅ **Session 生命周期**:`active / idle / exited` 三态;**已退出 session 无时限保留**,用户手动右键关闭才销毁(ADR-008)
- ✅ **启动模板**:内置(Shell / Claude Code / Codex / OpenCode)+ 自定义
- ✅ **多窗口**:任意数量平等窗口;关窗即托盘模式;跨窗口 session 可见
- ✅ **Ceteris Link(远程挂载)**:在另一台 Windows 机器上打开这台机器正在跑的终端标签页。同一批 session、同一份 scrollback、同一个正在跑的 agent;会话始终留在原机器运行。端到端加密(X25519 + AES-256-GCM),预共享令牌**从不上线路**。见 [docs/远程访问指南.md](docs/远程访问指南.md)
- ✅ **CWD 跟踪**:OSC 1337 hook 注入 PowerShell + cmd.exe
- ✅ **17 套主题**:Ceteris Dark(默认) / Ceteris Light / Rose Pine(3 款) / Catppuccin(2 款) / Tokyo Night(2 款) / Dracula / One Dark Pro / Cutie / Light Pink / Fairyfloss / Business / Ubuntu / Windows Terminal
- ✅ **窗口风格**:Windows / macOS 双布局(只影响标题栏 chrome,不影响配色)
- ✅ **设置即改即生效**,无保存按钮;导出 / 导入归档(支持敏感字段擦除选项)
- ✅ **系统托盘**:常驻,含"正在运行的会话"子菜单 + 设置 + 完全退出二次确认
- ✅ **拖文件夹到终端区**:直接在该路径开新 session
- ✅ **多行粘贴防护**:粘贴含换行时弹确认,防止误粘脚本被立即执行
- ✅ **终端搜索**(Ctrl+F)显示命中数
- ✅ **持久日志**:`%APPDATA%\Ceteris\logs\`

### V1.1 计划

- 状态识别扩展("等待输入" / "错误",基于 OSC 1337 命令完成事件)
- 系统通知(状态变化时,可选)
- 代码签名

### V1.2 计划

- Explorer 右键集成("在 Ceteris 中打开此文件夹")
- 标签页拖拽改顺序
- 标签页拖出 = 拆分到新窗口

### V1.6(规划中 — beta 反馈回合)

- **Linux 支持**(Ubuntu 22.04 GNOME 为 Tier 1;Fedora / CentOS Stream 9 / RHEL 9 为 Tier 2,走 `.rpm` + AppImage)。**不复刻 Windows 托盘心智**:GNOME 自 3.x 起官方移除 system tray,Ceteris 在 Linux 上作为普通桌面 app 运行(`lifecycleModel: 'no-persistence'`),关闭最后一个窗口且仍有非 exited session 时弹同一个跨平台二次确认 modal。文件管理器集成走 freedesktop 标准(`.desktop` + `Categories=TerminalEmulator` + gsettings + update-alternatives),**不写 Nautilus 扩展**。详见 [ADR-013](docs/软件定义书.md#adr-013) 与 [BETA-003](docs/beta反馈工单库-20260515.md#beta-003--linux-支持方案-a无托盘普通桌面-app)。
- i18n(中文 + 英文)
- AI 助手设置页(LLM 状态复核的基础)

### V2.0(社区 / 长期)

- macOS 支持(`lifecycleModel: 'dock-resident'`,原生 HIG)
- WSL session 集成
- (候选)daemon 架构 — 拆 Electron 主进程为后台 daemon + UI 观察窗,让 session 跨 UI 崩溃 / 升级存活。**未承诺**,等到崩溃/升级丢 session 成为高频反馈时再立项评估

## 架构(简述)

Ceteris 基于 **Electron 31 + TypeScript + React 18 + node-pty + xterm.js** 构建。

- **主进程** = 守护进程:持有所有 PTY、所有数据、系统托盘
- **每个窗口 = 一个 Renderer 进程**:独立 React UI
- 窗口是纯粹的观察者 — 关掉它绝对不影响 session
- 主 / Renderer 之间走 Electron IPC,有严格的类型化协议(`docs/ipc-protocol.md`)

详见:

- [软件定义书](docs/软件定义书.md) — Ceteris 是什么 + 为什么
- [IPC 协议](docs/ipc-protocol.md) — main 与 renderer 之间的契约
- [AGENTS.md](AGENTS.md) — 给为 Ceteris 贡献代码的 AI agent 看的

## 从源码构建

```bash
# 前置:Node.js 20+,Windows 10/11
git clone https://github.com/Fanisting/ceteris.git
cd ceteris
npm install
npm run dev      # 带热重载的开发模式
npm run build    # 打包安装程序到 release/
npm test         # 跑后端测试
```

## Help Wanted

Ceteris 由我一个人构建维护。**架构已经为跨平台准备好** — 见 [`src/main/platform/`](src/main/platform/) 与 `PlatformAdapter.lifecycleModel` 字段。Linux 支持由作者本人在 v1.6 实施;macOS 等仍开放给社区贡献:

### 高优先级

- [ ] **macOS 支持** — 实现 `src/main/platform/macos.ts`,`lifecycleModel: 'dock-resident'`。Electron `window-all-closed` darwin 默认分支已贴合 macOS HIG(app 留在 Dock);跨平台 `<LastSessionConfirm />` modal 在 `Cmd+Q` / App Menu Quit 且仍有非 exited session 时触发。
- [ ] **WSL session 集成**

### 中优先级

- [ ] Fish / Nushell shell hook
- [ ] 标签页拖拽
- [ ] 更多主题(7 套对我够用,但欢迎加)
- [ ] 中英以外的 i18n

### 低优先级

- [ ] 启动时恢复"重要"session(用户标记)
- [ ] 性能基线测试

如果上述任意一条吸引你,具体如何加新平台不破坏核心代码请看后续 `CONTRIBUTING.md`(待补)。

## 设计哲学

如果想理解 Ceteris 为什么这样做选择,四条原则:

1. **路径是稳定的,Session 是廉价的,UI 是临时的** — 工作以路径为锚,session 来去自如,窗口是用完即抛的观察工具
2. **不让用户输入路径,只让用户点击路径** — `cd` 是 1971 年的设计,应该是可选项
3. **用户决策最少化** — 自动分类 / 自动跟踪 / 自动调整尺寸;用户选路径和模板,其它工具自己搞
4. **窗口与应用解耦** — 关窗口是零成本的;应用住在托盘里,直到你显式退出

完整推导见[软件定义书](docs/软件定义书.md)第 2 章。

## Ceteris 不是什么

为了节省你时间:

- ❌ **不是终端模拟器替代品** — 我们和大家一样用 xterm.js
- ❌ **不是 tmux 竞品** — tmux 是 TUI,Ceteris 是 GUI,目标用户不同
- ❌ **不是项目管理工具** — 没有 kanban,没有团队功能,没有 workspace 概念
- ❌ **不是 SSH 客户端** — 只跑本地 session
- ❌ **不是文件编辑器** — 想编辑就在 session 里 `code .`
- ❌ **不是"把一切都瓦片化"的极客工具** — 如果你喜欢在终端管理器里用 vim 快捷键,你会觉得 Ceteris 的鼠标优先很烦。这是设计,不是 bug。

## 路线图

| 阶段 | 内容 | 时间 |
|-------|------|------|
| Phase 1 | V1:内部使用,只 Windows | 进行中 |
| Phase 2 | 开源、打磨 | V1 稳定后 |
| Phase 3 | V1.x:状态识别 / 通知 / Explorer 集成 | 发布后 |
| Phase 4 | V2.0:跨平台(社区驱动) | TBD |

这是个个人项目,业余时间做。没有公司,没有 SLA,没有承诺时间。能解决你的问题最好,不能就 fork。

## License

MIT — 见 [LICENSE](LICENSE)。

## 致谢

Ceteris 站在这些项目的肩膀上:

- [Electron](https://www.electronjs.org/) — 应用框架
- [electron-vite + Vite](https://electron-vite.org/) — 构建工具
- [xterm.js](https://xtermjs.org/) — 终端渲染器
- [node-pty](https://github.com/microsoft/node-pty) — PTY 绑定(Microsoft)
- [React](https://react.dev/) — UI 框架
- [Material Symbols](https://fonts.google.com/icons):UI 图标(Apache 2.0)
- [Rose Pine](https://rosepinetheme.com/) — 配色灵感
- [霞鹜文楷 (LXGW WenKai)](https://github.com/lxgw/LxgwWenKai) — UI 中文字体

灵感来源:

- [Wave Terminal](https://www.waveterm.dev/) — 证明了"session 持久化 + 精美 GUI"是可能的
- [tmux](https://github.com/tmux/tmux) — 证明了 session 应该比 UI 活得久
- [iTerm2](https://iterm2.com/) — OSC 1337 的源头,cwd 跟踪的无名英雄

---

> 这个项目存在的原因是 Windows Terminal 花了四年也没有发布 close-to-tray。
