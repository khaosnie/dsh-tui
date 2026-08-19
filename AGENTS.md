# Agent Install Notes

This repository is a DSH CLI profile. When installing it for a user, follow the README installation steps and then explicitly tell the user how to configure a model.

Model setup has two paths:

- Easiest: start the TUI with `dsh --profile cli`, then run `/model add` to add a DeepSeek API key. This is the recommended first-time path.
- Advanced: for other providers or custom gateways, follow the manual `~/.dsh/settings.yaml` configuration in `README.md`.

Do not invent or reuse API keys. Ask the user to provide their own key, and do not put secrets in this repository.