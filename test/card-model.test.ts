/**
 * Headless tests for the card model + persistence policy (src/card-model.ts).
 * Runs via Node's built-in
 * TypeScript type-stripping (Node >= 23.6), no TUI:
 * `node --test test/card-model.test.ts` (see package.json `test`). These lock:
 *   - suppressThinkingMarkdown: the pure decision behind the markdown
 *     transformer src/index.ts registers,
 *   - staleCardShapeModel: a persisted snapshot always renders SETTLED, with
 *     an unknown duration when it was saved mid-response,
 *   - shouldReappendCard: whether a settled card must be re-appended after a
 *     compaction drops its source entry from the rebuilt transcript.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type PersistedCardData, shouldReappendCard, staleCardShapeModel, suppressThinkingMarkdown } from "../src/card-model.ts";
import { type CardEntry, type CardExpansion, type CardShapeModel, shapeCard, type ShapeGroup, type ShapeItem } from "../src/card-shape.ts";

const SPIN = "◍"; // fixed spinner frame so assertions are deterministic

/** Plain text of one shaped line: indent spaces + concatenated segment text. */
function line(shaped: { indent: number; segments: { text: string }[] }): string {
	return " ".repeat(shaped.indent) + shaped.segments.map((s) => s.text).join("");
}

/** Expansion state: default view (members hidden) unless overridden. */
function exp(overrides: Partial<CardExpansion> = {}): CardExpansion {
	return { fullCollapsed: false, isMembersVisible: () => false, ...overrides };
}

/** Render a whole card to an array of plain-text lines. */
function render(model: CardShapeModel, expansion: CardExpansion = exp(), spinner = SPIN): string[] {
	return shapeCard(model, expansion, spinner).lines.map(line);
}

function item(overrides: Partial<ShapeItem> = {}): ShapeItem {
	return { label: "Read a.ts", durMs: 400, isError: false, running: false, preview: [], glyph: "▤", ...overrides };
}

function group(overrides: Partial<ShapeGroup> = {}): ShapeGroup {
	return { label: "", counts: "", items: [], ...overrides };
}

/** Wrap a group as a top-level card entry. */
const ge = (g: ShapeGroup): CardEntry => ({ kind: "group", group: g });

// A reusable two-command group (matches the fixture in card-shape.test.ts).
const cmds = group({
	label: "Ran commands",
	counts: "2 commands",
	items: [
		item({ label: "Ran npm", durMs: 2100, glyph: "$" }),
		item({ label: "Ran git status", durMs: 300, glyph: "$", preview: [" M src/index.ts", "?? t.ts"] }),
	],
});

// ── Native thinking suppression ─────────────────────────────────────────────────
// suppressThinkingMarkdown is the pure decision behind the markdown transformer
// src/index.ts registers. Locking it here guards that lever: returning
// "" for "assistant-thinking" is what makes pi's Markdown render ZERO lines for
// the native thinking body (verified against pi-tui markdown.js — a transformed
// text that trims to empty early-returns []). Everything else must pass through
// byte-for-byte so real answer/user markdown is never altered.
test("suppressThinkingMarkdown blanks assistant-thinking to a zero-line-rendering empty string", () => {
	const blanked = suppressThinkingMarkdown("**Planning the approach**\nstep two", "assistant-thinking");
	assert.equal(blanked, "");
	// pi's Markdown.render early-returns [] iff the transformed text trims to empty;
	// "" satisfies that (the whole point of lever 1), so assert the trim contract.
	assert.equal(blanked.trim(), "");
});

test("suppressThinkingMarkdown passes non-thinking markdown through byte-for-byte", () => {
	const answer = "Here is the **final** answer.\n\n- a\n- b";
	assert.equal(suppressThinkingMarkdown(answer, "assistant"), answer);
	assert.equal(suppressThinkingMarkdown(answer, "user"), answer);
	// An unknown/empty message type is treated as non-thinking (never blanked).
	assert.equal(suppressThinkingMarkdown(answer, ""), answer);
	// Empty thinking stays empty (already renders nothing); no crash on empty input.
	assert.equal(suppressThinkingMarkdown("", "assistant-thinking"), "");
});

// ── Compaction survival + stale-snapshot shaping ────────────────────────────────
// The card model is stored by reference on the appended session entry but its data
// is serialized ONCE at append time (session-manager _persist), so a card appended
// EARLY (live, empty) leaves a stale {live:true, workedMs:0, entries:[]} line on
// disk that a plain /resume renders. staleCardShapeModel renders that snapshot as
// SETTLED and never a ticking ghost; shouldReappendCard decides whether a compaction
// (which drops entries before firstKeptEntryId from the rebuilt chat) requires a
// fresh card so the response stays visible.

test("staleCardShapeModel renders a mid-response snapshot settled with an unknown duration", () => {
	// The exact stale line: appended live, never re-serialized.
	const data: PersistedCardData = { live: true, workedMs: 0, failures: 0, entries: [] };
	const shaped = staleCardShapeModel(data);
	assert.equal(shaped.live, false); // never a ticking ghost
	assert.equal(shaped.unknownDuration, true); // "Worked for —"
	assert.deepEqual(render(shaped), ["Worked for — ▾"]);
});

test("staleCardShapeModel keeps a genuinely settled snapshot's duration and entries", () => {
	const data: PersistedCardData = { live: false, workedMs: 39000, failures: 2, entries: [ge(cmds)] };
	const shaped = staleCardShapeModel(data);
	assert.equal(shaped.live, false);
	assert.equal(shaped.unknownDuration, false); // real workedMs → no "—"
	assert.equal(shaped.failures, 2);
	assert.deepEqual(render(shaped), ["Worked for 39s · 2 failed ▾", "  • Ran commands · 2 commands ▸"]);
});

test("staleCardShapeModel treats a live snapshot that DID record time as settled (not a ghost)", () => {
	// Defensive: a live snapshot with a non-zero workedMs is still rendered settled
	// (live:false) — the resume has no timer, so a "⟳ Working" header would freeze.
	const shaped = staleCardShapeModel({ live: true, workedMs: 5000, entries: [] });
	assert.equal(shaped.live, false);
	assert.equal(shaped.unknownDuration, false);
	assert.equal(render(shaped)[0], "Worked for 5s ▾");
});

test("staleCardShapeModel tolerates a malformed snapshot (missing/!array fields)", () => {
	const shaped = staleCardShapeModel({} as PersistedCardData);
	assert.equal(shaped.live, false);
	assert.equal(shaped.unknownDuration, false); // workedMs defaults 0 but live is falsy
	assert.deepEqual(shaped.entries, []);
	assert.deepEqual(render(shaped), ["Worked for 0s ▾"]);
});

test("shouldReappendCard re-appends only a DROPPED, not-yet-reappended card", () => {
	// Dropped by compaction (id absent from the kept context) and untouched → re-append.
	assert.equal(
		shouldReappendCard({ lastCardEntryId: "card1", survivingEntryIds: ["comp", "kept1"], alreadyReappended: false }),
		true,
	);
	// Survived the compaction (still in the kept context) → do NOT re-append.
	assert.equal(
		shouldReappendCard({ lastCardEntryId: "card1", survivingEntryIds: ["comp", "card1", "kept1"], alreadyReappended: false }),
		false,
	);
	// Already re-appended once → never a second card for the same response (dedup).
	assert.equal(
		shouldReappendCard({ lastCardEntryId: "card1", survivingEntryIds: ["comp"], alreadyReappended: true }),
		false,
	);
	// No card was ever appended → nothing to survive.
	assert.equal(
		shouldReappendCard({ lastCardEntryId: undefined, survivingEntryIds: [], alreadyReappended: false }),
		false,
	);
});

// ── Interrupted marker survives a resume ───────────────────────────────────────

test("staleCardShapeModel propagates interrupted so a resumed interrupted card keeps the marker", () => {
	// Registry/compaction survival applies to interrupted cards.
	const data: PersistedCardData = { live: false, workedMs: 39000, failures: 0, entries: [], interrupted: true };
	const shaped = staleCardShapeModel(data);
	assert.equal(shaped.interrupted, true);
	assert.equal(render(shaped)[0], "Worked for 39s · interrupted ▾");
	// A non-interrupted snapshot never gains the marker.
	assert.equal(staleCardShapeModel({ live: false, workedMs: 1000, entries: [] }).interrupted, false);
});
