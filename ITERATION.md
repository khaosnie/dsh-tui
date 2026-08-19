# dsh-tui 迭代方案

> **当前执行稿：[`ITERATION-3.md`](./ITERATION-3.md)**（2026-08-18，A→B→C→D）。本文是第一轮（2026-08-17）已完成的历史方案，不要按下面的「不上 ink」继续改。第二轮审查见 [`ITERATION-2.md`](./ITERATION-2.md)。

> 日期：2026-08-17  
> 范围：`tui-runner.mjs` / `tui-startup.mjs` / `cordis.patch.yml` / README.md  
> 原则（仅第一轮）：**先修正确性，再补 agent 透明度，最后打磨 readline。不改架构，不上 ink/blessed。**

架构已经对了：第三种 profile，挂在 `dsh-base` 上，不监听 3080，会话走同一套 JSONL。`tui-startup` 和 patch 接近可合入。迭代几乎全部落在 `tui-runner.mjs`。

---

## 目标

三批之后，日常路径应满足：

1. `/model`、`/resume`、`/new` 行为与提示一致，失败不丢会话、不吞输入。
2. 模型输出中 Ctrl+C 取消本轮；空闲时才确认退出。
3. 能看见工具在干什么（名称、耗时、结果摘要、失败原因）。
4. 失败的 turn 有明确错误，而不是安静回到 prompt。
5. type-ahead 时流式输出不把正在打的字打乱。

「天天用」还需要 markdown / 会话标题，放在第 4 批，不阻塞前三批验收。

---

## 不做（本轮）

| 项 | 原因 |
|---|---|
| 换成 ink / blessed / 真全屏 TUI | 成本高，当前缺口不在渲染框架 |
| 改 `inject` + `ctx.get()` 双路径 | 官方 `dsh-headless` 就是这个写法 |
| `compactNow` 补第三参 `sourceCommandId` | 可选展示关联，不 crash |
| `/list` 上下键选择器 | P2，`--list` 先把标题和合法性做对即可 |
| 多行粘贴时间窗自动合并 | 易误伤慢速输入；需要单独的多行模式再做 |
| 给 profile 加测试框架 / 抽包发布 | 仍是本地 profile；先把 runner 修对 |

---

## 批次总览

| 批 | 主题 | 文件 | 预估 | 验收门槛 |
|---|---|---|---|---|
| A | 正确性 | `tui-runner.mjs` | 小，&lt;40 行 | `/model` `/resume` 不再撒谎或丢会话 |
| B | 中断与队列 | `tui-runner.mjs` | 小-中 | Ctrl+C 语义对；管道输入不丢行；turn 失败可见 |
| C | Agent 透明度 | `tui-runner.mjs` | 中 | 工具调用可跟；等待期有指示 |
| D | 输入卫生 | `tui-runner.mjs` | 中 | 边等边打字不乱屏；用户/助手可扫读 |
| E | 打磨 | runner + startup + README | 小-中 | 列表可读、尊重 NO_COLOR、BANNER 可关 |

先 A → B → C。D/E 可并行，但不要插进 A/B 的 diff。

---

## A. 正确性（必做）

### A1. `/model` 对后续 spawn 生效

- **现状**：`repl()` 启动时把 `currentSelection()` 冻进闭包；`saveSelection()` 只写 settings。
- **改法**：删除外层 `selection` / `agentOptions` / `setup`。每次 `spawn()` 内重新 `defaultModel.currentSelection()`，再构造 `agentOptions` 和 `installModelSelection`。
- **不要做**：试图热切换*当前* agent 的模型。当前会话绑死模型是 DSH 语义；提示改成「对下一个 `/new` 或 `/resume` 生效」。
- **验收**：
  - `/model <id>` 后 `/new`，新会话用新模型。
  - `/model` 无参仍打印当前 settings（含 effort，若有）。
  - 不重启进程。

### A2. `/resume` 失败不丢当前会话

- **现状**：`spawn()` 先 `dispose` 再 `resume`；失败后 `current === null`，后续输入走 `if (!current) return` 被静默丢弃。
- **改法**：先 `agents.resume(...)` 成功，再 dispose 旧 handle。失败则打印错误、保留旧 `current`。`/new` 同理：create 成功后再扔旧的。
- **验收**：
  - `/resume 不存在的id` → 报错，原会话仍可对话。
  - `/resume` 成功 → 旧 agent 已 dispose，新会话可对话。

### A3. 同步 README

- 删掉或改写「`/model` 对新 agent 生效」——补上「须 `/new` 或 `/resume`，且同进程立即生效」。
- 在已知限制里写明：resume 失败保留当前会话。

---

## B. 中断、队列、失败可见（必做）

### B1. Ctrl+C：忙时取消，闲时退出

- **现状**：SIGINT 只 `rl.question("quit? (y/N)")`；输出中无法取消。连按会叠多层 question。
- **改法**：
  - 若 `current.agent` 非 idle：`agent.cancel({ kind: "user" }, { keepInbox: true })`，停 spinner/流式，提示已取消，再 `rl.prompt()`。
  - 若 idle：确认退出（或第二次 Ctrl+C 直接退出）。
  - SIGINT handler 加互斥，禁止叠 `question`。
- **API**：`agent.cancel(cause, options?)` 在 `@deepseek-ai/dsh-agent`，**必须传 cause**。默认清 inbox；本 CLI 的 type-ahead 在 readline 队列里、尚未 `followup`，用 `keepInbox: true` 以免误伤 agent 侧已排队工作。
- **验收**：
  - 长回答中 Ctrl+C → 停止生成，会话还在，可继续输入。
  - 空闲 Ctrl+C → 确认后保存退出。
  - 连按不会出现多层 `quit?`。

### B2. drain 竞态

- **现状**：`while` 清空后、`draining = false` 前入队的行不会触发下一轮 drain。
- **改法**：`finally` 里 `draining = false` 之后，若 `queue.length > 0 && !exiting`，再调一次 `drain()`。
- **验收**：`printf 'a\nb\n' | dsh --profile tui --new`（或等价管道）两行都发给 agent，进程正常退出。

### B3. 暴露 `turn/end` error

- **现状**：`streamTurn` 只看 `assistant/message` 和 `tool/*`。headless 会把 `turn/end` 的 `reason.kind === "error"` 打到 stderr。
- **改法**：drain 尾事件时若本轮 `turn/end` 为 error，打印 `code` + `message`。取消（B1）不要当错误喊。
- **验收**：故意触发工具/模型失败，prompt 回来前能看到错误，而不是空白。

### B4. 订阅 `session/event`（可与 B3 一起做）

- **现状**：`sleep(60)` 轮询 `agent.session.events`。
- **改法**：听 `session/event`，用 `whenIdle()` 做结束条件；保留一次最终 drain（补上监听开始前已入 log 的事件）。
- **坑（实现时必踩）**：`session/event` 是作用域事件（`Scoped<Session>`，见 `dsh-session` + `dsh-scope`）。agent 作用域的 listener **只**收到从该 agent.ctx 进入的会话事件；挂在 runner 的 profile `ctx` 上会收到这棵树上所有会话（当前 agent、刚 dispose 尚未收完的旧会话、compaction / subagent 若另开 session）。
  - **推荐**：每次 `spawn()` 之后在 `current.agent.ctx` 上 `on('session/event', …)`，旧 agent dispose 时让 listener 随 ctx 一起拆掉，不要挂一次管终身。
  - **若挂 runner ctx**：回调里必须 `session === current?.agent.session`，否则会把别人的 `assistant/message` 打到当前 stdout。
  - resume / seed 进 log 的历史事件 **不**走 firehose（构造期 seed 不 emit），所以订阅不能替代启动时的 snapshot drain。
- **若本批时间紧**：可先留轮询，但 B3 必须做。轮询改订阅不要和 A 混在一个 diff。

---

## C. Agent 透明度（日常能用的关键）

### C1. 工具调用可跟

- 开始：`[tool] {name}` + 关键参数摘要（截断，单行）。
- 结束：耗时、成功/失败色、结果前 ~80 字符或 error code。
- 现有 `[tool error]` 保留，并入这条时间线，不要打两遍。

### C2. thinking 指示

- `followup` 之后到第一个 assistant 文本 / tool 事件之前：TTY 下 spinner（如 `thinking…`）。
- 第一个增量到达即清掉。
- **非 TTY / 管道：根本不要藏光标、不要打 spinner**（这不是「退出时恢复」的一条路径，是根本不进入藏光标状态）。
- 藏光标用 `\x1b[?25l` 的话，抽一个幂等的 `restoreCursor()`（写 `\x1b[?25h`，可重复调用）。TTY 下至少覆盖这四条，再用 `process.on("exit")` 兜底：

  | 路径 | 典型触发 | 为什么单独列 |
  |---|---|---|
  | cancel | 生成中 Ctrl+C | **不退出进程**，只回 prompt；只靠 exit 钩子救不了 |
  | `flushAndExit` | `/exit`、idle 确认退出 | 正常退出 |
  | `rl.on("close")` | TTY 下 Ctrl+D、stdin EOF | 有时会先 close 再进 drain；spinner 可能还在转。管道 EOF 若已遵守「非 TTY 不藏光标」则无事，TTY+EOF 仍要恢复 |
  | `SIGTERM` / `SIGHUP` | 外层 kill、终端关掉 | **不走** `flushAndExit`；不钩的话终端会一直没光标 |

- `process.on("exit", restoreCursor)` 覆盖 flushAndExit、未捕获异常、以及 Node 能收到的终止信号。`SIGKILL` 钩不到，文档里一句即可。
- 不要只在「三条路径」上散落 `stdout.write("\x1b[?25h")`。

### C3. `/list` 与自动 resume 走官方 list API

- 删除自写的 `encodeSegment` / `projectKey` / `readdir`（`encodeSegment` 已是死代码）。
- 用 `ctx.sessionPersistence.list()`（或 `listSnapshots()`），按当前 `cwd` 过滤，跳过损坏/半截会话。
- `--list` / `/list` 至少输出：id、相对时间；有标题则显示标题（`dsh-base` 已挂 `dsh-session-title`）。
- `latestSession()` 基于同一 list，不要第二套扫盘逻辑。

---

## D. 输入卫生（手感）

### D1. 流式输出不打断当前输入行

- type-ahead 时 `stdout.write` 会和 readline 回显打架。
- 写增量前保存 `rl.line` / cursor，写完后清行并重绘 prompt + 缓冲区。busy 期间也可暂停 echo、结束后再 prompt。
- 非 TTY 跳过。

### D2. 用户消息前缀

- 提交后用固定前缀回显一行（如 `you › …`），与助手输出分色。
- 这是扫读问题，不是「消息丢了」——终端已经 echo 过。不要做成复杂 transcript view。

### D3. 自定义 prompt

- 设 `prompt`（空闲 / 忙碌两态即可）。
- 不要把换个 glyph 当成独立大任务；跟 D1 一起做。

---

## E. 打磨（不阻塞日常）

| ID | 项 | 说明 |
|---|---|---|
| E1 | BANNER | 仅 TTY；`--quiet` 或 `DSH_NO_BANNER` 可关。先打 BANNER，再打 `[new session]`。管道模式零 logo。 |
| E2 | `NO_COLOR` / `TERM=dumb` / 非 TTY | 集中 `style()`，禁止满文件 `\x1b[`。 |
| E3 | `/model` effort | 解析 `provider/model` 外的 effort；非法值报错不写 settings。 |
| E4 | markdown | **先整段再着色**，不要在流式热路径上做半套解析。代码块最低限度：缩进 + 与正文分色。 |
| E5 | token 用量 | 有 `dsh-token-meter` 再在每轮末打一行；没有就跳过。 |
| E6 | `/resume` 无参 | 打印最近 N 条（用 C3 的 list），不要做全套箭头菜单。 |
| E7 | 前缀重打 | `streamTurn` 在 `text.startsWith(printed)` 失败时只打增量或换行后再打全文，避免闪屏。 |

---

## 任务清单（可直接认领）

改文件默认都是 `tui-runner.mjs`，除非另写。

- [x] **A1** spawn 内重读 `currentSelection()`；修正 `/model` 文案
- [x] **A2** resume/create 成功后再 dispose 旧 agent
- [x] **A3** README：`/model`、resume 失败语义
- [x] **B1** SIGINT：busy → `cancel({ kind: "user" }, { keepInbox: true })`；idle → 退出确认；禁止叠 question
- [x] **B2** drain 结束后若 queue 非空则再 drain
- [x] **B3** 打印本轮 `turn/end` error（取消除外）
- [x] **B4** 在 `agent.ctx` 上按需订 `session/event`；保留 snapshot drain
- [x] **C1** tool 开始/结束：参数摘要、耗时、结果预览
- [x] **C2** TTY spinner；幂等光标恢复 + `process.on("exit")`；覆盖 cancel / flushAndExit / rl.close / SIGTERM
- [x] **C3** `sessionPersistence.list()` 替换扫盘；删 `encodeSegment`/`projectKey`
- [x] **D1** 流式写 stdout 时保存并重绘 readline 行
- [x] **D2** 用户消息前缀回显
- [x] **D3** 空闲/忙碌 prompt
- [x] **E1–E7** 实现 BANNER / NO_COLOR / effort / markdown / token / 无参 resume / 前缀替换保护

---

## 建议验收脚本

在真实终端（不要套一层 sandbox bash）执行：

```bash
# A1
# 会话内：/model <另一个模型>  →  /new  →  /model
# 期望：新会话的 /model 为刚设置的值

# A2
# 有一个活会话时：/resume definitely-not-a-session
# 期望：报错；再发一句普通话，agent 仍回答

# B1
# 发一个会长输出的问题，生成中 Ctrl+C
# 期望：停止；还能继续打字；不退出进程

# B2
printf 'say hello in one word\n' | dsh --profile tui --new
# 期望：有助手输出，进程退出码 0，无 BANNER（若 E1 已做）

# C1
# 让它跑一次 bash（如 pwd）
# 期望：能看到工具名和输出摘要，不只是 [tool] bash
```

---

## 丢回 DeepSeek 改时的约束

1. 只改 TUI profile 目录，不要改 `~/.npm/_npx/.../@deepseek-ai/`。
2. 每批一个 diff，按 A → B → C 顺序合；不要夹带 markdown 渲染或 ASCII logo。
3. 新颜色/光标/spinner 必须走统一出口。非 TTY 不藏光标。TTY 下 `restoreCursor()` 覆盖 cancel、`flushAndExit`、`rl.on("close")`、`SIGTERM`/`SIGHUP`，并用 `process.on("exit")` 兜底。
4. 订 `session/event` 必须绑 `current.agent.ctx`，或在 runner `ctx` 上按 `session` 过滤；每次 spawn 重绑。不要假设 profile ctx 上听到的都是当前会话。
5. 不要再复制 `dsh-session-persistence-jsonl` 的路径编码。
6. 改完用上面的验收脚本自测，在回复里贴实际输出，不要只说「已修复」。
