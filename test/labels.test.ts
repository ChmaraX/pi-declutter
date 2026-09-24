/**
 * Tests for the pure label heuristics (ticket 05/07/17), focused on the
 * structured signals ticket 37 introduced / relies on:
 *
 *   - describeCallIsGeneric: the args-gist gate now branches on this structured
 *     predicate instead of sniffing describeCall's "Used …" prose (item 7). It
 *     must be true for exactly the bare generic fallbacks and false for concrete
 *     labels (file/search/command cases AND self-describing custom tools).
 *   - bucketCountsText == liveCounter minus its "Exploring[ · ]" prefix, the
 *     equivalence that let item 2 drop the regex in index.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { bucketCountsText, describeCall, describeCallIsGeneric, type ToolCallLike } from "../src/labels.ts";

function call(name: string, args: Record<string, unknown> = {}): ToolCallLike {
	return { name, arguments: args };
}

// ── describeCallIsGeneric (item 7 structured signal) ──────────────────────────

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

test("describeCallIsGeneric matches describeCall's 'Used ' prefix across a mixed set", () => {
	// The predicate must agree with the old prose test on every input, so the
	// gist gate is unchanged in behavior.
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

