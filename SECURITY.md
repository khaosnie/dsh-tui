# 安全说明

## 报告安全问题

如果发现安全问题，请不要在公开 issue 中直接披露利用细节。推荐使用以下渠道：

- GitHub Security Advisories：在仓库的 **Security** 页面中选择 **Report a vulnerability**。
- 如果私密漏洞报告尚未启用，请先在 issue 中只说明“希望私密报告安全问题”，不要包含复现细节或敏感信息。

发布到 GitHub 后，维护者应在仓库设置中启用 **Private vulnerability reporting**，让上面的私密报告入口实际可用。

## 本地敏感数据

本项目是一个 DSH profile，不需要提交本地密钥、会话日志、API Key 或机器专属配置。

发布改动前，请确认没有提交：

- 包含凭据的 `.env` 文件或 shell 配置。
- `~/.dsh/sessions` 中的 DSH 会话数据。
- 带有私人路径的本地启动脚本。
- 不希望公开的提示词、回复或工具输出日志。
