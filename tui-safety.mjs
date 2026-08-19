const TERMINAL_STRING = /\x1B(?:\][\s\S]*?(?:\x07|\x1B\\)|[P_^X][\s\S]*?\x1B\\|\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const C1_TERMINAL_STRING = /[\x90\x9D\x9E\x9F\x98][\s\S]*?(?:\x9C|\x1B\\|\x07)/g;
const C1_CSI = /\x9B[0-?]*[ -/]*[@-~]/g;
const UNSAFE_CONTROL = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
const SENSITIVE_KEY = /(?:api[-_]?key|token|password|authorization|cookie|secret|credential|private[-_]?key|access[-_]?key)/i;

/** Remove terminal control sequences from text that did not originate in this program. */
export function sanitizeTerminalText(value) {
	return String(value ?? "")
		.replace(TERMINAL_STRING, "")
		.replace(C1_TERMINAL_STRING, "")
		.replace(C1_CSI, "")
		.replace(UNSAFE_CONTROL, "");
}

export function sanitizeDisplayValue(value) {
	return sanitizeTerminalText(value).replace(/\r/g, "");
}

export function isSensitiveToolField(key) {
	return SENSITIVE_KEY.test(String(key));
}

/** Summarize tool arguments without exposing credential-shaped fields by default. */
export function summarizeToolArguments(raw, { verbose = false } = {}) {
	if (!raw) return "";
	if (verbose) return sanitizeDisplayValue(raw);
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return Object.entries(parsed)
				.slice(0, 3)
				.map(([key, value]) => {
					if (isSensitiveToolField(key)) return `${sanitizeDisplayValue(key)}=***`;
					const rendered = typeof value === "string"
						? value
						: JSON.stringify(value, (nestedKey, nestedValue) => isSensitiveToolField(nestedKey) ? "***" : nestedValue);
					const clean = sanitizeDisplayValue(rendered).replace(/\s+/g, " ").trim();
					return `${sanitizeDisplayValue(key)}=${clean.length > 40 ? `${clean.slice(0, 39)}…` : clean}`;
				})
				.join(" ");
		}
	} catch {}
	return "arguments hidden";
}
