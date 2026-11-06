# IME-1 · 中文 IME 偶发"按标点冲刷一大段历史输入"

**状态**:**workaround 已实施(2026-05-18),探针已二次升级(2026-05-18 当晚),监控中** — `compositionend` 延迟 16ms 清空 helper-textarea,核心逻辑在 `src/shared/ime-textarea-workaround.ts`,7 条护栏单测就位。探针不再 console.warn 每条 EV(噪音过大且 DevTools 没开就丢现场),改为 ring buffer + LEAK 触发时 IPC dump 到 main `logger.ime` 落盘 `%APPDATA%/Ceteris/logs/ime-YYYY-MM-DD.log`。LEAK 判定从"`data.length > 20`"升级为"`data.length > 20 AND taLen ≥ data.length + 8`",排除"正常长 IME 提交"的误报(2026-05-18 用户实例:24 字一次性输入,head/tail/taTail 三字段完全一致)。
**优先级**:P1(影响中文用户日常输入体感,但偶发性;切英文输入法即恢复)
**首次报告**:2026-05-16,用户日常使用 Ceteris 时偶发,凭对话框输入残影确认
**复现率**:偶发,不是每次都触发;仅在中文输入法开启时;切英文输入法立即消失

---

## 现象

中文输入法(已确认在 Windows 微软拼音上复现)开启时,按 `，` `。` `、`(或"一些其他按键")偶发触发:终端突然冲刷出一段重复的历史输入文字,看起来像"粘贴"了之前的内容,但又不一定走粘贴逻辑。

用户视角:"按动的时候会意外粘贴一段文字,当然也不一定是粘贴逻辑,反正就是会冲刷出一堆字"。复现样本(用户在对话框直接打字,IME 状态下连按标点):每按一个标点,前面的整段文字几乎完整重复一遍,后面再追加这一次按下的标点 → 内容指数级增长。

切到英文输入法 → 现象消失。

## 调研结论:根因在 `@xterm/xterm@5.5.0` 自带的 CompositionHelper

我们这一侧 (`src/renderer/components/TerminalView.tsx`) 干净:

- L755 `attachCustomKeyEventHandler` 内 `if (ev.isComposing || ev.keyCode === 229) return true` — IME composition 期间所有按键透传 xterm,我们的 Ctrl+F / Ctrl+Shift+V 拦截路径**不会**打断 IME 状态机。
- L1065 `term.onData(data)` → `encodeStringToBase64(data)` → IPC `session:send-input`。**无任何二次累加 / 缓存 / replay**。
- 整个组件**没有**手写的 `composition*` / `paste` / `input` 事件监听去碰 helper-textarea。

→ 我们没引入这个 bug,但也没 workaround 它。

漏洞链(`node_modules/@xterm/xterm/src/browser/`):

### 漏洞 1 — helper-textarea 几乎从不清空

`Terminal.ts:1063-1068`:

```ts
// If ctrl+c or enter is being sent, clear out the textarea.
if (result.key === C0.ETX || result.key === C0.CR) {
  this.textarea!.value = '';
}
```

**整个 xterm 只在按 Enter (CR) 或 Ctrl+C (ETX) 时清 textarea**。普通字符、IME 提交、退格、方向键、其他控制键路径下 `textarea.value` 都一直累加,直到用户按一次 Enter 才清掉。

中文 IME 用户长时间不按 Enter(在 Claude Code / aider 等 TUI 内的多行编辑场景)时,helper-textarea 可以累到几百几千字符。

### 漏洞 2 — `compositionend` 用 `substring(start)` 取从开头到 textarea 末尾

`CompositionHelper.ts:127-176`(简化):

```ts
private _finalizeComposition(waitForPropagation: boolean): void {
  this._isComposing = false;
  if (!waitForPropagation) {
    const input = this._textarea.value.substring(
      this._compositionPosition.start,
      this._compositionPosition.end
    );
    this._coreService.triggerDataEvent(input, true);
  } else {
    // ↓ 中文输入几乎全走这个分支
    const currentCompositionPosition = { ...this._compositionPosition };
    this._isSendingComposition = true;
    setTimeout(() => {
      if (this._isSendingComposition) {
        this._isSendingComposition = false;
        currentCompositionPosition.start += this._dataAlreadySent.length;
        let input;
        if (this._isComposing) {
          input = this._textarea.value.substring(start, end);   // 有界
        } else {
          input = this._textarea.value.substring(start);        // ⚠️ 无上界
        }
        this._coreService.triggerDataEvent(input, true);        // → 我们的 onData
      }
    }, 0);
  }
}
```

`_compositionPosition.start` 在 `compositionstart()` 那一刻记录 `textarea.value.length`,**整个生命周期只在新一轮 compositionstart 触发时才重置**。

### 触发条件(解释了"偶发性")

当 `start` 与 textarea 实际状态对不齐时,`substring(start)` 会把历史累加都取出来发一遍:

1. **两次 `_finalizeComposition` 嵌套** — 前一个 setTimeout(0) 还没跑,新 compositionstart 已经把 `_compositionPosition.start` 改成新值。前一次 setTimeout 跑起来时读到的是新的 `_dataAlreadySent`,offset 算错。
2. **`_handleAnyTextareaChanges` 与 `_finalizeComposition` 的 setTimeout 交错** — keydown 229 + `!isComposing` 的路径(微软拼音把 `，` `。` `、` 当 punctuation auto-convert 直送 textarea,**不一定走 compositionstart**)走 `_handleAnyTextareaChanges`,它内部用 `diff = newValue.replace(oldValue, '')` —— **这是字符串 replace 不是 diff**,当 textarea 历史里恰好出现重复子串时 diff 算错。
3. **`_dataAlreadySent` 在 compositionstart 重置为 `''`**,但 setTimeout 闭包内 `currentCompositionPosition.start += this._dataAlreadySent.length` 读的是当前最新的 `_dataAlreadySent`,跨 composition 时序错乱时会算成 0 → start 不动 → substring 多取。

相关上游 issue 提示:
- `xtermjs/xterm.js#3191` "input characters can be duplicated" → 对应代码里 `_dataAlreadySent` 的补丁,但本 case 露出的是该补丁覆盖不到的另一条路径。
- `xtermjs/xterm.js#3679` `_inputEvent` 与 keydown 交互的 race。

5.5.0 / 当前 master 这两块代码均未本质改动,升 xterm 不是省事路线。

## Workaround 方案(已设计,未实施)

### 第一步:埋探针确认

在 `TerminalView.tsx:1065` 的 `term.onData` 内加一次性日志:

```ts
const dataHandler = term.onData((data) => {
  if (data.length > 20) {  // 单次 IME 提交极少 > 20 字
    const ta = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    console.warn('[IME-LEAK]', {
      len: data.length,
      head: data.slice(0, 60),
      tail: data.slice(-30),
      taLen: ta?.value.length,
      taTail: ta?.value.slice(-60),
    });
  }
  // 原有逻辑...
});
```

复现后看日志:`taLen` 涨到几百几千 + `data` 恰好是 textarea 尾段的子串 → 确认假说。

### 第二步:挂一个 `compositionend` 兜底清空

在 `term.open(container)` 之后立刻:

```ts
const helperTa = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
if (helperTa) {
  helperTa.addEventListener('compositionend', () => {
    // 等 xterm 自己的 setTimeout(0) 跑完再清,不抢它的 substring 读取窗口
    setTimeout(() => { helperTa.value = ''; }, 16);
  });
}
```

代价/语义:
- textarea 持续保持空 → 下次 compositionstart 时 `_compositionPosition.start = 0`、`substring(0)` 取到的就是真·本次 composition 内容,无法"溢出到历史"。
- 时序必须晚于 xterm 自己的 setTimeout(0)。用 16ms(一帧)是经验保守值;0ms 会抢在 xterm 的 substring 读取之前清空,**会把当次输入也吞掉**。如果证据显示 xterm 还有更长的延迟路径,放宽到 32ms。
- xterm 的 `_handleAnyTextareaChanges` 也用 `oldValue / newValue` 算 diff,我们在 compositionend 之后清空,不会影响它在 compositionstart 之前的 oldValue 快照。

### 不推荐路径

- **升 `@xterm/xterm`** — master 这两块代码未本质改动,且会同时引入 webgl addon / 其他破坏性变更,不如本地 workaround。
- **fork xterm 修 CompositionHelper** — 维护成本高,且我们对 `_isComposing` / `_isSendingComposition` 状态机的所有 race 边缘 case 没把握能改对。

## 不在本工单范围

- 中文 IME 候选框定位漂移(那是 `updateCompositionElements` 内的 left/top 计算,与本 bug 是不同的代码路径)。
- 切换主题 / 字号时 IME 候选框样式不同步(同上)。

## 待办

- [x] 第一步埋日志(2026-05-16 已加 PROBE A / PROBE B,见下"测试步骤")
- [x] 第二步实施 workaround,加 changelog 一条(2026-05-18 — 决策:不等复现证据,
      理由见下"实施决策记录")
- [x] 写护栏单测防止未来误删 listener(`src/shared/ime-textarea-workaround.test.ts`,
      7 条覆盖延迟生效 / 不抢 substring 窗口 / 连按合并 / detach 清理 pending 等)
- [x] 探针升级:ring buffer + 持久化 LEAK 判定升级(2026-05-18 当晚,见下"探针 v2 升级")
- [ ] 跑回归:确认 Enter / Ctrl+C 清 textarea 路径仍工作,中文长段输入不丢字
      (手动,中文 IME 必须人测)
- [ ] **观察期**:dev / beta 版本运行两周(2026-05-18 → 2026-06-01),
      不再依赖 DevTools — 读 `%APPDATA%/Ceteris/logs/ime-*.log`,**无报警则推进**下一项
- [ ] 观察期通过后,**移除两个探针**(grep `IME-1 PROBE` / `IME-LEAK` / `IME-EV`
      一次性清掉,连同 `ime-probe-ring.ts` / `LOGGER_IME_DUMP` channel /
      `logger.ime` 通道一起退役);若期间再现 LEAK,在此工单加复现证据 +
      分析新 race 路径
- [ ] 跟一下 xterm.js 上游 issue,如果将来上游修了,把本 workaround 删掉
      (届时护栏测试也一并移除,或改成"断言上游已修")

## 探针 v2 升级(2026-05-18 当晚)

**触发**:用户在没开 DevTools 的情况下报告 `[IME-LEAK]` 出现,但 console 里只有
"Object" 占位 — 字段全丢,定位不了哪条 race。同晚补打一次现场 `len=24
head=tail=taTail=24 字`,确认这是"正常一次性长 IME 提交"被探针误报为 leak。
两个问题:**(a) 阈值粗糙、(b) 现场易失**。

**实施**:

1. **LEAK 判定升级** — `src/shared/ime-probe-ring.ts#isLikelyHistoryFlush`:
   - 原条件:`data.length > 20`
   - 新条件:`data.length > 20 AND taLen >= data.length + 8`
   - 物理意义:textarea 必须比 data 严格"多出富余" — 否则 textarea 内容就是
     data 本身,是正常长输入,不是历史冲刷

2. **EV 改 ring buffer + LEAK 一次性 dump**:
   - PROBE B 的 `composition* / keydown(229)` 不再 `console.warn`,改 push 到
     `imeProbeRing`(capacity=50,满了覆盖最老)
   - PROBE A 检测到 LEAK 时:push 一条 `ev='leak'` 到 ring,drain 整个 ring
     一次性 IPC 发到 `cmd:logger:ime-dump`,main 端 `logger.ime` 落盘
     `%APPDATA%/Ceteris/logs/ime-YYYY-MM-DD.log`(按日切、5MB rotate、保 7 天,
     与 `llm` 通道同套设施,不 mirror console)
   - 仍保留一次 `console.warn('[IME-LEAK]', ...)` 第一时间在 DevTools 可见

3. **新文件 / 文件变更**:
   - 新:`src/shared/ime-probe-ring.ts`(57 行,纯函数 + duck-typed)
   - 新:`src/shared/ime-probe-ring.test.ts`(10 条护栏单测覆盖 ring 满覆盖
     / drain 清空 / `isLikelyHistoryFlush` 边界)
   - 改:`src/shared/protocol.ts`(加 `LOGGER_IME_DUMP` channel + payload/response)
   - 改:`src/main/logger.ts`(`Channel` 加 `'ime'`,加 `logger.ime(...)` 方法)
   - 改:`src/main/ipc.ts`(handler 接 dump 后调 `logger.ime`)
   - 改:`src/renderer/components/TerminalView.tsx`(PROBE A/B 改造)

**怎么读 `ime-*.log`**:

设置页 → 数据 → "打开日志目录"(或 `cmd:system:open-logs-dir`),找
`ime-YYYY-MM-DD.log`。每条 LEAK 是一行 JSON:
```
2026-05-18T22:00:01.234Z [INFO] [ime-probe] leak dump session=<id> t=501654.0 entries=27 {"meta":{...},"entries":[{...},...,{"ev":"leak",...}]}
```
按 docs 里的"3 条 race 路径对照表"看 entries 末尾(最后一条 `ev:'leak'`)前面
的 EV 序列即可定位。

**预期日志体积**:LEAK 偶发,每次 dump ~3-5KB;`ime-*.log` 日均预计 ≤ 100KB,
5MB 限制下绰绰有余。

**退役条件**:同上面"观察期"待办,workaround 真正生效则一并删 `ime-probe-ring.*`
/ `LOGGER_IME_DUMP` channel / `logger.ime` 通道。

## 实施决策记录(2026-05-18)

**决策**:不等复现证据,直接实施 workaround + 保留探针监控。

**理由**:
1. workaround 是治根(漏洞 1 — textarea 几乎从不清空)而非对症,对三条
   race 路径同时有效,不依赖具体命中哪条
2. 复现成本高:文档自己写了"重复 20-30 次 / 给重度用户用 1-2 天",
   ROI 不如直接 ship workaround + 探针监控
3. workaround 唯一硬约束是"16ms 不能抢在 xterm `setTimeout(0)` substring
   读取窗口之前" — 这个用**正常中文输入不丢字**就能验证,不需要复现 bug
4. 探针保留作为上线后监控:若 workaround 没盖到的 case 触发,Console
   `[IME-LEAK]` 一眼可见,比"等复现再上"反应更快

**护栏设计**:
- 核心逻辑下沉到 `src/shared/ime-textarea-workaround.ts`(AGENTS.md 5.1
  red line — renderer 不写测试,所以纯函数必须放 shared)
- duck-typed `ImeTextareaLike` 接口,测试用 fake textarea + `vi.useFakeTimers`,
  不引入 jsdom / happy-dom 依赖
- 7 条测试覆盖:延迟生效 / 不抢 substring 窗口 / 默认 16ms /
  连续 compositionend 合并 setTimeout / detach 清理 listener /
  detach 取消 pending / 自定义 timer 注入

---

## 测试步骤(2026-05-16 探针就位后)

### 已埋的两个探针

`src/renderer/components/TerminalView.tsx`:

- **PROBE A** — `term.onData` 内,`data.length > 20` 时打 `[IME-LEAK]`,带 data 头尾 + textarea 末尾,用来抓"一次输入冲刷一大段"的实证。
- **PROBE B** — `term.open(container)` 之后给 `.xterm-helper-textarea` 挂 `compositionstart` / `compositionupdate` / `compositionend` / `keydown(229)` 监听,打 `[IME-EV]`,用来判断 race 走了哪条路径。

两个探针都用 `console.warn`,在 DevTools console 直接 filter `IME-` 即可。

### 环境准备

1. `npm run dev` 启动开发版 Ceteris(electron-vite dev,自带 hot reload + DevTools)
2. 任意打开一个 session(默认 PowerShell 即可,或推荐进一个 TUI 比如 `claude` / `aider` / `nano`,因为复现要"长时间不按 Enter")
3. **打开 DevTools**(Ceteris 的渲染进程窗口里 `Ctrl+Shift+I`)→ Console tab → 过滤栏输入 `[IME-`
4. **确认 Windows 输入法已切到"微软拼音"**(任务栏右下角语言指示器),不要用搜狗/QQ 等第三方 IME — 本 bug 只在微软拼音上复现过

### 用例 1:冒烟(英文输入法 / 基线)

切英文输入法 → 在终端里随便敲一长串字符,按几次 Enter。

**预期**:Console **完全没有** `[IME-` 开头的日志。如果有任何 LEAK 或 EV 触发,说明探针逻辑写错或阈值订低了,先回来修探针,**别继续测**。

### 用例 2:中文 IME 正常路径

切微软拼音 → 在终端里打一句"今天天气真好啊" → 按 Enter。

**预期**(按顺序看 `[IME-EV]`):
1. `start` taLen=0(或某个上次残留值)
2. 若干次 `update` data 不为空,taLen 逐次增长
3. `end` data="今天天气真好啊",taLen 约等于这一串的长度
4. 没有 `[IME-LEAK]`
5. 按 Enter 之后,**下一次** `start` 看到的 taLen 应该被清回 0(对应漏洞 1 文档说的"Enter 才清空")

这一步只是确认探针工作正常 + 正常路径下 textarea 会被 Enter 清掉。

### 用例 3:复现 bug(关键)

按文档原始复现样本走:

1. 切微软拼音
2. 在终端里**连续打多段中文,中间不按 Enter**(比如打个三五十字的段落,模拟在 Claude Code 对话框里写一大段需求)
3. 此时观察 `[IME-EV]` 的 taLen 字段 — 应该一路涨到几十~几百
4. 现在**连按标点 `,` 或 `。` 或 `、`**,每按一次留 1-2 秒间隔
5. 重复 4-5 次,运气好就能触发

**bug 发生时预期看到**:
- `[IME-LEAK]` 日志,`len` 远大于你这一次按下的标点字数(可能几十几百)
- 日志里 `taLen` 已经累积到几百
- **`tail` 字段(LEAK 数据末尾)出现在 `taTail` 里**(也就是 data 末尾是 textarea 末尾的子串)— 这是"textarea 历史被原样取出"的直接证据
- 同时观察终端可视区:对应这次按键冲刷出来一段重复的历史文字

**对照 3 条 race 路径**(看 LEAK 前面紧挨着的 EV 是什么):

| LEAK 之前看到的 EV 序列 | 命中假说 |
|---|---|
| 单独 `kd229`,**没有** `start`/`end` | race 路径 2:微软拼音标点 auto-convert 走 `_handleAnyTextareaChanges` 的 `replace` diff |
| `start` → `start` → `end` 嵌套 | race 路径 1:两次 `_finalizeComposition` 重叠 |
| 正常 `start` → `end`,但 `end` data 远短于 LEAK len | race 路径 3:`_dataAlreadySent` 跨 composition 重置时序错乱 |

### 用例 4:负对照(英文 IME 同操作)

切英文输入法 → 重复用例 3 的"连续打字 + 连按标点"动作(英文键盘的 `,` `.` 即可)。

**预期**:**完全没有** `[IME-LEAK]`。如果英文下也能触发说明假说不成立,要回头查根因。

### 证据归档

复现后:

1. DevTools Console 右键 → **Save as...**(导出全量 console log),保存为 `docs/issues/ime-1-evidence-<日期>.log`
2. 截一张 LEAK 触发瞬间的终端可视区截图(看得到那段被冲刷出来的重复文字)
3. 在本工单加一行:`确认日期 / 微软拼音版本 / Windows 版本 / 命中哪条 race 路径`
4. 拿到 1 次确认证据就可以推进到 workaround 实施;**别在拿到证据前提交移除探针的 PR**

### 如果复现不出来

- 本 bug 是**偶发**的,文档明确说"不是每次都触发"。先按用例 3 重复 20-30 次再下结论
- 换不同的中文输入习惯试:连续按同一个标点 / 中英标点交替 / 输入到一半切换光标位置 / IME 候选框弹出时按标点
- 实在不行,把探针留在版本里,**给一名重度中文用户**装这个 dev build,让他正常用 1-2 天再收日志
