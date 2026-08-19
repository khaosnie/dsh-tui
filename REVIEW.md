# dsh-tui 代码审查与迭代建议

> 审查日期：2026-08-17
> 审查范围：`tui-runner.mjs` / `tui-startup.mjs` / `cordis.patch.yml` / README.md
> 验证方式：与 DSH 底层源码交叉核对（`~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/`）
> 总体结论：**功能层到位、架构正确，交互层仍属"裸 readline + 字符串拼接"水平**。P0 共 2 个真实 bug，界面优化 P0 共 3 项，做完手感即可从"能用"跳到"想天天用"。

---

## 一、P0 真实 Bug（影响核心功能，建议必改）

### 1.1 `/model` 切换后实际不生效

- **位置**：`tui-runner.mjs:191-192`（快照固定） vs `tui-runner.mjs:241-260`（handleModel）
- **证据**：
  - REPL 启动时把 `defaultModel.currentSelection()` 结果固定为闭包常量：
    ```js
    const selection = defaultModel.currentSelection();
    const agentOptions = { provider: selection.provider, model: selection.model };
    ```
  - `handleModel` 只调用 `saveSelection()` 写 settings，**不更新** `selection` / `agentOptions` 两个闭包变量
  - 底层 `currentSelection()` 每次返回**新对象**（`dsh-agent-default-model/lib/index.js:56`），闭包捕获的是旧引用
- **后果**：`/model` 显示"已设置"，但当前进程内新建/恢复的 agent 仍用旧模型，需重启 `dsh` 才真正生效。README 第 89 行「对新 agent 生效」与实际行为不符
- **修复**：`spawn()` 每次重新读取 `defaultModel.currentSelection()` 再构造 `agentOptions` 和 `setup`，不要在外层固定

### 1.2 `/resume` 失败会丢当前会话 + 后续输入静默丢弃

- **位置**：`tui-runner.mjs:200-226`（spawn）+ `tui-runner.mjs:354`（静默丢弃点）
- **证据**：
  - `spawn()` 先 `dispose()` 当前 agent、置 `current = null`，再 `agents.resume()`
  - resume 抛错（id 不存在等）时，`/resume` 的 catch 只打印错误，但 `current` 已是 null
  - 后续任何普通输入都走 `if (!current) return;`（354 行）**被静默丢弃**，用户还以为在对话
- **后果**：resume 失败 → 当前会话丢失 + 所有后续输入无响应
- **修复**：resume 失败时回滚——恢复原 agent，或先 resume 成功再 dispose 旧的

---

## 二、P1 交互体验缺失（重要）

### 2.1 Ctrl+C 不能中断正在进行的 turn

- **位置**：`tui-runner.mjs:409-417`
- **证据**：`SIGINT` handler 只问 "quit? (y/N)"；模型输出中无法取消当前轮，只能退出进程
- **修复**：turn 进行中 Ctrl+C → `agent.cancel()`（`dsh-agent-loop` 有现成 API）；空闲时才是退出确认

### 2.2 多行粘贴会被拆成多条独立消息

- **位置**：`tui-runner.mjs:408`（`rl.on("line")`）
- **证据**：readline `line` 事件逐行触发，粘贴的多行文本每行都成为独立 user turn
- **修复**：检测连续快速行合并为一条，或提供多行输入模式

---

## 三、P2 完善项

| # | 项 | 位置 | 说明 |
|---|---|---|---|
| 3.1 | `/compact` 缺第三参数 | `tui-runner.mjs:271-274` | 官方 `compactNow(agent, signal, sourceCommandId)` 传 `invocation.commandId` 做展示关联（`dsh-command-compact/lib/index.js:54`）；现在传 2 参不 crash 但少关联 |
| 3.2 | `streamTurn` 前缀不匹配整段重打 | `tui-runner.mjs:84-85` | `else io.stdout.write(text)` 会把已打印内容重打一遍，极端情况闪屏；改为只打印增量 |
| 3.3 | `inject` 声明与 `ctx.get()` 并存 | `tui-runner.mjs:20` vs `:467-473` | 声明了声明式注入却又在 `run()` 里 `ctx.get()` 运行时取，两套并存。统一为声明式注入更清晰 |
| 3.4 | 无 token/用量显示 | `streamTurn` 返回后 | dsh 有 `dsh-token-meter`，可每轮后显示 token 消耗（类似 web 端） |
| 3.5 | BANNER 每次启动都打 | `tui-runner.mjs:447` | 加 `--quiet` 或 `DSH_NO_BANNER`；占屏约 20 行 |
| 3.6 | `/model` 不支持 effort 参数 | `tui-runner.mjs:251-253` | `currentSelection()` 返回 `reasoningEffort`，但 `handleModel` 只解析 `provider/model` |
| 3.7 | `listSessions` 直接 readdir | `tui-runner.mjs:119-141` | 官方 persistence 有 header 行校验（`dsh-session-persistence-jsonl/lib/index.js:1036`）；损坏/半截会话也会列出。可用官方 `ctx.sessionPersistence` 的 list API |
| 3.8 | tool 成功结果无显示 | `tui-runner.mjs:88-93` | 只显示 `[tool] 名` 和 `[tool error]`，成功结果摘要不展示（bash 输出等），用户看不到工具干了什么 |

---

## 四、界面（UI/UX）优化建议

### 4.1 输入侧（最影响手感）

**4.1.1 Prompt 是裸的默认 `> `**
- 证据：`createInterface`（366-370 行）没设 `prompt`，所有 `rl.prompt()`（404/414/454 行）显示 Node 默认 `> `
- 优化：自定义 prompt（`❯ `），并区分输入态/忙态——agent 运行时 prompt 变灰或变 spinner

**4.1.2 流式输出会打断正在编辑的输入行** ⭐ 最值得做
- 证据：`streamTurn` 直接 `io.stdout.write()`（82/90/108 行），readline 输入行"浮"在终端，assistant 输出会穿插在用户正在打的字中间，光标位置全乱
- 优化：输出前保存当前输入行（`rl.line`），写完增量后重绘；或输出期间用 ANSI 光标管理
- 这是 TUI 里"专业 vs 玩具"的分水岭

**4.1.3 用户消息没有回显区分**
- 普通输入行直接进入，与 assistant 输出同色同风格，会话记录无法快速扫读
- 优化：提交时用颜色回显一行（如 `❯ 你的消息` 青色），与模型输出形成视觉分隔

**4.1.4 Ctrl+C 语义不对**（见 2.1，界面角度补充）
- 模型输出中按 Ctrl+C 是"退出确认"而不是"取消本轮"——主流 CLI 都是先取消后退出

### 4.2 输出侧（信息层级）

**4.2.1 Markdown 是裸奔的**
- 证据：`streamTurn` 把 `block.text` 原样输出（76-79 行），**加粗/代码块/列表/标题全部无渲染**，代码块没有着色没有框线，长回答是纯文本墙
- 优化：轻量 ANSI 渲染（`**bold**`、`# 标题`、代码块整体一个底色）——不需要引库，约 50 行可搞定；或接现成 `marked` + `cli-highlight`

**4.2.2 工具调用只有一行干巴巴的 `[tool] 名`**
- 证据：90 行 `\x1b[2m[tool] ${ev.data.name}\x1b[0m`——没有参数、没有耗时、没有结果预览
- 优化：`[tool] bash · 2.3s · 输出前 80 字符`，成功/失败不同色；这是用户感知 agent"在干什么"的主要通道

**4.2.3 无"思考中"状态指示**
- `followup` 后到第一个 token 之间是死寂的（有时几秒），用户不知道是卡了还是在想
- 优化：spinner + "thinking…"（用 `\x1b[?25l` 隐藏光标 + 循环帧）

**4.2.4 会话横幅信息过少**
- 证据：448-451 行只显示 `session id · cwd`，id 是一串随机 UUID，人不可读
- 优化：显示**会话标题**——dsh-base 本身就挂了 `dsh-session-title` + `dsh-session-title-first-prompt-llm`（已核实 `dsh-base/cordis.patch.yml:33-55`）；`--list` 时也显示标题 + 消息数 + 相对时间，而不是裸 id + mtime（119-141 行）

### 4.3 结构侧

**4.3.1 BANNER 每次启动打 20+ 行 ASCII art**
- 占屏且无信息量；主流 CLI 的 logo 收进 `--version` 或只在 TTY 且无历史时打
- 优化：`--quiet` / 环境变量关闭；管道模式（非 TTY）打 BANNER 纯属噪音

**4.3.2 `/list` 不能交互选择**
- 现在只能看 id 再手动 `/resume <id>` 复制粘贴
- 优化：`/resume` 无参数时列出最近 N 个会话，上下键选择（readline 的 `question` + 简单菜单即可）

**4.3.3 没有彩色/单色自适应**
- 硬编码 ANSI 色（`\x1b[2m` 灰、`\x1b[31m` 红等），浅色终端会看不清灰色；不尊重 `NO_COLOR`/`TERM=dumb`
- 优化：集中一个 `style()` 函数，检测 `NO_COLOR` 和 `isTTY`

---

## 五、优先级总表

| 优先级 | 项 | 工作量 | 收益 |
|---|---|---|---|
| 🔴 P0 | 1.1 `/model` 切换不生效 | 小（~5 行） | 功能正确性 |
| 🔴 P0 | 1.2 `/resume` 失败丢会话 | 中 | 功能正确性 |
| 🔴 P0 | 4.1.2 流式输出不打断输入行 | 中 | 手感质变 |
| 🔴 P0 | 4.1.3 用户消息回显区分 | 小 | 可读性质变 |
| 🔴 P0 | 4.1.4 Ctrl+C 取消本轮 | 小 | 交互正确性 |
| 🟡 P1 | 4.2.1 Markdown 轻量渲染 | 中 | 可读性 |
| 🟡 P1 | 4.2.2 tool 调用带参数/耗时/结果 | 中 | 透明度 |
| 🟡 P1 | 4.2.3 thinking spinner | 小 | 等待体验 |
| 🟢 P2 | 2.2 多行粘贴合并 | 小 | 输入体验 |
| 🟢 P2 | 3.1-3.8 / 4.1.1 / 4.2.4 / 4.3.x | 小-中 | 打磨 |

**一句话**：功能层已经到位（不用动架构），把 P0 五项做完，手感就能从"能用"跳到"想天天用"。

---

## 六、建议执行方式

- **P0 两项 bug（1.1 / 1.2）**：`tui-runner.mjs` 单文件改动 <20 行，可直接改
- **界面 P0 三项（4.1.2 / 4.1.3 / 4.1.4）**：涉及 readline 交互改造，建议一次做完再验证
- 若项目是 deepseek 自己写的，可把本清单丢回给它认领，验收按 P0 → P1 → P2 逐批
