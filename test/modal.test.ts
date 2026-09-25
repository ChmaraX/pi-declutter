/**
 * Tests for the pure modal-content model + scroll windowing (ticket 35). The
 * inline output box was replaced by a floating overlay; this file locks the
 * content composition (title / badge / caption / body / copy text) and the
 * scroll math the overlay component relies on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ShapeItem, ShapeNarration, ShapeThought } from "../src/card-shape.ts";
import {
	clampScrollTop,
	handleToolsExpandInput,
	itemModalContent,
	narrationModalContent,
	scrollHint,
	thoughtModalContent,
	visibleSlice,
	wrapBody,
	wrapLine,
} from "../src/modal.ts";

function item(overrides: Partial<ShapeItem> = {}): ShapeItem {
	return { label: "Ran git status", durMs: 300, isError: false, running: false, preview: [], glyph: "$", ...overrides };
}

function thought(overrides: Partial<ShapeThought> = {}): ShapeThought {
	return { ms: 0, summary: "", tail: [], ...overrides };
}

function narration(overrides: Partial<ShapeNarration> = {}): ShapeNarration {
	return { text: "", summary: "", ...overrides };
}

// ── modal input ──────────────────────────────────────────────────────────────

test("handleToolsExpandInput uses the configured matcher and handles only that action", () => {
	let toggles = 0;
	const matches = (data: string) => data === "configured-expand";
	assert.equal(handleToolsExpandInput("ctrl+o", matches, () => toggles++), false);
	assert.equal(toggles, 0);
	assert.equal(handleToolsExpandInput("configured-expand", matches, () => toggles++), true);
	assert.equal(toggles, 1);
});

// ── itemModalContent ─────────────────────────────────────────────────────────

test("a command modal leads its body with the $ command line and shows a Shell caption", () => {
	const content = itemModalContent(item({ command: "git status", preview: ["M src/index.ts"] }));
	assert.equal(content.caption, "Shell");
	assert.equal(content.title, "Ran git status (0.3s)");
	assert.deepEqual(content.body, ["$ git status", "M src/index.ts"]);
	assert.equal(content.copyText, "$ git status\nM src/index.ts");
	assert.deepEqual(content.badge, { text: "✓ Success", tone: "success" });
});

test("a non-command modal has an Output caption and no leading $ line", () => {
	const content = itemModalContent(item({ label: "Searched for foo", glyph: "⌕", preview: ["a.ts:1", "b.ts:2"] }));
	assert.equal(content.caption, "Output");
	assert.deepEqual(content.body, ["a.ts:1", "b.ts:2"]);
	assert.equal(content.copyText, "a.ts:1\nb.ts:2");
});

test("a failed command modal carries the exit-code badge", () => {
	const content = itemModalContent(item({ isError: true, command: "git push", exitCode: 1, preview: ["fatal: no upstream"] }));
	assert.deepEqual(content.badge, { text: "Exit code 1", tone: "error" });
	assert.equal(content.body[0], "$ git push");
});

test("modal body drops the duplicated exit-code line and trailing blanks (ticket-19 cleanup, review P2)", () => {
	const content = itemModalContent(
		item({
			isError: true,
			command: "git push",
			exitCode: 1,
			preview: ["fatal: no upstream", "Command exited with code 1", "", ""],
		}),
	);
	// The badge already conveys the exit code, so the body must not repeat it,
	// and trailing blank lines are trimmed — matching the former inline box.
	assert.deepEqual(content.body, ["$ git push", "fatal: no upstream"]);
	assert.equal(content.copyText, "$ git push\nfatal: no upstream");
});

test("fullText supersedes the preview tail and sets the full flag", () => {
	const full = "line1\nline2\nline3\nline4";
	const content = itemModalContent(item({ command: "cat big", preview: ["line3", "line4"] }), full);
	assert.equal(content.full, true);
	assert.deepEqual(content.body, ["$ cat big", "line1", "line2", "line3", "line4"]);
	assert.equal(content.copyText, "$ cat big\nline1\nline2\nline3\nline4");
});

test("empty output yields just the command line (or an empty body)", () => {
	const cmd = itemModalContent(item({ command: "true", preview: [] }));
	assert.deepEqual(cmd.body, ["$ true"]);
	const noCmd = itemModalContent(item({ label: "Read a.ts", glyph: "▤", preview: [] }));
	assert.deepEqual(noCmd.body, []);
	assert.equal(noCmd.copyText, "");
});

// ── thoughtModalContent ────────────────────────────────────────────────────────

test("a thought modal titles with the duration + summary and a Thinking caption", () => {
	const content = thoughtModalContent(thought({ ms: 3000, summary: "weighing options", tail: ["weighing options", "a vs b"] }));
	assert.equal(content.caption, "Thinking");
	assert.equal(content.title, "Thought 3s · weighing options");
	assert.deepEqual(content.body, ["weighing options", "a vs b"]);
	assert.equal(content.copyText, "weighing options\na vs b");
	assert.equal(content.badge, undefined);
});

test("a thought modal with no summary omits the trailing separator", () => {
	const content = thoughtModalContent(thought({ ms: 1200, tail: ["quick thought"] }));
	assert.equal(content.title, "Thought 1s");
});

// ── narrationModalContent (ticket 41) ────────────────────────────────────────────

test("a narration modal titles with the summary and a Narration caption, full body + copy", () => {
	const content = narrationModalContent(
		narration({ text: "First line of the note.\nSecond line.", summary: "First line of the note." }),
	);
	assert.equal(content.caption, "Narration");
	assert.equal(content.title, "First line of the note.");
	assert.deepEqual(content.body, ["First line of the note.", "Second line."]);
	assert.equal(content.copyText, "First line of the note.\nSecond line.");
	assert.equal(content.badge, undefined);
	assert.equal(content.full, true); // the grouper always captures the whole block
});

test("an empty narration yields an empty body", () => {
	const content = narrationModalContent(narration({ text: "", summary: "Message" }));
	assert.deepEqual(content.body, []);
	assert.equal(content.copyText, "");
});

// ── scroll windowing ───────────────────────────────────────────────────────────

test("clampScrollTop keeps top within [0, total - viewport]", () => {
	assert.equal(clampScrollTop(-5, 100, 20), 0);
	assert.equal(clampScrollTop(50, 100, 20), 50);
	assert.equal(clampScrollTop(200, 100, 20), 80); // max top = 100 - 20
	assert.equal(clampScrollTop(5, 10, 20), 0); // fits entirely → no scroll
});

test("visibleSlice returns the clamped window of body lines", () => {
	const body = Array.from({ length: 10 }, (_, i) => `L${i}`);
	assert.deepEqual(visibleSlice(body, 0, 3), ["L0", "L1", "L2"]);
	assert.deepEqual(visibleSlice(body, 8, 3), ["L7", "L8", "L9"]); // clamped to last page
	assert.deepEqual(visibleSlice(body, -3, 3), ["L0", "L1", "L2"]);
});

test("scrollHint is empty when everything fits and a 1-based range otherwise", () => {
	assert.equal(scrollHint(0, 20, 10), "");
	assert.equal(scrollHint(0, 5, 20), "1–5 / 20");
	assert.equal(scrollHint(10, 5, 20), "11–15 / 20");
	assert.equal(scrollHint(100, 5, 20), "16–20 / 20"); // clamped to the last page
});

// ── wrapLine / wrapBody (ticket 39) ─────────────────────────────────────────────

test("wrapLine leaves a line that fits unchanged", () => {
	assert.deepEqual(wrapLine("short line", 20), ["short line"]);
	assert.deepEqual(wrapLine("exactly-ten", 11), ["exactly-ten"]);
});

test("wrapLine breaks a long line on word boundaries, never mid-word when avoidable", () => {
	const rows = wrapLine("the quick brown fox jumps over", 10);
	// Each row within the 10-col budget; words kept whole.
	for (const r of rows) assert.ok([...r].length <= 10, `row too wide: ${JSON.stringify(r)}`);
	assert.deepEqual(rows, ["the quick", "brown fox", "jumps over"]);
	// Rejoining the rows on spaces reproduces the original words in order.
	assert.equal(rows.join(" "), "the quick brown fox jumps over");
});

test("wrapLine hard-breaks a single unbreakable token longer than the width", () => {
	const rows = wrapLine("abcdefghijklmnop", 5);
	assert.deepEqual(rows, ["abcde", "fghij", "klmno", "p"]);
});

test("wrapLine hard-breaks a long token that starts mid-line after a word", () => {
	const rows = wrapLine("hi abcdefghij", 5);
	// "hi" fits its own row, then the 10-char token hard-breaks into 5-col chunks.
	assert.deepEqual(rows, ["hi", "abcde", "fghij"]);
});

test("wrapLine preserves an empty line as a single empty row", () => {
	assert.deepEqual(wrapLine("", 10), [""]);
});

test("wrapLine honours an injected width measure (wide chars count double)", () => {
	// Treat every char as width 2: a 4-char string needs 8 cols, so at width 5 it
	// hard-breaks after 2 chars per row.
	const double = (s: string) => [...s].length * 2;
	assert.deepEqual(wrapLine("abcd", 5, double), ["ab", "cd"]);
});

test("wrapBody flattens multi-paragraph body, keeping blank separators", () => {
	const body = ["the quick brown fox", "", "jumps over the lazy dog"];
	const rows = wrapBody(body, 10);
	assert.deepEqual(rows, ["the quick", "brown fox", "", "jumps over", "the lazy", "dog"]);
});

test("wrapped body drives the scroll math on the larger row count", () => {
	// Two source lines wrap to five rows; a 3-row viewport then scrolls them.
	const body = ["aaa bbb ccc ddd", "eee fff"];
	const rows = wrapBody(body, 7);
	assert.deepEqual(rows, ["aaa bbb", "ccc ddd", "eee fff"]);
	assert.equal(rows.length, 3);
	// Viewport of 2 over 3 rows: top clamps to 1, hint reflects the wrapped total.
	assert.deepEqual(visibleSlice(rows, 5, 2), ["ccc ddd", "eee fff"]);
	assert.equal(scrollHint(0, 2, rows.length), "1–2 / 3");
});

// ── Input section (owner issue 2: MCP/extension tool modals were empty) ────────

test("a non-command modal with input leads with Input, then Output, caption Call", () => {
	const content = itemModalContent(
		item({ label: "GitHub: issue read", glyph: "◆", input: '{\n  "issue_number": 9953\n}', fullOutput: undefined }),
		'{"number":9953}',
	);
	assert.equal(content.caption, "Call");
	assert.deepEqual(content.body.slice(0, 4), ["Input:", "{", '  "issue_number": 9953', "}"]);
	assert.ok(content.body.includes("Output:"));
	assert.ok(content.body.includes('{"number":9953}'));
	// Copy carries the whole sectioned body.
	assert.ok(content.copyText.startsWith("Input:"));
});

test("a non-command modal with input but NO output says so instead of an empty box", () => {
	const content = itemModalContent(item({ input: '{"q": "x"}' }));
	assert.equal(content.body[content.body.length - 1], "(no output captured)");
});

test("a command modal ignores input (the $ line is the input) and keeps its shape", () => {
	const content = itemModalContent(item({ command: "ls", input: '{"should": "not appear"}', preview: ["a.ts"] }));
	assert.equal(content.caption, "Shell");
	assert.equal(content.body[0], "$ ls");
	assert.equal(content.body.includes("Input:"), false);
});
