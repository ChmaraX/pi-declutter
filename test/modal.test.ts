/**
 * Tests for the pure modal-content model + scroll windowing (ticket 35). The
 * inline output box was replaced by a floating overlay; this file locks the
 * content composition (title / badge / caption / body / copy text) and the
 * scroll math the overlay component relies on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ShapeItem, ShapeThought } from "../src/card-shape.ts";
import {
	clampScrollTop,
	itemModalContent,
	scrollHint,
	thoughtModalContent,
	visibleSlice,
} from "../src/modal.ts";

function item(overrides: Partial<ShapeItem> = {}): ShapeItem {
	return { label: "Ran git status", durMs: 300, isError: false, running: false, preview: [], glyph: "$", ...overrides };
}

function thought(overrides: Partial<ShapeThought> = {}): ShapeThought {
	return { ms: 0, summary: "", tail: [], ...overrides };
}

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
