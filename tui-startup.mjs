import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

/**
 * @deepseek-ai/dsh-tui-startup — 终端交互入口的命令行参数解析器。
 * 解析 `--new` / `--resume <id>` / `--list` / `--quiet`，并把结果发布为
 * `tuiStartup` 服务，供 tui-runner 消费。
 */
export const name = "tui-startup";
export const inject = ["cmdlineArgs"];
export const TUI_STARTUP_SERVICE = "tuiStartup";

function tuiCommand() {
	return new Command()
		.name("dsh --profile tui")
		.description("在终端中与 DeepSeek Harness coding agent 交互")
		.helpOption("-h, --help", "显示帮助")
		.option("--new", "新建会话，不恢复最近会话")
		.option("--resume <id>", "恢复指定会话")
		.option("--list", "列出当前项目的持久化会话并退出")
		.option("--quiet", "不显示启动 logo")
		.addHelpText("after", `
示例:
  dsh --profile tui                  恢复最近会话，没有则新建
  dsh --profile tui --new            新建会话
  dsh --profile tui --resume <id>    恢复指定会话
  dsh --profile tui --list           列出当前项目会话
  dsh --profile tui --quiet          启动时不显示 logo
`);
}

export function apply(ctx) {
	const program = tuiCommand();
	program.action(() => {
		const opts = program.opts();
		ctx.provide(TUI_STARTUP_SERVICE, {
			fresh: opts.new === true,
			resumeId: typeof opts.resume === "string" ? opts.resume : null,
			list: opts.list === true,
			quiet: opts.quiet === true
		});
	});
	parseCmdline(ctx, program);
}
