import assert from "node:assert/strict";
import test from "node:test";
import { parseExitTimeoutMs } from "../tui-runner.mjs";

test("退出兜底超时解析", () => {
	assert.equal(parseExitTimeoutMs("1250"), 1250);
	assert.equal(parseExitTimeoutMs("0"), 0);
	assert.equal(parseExitTimeoutMs("-1"), 0);
	assert.equal(parseExitTimeoutMs("not-a-number"), 3000);
});
