import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useCursor, useInput, useWindowSize } from "ink";
import stringWidth from "string-width";

const h = React.createElement;
const BRAND = "#4176e6";
const BRAND_SOFT = "#679efe";
const USER_BG = "#34343f";
const CARET_ANCHOR = "\u2800";

function contextLabel(state) {
	if (state.contextUsage && state.contextWindow) return `Context ${state.contextUsage} / ${state.contextWindow}`;
	if (state.contextWindow) return `Context budget ${state.contextWindow}`;
	return "Context collecting usage";
}

function rule(columns) {
	return "─".repeat(Math.max(24, columns - 2));
}

function wrappedRows(text, columns) {
	const width = Math.max(1, columns);
	let rows = 0;
	for (const line of String(text).split("\n")) {
		rows += Math.max(1, Math.ceil(stringWidth(line) / width));
	}
	return Math.max(1, rows);
}

function wrapLine(text, width) {
	const limit = Math.max(1, width);
	if (text === "") return [""];
	const rows = [];
	let current = "";
	let currentWidth = 0;
	for (const char of text) {
		const charWidth = stringWidth(char);
		if (charWidth <= 0) {
			current += char;
			continue;
		}
		if (currentWidth + charWidth > limit && current.length > 0) {
			rows.push(current);
			current = char;
			currentWidth = charWidth;
			continue;
		}
		current += char;
		currentWidth += charWidth;
	}
	rows.push(current);
	return rows;
}

function clampIndex(value, length) {
	return Math.max(0, Math.min(length, value));
}

function utf16FromCodePoint(text, codePointIndex) {
	let offset = 0;
	let count = 0;
	for (const char of text) {
		if (count >= codePointIndex) break;
		offset += char.length;
		count++;
	}
	return offset;
}

function codePointFromUtf16(text, utf16Index) {
	let offset = 0;
	let count = 0;
	for (const char of text) {
		if (offset >= utf16Index) break;
		offset += char.length;
		count++;
	}
	return count;
}

function moveByCodePoint(text, utf16Index, delta) {
	const count = [...text].length;
	return utf16FromCodePoint(text, clampIndex(codePointFromUtf16(text, utf16Index) + delta, count));
}

function moveByWord(text, utf16Index, direction) {
	const chars = [...text];
	let index = 0;
	let offset = 0;
	while (index < chars.length && offset < utf16Index) {
		offset += chars[index].length;
		index++;
	}
	const isSep = (char) => /\s/.test(char);
	if (direction > 0) {
		while (index < chars.length && !isSep(chars[index])) {
			offset += chars[index].length;
			index++;
		}
		while (index < chars.length && isSep(chars[index])) {
			offset += chars[index].length;
			index++;
		}
	} else {
		while (index > 0 && isSep(chars[index - 1])) {
			index--;
			offset -= chars[index].length;
		}
		while (index > 0 && !isSep(chars[index - 1])) {
			index--;
			offset -= chars[index].length;
		}
	}
	return offset;
}

function layoutComposer(prompt, input, width) {
	const promptWidth = stringWidth(prompt);
	const indent = " ".repeat(promptWidth);
	const rows = [];
	let offset = 0;
	const parts = String(input).split("\n");
	for (const [index, line] of parts.entries()) {
		const prefix = index === 0 ? prompt : indent;
		const wrapped = wrapLine(prefix + line, width);
		let consumed = 0;
		for (const [rowIndex, visual] of wrapped.entries()) {
			const hasPrefix = rowIndex === 0;
			const content = hasPrefix ? visual.slice(prefix.length) : visual;
			const start = offset + consumed;
			rows.push({
				visual,
				prefix: hasPrefix ? prefix : "",
				prefixWidth: hasPrefix ? promptWidth : 0,
				start,
				end: start + content.length
			});
			consumed += content.length;
		}
		offset += line.length + (index < parts.length - 1 ? 1 : 0);
	}
	if (!rows.length) {
		rows.push({ visual: prompt, prefix: prompt, prefixWidth: promptWidth, start: 0, end: 0 });
	}
	return rows;
}

function caretView(rows, input, caret) {
	let rowIndex = 0;
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const next = rows[i + 1];
		if (caret < row.end || (caret === row.end && (!next || next.start > caret))) {
			rowIndex = i;
			break;
		}
		rowIndex = next ? i + 1 : i;
	}
	const row = rows[rowIndex];
	return {
		row: rowIndex,
		col: row.prefixWidth + stringWidth(input.slice(row.start, caret))
	};
}

function hitTestComposer(rows, input, rowIndex, column) {
	const row = rows[Math.max(0, Math.min(rows.length - 1, rowIndex))];
	if (!row) return 0;
	if (column <= row.prefixWidth) return row.start;
	let width = row.prefixWidth;
	let offset = row.start;
	for (const char of input.slice(row.start, row.end)) {
		const charWidth = Math.max(1, stringWidth(char));
		if (column < width + charWidth / 2) return offset;
		width += charWidth;
		offset += char.length;
	}
	return row.end;
}

function copyText(text) {
	if (!text || !process.stdout.isTTY) return;
	process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
}

function displayText(line) {
	if (line.startsWith("You ›")) return line.slice("You › ".length);
	if (line.startsWith("DeepSeek ›")) return line.slice("DeepSeek › ".length);
	if (line.startsWith("Think ›")) return line.slice("Think › ".length);
	return line;
}

function entryRowCount(entry, columns) {
	if (entry.kind === "blank") return 1;
	if (entry.kind === "transcript") {
		const line = entry.line;
		if (line.startsWith("You ›")) {
			return wrappedRows(displayText(line), Math.max(1, columns - 2)) + 2;
		}
		return wrappedRows(displayText(line), columns);
	}
	return wrappedRows(entry.text ?? "", columns);
}

function transcriptEntries(lines) {
	let inCode = false;
	return lines.map((line) => {
		const text = displayText(line);
		const fence = text.trimStart().startsWith("```");
		const entry = { kind: "transcript", line, code: inCode, fence };
		if (fence) inCode = !inCode;
		return entry;
	});
}

function sliceFromBottom(entries, heights, offsetFromBottom, viewportRows) {
	const total = heights.reduce((sum, value) => sum + value, 0);
	const endRow = Math.max(0, total - offsetFromBottom);
	const startRow = Math.max(0, endRow - viewportRows);
	let acc = 0;
	let start = 0;
	let end = entries.length;
	for (let i = 0; i < entries.length; i++) {
		const next = acc + heights[i];
		if (next <= startRow) start = i + 1;
		if (acc >= endRow) {
			end = i;
			break;
		}
		acc = next;
	}
	return { entries: entries.slice(start, end), start, end, startRow, endRow, total };
}

function inlineMarkdown(text, keyPrefix) {
	const nodes = [];
	const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
	let last = 0;
	let index = 0;
	for (const match of text.matchAll(pattern)) {
		if (match.index > last) nodes.push(text.slice(last, match.index));
		const token = match[0];
		if (token.startsWith("`")) {
			nodes.push(h(Text, { key: `${keyPrefix}-code-${index++}`, color: "cyan" }, token.slice(1, -1)));
		} else {
			nodes.push(h(Text, { key: `${keyPrefix}-bold-${index++}`, bold: true }, token.slice(2, -2)));
		}
		last = match.index + token.length;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes.length ? nodes : [text];
}

function MarkdownLine({ text, code, fence, baseKey, color, dimColor }) {
	if (fence) return h(Text, { color: "#7f7f7f", dimColor: true }, text);
	if (code) return h(Text, { color: "cyan" }, text);
	const heading = /^(#{1,6})\s+(.*)$/.exec(text);
	if (heading) {
		return h(Text, { color: BRAND, bold: true }, ...inlineMarkdown(heading[2], `${baseKey}-h`));
	}
	if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(text)) {
		return h(Text, { dimColor: true }, text);
	}
	const quote = /^>\s?(.*)$/.exec(text);
	if (quote) {
		return h(Text, { dimColor: true }, "│ ", ...inlineMarkdown(quote[1], `${baseKey}-q`));
	}
	return h(Text, { color, dimColor }, ...inlineMarkdown(text, baseKey));
}

const DocumentEntry = memo(function DocumentEntry({ entry, index }) {
	if (entry.kind === "transcript") {
		const line = entry.line;
		const key = `${index}-${line}`;
		if (line.startsWith("You ›")) {
			return h(
				Box,
				{ key, backgroundColor: USER_BG, paddingX: 1, paddingY: 1 },
				h(Text, { color: "#f2f2f2" }, displayText(line))
			);
		}
		if (line.startsWith("DeepSeek ›")) {
			return h(MarkdownLine, { key, baseKey: key, text: displayText(line), code: entry.code, fence: entry.fence });
		}
		if (line.startsWith("Think ›")) {
			return h(MarkdownLine, { key, baseKey: key, text: displayText(line), color: "#a6a6a6", dimColor: true });
		}
		if (line.startsWith("[tool error]")) {
			return h(Text, { key, color: "red" }, line);
		}
		if (line.startsWith("[tool]")) {
			return h(Text, { key, color: "green" }, line);
		}
		if (line.startsWith("[new ") || line.startsWith("[resumed ")) {
			return h(Text, { key, dimColor: true }, line);
		}
		return h(MarkdownLine, { key, baseKey: key, text: line, code: entry.code, fence: entry.fence });
	}
	if (entry.kind === "brand") {
		return h(Text, { key: `${index}-${entry.text}`, color: BRAND, bold: entry.bold }, entry.text);
	}
	if (entry.kind === "hint") {
		return h(Text, { key: `${index}-${entry.text}`, dimColor: true }, entry.text);
	}
	return h(Text, { key: `${index}-blank` }, " ");
});

function isComposerNewline(key, inputKey) {
	if (inputKey.return && (inputKey.shift || inputKey.meta)) return true;
	if (inputKey.ctrl && key.toLowerCase() === "j") return true;
	if (key === "\n") return true;
	const body = String(key).replace(/^\u001b/, "");
	let match = /^\[13;(\d+)(?::\d+)?u$/.exec(body);
	if (match) {
		const bits = Number(match[1]) - 1;
		return Boolean(bits & 1) || Boolean(bits & 2);
	}
	match = /^\[27;(\d+);13~$/.exec(body);
	if (match) {
		const bits = Number(match[1]) - 1;
		return Boolean(bits & 1) || Boolean(bits & 2);
	}
	return false;
}

function caretTag(caret) {
	let n = (caret >>> 0) + 1;
	let tag = "";
	while (n > 0) {
		tag += n & 1 ? "\u200B" : "\u200C";
		n >>= 1;
	}
	return tag;
}

function useKeyboardProtocol() {
	useEffect(() => {
		if (!process.stdout.isTTY) return;
		process.stdout.write("\x1b[>4;2m\x1b[>5;1m\x1b[?1007h");
		return () => {
			process.stdout.write("\x1b[>4;0m\x1b[>5;0m\x1b[?1007l");
		};
	}, []);
}

function useMouseWheel(onWheel, enabled) {
	const callback = useRef(onWheel);
	callback.current = onWheel;

	useEffect(() => {
		if (!enabled) return;
		if (!process.stdin.isTTY || !process.stdout.isTTY) return;
		let pending = "";
		const onData = (chunk) => {
			pending += String(chunk);
			const pattern = /\x1b\[<(\d+);\d+;\d+([Mm])/g;
			let match;
			let consumed = 0;
			while ((match = pattern.exec(pending))) {
				consumed = pattern.lastIndex;
				const button = Number(match[1]);
				if (match[2] === "M" && (button & 64) !== 0) {
					callback.current((button & 1) === 0 ? "up" : "down");
				}
			}
			pending = consumed > 0 ? pending.slice(consumed) : pending;
			if (pending.length > 32) pending = pending.slice(-32);
		};

		process.stdin.prependListener("data", onData);
		process.stdout.write("\x1b[?1000h\x1b[?1006h");
		return () => {
			process.stdin.removeListener("data", onData);
			process.stdout.write("\x1b[?1000l\x1b[?1006l");
		};
	}, [enabled]);
}

function commandMatches(input, commands) {
	const query = input.trimStart().toLowerCase();
	if (!query.startsWith("/")) return [];
	return commands.filter((command) => command.name.startsWith(query.split(/\s+/, 1)[0]));
}

function App({ api, commands, initialState }) {
	const { exit } = useApp();
	const { setCursorPosition } = useCursor();
	useKeyboardProtocol();
	const [state, setState] = useState(initialState);
	const [input, setInput] = useState("");
	const [caret, setCaret] = useState(0);
	const [anchor, setAnchor] = useState(null);
	const [selected, setSelected] = useState(0);
	const [modelMenu, setModelMenu] = useState(false);
	const [scrollOffset, setScrollOffset] = useState(0);
	const { columns, rows } = useWindowSize();
	const colCount = Math.max(1, columns ?? 80);
	const rowCount = Math.max(1, rows ?? 24);
	useEffect(() => {
		if (!process.stdout.isTTY) return;
		process.stdout.write("\x1b[?1007h");
	}, [colCount, rowCount]);
	const totalRowsRef = useRef(0);
	const limits = useRef({ maxOffset: 0, pageSize: 1 });
	const ignoreReturnUntil = useRef(0);
	const matches = commandMatches(input, commands);
	const models = state.models ?? [];
	const choices = (modelMenu ? models : matches).slice(0, 9);
	const active = choices[selected];
	const transcript = state.lines ?? [];
	const document = useMemo(() => [
		{ kind: "brand", bold: true, text: `DeepSeek Harness${state.project ? `  ·  ${state.project}` : ""}` },
		...(state.banner ? state.banner.trim().split("\n").map((text) => ({ kind: "brand", text })) : []),
		{ kind: "hint", text: "Type / for commands  ·  Shift+Enter newline  ·  Touchpad scroll  ·  Option/Alt-drag select" },
		{ kind: "blank" },
		...transcriptEntries(transcript)
	], [state.project, state.banner, transcript]);
	const heights = useMemo(
		() => document.map((entry) => entryRowCount(entry, colCount)),
		[document, colCount]
	);
	const totalRows = useMemo(() => heights.reduce((sum, value) => sum + value, 0), [heights]);
	const menuRows = modelMenu ? models.slice(0, 9).length + 1 : matches.length > 0 ? matches.slice(0, 9).length : 0;
	const statusRows = 2;
	const hintRows = 2;
	const prompt = state.turn === "running" ? "⋯ " : "› ";
	const innerWidth = Math.max(1, colCount);
	const safeCaret = clampIndex(caret, input.length);
	const safeAnchor = anchor == null ? null : clampIndex(anchor, input.length);
	const selection = safeAnchor == null || safeAnchor === safeCaret
		? null
		: { start: Math.min(safeAnchor, safeCaret), end: Math.max(safeAnchor, safeCaret) };
	const inputRows = layoutComposer(prompt, input, innerWidth);
	const caretPos = caretView(inputRows, input, safeCaret);
	const maxInputRows = Math.max(1, Math.min(8, rowCount - menuRows - statusRows - hintRows - 6));
	let visibleStart = 0;
	if (inputRows.length > maxInputRows) {
		visibleStart = Math.max(0, Math.min(caretPos.row, inputRows.length - maxInputRows));
		if (caretPos.row >= visibleStart + maxInputRows) visibleStart = caretPos.row - maxInputRows + 1;
	}
	const visibleInputRows = inputRows.slice(visibleStart, visibleStart + maxInputRows);
	const inputRowCount = visibleInputRows.length;
	const composerRows = 2 + inputRowCount;
	const chromeRows = menuRows + composerRows + statusRows;
	const documentPaneRows = Math.max(1, rowCount - chromeRows);
	const viewportRows = Math.max(1, documentPaneRows - hintRows);
	const maxOffset = Math.max(0, totalRows - viewportRows);
	let offset = Math.min(Math.max(0, scrollOffset), maxOffset);
	if (totalRowsRef.current !== totalRows) {
		const delta = totalRows - totalRowsRef.current;
		totalRowsRef.current = totalRows;
		if (scrollOffset > 0 && delta > 0) offset = Math.min(scrollOffset + delta, maxOffset);
		else offset = Math.min(Math.max(0, scrollOffset), maxOffset);
	}
	if (offset !== scrollOffset) setScrollOffset(offset);
	const visible = sliceFromBottom(document, heights, offset, viewportRows);
	const pageSize = Math.max(Math.floor(viewportRows * 0.8), 1);
	limits.current = { maxOffset, pageSize };
	const caretVisibleRow = caretPos.row - visibleStart;
	setCursorPosition({
		x: Math.min(caretPos.col, Math.max(0, colCount - 1)),
		y: documentPaneRows + menuRows + 2 + caretVisibleRow
	});

	useMouseWheel((direction) => {
		const { maxOffset: limit, pageSize: size } = limits.current;
		const step = Math.max(Math.floor(size / 4), 1);
		setScrollOffset((value) => {
			const next = direction === "up" ? value + step : value - step;
			return Math.min(Math.max(0, next), limit);
		});
	}, true);

	useEffect(() => api.subscribe((update) => {
		setState((previous) => ({ ...previous, ...update }));
	}), [api]);

	useEffect(() => {
		setSelected((previous) => Math.min(previous, Math.max(0, choices.length - 1)));
	}, [input, modelMenu, choices.length]);

	const submit = async (line) => {
		const text = line.trim();
		if (!text) return;
		if (state.turn === "running" && !text.startsWith("/")) return;
		setInput("");
		setCaret(0);
		setAnchor(null);
		setSelected(0);
		setScrollOffset(0);
		await api.submit(line);
	};

	const replaceRange = (from, to, text) => {
		const next = input.slice(0, from) + text + input.slice(to);
		setInput(next);
		setCaret(from + text.length);
		setAnchor(null);
	};

	const selectedRange = () => {
		if (safeAnchor == null || safeAnchor === safeCaret) return null;
		return { from: Math.min(safeAnchor, safeCaret), to: Math.max(safeAnchor, safeCaret) };
	};

	const insertText = (text) => {
		const range = selectedRange();
		if (range) replaceRange(range.from, range.to, text);
		else replaceRange(safeCaret, safeCaret, text);
	};

	const moveCaretTo = (next, extend) => {
		const clamped = clampIndex(next, input.length);
		setCaret(clamped);
		if (extend) setAnchor((value) => (value == null ? safeCaret : value));
		else setAnchor(null);
	};

	useInput((key, inputKey) => {
		if (inputKey.eventType === "release") return;
		if (key.startsWith("[<")) return;
		if (inputKey.ctrl && key.toLowerCase() === "c") {
			const range = selectedRange();
			if (range) {
				copyText(input.slice(range.from, range.to));
				return;
			}
			if (state.turn === "running") api.cancel();
			else exit();
			return;
		}
		if (inputKey.ctrl && key.toLowerCase() === "a") {
			setAnchor(0);
			setCaret(input.length);
			return;
		}
		if (inputKey.ctrl && key.toLowerCase() === "e") {
			moveCaretTo(input.length, false);
			return;
		}
		if (!modelMenu && isComposerNewline(key, inputKey)) {
			ignoreReturnUntil.current = Date.now() + 100;
			insertText("\n");
			return;
		}
		if (inputKey.escape) {
			if (modelMenu) setModelMenu(false);
			else if (selection) setAnchor(null);
			return;
		}
		if (inputKey.pageUp) {
			setScrollOffset((value) => Math.min(value + limits.current.pageSize, limits.current.maxOffset));
			return;
		}
		if (inputKey.pageDown) {
			setScrollOffset((value) => Math.max(value - limits.current.pageSize, 0));
			return;
		}
		if (inputKey.leftArrow) {
			if (!inputKey.shift && selectedRange()) {
				moveCaretTo(selectedRange().from, false);
				return;
			}
			const next = inputKey.meta || inputKey.ctrl
				? moveByWord(input, safeCaret, -1)
				: moveByCodePoint(input, safeCaret, -1);
			moveCaretTo(next, inputKey.shift);
			return;
		}
		if (inputKey.rightArrow) {
			if (!inputKey.shift && selectedRange()) {
				moveCaretTo(selectedRange().to, false);
				return;
			}
			const next = inputKey.meta || inputKey.ctrl
				? moveByWord(input, safeCaret, 1)
				: moveByCodePoint(input, safeCaret, 1);
			moveCaretTo(next, inputKey.shift);
			return;
		}
		if (inputKey.home) {
			moveCaretTo(inputRows[caretPos.row]?.start ?? 0, inputKey.shift);
			return;
		}
		if (inputKey.end) {
			moveCaretTo(inputRows[caretPos.row]?.end ?? input.length, inputKey.shift);
			return;
		}
		if (inputKey.upArrow && choices.length) {
			setSelected((value) => (value + choices.length - 1) % choices.length);
			return;
		}
		if (inputKey.downArrow && choices.length) {
			setSelected((value) => (value + 1) % choices.length);
			return;
		}
		if (inputKey.upArrow || inputKey.downArrow) {
			const goingUp = inputKey.upArrow;
			if (inputKey.shift || inputRows.length > 1) {
				const next = hitTestComposer(inputRows, input, caretPos.row + (goingUp ? -1 : 1), caretPos.col);
				if (inputKey.shift || next !== safeCaret) {
					moveCaretTo(next, inputKey.shift);
					return;
				}
			}
			const { maxOffset: limit, pageSize: size } = limits.current;
			const step = Math.max(Math.floor(size / 4), 1);
			setScrollOffset((value) => Math.min(Math.max(0, goingUp ? value + step : value - step), limit));
			return;
		}
		if (/^[1-9]$/.test(key) && choices[Number(key) - 1]) {
			const choice = choices[Number(key) - 1];
			if (modelMenu) {
				setModelMenu(false);
				void submit(`/model ${choice.provider}/${choice.id}`);
			} else {
				void submit(choice.name);
			}
			return;
		}
		if (inputKey.return) {
			if (Date.now() < ignoreReturnUntil.current) return;
			if (state.turn === "running" && !modelMenu && !input.trim().startsWith("/")) return;
			if (modelMenu && active) {
				setModelMenu(false);
				void submit(`/model ${active.provider}/${active.id}`);
			} else if (input.trim() === "/model") {
				setModelMenu(true);
			} else if (/\s/.test(input.trim())) {
				void submit(input);
			} else if (matches.length && input.trimStart().startsWith("/")) {
				if (active?.name === "/model") {
					setInput("/model");
					setCaret(6);
					setAnchor(null);
					setModelMenu(true);
				} else {
					void submit(active?.name ?? input);
				}
			} else {
				void submit(input);
			}
			return;
		}
		if (inputKey.backspace || (inputKey.ctrl && key === "h")) {
			const range = selectedRange();
			if (range) replaceRange(range.from, range.to, "");
			else if (inputKey.backspace && (inputKey.meta || inputKey.ctrl)) replaceRange(moveByWord(input, safeCaret, -1), safeCaret, "");
			else replaceRange(moveByCodePoint(input, safeCaret, -1), safeCaret, "");
			return;
		}
		if (inputKey.delete || (inputKey.ctrl && key === "d")) {
			const range = selectedRange();
			if (range) replaceRange(range.from, range.to, "");
			else replaceRange(safeCaret, moveByCodePoint(input, safeCaret, 1), "");
			return;
		}
		if (inputKey.ctrl && key === "w") {
			const range = selectedRange();
			if (range) replaceRange(range.from, range.to, "");
			else replaceRange(moveByWord(input, safeCaret, -1), safeCaret, "");
			return;
		}
		if (!inputKey.ctrl && !inputKey.meta && key) insertText(key.replace(/\r\n?/g, "\n"));
	});

	const olderHint = visible.startRow > 0
		? `↑ ${visible.startRow} earlier lines · PgUp to scroll`
		: " ";
	const newerHint = visible.endRow < visible.total
		? `↓ ${visible.total - visible.endRow} newer lines · PgDn to scroll`
		: " ";

	return h(
		Box,
		{ flexDirection: "column", height: rowCount, width: colCount, overflow: "hidden" },
		h(
			Box,
			{
				flexDirection: "column",
				height: documentPaneRows,
				minHeight: documentPaneRows,
				maxHeight: documentPaneRows,
				width: colCount,
				overflow: "hidden",
				flexGrow: 0,
				flexShrink: 0
			},
			h(Text, { dimColor: true, wrap: "truncate-end" }, olderHint),
			...visible.entries.map((entry, index) =>
				h(DocumentEntry, { key: `${visible.start + index}`, entry, index: visible.start + index })
			),
			h(Box, { flexGrow: 1, flexShrink: 1, minHeight: 0 }),
			h(Text, { dimColor: true, wrap: "truncate-end" }, newerHint)
		),
		modelMenu
			? h(
					Box,
					{ flexDirection: "column", height: menuRows, minHeight: menuRows, flexShrink: 0, overflow: "hidden", paddingX: 1 },
					h(Text, { color: BRAND, bold: true }, "Models"),
					...models.slice(0, 9).map((model, index) =>
						h(
							Text,
							{ key: `${model.provider}/${model.id}`, color: index === selected ? BRAND : undefined, wrap: "truncate-end" },
							`${index === selected ? "›" : " "} ${index + 1}. ${model.provider}/${model.id}${model.description ? ` — ${model.description}` : ""}`
						)
					)
				)
			: matches.length > 0
				? h(
						Box,
						{ flexDirection: "column", height: menuRows, minHeight: menuRows, flexShrink: 0, overflow: "hidden", paddingX: 1 },
						...matches.slice(0, 9).map((command, index) =>
							h(
								Text,
								{ key: command.name, color: index === selected ? BRAND : undefined, wrap: "truncate-end" },
								`${index === selected ? "›" : " "} ${index + 1}. ${command.name.padEnd(10)} ${command.description}`
							)
						)
					)
				: null,
		h(
			Box,
			{ flexDirection: "column", height: composerRows, minHeight: composerRows, maxHeight: composerRows, width: colCount, flexShrink: 0, overflow: "hidden" },
			h(Text, { color: state.turn === "running" ? "yellow" : BRAND_SOFT }, rule(colCount)),
			h(
				Box,
				{ paddingX: 0, flexDirection: "column", width: colCount, height: inputRowCount, minHeight: inputRowCount, flexShrink: 0, overflow: "hidden" },
				...visibleInputRows.map((row, index) => {
					const content = input.slice(row.start, row.end);
					const children = [];
					if (row.prefix) {
						children.push(h(Text, { color: row.prefix === prompt ? BRAND : undefined, wrap: "truncate-end" }, row.prefix));
					}
					if (selection) {
						const from = Math.max(0, selection.start - row.start);
						const to = Math.min(content.length, selection.end - row.start);
						if (to > 0 && from < content.length) {
							if (from > 0) children.push(content.slice(0, from));
							children.push(h(Text, { inverse: true, wrap: "truncate-end" }, content.slice(from, to)));
							children.push(content.slice(to));
						} else {
							children.push(content);
						}
					} else {
						children.push(content);
					}
					children.push(CARET_ANCHOR + caretTag(safeCaret));
					return h(Text, { key: `input-${row.start}-${index}`, wrap: "truncate-end" }, ...children);
				})
			),
			h(Text, { color: state.turn === "running" ? "yellow" : BRAND_SOFT }, rule(colCount))
		),
		h(
			Box,
			{ flexDirection: "column", width: colCount, height: statusRows, minHeight: statusRows, flexShrink: 0, paddingX: 1, overflow: "hidden" },
			h(
				Text,
				{ dimColor: true, wrap: "truncate-end" },
				`${contextLabel(state)}  ·  Turn ${state.turn ?? "idle"}`
			),
			h(
				Text,
				{ dimColor: true, wrap: "truncate-end" },
				`${state.provider ?? "—"}  ·  ${state.model ?? "—"}  ·  Session ${(state.sessionId ?? "—").slice(-12)}`
			)
		)
	);
}

export function startTuiUi(options) {
	let listener = null;
	let state = { lines: [], turn: "idle", ...options.initialState };
	const api = {
		subscribe(next) {
			listener = next;
			return () => {
				if (listener === next) listener = null;
			};
		},
		submit: options.onSubmit,
		cancel: options.onCancel
	};
	const instance = render(h(App, { api, commands: options.commands, initialState: state }), {
		alternateScreen: true,
		exitOnCtrlC: false,
		kittyKeyboard: { mode: "enabled", flags: ["disambiguateEscapeCodes"] }
	});
	const publish = (update) => {
		state = { ...state, ...update };
		listener?.(update);
	};
	return {
		write(text) {
			const raw = String(text);
			const parts = raw.split("\n");
			const lines = [...state.lines];
			if (lines.length === 0 || !state.lineOpen) lines.push("");
			lines[lines.length - 1] += parts.shift() ?? "";
			for (const part of parts) lines.push(part);
			const lineOpen = !raw.endsWith("\n");
			if (!lineOpen && lines.at(-1) === "") lines.pop();
			publish({ lines, lineOpen });
		},
		clear() {
			publish({ lines: [], lineOpen: false });
		},
		status(update) {
			publish(update);
		},
		waitUntilExit: instance.waitUntilExit,
		unmount: instance.unmount
	};
}
