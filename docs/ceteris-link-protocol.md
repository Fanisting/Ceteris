# Ceteris Link 线路协议规格

> Host 与 Client 两台机器之间的通信契约。
> 与 `ipc-protocol.md` 的关系:那份定义"main 与 renderer 怎么说话",这份定义"两台机器怎么说话"。
> Link 承载的正是前者的消息,原样搬运,不做任何语义翻译。
>
> 文档版本:1.0 · 最后更新:2026-08-04 · `LINK_PROTOCOL_VERSION = 1`

---

## 1. 设计前提

Ceteris 的既有架构里,renderer 是**无状态观察者**,只通过两个原语与 main 通信:

```
invoke(channel, payload) -> Promise<result>     // cmd:*
on(channel, handler)                            // evt:*
```

因此"让另一台机器上的窗口显示本机的会话"不需要新的业务层,只需要**换一条传输通道**。Ceteris Link 就是这条通道。

三条由此推导出的设计约束:

1. **renderer 零改动**。远程窗口的 renderer 与本地窗口跑的是同一份代码,它无从得知自己连的是远端。
2. **Host 不理解业务**。LinkServer 只做解密、分帧、把命令交给既有 handler、把事件写回 socket。任何业务语义都不在 Link 层复制。
3. **远程客户端 = 虚拟窗口**。Host 把每个客户端注册进 WindowManager,于是 session ownership、事件广播、owner-only 字节流路由全部复用既有代码路径,零特例分支。

---

## 2. 分帧

TCP 是字节流不是消息流,需要自己分帧。

```
+----------------+---------------------------+
| uint32 BE 长度  |          载荷              |
+----------------+---------------------------+
      4 字节              长度字节
```

长度**不含**前缀自身。

| 阶段 | 载荷内容 | 上限 |
|------|---------|------|
| 握手 | 明文 UTF-8 JSON | 4 KiB(`LINK_MAX_HANDSHAKE_BYTES`) |
| 握手后 | `AES-256-GCM 密文 ‖ 16 字节认证标签` | 8 MiB(`LINK_MAX_FRAME_BYTES`) |

**为什么分两段上限**:握手阶段对端尚未证明自己掌握令牌,此时它能让我们分配的内存必须尽可能小(slowloris / length-prefix DoS 防护)。第一个加密帧验证通过即视为已认证,再放宽到业务需要的 8 MiB(`cmd:session:get-scrollback` 的响应最大约 2.7 MB)。

上限校验必须**先于**内存分配。一个伪造的 `0xFFFFFFFF` 前缀否则能让我们尝试 allocate 4 GiB。误连 HTTP 服务是最常见的触发场景:`"GET "` 的 ASCII 是 `0x47455420` = 1.2 GB。

实现:`src/main/link/frame-codec.ts`。

---

## 3. 握手与密钥派生

### 3.1 时序

```
Client                                              Server
  |                                                    |
  |---- [明文] hello { v, clientPub, clientNonce } --->|
  |                                                    | 派生会话密钥
  |<--- [明文] hello-ack { v, serverPub, serverNonce }-|
  | 派生会话密钥                                         |
  | raiseLimit()                                        | raiseLimit()
  |                                                    |
  |---- [密文 seq=0] auth { name, version, ipcVer } -->|
  |                                                    | 解开 = 认证通过
  |                                                    | 注册虚拟窗口
  |<--- [密文 seq=0] auth-ok { virtualWindowId, ... }--|
  |                                                    |
  |============ 之后全部是密文帧,双向 ==================|
```

### 3.2 密钥派生

两端必须逐字节一致,否则解密失败:

```
shared = X25519(ownPriv, peerPub)                          // 32 字节
ikm    = shared ‖ utf8(token)
salt   = clientNonce ‖ serverNonce                         // 16 + 16 字节
info   = utf8("ceteris-link/v1") ‖ clientPub ‖ serverPub
okm    = HKDF-SHA256(ikm, salt, info, 64)
c2sKey = okm[0..32)
s2cKey = okm[32..64)
```

设计要点:

| 决定 | 理由 |
|------|------|
| 令牌进 **IKM** 而非 salt | HKDF 的 salt 被设计成可公开,extract 阶段不对 salt 保密性提供保证。秘密材料必须走 IKM |
| 令牌**不上线路** | "能解开对方的帧"即认证证明。窃听者拿不到任何可离线爆破的材料 |
| 双方公钥进 **info** | transcript binding。攻击者改写明文握手包只会导致两端派生出不同密钥并立即失败,无法悄悄降级 |
| 每连接**临时**密钥对 | 前向保密。令牌日后泄露也解不开历史流量 |
| 两个方向**不同密钥** | 避免共用 (key, nonce) 空间。GCM 下 nonce 复用会直接泄露认证密钥 |
| 显式拒绝**全零共享秘密** | X25519 低阶点防御。OpenSSL 通常已拦,但标准不强制 |

### 3.3 帧加密

```
nonce  = 4 字节零 ‖ 8 字节 BE 计数器
frame  = AES-256-GCM(key, nonce, plaintext) ‖ tag
```

计数器由**接收方自己维护**,不从帧里读取。因此重放、乱序、丢帧一律表现为 GCM 认证失败,调用方必须立即断开。TCP 已保证有序,正常流量不受影响。

每条连接密钥全新,故计数器在该密钥下永不重复。这比随机 96-bit nonce 更安全(后者在 2^32 帧后有生日碰撞风险)。

实现:`src/main/link/link-crypto.ts`。

---

## 4. 消息类型

握手阶段(明文):

| type | 方向 | 说明 |
|------|------|------|
| `hello` | C → S | 协议版本、临时公钥、随机数 |
| `hello-ack` | S → C | 同上 |
| `handshake-error` | 双向 | 仅用于版本不匹配等与凭据**无关**的失败 |

握手后(密文):

| type | 方向 | 说明 |
|------|------|------|
| `auth` | C → S | 客户端名、版本、IPC 协议版本、可选 `preferredWindowId` |
| `auth-ok` | S → C | 分配的虚拟 windowId / windowNumber、Host 名与版本 |
| `auth-rejected` | S → C | IPC 版本不匹配、客户端数超限 |
| `cmd` | C → S | 转发一条 `cmd:*`,带自增 `id` |
| `cmd-result` | S → C | 对应 `id` 的结果或错误(保留 error code) |
| `evt` | S → C | 转发一条 `evt:*`,含完整 EventEnvelope |
| `ping` / `pong` | 双向 | 心跳,15 秒一次,50 秒无入站即判定连接已死 |
| `bye` | 双向 | 优雅关闭,收到后不触发重连退避 |

**凭据错误不发 `handshake-error`**:令牌不对时静默断开,不告诉对方"你的令牌错了"还是"这里根本没开 Host 模式"。

---

## 5. 命令路由

远程窗口发出的命令,按 `LINK_LOCAL_ONLY_CHANNELS` 白名单分流。判断标准一句话:**这条命令操作的是"我面前这块玻璃"还是"那台机器上的数据"?**

留在本地:`cmd:app:quit`、`cmd:window:*`、`cmd:system:clipboard-*`、`cmd:system:open-external`、`cmd:system:get-build-type`、`cmd:system:open-logs-dir`、`cmd:logger:ime-dump`、`cmd:link:*`。

其余一律转发。

**默认转发是刻意的**:新增的业务命令几乎总是操作 Host 数据,若默认本地执行,新命令会在远程窗口里静默地对错误的机器生效。白名单机制保证"新增 channel 时默认落在安全的一侧"。

`src/shared/link-routing.test.ts` 断言白名单每一项都真实存在于 `COMMAND_CHANNELS`,防止改名后静默失配。

### 5.1 windowId 的重写

Host 收到转发命令后,**强制**把信封的 `windowId` 改写为该连接的虚拟窗口 id:

```ts
const envelope = { windowId: this.virtualWindowId, requestId: randomUUID(), payload: msg.payload };
```

这是本协议最重要的一条安全约束。若原样信任客户端传来的 windowId,一个恶意客户端就能冒充 Host 上的任意窗口去 claim / release 它正在用的 session。

同理,`auth.preferredWindowId` 只在该 id 当前**既不是**真实窗口、**也不是**已注册虚拟窗口时才被接受。

---

## 6. 虚拟窗口的生命周期

```
客户端认证通过
   → WindowManager.registerVirtualWindow(send, preferredWindowId?)
   → 触发 onWindowCreated → 广播 evt:window:list-updated
   → 该 windowId 从此可以持有 session ownership

socket 断开(任何原因)
   → WindowManager.unregisterVirtualWindow(windowId)
   → 触发 onWindowClosed → sessionManager.handleWindowClosed(windowId)
   → 它持有的所有 session 转为无主,PTY 继续运行
   → Host 本机窗口可立即接管
```

最后一步是这个特性与 Ceteris 核心哲学("会话不随窗口死")的接榫处:远程客户端断线在 Host 眼里与本地关掉一个窗口**是同一件事**,走同一条代码路径。

### 6.1 重连保持身份

renderer 用 `window.api.windowId`(取自 URL query)与 `session.ownerWindowId` 比对来判断"这个终端归不归我"。所以:

- Client 的本地窗口用 Host 分配的虚拟 windowId 作为自己的 id(`createWindow` 的 `forcedWindowId`)。
- 重连时 `auth.preferredWindowId` 带上旧 id,Host 复用它。
- 于是重连只需 `webContents.reload()` 一次:renderer 重新握手、重新拉 snapshot、身份不变,之前接管的 session 仍然是它的。

若每次重连都换新 id,renderer 重连后会认为自己一个 session 都不持有,进而去 claim 那些**其实还是它自己的** session,拿到一堆 `SessionAlreadyOwned`。

---

## 7. 事件路由的两处偏离

Link 引入后,`ipc.ts` 的 `broadcastEvent` 有两处偏离"发给所有 BrowserWindow"的直觉:

1. **跳过远程绑定窗口(Client 侧)**。这类窗口的 store 由 Host 推来的事件驱动。若本机守护进程也往里塞自己的 path 树和 session 列表,两份互不相干的状态会互相覆盖,表现为侧栏诡异闪烁、标签页凭空出现又消失。

2. **补上虚拟窗口(Host 侧)**。远程客户端不是 BrowserWindow,`getAllWindows()` 看不到它们,必须显式遍历。

定向推送(owner-only 的 `evt:session:output`)走 `sendEventToWindowId`,由 `WindowManager.deliverEvent` 自动区分目标是本机 webContents 还是一条 TCP 连接。

---

## 8. 版本演进

`LINK_PROTOCOL_VERSION` 进了 HKDF 的 info 串,**版本不同必然派生出不同密钥**。因此不存在"跨版本勉强通信"的中间状态,握手阶段直接比对并明确报错。

同 major 版本内允许:新增消息 type(老端忽略未知 type)、现有消息新增可选字段。

必须 bump:删除 / 重命名消息 type 或字段、字段类型变化、加密参数变化。

---

## 9. 已知的协议层限制

- 单 Host 同时最多 `LINK_MAX_CLIENTS = 8` 个客户端(与 WindowManager 的 20 窗口上限呼应)。
- 无消息压缩。PTY 输出经 base64 后膨胀 4/3,实测在终端交互场景下带宽不是瓶颈,不值得引入压缩带来的 CRIME 类风险面。
- 命令转发超时固定 30 秒,不可配置。
