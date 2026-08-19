# dsh-tui

`dsh-tui` 是一个运行在 **DeepSeek Harness (DSH)** 之上的终端交互 profile。它不需要启动 Web 服务，也不监听端口，直接在终端里创建和恢复 agent 会话。

## 特性

- 终端内多轮对话，支持会话持久化和恢复。
- 不依赖 Web UI，适合日常在命令行中使用。
- 支持常用会话命令、模型选择、历史滚动和管道输入。
- TTY 模式提供更顺手的输入框、轻量 Markdown 显示和文本复制体验。

## 平台支持

目前主要在 macOS 的终端环境中使用和验证。Linux / WSL 理论上可以运行，但还没有系统测试；Windows 原生终端暂未验证。

不同终端对键盘、鼠标和剪贴板能力的支持不完全一致，如果遇到交互差异，欢迎反馈具体系统和终端应用。

## 安装

本项目是一个 DSH profile。推荐把仓库放在任意开发目录，然后链接到 DSH profile 目录：

```bash
git clone <repo-url> dsh-tui-profile
cd dsh-tui-profile
npm install --legacy-peer-deps

mkdir -p ~/.dsh/profiles
ln -s "$PWD" ~/.dsh/profiles/tui
```

如果你已经有 `~/.dsh/profiles/tui`，请先确认它是否指向旧版本目录，再决定是否替换。

## 使用

```bash
dsh --profile tui                  # 自动恢复当前目录最近会话，没有则新建
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

这个检查只做语法校验，不会启动 agent，也不会改动本机会话。涉及终端交互的改动，建议在真实终端中手动测试。

## 已知限制

- `/model` 改的是默认模型选择，不会热切换当前已经创建的会话；需要 `/new` 或 `/resume` 后生效。
- 流式输出阶段的 Markdown 不做完整解析，最终消息稳定后再做轻量显示。
- 工具执行能力仍受 DSH 和宿主环境的 sandbox 限制。
