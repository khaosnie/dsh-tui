import { randomUUID } from "node:crypto";
import { createInterface, clearLine, cursorTo } from "node:readline";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { startTuiUi } from "./tui-ui.mjs";

/**
 * @deepseek-ai/dsh-tui-runner — interactive terminal agent driver.
 *
 * Boots dsh-base without any Host/HTTP layer, creates or resumes one Agent
 * through the core registry, then runs a readline REPL: each ordinary input
 * line becomes one user turn, assistant text streams to stdout as it lands,
 * and every turn flushes the Session so a later `--resume` picks up exactly
 * where this process left off.
 */
export const name = "tui-runner";
export const inject = ["agentDefaultModel", "agents", "llm", "sessions"];

const BANNER = String.raw`
                          ▄▄
         ▄▄▄▄▄▄▄▄▄▄▄▄▄█████▀        ▄██▄
      ▄█████████████████████▄▄      ███████▄▄▄▄▄▄███
    ▄███████████████████████████▄▄   ▀████████████▀
   ▄███████████████████████████████▄▄  ▀███████▀▀
  ▄███▀▀▀▀▀▀▀▀███████████████▀▀████████▄▄████▀
  ████            ▀▀███████████▄▄  ▀█████████▀
  ████               ▀▀█████████▄   ▀███████▀
   ████                ▀█████████▄▄████████▀
   ▀████▄                ▀███████████████▀
    ▀█████▄      ▄▄▄      ▀████████████▀
      ▀█████▄▄▄▄▄██████▄▄▄  ▀████████▄▄▄
         ▀▀█████████████████▀▀▀▀▀▀▀▀▀▀▀
              ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
    ██████╗ ███████╗███████╗██████╗ ███████╗███████╗███████╗██╗  ██╗
    ██╔══██╗██╔════╝██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██║ ██╔╝
    ██║  ██║█████╗  █████╗  ██████╔╝█████╗  ███████╗█████╗  █████╔╝
    ██║  ██║██╔══╝  ██╔══╝  ██╔══██╗██╔══╝  ╚════██║██╔══╝  ██╔═██╗
    ██████╔╝███████╗███████╗██║  ██║███████╗███████║███████╗██║  ██╗
    ╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝
        interactive terminal · persistent sessions · no server
`;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const PROMPT_IDLE = "› ";
const PROMPT_BUSY = "⋯ ";
const COMMANDS = [
	"/help",
	"/exit",
	"/quit",
	"/new",
	"/resume",
	"/list",
	"/clear",
	"/model",
	"/compact"
];
const COMMAND_PALETTE = [
	{ name: "/help", description: "show available commands" },
	{ name: "/exit", description: "save and quit" },
	{ name: "/quit", description: "save and quit" },
	{ name: "/new", description: "start a fresh session" },
	{ name: "/resume", description: "resume a session" },
	{ name: "/list", description: "list saved sessions" },
	{ name: "/clear", description: "clear the transcript" },
	{ name: "/model", description: "choose provider / model" },
	{ name: "/compact", description: "compact conversation history" }
];

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const colorEnabled =
	Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const ANSI = {
	dim: "2",
	red: "31",
	green: "32",
	yellow: "33",
	cyan: "36",
	bold: "1"
};

function stripAnsi(text) {
	return String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function style(kind, text) {
	if (!colorEnabled) return text;
	const code = ANSI[kind];
	if (!code) return text;
	return `\x1b[${code}m${text}\x1b[0m`;
}

function trunc(text, n) {
	const t = String(text ?? "").replace(/\s+/g, " ").trim();
	if (t.length <= n) return t;
	return `${t.slice(0, Math.max(0, n - 1))}…`;
}

function relativeTime(ms) {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

function formatTokens(value) {
	if (!Number.isFinite(value)) return "—";
	if (value < 1000) return String(Math.round(value));
	if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
	return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
}

function colorizeMarkdown(text) {
	if (!colorEnabled) return text;
	const lines = text.split("\n");
	let inCode = false;
	return lines
		.map((line) => {
			if (line.startsWith("```")) {
				inCode = !inCode;
				return style("dim", line);
			}
			if (inCode) return style("cyan", line);
			let out = line.replace(/^(#{1,6})\s+(.*)$/, (_m, _h, rest) => style("bold", rest));
			out = out.replace(/\*\*([^*]+)\*\*/g, (_m, body) => style("bold", body));
			out = out.replace(/`([^`]+)`/g, (_m, body) => style("cyan", body));
			return out;
		})
		.join("\n");
}

function toolArgSummary(raw) {
	if (!raw) return "";
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			const bits = Object.entries(parsed).slice(0, 3).map(([k, v]) => {
				const val = typeof v === "string" ? v : JSON.stringify(v);
				return `${k}=${trunc(val, 40)}`;
			});
			return bits.join(" ");
		}
	} catch {}
	return trunc(raw, 80);
}

function toolResultText(ev) {
	const blocks = ev.data?.message?.content?.[0]?.content;
	if (!Array.isArray(blocks)) return "";
	return blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function toolResultCallId(ev) {
	return ev.data?.message?.content?.[0]?.toolCallId;
}

async function loadModelCatalog(llm) {
	if (!llm?.listProviders || !llm?.listModels) return [];
	const providers = llm.listProviders();
	const settled = await Promise.allSettled(
		providers.map(async (provider) => ({
			provider,
			models: await llm.listModels(provider.id)
		}))
	);
	return settled.flatMap((result) => {
		if (result.status !== "fulfilled") return [];
		return result.value.models.map((model) => ({
			provider: result.value.provider.id,
			providerName: result.value.provider.name,
			id: model.id,
			name: model.name,
			description: model.description
		}));
	});
}

function modelSpec(entry) {
	return `${entry.provider}/${entry.id}`;
}

function titleFromEvents(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === "session/title" && events[i].data?.title) {
			return events[i].data.title;
		}
	}
	return null;
}

function createCursorGuard(stdout, blocked) {
	let hidden = false;
	const show = () => {
		if (!hidden) return;
		hidden = false;
		try {
			stdout.write("\x1b[?25h");
		} catch {}
	};
	const hide = () => {
		if (!interactive || hidden || blocked?.()) return;
		hidden = true;
		stdout.write("\x1b[?25l");
	};
	process.on("exit", show);
	return { hide, show };
}

async function projectSessions(persistence, cwd) {
	if (!persistence?.list) return [];
	const headers = await persistence.list();
	return headers
		.filter((header) => header.cwd === cwd && header.origin !== "subagent")
		.sort((a, b) => b.createdAt - a.createdAt);
}

async function sessionTitle(persistence, header) {
	if (!persistence?.inspect) return null;
	try {
		const inspection = await persistence.inspect(header.id);
		return titleFromEvents(inspection.events);
	} catch {
		return null;
	}
}

async function printSessionList(persistence, cwd, write, options = {}) {
	const { limit = Infinity, withTitles = true } = options;
	const all = await projectSessions(persistence, cwd);
	if (all.length === 0) {
		write("(no persisted sessions for this project)\n");
		return [];
	}
	const rows = all.slice(0, Number.isFinite(limit) ? limit : all.length);
	for (let i = 0; i < rows.length; i++) {
		const header = rows[i];
		let title = "";
		if (withTitles && i < 20) title = (await sessionTitle(persistence, header)) ?? "";
		const bits = [header.id, relativeTime(header.createdAt)];
		if (title) bits.push(title);
		write(`${bits.join("\t")}\n`);
	}
	return rows;
}

/**
 * Stream one turn: snapshot-drain from `fromSeq`, then wake on agent-scoped
 * `session/event` until `whenIdle()`. Resume seeds do not emit, so the
 * snapshot drain is mandatory.
 */
async function streamTurn(agent, fromSeq, hooks) {
	const idle = agent.whenIdle();
	let lastSeq = fromSeq;
	let notify = null;
	const off = agent.ctx.on("session/event", () => {
		notify?.();
	});
	const drain = () => {
		const events = agent.session.events;
		for (; lastSeq < events.length; lastSeq++) hooks.consume(events[lastSeq]);
	};
	try {
		drain();
		while (true) {
			const result = await Promise.race([
				idle.then(() => "idle"),
				new Promise((resolve) => {
					notify = () => resolve("ev");
				})
			]);
			drain();
			if (result === "idle") break;
		}
		await idle;
		drain();
	} finally {
		off();
	}
}

async function repl(ctx, services, io) {
	const { agents, defaultModel, sessions, startup, persistence, llm } = services;
	const compaction = ctx.get("compaction");
	const tokenMeter = ctx.get("tokenMeter");
	const cursor = createCursorGuard(io.stdout, () => Boolean(ui));
	const cwd = process.cwd();

	let current = null;
	let exiting = false;
	let busy = false;
	let sigintLocked = false;
	let rl = null;
	let spinnerTimer = null;
	let spinnerOn = false;
	let modelCatalog = [];
	let ui = null;

	const writeOut = (text) => {
		if (!text) return;
		if (ui) {
			ui.write(stripAnsi(text));
			return;
		}
		const draft = interactive && rl && rl.line.length > 0;
		if (draft) {
			clearLine(io.stdout, 0);
			cursorTo(io.stdout, 0);
		}
		io.stdout.write(text);
		if (draft) rl.prompt(true);
	};

	const say = (text) => writeOut(text.endsWith("\n") ? text : `${text}\n`);

	const stopSpinner = () => {
		if (!spinnerOn) return;
		spinnerOn = false;
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = null;
		}
		if (!ui && interactive) {
			clearLine(io.stdout, 0);
			cursorTo(io.stdout, 0);
		}
		if (!ui) cursor.show();
	};

	const startSpinner = () => {
		if (ui || !interactive || spinnerOn) return;
		spinnerOn = true;
		cursor.hide();
		let i = 0;
		const draw = () => {
			const frame = SPINNER_FRAMES[i++ % SPINNER_FRAMES.length];
			const draft = rl && rl.line.length > 0;
			if (draft) {
				clearLine(io.stdout, 0);
				cursorTo(io.stdout, 0);
			} else {
				io.stdout.write("\r");
			}
			io.stdout.write(style("dim", `${frame} thinking…`));
			if (draft) rl.prompt(true);
		};
		draw();
		spinnerTimer = setInterval(draw, 80);
	};

	const setBusy = (next) => {
		busy = next;
		if (ui) {
			ui.status({ turn: next ? "running" : "idle" });
			return;
		}
		if (!rl) return;
		rl.setPrompt(style("dim", next ? PROMPT_BUSY : PROMPT_IDLE));
	};

	const restoreTerminal = () => {
		stopSpinner();
		cursor.show();
	};

	const refreshModelCatalog = async () => {
		try {
			modelCatalog = await loadModelCatalog(llm);
		} catch {
			modelCatalog = [];
		}
		if (ui) ui.status({ models: modelCatalog });
	};

	const complete = (line) => {
		const trimmed = line.trimStart();
		const command = trimmed.split(/\s+/, 1)[0];
		if (!trimmed.startsWith("/")) return [[], line];
		if (command === "/model") {
			const prefix = trimmed.slice("/model".length).trimStart();
			const matches = modelCatalog
				.map(modelSpec)
				.filter((spec) => spec.toLowerCase().startsWith(prefix.toLowerCase()))
				.map((spec) => `/model ${spec}`);
			return [matches.length ? matches : ["/model"], line];
		}
		const matches = COMMANDS.filter((candidate) => candidate.startsWith(command));
		return [matches.length ? matches : COMMANDS, line];
	};

	const spawn = async (resumeId) => {
		const selection = defaultModel.currentSelection();
		const agentOptions = { provider: selection.provider, model: selection.model };
		const setup = (agentCtx) => {
			installModelSelection(agentCtx, { current: selection, assembled: void 0 });
		};
		let handle;
		if (resumeId) {
			handle = await agents.resume({
				resumeSessionId: SessionId(resumeId),
				agentOptions,
				setup
			});
		} else {
			handle = await agents.create({
				sessionId: SessionId(`session-${randomUUID()}`),
				meta: { cwd },
				agentOptions,
				setup
			});
		}
		if (current) {
			try {
				await current.handle.dispose();
			} catch {}
		}
		current = { handle, agent: handle.agent };
		if (ui) {
			let contextWindow;
			try {
				contextWindow = (
					await llm?.resolveModelInfo?.(current.agent.options.provider, current.agent.options.model)
				)?.context?.contextWindow;
			} catch {}
			let contextUsage;
			try {
				const measured = tokenMeter?.measure(current.agent.session);
				if (measured?.totalTokens) contextUsage = formatTokens(measured.totalTokens);
			} catch {}
			ui.status({
				sessionId: current.agent.id,
				provider: current.agent.options.provider,
				model: current.agent.options.model,
				contextWindow: contextWindow ? formatTokens(contextWindow) : undefined,
				contextUsage
			});
		}
		if (interactive) {
			say(style("dim", resumeId ? `[resumed ${resumeId}]` : `[new session ${current.agent.id}]`));
		}
		await current.agent.whenIdle();
	};

	const flushAndExit = async (code) => {
		if (exiting) return;
		exiting = true;
		restoreTerminal();
		try {
			ui?.unmount();
		} catch {}
		try {
			if (rl) rl.close();
		} catch {}
		try {
			if (current) await sessions.flush(current.agent.session);
		} catch {}
		try {
			if (current) await current.handle.dispose();
		} catch {}
		io.exit(code);
	};

	const consumeEvent = (state, ev) => {
		if (ev.type === "assistant/message") {
			const content = ev.data.message.content;
			const reasoning = content
				.filter((block) => block.type === "reasoning")
				.map((block) => block.text)
				.join("");
			const text = content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			if (text === state.printed && reasoning === state.printedReasoning) return;
			stopSpinner();
			if (reasoning !== state.printedReasoning) {
				if (interactive) {
					if (!state.reasoningStarted) {
						writeOut("Think › ");
						state.reasoningStarted = true;
					}
					const delta = reasoning.startsWith(state.printedReasoning)
						? reasoning.slice(state.printedReasoning.length)
						: `\n${reasoning}`;
					writeOut(delta.replaceAll("\n", "\nThink › "));
					state.sawOutput = true;
				}
				state.printedReasoning = reasoning;
			}
			if (text === state.printed) return;
			if (state.reasoningStarted) {
				writeOut("\n");
				state.reasoningStarted = false;
			}
			if (!state.assistantStarted) {
				if (interactive) writeOut("DeepSeek › ");
				state.assistantStarted = true;
			}
			if (text.startsWith(state.printed)) {
				writeOut(text.slice(state.printed.length));
			} else {
				writeOut(`\n${colorizeMarkdown(text)}`);
			}
			state.printed = text;
			state.sawOutput = true;
			return;
		}
		if (ev.type === "tool/call") {
			stopSpinner();
			if (state.reasoningStarted) {
				writeOut("\n");
				state.reasoningStarted = false;
			}
			if (state.assistantStarted) {
				writeOut("\n");
				state.assistantStarted = false;
			}
			state.tools.set(ev.data.callId, { name: ev.data.name, started: Date.now() });
			const args = toolArgSummary(ev.data.arguments);
			say(style("dim", args ? `[tool] ${ev.data.name} · ${args}` : `[tool] ${ev.data.name}`));
			state.sawOutput = true;
			return;
		}
		if (ev.type === "tool/result") {
			stopSpinner();
			const callId = toolResultCallId(ev);
			const prior = callId ? state.tools.get(callId) : null;
			const ms = prior ? Date.now() - prior.started : null;
			const elapsed = ms != null ? ` · ${(ms / 1000).toFixed(1)}s` : "";
			const name = prior?.name ?? "tool";
			// data.error is result.error.info from dsh-agent-loop appendToolResult.
			const info = ev.data?.error;
			const failed = info !== undefined
				|| ev.data?.message?.content?.[0]?.isError === true;
			const detail = info?.code ?? info?.name ?? info?.message
				?? (typeof info === "string" ? info : null)
				?? "error";
			if (failed) {
				say(style("red", `[tool error] ${name}${elapsed} · ${detail}`));
			} else {
				const preview = trunc(toolResultText(ev), 80);
				say(style("green", preview ? `[tool] ${name}${elapsed} · ${preview}` : `[tool] ${name}${elapsed}`));
			}
			state.sawOutput = true;
			return;
		}
		if (ev.type === "turn/end") {
			const reason = ev.data?.reason;
			if (reason?.kind === "error") {
				state.turnError = reason.error;
			} else if (reason?.kind === "aborted") {
				state.cancelled = true;
			}
		}
	};

	const runTurn = async (text) => {
		if (!current) return;
		if (interactive) say(`You › ${text}`);
		setBusy(true);
		startSpinner();
		const firstSeq = current.agent.session.seq;
		current.agent.followup(
			createUserMessage({
				content: [{ type: "text", text }],
				source: { kind: "user" }
			})
		);
		const state = {
			printed: "",
			printedReasoning: "",
			sawOutput: false,
			assistantStarted: false,
			reasoningStarted: false,
			turnError: null,
			cancelled: false,
			tools: new Map()
		};
		try {
			await streamTurn(current.agent, firstSeq, {
				consume: (ev) => consumeEvent(state, ev)
			});
		} finally {
			stopSpinner();
			setBusy(false);
		}
		if (state.printed || state.sawOutput) writeOut("\n");
		if (state.turnError && !state.cancelled) {
			const { code, message } = state.turnError;
			say(style("red", `turn error${code ? ` ${code}` : ""}: ${message ?? ""}`.trim()));
		}
		if (interactive && tokenMeter && current) {
			try {
				const measured = tokenMeter.measure(current.agent.session);
				if (measured.totalTokens > 0) {
					if (ui) ui.status({ contextUsage: formatTokens(measured.totalTokens) });
					else say(style("dim", `[tokens ${measured.totalTokens}]`));
				}
			} catch {}
		}
		await sessions.flush(current.agent.session);
	};

	const pickModel = async () => {
		const currentSelection = defaultModel.currentSelection();
		await refreshModelCatalog();
		if (modelCatalog.length === 0) {
			say(style("yellow", "No registered models are currently available."));
			return;
		}
		say(
			`current: ${currentSelection.provider}/${currentSelection.model}${
				currentSelection.reasoningEffort ? ` (effort ${currentSelection.reasoningEffort})` : ""
			}`
		);
		for (let i = 0; i < modelCatalog.length; i++) {
			const entry = modelCatalog[i];
			const active =
				entry.provider === currentSelection.provider && entry.id === currentSelection.model
					? style("cyan", " ← current")
					: "";
			const details = entry.description ? ` — ${trunc(entry.description, 72)}` : "";
			say(`${String(i + 1).padStart(2, " ")}. ${modelSpec(entry)}${details}${active}`);
		}
		if (!rl) return;
		const answer = await new Promise((resolve) => {
			rl.question("select model number (Enter to cancel): ", resolve);
		});
		const index = Number.parseInt(answer.trim(), 10) - 1;
		if (answer.trim() === "") {
			say(style("dim", "[model selection cancelled]"));
			return;
		}
		if (!Number.isInteger(index) || !modelCatalog[index]) {
			say(style("red", "invalid model selection"));
			return;
		}
		await handleModel(modelSpec(modelCatalog[index]));
	};

	const handleModel = async (arg) => {
		const sel = defaultModel.currentSelection();
		if (!arg) {
			await pickModel();
			return;
		}
		const parts = arg.split(/\s+/);
		const spec = parts[0];
		const effortArg = parts[1];
		const [providerOrModel, maybeModel] = spec.includes("/") ? spec.split("/", 2) : [sel.provider, spec];
		const provider = maybeModel ? providerOrModel : sel.provider;
		const model = maybeModel || providerOrModel;
		const switchingModel = provider !== sel.provider || model !== sel.model;
		const next = { provider, model };
		if (effortArg) {
			try {
				const resolved = llm?.resolveModelInfo
					? await llm.resolveModelInfo(provider, model)
					: null;
				const efforts = resolved?.reasoning?.efforts ?? [];
				if (efforts.length === 0) {
					say(style("red", `"${provider}/${model}" does not support reasoning effort`));
					return;
				}
				if (!efforts.some((effort) => effort.id === effortArg)) {
					say(
						style(
							"red",
							`unsupported effort "${effortArg}"; choose one of: ${efforts
								.map((effort) => effort.id)
								.join(", ")}`
						)
					);
					return;
				}
				next.reasoningEffort = ReasoningEffortId(effortArg);
			} catch (error) {
				say(style("red", `could not resolve model capability: ${error.message}`));
				return;
			}
		} else if (!switchingModel && sel.reasoningEffort) {
			next.reasoningEffort = sel.reasoningEffort;
		}
		try {
			await defaultModel.saveSelection(next);
			say(
				style(
					"dim",
					`[model set to ${provider}/${model}${next.reasoningEffort ? ` effort ${next.reasoningEffort}` : ""} — applies after /new or /resume]`
				)
			);
		} catch (error) {
			say(style("red", `could not switch model: ${error.message}`));
		}
	};

	const handleCompact = async () => {
		if (!current) return;
		if (!compaction) {
			say(style("red", "compaction is not available in this profile"));
			return;
		}
		try {
			say(style("dim", "[compacting…]"));
			const result = await compaction.compactNow(current.agent, new AbortController().signal);
			if (result === null) {
				say("No compactable history yet.");
			} else {
				say(`Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`);
			}
		} catch (error) {
			if (error instanceof Error && error.code) {
				const messages = {
					busy: "Compaction is unavailable because this process has an active compaction, or the agent is not idle.",
					cancelled: "Compaction cancelled.",
					changed: "The history selected for compaction changed before it could be replaced.",
					summary: "Compaction could not produce a useful summary.",
					commit: "Compaction did not finish cleanly; some session history may have changed.",
					persistence: "Compaction finished, but the session could not be saved."
				};
				say(style("red", messages[error.code] ?? error.message));
			} else {
				say(style("red", error.message));
			}
		}
	};

	const handleLine = async (line) => {
		const text = line.trim();
		if (text === "") return;
		if (text.startsWith("/")) {
			const [cmd, ...rest] = text.split(/\s+/);
			const arg = rest.join(" ").trim();
			switch (cmd) {
				case "/exit":
				case "/quit":
					await flushAndExit(0);
					return;
				case "/help":
					say(
						`commands:\n` +
							`  /exit           quit (saves the session)\n` +
							`  /new            start a fresh session\n` +
							`  /resume         list recent sessions\n` +
							`  /resume <id>    resume a specific session\n` +
							`  /list           list persisted sessions for this project\n` +
							`  /clear          clear the terminal screen\n` +
							`  /model          choose a registered provider/model\n` +
							`  /model <name> [effort]   switch the default model (next /new or /resume)\n` +
							`  /compact        compact the conversation history\n` +
							`anything else is sent to the agent as a message.`
					);
					return;
				case "/clear":
					if (ui) ui.clear();
					else if (interactive) writeOut("\x1b[2J\x1b[H");
					return;
				case "/model":
					await handleModel(arg || undefined);
					return;
				case "/compact":
					await handleCompact();
					return;
				case "/new":
					try {
						await spawn(null);
					} catch (error) {
						say(style("red", `new session failed: ${error.message}`));
					}
					return;
				case "/resume":
					if (!arg) {
						say("recent sessions:");
						await printSessionList(persistence, cwd, (t) => writeOut(t), {
							limit: 10,
							withTitles: true
						});
						say("usage: /resume <session-id>");
						return;
					}
					try {
						await spawn(arg);
					} catch (error) {
						say(style("red", `resume failed: ${error.message}`));
					}
					return;
				case "/list":
					await printSessionList(persistence, cwd, (t) => writeOut(t), { withTitles: true });
					return;
				default:
					say(`unknown command: ${cmd} (try /help)`);
					return;
			}
		}
		if (busy || !current) return;
		await runTurn(text);
	};

	let queue = [];
	let draining = false;
	let stdinClosed = false;
	let ready = false;

	const enqueue = (line) => {
		queue.push(line);
		if (ready && !draining) drain();
	};

	const drain = async () => {
		draining = true;
		try {
			while (queue.length > 0) {
				const line = queue.shift();
				try {
					await handleLine(line);
				} catch (error) {
					restoreTerminal();
					setBusy(false);
					say(style("red", error.message));
				}
				if (exiting) break;
			}
		} finally {
			draining = false;
		}
		if (exiting) return;
		if (queue.length > 0) {
			drain();
			return;
		}
		if (stdinClosed) {
			await flushAndExit(0);
		} else if (interactive) {
			rl.prompt();
		}
	};

	if (!interactive) {
		rl = createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: false,
			prompt: style("dim", PROMPT_IDLE),
			completer: complete
		});
		rl.on("line", enqueue);
		rl.on("close", () => {
			stdinClosed = true;
			restoreTerminal();
			if (exiting) return;
			if (ready && !draining) drain();
		});
	}

	const onTerm = () => {
		void flushAndExit(0);
	};
	process.on("SIGTERM", onTerm);
	process.on("SIGHUP", onTerm);

	await refreshModelCatalog();
	ctx.on("llm/adapters-updated", () => {
		void refreshModelCatalog();
	});

	if (interactive) {
		ui = startTuiUi({
			commands: COMMAND_PALETTE,
			initialState: {
				models: modelCatalog,
				project: cwd,
				banner: startup.quiet || process.env.DSH_NO_BANNER ? "" : BANNER,
				turn: "idle"
			},
			onSubmit: async (line) => {
				try {
					await handleLine(line);
				} catch (error) {
					say(style("red", error.message));
				}
			},
			onCancel: () => {
				if (current?.agent.status === "running") {
					current.agent.cancel({ kind: "user" }, { keepInbox: true });
					say(style("dim", "[cancelled]"));
				}
			}
		});
	}

	let initialResumeId = null;
	if (!startup.fresh) {
		if (startup.resumeId) {
			initialResumeId = startup.resumeId;
		} else {
			const listed = await projectSessions(persistence, cwd);
			initialResumeId = listed[0]?.id ?? null;
		}
	}
	if (initialResumeId) {
		try {
			await spawn(initialResumeId);
		} catch (error) {
			say(style("yellow", `[latest session unavailable, starting new one: ${error.message}]`));
			await spawn(null);
		}
	} else {
		await spawn(null);
	}

	ready = true;
	if (interactive && ui) {
		await ui.waitUntilExit();
		if (!exiting) await flushAndExit(0);
		return;
	}
	if (stdinClosed) await flushAndExit(0);
	else if (queue.length > 0 && !draining) drain();
}

function fail(io, error) {
	io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
	io.exit(1);
}

async function run(ctx, io) {
	await ctx.get("loader")?.await();
	const agents = ctx.get("agents");
	const defaultModel = ctx.get("agentDefaultModel");
	const sessions = ctx.get("sessions");
	const startup = ctx.get("tuiStartup");
	const persistence = ctx.get("sessionPersistence");
	const llm = ctx.get("llm");
	if (agents === void 0 || defaultModel === void 0 || sessions === void 0 || startup === void 0) return;

	if (startup.list) {
		await printSessionList(persistence, process.cwd(), (t) => io.stdout.write(t), { withTitles: true });
		io.exit(0);
		return;
	}

	await repl(ctx, { agents, defaultModel, sessions, startup, persistence, llm }, io);
}

export function apply(ctx) {
	const exit = ctx.get("appExit");
	if (exit === void 0) throw new Error("tui-runner: the launcher must provide ctx.appExit before the tree mounts");
	const io = { stdout: process.stdout, stderr: process.stderr, exit };
	run(ctx, io).catch((error) => {
		try {
			process.stdout.write("\x1b[?25h");
		} catch {}
		fail(io, error);
	});
}
