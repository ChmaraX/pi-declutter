/**
 * buildCardEntries tests (ticket 38): the pure grouper-entries → card-data
 * conversion, extracted from index.ts. Verifies group labels/counts, failure
 * counting, settledIds collection, single vs multi-member labelling, thought
 * coalescing, and the live-thought marking.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCardEntries, type CardEntryBuild, settleAction, type ToolCall, toShapeItem } from "../src/card-build.ts";
import type { Entry } from "../src/grouping.ts";

function call(over: Partial<ToolCall> & { toolCallId: string; name: string }): ToolCall {
	return { arguments: {}, startMs: 0, endMs: 10, ...over };
}

test("buildCardEntries: a single-tool group gets no count suffix", () => {
	const entries: Entry<ToolCall>[] = [
		{ kind: "group", calls: [call({ toolCallId: "a", name: "read", arguments: { path: "x.ts" } })] },
	];
	const built = buildCardEntries(entries);
	assert.equal(built.entries.length, 1);
	const e = built.entries[0];
	assert.equal(e.kind, "group");
	if (e.kind === "group") {
		assert.equal(e.group.counts, "", "single-tool group has no count suffix");
		assert.equal(e.group.items.length, 1);
	}
	assert.deepEqual(built.settledIds, ["a"]);
	assert.equal(built.failures, 0);
});

test("buildCardEntries: a multi-tool group gets a bucket count and collects settledIds", () => {
	const entries: Entry<ToolCall>[] = [
		{
			kind: "group",
			calls: [
				call({ toolCallId: "a", name: "read", arguments: { path: "x.ts" } }),
				call({ toolCallId: "b", name: "bash", arguments: { command: "ls" } }),
			],
		},
	];
	const built = buildCardEntries(entries);
	const e = built.entries[0];
	assert.equal(e.kind, "group");
	if (e.kind === "group") assert.notEqual(e.group.counts, "", "multi-tool group carries a count");
	assert.deepEqual(built.settledIds, ["a", "b"]);
});

test("buildCardEntries: counts failures across a group", () => {
	const entries: Entry<ToolCall>[] = [
		{
			kind: "group",
			calls: [
				call({ toolCallId: "a", name: "bash", isError: true }),
				call({ toolCallId: "b", name: "bash" }),
				call({ toolCallId: "c", name: "bash", isError: true }),
			],
		},
	];
	assert.equal(buildCardEntries(entries).failures, 2);
});

test("buildCardEntries: a thought entry coalesces its spans", () => {
	const entries: Entry<ToolCall>[] = [
		{ kind: "thought", spans: [{ ms: 1500, text: "Planning the approach" }] },
	];
	const built = buildCardEntries(entries);
	assert.equal(built.entries.length, 1);
	const e = built.entries[0];
	assert.equal(e.kind, "thought");
	if (e.kind === "thought") {
		assert.equal(e.thought.ms, 1500);
		assert.ok(e.thought.summary.length > 0);
		assert.equal(e.thought.live, undefined, "not live unless flagged");
	}
});

test("buildCardEntries: liveThinkingActive marks only a TRAILING thought entry live", () => {
	const entries: Entry<ToolCall>[] = [
		{ kind: "group", calls: [call({ toolCallId: "a", name: "read" })] },
		{ kind: "thought", spans: [{ ms: 2000, text: "Considering next" }] },
	];
	const built = buildCardEntries(entries, true);
	const last = built.entries[built.entries.length - 1];
	assert.equal(last.kind, "thought");
	if (last.kind === "thought") assert.equal(last.thought.live, true);
});

test("buildCardEntries: liveThinkingActive does NOT mark a trailing GROUP entry", () => {
	const entries: Entry<ToolCall>[] = [
		{ kind: "thought", spans: [{ ms: 2000, text: "Considering" }] },
		{ kind: "group", calls: [call({ toolCallId: "a", name: "read" })] },
	];
	const built = buildCardEntries(entries, true);
	const first = built.entries[0];
	// The earlier thought stays not-live; only a trailing thought would be flagged.
	if (first.kind === "thought") assert.notEqual(first.thought.live, true);
});

// ── settleAction (ticket 38: the settle decision, pure) ───────────────────────

const EMPTY: CardEntryBuild = { entries: [], settledIds: [], failures: 0 };
const RENDERABLE: CardEntryBuild = {
	entries: [{ kind: "group", group: { label: "Ran ls", counts: "", items: [] } }],
	settledIds: ["a"],
	failures: 0,
};

test("settleAction: nothing renderable → freeze-empty regardless of a live card", () => {
	assert.equal(settleAction(EMPTY, true), "freeze-empty");
	assert.equal(settleAction(EMPTY, false), "freeze-empty");
});

test("settleAction: renderable with a live card → settle-live (mutate in place)", () => {
	assert.equal(settleAction(RENDERABLE, true), "settle-live");
});

test("settleAction: renderable with NO live card → append-settled (tool-less response)", () => {
	assert.equal(settleAction(RENDERABLE, false), "append-settled");
});

test("settleAction: a group with a label but zero items still counts as renderable", () => {
	const labelOnly: CardEntryBuild = {
		entries: [{ kind: "group", group: { label: "Ran ls", counts: "", items: [] } }],
		settledIds: [],
		failures: 0,
	};
	assert.equal(settleAction(labelOnly, true), "settle-live");
});

// ── Narration entries (ticket 41) ────────────────────────────────────────────────

test("buildCardEntries: a narration entry carries the full text plus a derived summary", () => {
	const entries: Entry<ToolCall>[] = [{ kind: "narration", text: "**Checking config**\nThe file looks fine so far." }];
	const built = buildCardEntries(entries);
	assert.equal(built.entries.length, 1);
	const e = built.entries[0];
	assert.equal(e.kind, "narration");
	if (e.kind === "narration") {
		assert.equal(e.narration.text, "**Checking config**\nThe file looks fine so far.");
		assert.equal(e.narration.summary, "Checking config The file looks fine so far."); // full prose kept (multi-line budget), markdown stripped
	}
});

test("buildCardEntries: a narration entry with only symbols/no words falls back to a non-empty summary", () => {
	const entries: Entry<ToolCall>[] = [{ kind: "narration", text: "---" }];
	const built = buildCardEntries(entries);
	const e = built.entries[0];
	assert.equal(e.kind, "narration");
	if (e.kind === "narration") assert.ok(e.narration.summary.length > 0, "never an empty row label");
});

test("buildCardEntries: narration entries do not affect failure counting or settledIds", () => {
	const entries: Entry<ToolCall>[] = [
		{ kind: "group", calls: [call({ toolCallId: "a", name: "bash", isError: true })] },
		{ kind: "narration", text: "That failed, retrying differently." },
	];
	const built = buildCardEntries(entries);
	assert.equal(built.failures, 1);
	assert.deepEqual(built.settledIds, ["a"]);
});

test("settleAction: a narration-only build (no tools ran) still counts as renderable", () => {
	const narrationOnly: CardEntryBuild = {
		entries: [{ kind: "narration", narration: { text: "An intermediate note.", summary: "An intermediate note." } }],
		settledIds: [],
		failures: 0,
	};
	assert.equal(settleAction(narrationOnly, false), "append-settled");
	assert.equal(settleAction(narrationOnly, true), "settle-live");
});

// ── Synthetic calls from thinking-channel dumps (span-classify) ────────────────

test("toShapeItem: labelOverride wins over describeCall and suppresses the args gist", () => {
	const call: ToolCall = {
		toolCallId: "span-syn-1",
		name: "bash",
		arguments: {},
		startMs: 1000,
		endMs: 1400,
		labelOverride: "Cursor shell: cd /x && npx biome lint",
		fullOutput: "Checked 8 files in 13ms.",
	};
	const item = toShapeItem(call);
	assert.equal(item.label, "Cursor shell: cd /x && npx biome lint");
	assert.equal(item.glyph, "$"); // family name drives the glyph
	assert.equal(item.command, undefined); // no real args — no $ line duplication
	assert.equal(item.fullOutput, "Checked 8 files in 13ms.");
});
