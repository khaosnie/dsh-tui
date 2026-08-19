# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号按语义化版本发布时确定。

## [Unreleased]

### Security

- 新增 `tui-safety.mjs`：对外部文本（模型输出、工具输出、配置字符串等）统一净化 ESC/C0/C1、CSI/OSC/DCS/APC/PM/SOS 控制序列，程序自生成的 ANSI 高亮不受影响。
- 工具参数默认脱敏（敏感字段值打码 `***`）、工具成功结果默认不展示正文；`DSH_TUI_VERBOSE_TOOLS=1` 显式查看完整内容（会暴露敏感信息）。

### Fixed

- TTY 命令串行化：运行中的 turn 期间 `/new`、`/resume`、`/exit` 与普通消息统一排队，消除并发竞态；turn 使用局部 session handle，旧 turn 结束后不再错 flush 新会话。
- TTY 模式下首个 turn 完成后不再因 `rl.prompt()` 空引用崩溃（修复引入的回归，第二轮复查发现）。
- 管道模式 agent/provider 错误（如缺 API key）退出码从 0 修正为非 0（1）；用户取消不计失败。
- 管道模式无参 `/model` 在 EOF 后不再挂起（打印模型列表后直接返回；TTY 交互选择走 TUI 面板）。
- 拖选复制文本去除程序生成的 ANSI 码；渲染展示保留颜色。
- transcript 默认保留最后 2000 行（`DSH_TUI_TRANSCRIPT_LINES` 可配），顶部显示截断提示。
- 自动恢复与 `/list` 的「最近」按最后活动时间（最后持久化事件）而非创建时间排序。
- 启动阶段（spawn 就绪前）提交的输入不再静默丢失，ready 后统一处理。

### Changed

- README 重写上手章节：补充 dsh CLI 安装步骤（`npm install --global @deepseek-ai/dsh@0.1.0-rc.6` 及版本验收）；模型配置改为真实可用的 `~/.dsh/settings.yaml` 示例（删除无效的 `DSH_MODEL` 指引）；其他 provider 配置示例修正为正确的 service id 写法。
- 明确已验证环境矩阵（macOS 26.5 / macOS Terminal / dsh 0.1.0-rc.6）。
- TTY `/exit` 退出兜底：`flushAndExit` 后设置 unref 定时器（默认 3s，`DSH_TUI_EXIT_TIMEOUT_MS` 可配，`0` 禁用），launcher 未及时让进程退出时以相同退出码强制退出（防御性兜底）。
- 移除 `pnpm-workspace.yaml`（仓库统一使用 npm）。

### CI

- `.github/workflows/check.yml`：增加 `permissions: contents: read`；新增临时 HOME 下的 profile smoke 测试（`--help` / `--list` / `--dump-config`），每条命令 `timeout 30s` 防挂起；`npm run check` 接入单测（净化/脱敏/transcript/EOF/退出超时共 8 项）。

### Known issues

- `dsh --profile cli --list` 存在间歇性挂起（输出后进程不退出）：已复现于 launcher 0.1.0-rc.6 与 0.1.0-rc.7，定位指向 launcher 层 HMR watcher 生命周期，profile 层无法修复；CI smoke 已用 `timeout 30s` 兜底，建议上游修复后升级验证。
- 管道模式 `--resume` 后立即关闭 stdin 可能偶发丢行（launcher 引导期竞态，基线同现）。