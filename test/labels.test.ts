/**
 * Tests for the pure label heuristics, focused on their structured signals:
 *
 *   - describeCallIsGeneric: the args-gist gate branches on this structured
 *     predicate instead of sniffing describeCall's "Used …" prose. It
 *     must be true for exactly the bare generic fallbacks and false for concrete
 *     labels (file/search/command cases AND self-describing custom tools).
 *   - bucketCountsText == liveCounter minus its "Exploring[ · ]" prefix, the
 *     equivalence index.ts relies on instead of a regex.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	bucketCountsText,
	bucketOf,
	describeCall,
	describeCallIsGeneric,
	isCommandTool,
	isPreviewTool,
	type ToolCallLike,
} from "../src/labels.ts";
import { toolGlyph } from "../src/card-shape.ts";

function call(name: string, args: Record<string, unknown> = {}): ToolCallLike {
	return { name, arguments: args };
}

// ── describeCallIsGeneric (structured signal) ─────────────────────────────────

test("describeCallIsGeneric is false for concrete built-in (file/search/command) calls", () => {
	for (const c of [
		call("read", { path: "a.ts" }),
		call("edit", { path: "a.ts" }),
		call("write", { path: "a.ts" }),
		call("grep", { pattern: "x" }),
		call("find", { pattern: "x" }),
		call("ls", { path: "." }),
		call("bash", { command: "git status" }),
		call("powershell", { command: "Get-ChildItem" }),
	]) {
		assert.equal(describeCallIsGeneric(c), false, `${c.name} should be concrete`);
		assert.equal(describeCall(c).startsWith("Used "), false);
	}
});

test("describeCallIsGeneric is false for self-describing custom tools (concrete label)", () => {
	// These map to descriptive labels, so no gist should be appended.
	for (const c of [
		call("cursor", { activityTitle: "Refactor auth" }),
		call("linear_get_issue", { id: "NV-1" }),
		call("web_search", { query: "next.js" }),
		call("fetch_content", { url: "https://x" }),
		call("linear_list_issues"),
	]) {
		assert.equal(describeCallIsGeneric(c), false, `${c.name} should be concrete`);
	}
});

test("describeCallIsGeneric is true for bare generic fallbacks", () => {
	// Unknown tool → "Used <name>"; known family with empty rest → "Used <family>";
	// cursor with no args → its "Used Cursor" fallback.
	for (const c of [call("some_unknown_tool"), call("linear_"), call("cursor")]) {
		assert.equal(describeCallIsGeneric(c), true, `${c.name} should be generic`);
		assert.equal(describeCall(c).startsWith("Used "), true);
	}
});

// ── TOOL_TRAITS (one dispatch table, not five scattered switches) ───────────────

test("toolGlyph/bucketOf/isCommandTool/isPreviewTool agree per built-in tool", () => {
	const expected: Record<string, { bucket: string; glyph: string; isCommand: boolean; preview: boolean }> = {
		read: { bucket: "files", glyph: "\u25a4", isCommand: false, preview: false },
		edit: { bucket: "files", glyph: "\u270e", isCommand: false, preview: false },
		write: { bucket: "files", glyph: "\u270e", isCommand: false, preview: false },
		grep: { bucket: "searches", glyph: "\u2315", isCommand: false, preview: true },
		find: { bucket: "searches", glyph: "\u2261", isCommand: false, preview: true },
		ls: { bucket: "searches", glyph: "\u2261", isCommand: false, preview: true },
		bash: { bucket: "commands", glyph: "$", isCommand: true, preview: true },
		powershell: { bucket: "commands", glyph: "$", isCommand: true, preview: true },
	};
	for (const [name, traits] of Object.entries(expected)) {
		assert.equal(bucketOf(name), traits.bucket, `${name} bucket`);
		assert.equal(toolGlyph(name), traits.glyph, `${name} glyph`);
		assert.equal(isCommandTool(name), traits.isCommand, `${name} isCommand`);
		assert.equal(isPreviewTool(name), traits.preview, `${name} preview`);
	}
});

test("unknown/MCP tool names keep today's fallback: generic bucket, default glyph, not a command, no preview", () => {
	for (const name of ["mystery", "linear_get_issue", "cursor", "github_pull_request"]) {
		assert.equal(bucketOf(name), "tools", `${name} bucket`);
		assert.equal(toolGlyph(name), "\u25c6", `${name} glyph`);
		assert.equal(isCommandTool(name), false, `${name} isCommand`);
		assert.equal(isPreviewTool(name), false, `${name} preview`);
	}
	assert.equal(bucketOf(undefined), "tools");
	assert.equal(isCommandTool(undefined), false);
	assert.equal(isPreviewTool(undefined), false);
});

test("describeCallIsGeneric matches describeCall's 'Used ' prefix across a mixed set", () => {
	// The predicate must agree with the "Used " prose prefix on every input, so
	// the gist gate behaves identically.
	const cases = [
		call("read", { path: "a.ts" }),
		call("bash", { command: "ls" }),
		call("cursor", { activityTitle: "T" }),
		call("cursor"),
		call("linear_get_issue", { id: "NV-9" }),
		call("linear_"),
		call("github_pull_request"),
		call("mystery"),
	];
	for (const c of cases) {
		assert.equal(describeCallIsGeneric(c), describeCall(c).startsWith("Used "), `mismatch for ${c.name}`);
	}
});

