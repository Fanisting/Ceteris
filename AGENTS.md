# AGENTS.md:Ceteris 项目 AI Agent 工作说明

> 给为 Ceteris 写代码的 AI agent(Claude Code / Cursor / Codex 等)看。
> 你可以自主干活,大部分时候不需要问开发者;但第 2 章的三条边界永远不能越过。

文档版本:2.0 · 最后更新:2026-11-07

> **v2.0 变更**:CP-1 到 CP-5 已全部完成,检查点流程原文移到 `docs/开发记录-总览.md` 末尾附录。
> 删掉"开工前通读全部文档"的要求,改为按需读相关章节。macOS 与 Linux 已实现并发布,平台章节同步更新。
> 已完成的方案与 beta 工单库移到 `docs/archive/`。

---

## 1. 文档:按需读相关章节

不要通读。先用 `grep -n "^#"` 看目录,再只读和当前任务有关的章节。

| 要做的事 | 读哪里 |
|---|---|
| 判断一个功能该不该做 | `docs/软件定义书.md` 第 2 章(设计哲学)、第 13.2 节(永远不做) |
| 动状态机(path / session / 应用生命周期) | `docs/软件定义书.md` 第 8 章 |
| 动 IPC 消息 | `docs/ipc-protocol.md` 对应消息那一节 |
| 动远程访问(Ceteris Link) | `docs/ceteris-link-protocol.md`、`docs/远程访问指南.md` |
| 动快捷键 | `docs/键盘交互规范.md` |
| 打包、发版 | `docs/打包发布流程.md` |
| 查已知坑、历史 bug | `docs/known-issues.md`、`docs/issues/` |
| 查某个决策的来历 | `docs/软件定义书.md` 的 ADR 列表;旧方案和工单在 `docs/archive/` |

文档和代码对不上时,以代码为准,并在回报里指出哪里过时了。

---

## 2. 三条边界(越过即停,先问开发者)

### 边界 1:破坏性操作

以下操作前必须停下来,说明你要做什么,等开发者确认:

* 删除不是你自己刚创建的文件
* `git push --force`、修改 `.git/` 目录
* 删除或修改真实数据目录 `%APPDATA%\Ceteris\` 下的任何文件(测试也不行)
* 卸载 npm 包
* 修改 Windows 注册表
* 任何对真实数据生效的 clean / reset 类命令

### 边界 2:新依赖

技术栈以 `docs/软件定义书.md` 第 10.1 节为准。新加 npm 包前先问。例外:`@types/*` 可以直接装;测试相关的包先在对话里说一声再装。

### 边界 3:产品哲学

第 2 章的哲学原则和第 13.2 节"永远不做"是红线。实现时如果发现"加个 XXX 会简单很多",而 XXX 在红线里,停下来问。例如:

* 应用内快捷键切换 session(违反"鼠标优先")
* "主窗口"概念(违反"窗口平等")
* 关闭窗口时弹确认(违反"窗口零成本开关")。唯一例外见 ADR-013:Linux 上最后一个窗口关闭且仍有非 exited session 时,弹 `<LastSessionConfirm />`。其他情况一律不弹。

---

## 3. 代码注释、错误与日志

没有人 review 你的代码,开发者事后要能接手调试。目标:一个熟悉 TypeScript 和 Electron 的人,一小时内能看懂任何一个文件在做什么、为什么、出问题看哪里。

* **文件头注释**(每个 .ts / .tsx 必须有):`@file`、`@purpose`、`@关键设计`、`@对应文档章节`、`@不要在这里做的事`。参考 `src/main/ai-client.ts`。
* **公开函数**写清参数、返回值、会抛什么、副作用;复杂的私有函数同样要写。
* **复杂逻辑**写"为什么这么做,不那么做",不要复述代码。踩过的坑写进注释。
* **状态转移代码**在函数顶部画 mini 状态图,或引用软件定义书第 8 章。
* 不写:复述代码的注释、没有具体内容的 TODO、注释掉的代码(git 有历史)。
* **抛出的 Error** 要带:操作名、关键参数值、至少两个可能原因、建议的下一步。
* **主进程日志**带模块名和关键参数。`debug` 记 IPC 内容和字节流;`info` 记重要状态变化;`warn` 记异常但不致命;`error` 记致命错误。

---

## 4. 调试的 10 轮规则

同一个问题(同一个 bug、同一个失败测试)调试超过 10 轮还没解决,立刻停:

1. 停止修改,保留当前代码状态,不要回退。
2. 在仓库根目录写 `BLOCKED.md`:问题表现、复现步骤、试过的每条思路和结果、最强的猜测及为什么没修好、关键文件和行号、最有诊断价值的 5 到 20 行日志。
3. 输出 `🛑 BLOCKED: 调试 10 轮未果,需要开发者介入。详见 BLOCKED.md`,然后等待。

改一次代码重跑、加一个 log 重跑、改一个配置重跑,都算一轮。5 轮就感觉方向不对,可以提前 BLOCKED。做不同的功能、修不同的 bug 各跑几次,不算。

---

## 5. 测试

* **必须有测试**:`src/main/` 和 `src/shared/` 下所有非平凡逻辑(状态机、各 Manager、IPC 序列化与校验、原子写和损坏恢复、OSC 解析、active / idle 判定)。
* **不写测试**:`src/renderer/`(UI 由人工测)、`src/preload/`(只做转发)、第三方库的薄封装、简单 getter / setter。
* 框架是 Vitest。PTY 一律 mock,不 spawn 真的 shell;文件系统用 `fs.mkdtemp(os.tmpdir())` 临时目录,测完删掉。
* 每条规则一个测试,覆盖错误输入、边界(0 / 1 / N 个、容量上限)、并发、异常(启动失败、JSON 损坏、写盘失败)。
* 开发中只跑相关的测试文件;commit 前跑一次完整的 `npm test`。
* 不许为了让测试通过而 mock 掉被测的核心模块。

---

## 6. Git 与分支

* `main` 只接收合并好的功能。每个功能或修复一个分支:`feat/xxx`、`fix/xxx`、`chore/xxx`、`docs/xxx`。
* 开发者常常同时跑几个 agent。开新分支时用独立 worktree(`git worktree add`),在 worktree 里自己跑 `npm ci`;不要 `git stash`,不要回退别人未提交的改动。
* 每个独立的功能点、修复、重构一个 commit,保证 `git bisect` 可用。
* Commit message 用 Conventional Commits:`<type>(<scope>): <subject>`。type 取 `feat / fix / refactor / test / docs / chore / perf / ci`;subject 小写开头,50 字以内。
* commit 前跑过 `npm run typecheck`、`npm run lint`、`npm test`,并用 prettier 格式化。
* 合并走 PR:`gh pr create -R Fanisting/ceteris`。`gh` 命令一律带 `-R Fanisting/ceteris`(仓库有 upstream remote,不带会指错仓库)。
* 永远不 force push,除非开发者明确要求。
* 每次发版的 commit 都更新 `README.md` 和 `README.zh-CN.md`,清单见 `docs/打包发布流程.md` 第 3.6 节。

---

## 7. 平台与渠道

* 平台差异放在 `src/main/platform/`(PlatformAdapter):`windows.ts`、`macos.ts`、`linux.ts` 都已实现。新代码需要平台判断时,优先加到 adapter 里,不要在业务代码里新增 `process.platform` 分支。
* 测试需要 platform adapter 时用 mock,不直接调具体平台实现。
* Windows 在本机构建;Linux 在 WSL / Docker 里构建(`npm run build:linux`);macOS 由 GitHub Actions(`.github/workflows/build-mac.yml`)构建,本机测不了的平台要在回报里写明没测。
* stable / beta / dev 三个渠道可以同时运行,隔离规则只在 `src/shared/channel.ts` 一处维护。开发者日常工作在安装版 stable 里;测试用 beta(`npm run build:beta` 后 `npm run beta`)或 dev(`npm run dev`)。更新 stable 会关掉它里面的终端,不要擅自更新或关闭 stable。

---

## 8. 数据安全

* 永远不读写、不删除真实数据目录 `%APPDATA%\Ceteris\`;测试用临时目录。
* `.env*` 不进 git。代码、注释、commit message 里不写真实路径(用 `~/projects/example` 占位)、API key、token、密码,也不贴测试用的真实输出。
* 测试不 spawn 真实的浏览器、shell 或应用。

---

## 9. 性能底线

* 冷启动到第一个窗口可见 < 3 秒;创建 session 到 PTY ready < 1 秒
* PTY 字节流到 xterm 显示 < 50ms;设置变更同步到所有窗口 < 200ms
* 稳态(10 个 session,2 个窗口)内存 < 500MB

超出底线 2 倍以上时停下来评估设计。没有问题的地方不做性能优化,保持简单。

---

## 10. 不做顺手重构

已合并的代码不做"顺手"重构(改命名、callback 改 async、抽工具函数、加抽象层)。只有三种情况可以改:当前功能必须改它;它是阻碍当前工作的 bug;开发者明确要求。补注释、跑 prettier、修 typo 不算重构。想做但不属于当前任务的事,记到 `BACKLOG.md`。

---

## 附录:答案永远是"不"的问题

* 加 vim 模式快捷键
* 加 project / workspace 概念让 session 持久化
* 关闭窗口时弹确认(ADR-013 的 Linux 最后窗口例外除外)
* force push(除非开发者明确要求)
* 为了过测试 mock 掉核心模块
