# dsh-tui 迭代建议（第二轮）

> **当前执行稿：[`ITERATION-3.md`](./ITERATION-3.md)**。本文是审查记录：P0 正确性项已采纳；光标 `y: rows-4` 与 `wrap="truncate-end"` 已否决，不要按本文处方实施。

> 审查日期：2026-08-18
> 审查范围：`tui-runner.mjs` / `tui-ui.mjs` / `tui-startup.mjs` / `cordis.patch.yml` / `package.json`
> 验证方式：与 DSH 底层源码交叉核对（`~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/`）＋ Ink 7.1.1 布局/`useCursor` 源码核对
> 总体结论：第一轮（ITERATION.md）的核心正确性问题已基本落地，架构与 DSH API 契约全部对得上。**本轮剩余问题集中在「Ink UI 引入后，旧 readline 交互路径与 Ink 打架」以及「手算行数/光标坐标与 Ink 真实布局不符」**。P0 共 5 项（3 个 bug + 光标 + 滚动），均落在两个源文件内、可独立改。

---

## 一、结论概览

| 级别 | 项 | 文件 | 一句话 |
|---|---|---|---|
| 🔴 P0 | tool/result 错误判定读错字段 | runner | 工具失败被当成功显示 |
| 🔴 P0 | 裸 spinner/光标控制污染 Ink alternate screen | runner | TTY 下屏幕闪烁/乱码 |
| 🔴 P0 | 无防重入，turn 运行中可并发 runTurn | runner/ui | 连按 Enter 输出重复交错 |
| 🔴 P0 | 光标定位不准确（偏下） | ui | Y 用内容高度而非终端高度 |
| 🔴 P0 | 滚动不丝滑 | ui | 滚动单位错位 + 折行未计数 + 双帧闪烁 |
| 🟡 P1 | `/model` effort 校验不完整 | runner | 无 reasoning 能力的模型也接受 effort |
| 🟡 P1 | 空 stdin 跳过 `flushAndExit` | runner | 会话可能不落盘 |
| 🟢 P2 | 死代码/未声明依赖/若干打磨 | runner/ui | 清理与健壮性 |

---

## 二、P0 真实 Bug（必改）

### 2.1 `tool/result` 错误判定读错字段 → 工具失败显示为成功

- **位置**：`tui-runner.mjs:539`（`consumeEvent` 的 `tool/result` 分支）
- **证据**：
  - 事件信封是 `{ type, seq, time, data, surfaceOp, sourceEventSeqs }`（见 `dsh-session` 的 `Session.append`），工具结果全部在 `data` 下。
  - `dsh-agent-loop` 的 `appendToolResult` 把错误放在 `data.error`（形如 `{ name, code }`）；权威判法见 `dsh-session-telemetry`：`event.data.message.content[0].isError === true`。
  - 当前代码 `if (ev.error)` 读到的是事件顶层 `error`，**永远为 `undefined`** → 红色 `[tool error]` 分支是死代码。
- **后果**：bash 等工具执行失败时，被绿色 `[tool] 名 · 耗时 · 预览` 当成功展示，用户被误导。
- **修复**：
  ```js
  const failed = ev.data?.error !== void 0 || ev.data?.message?.content?.[0]?.isError === true;
  if (failed) {
    say(style("red", `[tool error] ${name}${elapsed} · ${ev.data?.error?.code ?? "error"}`));
  } else {
    const preview = trunc(toolResultText(ev), 80);
    say(style("green", preview ? `[tool] ${name}${elapsed} · ${preview}` : `[tool] ${name}${elapsed}`));
  }
  ```

### 2.2 裸 spinner/光标控制污染 Ink 的 alternate screen

- **位置**：`tui-runner.mjs` 的 `startSpinner`（338-357）、`stopSpinner`（324-336）、`createCursorGuard`（198-214）
- **证据**：
  - 三者守卫条件都是 `interactive`（= TTY），**没有判断 `ui` 是否已挂载**；而 `ui = startTuiUi(...)` 恰好在 `if (interactive)` 里挂载（870-893），所以 `interactive === true ⟺ ui 已挂载`。
  - `runTurn` 里 `startSpinner()` 无条件调用（562），`consumeEvent` 里 `stopSpinner()` 无条件调用（483/517/533）。
  - Ink 用 `alternateScreen: true` 接管终端（`tui-ui.mjs:341`），`startSpinner` 却直接 `io.stdout.write("\r") + spinner` 每 80ms 直写 stdout，与 Ink 整帧渲染穿插。
- **后果**：TTY 下每次对话出现闪烁、残影、光标错乱；`\x1b[?25l/h`、`clearLine`、`cursorTo` 作用在 alternate screen 上与 Ink 冲突。
- **修复**：让整套裸 spinner/光标逻辑在 `ui` 挂载时 no-op。Ink 的 `state.turn === "running"` 已有自己的 `⋯ ` 忙态提示（`tui-ui.mjs:305`）。
  ```js
  const startSpinner = () => {
    if (ui || !interactive || spinnerOn) return;  // ui 挂载时直接返回
    ...
  };
  const stopSpinner = () => {
    if (!spinnerOn) return;
    ...
    if (interactive && !ui) { clearLine(...); cursorTo(...); }  // 仅裸 readline 模式才清行
    cursor.show();
  };
  ```
  （`cursor.hide/show` 也可在内部对 `ui` 提前短路，或直接让 `startSpinner` 在 ui 模式下不碰 cursor。）

### 2.3 无防重入：turn 运行中按 Enter 会并发 `runTurn`

- **位置**：`tui-runner.mjs` 的 `handleLine`（732-801）/`runTurn`（558-603）；`tui-ui.mjs` 的 `submit`（186-192）与 `useInput` return 分支（231-249）
- **证据**：
  - Ink 里是 `void submit(input)`，`submit` → `api.submit` → `onSubmit` → `handleLine` → `runTurn`，全程无 busy 守卫。
  - `let busy = false`（`tui-runner.mjs:297`）只被 `setBusy` 写（360），**全文从未被读取**——标志已预留但没接上。
  - 两个并发 `runTurn` 各从自己捕获的 `firstSeq` 起 `streamTurn`，重叠区间的事件被 `consumeEvent` **消费两遍**。
- **后果**：生成中再按 Enter，第二消息入 inbox、第二个 `streamTurn` 同时 drain，助手输出与 `[tool]` 行重复、交错。
- **修复**：二选一（推荐都做）：
  - runner 侧：`handleLine` 开头 `if (busy) return;`（并把 `setBusy` 的写入语义理顺——busy 表示「正在跑 turn」）。
  - ui 侧：`submit` 开头 `if (state.turn === "running") return;`，运行中直接吞掉 Enter。

---

## 三、P0 界面问题（光标 + 滚动）

> 这两个问题同源：`tui-ui.mjs` 手算行数与光标坐标，跟 Ink 的真实布局对不上。Ink 布局是**底部锚定**的——根 `Box` 是 `height:"100%"`，transcript 区是 `flexGrow:1`，输入框和状态栏永远贴在屏幕底部。

### 3.1 光标定位不准确（偏下）

- **位置**：`tui-ui.mjs:157-160`
  ```js
  setCursorPosition({
    x: Math.min(2 + displayWidth(input), ...),
    y: visibleDocumentRows + scrollHintRows + menuRows + 1   // ❌ 用内容高度
  });
  ```
- **根因**：
  - 输入行真实 Y 恒等于 **`rows - 4`**（从下往上：状态栏 2 行 + 输入框下边框 1 行 + 0 基索引 1），与内容多少、是否菜单、滚动位置都无关。
  - 代码却用 `visibleDocumentRows + scrollHintRows + menuRows + 1` 拼，这是一个**随内容和滚动位置漂移**的值，所以光标大部分时间不落在输入框上，一滚动就跳。
- **放大因素**：`transcriptRowCount`（47-49）写死 “You ›”=3 行、其它=1 行，但 `transcriptLine` 的 `<Text>` **没设 `wrap`**，Ink 默认折行；长行折成 2/3/4 行后 `visibleDocumentRows` 与真实渲染行数严重不符，光标进一步漂移（并可能把输入框/状态栏顶出屏）。
- **修复**（锚定底部，不数内容行）：
  ```js
  setCursorPosition({
    x: Math.min(3 + displayWidth(input), Math.max((process.stdout.columns ?? 80) - 1, 0)),
    y: rows - 4   // 状态栏2 + 输入框下边框1 + 1(0基索引)
  });
  ```
  - X 也顺手修正：输入框 `paddingX:1` + 提示符 `"› "` 两列，光标列应为 `3 + displayWidth(input)`，现在是 `2 + …` 少算 1 列。

### 3.2 滚动不丝滑

四个因素叠加：

1. **滚动单位错位**：`scrollOffset` 是「条目数」，但视口 `availableDocumentRows` 和步长 `pageSize`（152-154）是「行数」；条目高度不一（1 行 vs 3 行），再叠加**折行未计数**，滚一格移动的物理行数忽大忽小 → 一跳一跳。
2. **自动滚动用 `useEffect`，跑在渲染之后**（175-184）：新行到达时先按**旧 offset** 渲染一帧，effect 再改 offset 触发第二帧，肉眼是「先跳一下再回位」的闪烁。
3. **每次滚动整段重渲染、无 memo**：`document` 数组（144-150）与 `transcript.map(...)` 每帧重建，长会话下每次滚轮/每个流式 chunk 都是 O(n) 协调，掉帧。
4. **鼠标滚轮走裸 stdin 正则解析**（92-121）：`prependListener("data")` 与 Ink 的 stdin 读取并存，`pending` 跨 chunk 拼转义序列较脆弱；每滚一次全量 setState + 全量渲染。

- **修复方向**：
  - transcript 的 `<Text>` 加 `wrap="truncate-end"`（或固定 `maxWidth`），让每条确实是 1/3 行，行数计算与真实渲染对齐——**这一条同时治光标和滚动**；
  - 光标 Y 改成 `rows - 4`（见 3.1），去掉对 `visibleDocumentRows`/`scrollHintRows` 的依赖；
  - 自动滚动改 `useLayoutEffect`（或在 render 内同步推导 offset），消除「先渲染旧偏移再修正」的双帧闪烁；
  - `React.memo` 包单行渲染 + `useMemo` 缓存 `document`/`matches`，滚轮 tick 只更新 `scrollOffset`，不再重建全表；
  - 视口/步长统一用「行」为单位（或把 `scrollOffset` 改为「距底部行数」）。

---

## 四、P1 正确性 / 健壮性

### 4.1 `/model` effort 校验不完整

- **位置**：`tui-runner.mjs:663-684`
- **证据**：
  ```js
  if (efforts.length > 0 && !efforts.some(e => e.id === effortArg)) { ...reject... }
  next.reasoningEffort = ReasoningEffortId(effortArg);
  ```
  当模型 `efforts` 为空（不支持 reasoning effort）时，`efforts.length > 0` 为 false → **任何 effort 都被静默接受**并写入 settings，直到下次真正请求才被 `resolveCallFor` 抛 `UNSUPPORTED_REASONING_EFFORT`。
- **修复**：`efforts.length === 0 || !efforts.some(...)` 时都拒绝并提示。

### 4.2 非 TTY 且 stdin 为空时跳过 `flushAndExit`

- **位置**：`tui-runner.mjs:803-923`
- **证据**：stdin 0 字节时 `rl.on("close")` 先于 `ready = true` 触发，`stdinClosed = true` 但 `drain()` 未被触发；`ready` 置位后 `queue.length === 0`，第 923 行也不触发 → `flushAndExit` 不执行。
- **后果**：`printf '' | dsh --profile tui --new`（或 `< /dev/null`）时新建会话头不 `flush`，进程靠事件循环自然退出。
- **修复**：`ready = true` 之后补一句 `if (stdinClosed) await flushAndExit(0);`

---

## 五、P2 死代码 / 清理

| # | 项 | 位置 | 说明 |
|---|---|---|---|
| 5.1 | `wantBanner` 死代码 | runner:305 / 895 | 硬编码 `false` + `if (wantBanner) io.stdout.write(BANNER)`，banner 实际走 Ink `initialState.banner`。删掉。 |
| 5.2 | `pickModel` 的 `rl.question` 不可达 | runner:634-636 | TTY 下 `/model` 被 Ink 菜单拦截、非 TTY 下提前 return；一旦流程变动会因 `rl === null` 抛 TypeError。 |
| 5.3 | `busy` 标志只写不读 | runner:297/360 | 见 2.3，应接入 `handleLine` 守卫。 |
| 5.4 | `commander` 未声明依赖 | startup:1 / package.json | `package.json` 只声明 `ink`/`react`，`commander` 靠 DSH runtime hoisted node_modules 解析；`nodeLinker` 策略一变即断。 |
| 5.5 | `displayWidth` CJK 覆盖不全 | ui:68-83 | 漏 CJK 扩展 B（U+20000+）与 emoji，光标列会偏。 |

---

## 六、优化建议表（非 bug）

| 项 | 位置 | 建议 |
|---|---|---|
| 会话标题串行拉取 | `printSessionList`（runner:242-249） | 最多 20 次 `inspect` 逐个 `await`，可 `Promise.all` 并行或再降上限。 |
| markdown 只对整段替换着色 | `consumeEvent`（runner:507-511） | 流式增量是原文，已知取舍；非前缀分支 `\n${colorizeMarkdown(text)}` 会重打全文，极端场景闪屏。 |
| reasoning 替换不清理旧内容 | runner:490-496 | `reasoning.startsWith(printed)` 失败分支只追加不清理（edge case）。 |
| 滚轮裸 stdin 解析 | ui:92-121 | 与 Ink 并存较脆弱，可评估 Ink 的 `useInput` 是否已支持 mouse 或改用更稳的解析。 |

---

## 七、优先级总表

| 优先级 | 项 | 工作量 | 收益 |
|---|---|---|---|
| 🔴 P0 | 2.1 tool 错误判定 | 小（~3 行） | 正确性 |
| 🔴 P0 | 2.2 spinner 与 Ink 打架 | 小（加 `!ui` 守卫） | 屏显正确性 |
| 🔴 P0 | 2.3 防重入 | 小（busy 守卫） | 输出正确性 |
| 🔴 P0 | 3.1 光标锚定底部 | 小（`y: rows-4`） | 手感质变 |
| 🔴 P0 | 3.2 滚动顺滑 | 中（wrap + 单位统一 + memo） | 手感质变 |
| 🟡 P1 | 4.1 effort 校验 | 小 | 正确性 |
| 🟡 P1 | 4.2 空 stdin flush | 小 | 健壮性 |
| 🟢 P2 | 5.x 死代码/依赖 + 6.x 打磨 | 小-中 | 清理 |

**一句话**：第一轮的功能正确性已经到位；这一轮把「Ink 迁移后遗留的裸 readline 交互」和「手算布局 vs Ink 真实布局」这两类问题清干净，TUI 就能从「能用」到「丝滑好用」。

---

## 八、建议执行顺序与验收

1. **先做 3.1 + 3.2**（同一批，都改 `tui-ui.mjs`）：`wrap="truncate-end"` + 光标 `y: rows-4` + 滚动单位统一 + `useLayoutEffect`/`memo`。验收：真实终端里光标钉在输入框、滚轮/PgUp/PgDn 顺滑、长行不把输入框顶出屏。
2. **再做 2.1 + 2.2 + 2.3**（`tui-runner.mjs`，小改动）：验收——故意让 bash 失败看是否红色 `[tool error]`；TTY 下对话无闪烁；生成中连按 Enter 不再重复输出。
3. **再做 4.1 + 4.2**：验收——`/model <无reasoning模型> <effort>` 报错不落盘；`printf '' | dsh --profile tui --new` 正常退出且会话已 flush。
4. **最后 P2 清理**。

约束（沿用第一轮）：
- 只改 TUI profile 目录，不动 `~/.npm/_npx/.../@deepseek-ai/`。
- 颜色/光标/spinner 走统一出口；非 TTY 不藏光标；`ui` 挂载时裸 spinner 全 no-op。
- 每批一个 diff，改完贴实际终端输出自测，不要说「已修复」。
