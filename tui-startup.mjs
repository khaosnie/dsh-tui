import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

/**
 * @deepseek-ai/dsh-tui-startup — the interactive terminal app's command-line
 * provider. It parses `--new` / `--resume <id>` / `--list` / `--quiet` and
 * publishes the parsed values as the `tuiStartup` service; the tui-runner
 * row consumes it.
 */
export const name = "tui-startup";
export const inject = ["cmdlineArgs"];
export const TUI_STARTUP_SERVICE = "tuiStartup";

function tuiCommand() {
	return new Command()
		.name("dsh --profile tui")
		.description("Interactive terminal chat with the DeepSeek Harness coding agent")
		.helpOption("-h, --help", "show this help")
		.option("--new", "start a fresh session instead of resuming the latest one")
		.option("--resume <id>", "resume the persisted session with the given id")
		.option("--list", "list persisted sessions for this project and exit")
		.option("--quiet", "skip the startup banner")
		.addHelpText("after", `
Examples:
  dsh --profile tui                  resume the latest session, or start one
  dsh --profile tui --new            start a fresh session
  dsh --profile tui --resume <id>    resume a specific session
  dsh --profile tui --list           show persisted sessions for this project
  dsh --profile tui --quiet          start without the ASCII banner
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
