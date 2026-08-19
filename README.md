# dsh-tui

`dsh-tui` 是一个运行在 **DeepSeek Harness (DSH)** 之上的终端交互 profile。它不需要启动 Web 服务，也不监听端口，直接在终端里创建和恢复 agent 会话。

## 特性

- 终端内多轮对话，支持会话持久化和恢复。
- 不依赖 Web UI，适合日常在命令行中使用。
- 支持常用会话命令、模型选择、历史滚动和管道输入。
- TTY 模式提供更顺手的输入框、轻量 Markdown 显示和文本复制体验。

## 平台支持

目前主要在 macOS 的终端环境中使用和验证。Linux / WSL 理论上可以运行，但还没有系统测试；Windows 原生终端暂未验证。

已验证环境：macOS 26.5、macOS Terminal（TTY）与 DSH CLI `0.1.0-rc.6`。本 profile 的依赖和 smoke test 以 `0.1.0-rc.6` 为兼容基线；升级 DSH 后请先运行下方的 smoke 命令确认组合仍可加载。

不同终端对键盘、鼠标和剪贴板能力的支持不完全一致，如果遇到交互差异，欢迎反馈具体系统和终端应用。

## 安装

前置要求：Node.js 22 或更高版本。先安装 DSH CLI（本仓库已验证 `0.1.0-rc.6`）：

```bash
npm install --global @deepseek-ai/dsh@0.1.0-rc.6
dsh --version
```

第二条命令应输出 `0.1.0-rc.6`。同一 `0.1.0` RC 系列的较新版本也可能可用，但 DSH 的 profile 组合仍在快速演进，升级后应运行 `dsh --profile tui --dump-config` 验证。

本项目是一个 DSH profile。推荐把仓库放在任意开发目录，然后链接到 DSH profile 目录：

```bash
git clone <repo-url> dsh-tui-profile
cd dsh-tui-profile
npm ci

mkdir -p ~/.dsh/profiles
ln -s "$PWD" ~/.dsh/profiles/tui
```

如果你已经有 `~/.dsh/profiles/tui`，请先确认它是否指向旧版本目录，再决定是否替换。

DSH 也支持通过 `dsh plugin --profile <name> add <local-package>` 添加本地 package。当前仓库作为完整 profile 使用时，symlink 方式最直接；如果后续封装成标准 DSH plugin，可以再切换到 plugin 安装方式。

## 首次配置模型

`dsh-tui` 不直接保存模型密钥。DeepSeek 的最简路径只需要 API key：profile base 已提供默认路由 `deepseek-official/deepseek-v4-flash`，不需要 `DSH_MODEL`。

```bash
export DEEPSEEK_API_KEY="<your-api-key>"
```

如需显式切换默认模型，把选择写入 DSH 用户设置（不要把 key 写入此文件）：

```yaml
 # ~/.dsh/settings.yaml
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: low # 可选；仅模型支持时设置
```

其他 provider 也通过同一个 `~/.dsh/settings.yaml` 的 `llm-pi-ai` 区段注册。以下是可加载的 OpenAI 兼容网关示例；`llm-pi-ai` 已由 DSH base 以正确的 service id 挂载，**不要**用 name mismatch 的 `id: llm` patch 覆盖它：

```bash
export OPENAI_API_KEY="<your-api-key>"
```

```yaml
# ~/.dsh/settings.yaml
agent-default-model:
  provider: openai-compatible
  model: your-model-id
llm-pi-ai:
  providers:
    openai-compatible:
      displayName: OpenAI Compatible
      apiKeyEnv: OPENAI_API_KEY
      api: openai-completions
      baseURL: https://example.com/v1
      models:
        - id: your-model-id
          name: Your Model
          contextWindow: 65536
          maxTokens: 4096
```

进入 TUI 后，可以用 `/model` 查看和选择 DSH 当前可用的 provider / model。

## 使用

```bash
dsh --profile tui                  # 自动恢复当前目录最后有持久化事件的会话，没有则新建
dsh --profile tui --new            # 强制新会话
dsh --profile tui --resume <id>    # 恢复指定会话
dsh --profile tui --list           # 列出本项目会话
dsh --profile tui --quiet          # 不显示启动 logo
```

如果想要短命令，可以在自己的 shell 配置里加 alias：

```bash
alias deepseek='dsh --profile tui'
```

管道模式也可用：

```bash
printf 'say hello in one word\n' | dsh --profile tui --new
```

管道模式会按输入顺序串行处理每一行。用户取消的 turn 不算失败；任一 provider 或 agent turn 失败时，stdin EOF 后进程以非零退出，适合脚本检测。

## 会话内命令

```text
/exit                    保存并退出
/new                     开始新会话
/resume                  查看最近会话
/resume <id>             恢复指定会话
/list                    列出当前项目会话
/clear                   清空当前屏幕
/model                   选择 provider / model
/model <name> [effort]   切换默认模型
/compact                 压缩上下文
```

以 `/` 开头输入时会显示命令候选。长对话可以滚动查看历史；停留在历史位置时，新输出不会强制把视图拉回底部。

TUI transcript 默认最多保留 2000 行，超出时保留最新内容并在顶部提示累计截断行数；可用 `DSH_TUI_TRANSCRIPT_LINES` 调整上限。

拖拽选择对话区文本后，松开鼠标会自动写入剪贴板；在 macOS 上会同时使用系统剪贴板能力和终端 OSC 52。

## 项目结构

```text
tui-startup.mjs    解析命令行参数
tui-runner.mjs     创建/恢复 agent，会话命令和流式输出
tui-ui.mjs         Ink TUI 输入框、状态栏和对话区
cordis.patch.yml   DSH profile 挂载配置
cordis.yml         profile 根配置
```

## 开发

```bash
npm run check
```

该命令包含语法与纯函数单测，不会启动 agent，也不会改动本机会话。CI 还会在临时 `HOME` 中执行 `dsh --profile tui --help`、`--list`、`--dump-config` 的 profile smoke test，不会请求模型。涉及终端交互的改动，建议在真实终端中手动测试。

## 安全边界

本 profile 会加载 DSH code runtime，并允许通过 `DSH_TOOLS_MODE` 等 DSH 配置启用工具能力。请只在可信工作区中运行，不要在不信任的仓库里直接启动。

请注意：

- 工具能力配置和文件系统 sandbox 是两套不同边界，启用工具前应分别确认。
- 工具输入和输出会写入 DSH 的持久会话；终端默认只显示脱敏参数与完成状态。仅在明确需要排查时设置 `DSH_TUI_VERBOSE_TOOLS=1` 显示完整的、仍会过滤终端控制符的工具内容。
- 不要把 API Key、访问令牌、私钥或会话日志放进项目工作区。
- 如果需要工具执行能力，请显式确认 DSH / sandbox 配置符合你的预期。
- 开源反馈和 issue 中不要粘贴包含凭据、私有路径或敏感会话内容的日志。

## 已知限制

- `/model` 改的是默认模型选择，不会热切换当前已经创建的会话；需要 `/new` 或 `/resume` 后生效。
- 流式输出阶段的 Markdown 不做完整解析，最终消息稳定后再做轻量显示。
- 不同系统和终端对键盘、鼠标、剪贴板能力的支持可能不同。
- 在部分 DSH launcher 版本中，TTY 下执行 `/exit` 可能因 launcher 的 HMR/chokidar watcher 竞态而未自行退出。profile 会在完成会话 flush 并调用 launcher 的退出接口后，等待 3 秒再以相同退出码强制退出；可用 `DSH_TUI_EXIT_TIMEOUT_MS` 调整等待毫秒数，设为 `0` 或负数可禁用兜底。
