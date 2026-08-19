import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeTerminalText, summarizeToolArguments } from "../tui-safety.mjs";
import { appendTranscript } from "../tui-ui.mjs";

test("净化 CSI SGR 序列", () => {
	assert.equal(sanitizeTerminalText("\x1b[31mred\x1b[0m"), "red");
});

test("净化 OSC 52 剪贴板注入", () => {
	assert.equal(sanitizeTerminalText("before\x1b]52;c;c2VjcmV0\x07after"), "beforeafter");
});

test("净化 DCS 注入", () => {
	assert.equal(sanitizeTerminalText("before\x1bPqpayload\x1b\\after"), "beforeafter");
});

test("默认脱敏工具参数，verbose 保留可显示内容", () => {
	const raw = JSON.stringify({ apiKey: "secret", path: "/tmp/x", config: { authorization: "Bearer secret" } });
	assert.match(summarizeToolArguments(raw), /apiKey=\*\*\*/);
	assert.doesNotMatch(summarizeToolArguments(raw), /Bearer secret/);
	assert.match(summarizeToolArguments(raw, { verbose: true }), /secret/);
});

test("transcript 保留尾部并报告截断行数", () => {
	const result = appendTranscript(Array.from({ length: 2_000 }, (_, index) => String(index)), false, "latest\n");
	assert.equal(result.lines.length, 2_000);
	assert.equal(result.lines.at(-1), "latest");
	assert.equal(result.dropped, 1);
});
