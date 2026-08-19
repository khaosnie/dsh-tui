# dsh 外部 Agent 协作 Profile 实施方案

> 日期：2026-08-17  
> 目标：让外部调度 Agent 能以稳定、可审计、可多轮接续的 CLI 方式调用 DeepSeek Harness。

## 1. 决策与边界

新增独立 profile：`dsh --profile collab`。

不修改：

- `@deepseek-ai/dsh-headless` 的 npm 安装目录；
- 现有 `dsh --profile tui`；
- 默认 `dsh` 行为、全局配置和既有 session 文件格式。

这样更新 DSH 时不会覆盖本地协作能力，也不会改变日常 TUI 使用体验。

同一 session ID 在同一时间只能被一个进程恢复和写入；协作 profile 必须自行实施跨进程锁，不能依赖 DSH 持久化层。

现有 `dsh-session-persistence` 的 reservation 只在单一 Node 进程的内存中协调。JSONL 后端保证单个写入的崩溃恢复和原子发布，但不协调另一 backend 实例或另一进程对同一 session 的写入。因此，两个进程并发 `--resume` 同一 session 会产生静默覆盖或丢失事件的风险。

## 2. 命令契约

```bash
# 新建一次性协作任务
dsh --profile collab "检查当前项目的测试失败原因"

# 从持久化会话继续执行
dsh --profile collab --resume <session-id> "根据上次结论修复问题并运行测试"

# 从标准输入读取多行任务书
cat task.md | dsh --profile collab --stdin

# 从文件读取多行任务书
dsh --profile collab --task-file /tmp/task.md

# 机器可读结果；stdout 只输出 JSON
dsh --profile collab --json "审查本次改动"

# 超时后取消本轮、持久化 session，并以非零码退出（默认 900 秒）
dsh --profile collab --timeout 900 "执行完整测试并修复失败项"

# 导出 session 为普通 JSONL
dsh --profile collab --export-session <session-id>
```

`task` 位置参数、`--stdin`、`--task-file` 三者必须恰好选择一个。  
`--export-session` 是只读命令，不能与任务输入或 `--resume` 合用。

## 3. 输出与退出码

默认模式保持适合人工阅读的行为：

- stdout：最终 assistant 回复；
- stderr：运行错误与诊断；
- 退出码：`0` 成功，`1` 模型/运行失败或取消，`2` 参数、输入或锁冲突，`124` 超时取消。

`--json` 模式的 stdout 必须只写一条 JSON，避免调度器解析日志：

```json
{
  "schema_version": 1,
  "session_id": "session-…",
  "status": "completed",
  "exit_code": 0,
  "final_text": "…",
  "exit_reason": { "kind": "completed" },
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "reasoning_tokens": 0,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0
  },
  "context_estimate": {
    "total_tokens": 0
  }
}
```

约定：

- `usage` 来自本轮 `assistant/message.data.usage`，可能因 provider 不提供而为 `null`；
- `context_estimate` 来自 `tokenMeter.measure()`，它是上下文估算，不能当作 API 实际计费；
- `status` 取 `completed`、`cancelled`、`timeout`、`error`；
- 状态与退出码映射固定为：`completed → 0`、`cancelled → 1`、`error → 1`、`timeout → 124`；参数、输入及锁冲突在无法形成任务结果时退出 `2`；
- JSON 模式的 stderr 只保留启动级异常；可预期的运行错误写入 JSON 的 `exit_reason`。

## 4. 实现结构

建议新增独立目录 `~/.dsh/profiles/collab/`：

```text
collab/
├── cordis.yml
├── cordis.patch.yml
├── collab-startup.mjs
├── collab-runner.mjs
└── README.md
```

`cordis.patch.yml` 从 `dsh-base` 组装运行环境，插入本地 `collab-startup` 与 `collab-runner`，并注入：

- `agentDefaultModel`
- `agents`
- `sessions`
- `sessionPersistence`
- `tokenMeter`

不复用官方 `headless-startup` / `headless-runner`，因为它们当前只接受 argv task，且强制新建随机 session。

## 5. 核心实现

### 5.1 参数与任务输入

`collab-startup.mjs` 使用 Commander 解析：

- `--resume <id>`
- `--stdin`
- `--task-file <path>`
- `--json`
- `--timeout <seconds>`（默认 `900`；`0` 表示不限制）
- `--export-session <id>`
- `[task...]`

启动层只校验参数组合和文件可读性。stdin 的异步读取应放在 runner 中完成，避免在 Commander action 生命周期中产生异步竞争。

### 5.2 跨进程 session 锁

对每个会写入 session 的运行，在创建或恢复 agent **之前**取得 session 目录下的锁：

```text
~/.dsh/sessions/<project>/<session-id>/.collab.lock
```

锁文件用 `open(path, "wx")` 原子创建，内容记录 `pid`、`hostname`、`started_at` 与 profile 版本。创建成功后直到 agent 已 idle、session 已 flush 且 handle 已 dispose 才在 `finally` 中删除。

当前使用场景是本机 `~/.dsh` 根目录，因此 stale 判断限定为同一主机：

1. 锁不存在：创建并继续；
2. 锁存在且 hostname 相同、`process.kill(pid, 0)` 表明进程存活：拒绝执行并以退出码 `2` 返回；
3. 锁存在但 pid 不存在，或锁的 mtime 超过保守 stale 阈值：记录诊断后接管；
4. hostname 不同：默认拒绝接管，要求操作者显式移除锁，避免共享卷或时钟偏差造成双写。

stale 接管必须通过“重命名旧锁到唯一隔离文件，再以 `wx` 创建新锁”的流程完成，不能直接 `unlink()` 后创建，否则两个竞争者仍可能同时进入。

新建任务也应在获得 session ID 后持锁，以避免另一个进程在该任务尚未退出时尝试恢复它。`--export-session` 是只读操作；目标 session 有活跃 writer lock 时默认拒绝导出不稳定快照。

### 5.3 创建与恢复 session

runner 每次运行都读取当前 `agentDefaultModel.currentSelection()`，据此构造 `agentOptions` 和 `installModelSelection()` setup。

- 新任务：`agents.create({ sessionId, meta, agentOptions, setup })`
- 接续：`agents.resume({ resumeSessionId: SessionId(id), agentOptions, setup })`

恢复失败时不创建替代的新 session，直接按错误退出，防止调度器误把“没有接上上下文”的结果当成成功。

### 5.4 本轮结果汇总

记录提交 followup 前的 `firstSeq`，仅扫描该序号之后的事件：

- 最后一条非空 `assistant/message` 的 text 内容作为 `final_text`；
- 最新 `assistant/message.data.usage` 作为本轮 `usage`；
- `turn/end` 作为 `exit_reason`；
- reasoning 和 tool 事件不混入最终文本。

在任意结束路径中按以下顺序收尾：

1. 停止超时计时器；
2. 必要时调用 `agent.cancel({ kind: "user" })`；
3. 等待 `agent.whenIdle()`；
4. `sessions.flush(agent.session)`；
5. 输出文本或 JSON；
6. dispose agent handle；
7. 请求进程退出。

### 5.5 超时

`--timeout` 使用 Node 定时器实现。时间到达后：

1. 记录 `timeout` 状态；
2. 调用 `agent.cancel()`，不直接 `process.exit()`；
3. 等待循环关闭并 flush；
4. 返回退出码 `124`。

这比调用方强杀进程更可靠，因为会话保留了已完成步骤和取消状态，可用于后续 `--resume`。

### 5.6 JSONL 导出

`--export-session` 使用：

```js
await sessionPersistence.readFrom(SessionId(sessionId), 0)
```

将返回的 header 与 events 序列化为逐行 JSON 输出。它读取的是 DSH 的逻辑会话视图，因此不依赖系统安装 `zstd`，也不会让调用方直接解析内部压缩文件。

导出是纯本地读路径：它不要求 `DEEPSEEK_API_KEY`，也不应初始化 agent、模型或 LLM provider。profile 的启动结构需要让 `--export-session` 在凭据校验与模型依赖之前直接进入 persistence reader。

## 6. 实施顺序

- [x] 创建 `collab` profile 骨架与最小新建任务执行。
- [x] 实现跨进程 session 锁与 `--resume`，验证上下文可以跨进程接续且无并发双写。
- [x] 实现 `--stdin`、`--task-file` 与输入互斥校验。
- [x] 实现稳定的本轮事件汇总及 `--json`。
- [x] 注入 token meter，并区分实际 usage 与上下文估算。
- [x] 实现 `--timeout` 的取消、flush、退出码流程。
- [x] 实现 `--export-session` JSONL 输出。
- [x] 添加 README、命令示例及手动验证记录。

## 7. 验收标准

1. 新任务 JSON 输出包含非空 `session_id`、`status`、`exit_code`、`final_text`。
2. `--resume <id>` 能引用上轮上下文，而不是创建新 session。
3. stdin 和 task 文件可无损传递多行、引号和 Markdown 内容。
4. `--json` stdout 可被 `JSON.parse()` 直接解析，stderr 不污染协议输出。
5. 超时后返回 `124`，且同一 session 能恢复并继续执行。
6. 同一 session 并发执行两次 `--resume` 时，第二个进程在 agent 创建前失败并返回退出码 `2`；第一个进程的 session 保持可恢复。
7. 导出的 JSONL 能在无 `zstd` 命令和无 `DEEPSEEK_API_KEY` 的环境中读取。
8. `dsh --profile tui` 的交互、默认模型选择和既有会话均不发生行为变化。
