# dsh-tui 第三轮迭代方案

> 日期：2026-08-18  
> 范围：仅 `~/.dsh/profiles/tui/`（`tui-runner.mjs` / `tui-ui.mjs` / `tui-startup.mjs` / `package.json` / `README.md`）  
> 对照：[`ITERATION.md`](./ITERATION.md)（第一轮，已完成）；[`ITERATION-2.md`](./ITERATION-2.md)（审查；采纳其 P0 正确性项，修正光标/滚动处方）  
> 对照：本机 Pi（`@earendil-works/pi-tui`）与 Hermes（`@hermes/ink` + `useDeclaredCursor`）的光标实现  
> 原则：**先修可见正确性并停止抢 stdout，再按「先画再量」钉硬件光标，最后把滚动改成「行」为单位。不改 DSH npm 包，不 fork Ink，不改 collab profile。**  
> 修订：对照 `tui-runner.mjs` / `tui-ui.mjs`、Ink 7.1.1、`dsh-agent-loop` 与 yoga 布局核验。修正 `useCursor` 签名、A1 判据；补 B 根因（根节点不 `setHeight`）、提示行预留、首帧滞后、C 切片/clamp、A3 `/new`/`/resume` 语义。

第一轮（会话、取消、工具时间线、Ink 接入）已经能用。当前缺口是：Ink 迁入后 readline 残留路径仍在打架，以及手算行数与真实布局不一致。

核验已确认、按本方案执行即可：A1–A3、D1–D3 与核实一致；`useBoxMetrics` / `useCursor` 在 Ink 7.1.1 可用；`string-width` 与 Ink `measureText`/`wrapText` 同源（`widest-line` / `wrap-ansi`），`string-width@8.2.2` 已是传递依赖；`y: rows-4` 落到 `Context` 已复现，根因见 B。批次顺序不变。

---

## 从 Pi / Hermes 学到的（光标）

两家日常手感准，不是菜单放上面还是下面，而是 **光标坐标来自已经画出来的那一帧**。

| | Pi | Hermes | 本方案要对齐的部分 |
|---|---|---|---|
| 框架 | 自研行缓冲 TUI，不是 Ink | 魔改 Ink（`@hermes/ink`） | 继续上游 Ink |
| 怎么定位 | 输入 caret 处插零宽 `CURSOR_MARKER`，整帧扫描后 CUP | `useDeclaredCursor`：输入 Box 的 ref + 盒内 (line, column)，渲染器按盒子矩形 park | `useBoxMetrics` 量盒子；`useCursor()` 取 `setCursorPosition`，坐标用 `string-width` |
| 折行 | 渲染后再量可见列 | `cursorLayout` 与 wrap-ansi 同一套 | 宽度计算必须和 Ink 渲染一致，用 `string-width`，弃用手写 CJK 表 |
| 硬件光标 | 每帧更新位置；默认可隐藏，但 **位置仍 park**；部分终端要看得见 IME 才跟 | 每帧 park 在 caret；占位符/失焦时才藏 | **不要** `setCursorPosition(undefined)` 当默认；IME 要跟看得见的硬件光标 |
| 假光标 | 反色块与标记同格 | 占位符才用合成光标 | 去掉 `▏`，只留硬件光标 |

**明确不搬：**

- Pi 的 APC 标记扫描（要改 Ink 输出管线）
- Hermes 的 `@hermes/ink`、fast-echo 直写 stdout、`noteExternalCursorAdvance`（和 spinner 抢屏幕是同一类债）
- 整页换成自研 TUI

**明确要搬的模型：** 先画 → 量输入行真实格子 → 把硬件光标 park 过去。A 批必须先做完：只有渲染器能动光标，测量才有意义。

命令菜单放输入框上或下 **都不降低光标难度**；用 metrics 时菜单一开盒子 `top` 自己变。菜单位置本轮不改。

---

## 不做

| 项 | 原因 |
|---|---|
| 写死 `y: rows - N` | Ink 不给根 yoga 节点 `setHeight`，帧高=内容高，输入行不在终端倒数固定行；任何 `rows-N` 都会回归到状态栏 |
| 用户消息 `wrap="truncate-end"` 作为滚动主方案 | 和「完整内容可滚」冲突；长行应折行并计入真实行数 |
| 换成 `ink-text-input` / 重写整个 composer | 官方 TextInput 仍要调用方传 Y，解决不了全屏 flex；会打乱命令面板和忙态 |
| 接入 Pi `CURSOR_MARKER` 或 fork `@hermes/ink` | 等于自研/魔改渲染器 |
| 按键 fast-echo 直写 stdout | Hermes 为跟手付出整套 displayCursor 同步；我们规模不值得 |
| 改 `@deepseek-ai/*` 或 web/headless profile | 升级会被覆盖 |
| 给 TUI 和 collab 共用跨进程锁 | 另开一轮 |
| 为光标把命令菜单改到输入框下方 | 输入行 Y 会随候选条数变，手算更难；metrics 下无收益 |

---

## 目标

四批之后，日常 TTY 路径应满足：

1. 工具失败显示红色 `[tool error]`，不再被当成成功。
2. 生成中连按 Enter 不会开第二轮、不会交错重复输出。
3. Ink 全屏下无 spinner 闪烁、无 `\x1b[?25l` 与 Ink 抢光标。
4. 硬件光标钉在输入框 caret；中文 IME 候选框跟随该光标；屏幕上只有这一个光标。
5. Logo、标题、对话在同一份可滚动文档里；触控板方向与 macOS 自然滚动一致；滚轮/PgUp/PgDn 按「行」移动，贴底时无双帧闪一下。
6. `/model` 对不支持 effort 的模型直接拒绝；空 stdin 管道也会 flush 后退出。

---

## 批次总览

| 批 | 主题 | 文件 | 预估 | 验收门槛 |
|---|---|---|---|---|
| A | 正确性：tool 错误、spinner、防重入 | `tui-runner.mjs`、`tui-ui.mjs` | 小 | 失败工具红色；TTY 无闪烁；生成中 Enter 被吞 |
| B | 光标：先画再量，park 硬件光标 | `tui-ui.mjs` | 中 | IME 候选框跟输入框；无底部第二光标 |
| C | 滚动：行单位 + 折行计数 + 同步贴底 | `tui-ui.mjs` | 中 | 全屏内容滚；方向正确；长行不顶掉输入框 |
| D | P1/P2：effort、空 stdin flush、死代码 | runner / startup / package.json / README | 小 | 见各条验收 |

A 先合：B 依赖「只有 Ink 动光标」。C 依赖 B 的 composer 结构（输入行有 ref）。D 可穿插在 A 之后。

---

## A. 正确性（必做）

### A1. `tool/result` 读 `data` 而不是信封顶层

- **位置**：`tui-runner.mjs` `consumeEvent` 的 `tool/result` 分支（当前 `if (ev.error)`，信封是 `{type, data}`，顶层 `error` 恒为 `undefined`）
- **构造核对**（`dsh-agent-loop` `appendToolResult`）：`session.append("tool/result", { turn, step, message, ...result.error?.info ? { error: result.error.info } : {} })`。第二个参数就是 `data`。`result.error.info` 存在时才会有 `data.error`；`data.error` 就是那份 **info 对象**，不要再当成信封顶层。
- **改法**：主判据只用 `ev.data.error`。`message.content[0].isError` 依赖 `createToolResultMessage` 的 content 形态，**只作防御，不能当唯一条件**。

```js
const info = ev.data?.error;
const failed = info !== undefined
	|| ev.data?.message?.content?.[0]?.isError === true;
const detail = info?.code ?? info?.name ?? info?.message
	?? (typeof info === "string" ? info : null)
	?? "error";
if (failed) {
	say(style("red", `[tool error] ${name}${elapsed} · ${detail}`));
} else {
	const preview = trunc(toolResultText(ev), 80);
	say(style("green", preview ? `[tool] ${name}${elapsed} · ${preview}` : `[tool] ${name}${elapsed}`));
}
```

- **不要假设** `info.code` 一定存在。info 字段名以真实失败工具打出来的对象为准；展示链 `code → name → message → "error"` 即可。
- **验收**：让 agent 跑 **不存在的命令**（command not found），transcript 必须出现红色 `[tool error]`，不是绿色成功预览。`false` 是否走 `isError` / `data.error` 不确定，可作对照再试一次，**不能当唯一必失败用例**。实施时把该次 `data.error` 的真实字段记进注释或本文件，避免下次再猜 `.code`。

### A2. Ink 模式下裸 spinner / 光标控制 no-op

- **位置**：`startSpinner` / `stopSpinner` / `createCursorGuard`
- **改法**：`if (ui) return;` 放在 `startSpinner` 最前；`stopSpinner` 仅在 `!ui` 时 `clearLine` / `cursorTo` / `cursor.show`。Ink 忙态继续用 composer 的 `⋯ `。
- **为什么必须在 B 之前**：Pi/Hermes 的硬件光标都由 **唯一渲染器** 在每帧末 park。TTY 下再每 80ms `\r` + `\x1b[?25l/h`，B 测到的格子也会被打乱。
- **验收**：TTY 下一轮对话无闪烁、无 `thinking…` 残影；`printf 'say hi\n' | dsh --profile tui --new --quiet` 不得把光标藏死后不恢复。

### A3. 防重入

- **runner**：`handleLine` 在进入 `runTurn` 前 `if (busy) return;`。斜杠命令不受 busy 阻塞（比「`handleLine` 一刀切」更合理）。`busy` 只表示「正在跑 turn」。
- **有意放行**：busy 时 `/exit`、`/new`、`/resume` 仍可执行。`/new` / `/resume` 会 `spawn` 并 dispose 运行中的旧 agent，**等价于取消当前 turn**。这是有意的，不是漏守卫。
- **ui**：`submit` 开头 `if (state.turn === "running") return;`；`useInput` 的 Enter 在 running 时不提交（挡住的是普通提问，不是 `/` 命令）。
- **验收**：生成中连续按 Enter 3 次，只看到一轮用户消息和一轮回复；无交错 `[tool]` 行。生成中执行 `/new` 会丢弃当前 turn 并开新会话（见 D3 README）。

---

## B. 光标（必做：测量模型，不用魔数）

### 问题

自定义 composer + `useInput` 时，Ink 不知道哪一行是输入控件。不定位则硬件光标在输出末尾（状态栏后），IME 跟那个点。手算 `visibleDocumentRows` 随内容和折行漂移。

**`y: rows - 4` 落到状态栏 `Context` 的根因**（不是差一行）：Ink `calculateLayout` 只给根 yoga 节点 `setWidth`，**从不 `setHeight`**。根 Box 的 `height: "100%"` 在瑜伽里变成 `auto` → **帧高 = 内容高**，输入框并没有被钉在终端底部。当前窗口上限 `rows-7` + 固定 5 行 → 帧高恒为 `rows-2`，输入行落在帧内 `rows-6`，于是 `y: rows-4` 正好命中状态栏第一行。`renderToString` 复刻（33 行文档 + 3 行输入 + 2 行状态 = 38 行帧，40 行终端下输入行在 34）：`40-4=36` 精确落在 `Context` 那行。

以后禁止再引入 `rows-N` 魔数：百分比高度在这个 Ink 版本里填不满终端，倒数第 N 行不是输入行。

这和 Pi/Hermes 修过的是同一个定位问题：**硬件光标必须 park 在已画出的 caret，不能猜终端坐标。**

### 改法（对齐 Hermes 的声明模型；Ink 7.1.1 真实 API）

Ink 7.1.1：`useCursor()` **无参**，返回 `{ setCursorPosition }`。`y` 是 **帧内 0 基行号**（`log-update` 的 `buildCursorSuffix` 用 `visibleLineCount - y` 上移），不是终端绝对行。坐标通过 `setCursorPosition({ x, y })` 传入；`undefined` 才是藏光标。**不要**写成 `useCursor({ x, y })`。

`useBoxMetrics` 返回相对 **parent** 的 `top`/`left` 和 `hasMeasured`（在 `useEffect` 里、画后更新）。**不累加祖先**；`measureElement` 才会。因此「输入行提升为根 Box 直接子节点 → 其 `top` 即帧内 y」成立。

`string-width` 与 Ink 渲染一致：`measureText` 用 `widest-line`，`wrapText` 用 `wrap-ansi`，底层都是它。`string-width@8.2.2` 已在 `node_modules`（Ink 传递依赖），D3 补声明无风险。

当前 `tui-ui.mjs` 已经在调 `useCursor` / `setCursorPosition`（约 131 / 157 行），Y 用手算，X 用手写 `displayWidth`。B 的落地是 **换数据源，不是换 hook**：

```text
const { setCursorPosition } = useCursor();          // 已有，勿改签名
输入行 Box 提升为根的直接子节点 + ref
  → useBoxMetrics(ref) → { left, top, hasMeasured }
  → col = stringWidth(prompt + input)
  → hasMeasured 时：
      setCursorPosition({ x: left + col, y: top })
  → 未测到：用上次已知 {x,y} 兜底，不要落到帧底
```

具体：

1. 去掉模拟光标 `▏`（若还在）。
2. **优先把含 `›` 的输入行 `Box` 提升为根的直接子节点**，顶/底横线做兄弟。此时 `top` 就是 `setCursorPosition` 的 y。不要再手加 `top + 1`。
3. 若暂不提升：ref 只能打在 parent=根 的那一层（现在的 composer 列）。内层 `paddingX: 1` 盒子的 `top` 相对 composer，**不能**直接当帧内 y。
4. **提示行固定槽位**（必做，否则光标会抖）：`↑/↓ N earlier lines` 现在在文档区内，滚动时出现/消失 → 文档高度 ±1 → 输入行 `top` ±1。始终渲染该行（无提示时用空行），或把它移出文档区（例如钉在 composer 上方、不进滚动切片）。不要让提示行参与「有则占一行、无则消失」。
5. 仅在 `hasMeasured === true` 时更新已知位置并 `setCursorPosition`。未测到前用 **上次已知坐标** 兜底。默认 **显示** 硬件光标。不要把 `setCursorPosition(undefined)` 当常态。
6. **一帧滞后是预期**：`useBoxMetrics` 在 `useEffect`（画后）更新，`useCursor` 在 `useInsertionEffect` 传播 → 首帧光标可能先落在帧底，下一帧才 park 到输入框。验收不当 bug；有上次位置兜底后，冷启动最多闪一帧。
7. X：ref 在输入行上时 padding 已进盒子，caret 列用 `stringWidth(prompt + input)`，不要再加一次 1。多行输入以后再加 `cursorLayout`，本轮 caret 在行尾即可。
8. 删除手写 `displayWidth`，改用 `string-width`。`package.json` 声明该依赖（D3）。
9. 打开命令菜单时不要藏光标；metrics 应随 composer 上移。

**可选互补（不做不能替代实测）：** 把根 Box `height: "100%"` 改成 `height: rows`（`useWindowSize` 的数值）。这样 `flexGrow` 才真正生效，帧恰好填满终端，消掉底部约 2 行空行，布局更确定。光标方案仍靠 `useBoxMetrics`，**禁止只改 height、不测盒子**——菜单和提示行仍会变 `top`。

### 验收

- 空输入、中文、ASCII、emoji、粘贴长句：硬件光标在 `›` 后文本末尾（第二帧及之后；首帧滞后不当失败）。
- 系统中文候选框贴着输入框，不在状态栏或屏幕底部。
- 打开 `/` 或 `/model` 菜单后，光标仍在输入行。
- 滚动 transcript、提示行从「有」变「无」时，输入框和光标 **不跳一行**。
- 窗口失焦时允许终端自己把光标画成空心块；不要再叠一个 `▏`。

---

## C. 滚动（必做）

### 目标交互

- Logo、标题、提示、用户/助手消息是 **同一份文档**，一起滚；输入框和状态栏固定（光标因此不受滚动影响，与 Pi 只扫视口、Hermes park 在 composer Box 一致）。
- macOS 自然滚动：两指上滑 → 内容向上（看更新的）；两指下滑 → 回看更早内容。PgUp 回看，PgDn/End 回最新。
- 不截断长行；折行后按真实行数占视口。行宽函数与 B 的 `string-width` 相同。

### 改法

1. **滚动单位改为「距底部的行数」**，不再用「条目数」。`pageSize` / 滚轮步长 / `availableRows` 全部是行。`scrollOffset` **clamp 到文档总行高**（`[0, max(0, totalRows - viewportRows)]`），禁止滚过头越界。
2. **行高函数**同时计入（Text 默认 `wrap='wrap'`，长行必折）：
   - 用户气泡：`paddingY: 1` → 文本折行行数 + 2；
   - 其它行：`ceil(stringWidth(text) / columns)`，至少 1。
3. 视口按累计行高取切片。贴底时 **视口末端 = 文档底部** 即可。
4. **删掉 `visibleDocument` 的怪癖**：当前「总是把最新一条塞进视口」（`start < end` 分支）在行单位切片下不再需要，不要移植。
5. **贴底同步**：新内容到达且当前已在底部时，在 render 路径里直接保持 offset=0，不要 `useEffect` 先画旧 offset 再改（双帧闪烁）。离开底部时，新行增加应补偿 offset，视口钉在用户正在看的那段。
6. `useMemo` 缓存 document 列表；单行 `React.memo`。滚轮只改 `scrollOffset`。滚动提示行走 B 的固定槽位，不在切片里忽有忽无。
7. 滚轮继续用 SGR 鼠标协议（Ink `useInput` 没有 mouse）。解析器按完整 `\x1b[<...M` 消费，未完成的 CSI 留在 buffer；`useInput` 继续忽略 `[<` 开头的序列。**保留现状 `slice(-32)` cap**（`consumed === 0` 时截断 pending，防止异常输入流把 buffer 撑爆）；改成「未完成 CSI 留 buffer」时不要删这个上限。退出时关闭 `?1000` / `?1006`。不要为了跟手去学 Hermes 的 fast-echo。

### 验收

- 一屏装不下时，触控板上滑，Logo 和旧消息往上离开视口，能看到更下面的回复。
- 方向与系统一致（若反了就是回归）。
- 长中文/长英文回复折行，不把输入框/状态栏顶出屏幕。
- 停在历史位置时，流式新输出不强制拉回底部；按 End 或滚回底部后恢复跟随。
- 提交新问题时回到底部（offset=0）。
- 滚轮/PgUp 到顶或到底时停住，offset 不越界、不出现空白洞。
- 滚动过程中 IME/硬件光标仍钉在输入行且不跳一行（B 的回归 + 提示行槽位）。
- 向 stdin 灌超长残缺 CSI 时，pending 仍受 32 字符上限约束，进程内存不涨。

---

## D. P1 / P2

### D1. `/model` effort

`efforts.length === 0 || !efforts.some(...)` 时拒绝并列出可选值（无 reasoning 则提示该模型不支持 effort）。不写入 `saveSelection`。

验收：`/model deepseek-v4-flash high`（或当前无 reasoning 的模型）报错，settings 不变。

### D2. 空 stdin flush

`ready = true` 之后，非 interactive 路径补：

```js
if (stdinClosed) await flushAndExit(0);
else if (queue.length > 0 && !draining) drain();
```

验收：`printf '' | dsh --profile tui --new --quiet` 退出码 0，且 `~/.dsh/sessions/` 下该次 session 已落盘。

### D3. 清理

- 删除 `wantBanner` 及对 stdout 直写 BANNER 的死代码。
- `pickModel` 在 `!rl` 时不要 `rl.question`；TTY 只走 Ink 菜单，非 TTY 只打印列表。
- `package.json` 声明 `commander` 与 `string-width`。
- README 在「会话内命令」或单独「TTY 行为」节写清（以后不用翻代码回忆）：
  - **光标 / IME**：TTY 只用硬件光标，钉在输入框 caret；系统中文候选框跟这个光标，没有假光标 `▏`。
  - **生成中不可二次提交**：turn running 时普通 Enter 被吞，不会开第二轮。
  - **busy 时命令**：`/exit`、`/new`、`/resume` 仍可用；`/new` / `/resume` 会丢掉当前 turn（dispose 旧 agent）。
  - 滚轮方向与 macOS 自然滚动一致（两指上滑看更新内容）。

---

## 建议执行顺序

1. **A**（同一 diff）：tool 错误 + spinner 短路 + busy 守卫。先保证只有 Ink 动光标。
2. **B**：输入行提升为根直接子节点 + `useBoxMetrics` + 提示行固定槽位 + 上次坐标兜底。用中文输入法在真实 TTY 验收；首帧滞后不当失败。
3. **C**：行单位滚动 + 与 B 相同的宽度函数 + 同步贴底。验收时顺带确认光标不跟滚动跑。
4. **D**：effort、空 stdin、死代码、README。

每批改完用真实 TTY 看一屏，不要只 `node --check`。

---

## 与 ITERATION-2.md 的差异

| ITERATION-2 | 本方案 |
|---|---|
| 先做光标/滚动，再做 runner 正确性 | 先 A（正确性 + 独占 stdout），再 B/C |
| 光标 `y: rows - 4`，`x: 3 + width` | 根因：Ink 不 `setHeight` 根节点，帧高=内容高；Y/X 用 `useBoxMetrics` + `string-width`，禁止 `rows-N` |
| transcript `wrap="truncate-end"` 对齐行数 | 保留折行，行高与 B 共用 `string-width` |
| 滚动「单位统一」表述较笼统 | 「距底部行数」+ 用户气泡含 paddingY |
| 未写 IME 验收 | B 以候选框位置为准；默认显示硬件光标 |
| （无） | 写明学 Pi/Hermes 的测量模型，不搬标记扫描与 fork Ink |

---

## 本轮修订（对照代码核验）

| 项 | 处理 |
|---|---|
| `useCursor({ x, y })` 写错 | 改为 Ink 7.1.1 真实用法：`useCursor()` → `setCursorPosition({ x, y })`。现有代码已在这条路径上，B 只换 Y/X 数据源 |
| A1 双条件并列 | 主判据 `ev.data.error`；`content[0].isError` 仅防御。展示字段不假设 `.code`，实施时用真实失败工具核对 info |
| A1 验收用 `false` | 改为必测「不存在的命令」；`false` 仅对照 |
| C 未完成 CSI 留 buffer | 明确保留 `slice(-32)` cap |
| D README 太略 | 要求写清硬件光标/IME、生成中不可二次提交、busy 时 `/new`/`/resume` 会取消当前 turn |
| `rows-4` 只写「已实测」 | B 写明根因：根 yoga 节点不 `setHeight` → 帧高=内容高 |
| 提示行占/不占一行 | 固定槽位或移出文档区，避免输入行 `top` ±1 |
| 首帧光标在帧底 | 预期行为；上次位置兜底；验收不当 bug |
| `visibleDocument` 强塞最新条 | C 改为视口末端=底部；`scrollOffset` clamp 到总行高 |
| 根 `height: "100%"` 无效 | 可选改为数值 `rows`；不能代替实测 |

---

## 约束（沿用第一轮）

- 只改 TUI profile 目录。
- 颜色 / 光标 / spinner 走统一出口；非 TTY 不把光标藏死。
- `ui` 挂载时裸 spinner、`clearLine`、`cursorTo`、`\x1b[?25l` 全部 no-op。
- TTY 下硬件光标由 Ink `useCursor()` → `setCursorPosition` 独占；不要再直写 CUP / hide。不要调用 `useCursor({ x, y })`（该签名不存在）。
- 禁止用 `rows - N` 猜输入行 Y。根节点百分比高度在当前 Ink 下不等于终端高度。
- 触控板方向保持与 macOS 自然滚动一致，改滚动单位时不要把方向改回去。
