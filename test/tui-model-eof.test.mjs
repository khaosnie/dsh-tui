import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dshBin = join(repoRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

test("管道 /model 在 stdin EOF 后退出", { timeout: 10_000 }, async (t) => {
	const home = await mkdtemp(join(tmpdir(), "dsh-tui-model-eof-"));
	t.after(() => rm(home, { force: true, recursive: true }));
	await mkdir(join(home, ".dsh", "profiles"), { recursive: true });
	await symlink(repoRoot, join(home, ".dsh", "profiles", "tui"), "dir");

	const env = { ...process.env, HOME: home };
	delete env.DSH_HOME;
	const child = spawn(process.execPath, [dshBin, "--profile", "tui", "--new"], {
		cwd: repoRoot,
		env,
		stdio: ["pipe", "pipe", "pipe"]
	});
	child.stdin.end("/model\n");

	let timedOut = false;
	const result = await new Promise((resolve) => {
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, 5_000);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});

	assert.equal(timedOut, false, "管道 /model 在 stdin EOF 后不应挂起");
	assert.equal(result.signal, null, "进程应自然退出");
});

test("管道 /exit 不受兜底定时器影响", { timeout: 10_000 }, async (t) => {
	const home = await mkdtemp(join(tmpdir(), "dsh-tui-exit-pipe-"));
	t.after(() => rm(home, { force: true, recursive: true }));
	await mkdir(join(home, ".dsh", "profiles"), { recursive: true });
	await symlink(repoRoot, join(home, ".dsh", "profiles", "tui"), "dir");

	const env = { ...process.env, HOME: home, DSH_TUI_EXIT_TIMEOUT_MS: "3000" };
	delete env.DSH_HOME;
	const child = spawn(process.execPath, [dshBin, "--profile", "tui", "--new"], {
		cwd: repoRoot,
		env,
		stdio: ["pipe", "pipe", "pipe"]
	});
	child.stdin.end("/exit\n");

	let timedOut = false;
	const result = await new Promise((resolve) => {
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, 5_000);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});

	assert.equal(timedOut, false, "管道 /exit 不应等待兜底超时");
	assert.equal(result.code, 0, "管道 /exit 应以零退出码退出");
	assert.equal(result.signal, null, "进程应自然退出");
});
