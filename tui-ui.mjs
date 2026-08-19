import { spawnSync } from "node:child_process";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, measureElement, render, useApp, useCursor, useInput, useWindowSize } from "ink";
import stringWidth from "string-width";

const h = React.createElement;
const BRAND = "#4176e6";
const BRAND_SOFT = "#679efe";
const USER_BG = "#34343f";
const CARET_ANCHOR = "\u2800";
const TRANSCRIPT_LINE_LIMIT = Number.parseInt(process.env.DSH_TUI_TRANSCRIPT_LINES ?? "2000", 10) || 2000;

export function appendTranscript(lines, lineOpen, text, lineLimit = TRANSCRIPT_LINE_LIMIT) {
	const raw = String(text);
	const parts = raw.split("\n");
	const next = [...lines];
	if (next.length === 0 || !lineOpen) next.push("");
	next[next.length - 1] += parts.shift() ?? "";
	for (const part of parts) next.push(part);
	const nextLineOpen = !raw.endsWith("\n");
	if (!nextLineOpen && next.at(-1) === "") next.pop();
	const dropped = Math.max(0, next.length - lineLimit);
	return {
		lines: dropped > 0 ? next.slice(dropped) : next,
		lineOpen: nextLineOpen,
		dropped
	};
}

function contextLabel(state) {
	if (state.contextUsage && state.contextWindow) return `Context ${state.contextUsage} / ${state.contextWindow}`;
	if (state.contextWindow) return `Context budget ${state.contextWindow}`;
	return "Context collecting usage";
}

function rule(columns) {
	return "─".repeat(Math.max(24, columns - 2));
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
	const plainText = stripAnsi(text);
	if (!plainText) return;
	if (process.stdout.isTTY) {
		process.stdout.write(`\x1b]52;c;${Buffer.from(plainText, "utf8").toString("base64")}\x07`);
	}
	if (process.platform === "darwin") {
		spawnSync("pbcopy", { input: plainText });
	}
}

function stripAnsi(text) {
	return String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function displayText(line) {
	if (line.startsWith("You ›")) return line.slice("You › ".length);
	if (line.startsWith("DeepSeek ›")) return line.slice("DeepSeek › ".length);
	if (line.startsWith("Think ›")) return line.slice("Think › ".length);
	return line;
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

function plainInlineMarkdown(text) {
	return text.replace(/`([^`]+)`|\*\*([^*]+)\*\*/g, (_, code, bold) => code ?? bold ?? "");
}

function markdownDisplayText(text, code, fence) {
	if (fence || code) return text;
	const heading = /^(#{1,6})\s+(.*)$/.exec(text);
	if (heading) return plainInlineMarkdown(heading[2]);
	const quote = /^>\s?(.*)$/.exec(text);
	if (quote) return `│ ${plainInlineMarkdown(quote[1])}`;
	return plainInlineMarkdown(text);
}

function screenRowStyle(kind, text, code, fence) {
	if (kind === "brand") return { color: BRAND, bold: true };
	if (kind === "hint" || kind === "meta") return { dimColor: true };
	if (kind === "user") return { color: "#f2f2f2", backgroundColor: USER_BG };
	if (kind === "tool-error") return { color: "red" };
	if (kind === "tool") return { color: "green" };
	if (kind === "think") return { color: "#a6a6a6", dimColor: true };
	if (fence) return { color: "#7f7f7f", dimColor: true };
	if (code) return { color: "cyan" };
	if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(text)) return { dimColor: true };
	if (/^(#{1,6})\s+/.test(text)) return { color: BRAND, bold: true };
	if (/^>\s?/.test(text)) return { dimColor: true };
	return {};
}

function pushScreenRows(rows, keyPrefix, kind, text, columns, extra = {}) {
	const width = Math.max(1, columns);
	for (const [rowIndex, rowText] of wrapLine(text, width).entries()) {
		rows.push({
			key: `${keyPrefix}-${rowIndex}`,
			kind,
			text: rowText,
			copyText: stripAnsi(rowText),
			...extra
		});
	}
}

function documentRows(entries, columns) {
	const rows = [];
	const width = Math.max(1, columns);
	for (const [index, entry] of entries.entries()) {
		if (entry.kind === "blank") {
			rows.push({ key: `${index}-blank`, kind: "blank", text: " " });
			continue;
		}
		if (entry.kind === "brand" || entry.kind === "hint") {
			const style = screenRowStyle(entry.kind, entry.text);
			pushScreenRows(rows, String(index), entry.kind, entry.text, width, {
				...style,
				bold: entry.bold ?? style.bold
			});
			continue;
		}
		if (entry.kind !== "transcript") continue;
		const line = entry.line;
		if (line.startsWith("You ›")) {
			rows.push({
				key: `${index}-user-top`,
				kind: "user",
				text: " ",
				copyText: "",
				...screenRowStyle("user", " ")
			});
			for (const [rowIndex, text] of wrapLine(displayText(line), Math.max(1, width - 1)).entries()) {
				const rowText = ` ${text}`;
				rows.push({
					key: `${index}-user-${rowIndex}`,
					kind: "user",
					text: rowText,
					copyText: rowText,
					...screenRowStyle("user", rowText)
				});
			}
			rows.push({
				key: `${index}-user-bottom`,
				kind: "user",
				text: " ",
				copyText: "",
				...screenRowStyle("user", " ")
			});
			continue;
		}
		const text = displayText(line);
		const kind = line.startsWith("Think ›")
			? "think"
			: line.startsWith("[tool error]")
				? "tool-error"
				: line.startsWith("[tool]")
					? "tool"
					: line.startsWith("[new ") || line.startsWith("[resumed ")
						? "meta"
						: "assistant";
		const display = kind === "assistant" || kind === "think"
			? markdownDisplayText(text, entry.code, entry.fence)
			: text;
		pushScreenRows(rows, String(index), kind, display, width, {
			code: entry.code,
			fence: entry.fence,
			...screenRowStyle(kind, text, entry.code, entry.fence)
		});
	}
	return rows;
}

function selectionBounds(selection) {
	if (!selection) return null;
	const a = selection.anchor;
	const b = selection.focus;
	if (a.row < b.row || (a.row === b.row && a.col <= b.col)) return { start: a, end: b };
	return { start: b, end: a };
}

function hasSelectionSpan(selection) {
	const bounds = selectionBounds(selection);
	return Boolean(bounds && (bounds.start.row !== bounds.end.row || bounds.start.col !== bounds.end.col));
}

function offsetAtCell(text, cell) {
	let width = 0;
	let offset = 0;
	for (const char of text) {
		const next = width + Math.max(1, stringWidth(char));
		if (cell < next) return offset;
		width = next;
		offset += char.length;
	}
	return text.length;
}

function selectedText(rows, selection) {
	const bounds = selectionBounds(selection);
	if (!bounds) return "";
	const out = [];
	for (let row = bounds.start.row; row <= bounds.end.row; row++) {
		const text = rows[row]?.copyText ?? rows[row]?.text ?? "";
		const start = row === bounds.start.row ? offsetAtCell(text, bounds.start.col) : 0;
		const end = row === bounds.end.row ? offsetAtCell(text, bounds.end.col) : text.length;
		out.push(text.slice(Math.min(start, end), Math.max(start, end)));
	}
	return stripAnsi(out.join("\n").trimEnd());
}

function selectedCellRange(rowIndex, text, selection) {
	const bounds = selectionBounds(selection);
	if (!bounds || rowIndex < bounds.start.row || rowIndex > bounds.end.row) return null;
	const start = rowIndex === bounds.start.row ? bounds.start.col : 0;
	const end = rowIndex === bounds.end.row ? bounds.end.col : stringWidth(text);
	if (start === end) return null;
	const from = offsetAtCell(text, Math.min(start, end));
	const to = offsetAtCell(text, Math.max(start, end));
	if (from === to) return null;
	return { from, to };
}

function SelectableRow({ row, rowIndex, selection, registerRow }) {
	const range = selectedCellRange(rowIndex, row.text, selection);
	const props = {
		key: row.key,
		color: row.color,
		dimColor: row.dimColor,
		bold: row.bold,
		wrap: "truncate-end"
	};
	const children = range
		? [
				row.text.slice(0, range.from),
				h(Text, { ...props, key: `${row.key}-selection`, inverse: true }, row.text.slice(range.from, range.to)),
				row.text.slice(range.to)
			]
		: [row.text];
	return h(
		Box,
		{
			key: row.key,
			ref: (node) => registerRow(rowIndex, node),
			width: "100%",
			height: 1,
			minHeight: 1,
			maxHeight: 1,
			flexShrink: 0,
			overflow: "hidden",
			backgroundColor: row.backgroundColor
		},
		h(Text, props, ...children)
	);
}

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
		process.stdout.write("\x1b[>4;2m\x1b[>5;1m\x1b[?1007l");
		return () => {
			process.stdout.write("\x1b[>4;0m\x1b[>5;0m");
		};
	}, []);
}

function useMouseWheel(onWheel, enabled, onPointer) {
	const wheel = useRef(onWheel);
	const pointer = useRef(onPointer);
	wheel.current = onWheel;
	pointer.current = onPointer;

	useEffect(() => {
		if (!enabled) return;
		if (!process.stdin.isTTY || !process.stdout.isTTY) return;
		let pending = "";
		const onData = (chunk) => {
			pending += String(chunk);
			const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
			let match;
			let consumed = 0;
			while ((match = pattern.exec(pending))) {
				consumed = pattern.lastIndex;
				const button = Number(match[1]);
				const marker = match[4];
				if (marker === "M" && (button & 64) !== 0) {
					wheel.current((button & 1) === 0 ? "up" : "down");
					continue;
				}
				const motion = (button & 32) !== 0;
				const which = button & 3;
				if (marker === "m") {
					pointer.current?.({ x: Number(match[2]), y: Number(match[3]), kind: "up" });
					continue;
				}
				if (which !== 0) continue;
				pointer.current?.({
					x: Number(match[2]),
					y: Number(match[3]),
					kind: motion ? "drag" : "down"
				});
			}
			pending = consumed > 0 ? pending.slice(consumed) : pending;
			if (pending.length > 32) pending = pending.slice(-32);
		};

		process.stdin.prependListener("data", onData);
		process.stdout.write("\x1b[?1002h\x1b[?1006h");
		return () => {
			process.stdin.removeListener("data", onData);
			process.stdout.write("\x1b[?1002l\x1b[?1006l");
		};
	}, [enabled]);
}

function commandMatches(input, commands) {
	const query = input.trimStart().toLowerCase();
	if (!query.startsWith("/")) return [];
	return commands.filter((command) => command.name.startsWith(query.split(/\s+/, 1)[0]));
}

function maskSecret(input) {
	return String(input).replace(/[^\n]/g, "*");
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
	const [docSelection, setDocSelection] = useState(null);
	const rowRefs = useRef(new Map());
	const rowBounds = useRef(new Map());
	const { columns, rows } = useWindowSize();
	const colCount = Math.max(1, columns ?? 80);
	const rowCount = Math.max(1, rows ?? 24);
	const totalRowsRef = useRef(0);
	const limits = useRef({ maxOffset: 0, pageSize: 1 });
	const ignoreReturnUntil = useRef(0);
	const secretPrompt = state.secretPrompt ?? null;
	const displayInput = secretPrompt ? maskSecret(input) : input;
	const matches = secretPrompt ? [] : commandMatches(input, commands);
	const models = state.models ?? [];
	const choices = secretPrompt ? [] : (modelMenu ? models : matches).slice(0, 9);
	const active = choices[selected];
	const transcript = state.lines ?? [];
	const document = useMemo(() => [
		{ kind: "brand", bold: true, text: `DeepSeek Harness${state.project ? `  ·  ${state.project}` : ""}` },
		...(state.banner ? state.banner.trim().split("\n").map((text) => ({ kind: "brand", text })) : []),
		{ kind: "hint", text: "Type / for commands  ·  Shift+Enter newline  ·  Touchpad scroll  ·  Drag to copy text" },
		...(state.truncatedLines ? [{ kind: "hint", text: `… 已截断 ${state.truncatedLines} 行 …` }] : []),
		{ kind: "blank" },
		...transcriptEntries(transcript)
	], [state.project, state.banner, state.truncatedLines, transcript]);
	const documentColumns = Math.max(1, colCount - 1);
	const rowsDoc = useMemo(() => documentRows(document, documentColumns), [document, documentColumns]);
	const totalRows = rowsDoc.length;
	const menuRows = secretPrompt ? 0 : modelMenu ? models.slice(0, 9).length + 1 : matches.length > 0 ? matches.slice(0, 9).length : 0;
	const statusRows = 2;
	const hintRows = 2;
	const prompt = secretPrompt ? secretPrompt.prompt : state.turn === "running" ? "⋯ " : "› ";
	const innerWidth = Math.max(1, colCount);
	const safeCaret = clampIndex(caret, input.length);
	const safeAnchor = anchor == null ? null : clampIndex(anchor, input.length);
	const selection = safeAnchor == null || safeAnchor === safeCaret
		? null
		: { start: Math.min(safeAnchor, safeCaret), end: Math.max(safeAnchor, safeCaret) };
	const inputRows = layoutComposer(prompt, displayInput, innerWidth);
	const caretPos = caretView(inputRows, displayInput, safeCaret);
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
	const visibleEndRow = Math.max(0, totalRows - offset);
	const visibleStartRow = Math.max(0, visibleEndRow - viewportRows);
	const visibleRows = rowsDoc.slice(visibleStartRow, visibleEndRow);
	const visibleRowSignature = visibleRows.map((row) => row.key).join("\0");
	const pageSize = Math.max(Math.floor(viewportRows * 0.8), 1);
	limits.current = { maxOffset, pageSize };
	const caretVisibleRow = caretPos.row - visibleStart;
	setCursorPosition({
		x: Math.min(caretPos.col, Math.max(0, colCount - 1)),
		y: documentPaneRows + menuRows + 2 + caretVisibleRow
	});

	const registerRow = (rowIndex, node) => {
		if (node) rowRefs.current.set(rowIndex, node);
		else rowRefs.current.delete(rowIndex);
	};

	useEffect(() => {
		const measured = new Map();
		for (const [rowIndex, node] of rowRefs.current.entries()) {
			const bounds = measureElement(node);
			if (bounds.width > 0 || bounds.height > 0) measured.set(rowIndex, bounds);
		}
		rowBounds.current = measured;
	}, [visibleStartRow, visibleEndRow, visibleRowSignature, colCount, rowCount, documentPaneRows]);

	useMouseWheel((direction) => {
		const { maxOffset: limit, pageSize: size } = limits.current;
		const step = Math.max(Math.floor(size / 4), 1);
		setScrollOffset((value) => {
			const next = direction === "up" ? value + step : value - step;
			return Math.min(Math.max(0, next), limit);
		});
	}, true, (event) => {
		const pointFromMouse = (clampToRows = false) => {
			const x = event.x - 1;
			const y = event.y - 1;
			const measuredRows = [...rowBounds.current.entries()].sort((a, b) => a[0] - b[0]);
			if (!measuredRows.length) return null;
			let fallback = null;
			for (const [row, bounds] of measuredRows) {
				const top = bounds.y;
				const bottom = bounds.y + Math.max(1, bounds.height);
				if (y >= top && y < bottom) {
					return { row, col: Math.max(0, Math.min(x - bounds.x, Math.max(0, bounds.width - 1))) };
				}
				if (clampToRows) {
					const distance = y < top ? top - y : y - bottom + 1;
					if (!fallback || distance < fallback.distance) fallback = { row, bounds, distance };
				}
			}
			if (!clampToRows || !fallback) return null;
			return {
				row: fallback.row,
				col: Math.max(0, Math.min(x - fallback.bounds.x, Math.max(0, fallback.bounds.width - 1)))
			};
		};
		if (event.kind === "down") {
			const point = pointFromMouse(false);
			if (!point) {
				setDocSelection(null);
				return;
			}
			setDocSelection({ anchor: point, focus: point, dragging: true });
			return;
		}
		if (event.kind === "drag") {
			const point = pointFromMouse(true);
			if (!point) return;
			setDocSelection((selection) => {
				if (!selection?.dragging) return selection;
				return { ...selection, focus: point };
			});
			return;
		}
		if (event.kind === "up") {
			const point = pointFromMouse(true);
			if (!point) return;
			setDocSelection((selection) => {
				if (!selection?.dragging) return selection;
				const next = { ...selection, focus: point, dragging: false };
				const text = selectedText(rowsDoc, next);
				if (text) copyText(text);
				return hasSelectionSpan(next) ? next : null;
			});
		}
	});

	useEffect(() => api.subscribe((update) => {
		setState((previous) => ({ ...previous, ...update }));
	}), [api]);

	useEffect(() => {
		setSelected((previous) => Math.min(previous, Math.max(0, choices.length - 1)));
	}, [input, modelMenu, choices.length]);

	useEffect(() => {
		if (!secretPrompt) return;
		setInput("");
		setCaret(0);
		setAnchor(null);
		setSelected(0);
		setModelMenu(false);
		setDocSelection(null);
	}, [secretPrompt?.id]);

	const submit = async (line) => {
		if (secretPrompt) {
			const value = input;
			setInput("");
			setCaret(0);
			setAnchor(null);
			setDocSelection(null);
			api.resolveSecret(value);
			return;
		}
		const text = line.trim();
		if (!text) return;
		if (state.turn === "running" && !text.startsWith("/")) return;
		setInput("");
		setCaret(0);
		setAnchor(null);
		setDocSelection(null);
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
		if (secretPrompt) return null;
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
		if ((inputKey.ctrl || inputKey.meta) && key.toLowerCase() === "c") {
			if (secretPrompt) {
				setInput("");
				setCaret(0);
				setAnchor(null);
				api.resolveSecret(null);
				return;
			}
			const range = selectedRange();
			if (range) {
				copyText(input.slice(range.from, range.to));
				return;
			}
			const documentText = selectedText(rowsDoc, docSelection);
			if (documentText) {
				copyText(documentText);
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
		if (!secretPrompt && !modelMenu && isComposerNewline(key, inputKey)) {
			ignoreReturnUntil.current = Date.now() + 100;
			insertText("\n");
			return;
		}
		if (inputKey.escape) {
			if (secretPrompt) {
				setInput("");
				setCaret(0);
				setAnchor(null);
				api.resolveSecret(null);
			} else if (modelMenu) setModelMenu(false);
			else if (selection) setAnchor(null);
			else if (docSelection) setDocSelection(null);
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
				const next = hitTestComposer(inputRows, displayInput, caretPos.row + (goingUp ? -1 : 1), caretPos.col);
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
			if (secretPrompt) {
				void submit(input);
				return;
			}
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

	const olderHint = visibleStartRow > 0
		? `↑ ${visibleStartRow} earlier lines · PgUp to scroll`
		: " ";
	const newerHint = visibleEndRow < totalRows
		? `↓ ${totalRows - visibleEndRow} newer lines · PgDn to scroll`
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
			...visibleRows.map((row, index) =>
				h(SelectableRow, { key: `${visibleStartRow + index}-${row.key}`, row, rowIndex: visibleStartRow + index, selection: docSelection, registerRow })
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
				`${contextLabel(state)}  ·  Turn ${state.turn ?? "idle"}${state.turnElapsed ? ` ${state.turnElapsed}` : ""}`
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
	let secretRequest = null;
	let secretSeq = 0;
	let state = { lines: [], turn: "idle", ...options.initialState };
	const publish = (update) => {
		state = { ...state, ...update };
		listener?.(update);
	};
	const api = {
		subscribe(next) {
			listener = next;
			return () => {
				if (listener === next) listener = null;
			};
		},
		submit: options.onSubmit,
		cancel: options.onCancel,
		resolveSecret(value) {
			if (!secretRequest) return;
			const request = secretRequest;
			secretRequest = null;
			publish({ secretPrompt: null });
			request.resolve(value);
		}
	};
	const instance = render(h(App, { api, commands: options.commands, initialState: state }), {
		alternateScreen: true,
		exitOnCtrlC: false,
		kittyKeyboard: { mode: "enabled", flags: ["disambiguateEscapeCodes"] }
	});
	return {
		write(text) {
			const next = appendTranscript(state.lines, state.lineOpen, text);
			publish({
				lines: next.lines,
				lineOpen: next.lineOpen,
				truncatedLines: (state.truncatedLines ?? 0) + next.dropped
			});
		},
		clear() {
			publish({ lines: [], lineOpen: false, truncatedLines: 0 });
		},
		status(update) {
			publish(update);
		},
		promptSecret(prompt) {
			if (secretRequest) throw new Error("a secret prompt is already active");
			return new Promise((resolve) => {
				secretRequest = { resolve };
				publish({ secretPrompt: { id: ++secretSeq, prompt } });
			});
		},
		waitUntilExit: instance.waitUntilExit,
		unmount() {
			if (secretRequest) {
				const request = secretRequest;
				secretRequest = null;
				request.resolve(null);
			}
			instance.unmount();
		}
	};
}