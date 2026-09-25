/**
 * Headless unit tests for the pure flow state machine (tickets 10 + 21).
 *
 * Runs via Node's built-in TypeScript type-stripping (Node >= 23.6), no TUI and
 * no build step: `node --test test/grouping.test.ts` (see package.json `test`).
 *
 * These lock the flow behaviours:
 *   1. Groups break on assistant text with non-whitespace content (ticket 10) AND
 *      on meaningful thinking (ticket 21); empty/whitespace text and turn
 *      boundaries do NOT break, so sequential tool-only turns stay one group.
 *   2. The card is an ordered TOP-LEVEL sequence of Group and Thought entries in
 *      event order (ticket 21).
 *   3. Meaningful thinking = consecutive spans totaling >= MIN_THOUGHT_MS: it
 *      closes the current group and becomes its own thought entry between groups.
 *      Sub-threshold thinking is ignored entirely (does not break, does not emit).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type Entry, Grouper, hasNonWhitespace, MIN_THOUGHT_MS, shouldTick } from "../src/grouping.ts";

/** Convenience: build a grouper over plain string "calls". */
function grouper(): Grouper<string> {
	return new Grouper<string>();
}

/** Calls of a group entry (fails if the entry is not a group). */
function groupCalls(entry: Entry<string>): string[] {
	assert.equal(entry.kind, "group");
	return entry.kind === "group" ? entry.calls : [];
}

/** Total ms of a thought entry (fails if the entry is not a thought). */
function thoughtMs(entry: Entry<string>): number {
	assert.equal(entry.kind, "thought");
	return entry.kind === "thought" ? entry.spans.reduce((s, sp) => s + sp.ms, 0) : 0;
}

test("hasNonWhitespace distinguishes blank from content", () => {
	assert.equal(hasNonWhitespace(""), false);
	assert.equal(hasNonWhitespace("   "), false);
	assert.equal(hasNonWhitespace("\n\t "), false);
	assert.equal(hasNonWhitespace(" x "), true);
	assert.equal(hasNonWhitespace("."), true);
});

test("sequential tool-only turns stay one group (no text/thinking between)", () => {
	const g = grouper();
	// 4 tool calls spread across 4 turns; turn boundaries are no-ops.
	g.addCall("read");
	g.addCall("bash");
	g.addCall("read");
	g.addCall("grep");
	const { entries } = g.finalize();
	assert.equal(entries.length, 1);
	assert.deepEqual(groupCalls(entries[0]), ["read", "bash", "read", "grep"]);
});

test("empty/whitespace-only text block does NOT break the group", () => {
	const g = grouper();
	g.addCall("read");
	g.textStart();
	g.textDelta("   ");
	g.textDelta("\n\t");
	g.textEnd("   \n\t");
	g.addCall("bash");
	const { entries } = g.finalize();
	assert.equal(entries.length, 1);
	assert.deepEqual(groupCalls(entries[0]), ["read", "bash"]);
});

test("first non-whitespace text_delta breaks the group", () => {
	const g = grouper();
	g.addCall("read");
	g.textStart();
	g.textDelta("Now let me check");
	g.addCall("bash");
	const { entries } = g.finalize();
	assert.equal(entries.length, 2);
	assert.deepEqual(groupCalls(entries[0]), ["read"]);
	assert.deepEqual(groupCalls(entries[1]), ["bash"]);
});

test("leading whitespace delta then content still breaks exactly once", () => {
	const g = grouper();
	g.addCall("read");
	g.textStart();
	g.textDelta("  "); // whitespace only: no break yet
	g.textDelta("Hello"); // first content: break
	g.textDelta(" world"); // already broke this block: no second break
	g.addCall("bash");
	g.addCall("grep");
	const { entries } = g.finalize();
	assert.equal(entries.length, 2);
	assert.deepEqual(groupCalls(entries[0]), ["read"]);
	assert.deepEqual(groupCalls(entries[1]), ["bash", "grep"]);
});

test("text_end with content breaks even when no delta carried it, and records a narration entry (ticket 41)", () => {
	const g = grouper();
	g.addCall("read");
	g.textStart();
	g.textEnd("All done."); // provider delivered whole block in text_end
	g.addCall("bash");
	// The response ends on a group with ONE narration — promotion pulls it back
	// out as the answer (a response must never be answerless), leaving the two
	// groups it separated.
	const { entries, finalAnswer, promoted } = g.finalize();
	assert.equal(entries.length, 2);
	assert.deepEqual(groupCalls(entries[0]), ["read"]);
	assert.deepEqual(groupCalls(entries[1]), ["bash"]);
	assert.equal(finalAnswer, "All done.");
	assert.equal(promoted, true);
});

test("a leading text block before any tool does not create an empty group", () => {
	const g = grouper();
	g.textStart();
	g.textDelta("Sure, let me look."); // break on empty open group → no-op
	g.addCall("read");
	const { entries } = g.finalize();
	assert.equal(entries.length, 1);
	assert.deepEqual(groupCalls(entries[0]), ["read"]);
});

// ── Meaningful thinking as its own top-level entry (ticket 21) ───────────────────

test("think → cmd → think → cmd is four ordered entries in event order", () => {
	const g = grouper();
	g.addThought(4000, "planning approach");
	g.addCall("bash"); // resolves the leading thought, then opens a group
	g.addThought(2000, "checking output");
	g.addCall("make"); // resolves the 2nd thought, opens a new group
	const { entries } = g.finalize();
	assert.equal(entries.length, 4);
	assert.equal(thoughtMs(entries[0]), 4000);
	assert.deepEqual(groupCalls(entries[1]), ["bash"]);
	assert.equal(thoughtMs(entries[2]), 2000);
	assert.deepEqual(groupCalls(entries[3]), ["make"]);
});

test("leading meaningful thinking is the first entry, before the first group", () => {
	const g = grouper();
	g.addThought(1500, "planning");
	g.addCall("read");
	g.addCall("grep");
	const { entries } = g.finalize();
	assert.equal(entries.length, 2);
	assert.equal(entries[0].kind, "thought");
	assert.equal(thoughtMs(entries[0]), 1500);
	assert.deepEqual(groupCalls(entries[1]), ["read", "grep"]);
});

test("consecutive thinking spans coalesce into ONE thought entry (summed ms)", () => {
	const g = grouper();
	g.addCall("read");
	// Two consecutive spans (no tool between) totalling >= 1s → one entry.
	g.addThought(600, "first burst");
	g.addThought(700, "second burst\nlast summary");
	g.addCall("bash");
	const { entries } = g.finalize();
	assert.equal(entries.length, 3);
	assert.deepEqual(groupCalls(entries[0]), ["read"]);
	assert.equal(entries[1].kind, "thought");
	assert.equal(thoughtMs(entries[1]), 1300); // 600 + 700 coalesced
	assert.deepEqual(groupCalls(entries[2]), ["bash"]);
});

test("sub-threshold thinking between two tools is ignored: the group stays whole", () => {
	const g = grouper();
	g.addCall("bash");
	g.addThought(500, "tiny bursty span"); // < 1s → ignored, does not break
	g.addCall("make");
	const { entries } = g.finalize();
	// One fat group; no thought entry, no split (protects against bursty spans).
	assert.equal(entries.length, 1);
	assert.deepEqual(groupCalls(entries[0]), ["bash", "make"]);
});

test("many bursty sub-second spans between tools still coalesce past the threshold", () => {
	const g = grouper();
	g.addCall("read");
	g.addThought(400, "a");
	g.addThought(400, "b");
	g.addThought(400, "c"); // 1200 total ≥ 1s → meaningful, closes the group
	g.addCall("bash");
	const { entries } = g.finalize();
	assert.equal(entries.length, 3);
	assert.deepEqual(groupCalls(entries[0]), ["read"]);
	assert.equal(thoughtMs(entries[1]), 1200);
	assert.deepEqual(groupCalls(entries[2]), ["bash"]);
});

test("meaningful thinking then visible text: one thought entry, no empty trailing group", () => {
	const g = grouper();
	g.addCall("read");
	g.addThought(2000, "reasoning before answering");
	g.textStart();
	g.textDelta("Here is the answer.");
	const { entries } = g.finalize();
	// Group (read) closes, thought entry lands, then the text break closes nothing.
	assert.equal(entries.length, 2);
	assert.deepEqual(groupCalls(entries[0]), ["read"]);
	assert.equal(thoughtMs(entries[1]), 2000);
});

test("trailing meaningful thinking after the last tool is emitted at finalize", () => {
	const g = grouper();
	g.addCall("bash");
	g.addThought(1500, "wrapping up");
	const { entries } = g.finalize();
	assert.equal(entries.length, 2);
	assert.deepEqual(groupCalls(entries[0]), ["bash"]);
	assert.equal(thoughtMs(entries[1]), 1500);
});

test("trailing sub-threshold thinking after the last tool is dropped", () => {
	const g = grouper();
	g.addCall("bash");
	g.addThought(300, "blip");
	const { entries } = g.finalize();
	assert.equal(entries.length, 1);
	assert.deepEqual(groupCalls(entries[0]), ["bash"]);
});

test("zero/negative-duration spans are dropped and never contribute", () => {
	const g = grouper();
	g.addThought(0, "dropped");
	g.addThought(-5, "dropped");
	g.addCall("read");
	const { entries } = g.finalize();
	assert.equal(entries.length, 1);
	assert.deepEqual(groupCalls(entries[0]), ["read"]);
});

test("snapshot shows resolved entries plus the open group at the tail (pending hidden)", () => {
	const g = grouper();
	g.addThought(2000, "planning");
	g.addCall("read"); // resolves the thought
	g.addCall("grep");
	g.addThought(300, "pending sub-second"); // unresolved, hidden in snapshot
	const snap = g.snapshot();
	// thought entry + the still-open group; pending sub-second thinking not shown.
	assert.equal(snap.length, 2);
	assert.equal(snap[0].kind, "thought");
	assert.deepEqual(groupCalls(snap[1]), ["read", "grep"]);
});

test("MIN_THOUGHT_MS is the 1s threshold", () => {
	assert.equal(MIN_THOUGHT_MS, 1000);
});

// ── Live thinking exposed in snapshot (ticket 23) ────────────────────────────────

test("snapshot exposes a suprathreshold live thinking span as a trailing thought entry", () => {
	const g = grouper();
	g.addCall("read");
	// A 1200ms in-progress span (>= 1s) closes the open group and appears after it.
	const snap = g.snapshot({ ms: 1200, text: "streaming plan\nnext step" });
	assert.equal(snap.length, 2);
	assert.deepEqual(groupCalls(snap[0]), ["read"]);
	assert.equal(snap[1].kind, "thought");
	assert.equal(thoughtMs(snap[1]), 1200);
});

test("snapshot hides a sub-threshold live thinking span (open group stays the live tail)", () => {
	const g = grouper();
	g.addCall("read");
	const snap = g.snapshot({ ms: 500, text: "brief" }); // < 1s → hidden
	assert.equal(snap.length, 1);
	assert.deepEqual(groupCalls(snap[0]), ["read"]);
});

test("a live span coalesces with prior ended spans to cross the threshold in snapshot", () => {
	const g = grouper();
	g.addCall("read");
	g.addThought(600, "first burst"); // ended, pending, sub-1s alone
	const snap = g.snapshot({ ms: 500, text: "still going" }); // 600 + 500 = 1100 ≥ 1s
	assert.equal(snap.length, 2);
	assert.equal(snap[1].kind, "thought");
	assert.equal(thoughtMs(snap[1]), 1100);
});

test("the live thought keeps a STABLE top-level index across close then commit", () => {
	const g = grouper();
	g.addCall("read");
	// While streaming: [group{read}, live thought] → thought at index 1.
	let snap = g.snapshot({ ms: 1500, text: "planning" });
	assert.equal(snap.length, 2);
	assert.equal(snap[1].kind, "thought");
	// thinking_end: span moves to pendingSpans; still shown at the SAME index 1.
	g.addThought(1500, "planning");
	snap = g.snapshot();
	assert.equal(snap.length, 2);
	assert.equal(snap[1].kind, "thought");
	// Next tool commits it; the thought is still index 1, no earlier entry shifts.
	g.addCall("bash");
	snap = g.snapshot();
	assert.equal(snap.length, 3);
	assert.deepEqual(groupCalls(snap[0]), ["read"]);
	assert.equal(snap[1].kind, "thought");
	assert.deepEqual(groupCalls(snap[2]), ["bash"]);
});

test("snapshot shows a suprathreshold ENDED-but-unresolved run as a settled trailing thought", () => {
	const g = grouper();
	g.addCall("read");
	g.addThought(1500, "reasoning"); // ended, unresolved, ≥ 1s
	const snap = g.snapshot(); // no live span
	assert.equal(snap.length, 2);
	assert.deepEqual(groupCalls(snap[0]), ["read"]);
	assert.equal(snap[1].kind, "thought");
	assert.equal(thoughtMs(snap[1]), 1500);
});

test("shouldTick is true while tools run OR a thinking span is active, false otherwise", () => {
	assert.equal(shouldTick(1, false), true); // tools running
	assert.equal(shouldTick(0, true), true); // thinking active
	assert.equal(shouldTick(2, true), true); // both
	assert.equal(shouldTick(0, false), false); // neither → teardown
});

test("finalize is idempotent after reset (duplicate settle is a no-op)", () => {
	const g = grouper();
	g.addCall("read");
	assert.equal(g.finalize().entries.length, 1);
	g.reset();
	assert.equal(g.finalize().entries.length, 0);
});

test("force-settle transition: an open group + a flushed open thinking span finalize in order (ticket 32)", () => {
	// Mirrors index.ts force-settle: at an abnormal end (stream error / abort) the
	// open thinking span is flushed via addThought (elapsed + partial text) BEFORE
	// finalize, so the interrupted card closes with the group then its trailing
	// thought in true event order.
	const g = grouper();
	g.addCall("grep");
	g.addCall("grep");
	// The stream died mid-thinking: no thinking_end fired, so the extension flushes
	// the in-progress span here (elapsed 3s, partial streamed text preserved).
	g.addThought(3000, "**Inspecting events controller and queue setup**");
	const { entries } = g.finalize();
	assert.equal(entries.length, 2);
	assert.deepEqual(groupCalls(entries[0]), ["grep", "grep"]);
	assert.equal(entries[1].kind, "thought");
	assert.equal(thoughtMs(entries[1]), 3000);
});

// ── Narration entries + finalAnswer popping (ticket 41) ─────────────────────────
// An intermediate assistant text block folds into the card as a "narration" entry
// in its chronological spot; the TRUE final answer (nothing follows it) is popped
// out of the sequence by finalize() and returned separately, never as a card row.

test("mid-response narration STAYS folded in place when a LATER narration exists to promote", () => {
	const g = grouper();
	g.addCall("read");
	g.textStart();
	g.textEnd("Checking the config next.");
	g.addCall("grep");
	g.textStart();
	g.textEnd("Found it in biome.json.");
	g.addCall("bash");
	// The LAST narration is promoted as the answer; the earlier one keeps its
	// chronological slot between the groups it separated.
	const { entries, finalAnswer, promoted } = g.finalize();
	assert.equal(entries.length, 4);
	assert.deepEqual(groupCalls(entries[0]), ["read"]);
	assert.equal(entries[1].kind, "narration");
	assert.equal(entries[1].kind === "narration" ? entries[1].text : undefined, "Checking the config next.");
	assert.deepEqual(groupCalls(entries[2]), ["grep"]);
	assert.deepEqual(groupCalls(entries[3]), ["bash"]);
	assert.equal(finalAnswer, "Found it in biome.json.");
	assert.equal(promoted, true);
});

test("promotion: a response ending on a THOUGHT promotes the last narration (Cursor trailing-thinking bug)", () => {
	const g = grouper();
	g.addCall("read");
	g.textStart();
	g.textEnd("Reinstall it: pi install npm:@tifan/pi-inline-skills.");
	g.addThought(2000, "Cursor web fetch: https://npmjs.com/..."); // dump AFTER the answer
	const { entries, finalAnswer, promoted } = g.finalize();
	assert.equal(finalAnswer, "Reinstall it: pi install npm:@tifan/pi-inline-skills.");
	assert.equal(promoted, true);
	assert.equal(entries.some((e) => e.kind === "narration"), false);
});

test("promotion: no narration at all \u21d2 no finalAnswer, no promoted flag (tool-only response)", () => {
	const g = grouper();
	g.addCall("read");
	g.addCall("bash");
	const { entries, finalAnswer, promoted } = g.finalize();
	assert.equal(entries.length, 1);
	assert.equal(finalAnswer, undefined);
	assert.equal(promoted, undefined);
});

test("promotion: a TRAILING narration still pops un-promoted (native text was never hidden)", () => {
	const g = grouper();
	g.addCall("read");
	g.textStart();
	g.textEnd("The answer.");
	const { finalAnswer, promoted } = g.finalize();
	assert.equal(finalAnswer, "The answer.");
	assert.equal(promoted, undefined);
});

test("a trailing text block with nothing after it is popped out as finalAnswer, not a card row", () => {
	const g = grouper();
	g.addCall("read");
	g.textStart();
	g.textEnd("Here is the summary you asked for.");
	const { entries, finalAnswer } = g.finalize();
	assert.equal(entries.length, 1); // only the group; the narration was popped
	assert.deepEqual(groupCalls(entries[0]), ["read"]);
	assert.equal(finalAnswer, "Here is the summary you asked for.");
});

test("a plain text-only response (no tools) has no card entries; the whole answer is finalAnswer", () => {
	const g = grouper();
	g.textStart();
	g.textEnd("Paris is the capital of France.");
	const { entries, finalAnswer } = g.finalize();
	assert.equal(entries.length, 0);
	assert.equal(finalAnswer, "Paris is the capital of France.");
});

test("two text blocks back to back with nothing between them: only the LAST is popped", () => {
	const g = grouper();
	g.addCall("read");
	g.textStart();
	g.textEnd("First paragraph, narration.");
	g.textStart();
	g.textEnd("Second paragraph, the real answer.");
	const { entries, finalAnswer } = g.finalize();
	assert.equal(entries.length, 2);
	assert.deepEqual(groupCalls(entries[0]), ["read"]);
	assert.equal(entries[1].kind, "narration");
	assert.equal(entries[1].kind === "narration" ? entries[1].text : undefined, "First paragraph, narration.");
	assert.equal(finalAnswer, "Second paragraph, the real answer.");
});

test("a response with no text at all has no narration entries and no finalAnswer (regression guard)", () => {
	const g = grouper();
	g.addCall("read");
	g.addCall("bash");
	const { entries, finalAnswer } = g.finalize();
	assert.equal(entries.length, 1);
	assert.deepEqual(groupCalls(entries[0]), ["read", "bash"]);
	assert.equal(finalAnswer, undefined);
});

test("a whitespace-only trailing text block records nothing and is not popped as finalAnswer", () => {
	const g = grouper();
	g.addCall("read");
	g.textStart();
	g.textEnd("   \n\t ");
	const { entries, finalAnswer } = g.finalize();
	assert.equal(entries.length, 1);
	assert.equal(finalAnswer, undefined);
});

test("a narration entry appears in snapshot immediately (live), not withheld until settle", () => {
	const g = grouper();
	g.addCall("read");
	g.textStart();
	g.textEnd("Reading config now.");
	const snap = g.snapshot();
	assert.equal(snap.length, 2);
	assert.deepEqual(groupCalls(snap[0]), ["read"]);
	assert.equal(snap[1].kind, "narration");
});

test("reset() discards a pending narration entry along with everything else", () => {
	const g = grouper();
	g.addCall("read");
	g.textStart();
	g.textEnd("Some narration.");
	g.reset();
	const { entries, finalAnswer } = g.finalize();
	assert.equal(entries.length, 0);
	assert.equal(finalAnswer, undefined);
});
