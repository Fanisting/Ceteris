# Ceteris IPC 协议规格

> Ceteris 在 alpha 阶段(CP-1 ~ Milestone 1)的开发代号为 EasyTerm,v1.5 起正式定名 Ceteris。详见软件定义书 ADR-012。

> 主进程(守护进程)与渲染进程(每个窗口)之间的通信契约。
> 这份文档定义所有消息的 schema、语义、错误码、时序约束。
> 实现代码必须严格遵循,不允许"自由发挥"。

文档版本:1.6 · 最后更新:2026-11-10

> **v1.6 变更**(收纳盒,软件定义书 ADR-036):
> - 新增 `cmd:shelf:put`、`cmd:shelf:restore`、`cmd:shelf:remove`、`cmd:shelf:clear` 与事件 `evt:shelf:changed`;snapshot 加 `shelf`
> - domain 白名单加 `shelf`
> - `evt:session:destroyed` 的 reason 多一个 `'shelved'`
> - settings 加 `behavior.shelveIdleAfterHours`(默认 0)
> - 附录 D 的管道加 `agent-session` 操作(任何活着的标签都能调)
>
> **v1.5 变更**(GitHub Releases 更新检查,软件定义书 ADR-018):
> - 新增 `cmd:update:get-status`、`cmd:update:check-now` 与事件 `evt:update:status-changed`
> - domain 白名单加 `update`
> - settings 加 `behavior.autoCheckUpdates`(默认 true)
>
> **v1.4 变更**(PDF 实时预览 + SFTP 交互式登录,软件定义书 ADR-017):
> - 新增 `cmd:fs:stat-file`(PDF 自动刷新轮询文件大小和修改时间,安静请求)
> - `cmd:fs:list-dir` payload 加 `interactive`,`cmd:fs:read-pdf` payload 加 `fresh`、response 加 `mtimeMs`;`DirFailure` 多一个 `'login-required'`
> - 新增 `cmd:ssh:askpass-answer` 与事件 `evt:ssh:askpass-prompt` / `evt:ssh:askpass-closed`(后台 SFTP 连接的 ssh 登录提示由窗口回答)
> - domain 白名单加 `fs`、`ssh`(此前 `cmd:fs:*` 已在代码中,文档未列)
>
> **v1.3 变更**(Milestone 1 收尾 + 勘误第二轮回写):
> - domain 白名单加 `explorer-integration`(原仅 9 个 domain,接 Win11 新菜单 / 经典菜单后多一个域)
> - 新增 Section 5.7:`cmd:explorer-integration:get-status` / `set-classic` / `set-modern` / `get-ps-commands`(4 条)
> - 5.2 Session 段补 `cmd:session:clear-manual-rename`(M1 STM-3 修复后 renderer 恢复自动标题用)
> - 5.6 System 段补 `cmd:system:get-build-type` / `cmd:system:clipboard-read-text` / `cmd:system:clipboard-write-text`(3 条)
> - 上述命令均自 v1.2 发布后陆续在代码中加入,文档此前未同步
>
> **v1.2 变更**(Milestone 1 内部上线):
> - 删除全部 `tombstoned` / `墓地` 相关命令、事件、错误码(ADR-008,自 CP-3 起就不存在了,本文档之前未跟进)
> - state 字面量统一为 `'active' | 'idle' | 'exited'`
> - 新增命令:`cmd:window:minimize` / `cmd:window:toggle-maximize` / `cmd:window:get-max-state` / `cmd:session:rename`(自绘标题栏 + 重命名 UI)
> - 新增事件:`evt:window:max-state-changed`
> - 完整化既有但未文档化的命令:`cmd:settings:export` / `cmd:settings:import` / `cmd:template:add|update|delete|set-default` / `cmd:bookmark:pick-folder|set-default-template` / `cmd:system:open-data-dir|open-logs-dir|open-external`
> - 移除 `appearance.followSystemTheme` 副作用描述(ADR-009)
>
> **v1.1 变更**(2026-05-11,CP-4 勘误回合):一处 `followSystemTheme` 描述修正(完整对齐推后到 v1.2)。

---

## 目录

1. [总体说明](#1-总体说明)
2. [传输层](#2-传输层)
3. [消息分类与命名](#3-消息分类与命名)
4. [Handshake 协议](#4-handshake-协议)
5. [命令清单](#5-命令清单-renderer--main)
6. [事件清单](#6-事件清单-main--renderer)
7. [错误码](#7-错误码)
8. [字节流传输](#8-pty-字节流传输)
9. [时序约束](#9-时序约束与并发)
10. [版本演进](#10-版本演进)

---

## 1. 总体说明

### 1.1 角色

- **Main**:Electron 主进程,守护进程。单一可信数据源,持有所有 PTY、所有数据。
- **Renderer**:每个窗口对应一个独立 Renderer 进程。**无状态**(除窗口私有视图状态)。

### 1.2 消息方向

所有消息分两种方向:

| 方向 | 名称 | 用途 | 传输方式 |
|------|------|------|---------|
| Renderer → Main | **命令(Command)** | Renderer 请求 Main 做某事;有返回值或 error | `ipcRenderer.invoke` / `ipcMain.handle` |
| Main → Renderer | **事件(Event)** | Main 通知 Renderer 某事发生;单向广播或定向 | `webContents.send` / `ipcRenderer.on` |

**禁止**使用 Electron 老式的 `ipcRenderer.send` + `ipcMain.on`。理由:错误无法 propagate,容易吞错。

### 1.3 序列化

所有 payload 必须是 JSON 可序列化的(Electron IPC 内部用 structured clone)。**禁止**:
- 函数 / 闭包
- Symbol
- 含循环引用的对象
- Buffer(字节流另有规定,见 [第 8 节](#8-pty-字节流传输))

### 1.4 数据所有权

- Main 是所有数据的**唯一可信源**
- Renderer 不许自己持久化业务数据(只允许持久化纯视图状态如展开/折叠到 sessionStorage,这不算业务数据)
- Renderer 启动时,通过 `cmd:app:get-snapshot` 拉取完整状态
- 之后通过事件订阅增量更新

---

## 2. 传输层

### 2.1 Channel 命名约定

格式:`<kind>:<domain>:<action>`

- `kind`:`cmd` | `evt`
- `domain`:`app` | `window` | `session` | `path` | `bookmark` | `template` | `settings` | `tray` | `system` | `explorer-integration` | `fs` | `ssh` | `update`
- `action`:具体动词,kebab-case

> v1.3 起 domain 允许 kebab-case(为容纳 `explorer-integration`)。protocol.ts 校验
> 正则相应放宽到 `^cmd:[a-z-]+:[a-z-]+$` / `^evt:[a-z-]+:[a-z-]+$`。

例:
- `cmd:session:create`
- `cmd:bookmark:add`
- `evt:path:tree-updated`
- `evt:session:output`

### 2.2 Window ID 的传递

每个 Renderer 在启动时需要知道自己是哪个 window。

**机制**:Main 在创建 `BrowserWindow` 时,通过 URL query string 传:
```typescript
window.loadURL(`file://.../index.html?windowId=${windowId}`);
```

Renderer 在启动时:
```typescript
const params = new URLSearchParams(window.location.search);
const myWindowId = params.get('windowId')!;
```

**所有从 Renderer 发出的命令**,在底层封装时,会自动附加 `windowId` 字段(见 [第 2.4 节](#24-命令包封装))。

### 2.3 命令包封装

每个命令的 payload 在传输时被包装成:

```typescript
interface CommandEnvelope<P = unknown> {
  windowId: string;        // 自动附加,标识发起命令的窗口
  requestId: string;       // UUID,用于日志追踪
  payload: P;              // 命令的具体参数
}
```

实现上,Renderer 端封装:
```typescript
async function invoke<P, R>(channel: string, payload: P): Promise<R> {
  const envelope: CommandEnvelope<P> = {
    windowId: getMyWindowId(),
    requestId: crypto.randomUUID(),
    payload,
  };
  return await ipcRenderer.invoke(channel, envelope);
}
```

Main 端处理:
```typescript
ipcMain.handle('cmd:session:create', async (event, envelope: CommandEnvelope<CreateSessionPayload>) => {
  log.info(`[IPC] cmd:session:create requestId=${envelope.requestId} windowId=${envelope.windowId}`);
  // ... 执行
});
```

### 2.4 事件包封装

事件不需要 windowId(Main 推送时已知发给谁),但为了一致性和调试,保留 envelope:

```typescript
interface EventEnvelope<P = unknown> {
  eventId: string;         // UUID,用于日志和去重
  timestamp: number;       // Unix ms
  payload: P;
}
```

### 2.5 路由策略

| 事件类型 | 推送范围 |
|---------|---------|
| 全局状态变更(path tree、settings) | 广播给**所有**窗口 |
| Session 字节流 | 仅推送给该 session 的 owner window |
| Session 状态变化 | 广播给所有窗口(因为侧栏要更新) |
| Window list 变化 | 广播给所有窗口(因为灰显标签要更新) |
| Window 私有事件(被聚焦命令等) | 仅推送给目标窗口 |

实现:
```typescript
// 广播
function broadcast<P>(channel: string, payload: P) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, wrapEvent(payload));
  }
}

// 定向
function sendTo<P>(windowId: string, channel: string, payload: P) {
  const win = windowManager.getElectronWindow(windowId);
  if (win) win.webContents.send(channel, wrapEvent(payload));
}
```

---

## 3. 消息分类与命名

完整 channel 列表如下。后续章节给出每条消息的详细 schema。

### 3.1 命令(Renderer → Main)

| Channel | 用途 |
|---------|------|
| `cmd:app:get-snapshot` | 拉取应用完整状态(Renderer 启动时调用) |
| `cmd:app:get-protocol-version` | Handshake 检查协议版本 |
| `cmd:app:quit` | 触发完全退出流程(从托盘菜单或设置触发) |
| `cmd:window:create` | 新开一个窗口 |
| `cmd:window:close-self` | 关闭当前窗口 |
| `cmd:window:close-all` | 关闭所有窗口(进入纯托盘模式) |
| `cmd:window:focus` | 聚焦指定 windowId 的窗口 |
| `cmd:window:minimize` | **(M1-A)** 最小化当前窗口(自绘标题栏配套) |
| `cmd:window:toggle-maximize` | **(M1-A)** 切换当前窗口最大化/还原 |
| `cmd:window:get-max-state` | **(M1-A)** 查询当前窗口是否最大化 |
| `cmd:session:create` | 新建一个 session |
| `cmd:session:close` | 关闭一个 session |
| `cmd:session:claim` | 把一个 session 的 owner 设为本窗口 |
| `cmd:session:release` | 释放本窗口对某 session 的 ownership |
| `cmd:session:focus-owner` | 聚焦某 session 的 owner 窗口 |
| `cmd:session:send-input` | 向 session 发送键盘输入 |
| `cmd:session:resize` | 通知 session 终端尺寸变化 |
| `cmd:session:rename` | **(M1-C)** 重命名 session 的显示名 |
| `cmd:session:set-coordinator` | **(ADR-023)** 标记或取消 coordinator,标签移到标签栏上方一行 |
| `cmd:session:get-scrollback` | 获取 session 的 scrollback 缓冲(切换 owner 时用) |
| `cmd:shelf:put` | **(ADR-036)** 把一个 session 收进收纳盒(结束进程,留下 resume id) |
| `cmd:shelf:restore` | **(ADR-036)** 在本窗口重新打开收纳盒里的一个标签 |
| `cmd:shelf:remove` | **(ADR-036)** 从收纳盒移除一条 |
| `cmd:shelf:clear` | **(ADR-036)** 清空收纳盒 |
| `cmd:bookmark:add` | 添加收藏路径 |
| `cmd:bookmark:remove` | 移除收藏 |
| `cmd:bookmark:rename` | 重命名收藏的显示名 |
| `cmd:bookmark:reorder` | 调整收藏顺序 |
| `cmd:bookmark:set-default-template` | 设置某收藏路径的默认模板 |
| `cmd:bookmark:pick-folder` | 调起文件夹选择器,返回选择的路径 |
| `cmd:path:remove-from-recent` | 从"最近"中移除某路径 |
| `cmd:template:add` | 创建自定义模板 |
| `cmd:template:update` | 修改模板(含内置部分字段) |
| `cmd:template:delete` | 删除自定义模板(内置不可删) |
| `cmd:template:set-default` | 设置全局默认模板 |
| `cmd:settings:get` | 获取当前设置(Renderer 启动后通常调一次) |
| `cmd:settings:update` | 更新设置(部分更新) |
| `cmd:settings:reset` | 重置为出厂(危险) |
| `cmd:settings:list-shells` | 列出启动期检测到的所有可用 shell |
| `cmd:settings:get-auto-start` | 查询当前是否开机启动 |
| `cmd:settings:export` | 导出全部配置为 JSON 归档(M1-F:可选含/不含 env 敏感字段) |
| `cmd:settings:import` | 从 JSON 归档导入(in-memory replace,不重启应用,ADR-009) |
| `cmd:system:show-in-explorer` | 在 Explorer 中显示某路径 |
| `cmd:system:open-data-dir` | 在 Explorer 中打开 `%APPDATA%\Ceteris` |
| `cmd:system:open-logs-dir` | 在 Explorer 中打开日志目录 |
| `cmd:system:open-external` | 用系统默认浏览器打开 URL(仅 http(s)/mailto) |
| `cmd:fs:list-dir` | 列目录(本地或 SFTP),文件树用 |
| `cmd:fs:rename` | 重命名本地文件树条目 |
| `cmd:fs:delete` | 把本地文件树条目移到回收站 |
| `cmd:fs:read-pdf` | 分块读取可查看的文件(PDF / 图片 / markdown) |
| `cmd:fs:stat-file` | **(v1.4)** 查文件大小和修改时间,PDF 自动刷新轮询用 |
| `cmd:ssh:askpass-answer` | **(v1.4)** 回答一条 `evt:ssh:askpass-prompt` |
| `cmd:update:get-status` | **(v1.5)** 取当前更新检查状态 |
| `cmd:update:check-now` | **(v1.5)** 立刻查一次 GitHub Releases |

> v1.2 起删除:`cmd:template:list` (用 `cmd:app:get-snapshot` 拿到)、`cmd:session:restart-from-tombstone` (ADR-008 砍墓地)、`cmd:settings:detect-shells` (并入 `cmd:settings:list-shells`)、`cmd:settings:open-data-dir/open-log-dir` (并入 `cmd:system:open-data-dir/open-logs-dir`)、`cmd:system:show-context-menu` (renderer 端自绘菜单,不需要 main 端 popup)。

### 3.2 事件(Main → Renderer)

| Channel | 推送范围 |
|---------|---------|
| `evt:app:state-changed` | 全部 |
| `evt:window:assigned-id` | 仅目标窗口(初始化用) |
| `evt:window:list-updated` | 全部 |
| `evt:window:focus-requested` | 仅目标窗口 |
| `evt:window:max-state-changed` | **(M1-A)** 仅目标窗口;通知 maximize/unmaximize 状态变化 |
| `evt:session:created` | 全部 |
| `evt:session:state-changed` | 全部(单事件涵盖 state / currentCwd / displayName / exitCode 等子集变化) |
| `evt:session:output` | 仅 owner |
| `evt:session:exited` | 全部 |
| `evt:session:owner-changed` | 全部 |
| `evt:session:destroyed` | 全部 |
| `evt:shelf:changed` | **(ADR-036)** 全部;整个收纳盒列表,收纳时先于该 session 的 `evt:session:destroyed` 发出 |
| `evt:path:tree-updated` | 全部 |
| `evt:bookmarks:updated` | 全部 |
| `evt:templates:updated` | 全部 |
| `evt:settings:changed` | 全部 |
| `evt:ssh:askpass-prompt` | **(v1.4)** 仅发起 SFTP 连接的窗口 |
| `evt:ssh:askpass-closed` | **(v1.4)** 仅收到对应 prompt 的窗口 |
| `evt:update:status-changed` | **(v1.5)** 全部本机窗口 |

> v1.2 起删除:`evt:session:tombstoned` (ADR-008)、`evt:session:cwd-changed` (并入 `evt:session:state-changed` 的 changes.currentCwd 子字段,ADR-008)、`evt:template:list-updated` (重命名为 `evt:templates:updated`,代码一直是后者,文档之前不一致)、`evt:tray:menu-action` (托盘菜单 click handler 直接在 main 端执行,renderer 不参与)。

---

## 4. Handshake 协议

每个 Renderer 进程在加载完成后,**必须**先做 handshake,再做其他事。

### 4.1 流程

```
Renderer 启动
  ↓
1. 从 URL 取 windowId
  ↓
2. invoke('cmd:app:get-protocol-version', {})
  ↓
3. 收到 { protocolVersion: 1 }
  ↓
4. 比较与 Renderer 编译时的 PROTOCOL_VERSION,不匹配 → 抛错并显示升级提示
  ↓
5. invoke('cmd:app:get-snapshot', {})
  ↓
6. 收到完整 AppSnapshot,初始化 Renderer 状态
  ↓
7. 注册所有 evt:* 事件监听
  ↓
准备好,UI 显示
```

### 4.2 cmd:app:get-protocol-version

**Payload**:`{}`(空)

**Response**:
```typescript
interface ProtocolVersionResponse {
  protocolVersion: number;     // 当前协议主版本
  buildVersion: string;         // Ceteris 应用版本号(用于诊断)
}
```

**错误**:无(永远成功)

### 4.3 cmd:app:get-snapshot

**Payload**:
```typescript
interface GetSnapshotPayload {
  myWindowId: string;          // 当前窗口的 id(确认 Main 知道这个窗口)
}
```

**Response**:
```typescript
interface AppSnapshot {
  windows: WindowInfo[];        // 所有窗口的简要信息
  sessions: SessionInfo[];      // 所有 session
  pathTree: PathTree;           // 完整路径树(收藏 / 临时 / 最近)
  templates: Template[];        // 所有模板
  defaultTemplateId: string;
  settings: Settings;           // 当前设置
  myWindowId: string;          // 回显,用于校验
}
```

**错误**:
- `WindowNotRegistered`:Main 不认识这个 windowId(异常,通常意味着窗口已经被关闭)

类型定义见 `src/shared/types.ts`。每个类型字段语义见 `软件定义书.md` 第 11 章。

---

## 5. 命令清单 (Renderer → Main)

每个命令给出:**Payload**(请求参数)、**Response**(返回值)、**Errors**(可能的错误码)、**Side Effects**(执行的副作用,包括会触发哪些事件)。

### 5.1 应用与窗口

#### `cmd:app:quit`
触发完全退出流程。

```typescript
// Payload
interface QuitPayload {
  skipConfirmation?: boolean;   // 默认 false。设为 true 跳过有 session 时的确认
}

// Response
interface QuitResponse {
  cancelled: boolean;           // 用户取消了确认 → true,应用未退出
}
```

**Errors**:无

**Side Effects**:
- 若有 session 在跑且未跳过确认,弹原生对话框
- 用户确认 → SIGTERM 所有 PTY,持久化数据,`app.quit()`
- 不广播 `evt:` 事件(应用都要退出了)

---

#### `cmd:window:create`
新开一个窗口。

```typescript
// Payload: {}

// Response
interface CreateWindowResponse {
  windowId: string;             // 新窗口的 id
  windowNumber: number;         // 显示编号(Window N)
}
```

**Errors**:
- `MaxWindowsReached`:超过窗口数上限(V1 设为 20)

**Side Effects**:
- 创建新 BrowserWindow
- 广播 `evt:window:list-updated`

---

#### `cmd:window:close-self`
关闭发起命令的窗口。

```typescript
// Payload: {}
// Response: {} (空对象)
```

**Errors**:无

**Side Effects**:
- Main 调用该窗口的 `BrowserWindow.close()`
- 该窗口持有的所有 session,owner 变 null
- 广播 `evt:session:owner-changed` (per session) 和 `evt:window:list-updated`
- **绝不弹确认对话框**

---

#### `cmd:window:close-all`
关闭所有窗口,进入纯托盘模式。

```typescript
// Payload: {}
// Response: {}
```

**Errors**:无

**Side Effects**:
- 关闭所有 BrowserWindow
- 所有 session 的 owner 变 null
- 广播相关事件(虽然没有窗口收,但日志要打)

---

#### `cmd:window:focus`
聚焦指定窗口。

```typescript
// Payload
interface FocusWindowPayload {
  windowId: string;             // 目标窗口
}
// Response: {}
```

**Errors**:
- `WindowNotFound`:windowId 不存在

**Side Effects**:
- Main 调用目标窗口的 `BrowserWindow.focus()` 和必要时 `restore()`
- 推送 `evt:window:focus-requested` 给目标窗口(Renderer 可借此切换到合适视图)

---

#### `cmd:window:minimize` (M1-A)
最小化发起命令的窗口。

```typescript
// Payload: undefined
// Response: void
```

**Errors**:无(目标窗口已销毁时静默 no-op)

**Side Effects**:
- 调用本窗口的 `BrowserWindow.minimize()`
- 通常会跟一个 `evt:window:max-state-changed`(若状态确变)

---

#### `cmd:window:toggle-maximize` (M1-A)
切换发起命令的窗口的最大化/还原。

```typescript
// Payload: undefined
// Response: void
```

**Errors**:无

**Side Effects**:
- 调用 `maximize()` 或 `unmaximize()`
- 推送 `evt:window:max-state-changed` 给本窗口

---

#### `cmd:window:get-max-state` (M1-A)
查询发起命令的窗口当前是否最大化。

```typescript
// Payload: undefined
// Response
interface GetWindowMaxStateResponse {
  maximized: boolean;
}
```

WindowChrome 初次挂载时调一次拿到初值,之后通过订阅 `evt:window:max-state-changed` 跟踪。

### 5.2 Session

#### `cmd:session:create`
新建一个 session。

```typescript
// Payload
interface CreateSessionPayload {
  pathId: string;               // 启动时的工作目录(必须是 Main 已知的 path)
  templateId: string;           // 启动模板
  takeOwnership?: boolean;      // 默认 true,创建后本窗口为 owner
}

// Response
interface CreateSessionResponse {
  session: SessionInfo;         // 新创建的 session
  pathTreeChanged: boolean;     // 是否触发了 path 树变化(临时分类等)
}
```

**Errors**:
- `PathNotFound`:pathId 不存在
- `TemplateNotFound`:templateId 不存在
- `PtySpawnFailed`:node-pty 启动失败(详见错误的 `details` 字段)
- `ShellNotFound`:模板对应的 shell 不存在
- `CwdNotAccessible`:工作目录不存在或无权限

**Side Effects**:
- 创建 PTY
- 注入 OSC 1337 hook
- Path 状态机可能触发(临时分类)
- 广播 `evt:session:created`、`evt:session:state-changed`
- 若 path 树变化,广播 `evt:path:tree-updated`

---

#### `cmd:session:close`
关闭一个 session。

```typescript
// Payload
interface CloseSessionPayload {
  sessionId: string;
  force?: boolean;              // 默认 false。true = 跳过 SIGTERM 直接 kill
}
// Response: {}
```

**Errors**:
- `SessionNotFound`

**Side Effects** (v1.2 ADR-008 后):
- 调 `node-pty` 的 `kill()`,Windows ConPTY 立即终止子进程(无 SIGTERM/grace)
- 销毁 session,广播 `evt:session:destroyed`,可能触发 `evt:path:tree-updated`(如果该 path 因此变空 → 走 临时→最近 状态机)

> v1.2 起:`cmd:session:close` 等同于"销毁"(同步删 session)。**已退出**的 session(state='exited')也由 close 销毁。墓地 5 分钟自动过期已不存在,见 ADR-008。

---

#### `cmd:session:claim`
本窗口接管一个 session 的 ownership。

```typescript
// Payload
interface ClaimSessionPayload {
  sessionId: string;
}
// Response
interface ClaimSessionResponse {
  scrollback: string;           // base64 编码的 scrollback 字节流(让新 owner 重放)
}
```

**Errors**:
- `SessionNotFound`
- `SessionAlreadyOwned`:已有其他窗口持有(应该先让那个窗口释放,或用 `cmd:session:focus-owner` 而不是 claim)

**Side Effects**:
- 把 session 的 owner 改为本窗口
- 旧的字节流推送停止(若 owner 是其他窗口)
- 广播 `evt:session:owner-changed`

---

#### `cmd:session:release`
本窗口主动释放对某 session 的 ownership。

```typescript
// Payload
interface ReleaseSessionPayload {
  sessionId: string;
}
// Response: {}
```

**Errors**:
- `SessionNotFound`
- `NotOwner`:本窗口不是该 session 的 owner

**Side Effects**:
- session 的 owner 变 null
- 字节流推送停止
- 广播 `evt:session:owner-changed`

---

#### `cmd:session:focus-owner`
要求 Main 聚焦某 session 的 owner 窗口。

```typescript
// Payload
interface FocusSessionOwnerPayload {
  sessionId: string;
}
// Response
interface FocusSessionOwnerResponse {
  ownerWindowId: string | null;  // 若为 null,session 当前无 owner
  focused: boolean;              // 是否成功聚焦了
}
```

**Errors**:
- `SessionNotFound`

**Side Effects**:
- 若 session 有 owner → 等价于 `cmd:window:focus`
- 若无 owner → 不做事,response 中 focused=false(Renderer 自行决定是否 claim)

---

#### `cmd:session:send-input`
向 session 发送键盘输入。

```typescript
// Payload
interface SendInputPayload {
  sessionId: string;
  data: string;                 // 用户输入的字节,UTF-8 字符串
}
// Response: {}
```

**Errors**:
- 实际实现是"竞态时静默" — 不存在 / 已退出的 session 调 send-input 不报错也不动 PTY(规避 close/HMR 时的小窗期)

**Side Effects**:
- PTY 收到输入
- 不广播事件(输入不需要广播)

**性能要求**:延迟 < 10ms

---

#### `cmd:session:resize`
通知 session 终端尺寸变化。

```typescript
// Payload
interface ResizeSessionPayload {
  sessionId: string;
  cols: number;                 // 列数,1-1000
  rows: number;                 // 行数,1-500
}
// Response: {}
```

**Errors**:
- `SessionNotFound`
- `NotOwner`
- `InvalidDimensions`:cols/rows 超出范围

**Side Effects**:
- PTY 调用 resize
- 不广播

**性能要求**:延迟 < 50ms。Renderer 应自行 debounce 防止用户拖动窗口时狂发。

---

#### `cmd:session:rename` (M1-C)
重命名 session 的显示名(不影响实际命令 / PTY / pathId)。

```typescript
// Payload
interface RenameSessionPayload {
  sessionId: string;
  newDisplayName: string;       // trim 后 1+ 字符;空字符串 throw
}
// Response: void
```

**Errors**:
- 不存在的 sessionId 静默 no-op(竞态时一致语义)
- 空名抛 SessionManagerError

**Side Effects**:
- 广播 `evt:session:state-changed`(`changes.displayName` 在内)
- 标记 session.manuallyRenamed = true;后续 OSC 0/1/2 标题事件不再覆盖
  此 session 的 displayName(直到 `cmd:session:clear-manual-rename` 重置)

---

#### `cmd:session:clear-manual-rename` (v1.3,STM-3)
清除手动重命名标记,让 OSC 0/1/2 标题事件重新接管 displayName。

```typescript
// Payload
interface ClearManualRenamePayload {
  sessionId: string;
}
// Response: void
```

**典型场景**:用户右键 session 选「恢复自动标题」。例如:用户在 Claude Code
跑长任务时,Claude 通过 OSC 0/1/2 不断刷新窗口标题反映进度;之前 `rename`
锁住了名字,这里解锁让进度标题重新生效。

**Errors**:
- 不存在的 sessionId 静默 no-op

**Side Effects**:
- 清掉 `manuallyRenamed` 标记
- 不立即改 displayName(留待下一次 OSC 0/1/2 到来时覆盖)
- 不广播事件(标记本身对 UI 不可见)

---

#### `cmd:session:set-coordinator` (ADR-023)
标记或取消 coordinator。所有窗口把 coordinator 的标签放进标签栏上方单独一行,
不论当前打开的是哪个文件夹。任何窗口都能改,所有权不变。

```typescript
// Payload
interface SetCoordinatorPayload {
  sessionId: string;
  coordinator: boolean;
}
// Response: void
```

**Side Effects**:
- 值真的变了才广播 `evt:session:state-changed`(`changes.coordinator` 在内)
- 标记随 session 存在,session 销毁即消失,不持久化

**Errors**:
- 不存在的 sessionId 静默 no-op

---

> v1.2 起 `cmd:session:restart-from-tombstone` 已删除(ADR-008)。如需"再跑一次相同模板",在同一 path 下 `cmd:session:create` 即可。

---

#### `cmd:shelf:put` / `cmd:shelf:restore` / `cmd:shelf:remove` / `cmd:shelf:clear` (ADR-036)
收纳盒。类型在 `src/shared/shelf.ts`(`ShelfEntry`)和 `protocol.ts`。

```typescript
// cmd:shelf:put — 结束进程,把标签放进收纳盒;main 先广播 evt:shelf:changed 再销毁 session
interface ShelfPutPayload { sessionId: string }
// Response: void。Errors:SessionNotFound、SessionBusy(agentPhase === 'working')

// cmd:shelf:restore — 在调用方窗口按原模板重开;Claude Code / Codex 带 --resume / resume
interface ShelfRestorePayload { entryId: string; cols: number; rows: number }
interface ShelfRestoreResponse { session: SessionInfo; resumed: boolean }
// 新 session 成功创建后才删条目;启动失败条目留着。Errors:EntryNotFound、SshProfileNotFound 及 cmd:session:create 的全部错误

// cmd:shelf:remove
interface ShelfRemovePayload { entryId: string }
// cmd:shelf:clear — payload 空
```

**Side Effects**:每次变化广播 `evt:shelf:changed`(`ShelfChangedPayload`:`{ entries: ShelfEntry[]; shelvedSessionId?: string }`),收纳时 `shelvedSessionId` 是刚收起的 session,此时它还在,窗口用它的信息画"滑进盒子"的动画。自动收纳由 main 每分钟按 `settings.behavior.shelveIdleAfterHours` 扫描,不经 IPC。

---

#### `cmd:session:get-scrollback`
获取 session 的 scrollback 缓冲。一般用于 owner 切换或窗口刷新。

```typescript
// Payload
interface GetScrollbackPayload {
  sessionId: string;
}
// Response
interface GetScrollbackResponse {
  scrollback: string;           // base64 编码
  byteCount: number;            // 解码后字节数
}
```

**Errors**:
- `SessionNotFound`

### 5.3 Bookmark / Path

#### `cmd:bookmark:add`
添加收藏。

```typescript
// Payload
interface AddBookmarkPayload {
  path: string;                 // 绝对路径,Main 会校验存在性
  displayName?: string;
  defaultTemplateId?: string;
}
// Response
interface AddBookmarkResponse {
  bookmark: Bookmark;
}
```

**Errors**:
- `PathNotExist`
- `PathNotDirectory`:路径是文件不是目录
- `BookmarkAlreadyExists`:已收藏

**Side Effects**:
- 写 bookmarks.json
- Path 可能从"临时"或"最近"被提升到"收藏"
- 广播 `evt:bookmarks:updated`、`evt:path:tree-updated`

---

#### `cmd:bookmark:remove`
```typescript
interface RemoveBookmarkPayload {
  pathId: string;
}
// Response: {}
```

**Errors**:
- `BookmarkNotFound`

**Side Effects**:
- 写 bookmarks.json
- 若该 path 当前有 session → 移到"临时"
- 否则 → 移到"最近"(若有历史)或消失
- 广播相关事件

---

#### `cmd:bookmark:rename`
```typescript
interface RenameBookmarkPayload {
  pathId: string;
  newDisplayName: string;       // 空字符串表示恢复默认(用路径最后一段)
}
// Response: {}
```

**Errors**:`BookmarkNotFound`、`InvalidName`

---

#### `cmd:bookmark:reorder`
```typescript
interface ReorderBookmarksPayload {
  orderedPathIds: string[];     // 必须包含所有现有 bookmark 的 id,数量一致
}
// Response: {}
```

**Errors**:
- `InvalidOrderList`:列表与现有不一致(漏了或多了 id)

---

#### `cmd:bookmark:set-default-template`
```typescript
interface SetDefaultTemplatePayload {
  pathId: string;
  templateId: string | null;    // null = 取消该路径的默认模板
}
// Response: {}
```

**Errors**:`BookmarkNotFound`、`TemplateNotFound`

---

#### `cmd:bookmark:pick-folder`
弹出原生文件夹选择器。**Main 调用,因为这是原生 OS UI**。

```typescript
// Payload
interface PickFolderPayload {
  defaultPath?: string;         // 选择器初始打开的位置
}
// Response
interface PickFolderResponse {
  path: string | null;          // 用户取消选择 → null
}
```

**Errors**:无

---

#### `cmd:path:remove-from-recent`
```typescript
interface RemoveFromRecentPayload {
  path: string;                 // 绝对路径
}
// Response: {}
```

**Errors**:`PathNotInRecent`

### 5.4 Template

#### `cmd:template:list`
```typescript
// Payload: {}
// Response
interface ListTemplatesResponse {
  templates: Template[];
  defaultTemplateId: string;
}
```

实际上 Renderer 不太需要单独调这个,snapshot 里已有。提供这个是为了"模板编辑后只刷新 templates"。

---

#### `cmd:template:create`
```typescript
interface CreateTemplatePayload {
  name: string;
  icon: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  shellFirst: boolean;
  postExitAction: 'close_session' | 'keep_shell' | 'hold';
}
// Response
interface CreateTemplateResponse {
  template: Template;            // 含分配的 id
}
```

**Errors**:
- `InvalidTemplate`:必填字段缺失或格式错误(`details` 字段说明哪个字段)

---

#### `cmd:template:update`
```typescript
interface UpdateTemplatePayload {
  templateId: string;
  partial: Partial<Omit<Template, 'id' | 'isBuiltin'>>;
}
// Response: {}
```

**Errors**:
- `TemplateNotFound`
- `BuiltinTemplateRestricted`:试图修改内置模板的不可改字段(目前是 `isBuiltin`、`id`)

---

#### `cmd:template:delete`
```typescript
interface DeleteTemplatePayload {
  templateId: string;
}
// Response: {}
```

**Errors**:
- `TemplateNotFound`
- `BuiltinTemplateNotDeletable`:不能删除内置模板
- `TemplateInUse`:有 session 正在用此模板(让用户先关闭 session)

---

#### `cmd:template:set-default`
```typescript
interface SetDefaultTemplatePayload {
  templateId: string;
}
// Response: {}
```

**Errors**:`TemplateNotFound`

#### `cmd:template:usage-list`
新建页各按钮的启动次数(ADR-034)。无 payload。模板按钮的 key 是模板 id,检测到的 shell 按钮是 `shell:<shellId>`。计数在 `cmd:session:create` 里累加,只反映用户自己的点击;存在 `template-usage.json`,最多 64 条,最久没点的先丢。renderer 用 `src/shared/template-usage.ts` 的 `frequentChoices` 决定哪几个是常用选项。

```typescript
interface ListTemplateUsageResponse {
  entries: { key: string; count: number; lastUsedAt: number }[];
}
```

### 5.5 Settings

#### `cmd:settings:get`
```typescript
// Payload: {}
// Response
interface GetSettingsResponse {
  settings: Settings;
}
```

---

#### `cmd:settings:update`
**部分更新**。Main 用深合并(deep merge)应用 partial。

```typescript
interface UpdateSettingsPayload {
  partial: DeepPartial<Settings>;  // 任意层级的部分更新
}
// Response: {}
```

**Errors**:
- `InvalidSettings`:校验失败(如字号超出 8-24 范围)。`details` 字段说明哪个字段错了

**Side Effects**:
- 校验 + 合并 + 写 settings.json(debounced 500ms)
- 广播 `evt:settings:changed` 给所有窗口
- 某些设置变化触发副作用:
  - `behavior.autoStart` 变 → 调用 PlatformAdapter.setAutoStart
  - `systemIntegration.explorerContextMenu` 变(V1.2)→ 调注册表

> **v1.3 起 `appearance.followSystemTheme` 已删除**(见软件定义书 ADR-009);renderer 不再发送此字段,main 端 schema 也不接受。

---

#### `cmd:settings:reset`
```typescript
// Payload
interface ResetSettingsPayload {
  confirmed: true;              // 必须显式传 true,防止误调用
}
// Response: {}
```

**Errors**:
- `ConfirmationRequired`:`confirmed !== true`

**Side Effects**:
- settings.json 被覆盖为默认
- 广播 `evt:settings:changed`

---

#### `cmd:settings:export`
```typescript
// Payload: {}
// Response
interface ExportSettingsResponse {
  filePath: string;             // 已写入的 zip 文件路径
}
```

**实现**:
- 调原生保存对话框让用户选位置
- 把 settings.json + bookmarks.json + templates.json 打包成 zip
- 不包含 recent.json(隐私考虑)

---

#### `cmd:settings:import`
```typescript
// Payload
interface ImportSettingsPayload {
  filePath?: string;            // 不传则弹原生文件选择器
  overwrite: boolean;           // false = 只导入不存在的项;true = 覆盖
}
// Response: {}
```

**Errors**:
- `FileNotFound`
- `InvalidImportFile`:zip 损坏或格式不对
- `IncompatibleVersion`:导入文件协议版本不兼容

**Side Effects**:
- 校验 + 应用 + 持久化
- 广播相关事件

---

#### `cmd:settings:open-data-dir` / `cmd:settings:open-log-dir`
```typescript
// Payload: {}
// Response: {}
```

**Side Effects**:
- 调 `shell.openPath()`

---

#### `cmd:settings:detect-shells`
```typescript
// Payload: {}
// Response
interface DetectShellsResponse {
  shells: ShellInfo[];          // 当前系统检测到的 shell
}
```

**Errors**:无

### 5.6 System

#### `cmd:system:show-in-explorer`
```typescript
interface ShowInExplorerPayload {
  path: string;                 // 文件或文件夹路径
  open?: boolean;               // true 且 path 是文件夹:打开文件夹本身
}
// Response: {}
```

**Errors**:`PathNotExist`

**Side Effects**:默认调 `shell.showItemInFolder()`,在父目录里选中。`open: true` 且 `path` 确实是文件夹时改调 `shell.openPath()` 打开它,失败再退回 `showItemInFolder()`。文件永远不走 `openPath`,因为那会用关联程序运行它。文件树右键的"在文件资源管理器中打开"用 `open: true`。

#### `cmd:fs:list-dir`
```typescript
interface ListDirPayload {
  path: string;                 // 目录绝对路径;SFTP 时可以是 ~ 开头
  sshProfileId?: string;        // 有值时通过 SFTP 列这个 profile 上的目录
  fresh?: boolean;              // 用户主动操作时为 true,跳过 SFTP 失败缓存。轮询不要设置
  interactive?: boolean;        // (v1.4) 允许 SFTP 登录时向本窗口弹提示(密码 / Duo / 主机密钥)。
                                // 挂载文件树、点重试、打开选择框时设置;定时轮询不要设置
}
type ListDirResponse =
  | { ok: true; entries: FileTreeEntry[]; truncated: boolean; path?: string }  // path: 展开 ~ 后的目录,只有 SFTP 返回
  | { ok: false; reason: DirFailure };   // FileTreeFailure 或 'no-client' | 'auth' | 'host-key' | 'connect' | 'no-sftp' | 'login-required'
```

**Errors**:无。常规失败走 `reason`,不 reject

**Notes**:`login-required`(v1.4)表示后台连接遇到了登录提示而这次请求不允许弹窗,连接在发出任何凭据前已断开。它像 `auth` 一样缓存到下一次 `fresh` 请求

#### `cmd:fs:rename`
```typescript
interface RenameEntryPayload {
  path: string;                 // 条目绝对路径
  newName: string;              // 新文件名,不含路径
}
type RenameEntryResponse =
  | { ok: true; path: string }
  | { ok: false; reason: FileTreeFailure };
```

**Errors**:无。目标已存在时返回 `exists`,绝不覆盖

**Side Effects**:在原目录内改名。本节的命令在 Link 远程窗口里都转发给 Host,因为路径和 SSH profile 都在 Host 上

#### `cmd:fs:delete`
```typescript
interface DeleteEntryPayload {
  path: string;                 // 本地条目绝对路径
}
type DeleteEntryResponse =
  | { ok: true }
  | { ok: false; reason: FileTreeFailure };
```

**Errors**:无。路径不存在返回 `not-found`;相对路径和盘符根返回 `invalid-name`;回收站拒收 (被占用、所在盘没有回收站) 返回 `unknown`

**Side Effects**:调 `shell.trashItem()` 移到回收站,从不永久删除。只用于本地路径,SFTP 文件树没有删除

#### `cmd:fs:read-pdf`
```typescript
interface ReadPdfPayload {
  path: string;                 // 本地或远端绝对路径,扩展名必须是可显示的文件类型
  sshProfileId?: string;        // 有值时通过 SFTP 读
  offset: number;               // 字节偏移,从 0 开始,之后用上次的 nextOffset
  length?: number;              // 想读的字节数,最多一块,默认一块(文本翻页用)
  fresh?: boolean;              // (v1.4) 用户刚点击了文件:跳过 SFTP 失败缓存并允许登录提示。自动刷新不要设置
}
type ReadPdfResponse =
  | { ok: true; base64: string; size: number; nextOffset: number | null; mtimeMs: number | null }  // nextOffset null 表示读完;mtimeMs 是刷新基线,服务器不给时 null
  | { ok: false; reason: DirFailure | 'not-pdf' | 'too-large' };
```

**Errors**:无。常规失败走 `reason`。不可查看的扩展名或非普通文件返回 `not-found`,PDF 文件头不是 `%PDF-` 返回 `not-pdf`,超过 256 MiB 返回 `too-large`

**Notes**:每块 1 MiB,放得进 Link 的 8 MiB 帧,慢速线路也不会超过 30 秒的命令超时。txt 和 json 没有 256 MiB 上限,大文件一次只读一页

#### `cmd:fs:write-text`
```typescript
interface WriteTextPayload {
  path: string;                 // 已存在的 .txt 或 .json 绝对路径,不支持 SFTP
  base64: string;               // 完整新内容,最多 4 MiB
  expected: { mtimeMs: number; size: number } | null;  // 开始编辑时的状态,null 表示强制覆盖
}
type WriteTextResponse =
  | { ok: true; mtimeMs: number; size: number }  // 下一次保存要带上的状态
  | { ok: false; reason: FileTreeFailure | 'changed' | 'too-large' };
```

**Errors**:无。常规失败走 `reason`。`changed` 表示文件在编辑期间被其他程序改过

**Notes**:写临时文件再 rename,失败时原文件不变。Link 下在 Host 上执行

#### `cmd:fs:stat-file` (v1.4)
```typescript
interface StatFilePayload {
  path: string;                 // 同 read-pdf 的路径门槛
  sshProfileId?: string;
}
type StatFileResponse =
  | { ok: true; size: number; mtimeMs: number | null }   // mtimeMs 在 SFTP 服务器省略 ACMODTIME 时为 null,这时只比较 size
  | { ok: false; reason: DirFailure | 'not-pdf' | 'too-large' };
```

**Errors**:无。常规失败走 `reason`

**Notes**:PDF 自动刷新每 1.5 秒(本地)/ 3 秒(远端)调一次。它永远是安静请求:不跳过 SFTP 失败缓存,不允许登录提示,所以轮询不会打扰用户;连接断了就一直返回缓存的失败原因,直到用户主动操作。Link 远程窗口里转发给 Host

---

#### `cmd:system:show-context-menu`

显示 OS 原生右键菜单。Renderer 可以渲染自己的菜单 UI(更轻量),也可以通过这个 API 用原生菜单(在右键复杂菜单时更顺手)。

V1 实现:**Renderer 自渲染菜单为主,这个命令仅用于"在 Explorer 中显示"等需要 OS 集成的菜单项**。具体形态在实现时定。

---

#### `cmd:system:get-build-type` (v1.3)

返回当前构建形态,供渲染端决定是否禁用「系统集成」类 UI(dev / portable
形态下经典右键菜单 / Win11 新菜单都不支持 — 注册表 / MSIX 操作均依赖
NSIS 安装产物)。

```typescript
// Payload: void
// Response
interface GetBuildTypeResponse {
  buildType: 'dev' | 'portable' | 'installed';
}
```

**判定逻辑** (`src/main/build-type.ts`):
- `app.isPackaged === false` → `'dev'`
- 进程含 `PORTABLE_EXECUTABLE_DIR` 环境变量 → `'portable'`
- 其余 → `'installed'`

**Side Effects**:无

---

#### `cmd:system:clipboard-read-text` (v1.3,勘误第二轮)

从系统剪贴板读取文本。

```typescript
// Payload: void
// Response
interface ClipboardReadTextResponse {
  text: string;                 // 空字符串表示剪贴板无文本内容
}
```

---

#### `cmd:system:clipboard-write-text` (v1.3,勘误第二轮)

把文本写入系统剪贴板。

```typescript
// Payload
interface ClipboardWriteTextPayload {
  text: string;
}
// Response
interface ClipboardWriteTextResponse {
  ok: boolean;                  // false = 主进程层面写失败(罕见)
}
```

**为什么走 IPC 而不是 navigator.clipboard.***:Electron 在 `file://`
上下文下 web 权限系统会拒掉 `clipboard-write`,我们的 permission handler
显式拒了同源以外的权限请求 → renderer 端写永远静默失败。改为走主进程
Electron `clipboard` 模块,绕开所有 web 权限层 + dev/prod 行为一致。

---

### 5.8 SSH 登录提示 (v1.4)

#### `cmd:ssh:askpass-answer`
回答 main 通过 `evt:ssh:askpass-prompt` 发来的一条登录提示。

```typescript
interface AskpassAnswerPayload {
  promptId: string;             // 来自事件
  answer: string | null;        // null = 用户取消,ssh 这次登录失败
}
// Response: boolean — 是否还有提示在等这个 id(迟到或重复的答案返回 false)
```

**Errors**:无

**Notes**:SFTP 连接在 Host 上,Link 远程窗口里转发给 Host。答案只在内存里走到 ssh 的 askpass 助手,不记录、不缓存;保存密码仍由 profile 管理

### 5.9 更新检查 (v1.5)

查的是 GitHub `Fanisting/ceteris` 的 latest release(跳过 draft 和 prerelease)。只报告状态和下载直链,不下载不安装;下载由 renderer 用 `cmd:system:open-external` 交给浏览器。两条命令都在 `LINK_LOCAL_ONLY_CHANNELS` 里:远程窗口里点也查本机这份安装。

```typescript
interface UpdateStatus {
  state: 'idle' | 'checking' | 'up-to-date' | 'available' | 'error';
  currentVersion: string;              // app.getVersion()
  update: {
    version: string;                   // 去掉 v 的 tag
    tag: string;
    name: string;
    htmlUrl: string;                   // 发布页
    publishedAt: string | null;
    downloadUrl: string;               // 本机系统和 CPU 对应安装包的直链;没有匹配时等于 htmlUrl
    assetName: string | null;          // null = 没有匹配的文件,downloadUrl 是发布页
  } | null;                            // 之后一次检查失败时保留
  checkedAt: number | null;            // 上次检查结束的时间戳
  error: 'network' | 'rate-limited' | 'http' | 'bad-response' | 'bad-version' | null;
  autoCheck: boolean;                  // 本构建 + 当前设置下是否在定时检查
}
```

#### `cmd:update:get-status`
无 payload,返回 `UpdateStatus`。窗口挂载时拉一次,之后跟 `evt:update:status-changed`。

#### `cmd:update:check-now`
无 payload,立刻检查一次,返回查完后的 `UpdateStatus`。同时到达的多次调用共用一个请求。任何 channel(stable / beta / dev)都可用。

**Errors**:`UpdateCheckUnavailable`(主进程没接上 UpdateChecker,只在测试装配里出现)。网络失败、GitHub 限流等不抛错,写进 `status.error`。

**选哪个文件**(`src/shared/update-check.ts` 的 `selectAsset`):Windows 给 Setup exe,portable 运行时给 Portable exe;macOS 按 CPU 给 arm64 或 x64 的 dmg;Linux 以 AppImage 启动给 AppImage,否则 Debian 系给 deb、Red Hat 系给 rpm,找不到再退到 AppImage。

### 5.10 远程设置引导 (ADR-032)

#### `cmd:guides:remote-setup-paths`
无 payload,返回随 Ceteris 一起安装的两份指南文件的绝对路径。renderer 把对应角色的路径拼进粘给 agent 的一行提示里,agent 自己读文件。安装版在 `<install>\resources\guides`(electron-builder extraResources,asar 外),dev 在仓库的 `guides/`。

```typescript
interface RemoteSetupGuidePathsResponse {
  host: string;     // remote-setup-host.md:这台电脑做 SSH 主机
  client: string;   // remote-setup-client.md:这台电脑去连另一台
}
```

不在 `LINK_LOCAL_ONLY_CHANNELS` 里:远端视图不提供这个引导(view-menu.ts 在远端视图只列视图),所以不会从远程窗口调用。

### 5.7 Explorer Integration (v1.3)

> Win11 新菜单(MSIX + `IExplorerCommand`)与经典菜单(HKCU 注册表)的状态
> 查询与开关。这里的状态**不持久化到 settings.json**(它本来就是操作系统
> 状态,不是用户偏好),每次都现场查注册表 / Appx / 证书 store。

#### `cmd:explorer-integration:get-status`

综合查询当前系统对 Ceteris 两种 Explorer 集成的状态。

```typescript
// Payload: void
// Response
interface ExplorerIntegrationStatus {
  buildType: 'dev' | 'portable' | 'installed';
  windowsBuild: string;                        // 例 "10.0.22621";非 Windows 时 ""
  win11ModernSupported: boolean;               // build >= 22000 才支持新菜单
  classic: 'enabled' | 'disabled' | 'unsupported';
  modern:  'enabled' | 'disabled' | 'unsupported';
  cert: {
    thumbprint: string;
    notAfter: string;                          // ISO
    subject: string;
    trusted: boolean;                          // Cert:\CurrentUser\TrustedPeople 是否含此证书
  } | null;
  package: {
    name: string;
    version: string;
    installLocation: string;
  } | null;
  modernUnsupportedReason: string | null;      // null = 支持
  classicUnsupportedReason: string | null;     // null = 支持
}
```

**`enabled/disabled/unsupported` 语义**:
- `enabled` · 当前系统状态已开启(经典 = HKCU key 存在;Modern = MSIX 已注册)
- `disabled` · 支持但未开启
- `unsupported` · 当前构建/系统不支持(dev / portable 一律 unsupported;经典在非 Windows 也 unsupported;Modern 还要求 build ≥ 22000)

**Side Effects**:无

---

#### `cmd:explorer-integration:set-classic`

开/关 Explorer 经典右键菜单(HKCU 注册表,无需 UAC)。

```typescript
// Payload
interface SetExplorerIntegrationPayload {
  enabled: boolean;
}
// Response
interface SetExplorerIntegrationResponse {
  ok: boolean;
  message: string;                             // 失败时的可读消息;ok=true 时为空
  status: ExplorerIntegrationStatus;           // 操作后的最新状态
}
```

**写入位置**:
- `HKCU\Software\Classes\Directory\shell\Ceteris` (右键文件夹)
- `HKCU\Software\Classes\Directory\Background\shell\Ceteris` (右键文件夹空白处)

**Errors**:不抛错,失败信息走 `ok=false / message`。

**Side Effects**:reg.exe add/delete;Explorer 立即生效,无需重启。

---

#### `cmd:explorer-integration:set-modern`

开/关 Win11 新菜单(MSIX 包 + 自签证书)。

```typescript
// Payload
interface SetExplorerIntegrationPayload {
  enabled: boolean;
}
// Response: SetExplorerIntegrationResponse (同 set-classic)
```

**开启流程**(`scripts/install-context-menu.ps1` 由主进程 spawn):
1. 把 `ceteris-cert.cer` 导入 `Cert:\CurrentUser\TrustedPeople`(首次需 UAC)
2. `Add-AppxPackage -Path CeterisContextMenu.msix -ExternalLocation <resources/context-menu>`
3. Explorer 在用户下次打开右键菜单时加载新菜单条目

**关闭流程**(`scripts/uninstall-context-menu.ps1`):
1. `Get-AppxPackage Ceteris.ContextMenu | Remove-AppxPackage`
2. 证书保留(下次安装免 UAC)

**前置条件**(若不满足 `ok=false`):
- `buildType === 'installed'`(dev/portable 不带 extraResources)
- `windowsBuild >= 22000`
- `resources/context-menu/{install.ps1,CeterisContextMenu.msix,ceteris-cert.cer}` 必须存在

**Errors**:不抛错,详细原因走 `message`。

---

#### `cmd:explorer-integration:get-ps-commands`

取出 set-classic / set-modern 当下会执行的等价 PowerShell 命令(供「复制
PS 命令」按钮 — 让用户自行在 Terminal 里跑或贴到他人机器上)。

```typescript
// Payload: void
// Response
interface GetPsCommandsResponse {
  installModern: string;
  uninstallModern: string;
  installClassic: string;
  uninstallClassic: string;
}
```

**Side Effects**:无

---

### 5.10 Agent CLI(ADR-034)

新建页用的 agent 检测。版本和升级命令(`cmd:agent:list-versions`、`cmd:agent:upgrade` 等)的类型见 `src/shared/protocol.ts`;这里只记新建页决定显示哪些 agent 的那一条。

#### `cmd:agent:list-installed`
payload 可选 `{ force?: boolean }`,`force` 为 true 时丢掉缓存重新扫 PATH(新建页 Agents 标题旁的刷新按钮)。每个有检测规则的内置 agent(`AGENT_UPDATE_SPECS`)一项,`installed` 表示 PATH 上找得到它的命令。只扫 PATH,不跑 `--version`、不联网,毫秒级返回;新建页等它回来再画 Agents 区,没装的不显示。没有检测规则的模板(自定义)不在列表里,新建页照常显示它们。只对本机文件夹有意义,SSH / WSL 文件夹的新建页不调用。

```typescript
interface ListInstalledAgentsResponse {
  agents: { templateId: string; installed: boolean }[];
}
```

### 5.11 Agent 更新时关掉再开回来 (ADR-037)

agent CLI 的版本检查和升级命令(`cmd:agent:list-versions`、`cmd:agent:upgrade`、`cmd:agent:check-now`、`cmd:agent:notice-action`、`cmd:agent:notices-ready`)的类型都在 `src/shared/protocol.ts` 的注释里。这一节只写整体重载加的两条命令。实现在 `src/main/agent-reload.ts`。

#### `cmd:agent:reload-plan`
```typescript
interface AgentReloadPlanPayload { templateId: string }
interface AgentReloadPlan {
  tabs: number;        // 该 agent 模板的本机终端数 (不算 SSH 和已退出的),全部会关掉再开回来
  running: number;     // 其中 agentPhase 为 working 的,开回来后会收到 "continue"
  blocked: number;     // 其中在等用户批准的;不发 continue
  otherTabs: number;   // 别的模板 (纯 shell) 里手动跑着同一个 agent 的终端数;不动,只提醒
  resumes: boolean;    // 这个 agent 有恢复对话的命令行参数
  inProgress: boolean; // 同一个 agent 的重载还在进行
}
```
renderer 在弹对话框前调,把数字写进正文。**Errors**:`TemplateNotFound`(不是内置 agent)。

#### `cmd:agent:reload`
```typescript
interface ReloadAgentPayload { templateId: string; pathId: string; cols: number; rows: number }
interface ReloadAgentResponse { started: boolean; tabs: number }
```
立即返回;之后的进度走 `evt:agent:update-notice`:`reloading`(tabs 关掉的终端数)→ `reloaded`(tabs 开回来的数、continued 收到 continue 的数、failedTabs 没开回来的数、updated 升级是否生效、to 重查后的已装版本)。升级终端开在 `pathId` 下、显示在发起窗口里(与 `cmd:agent:upgrade` 一样)。`cmd:agent:notice-action` 的 `action: 'reload'` 做同样的事,升级终端开在 home 目录。

**Errors**:`TemplateNotFound`;`InvalidPayload`(`pathId` 是 SSH 路径);`AgentBusy`(后台自动升级正在跑这个 agent)。同一个 agent 已在重载时不报错,`started=false`。

### 5.12 代码文件 lint (ADR-040)

文件查看器保存代码文件成功后调用,用用户本机装的 linter 检查刚保存的文件。只读,不改文件。实现在 `src/main/code-lint.ts`,类型在 `src/shared/code-files.ts`。Link 窗口里和保存一样转发给 Host。

#### `cmd:code:lint`
```typescript
interface LintPayload { path: string }   // 刚保存的文件的绝对路径;类型要有 linter (codeFileInfo)
type LinterId = 'ruff' | 'lintr' | 'sqlfluff';
type LintResponse =
  | { ok: true; tool: LinterId; problems: LintProblem[] }
  | { ok: false; tool: LinterId | null; reason: 'not-installed' | 'unsupported' }
  | { ok: false; tool: LinterId; reason: 'failed'; detail: string };
interface LintProblem {
  line: number; column: number;          // 从 1 起,与各 linter 的输出一致
  endLine?: number; endColumn?: number;
  severity: 'error' | 'warning' | 'info';
  code: string;                          // 规则名,如 F401、LT01、object_usage_linter;没有时为空串
  message: string;
}
```
- `not-installed`:PATH 上没有这个工具,也没有 `uvx`(ruff、sqlfluff)或 Rscript;或者 R 里没装 lintr 包。renderer 显示安装命令。
- `unsupported`:路径不是绝对路径,或这种文件没有 linter。

**Errors**:不抛。工具崩溃、超时(60 秒,经 uvx 时 180 秒)、输出读不懂都返回 `reason: 'failed'`,`detail` 是它 stderr 的第一行。

**Side Effects**:起一个子进程。ruff 带 `--no-fix --no-cache`;sqlfluff 从 stdin 读文本。

## 6. 事件清单 (Main → Renderer)

### 6.1 应用与窗口

#### `evt:app:state-changed`
应用整体状态变化(进入/退出纯托盘模式)。

```typescript
interface AppStateChangedPayload {
  hasWindows: boolean;
  totalSessions: number;
  activeSessions: number;
}
```

**频率**:窗口数变化或 session 总数变化时。Main 应做 throttle(100ms)避免风暴。

---

#### `evt:window:assigned-id`
窗口启动时,Main 通过这个事件确认 windowId(冗余于 URL,作为校验)。

```typescript
interface AssignedIdPayload {
  windowId: string;
  windowNumber: number;
}
```

**推送范围**:仅目标窗口

---

#### `evt:window:list-updated`
窗口列表变化(创建 / 关闭)。

```typescript
interface WindowListUpdatedPayload {
  windows: WindowInfo[];
}
```

---

#### `evt:window:focus-requested`
Main 命令本窗口聚焦(配合 `cmd:window:focus`)。

```typescript
interface FocusRequestedPayload {
  reason: 'session-click' | 'tray-click' | 'manual';
  // 可选:聚焦后该选中的 session
  selectSessionId?: string;
}
```

**推送范围**:仅目标窗口

### 6.2 Session

#### `evt:session:created`
新 session 出现(可能由本窗口创建,也可能由其他窗口)。

```typescript
interface SessionCreatedPayload {
  session: SessionInfo;
}
```

---

#### `evt:session:state-changed`
状态(active/idle/exited)、displayName、currentCwd、exitCode 等任意 SessionInfo 字段子集变化。

```typescript
interface SessionStateChangedPayload {
  sessionId: string;
  changes: Partial<SessionInfo>;   // 只含变化的字段
  full: SessionInfo;               // 完整最新状态(便于 Renderer 直接覆盖)
}
```

`changes.shellBusy`(ADR-023 修订):shell hook 报提示符时为 false,之后用户按 Enter 为 true,进程退出时为 null。没有 hook 的 shell 从不带这个字段。

**频率**:Main 做 throttle(50ms)。状态在 active/idle 间频繁切换时聚合。

---

#### `evt:session:output`
PTY 字节流输出。**仅推送给 owner**。

```typescript
interface SessionOutputPayload {
  sessionId: string;
  data: string;                  // base64 编码的字节流
  seq: number;                   // 自该 session 创建以来的序号(单调递增)
}
```

详细规格见 [第 8 节](#8-pty-字节流传输)。

---

#### `evt:session:exited`
PTY 进程退出。session 进入 'exited' 状态,**不立即销毁**(ADR-008:无时限保留直到用户右键关闭)。

```typescript
interface SessionExitedPayload {
  sessionId: string;
  exitCode: number;              // 退出码;信号导致的退出 exitCode 可能为 0,signal 字段补充信息
  signal?: number;               // node-pty 给的 signal number,Windows ConPTY 一般 undefined
}
```

随后会跟 `evt:session:state-changed`(state='exited' + exitCode + exitedAt 在 changes 里)。**不再有** `evt:session:tombstoned`。

---

> v1.2 起删除:`evt:session:cwd-changed` — cwd 变化已合并到 `evt:session:state-changed`(`changes.currentCwd`)。ADR-008 之后 cwd 变化**不再驱动 path 迁移**,所以 newPathId 字段也不再有意义。

---

#### `evt:session:owner-changed`
Owner 切换(claim / release / 窗口关闭)。

```typescript
interface SessionOwnerChangedPayload {
  sessionId: string;
  oldOwnerWindowId: string | null;
  newOwnerWindowId: string | null;
}
```

---

> v1.2 起删除:`evt:session:tombstoned` — ADR-008 砍掉墓地态,session 进程退出后直接进 'exited',无中间过渡。

---

#### `evt:session:destroyed`
Session 真正销毁(从内存和 UI 中消失)。

```typescript
interface SessionDestroyedPayload {
  sessionId: string;
  reason: 'user-closed' | 'pty-exited' | 'app-quit';
}
```

> v1.2 起 reason 字面量改:`'tombstone-expired'` 已删除;`'pty-exited'` 仅在内部 destroySession 调用链中出现(实际 V1 路径里 PTY 退出走的是 'exited' 状态,不直接 destroy,所以 renderer 实际只会看到 user-closed / app-quit 两种)。

### 6.3 Path / Bookmark / Template

#### `evt:path:tree-updated`
完整路径树变化。**任何 path 状态机迁移、bookmark 增删等都会触发**。

```typescript
interface PathTreeUpdatedPayload {
  tree: PathTree;
}
```

**频率**:Main 做 throttle(100ms)聚合多次变化。

---

#### `evt:bookmarks:updated`
Bookmarks 数据变化(顺序变、重命名等)。常和 `evt:path:tree-updated` 同时出现。

```typescript
interface BookmarksUpdatedPayload {
  bookmarks: Bookmark[];
}
```

---

#### `evt:template:list-updated`
模板列表变化。

```typescript
interface TemplateListUpdatedPayload {
  templates: Template[];
  defaultTemplateId: string;
}
```

### 6.4 Settings

#### `evt:settings:changed`
设置变化(任一字段)。

```typescript
interface SettingsChangedPayload {
  settings: Settings;            // 完整新设置
  changedKeys: string[];         // 变化的字段路径,如 ["appearance.theme", "behavior.autoStart"]
}
```

Renderer 收到后:
- 简单实现:替换全部设置,重渲染
- 优化实现:按 `changedKeys` 局部应用(主题、字号等可即时切换无重渲染)

### 6.5 SSH 登录提示 (v1.4)

#### `evt:ssh:askpass-prompt`
后台 SFTP 连接的 ssh 在登录时要用户回答(密码 / Duo 验证码 / 主机密钥确认)。**定向**发给发起这次连接的窗口(带 `interactive` 的那次 `cmd:fs:list-dir` 或带 `fresh` 的 `cmd:fs:read-pdf` 的 windowId),不广播。Renderer 弹 modal,用 `cmd:ssh:askpass-answer` 回答。

```typescript
interface AskpassPromptPayload {
  promptId: string;
  profileId: string;
  profileName: string;          // 弹窗标题用
  host: string;
  username: string;
  kind: 'secret' | 'text' | 'confirm';  // secret 不回显(密码 / 密钥口令);text 回显(Duo 验证码);confirm 是 yes / no
  prompt: string;               // ssh 给 askpass 的那一行,如 "(me@host) Passcode or option (1-3): "
  detail: string;               // 之前打到 stderr 的说明(Duo 的选项菜单等),可能为空
}
```

5 分钟没有回答视为取消。

#### `evt:ssh:askpass-closed`
一条提示不再需要答案(ssh 已断开或超时),收到对应 `promptId` 的窗口收起 modal。

```typescript
interface AskpassClosedPayload {
  promptId: string;
}
```

### 6.6 更新检查 (v1.5)

#### `evt:update:status-changed`
`UpdateStatus`(见 5.9)变化时广播给本机所有窗口:开始检查、查到新版本、已是最新、失败、自动检查开关变化。Link 远程窗口不收(和其它广播一样被跳过),它们用 `cmd:update:get-status` 拉。

### 6.7 Tray / 其他

#### `evt:tray:menu-action`
托盘菜单的某些项,Main 做完后想通知特定窗口。例如"在 X 窗口聚焦 Y session":

```typescript
interface TrayMenuActionPayload {
  action: 'focus-session' | 'create-window-with-path';
  data: Record<string, unknown>; // 因 action 而异
}
```

V1 简化:大多数托盘动作 Main 自己处理,不需要通知 Renderer。这个事件用得少。

---

## 7. 错误码

所有命令的 error 都遵循这个结构:

```typescript
class IPCError extends Error {
  code: string;                  // 见下表
  details?: Record<string, unknown>;  // 错误的具体信息
  
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
```

### 7.1 错误码表

| Code | 含义 | 常见原因 |
|------|------|---------|
| **通用** | | |
| `Internal` | Main 内部错误 | bug,需要看日志 |
| `InvalidPayload` | 请求 payload 不符合 schema | Renderer 实现错误 |
| `Timeout` | 操作超时 | 系统负载高 / 死锁 |
| **窗口** | | |
| `WindowNotFound` | 指定的 windowId 不存在 | 窗口已关闭 |
| `WindowNotRegistered` | 当前 Renderer 的 windowId Main 不认识 | 异常情况,通常重启窗口可解决 |
| `MaxWindowsReached` | 窗口数到上限 | 达到 V1 上限(20) |
| **Session** | | |
| `SessionNotFound` | 指定 sessionId 不存在 | session 已销毁 |
| `SessionAlreadyOwned` | session 已有 owner,不能 claim | 用 focus-owner 代替 |
| ~~`SessionNotTombstoned`~~ | v1.2 起删除(ADR-008) | — |
| ~~`SessionTombstoned`~~ | v1.2 起删除(ADR-008) | — |
| `NotOwner` | 当前窗口不是 owner | 无权对此 session 做操作 |
| `PtySpawnFailed` | node-pty 启动失败 | shell 不存在 / 权限 / native 模块 |
| `ShellNotFound` | 指定 shell 不存在 | 系统未安装 |
| `CwdNotAccessible` | 工作目录不存在 / 无权限 | 路径已删除 / 权限被改 |
| **更新检查** | | |
| `UpdateCheckUnavailable` | 主进程没有 UpdateChecker | 测试装配,或 index.ts 创建失败(看 main.log 的 UpdateChecker) |
| `InvalidDimensions` | 终端尺寸不合法 | cols/rows 越界 |
| `InvalidName` | 名称不合法 | 超长 / 空字符串 / 含控制字符 |
| **Path / Bookmark** | | |
| `PathNotFound` | path id 不存在 | 数据不一致 |
| `PathNotExist` | 文件系统上路径不存在 | 用户删了 |
| `PathNotDirectory` | 路径不是目录 | 误操作 |
| `BookmarkNotFound` | bookmark id 不存在 | 已删除 |
| `BookmarkAlreadyExists` | 路径已收藏 | 重复操作 |
| `PathNotInRecent` | 路径不在最近列表 | 已被淘汰 |
| `InvalidOrderList` | reorder 时列表不一致 | 实现 bug |
| **Template** | | |
| `TemplateNotFound` | template id 不存在 | 已删除 |
| `BuiltinTemplateNotDeletable` | 内置模板不可删 | 用户误操作 |
| `BuiltinTemplateRestricted` | 内置模板的某字段不可改 | 用户误操作 |
| `TemplateInUse` | 模板有 session 在用 | 先关 session |
| `InvalidTemplate` | 模板定义不合法 | 字段缺失 / 格式错误 |
| **Settings** | | |
| `InvalidSettings` | 设置不合法 | 数值越界 / 枚举错误 |
| `ConfirmationRequired` | 危险操作需要 confirmed=true | 实现错 |
| `FileNotFound` | 文件不存在(导入用) | — |
| `InvalidImportFile` | 导入文件损坏 | — |
| `IncompatibleVersion` | 协议版本不兼容 | 跨版本导入 |

### 7.2 Renderer 处理建议

```typescript
try {
  await ipc.invoke('cmd:session:create', payload);
} catch (e) {
  if (e.code === 'CwdNotAccessible') {
    // 友好提示用户路径不存在,问是否从收藏移除
  } else if (e.code === 'PtySpawnFailed') {
    // 显示具体错误,引导查看日志
  } else {
    // 通用错误提示
  }
}
```

---

## 8. PTY 字节流传输

### 8.1 推送策略

PTY 会产生大量小包(每次 PTY 写都触发 onData)。直接每次都通过 IPC 推送会有性能问题。

**Main 端实现**:
- 每个 session 有一个 16ms 的聚合窗口
- 16ms 内的所有 onData 字节合并成一个 buffer
- 每 16ms 发一次 `evt:session:output`,只发给 owner
- 若 owner 是 null,**不发送但仍写 scrollback**
- 若 owner 切换,新 owner 通过 `cmd:session:get-scrollback` 拉取历史,再开始接收增量

### 8.2 数据格式

字节流以 base64 编码后放进 JSON。

```typescript
{
  sessionId: string;
  data: string;     // base64
  seq: number;      // 单调递增,每个 evt:session:output 一次,从 0 开始
}
```

**为什么 base64**:
- JSON 不能直接传二进制
- Electron IPC 的 structured clone 支持 ArrayBuffer 但 React 处理路径不友好
- base64 简单可靠,16ms 聚合后开销可接受

**性能验证**:每秒输出 100KB(剧烈日志输出)情况下,base64 + JSON 序列化 + IPC 测试在 i5-8500U 上 < 5ms。够用。

### 8.3 Scrollback 大小限制

每个 session 的 scrollback 上限为 **2MB(原始字节)**。超过后旧字节被环形覆盖。

`cmd:session:get-scrollback` 返回的就是当前的环形 buffer 内容。

V1 不暴露 scrollback 大小给用户配置,V1.1 可加。

### 8.4 输入方向(Renderer → Main)

输入比输出小很多,直接通过 `cmd:session:send-input` 即时发送,不聚合。

---

## 9. 时序约束与并发

### 9.1 命令顺序

**同一窗口的命令**:Main 必须按发送顺序处理。Renderer 串行 invoke 即可保证。

**不同窗口的命令**:Main 用单一事件循环,自然串行,无并发问题。但 Renderer 不能假设两个窗口的操作有特定顺序。

### 9.2 命令幂等性

下列命令是**幂等**的(重复调用结果相同):
- `cmd:settings:update`(同样的 partial)
- `cmd:bookmark:remove`(再次调用第一次后:返回 BookmarkNotFound,但状态正确)
- `cmd:session:close`(不存在 / 已退出的 session 静默 no-op,见 SessionManager.closeSession)
- 所有 `*:get-*`

下列命令**不幂等**,Renderer 必须确保不重复发送:
- `cmd:session:create`
- `cmd:bookmark:add`
- `cmd:template:add`

实现建议:Renderer 在发起这些命令时,**禁用对应 UI 控件直到响应回来**。

### 9.3 事件顺序

Main 保证事件按时间顺序推送,但 Renderer 不能假设事件原子到达:
- `evt:session:state-changed`(含 `changes.currentCwd`)与 `evt:path:tree-updated`(若 path 因此变化)可能分两次到达;ADR-008 后 path 实际不再因 cwd 变化迁移,所以更少见。Renderer 仍应 idempotent 处理。
- `evt:session:created` 与 `evt:path:tree-updated`(若新 path 因此进入临时分类)可能分两次到达。

### 9.4 Snapshot 与增量事件的竞争

Renderer 启动时:
```
1. invoke('cmd:app:get-snapshot')  ← Snapshot 在时刻 T1 拍摄
2. registerEventListeners()         ← 监听从 T2 开始
```

T1 < T2 之间发生的事件可能漏掉。怎么办?

**解决方案**:Main 在生成 snapshot 时记录一个 `snapshotSeq`,每个事件也带 `seq`。Renderer 启动后:
1. 收到 snapshot,保存 `snapshotSeq`
2. 收到事件,对比事件 seq:
   - seq <= snapshotSeq → 已包含在 snapshot,丢弃
   - seq > snapshotSeq → 增量,应用

V1 简化:由于 Renderer 注册监听极快(< 100ms),T1-T2 间隔可忽略,不实现 seq 对比。如果实测有问题再加。

### 9.5 死锁防范

- Main 处理命令时**不允许**反过来 invoke Renderer。Main 永远不调 Renderer 的 invoke。
- Main 发事件给 Renderer **永远是单向 fire-and-forget**,不等回应。
- 这两条保证不会出现死锁。

### 9.6 长操作的处理

`cmd:session:create` 包含 PTY 启动,可能耗时几百毫秒到数秒(尤其是磁盘慢)。Renderer 不应在 invoke 阻塞 UI:

```typescript
// 错误:阻塞 UI
const result = await ipc.invoke('cmd:session:create', payload);
showSession(result.session);

// 正确:在 loading 状态下 invoke,失败回滚
setSessionPending(true);
try {
  const result = await ipc.invoke('cmd:session:create', payload);
  // 收到 evt:session:created 时实际显示
} catch (e) {
  setSessionPending(false);
  showError(e);
}
```

---

## 10. 版本演进

### 10.1 当前版本

`PROTOCOL_VERSION = 1`(在 `src/shared/protocol.ts` 中定义为常量)。

### 10.2 兼容策略

* **同 major 版本内只能向后兼容地增加**:
  - 新增 channel:可
  - 现有命令的 payload 增加可选字段:可
  - 现有命令的 response 增加字段:可
  - 现有事件的 payload 增加字段:可
  - 现有错误码的扩展:可

* **以下变更必须 bump major 版本**:
  - 删除或重命名 channel
  - 删除或重命名字段
  - 字段类型变化
  - 字段从可选变必填或反之
  - 错误码语义改变

### 10.3 版本不匹配

Renderer handshake 时检查:
```typescript
const { protocolVersion } = await invoke('cmd:app:get-protocol-version', {});
if (protocolVersion !== PROTOCOL_VERSION) {
  // 显示错误页面:
  // "Ceteris 守护进程是版本 X,但当前 UI 是版本 Y。请重启应用。"
  // 不要继续 handshake。
}
```

实际上 Main 和 Renderer 同一个安装包,版本应该总是一致。版本不匹配通常意味着:
- 用户跑了多个不同版本的实例(单实例锁应该防住)
- 部分文件被替换(应用损坏,引导用户重装)

---

## 附录 A:类型定义索引

所有共享类型定义在 `src/shared/types.ts`,IPC 协议常量(channel 名、错误码)定义在 `src/shared/protocol.ts`。

```typescript
// src/shared/types.ts
export interface SessionInfo { ... }
export interface PathNode { ... }
export interface PathTree { bookmarks: PathNode[]; temporary: PathNode[]; recent: PathNode[]; }
export interface WindowInfo { ... }
export interface Bookmark { ... }
export interface Template { ... }
export interface Settings { ... }
export interface ShellInfo { id: string; name: string; path: string; }

// src/shared/protocol.ts
export const PROTOCOL_VERSION = 1;

export const Channels = {
  // Commands
  CMD_APP_GET_SNAPSHOT: 'cmd:app:get-snapshot',
  CMD_SESSION_CREATE: 'cmd:session:create',
  // ... 全部 channel 名
  
  // Events
  EVT_PATH_TREE_UPDATED: 'evt:path:tree-updated',
  EVT_SESSION_OUTPUT: 'evt:session:output',
  // ... 全部 event 名
} as const;

export const ErrorCodes = {
  INTERNAL: 'Internal',
  INVALID_PAYLOAD: 'InvalidPayload',
  WINDOW_NOT_FOUND: 'WindowNotFound',
  // ... 全部错误码
} as const;
```

实现时,**禁止**在业务代码里直接写 channel 字符串字面量,**必须**通过 `Channels.XXX` 引用。这样改名时编译器能检查全部引用点。

---

## 附录 B:常见 Renderer 调用模式

### B.1 启动序列

```typescript
async function bootstrap() {
  // 1. 取 windowId
  const myWindowId = new URLSearchParams(location.search).get('windowId')!;
  
  // 2. handshake
  const { protocolVersion } = await ipc.invoke(Channels.CMD_APP_GET_PROTOCOL_VERSION, {});
  if (protocolVersion !== PROTOCOL_VERSION) {
    showVersionMismatchScreen();
    return;
  }
  
  // 3. 拉 snapshot
  const snapshot = await ipc.invoke(Channels.CMD_APP_GET_SNAPSHOT, { myWindowId });
  store.initialize(snapshot);
  
  // 4. 注册事件监听
  ipc.on(Channels.EVT_PATH_TREE_UPDATED, (event) => store.updatePathTree(event.payload.tree));
  ipc.on(Channels.EVT_SESSION_OUTPUT, (event) => terminalManager.write(event.payload.sessionId, event.payload.data));
  // ... 其他事件
  
  // 5. 渲染 UI
  renderApp();
}
```

### B.2 创建 session 的 UI 流程

```typescript
async function handleCreateSessionClick(pathId: string, templateId: string) {
  uiStore.setPendingNewSession(pathId, true);
  try {
    const { session } = await ipc.invoke(Channels.CMD_SESSION_CREATE, {
      pathId,
      templateId,
      takeOwnership: true,
    });
    // 不需要在这里更新本地状态 — evt:session:created 会广播
    // 但本窗口可以立即选中该 session
    uiStore.selectSession(session.id);
  } catch (e) {
    if (e.code === ErrorCodes.CWD_NOT_ACCESSIBLE) {
      showError(`路径 ${pathId} 不存在或无权限。是否从收藏移除?`);
    } else {
      showError(`创建 session 失败:${e.message}`);
    }
  } finally {
    uiStore.setPendingNewSession(pathId, false);
  }
}
```

### B.3 切换 session 显示的流程

```typescript
async function handleSessionTabClick(sessionId: string) {
  const session = store.getSession(sessionId);
  
  if (session.ownerWindowId === myWindowId) {
    // 本窗口已持有 → 简单切换显示
    uiStore.selectSession(sessionId);
  } else if (session.ownerWindowId !== null) {
    // 其他窗口持有 → 聚焦那个窗口
    await ipc.invoke(Channels.CMD_SESSION_FOCUS_OWNER, { sessionId });
  } else {
    // 无 owner → 接管
    const { scrollback } = await ipc.invoke(Channels.CMD_SESSION_CLAIM, { sessionId });
    terminalManager.replayScrollback(sessionId, scrollback);
    uiStore.selectSession(sessionId);
  }
}
```

---

## 附录 C:实现检查清单

实现 IPC 层时,逐项核对:

### Main 侧

- [ ] `protocol.ts` 中所有 channel 名 / 错误码作为常量导出,代码中不出现字符串字面量
- [ ] 每个 `ipcMain.handle` 包一层中间件:解 envelope、记日志、catch 错误转 `IPCError`、记响应耗时
- [ ] 所有事件推送通过统一的 `broadcast` / `sendTo` 函数,不直接调 `webContents.send`
- [ ] PTY 字节流的 16ms 聚合实现
- [ ] 所有 throttle / debounce 实现集中在一个工具模块
- [ ] handshake 阶段 Main 知道 windowId 后回 `evt:window:assigned-id` 校验
- [ ] 单窗口关闭 / 全部关闭 / 完全退出三个路径分别测过
- [ ] 错误必须包含 `code`、`message`、可选 `details`,不能 throw 普通 Error

### Renderer 侧

- [ ] 启动严格按 handshake 顺序(version → snapshot → 监听)
- [ ] 不重复 invoke 不幂等命令(UI 禁用)
- [ ] 所有 invoke 包 try-catch,按 error code 分支处理
- [ ] 终端 resize 事件 debounce(100ms)再发送
- [ ] 收到 `evt:settings:changed` 后局部应用变化(主题、字体、字号),不整页重渲染

### 测试

- [ ] 每个命令的 happy path 有单元测试(mock IPC)
- [ ] 每个错误码至少一个测试
- [ ] handshake 流程测试
- [ ] 字节流聚合测试(16ms 内多次 onData 合并为一次推送)
- [ ] 多窗口场景测试(owner 切换、广播覆盖所有窗口)

---

## 附录 D:Tab control pipe(ADR-024、ADR-033)

这条通道不走 Electron IPC,是 main 与 ceteris-tabs 插件的 MCP 服务器之间的命名管道。格式定义在 `src/shared/tab-control.ts`,插件 `extensions/ceteris-tabs/server/ceteris-tabs-mcp.mjs` 里有一份相同的纯 JS 实现,`tab-control-mcp.test.ts` 检查两边一致。

**连接**:每个标签的环境变量里有 `CETERIS_CONTROL_PIPE`(Windows 为 `\.\pipe\ceteris-control-<pid>-<随机>`)和本标签的 `CETERIS_CONTROL_TOKEN`。一条连接一个请求,30 秒内收不到完整请求就断开。

**请求**(一行 JSON,换行结尾,最多 256 KB):

```typescript
interface TabControlRequest {
  v: 1;
  token: string;
  op: 'list' | 'get' | 'templates' | 'create' | 'close' | 'input' | 'read' | 'rename' | 'open-file' | 'agent-session';
  args: Record<string, unknown>;
}
```

**回复**(一行 JSON):`{ ok: true, result }` 或 `{ ok: false, code, message }`。`code` 取值:`bad-request`、`disabled`、`unknown-token`、`not-coordinator`、`not-found`、`ambiguous`、`self`、`failed`。

| op | args | result |
|---|---|---|
| `list` | 无 | `{ folder, tabs: TabSummary[] }`,只含调用方文件夹的标签,按创建时间排序 |
| `get` | `tab` | `TabSummary` |
| `templates` | 无 | `{ id, name, command, args }[]` |
| `create` | `template?`(id 或名字,默认 shell)、`name?` | 新标签的 `TabSummary`;没有 owner 窗口,尺寸同调用方 |
| `close` | `tab` | `{ closed }`;不能是调用方自己 |
| `input` | `tab`、`text?`、`keys?`(见 `TAB_CONTROL_KEYS`)、`submit?`(有文本时默认 true) | `{ tab, typed, keys, submitted }`;不能是调用方自己 |
| `read` | `tab`、`lines?`(默认 80,最多 2000) | `{ tab: TabSummary, screen }` |
| `rename` | `tab`、`name` | `TabSummary` |
| `open-file` | `path`(绝对,或相对目标标签的当前目录)、`tab?`(默认调用方自己) | `{ tab: TabSummary, path, name, kind }`(ADR-033);只接受查看器认识的类型(`fileViewKind`:md、txt、json、tex、pdf、图片),文件必须已存在;SSH 文件夹拒绝。**任何活着的标签都能调**,不要求协调者,也不要求扩展打开 |
| `agent-session` | `agent`(`'claude-code'` 或 `'codex'`)、`sessionId`(UUID) | `{ tab, agent, sessionId }`(ADR-036);只记到调用方自己的标签上,收纳盒恢复时用它续聊。插件的 SessionStart 钩子每次启动 / resume / `/clear` 都调一次。**任何活着的标签都能调** |

`tab` 可以是完整 id、4 位以上的唯一 id 前缀,或唯一的标签名。

`open-file` 通过后,main 广播 `evt:file-view:open-requested`(payload `FileViewOpenRequestedPayload`:`{ sessionId, name, path }`)给所有窗口;每个窗口在自己的 pdf-view-store 里以 `sessionId` 为 key 调 `openPdf`,和在文件树里点击这个文件完全一样。显示着那个标签的窗口立刻看到文件;别的窗口只记一个视图,用户切过去时才显示。main 不读文件内容,只 `stat` 一次确认是普通文件。

**授权**:每次请求都检查扩展已开、令牌对应的标签存在、未退出、`coordinator === true`。顺序与拒绝码见 `TabControlService.authorize`。例外:`open-file` 和 `agent-session` 只检查令牌对应的标签存在且未退出(ADR-033、ADR-036,`TAB_CONTROL_ANY_TAB_OPS`)。

**协调者引导用的 IPC**:`cmd:extensions:tab-control-status`,payload 为空,回复 `TabControlStatus`(`{ pluginInstalled: boolean }`)。main 读 Claude Code 的插件登记表 `<CLAUDE_CONFIG_DIR 或 ~/.claude>/plugins/installed_plugins.json`,列出 `ceteris-tabs@ceteris` 就是 true;文件不存在或读不了都回 false。勾选协调者不走新 IPC:标签菜单在 `cmd:session:set-coordinator` 成功后在本窗口派发 `ceteris:coordinator-ticked` 事件,`detail.sessionId` 是被勾选的标签。角色走 `cmd:session:set-role`,payload `{ sessionId, role }`,role 为 `'coordinator'`、`'fintuner'` 或 null(回到 Worker);main 改名、设 `coordinator` 并广播 sessionStateChanged(changes 含 role、coordinator、displayName)。导览靠 DOM 属性找目标:`data-guide="ghost-tab"`、`data-quick-key`、`data-guide="new-tab"`、`data-session-id`、`data-guide="role"`、`data-guide="role-coordinator"`、`data-guide="coordinator-bar"`。

---

**文档结束**

> 本协议文档与 `软件定义书.md` 共同构成 Ceteris V1 的完整设计契约。
> 协议版本号在 `src/shared/protocol.ts` 中维护,每次有不兼容变更必须 bump 版本号并更新本文档。
