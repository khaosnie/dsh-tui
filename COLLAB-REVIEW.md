# dsh CLI 与外部 Agent 协作能力审查

> 审查日期：2026-08-17
> 审查方：Aion（Hermes Agent）— 本机多 Agent 协作的调度方
> 审查对象：`dsh --profile headless`（一次性任务通道）+ `dsh --profile tui`（交互 REPL）
> 目的：让 dsh/DeepSeek Harness 项目能够像 codex CLI、pi-cli 一样，被外部 Agent（Aion）通过 CLI 派单协作
> 已实测：headless 派单、结果返回、会话落盘均可用（见下文）

---

## 一、背景：期望的协作形态

Aion 在团队中负责调度多个 AI Agent（Sotto/Pi、Codex、子 Agent），协作标准是**文本 CLI 派单**：

```bash
# 与 Codex 协作（一次性任务，可 resume）
codex exec "任务书"

# 与 Sotto/Pi 协作（带上下文任务书，保留 session 多轮跟进）
pi-cli --session <id> --task "任务书"
```

期望 dsh 也具备同等能力，成为团队「第四执行者」。当前 `dsh --profile headless` 已实现最小可用通道，但存在以下差距。

---

## 二、已可用能力（实测验证）

| 能力 | 状态 | 说明 |
|---|---|---|
| 派单 | ✅ | `dsh --profile headless "任务"` 可执行，agent 真实调用工具 |
| 结果返回 | ✅ | 最终回复打印到 stdout |
| 会话落盘 | ✅ | `~/.dsh/sessions/<项目>/<session-id>/session.jsonl.zstd` |
| 工具能力 | ✅ | 实测 bash/sandbox 工具可用 |
| 凭据 | ✅ | 环境变量 `DEEPSEEK_API_KEY` 注入即可 |

---

## 三、协作问题清单（按优先级）

### P0-1：headless 无 `--resume`，无法多轮接续 ⭐ 最核心

- **现象**：`dsh --profile headless` 每次调用都是全新冷启动会话，没有 `--resume <id>` 参数
- **影响**：审查→修改→复查这类多轮迭代协作无法实现。Aion 与 codex/pi 协作时依赖 resume 跟进同一任务的后续轮次，dsh 做不到就只能每次重发完整上下文，长任务书下 token 成本爆炸
- **期望**：
  ```
  dsh --profile headless --resume <session-id> "后续指令"
  ```
  复用已有 session 上下文，追加一条 user 消息，打印该轮最终回复后退出
- **归属**：headless 层（`@deepseek-ai/dsh-headless`）——TUI 已有 `agents.resume()` 的成熟用法（`tui-runner.mjs:376-380`），headless 加同样的选项即可

### P0-2：任务书只能走命令行 argv，不支持 stdin/文件输入

- **现象**：`task` 参数是 `[task...]` 多词拼接，无 stdin 读取、无 `--task-file` 选项
- **影响**：Aion 派单用的是 5 要素任务书（目标/上下文/验收标准/约束/输出格式），通常 1-4KB 文本。argv 有 shell 长度限制（macOS 约 256KB，但引号/换行转义极易出错）；多行任务书在 shell 里传递几乎不可用
- **期望**：
  ```
  dsh --profile headless --task-file /tmp/task.md     # 从文件读任务书
  echo "任务" | dsh --profile headless --stdin        # 或 stdin 管道
  ```
- **归属**：headless 层

### P0-3：无结构化输出，验收只能靠文本解析

- **现象**：headless 只打印最终 assistant 文本，无 JSON 输出模式、无机器可读的退出码语义
- **影响**：Aion 的验收门禁（四步：功能可用→数据准确→结论可信→偏差揭示）需要程序化提取结论/证据/状态。纯文本解析脆弱，尤其 agent 回复格式漂移时
- **期望**：
  ```
  dsh --profile headless --json "任务"   # 输出 {exit_reason, final_text, turn_error, token_usage, session_id}
  ```
  参照 codex exec 的 JSON 输出；至少提供 `--json` 模式，包含 session_id（供后续 resume）
- **归属**：headless 层（token 用量可直接复用 `dsh-token-meter`，TUI 已接：`tui-runner.mjs:500-507`）

### P1-4：无超时保护，长任务可能挂住调用方

- **现象**：headless 是前台进程，长时间任务会无限阻塞调用方；外部调用（Aion 的 terminal）需要自己包超时，但 macOS 无内置 `timeout` 命令
- **影响**：协作超时跟进机制（15 分钟无反馈必跟进）依赖调用侧能做超时控制。无内置超时则调度方无法可靠管理并发任务
- **期望**：headless 提供 `--timeout <seconds>` 参数，超时后优雅结束（flush 会话 + 非零退出 + 结构化错误）
- **归属**：headless 层

### P1-5：会话文件为 zstd 压缩，审计需要解压

- **现象**：`session.jsonl.zstd`，外部 Agent 读会话做追溯/审计需先解压（zstd 工具链）
- **影响**：Aion 的跨 Agent 审计（`agent-session-forensics`）读取 codex/pi 的会话都是明文 JSONL，dsh 需要额外解压步骤，且 zstd 二进制不一定在 PATH
- **期望**：至少提供 `dsh session export <id> --plain` 之类的明文导出命令；或 headless 结束时可 `--dump-session` 输出明文
- **归属**：headless / dsh-cmdline 层

### P2-6：凭据注入需要封装

- **现象**：key 需从 `~/.hermes/.env` 手动 source 再注入环境变量
- **影响**：调用侧需要 wrapper 脚本净化（.env 中还有无关坏行会打噪音到 stderr）
- **期望**：无 CLI 侧改动需求；Aion 侧 wrapper 解决（见下节「调用侧方案」）

---

## 四、调用侧（Aion）可自行解决的

以下问题不需要改 dsh 项目，Aion 侧 wrapper 即可：

| 问题 | 方案 |
|---|---|
| P2-6 凭据注入 | `~/.local/bin/dsh-task` wrapper：source key + 净化 stderr |
| P1-5 会话解压 | wrapper 内 `zstd -d` 或 `python3 -c zstandard` |
| P1-4 调用方超时 | wrapper 内 Python `subprocess.run(timeout=...)` 包一层 |

---

## 五、改进优先级建议

| 优先级 | 项 | 工作量（估） | 收益 |
|---|---|---|---|
| 🔴 P0-1 | headless `--resume` | 小（复用 TUI 的 `agents.resume()`） | 解锁多轮协作，质变 |
| 🔴 P0-2 | `--task-file` / `--stdin` | 小 | 任务书可靠传递 |
| 🔴 P0-3 | `--json` 结构化输出 | 中 | 验收门禁自动化 |
| 🟡 P1-4 | `--timeout` | 小 | 调度可靠性 |
| 🟡 P1-5 | 明文会话导出 | 小 | 审计可追溯 |
| 🟢 P2-6 | （调用侧 wrapper 解决） | — | — |

**一句话**：P0-1 是最大短板——headless 加上 `--resume` 后，dsh 就能从「单发任务工具」升级为「可迭代协作的团队成员」。

---

## 六、验证标准（改完后 Aion 侧验收）

1. `dsh --profile headless --resume <id> "追加指令"` 能正确接续上下文并打印新回复
2. `echo "任务" | dsh --profile headless --stdin` 与 `--task-file` 均可用
3. `dsh --profile headless --json "任务"` 输出含 session_id / final_text / token_usage
4. `--timeout 30` 超时后非零退出且会话已 flush
5. 明文导出命令可读（无需 zstd 工具链）
