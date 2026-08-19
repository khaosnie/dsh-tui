# dsh-tui — DeepSeek Harness 终端交互 CLI

一个运行在 **DeepSeek Harness (DSH)** 之上的交互式终端 CLI。它**不依赖任何 Web 服务器或监听端口**（不需要 3080），直接在本进程内创建 agent、读写会话，实现持久化多轮对话。

## 快速启动

```bash
dsh                     # 自动恢复当前目录最近会话，没有则新建
deepseek                # 同上（别名）
dsh --profile tui --new            # 强制新会话
dsh --profile tui --resume <id>    # 恢复指定会话
dsh --profile tui --list           # 列出本项目会话
dsh --profile tui --quiet          # 不打启动 logo
```

管道模式（非 TTY）不打 logo、不打 spinner、不藏光标：

```bash
printf 'say hello in one word\n' | dsh --profile tui --new
```

也可用 `DSH_NO_BANNER=1` 或 `NO_COLOR=1`。

## 项目文件（按重要性排序）

| 文件 | 作用 |
|---|---|
| `tui-runner.mjs` | **核心**。会话创建/恢复、流式输出、全部 `/命令`，并在 TTY 中挂载 Ink UI |
| `tui-ui.mjs` | Ink + React（无 JSX）命令面板：输入、候选列表、模型菜单、状态栏 |
| `tui-startup.mjs` | 命令行解析（`--new/--resume/--list/--quiet/--help`），发布 `tuiStartup` 服务 |
| `cordis.patch.yml` | profile 挂载层：persona 配置、禁用 HMR、插入上述两个插件 |
| `package.json` | profile manifest，声明 bundle 依赖 `@deepseek-ai/dsh-base` |
| `cordis.yml` | 空根配置（loader 锚点，勿手改） |

### 启动器脚本（在 PATH 里）

| 文件 | 作用 |
|---|---|
| `~/.npm-global/bin/dsh` | 包装脚本：**无参数 → TUI**；有参数 → 透传真实 dsh（`dsh web` 等不受影响） |
| `~/.local/bin/deepseek` | `deepseek` 命令 → TUI |
| `~/.local/bin/deepseek.bak-webclient` | 旧版伪 CLI 备份（依赖 3080，已弃用） |

## 架构（为什么不需要 3080）

DSH 的 profile 是 cordis 插件组合。官方有 `web`（需要 HTTP 端口）和 `headless`（一次性任务，无交互）两种。本项目是第三种：

```
dsh --profile tui
  └─ dsh-base (核心: agent/llm/session/persistence/tools)
      └─ tui-startup  解析命令行 → 提供 tuiStartup 服务
      └─ tui-runner   消费 tuiStartup：
                       1. agents.resume() 或 agents.create() 建 agent
                       2. TTY 使用 Ink 命令面板；管道输入继续使用 readline 队列
                       3. agent.followup() 发消息 → whenIdle() 等待
                       4. 在 agent.ctx 上订阅 session/event 流式打印
                       5. 每轮 sessions.flush() 持久化
```

**会话持久化**：与 web 共用同一 JSONL 存储（`~/.dsh/sessions/`），所以 `--list` 能看到 web 的会话，`--resume` 能接续任何会话。列表走 `ctx.sessionPersistence.list()`，不扫盘。

## 会话内命令

```
/exit           quit (saves the session)
/new            start a fresh session
/resume         list recent sessions
/resume <id>    resume a specific session
/list           list persisted sessions for this project
/clear          clear the terminal screen
/model          choose a registered provider/model
/model <name> [effort]   switch the default model
/compact        compact the conversation history
```

TTY 中以 `/` 开头会在输入框上显示匹配命令。用 `↑/↓` 或 `1–9` 选择并按 Enter 执行；`/model` 会打开由 DSH 当前 `llm.listProviders()` / `llm.listModels()` 提供的 provider/model 菜单。长对话可用鼠标滚轮或 `PgUp/PgDn` 按行翻页；停留在历史位置时，流式新输出不会抢回视图。底部状态栏持续显示 context usage、provider/model、会话和 turn 状态。管道模式保留 readline 队列，不渲染 Ink。

## TTY 行为

- **光标 / IME**：TTY 只用硬件光标，钉在输入框 caret；系统中文候选框跟这个光标，没有假光标 `▏`。`←/→` 移动插入点，`Shift+←/→` 选中，`Ctrl+A` 全选，选中后 `Ctrl+C` 复制。
- **鼠标 / 触控板**：默认开启鼠标滚轮上报，让触控板滚动翻页；需要复制终端文本时使用终端的鼠标模式旁路（macOS/Cursor 常见为 Option/Alt 拖拽）或键盘选区复制。
- **多行输入**：`Shift+Enter`（或 `Option+Enter` / `Ctrl+J`）换行，普通 Enter 发送。输入框最多长到 8 行。`Home/End` 移动到当前行首/行尾。TTY 启动时会打开 kitty keyboard protocol 和 xterm `modifyOtherKeys`，这样 Cursor / iTerm / Ghostty 才能把 Shift+Enter 和 Enter 区分开。
- **Markdown 显示**：TTY 输出会轻量渲染标题、`**粗体**`、行内代码、引用、代码块和表格分隔行；会话存档仍保留原始 Markdown 文本。
- **生成中不可二次提交**：turn running 时普通 Enter 被吞，不会开第二轮。
- **busy 时命令**：`/exit`、`/new`、`/resume` 仍可用；`/new` / `/resume` 会丢掉当前 turn（dispose 旧 agent）。
- **滚轮**：方向与 macOS 自然滚动一致（两指上滑看更新内容）。

## 关键技术点（对开发者）

- **agent 生命周期**：`agents.create({sessionId, meta:{cwd}, agentOptions, setup})` / `agents.resume({resumeSessionId, ...})`，返回 `{agent, dispose}`。`installModelSelection()` 绑定模型。`spawn()` 每次重新读取 `currentSelection()`。create/resume **成功后再** dispose 旧 agent。
- **发消息**：`agent.followup(createUserMessage({content, source}))` → `await agent.whenIdle()`。
- **流式输出**：在 `current.agent.ctx` 上订 `session/event`（作用域事件，不可挂 runner ctx 而不过滤）。resume 的 seed **不 emit**，所以仍要先 snapshot drain。
- **取消**：生成中 Ctrl+C → `agent.cancel({ kind: "user" }, { keepInbox: true })`。空闲 Ctrl+C 确认退出；连按第二次直接退出。
- **管道输入**（非 TTY）：stdin EOF 会立刻触发 `close`，必须用队列 + `ready` 标志延迟处理。drain 结束后若 queue 非空会再 drain。
- **compaction**：`ctx.compaction.compactNow(agent, signal)`，失败抛 `ManualCompactionError`（`error.code` 有 `busy/changed/summary/...`）。
- **模型切换**：`saveSelection()` 只改默认选择，**不改变当前会话已绑定的模型**。须 `/new` 或 `/resume`，同进程立即生效。
- **光标**：TTY 由 Ink `useCursor` / `setCursorPosition` 独占硬件光标，钉在输入行。`ui` 挂载时裸 spinner、`clearLine`、`cursorTo`、`\x1b[?25l` 全部 no-op。非 TTY 不藏光标。`restoreCursor()` 覆盖 cancel、`flushAndExit`、`rl.on("close")`、`SIGTERM`/`SIGHUP`，并用 `process.on("exit")` 兜底。

## 底层框架位置（如需深入）

DSH 核心包（bundle、API 定义）在：
`/Users/niexueke/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/`

关键子包：
- `dsh-headless` — 一次性任务的参考实现（本项目 runner 的模板）
- `dsh-cmdline` — 命令行/退出钩子
- `dsh-agent` / `dsh-agent-loop` — agent 与会话 API
- `dsh-session` / `dsh-session-persistence-jsonl` — 事件与持久化
- `dsh-compaction` / `dsh-command-compact` — 压缩
- `dsh-agent-default-model` — 模型选择

## 已知限制

- `bash` 工具依赖宿主机 sandbox（`sandbox-exec`）。若启动 TUI 的进程本身已在沙箱内（如从另一个沙箱 bash 启动），嵌套沙箱会被内核拒绝 → 工具报"沙箱后端不可用"。从真实终端启动无此问题。
- `/model` 不热切换当前会话的模型；改的是默认选择，对下一个 `/new` 或 `/resume` 生效。
- `/resume` 失败时保留当前会话，后续输入不会被丢弃。
- markdown 着色在助手消息被整段替换时应用；流式增量仍是原文，避免半套解析。
- `--list` 的「最近」按 `createdAt` 排序（官方 `list()` 不提供 mtime）。标题通过 `inspect` 读取最近最多 20 条，大日志会慢。
