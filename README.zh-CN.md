# Ceteris

> 你的终端会话不应该因为关掉窗口就死掉。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/Fanisting/ceteris/releases)
[![状态](https://img.shields.io/badge/状态-Alpha-orange)](#路线图)
[![English](https://img.shields.io/badge/English-README.md-blue)](README.md)

一个**以路径为中心、对 AI agent 友好**的终端管理器,支持 Windows、macOS 和 Linux。为同时运行多个长时间任务(包括 Claude Code、Codex、OpenCode 等 AI 编码助手)、需要在多个工作目录之间频繁切换、又不愿意因为关错窗口前功尽弃的开发者打造。

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
- **📍 路径是一等公民** —— 工作目录放在一个列表里,用标签筛选,session 按"在哪干活"组织,而不是按"用了哪个 profile 启动"
- **🖱️ 鼠标优先** —— 不需要记快捷键,不需要敲 `cd`,所有操作就是在侧栏点路径
- **🪟 所有窗口完全平等** —— 没有"主窗口"概念。开任意多个,关任意一个,应用照常运行

## 截图

> 第一个稳定版会附正式截图。下面是布局示意(实际侧栏图标用 Material Symbols,这里仅 ASCII 占位)。

```
┌────────────────────────────────────────────────────────────────────┐
│ Ceteris — Window 1                                    [_] [□] [×]  │
├──────────────────────┬─────────────────────────────────────────────┤
│ [文件夹] [标签]      │  ┌─[claude] [shell] [pytest] [codex灰]┐    │
│                      │  └────────────────────────────────────┘   │
│ ▼ ⌘ ~/projects/auth  │   ┌──────────────────────────────────────┐  │
│   ├─ ● claude code   │   │ $ claude                             │  │
│   ├─ ◐ shell         │   │ ✻ Welcome to Claude Code             │  │
│   └─ ○ pytest        │   │                                      │  │
│ ▼ ⌘ ~/projects/web   │   │ How can I help you today?            │  │
│   └─ ● codex         │   │ █                                    │  │
│ ▶ ⌘ ~/scripts        │   │                                      │  │
│                      │   │                                      │  │
│                      │   │                                      │  │
│ ▼ ⌚ ~/Downloads     │   │                                      │  │
│   └─ ○ shell         │   │                                      │  │
│                      │   │                                      │  │
│                      │   │                                      │  │
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
| 远程路径书签 | ❌ | ❌ | ❌ | ❌ | ✅ |
| 一键启动远程 tmux | ❌ | ❌ | ❌ | ❌ | ✅ |
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
- 一个 agent 在 `prod:~/repo` 挂在远程 tmux 里
- ...而你已经忘了哪个是哪个

Ceteris 给你:

- **持久侧栏** — 所有 agent 按所在 path 分组
- **状态指示** — 一眼看出谁还在干活、谁空闲了
- **CWD 跟踪** — agent 在 session 里 cd 了,tab 上自动出 ⚠,悬停看真实 cwd
- **SSH 路径书签**:保存远程配置,把远程工作目录和本地路径放在一起
- **远程 tmux 启动**:在远程主机上新建或接入 tmux,tmux 退出后回到远程 shell
- **启动模板**:内置 Claude Code、Codex、OpenCode、Gemini CLI、GitHub Copilot、Cursor 和 Aider;支持自定义模板,环境变量带遮罩(防止 API key 被旁人扫到)
- **Session 不灭** — 不小心关掉窗口,agent 继续跑;重开窗口接着用

## 快速开始

> ⚠️ Ceteris 处于 **Alpha** 阶段,边角会有点糙。路线图见下。

### 安装

从[最新版本](https://github.com/Fanisting/ceteris/releases/latest)(v0.4.3)下载适合你系统的文件:

| 系统 | 下载 |
|---|---|
| Windows 10/11(x64) | [Ceteris-Setup-0.4.3-x64.exe](https://github.com/Fanisting/ceteris/releases/download/v0.4.3/Ceteris-Setup-0.4.3-x64.exe) |
| macOS,Apple 芯片 | [Ceteris-0.4.3-arm64.dmg](https://github.com/Fanisting/ceteris/releases/download/v0.4.3/Ceteris-0.4.3-arm64.dmg) |
| macOS,Intel 芯片 | [Ceteris-0.4.3-x64.dmg](https://github.com/Fanisting/ceteris/releases/download/v0.4.3/Ceteris-0.4.3-x64.dmg) |
| Linux(x64),任意发行版 | [Ceteris-0.4.3-x86_64.AppImage](https://github.com/Fanisting/ceteris/releases/download/v0.4.3/Ceteris-0.4.3-x86_64.AppImage) |
| Ubuntu 或 Debian(x64) | [Ceteris-0.4.3-amd64.deb](https://github.com/Fanisting/ceteris/releases/download/v0.4.3/Ceteris-0.4.3-amd64.deb) |

- **Windows**:运行安装程序,然后从开始菜单或桌面启动。安装程序还没有代码签名,SmartScreen 可能拦截:点**更多信息**,再点**仍要运行**。
- **macOS**:打开 `.dmg`,把 Ceteris 拖进"应用程序"。应用还没有签名,第一次打开时请右键点它,选**打开**。
- **Linux**:运行 `chmod +x Ceteris-0.4.3-x86_64.AppImage` 后直接启动,或用 `sudo apt install ./Ceteris-0.4.3-amd64.deb` 安装 `.deb`。详见 [Linux 安装指南](docs/Linux安装指南-20260517.md)。

Windows 测试得最多。macOS 和 Linux 版本比较新,遇到问题请[提 issue](https://github.com/Fanisting/ceteris/issues)。

### 第一次跑

- 窗口出现,侧栏是空的
- 点"文件夹"右边的 **+** 选一个文件夹加入
- 或者直接从资源管理器拖一个文件夹到侧栏(或终端区)
- 双击文件夹,在该目录开终端
- 点 tab bar 的 `+` 选模板(Claude Code / Codex / Shell …)
- 远程工作:在设置里添加 SSH 配置,收藏一个远程路径(如 `~/repo`),再从路径视图普通连接或用 tmux 连接

### 试试"魔法"

体验 Ceteris 的独特之处:

1. 在不同路径开 2-3 个 session
2. 关掉窗口(右上角 ×)
3. 看系统托盘:Ceteris 还活着
4. 点托盘图标:重开窗口,所有 session 还在原位

在 macOS 上 Ceteris 改为留在 Dock 里。在 Linux 上它是普通桌面应用,关闭最后一个窗口时如果还有 session 在跑,会先询问。

就这样。这就是产品。

## 预览服务器上的 PDF

在远程机器上写 LaTeX(或任何会生成 PDF 的东西)?Ceteris 可以把 PDF 显示在终端旁边,并跟着文件一起更新。

1. 把服务器加成 SSH 配置(设置 → 远程),密钥选平时 `ssh` 用的那把。
2. 打开文件树,进到服务器上的某个文件夹。
3. 服务器要密码、Duo 验证码或确认主机密钥时,Ceteris 会弹对话框,回答一次即可。
4. 点一个 `.pdf`。服务器上的文件一变,预览自动刷新,页码和缩放保持不变。

标题栏按钮或 Ctrl + 滚轮可以缩放。图片、markdown 和本地文件同样会自动刷新。

## 核心特性

每个功能都有一页单独的说明,讲它做什么、在哪里找:见 [features 文件夹](features/README.md)(英文)。

### V1(当前 alpha)

- ✅ **支持 Windows、macOS 和 Linux**:macOS 上关闭窗口后应用留在 Dock;Linux 上作为普通桌面应用运行([ADR-013](docs/软件定义书.md#adr-013))
- ✅ **路径管理**:一个文件夹列表,支持重命名;开过终端的文件夹自动加入并保留
- ✅ **标签**:彩色标签以圆点显示在文件夹上,可按一个或多个标签筛选
- ✅ **远程路径**:SSH 配置、远程书签,侧栏标签同时显示配置名和远程路径
- ✅ **Session 生命周期**:`active / idle / exited` 三态;**已退出 session 无时限保留**,用户手动右键关闭才销毁(ADR-008)
- ✅ **启动模板**:内置 Shell、Claude Code、Codex、OpenCode、Gemini CLI、GitHub Copilot、Cursor、Aider,Windows 上另有 Admin Shell,也可以自定义;快捷启动的选项放在标签栏末尾的虚线标签里,点一下即启动
- ✅ **SSH tmux 模式**:每次启动时新建或接入 tmux,tmux 会话名由目录推导,tmux 退出后回到 shell
- ✅ **多窗口**:任意数量平等窗口;关窗即托盘模式;跨窗口 session 可见
- ✅ **Ceteris Link(远程挂载)**:在另一台 Windows 机器上打开这台机器正在跑的终端标签页。同一批 session、同一份 scrollback、同一个正在跑的 agent;会话始终留在原机器运行。端到端加密(X25519 + AES-256-GCM),预共享令牌**从不上线路**。见 [docs/远程访问指南.md](docs/远程访问指南.md)
- ✅ **CWD 跟踪**:OSC 1337 hook 注入 PowerShell + cmd.exe
- ✅ **95 套主题**:Light Pink(默认) / Ceteris Dark / Ceteris Light / Rose Pine(3 款) / Catppuccin(2 款) / Tokyo Night(2 款) / Dracula / One Dark Pro / Cutie / Light Pink / Fairyfloss / Business / Ubuntu / Windows Terminal / 梅子,7 款珠光主题(Lapis / Sapphire / Rose Dew / Ember / Jade / Moonlight / Frost),以及 6 款 LaTeX Beamer 模板配色(Metropolis / Metropolis Dark / Madrid / CambridgeUS / AnnArbor / Spruce),38 款取自 PiliPlus 主题色的 Pili 主题,以及 26 款 Legado MD3 主题,其中 4 款按种子色或 Windows 强调色实时生成。把自己的 `.css` 文件放进 `themes` 文件夹即可添加自定义主题
- ✅ **窗口风格**:Windows / macOS 双布局(只影响标题栏 chrome,不影响配色)
- ✅ **设置即改即生效**,无保存按钮;导出 / 导入归档(支持敏感字段擦除选项)
- ✅ **系统托盘**:常驻,含"正在运行的会话"子菜单 + 设置 + 完全退出二次确认
- ✅ **拖文件夹到终端区**:直接在该路径开新 session
- ✅ **多行粘贴防护**:粘贴含换行时弹确认,防止误粘脚本被立即执行
- ✅ **终端搜索**(Ctrl+F)显示命中数
- ✅ **文件面板**:浏览当前文件夹(本地,或 SSH 会话经 SFTP),在终端旁打开 PDF、图片和 markdown,文件一变就自动刷新
- ✅ **编辑 txt、json、md 和 tex**:直接修改保存,未保存的内容在断线重连后仍在;超过 2 MB 的文件分段只读,秒开;Markdown 用 OnePage 阅读样式;文件树里可以新建文件
- ✅ **看得见 agent 在做什么**:标签上的波浪随 agent 的阶段变化,AI 给每个 agent 标签起简短标题,agent 在你看别处时跑完会冒出一小簇庆祝粒子
- ✅ **“运行中”和“等你处理”筛选**:放在标签栏最前面;协调者标签切到任何文件夹都在,还能管理同一文件夹的其他标签
- ✅ **给我看文件**:让你的 Claude Code 在 Ceteris 里打开它的答案,文件出现在标签旁的文件面板,不需要协调者
- ✅ **更新 agent 时完整重载**:关掉该 agent 的标签、更新、再带着对话重新打开
- ✅ **[换模型和 effort](features/agent-model-effort.md)**:给文件夹设默认模型,或在正在运行的 Claude Code、Codex 标签里换,对话接着进行
- ✅ **[等你决定时弹消息](features/agent-choice-notice.md)**:agent 在你没看的标签里等你选择时,消息指到那个标签,也能直接在消息里选
- ✅ **[收纳盒](features/tab-shelf.md)**:闲置标签收起来省内存,点一下带着对话回来
- ✅ **[启动时恢复标签](features/reopen-tabs-at-launch.md)**:退出、更新或崩溃后,标签和 agent 对话都回来
- ✅ **[代码和数据文件](features/code-files.md)**:R、Python、Stata、SQL 等高亮显示、可编辑,保存后 lint
- ✅ **[在文件资源管理器中打开和删除](features/file-tree-open-in-explorer.md)**:在文件树里右键,删除的文件进回收站
- ✅ **[扩展一次装好](features/extension-setup.md)**:第一次启动一张清单装好 agent 扩展,Codex 也能把文件摆在标签旁边
- ✅ **[名称: 命令](features/name-commands.md)**:在 Claude Code 或 Codex 里敲 `compact:` 得到 `/compact`
- ✅ **公式显示成图片**:Claude Code 和 Codex 输出的 LaTeX 公式在终端里显示为排好的公式
- ✅ **检查更新**:发现 GitHub 上有新版本时,给出适合你系统的下载
- ✅ **Material Design 3 外观**:窗口、菜单、对话框和设置统一风格
- ✅ **中英文界面**:默认跟随系统语言
- ✅ **持久日志**:在应用数据目录下(Windows 为 `%APPDATA%\Ceteris\logs\`)

### V1.1 计划

- 状态识别扩展("等待输入" / "错误",基于 OSC 1337 命令完成事件)
- 系统通知(状态变化时,可选)
- 代码签名

### V1.2 计划

- Explorer 右键集成("在 Ceteris 中打开此文件夹")
- 标签页拖拽改顺序
- 标签页拖出 = 拆分到新窗口

### 以后

- WSL session 集成
- (候选)daemon 架构:把 Electron 主进程拆成后台 daemon 和 UI 观察窗,让 session 在三个平台上都能跨 UI 崩溃和升级存活。**未承诺**,等到崩溃或升级丢 session 成为高频反馈时再评估。

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
# 前置:Node.js 20+,Windows 10/11、macOS 或 Linux
git clone https://github.com/Fanisting/ceteris.git
cd ceteris
npm install
npm run dev      # 带热重载的开发模式
npm run build    # 打包安装程序到 release/
npm test         # 跑后端测试
```

## Help Wanted

Ceteris 由我一个人构建维护。**架构从设计上就是跨平台的**(见 [`src/main/platform/`](src/main/platform/) 与 `PlatformAdapter.lifecycleModel` 字段),Windows、macOS 和 Linux 版本都已发布。欢迎贡献,尤其是:

### 高优先级

- [ ] **macOS 和 Linux 测试**:这两个版本是新的,日常使用远少于 Windows
- [ ] **WSL session 集成**

### 中优先级

- [ ] Fish / Nushell shell hook
- [ ] 标签页拖拽
- [ ] 更多主题(现有 17 套,但欢迎加)
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
- ❌ **不是完整的 SSH 客户端套件**:Ceteris 支持以路径为中心的 SSH 会话,但不打算取代带端口转发、文件传输和主机管理的专业 SSH 工具
- ❌ **不是代码编辑器**:txt 和 json 可以直接改,改代码请在 session 里 `code .`
- ❌ **不是"把一切都瓦片化"的极客工具** — 如果你喜欢在终端管理器里用 vim 快捷键,你会觉得 Ceteris 的鼠标优先很烦。这是设计,不是 bug。

## 路线图

| 阶段 | 内容 | 时间 |
|-------|------|------|
| Phase 1 | V1:在 Windows、macOS 和 Linux 上日常使用 | 进行中 |
| Phase 2 | 开源、打磨 | V1 稳定后 |
| Phase 3 | V1.x:状态识别 / 通知 / Explorer 集成 | 发布后 |
| Phase 4 | V2.0:WSL 集成,候选 daemon 架构 | TBD |

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
- [OnePage](https://github.com/ivaneye/OnePage)(一页清 ivaneye),基于 [Cupertino](https://github.com/aaaaalexis/Obsidian-Cupertino)(aaaaalexis):Markdown 文件的阅读样式移植自这两个 Obsidian 主题(MIT,许可声明保留在 `src/renderer/styles/markdown-onepage.css`)
- [Rose Pine](https://rosepinetheme.com/) — 配色灵感
- [legado-with-MD3](https://github.com/HapeLee/legado-with-MD3):Legado MD3 系列主题使用它的 Material 3 配色方案
- [PiliPlus](https://github.com/bggRGjQaUbCoE/PiliPlus):Pili 系列主题照它的主题色列表和默认 Material 3 配色算法生成
- [霞鹜文楷 (LXGW WenKai)](https://github.com/lxgw/LxgwWenKai) — UI 中文字体

灵感来源:

- [Wave Terminal](https://www.waveterm.dev/) — 证明了"session 持久化 + 精美 GUI"是可能的
- [tmux](https://github.com/tmux/tmux) — 证明了 session 应该比 UI 活得久
- [iTerm2](https://iterm2.com/) — OSC 1337 的源头,cwd 跟踪的无名英雄

---

> 这个项目存在的原因是 Windows Terminal 花了四年也没有发布 close-to-tray。
