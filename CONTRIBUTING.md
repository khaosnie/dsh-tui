# 贡献指南

感谢你帮助改进 `dsh-cli`。

## 本地开发

```bash
npm ci
npm run check
```

CI 也会在临时 `HOME` 中把仓库链接为 `cli` profile，并运行 `dsh --profile cli --help`、`--list` 和 `--dump-config`。这些 smoke test 只验证 profile 组合与配置，不请求模型或消耗 token。

如果要做交互测试，可以把仓库链接为本地 DSH profile：

```bash
mkdir -p ~/.dsh/profiles
ln -s "$PWD" ~/.dsh/profiles/cli
dsh --profile cli --new
```

## 建议测试

如果修改 `tui-ui.mjs`，请尽量在真实终端里测试，不只跑语法检查。重点关注：

- 输入框编辑、多行输入和中文输入法。
- 鼠标/触控板滚动。
- 拖拽选择和复制。
- 窗口尺寸变化后的显示。

如果修改 `tui-runner.mjs`，请关注：

- 新会话和恢复会话。
- `/list`、`/new`、`/resume`、`/model`、`/compact`。
- 管道输入。

## Pull Request

请让改动尽量聚焦。如果涉及终端交互，请说明你测试过的操作系统和终端应用。