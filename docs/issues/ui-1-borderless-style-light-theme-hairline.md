# UI-1 · 无边框风格在浅色主题下的 hairline 补强(设计 RFC)

**状态**:**待决(2026-05-18)** — 当前主代码已统一走「无边框」方向,本文档讨论是否、以及如何为浅色主题(`rose-pine-dawn` / `cutie`)单独补一层 hairline。**不是 bug 工单**,是设计方向 RFC。
**优先级**:P3(视觉打磨,不影响功能;深色主题无此需求)
**触发对话**:2026-05-18 用户在删完 4 处残留 border 后主动提出 — 「常规设计理念一般是有一点点淡边框好,但就像现在这样保留无边框也好」。
**关联代码**:
- `src/renderer/styles/global.css:842`(`.sidebar`,无边框声明)
- `src/renderer/styles/global.css:920-925`(sidebar-category,无横线声明)
- `src/renderer/styles/global.css:1325-1394`(tab-bar / tab,无底线 / 无竖线声明)
- `src/renderer/styles/global.css:2770-2805`(BETA-037 浅色主题已有的特化规则,可对照扩展)

---

## 1. 当前状态(2026-05-18 收尾)

`global.css` 内现已有 4 处显式注释把「无边框版」固化为整体规则:

| 行号 | 区块 | 处理方式 |
|---|---|---|
| 847 | `.sidebar` 与主区 | 不画 1px,靠 `--color-bg-secondary` vs `--color-bg-primary` |
| 924 | `.sidebar-category` 之间 | 不画横线,靠 `category-header` 自身节奏区分 |
| 1330 | `.tab-bar` 底部 | 不画底线,靠背景差区分 |
| 1377 | `.tab` 之间 | 不画竖线,靠 hover/selected 背景差区分 |

本日(2026-05-18)又删掉了 4 处遗漏的 border(`.sidebar-footer` / `.terminal-statusbar` / `.settings-header` / `.settings-nav`),整体语言统一。

---

## 2. 现象:为什么浅色主题下"无边框"是一个 open question

### 物理事实

深浅主题里 `--color-bg-secondary` 与 `--color-bg-primary` 的对比度天然不对称:

| 主题 | secondary | primary | ΔL\*(感知差) |
|---|---|---|---|
| `rose-pine` (深) | `#1f1d2e` | `#191724` | ~3.5 |
| `catppuccin-mocha` (深) | `#181825` | `#1e1e2e` | ~3.0 |
| `rose-pine-dawn` (浅) | `#fffaf3` | `#faf4ed` | ~1.2 |
| `cutie` (浅) | `#fff0f5`(估) | `#fff8fb` | ~0.9 |

深色主题下 ΔL\* ≈ 3 已经能形成清晰的"区块感";浅色主题 ΔL\* < 1.5 几乎看不出层级 — 这就是 "Apple HIG 浅色模式给 sidebar 留一条 hairline,深色模式不给"的物理依据。

### 用户原话锚点

- 2026-05-18 用户的判断:**之前删边框是因为"实在是太明显了"** — 指 Ceteris 当时用 `var(--color-bg-elevated)` 这个**实色 token** 画 1px,在浅色底上呈"实墨水线",而不是"hairline 应有的若有若无"。
- 同日用户复述主流取向:**"一般是有一点点淡边框好"**,但**当前无边框也好** — 两者都成立,选择没塌方。

### 现状结论

当前"完全无边框"的方案在深色主题上是 2024–2026 最佳实践,**深色主题不需要任何改动**。浅色主题(尤其 `cutie`)则游离在两端之间:背景差不足以承担区块分层,但又不想退回"实色 1px 线"。

---

## 3. 2024–2026 主流设计趋势调研

| 产品 / 设计语言 | 布局区块 | 组件边界 | 浅色 vs 深色 |
|---|---|---|---|
| Linear | tonal surface | 1px @ ~6% alpha | 浅色更明显,但仍是 hairline |
| Vercel / Geist | tonal surface | 1px solid `--accents-2` | 浅色刻意留下结构感 |
| Arc / Raycast | tonal surface | 几乎无 | 两者均极简,但暗主题为主战场 |
| macOS Sequoia | tonal surface | 1px @ ~10% alpha (separator) | 浅色有 hairline,深色更弱 |
| Material You | tonal surface(色调阶梯) | 极少 | 深色优先设计 |
| iOS 18 / iPadOS 18 | tonal surface | hairline list separator | 浅色有,深色减弱 |

**收敛后的主流模式**:
1. 布局区块(sidebar / header / nav)用 **tonal surface**(背景色阶)分层 — **不画 solid border**;
2. 组件级边界(按钮 / 输入框 / 浮卡)用 **hairline**(1px,带 alpha 的半透明色) — 而**不是实色 token**;
3. 浅色主题倾向**多保留一层 hairline**,深色主题倾向**减弱或省略**;
4. 极个别极简流派(Arc / Raycast)走全程 tonal surface — 但他们的主战场是深色。

---

## 4. 方案讨论

### 方案 A:保留现状(全部无边框,跨主题统一)

- **优点**:语言极致统一;符合 Arc / Raycast 极简流派;深色主题完美。
- **代价**:浅色主题(尤其 `cutie`)在 ΔL\* < 1.5 的区块边界上视觉"漂浮",sidebar / statusbar / settings-nav 与主区之间缺乏自然分层。
- **何时合理**:如果产品定位明确**深色主题为主**,浅色仅作"也能用"的兜底。

### 方案 B:引入 `--color-hairline` token,只在浅色主题生效

新增 token,默认值为空字符串或 `transparent`,浅色主题覆盖为带 alpha 的细线色:

```css
:root {
  --color-hairline: transparent;
}

[data-theme='rose-pine-dawn'] {
  --color-hairline: color-mix(in srgb, var(--color-text-primary) 8%, transparent);
}

[data-theme='cutie'] {
  --color-hairline: color-mix(in srgb, var(--color-text-primary) 6%, transparent);
}

/* 4 处布局区块边界:深色主题 token 为 transparent → 视觉上等于无边框 */
.sidebar-footer { border-top: 1px solid var(--color-hairline); }
.terminal-statusbar { border-bottom: 1px solid var(--color-hairline); }
.settings-header { border-bottom: 1px solid var(--color-hairline); }
.settings-nav { border-right: 1px solid var(--color-hairline); }
```

- **优点**:深色主题视觉零变化(token 为 transparent);浅色主题获得 2024–2026 主流的 hairline 分层;一处加 token,4 处统一引用,后续新增区块零思考。
- **代价**:多一个 token 需要维护;`color-mix` 的浏览器兼容性 — Electron Chromium 已支持,但要注意 token 默认值兜底。
- **何时合理**:如果产品要做"跨深浅主题都站得住"的体验,**这是最对齐主流的方案**。

### 方案 C:浅色主题加深 `--color-bg-secondary`,继续走纯 tonal surface

把 `rose-pine-dawn` / `cutie` 的 `--color-bg-secondary` 往主色阶再压一档(比如 `cutie` 从 `#fff0f5` 调到 `#ffe4ec`),拉大 ΔL\* 到 ~3 左右,继续靠背景差分区。

- **优点**:语言依然是"纯 tonal surface",一致性最强;**真正解决根因**(背景差不足),而不是补线。
- **代价**:`cutie` 主题已经是「少女心粉色」精调过的调色板(见 `feedback_cutie_theme_must_be_girly_pink.md`),改 surface 色阶可能动到整体色彩平衡;`rose-pine-dawn` 是上游主题,改了就脱离规范。
- **何时合理**:有调色板设计带宽 + 愿意为浅色主题做专属背景层级时。

---

## 5. 推荐与待决

**推荐**:**方案 B**(hairline token,只在浅色主题生效)。

理由:
- 深色主题零打扰 — token 透明,DOM 不动,等同方案 A;
- 浅色主题精准补强 — 用 `color-mix(... 6-8%, transparent)` 而**不是** `--color-bg-elevated` 这种实色 token,直接对齐 macOS / Linear / iOS 当前主流;
- 一次性引入,后续任何新增区块只要写 `border: 1px solid var(--color-hairline)`,跨主题自动 do-the-right-thing;
- 与现有 BETA-037 浅色主题特化路径(`global.css:2770-2805`)是同一思路,不需要新模式;
- 与"原有 4 条 border 已删"的最近动作**不冲突** — 那次删的是**实色 1px 线**,这次加的是**透明度细线**,视觉重量差一个数量级。

**待决事项**:
1. token 命名(`--color-hairline` / `--color-separator` / `--color-divider`,哪个更对齐你已有的 token 命名习惯?)
2. 浅色主题 alpha 取值(`cutie` 6% 与 `rose-pine-dawn` 8% 是初稿,实际要在两个主题里目测)
3. 应用范围 — 4 处布局区块全上,还是先在 sidebar / statusbar 试点?
4. 是否同步给 `.settings-row` 的 `border-bottom`(line 1896)也换 token — 它当前用 `--color-bg-elevated` 实色,深色主题没问题,但浅色主题密集行间也会偏"实"

不动也是合理选择(方案 A);只是想把 trade-off 写在纸上,等真的决定要做时不必重新论证。
