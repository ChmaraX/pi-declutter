// Provider-stream normalization (owner architecture request): some providers
// route tool activity through the THINKING channel instead of real tool events.
// pi-cursor-sdk is the known case — Cursor's cloud agent executes tools
// remotely and streams each one back as a thinking block shaped like an
// operation dump ("$ grep …", "read /path", "Cursor shell: <cmd>" + output),
// interleaved with genuine reasoning prose. Without classification those dumps
// coalesce into the Thought entry and the card shows no tool members at all.
//
// This module is the single choke point for that normalization: one pure
// function that looks at a finished thinking span's text and says "reasoning"
// or "this is really a tool step". Detection is STRUCTURAL (what the first
// line looks like), not keyed to a provider name, so any other SDK that adopts
// the same convention gets classified for free, and genuine prose that merely
// mentions a command stays reasoning.

/** Cap for a synthesized member label (first line of the dump). */
export const MAX_SPAN_TOOL_LABEL_LEN = 88;

export type SpanClass =
	| { kind: "reasoning" }
	| {
			/** The span is a tool-activity dump, not reasoning. */
			kind: "tool";
			/** Member-row label: the dump's first line, end-truncated. */
			label: string;
			/** Built-in tool family the dump resembles — drives the row glyph via
			 * toolGlyph() ("bash" → $, "read" → ▤, "grep" → ⌕, "find" → ≡). */
			family: string;
	  };

/** First non-empty line of a span, trimmed. "" for an all-whitespace span. */
function firstLine(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line) return line;
	}
	return "";
}

function truncateLabel(line: string): string {
	return line.length > MAX_SPAN_TOOL_LABEL_LEN ? `${line.slice(0, MAX_SPAN_TOOL_LABEL_LEN - 1)}…` : line;
}

/**
 * Classify a finished thinking span. Tool-dump shapes (all keyed on the FIRST
 * non-empty line, so prose that mentions commands mid-paragraph stays
 * reasoning):
 *
 *   "$ <anything>"            — pseudo-shell op ("$ glob **&#47;x in /dir", "$ grep …")
 *   "Cursor <word>: …"        — named Cursor op ("Cursor shell: cd … && npx …")
 *   "read /path" | "read ~/…" — file read dump (path arg, NOT prose "read the file")
 *   "grep <arg>" / "glob <arg>" / "list <arg>" / "ls <arg>" — search/list dumps
 */
export function classifyThinkingSpan(text: string): SpanClass {
	const line = firstLine(text);
	if (!line) return { kind: "reasoning" };
	if (line.startsWith("$ ")) return { kind: "tool", label: truncateLabel(line), family: "bash" };
	if (/^Cursor [a-z]+:/i.test(line)) return { kind: "tool", label: truncateLabel(line), family: "bash" };
	if (/^read (\/|~\/)/.test(line)) return { kind: "tool", label: truncateLabel(line), family: "read" };
	if (/^grep\s+\S/.test(line)) return { kind: "tool", label: truncateLabel(line), family: "grep" };
	if (/^(glob|list|ls)\s+\S/.test(line)) return { kind: "tool", label: truncateLabel(line), family: "find" };
	return { kind: "reasoning" };
}
