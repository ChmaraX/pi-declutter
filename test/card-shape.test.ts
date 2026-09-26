/**
 * Headless render-shape tests for the pure activity-card shaping.
 *
 * Runs via Node's built-in TypeScript type-stripping (Node >= 23.6), no TUI:
 * `node --test test/card-shape.test.ts` (see package.json `test`). These lock
 * the behaviours without a live terminal:
 *   - the card renders in its FINAL shape from the first tool and grows in place
 *     (live vs settled differ only in the header and running-row glyph),
 *   - the card is an ordered TOP-LEVEL sequence of Group and Thought entries in
 *     event order: thinking sits BETWEEN groups, not inside them,
 *   - per-node expansion: full-collapse / default / all-expanded,
 *     per-group members, per-member output box, per-thought "Thinking" box,
 *   - shapeCard returns a parallel row-map (line index → node id) for the mouse,
 *   - singleton groups render as the member row directly,
 *   - failures stay calm: no auto-expand, the row keeps its family
 *     glyph (no red ✗), and every failed call has a box carrying the badge,
 *   - output previews are trimmed to the last N lines and truncated.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	boxTail,
	type CardEntry,
	type CardExpansion,
	type CardShapeModel,
	coalesceThoughts,
	deriveThoughtSummary,
	expandRowMapToVisual,
	groupHasMembersToggle,
	groupNodeId,
	HEADER_NODE,
	hoveredNodeAt,
	itemBadge,
	itemHasBox,
	MAX_PREVIEW_LINE_LEN,
	MAX_THOUGHT_SUMMARY_LEN,
	memberNodeId,
	narrationNodeId,
	narrationTexts,
	parseNodeId,
	previewLines,
	type ShapeGroup,
	type ShapeItem,
	type ShapeNarration,
	type ShapeThought,
	shapeCard,
	SPINNER_FRAMES,
	SPINNER_INTERVAL_MS,
	spinnerFrame,
	thoughtHasBox,
	thoughtNodeId,
	toolGlyph,
} from "../src/card-shape.ts";

const SPIN = "◍"; // fixed spinner frame so assertions are deterministic

/** Plain text of one shaped line: indent spaces + concatenated segment text. */
function line(shaped: { indent: number; segments: { text: string }[] }): string {
	return " ".repeat(shaped.indent) + shaped.segments.map((s) => s.text).join("");
}

/** Expansion state: default view (members hidden) unless overridden. There are
 * no inline boxes (rows open a modal), so the only tree state is per-group
 * member visibility. */
function exp(overrides: Partial<CardExpansion> = {}): CardExpansion {
	return { fullCollapsed: false, isMembersVisible: () => false, ...overrides };
}

/** Full-collapse: only the header. */
const COLLAPSED = exp({ fullCollapsed: true });
/** All-expanded: every group's members open (there are no inline boxes now). */
const ALL_OPEN = exp({ isMembersVisible: () => true });

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

function thought(overrides: Partial<ShapeThought> = {}): ShapeThought {
	return { ms: 0, summary: "", tail: [], ...overrides };
}

function narration(overrides: Partial<ShapeNarration> = {}): ShapeNarration {
	return { text: "", summary: "", ...overrides };
}

/** Wrap a group / thought / narration as a top-level card entry. */
const ge = (g: ShapeGroup): CardEntry => ({ kind: "group", group: g });
const te = (t: ShapeThought): CardEntry => ({ kind: "thought", thought: t });
const ne = (n: ShapeNarration): CardEntry => ({ kind: "narration", narration: n });

function model(overrides: Partial<CardShapeModel> = {}): CardShapeModel {
	return { live: false, elapsedMs: 39000, failures: 0, entries: [], ...overrides };
}

// A reusable two-command group.
const cmds = group({
	label: "Ran commands",
	counts: "2 commands",
	items: [
		item({ label: "Ran npm", durMs: 2100, glyph: "$" }),
		item({ label: "Ran git status", durMs: 300, glyph: "$", preview: [" M src/index.ts", "?? t.ts"] }),
	],
});

// ── Header (chevron at the end) ─────────────────────────────────────────────────

test("live header shows the animated spinner frame + 'Working · Xs ▾', settled is 'Worked for Xs ▾', collapsed '▸'", () => {
	const live = model({ live: true, elapsedMs: 12000 });
	// The header uses the passed spinner frame, not a static glyph.
	assert.equal(render(live)[0], `${SPIN} Working · 12s ▾`);

	const settled = model({ elapsedMs: 39000 });
	assert.equal(render(settled)[0], "Worked for 39s ▾");
	assert.equal(render(settled, COLLAPSED)[0], "Worked for 39s ▸");
});

test("failure count is appended to the header before the chevron", () => {
	const m = model({ failures: 2, entries: [ge(group({ items: [item({ isError: true })] }))] });
	assert.equal(render(m)[0], "Worked for 39s · 2 failed ▾");
});

// ── Spinner frame derivation ───────────────────────────────────────────────────
test("spinnerFrame advances one pi frame every SPINNER_INTERVAL_MS and cycles", () => {
	// Frame 0 at t=0, still frame 0 just before the interval, frame 1 at the interval.
	assert.equal(spinnerFrame(0), SPINNER_FRAMES[0]);
	assert.equal(spinnerFrame(SPINNER_INTERVAL_MS - 1), SPINNER_FRAMES[0]);
	assert.equal(spinnerFrame(SPINNER_INTERVAL_MS), SPINNER_FRAMES[1]);
	assert.equal(spinnerFrame(5 * SPINNER_INTERVAL_MS), SPINNER_FRAMES[5]);
	// Wraps after the last frame.
	const n = SPINNER_FRAMES.length;
	assert.equal(spinnerFrame(n * SPINNER_INTERVAL_MS), SPINNER_FRAMES[0]);
	assert.equal(spinnerFrame((n + 3) * SPINNER_INTERVAL_MS), SPINNER_FRAMES[3]);
});

test("SPINNER_FRAMES are pi's ten single-cell braille frames (row width never shifts)", () => {
	assert.equal(SPINNER_FRAMES.length, 10);
	// Every frame is exactly one code point, so frame-to-frame swaps keep the header
	// and running-row line widths identical (row-map stays aligned).
	for (const f of SPINNER_FRAMES) assert.equal([...f].length, 1);
});

// ── Three card states ────────────────────────────────────────────────────────────

test("full-collapse shows only the header", () => {
	const m = model({ entries: [ge(cmds)] });
	assert.deepEqual(render(m, COLLAPSED), ["Worked for 39s ▸"]);
});

test("default shows the group row only (members hidden), chevron closed", () => {
	const m = model({ entries: [ge(cmds)] });
	assert.deepEqual(render(m, exp()), ["Worked for 39s ▾", "  • Ran commands · 2 commands ▸"]);
});

test("all-expanded shows members; a member with output gets the openable chevron (no inline box)", () => {
	const m = model({ entries: [ge(cmds)] });
	assert.deepEqual(render(m, ALL_OPEN), [
		"Worked for 39s ▾",
		"  • Ran commands · 2 commands ▾",
		"    $ Ran npm (2.1s)",
		"    $ Ran git status (0.3s) ▸",
	]);
	// No inline box drawing is ever emitted now.
	assert.ok(!render(m, ALL_OPEN).some((l) => l.includes("┌") || l.includes("Success")));
});

// ── Per-node expansion (independent toggles) ─────────────────────────────────────

test("one group's members expand independently of its sibling", () => {
	const reads = group({ label: "Read files", counts: "2 files", items: [item({ label: "Read a.ts" }), item({ label: "Read b.ts" })] });
	const m = model({ entries: [ge(reads), ge(cmds)] });
	// Only entry 1's members visible.
	const onlySecond = exp({ isMembersVisible: (k) => k === 1 });
	assert.deepEqual(render(m, onlySecond), [
		"Worked for 39s ▾",
		"  • Read files · 2 files ▸",
		"  • Ran commands · 2 commands ▾",
		"    $ Ran npm (2.1s)",
		"    $ Ran git status (0.3s) ▸",
	]);
});

test("an expanded group shows member rows; a member with output carries the openable chevron", () => {
	const m = model({ entries: [ge(cmds)] });
	const membersOnly = exp({ isMembersVisible: () => true });
	assert.deepEqual(render(m, membersOnly), [
		"Worked for 39s ▾",
		"  • Ran commands · 2 commands ▾",
		"    $ Ran npm (2.1s)",
		"    $ Ran git status (0.3s) ▸",
	]);
});

test("only a member with output gets a chevron", () => {
	const m = model({ entries: [ge(cmds)] });
	const lines = shapeCard(m, exp({ isMembersVisible: () => true }), SPIN).lines;
	assert.equal(line(lines[2]), "    $ Ran npm (2.1s)");
	assert.ok(line(lines[3]).endsWith(" ▸"));
});

// ── Singleton groups render as the member row directly ──────────────────────────

test("default singleton group shows one member row; box chevron only with output", () => {
	const noOutput = model({ entries: [ge(group({ label: "Read a.ts", items: [item({ label: "Read a.ts" })] }))] });
	assert.deepEqual(render(noOutput), ["Worked for 39s ▾", "  ▤ Read a.ts (0.4s)"]);

	const withOutput = model({ entries: [ge(group({ items: [item({ label: "Ran ls", glyph: "≡", durMs: 100, preview: ["a.ts", "b.ts"] })] }))] });
	// The singleton member with output shows the openable chevron; clicking opens
	// the modal — no inline box ever renders.
	assert.deepEqual(render(withOutput), ["Worked for 39s ▾", "  ≡ Ran ls (0.1s) ▸"]);
	assert.ok(!render(withOutput, ALL_OPEN).some((l) => l.includes("┌")));
});

// ── Ordered top-level flow: thought / group interleave ───────────────────────────

test("thought and group entries render in event order at the top level", () => {
	// think → 2 commands → think → singleton.
	const make = group({ items: [item({ label: "Ran make test", glyph: "$", durMs: 4000, command: "make test" })] });
	const m = model({
		elapsedMs: 42000,
		entries: [
			te(thought({ ms: 4000, summary: "planning approach" })),
			ge(cmds),
			te(thought({ ms: 2000, summary: "checking output" })),
			ge(make),
		],
	});
	assert.deepEqual(render(m, exp()), [
		"Worked for 42s ▾",
		"  · Thought 4s · planning approach",
		"  • Ran commands · 2 commands ▸",
		"  · Thought 2s · checking output",
		"  $ Ran make test (4.0s) ▸",
	]);
});

test("thought text never appears at the collapsed group level", () => {
	// The thought entry precedes the group; collapsing the card hides everything.
	const m = model({ entries: [te(thought({ ms: 3000, summary: "secret plan", tail: ["secret plan"] })), ge(cmds)] });
	assert.ok(!render(m, COLLAPSED).some((l) => l.includes("secret plan")));
	// The default view shows the thought ROW but the group row carries no thought text.
	const def = render(m, exp());
	assert.ok(def.some((l) => l.includes("· Thought 3s · secret plan")));
	assert.equal(def[2], "  • Ran commands · 2 commands ▸");
});

// ── Row-map: line index → node id (mouse mapping) ────────────────────────────────

test("row-map pairs each line with its top-level node (one line per row)", () => {
	const reads = group({ label: "Read files", counts: "2 files", items: [item({ label: "Read a.ts" }), item({ label: "Read b.ts" })] });
	const m = model({ entries: [ge(reads), ge(cmds)] });
	// Both groups' members visible. No inline boxes, so each node is exactly one row.
	const expansion = exp({ isMembersVisible: () => true });
	const shaped = shapeCard(m, expansion, SPIN);
	assert.equal(shaped.lines.length, shaped.rowMap.length);
	assert.deepEqual(shaped.rowMap, [
		HEADER_NODE, // header
		groupNodeId(0), // Read files group row
		memberNodeId(0, 0), // Read a.ts
		memberNodeId(0, 1), // Read b.ts
		groupNodeId(1), // Ran commands group row
		memberNodeId(1, 0), // Ran npm
		memberNodeId(1, 1), // Ran git status (openable → modal)
	]);
});

test("a thought entry between groups maps to its thought node (one row)", () => {
	const m = model({
		entries: [ge(cmds), te(thought({ ms: 2000, summary: "why", tail: ["why", "because"] })), ge(cmds)],
	});
	const shaped = shapeCard(m, exp(), SPIN);
	// header, g0 row, t1 row (openable → modal, no inline box), g2 row.
	assert.deepEqual(shaped.rowMap, [
		HEADER_NODE,
		groupNodeId(0),
		thoughtNodeId(1),
		groupNodeId(2),
	]);
});

test("full-collapse row-map is the header only", () => {
	const m = model({ entries: [ge(cmds)] });
	assert.deepEqual(shapeCard(m, COLLAPSED, SPIN).rowMap, [HEADER_NODE]);
});

test("singleton group row maps to its member node (one row)", () => {
	const m = model({ entries: [ge(group({ items: [item({ label: "Ran ls", glyph: "≡", preview: ["x"] })] }))] });
	const shaped = shapeCard(m, exp(), SPIN);
	assert.deepEqual(shaped.rowMap, [HEADER_NODE, memberNodeId(0, 0)]);
});

test("expandRowMapToVisual repeats each node id once per wrapped visual row", () => {
	const m = model({ entries: [ge(cmds)] });
	const expansion = exp({ isMembersVisible: () => true });
	const shaped = shapeCard(m, expansion, SPIN);
	// rowMap = [header, group(0), member(0,0), member(0,1)]. Simulate the last
	// member row (index 3) wrapping to 3 visual rows on a narrow terminal.
	const wrapIdx = 3;
	const heights = shaped.rowMap.map((_, i) => (i === wrapIdx ? 3 : 1));
	const visual = expandRowMapToVisual(shaped.rowMap, heights);
	assert.equal(visual.length, shaped.rowMap.length + 2); // +2 extra rows for the wrap
	assert.equal(visual[wrapIdx], shaped.rowMap[wrapIdx]);
	assert.equal(visual[wrapIdx + 1], shaped.rowMap[wrapIdx]);
	assert.equal(visual[wrapIdx + 2], shaped.rowMap[wrapIdx]);
	assert.deepEqual(visual.slice(0, wrapIdx), shaped.rowMap.slice(0, wrapIdx)); // rows above unchanged
});

test("expandRowMapToVisual drops a 0-height (empty) line, matching the Box", () => {
	const visual = expandRowMapToVisual(["a", "b", "c"], [1, 0, 2]);
	assert.deepEqual(visual, ["a", "c", "c"]);
});

test("parseNodeId inverts the node-id helpers", () => {
	assert.deepEqual(parseNodeId(HEADER_NODE), { kind: "header" });
	assert.deepEqual(parseNodeId(groupNodeId(3)), { kind: "group", entryIndex: 3 });
	assert.deepEqual(parseNodeId(memberNodeId(2, 5)), { kind: "member", entryIndex: 2, itemIndex: 5 });
	assert.deepEqual(parseNodeId(thoughtNodeId(4)), { kind: "thought", entryIndex: 4 });
	assert.deepEqual(parseNodeId(narrationNodeId(7)), { kind: "narration", entryIndex: 7 });
	// Unknown ids resolve to the inert header.
	assert.deepEqual(parseNodeId("nonsense"), { kind: "header" });
});

test("thoughtNodeId, groupNodeId, and narrationNodeId never collide at the same top-level index", () => {
	assert.notEqual(thoughtNodeId(2), groupNodeId(2));
	assert.notEqual(narrationNodeId(2), groupNodeId(2));
	assert.notEqual(narrationNodeId(2), thoughtNodeId(2));
	assert.deepEqual(parseNodeId(thoughtNodeId(2)), { kind: "thought", entryIndex: 2 });
	assert.deepEqual(parseNodeId(groupNodeId(2)), { kind: "group", entryIndex: 2 });
	assert.deepEqual(parseNodeId(narrationNodeId(2)), { kind: "narration", entryIndex: 2 });
});

// ── Live parity: same tree live and settled, only header + spinner differ ────────

test("live and settled default trees match except the header and running glyph", () => {
	const base = group({
		label: "Read files, ran commands",
		counts: "1 file, 1 command",
		items: [item({ label: "Read a.ts" }), item({ label: "Ran npm", durMs: 900 })],
	});
	const live = model({
		live: true,
		elapsedMs: 5000,
		entries: [ge({ ...base, items: [base.items[0], { ...base.items[1], running: true }] })],
	});
	const settled = model({ elapsedMs: 5000, entries: [ge(base)] });

	const liveLines = render(live);
	const settledLines = render(settled);
	assert.equal(liveLines.length, 2);
	assert.equal(settledLines.length, 2);
	assert.equal(liveLines[1], `  ${SPIN} Read files, ran commands · 1 file, 1 command ▸`);
	assert.equal(settledLines[1], "  • Read files, ran commands · 1 file, 1 command ▸");
});

test("live members appear and a running member shows the spinner, no duration", () => {
	const m = model({
		live: true,
		elapsedMs: 3000,
		entries: [ge(group({ label: "Ran commands", counts: "2 commands", items: [item({ label: "Read a.ts" }), item({ label: "Ran npm", running: true })] }))],
	});
	const lines = render(m, ALL_OPEN);
	assert.equal(lines.at(-1), `    ${SPIN} Ran npm`);
});

test("a currently-running singleton shows the spinner in the default row", () => {
	const m = model({ live: true, elapsedMs: 2000, entries: [ge(group({ items: [item({ running: true })] }))] });
	assert.deepEqual(render(m), [`${SPIN} Working · 2s`, `  ${SPIN} Read a.ts`].map((l, i) => (i === 0 ? `${l} ▾` : l)));
});

// ── Thought entries: row, summary, expandable box ────────────────────────────────

test("a bare thought entry (no captured text) has no chevron and no box", () => {
	const m = model({ entries: [te(thought({ ms: 4000 }))] });
	const shaped = shapeCard(m, exp(), SPIN);
	assert.equal(line(shaped.lines[1]), "  · Thought 4s"); // no summary, no chevron
	assert.equal(shaped.rowMap[1], thoughtNodeId(0));
	// A text-less thought is not openable and never renders any box.
	assert.ok(!render(m).some((l) => l.includes("┌ Thinking")));
});

test("deriveThoughtSummary takes the first meaningful line, stripped and truncated", () => {
	assert.equal(deriveThoughtSummary("**Comparing LRU cache data structures**"), "Comparing LRU cache data structures");
	assert.equal(deriveThoughtSummary("\n\n## Plan\nrest"), "Plan");
	assert.equal(deriveThoughtSummary("- do the thing\nmore"), "do the thing");
	assert.equal(deriveThoughtSummary("   \n\t"), "");
	const long = deriveThoughtSummary("x".repeat(200));
	assert.equal([...long].length, MAX_THOUGHT_SUMMARY_LEN);
	assert.ok(long.endsWith("…"));
});

test("coalesceThoughts sums durations and keeps the LAST >=1s span's summary + tail", () => {
	const out = coalesceThoughts([
		{ ms: 200, text: "tiny sub-second span" }, // dropped from summary (sub-1s)
		{ ms: 1500, text: "First real thought\nbody a" },
		{ ms: 3000, text: "Second real thought\nline1\nline2" },
	]);
	assert.equal(out.ms, 4700); // all durations summed
	assert.equal(out.summary, "Second real thought"); // last >=1s span wins
	assert.deepEqual(out.tail, ["Second real thought", "line1", "line2"]);
	// fullText carries EVERY span in stream order (otherwise multi-span
	// providers — Cursor — would lose all but the last span from the modal); the
	// summary/tail glance view stays chosen-span.
	assert.equal(out.fullText, "tiny sub-second span\n\nFirst real thought\nbody a\n\nSecond real thought\nline1\nline2");
});

test("coalesceThoughts.fullText is UNTRUNCATED while .tail stays previewLines-capped", () => {
	// One line far longer than MAX_PREVIEW_LINE_LEN (120), and more real lines than
	// MAX_THOUGHT_TAIL (10) — .tail must still cap/truncate for the compact card-row
	// glance; .fullText must carry every character and every line untouched.
	const longLine = "x".repeat(300);
	const manyLines = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
	const text = `${longLine}\n${manyLines}`;
	const out = coalesceThoughts([{ ms: 2000, text }]);
	// tail: capped to MAX_THOUGHT_TAIL (10) lines, each end-truncated with an ellipsis
	// when over MAX_PREVIEW_LINE_LEN.
	assert.equal(out.tail.length, 10);
	assert.ok(out.tail[0].length <= 120);
	assert.ok(out.tail.some((line) => line.endsWith("\u2026")) || out.tail[0].length < longLine.length);
	// fullText: every line, every character, no ellipsis, no cap.
	assert.equal(out.fullText, text);
	assert.equal(out.fullText.split("\n").length, 16); // longLine + 15 "line N" rows
	assert.ok(!out.fullText.includes("\u2026"));
});

test("coalesceThoughts with only sub-second or text-less spans yields ms but no summary/tail", () => {
	const subSecond = coalesceThoughts([{ ms: 400, text: "skip" }, { ms: 300, text: "skip" }]);
	assert.equal(subSecond.ms, 700);
	assert.equal(subSecond.summary, "");
	assert.deepEqual(subSecond.tail, []);
	const noText = coalesceThoughts([{ ms: 2000, text: "" }]);
	assert.equal(noText.summary, "");
	assert.deepEqual(noText.tail, []);
});

test("a settled thought with a captured tail shows '· Thought Ns · <summary> ▸' (openable, no inline box)", () => {
	const t = thought({ ms: 3000, summary: "Weighing the options", tail: ["Weighing the options", "a vs b"] });
	const m = model({ entries: [te(t)] });
	// Row shows summary + a closed (openable) chevron; clicking opens the modal.
	const shaped = shapeCard(m, exp(), SPIN);
	assert.equal(line(shaped.lines[1]), "  · Thought 3s · Weighing the options ▸");
	assert.equal(shaped.rowMap[1], thoughtNodeId(0));
	// The tail text is NEVER rendered inline (it lives in the modal).
	assert.ok(!render(m).some((l) => l.includes("a vs b")));
	assert.ok(!shaped.lines.some((l) => l.kind === "preview"));
	assert.ok(!render(m).some((l) => l.includes("┌ Thinking")));
});

// ── Narration entries: intermediate assistant text folded into the
// card in its chronological spot, always clickable (a modal shows the full text) ──

test("a narration entry shows '› <summary> ▸' and is always openable", () => {
	const n = narration({ text: "Checking the config file next, then re-running the tests.", summary: "Checking the config file next…" });
	const m = model({ entries: [ne(n)] });
	const shaped = shapeCard(m, exp(), SPIN);
	assert.equal(line(shaped.lines[1]), "  › Checking the config file next… ▸");
	assert.equal(shaped.rowMap[1], narrationNodeId(0));
	assert.equal(shaped.lines[1].kind, "narration");
	// Never rendered as an inline box; the full text lives in the modal.
	assert.ok(!render(m).some((l) => l.includes("Checking the config file next, then")));
});

test("narration entries sit between the groups they separated, in event order", () => {
	const read = group({ label: "Read files", items: [item({ label: "Read a.ts" })] });
	const grep = group({ label: "Searched", items: [item({ label: "Searched for TODO", glyph: "⌕" })] });
	const n = narration({ summary: "Now checking for TODOs." });
	const m = model({ entries: [ge(read), ne(n), ge(grep)] });
	const lines = render(m);
	// header, read row, narration row, grep row.
	assert.equal(lines.length, 4);
	assert.ok(lines[1].includes("Read a.ts"));
	assert.ok(lines[2].includes("Now checking for TODOs."));
	assert.ok(lines[3].includes("Searched for TODO"));
	const shaped = shapeCard(m, exp(), SPIN);
	assert.equal(shaped.rowMap[2], narrationNodeId(1)); // top-level index 1
});

test("narrationTexts collects every narration entry's full text, in order, skipping other kinds", () => {
	const entries: CardEntry[] = [
		ge(group({ label: "Read files" })),
		ne(narration({ text: "First note.", summary: "First note." })),
		te(thought({ ms: 2000, summary: "planning" })),
		ne(narration({ text: "Second note.", summary: "Second note." })),
	];
	assert.deepEqual(narrationTexts(entries), ["First note.", "Second note."]);
});

test("narrationTexts returns [] when there is no narration", () => {
	assert.deepEqual(narrationTexts([ge(group()), te(thought())]), []);
	assert.deepEqual(narrationTexts([]), []);
});

// ── Live thinking entry: spinner row, in-place transform, live tail ──

test("a live thought entry renders '⟳ Thinking… · Xs ▸' with the spinner mark", () => {
	// A live entry shows the spinner + "Thinking…" and NOT the (still-forming) summary.
	const t = thought({ ms: 3000, live: true, summary: "ignored while live", tail: ["streaming"] });
	const m = model({ live: true, elapsedMs: 5000, entries: [te(t)] });
	const shaped = shapeCard(m, exp(), SPIN);
	assert.equal(line(shaped.lines[1]), `  ${SPIN} Thinking… · 3s`);
	assert.equal(shaped.rowMap[1], thoughtNodeId(0));
	// Its accent-toned spinner mark matches a running tool/group row.
	assert.equal(shaped.lines[1].segments[0].tone, "accent");
	assert.equal(shaped.lines[1].segments[0].text, SPIN);
});

test("a live thought transforms in place to the settled row: same node id, stable lines-before", () => {
	// Same preceding entry (a settled group) + a thought that is live, then settled.
	const liveT = thought({ ms: 3000, live: true, summary: "Weighing options", tail: ["a"] });
	const settledT = thought({ ms: 3000, summary: "Weighing options", tail: ["a"] });
	const liveModel = model({ live: true, elapsedMs: 6000, entries: [ge(cmds), te(liveT)] });
	const settledModel = model({ elapsedMs: 6000, entries: [ge(cmds), te(settledT)] });
	const liveShaped = shapeCard(liveModel, exp(), SPIN);
	const settledShaped = shapeCard(settledModel, exp(), SPIN);
	// The thought row lands at the SAME line index in both (stable lines-before) …
	const liveIdx = liveShaped.rowMap.indexOf(thoughtNodeId(1));
	const settledIdx = settledShaped.rowMap.indexOf(thoughtNodeId(1));
	assert.equal(liveIdx, settledIdx);
	assert.ok(liveIdx > 0);
	// … and carries the SAME node id, so the expansion state survives the transform.
	assert.equal(liveShaped.rowMap[liveIdx], thoughtNodeId(1));
	assert.equal(settledShaped.rowMap[settledIdx], thoughtNodeId(1));
	// Only the row text/mark change (no layout jump beyond the row itself).
	assert.equal(line(liveShaped.lines[liveIdx]), `  ${SPIN} Thinking… · 3s`);
	assert.equal(line(settledShaped.lines[settledIdx]), "  · Thought 3s · Weighing options ▸");
	// The rows BETWEEN the header and the thought are identical (the header word
	// legitimately changes live→settled; everything else is stable).
	assert.deepEqual(liveShaped.lines.slice(1, liveIdx).map(line), settledShaped.lines.slice(1, settledIdx).map(line));
});

test("a live thought never renders an inline box or an openable chevron (modal opens on the settled row)", () => {
	const t = thought({ ms: 2000, live: true, tail: ["reasoning so far", "next step"] });
	const m = model({ live: true, elapsedMs: 4000, entries: [te(t)] });
	const shaped = shapeCard(m, exp(), SPIN);
	// Live row shows spinner + "Thinking…", NO chevron (no stable box while streaming).
	assert.equal(line(shaped.lines[1]), `  ${SPIN} Thinking… · 2s`);
	assert.ok(!shaped.lines.some((l) => l.kind === "preview"));
	assert.ok(!render(m).some((l) => l.includes("reasoning so far") || l.includes("┌ Thinking")));
});

test("a live thought with no captured text yet has no chevron and no box", () => {
	const m = model({ live: true, elapsedMs: 3000, entries: [te(thought({ ms: 1200, live: true }))] });
	const shaped = shapeCard(m, exp(), SPIN);
	assert.equal(line(shaped.lines[1]), `  ${SPIN} Thinking… · 1s`); // no chevron
	assert.ok(!render(m).some((l) => l.includes("┌ Thinking")));
});

test("thoughtHasBox is true only when the thought has a captured tail", () => {
	assert.equal(thoughtHasBox(thought({ ms: 2000, tail: ["a"] })), true);
	assert.equal(thoughtHasBox(thought({ ms: 2000, tail: [] })), false);
});

test("groupHasMembersToggle is true only for multi-tool groups", () => {
	assert.equal(groupHasMembersToggle(group({ items: [item(), item()] })), true);
	assert.equal(groupHasMembersToggle(group({ items: [item()] })), false);
});

// ── Output preview ──────────────────────────────────────────────────────────────

test("output is NEVER rendered inline; the row is openable", () => {
	const m = model({ entries: [ge(group({ items: [item({ label: "Ran git", glyph: "$", durMs: 500, preview: ["line1", "line2"] })] }))] });
	assert.ok(!render(m).some((l) => l.includes("line1")));
	const shaped = shapeCard(m, ALL_OPEN, SPIN);
	// No preview/box lines are ever produced now.
	assert.equal(shaped.lines.filter((l) => l.kind === "preview").length, 0);
	assert.ok(!render(m, ALL_OPEN).some((l) => l.includes("┌") || l.includes("line1")));
	// The singleton member row carries the openable chevron.
	assert.ok(render(m).some((l) => l.endsWith("▸")));
});

test("previewLines keeps the last N (8) non-empty lines and truncates long lines", () => {
	assert.deepEqual(previewLines("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n\n\n"), ["3", "4", "5", "6", "7", "8", "9", "10"]);
	assert.deepEqual(previewLines("a\nb\nc"), ["a", "b", "c"]);
	assert.deepEqual(previewLines(""), []);
	assert.deepEqual(previewLines("only\n"), ["only"]);

	const long = "x".repeat(200);
	const [truncated] = previewLines(long);
	assert.equal(truncated.length, MAX_PREVIEW_LINE_LEN);
	assert.ok(truncated.endsWith("…"));
});

// ── Failures stay calm: no auto-expand, glyph row, box badge ─────────────────────

test("a settled failure does NOT auto-expand: default view still hides members", () => {
	const failed = item({ label: "Ran git push", glyph: "$", isError: true, command: "git push", exitCode: 1 });
	const m = model({
		failures: 1,
		entries: [ge(group({ label: "Ran commands", counts: "2 commands", items: [item({ glyph: "$", label: "Ran ls", command: "ls" }), failed] }))],
	});
	assert.deepEqual(render(m, exp()), ["Worked for 39s · 1 failed ▾", "  • Ran commands · 2 commands ▸"]);
});

test("a failed command shows the family glyph on the row (no red ✗), badge lives in the modal", () => {
	const failed = item({ label: "Ran git push", glyph: "$", isError: true, command: "git push", exitCode: 1, preview: ["fatal: no upstream"] });
	const m = model({
		failures: 1,
		entries: [ge(group({ label: "Ran commands", counts: "2 commands", items: [item({ glyph: "$", label: "Ran ls" }), failed] }))],
	});
	const lines = render(m, ALL_OPEN);
	assert.ok(lines.some((l) => l.startsWith("    $ Ran git push")));
	assert.ok(!lines.some((l) => l.includes("✗ Ran git")));
	// The exit-code badge is not inline; it renders in the modal (itemBadge unit-tested).
	assert.ok(!lines.some((l) => l.includes("Exit code 1")));
	assert.deepEqual(itemBadge(failed), { text: "Exit code 1", tone: "error" });
});

test("a failed member with NO box-worthy output is still openable; badge lives in the modal", () => {
	const failedRead = item({ label: "Read gone.ts", glyph: "▤", isError: true, preview: [] });
	const m = model({ failures: 1, entries: [ge(group({ items: [failedRead] }))] });
	const defaultLines = render(m);
	assert.equal(defaultLines[1], "  ▤ Read gone.ts (0.4s) ▸"); // openable chevron
	assert.ok(!render(m, ALL_OPEN).some((l) => l.includes("✗ Read"))); // no red ✗ on the row
	assert.equal(itemHasBox(failedRead), true); // openable
	assert.deepEqual(itemBadge(failedRead), { text: "✗ Failed", tone: "error" });
});

test("itemHasBox: command, output, or failure each yields a box; a clean read does not", () => {
	assert.equal(itemHasBox(item({ command: "ls" })), true);
	assert.equal(itemHasBox(item({ preview: ["out"] })), true);
	assert.equal(itemHasBox(item({ isError: true })), true);
	assert.equal(itemHasBox(item({ isError: false, preview: [] })), false);
});

// ── Box tail cleanup: trim trailing blanks + strip exit-code line ──

test("boxTail strips a trailing 'Command exited with code N' line the badge repeats", () => {
	assert.deepEqual(boxTail(["fatal: no upstream", "Command exited with code 1"], 1), ["fatal: no upstream"]);
});

test("boxTail trims trailing blank lines, including any left after stripping the exit line", () => {
	assert.deepEqual(boxTail(["out", "", "  "], undefined), ["out"]);
	assert.deepEqual(boxTail(["out", "", "Command exited with code 2", ""], 2), ["out"]);
});

test("boxTail keeps the exit line when it does not match the badge's exit code", () => {
	assert.deepEqual(boxTail(["out", "Command exited with code 3"], 1), ["out", "Command exited with code 3"]);
	assert.deepEqual(boxTail(["out", "Command exited with code 1"], undefined), ["out", "Command exited with code 1"]);
});

test("a failed command box drops the duplicated exit-code line but keeps real output", () => {
	const failed = item({
		label: "Ran git push",
		glyph: "$",
		isError: true,
		command: "git push",
		exitCode: 1,
		preview: ["fatal: no upstream", "Command exited with code 1"],
	});
	const m = model({ failures: 1, entries: [ge(group({ items: [failed] }))] });
	// The card itself renders no inline output. The exit-code/trailing-blank cleanup
	// for the MODAL body is verified in test/modal.test.ts against production
	// itemModalContent. boxTail is unit-tested directly just above.
	assert.ok(!render(m, ALL_OPEN).some((l) => l.includes("fatal: no upstream") || l.includes("Exit code 1")));
	assert.deepEqual(boxTail(failed.preview, failed.exitCode), ["fatal: no upstream"]);
});

test("itemBadge: success / captured exit code / failed fallback", () => {
	assert.deepEqual(itemBadge(item({ isError: false })), { text: "✓ Success", tone: "success" });
	assert.deepEqual(itemBadge(item({ isError: true, exitCode: 2 })), { text: "Exit code 2", tone: "error" });
	assert.deepEqual(itemBadge(item({ isError: true })), { text: "✗ Failed", tone: "error" });
});

test("toolGlyph maps each family to one single-width glyph", () => {
	assert.equal(toolGlyph("bash"), "$");
	assert.equal(toolGlyph("powershell"), "$");
	assert.equal(toolGlyph("read"), "▤");
	assert.equal(toolGlyph("grep"), "⌕");
	assert.equal(toolGlyph("find"), "≡");
	assert.equal(toolGlyph("ls"), "≡");
	assert.equal(toolGlyph("edit"), "✎");
	assert.equal(toolGlyph("write"), "✎");
	assert.equal(toolGlyph("some_mcp_tool"), "◆");
	for (const name of ["bash", "read", "grep", "find", "edit", "mystery"]) {
		assert.equal([...toolGlyph(name)].length, 1);
	}
});

test("a command with no output is still openable (chevron); its content lives in the modal", () => {
	const m = model({ entries: [ge(group({ items: [item({ label: "Ran git status", glyph: "$", command: "git status", durMs: 200 })] }))] });
	assert.ok(render(m).some((l) => l.endsWith(" ▸"))); // openable
	// No inline Shell box is ever drawn now.
	assert.ok(!render(m, ALL_OPEN).some((l) => l.includes("┌ Shell") || l.includes("$ git status")));
});

// ── Hover affordance ────────────────────────────────────────────────────────────
// shapeCard takes an optional hoveredNode: the PRIMARY row whose node id matches
// is marked `hovered` (the Component bolds it) and its chevron is bumped to
// `accent`. Box/preview lines are never lit, and passing no hoveredNode leaves
// every line un-hovered (mouse disabled / cursor off the card). hoveredNodeAt is
// the pure row→node resolver the mouse layer shares, incl. the out-of-range guard
// that clears hover on leave.

test("hoveredNodeAt resolves a visual row to its node and guards out-of-range", () => {
	const rowMap = [HEADER_NODE, groupNodeId(0), memberNodeId(0, 0)];
	assert.equal(hoveredNodeAt(rowMap, 0), HEADER_NODE);
	assert.equal(hoveredNodeAt(rowMap, 2), memberNodeId(0, 0));
	// Out of range (above the card, or below its last row) → undefined = leave/clear.
	assert.equal(hoveredNodeAt(rowMap, -1), undefined);
	assert.equal(hoveredNodeAt(rowMap, 3), undefined);
	assert.equal(hoveredNodeAt([], 0), undefined);
});

test("shapeCard highlights only the hovered group row and emphasizes its chevron", () => {
	const m = model({ entries: [ge(cmds)] });
	const groupNode = groupNodeId(0);
	const shaped = shapeCard(m, exp(), SPIN, groupNode);
	const idx = shaped.rowMap.indexOf(groupNode);
	assert.ok(idx >= 0);
	// The group row is hovered; the header (and any other row) is not.
	assert.equal(shaped.lines[idx].hovered, true);
	assert.equal(shaped.lines.filter((l) => l.hovered).length, 1);
	assert.equal(shaped.lines[0].hovered, undefined);
	// Its trailing chevron segment is bumped to accent for emphasis.
	const chevron = shaped.lines[idx].segments.at(-1);
	assert.ok(chevron && (chevron.text === " ▾" || chevron.text === " ▸"));
	assert.equal(chevron?.tone, "accent");
});

test("shapeCard lights exactly the hovered member row (one row per node)", () => {
	const m = model({ entries: [ge(cmds)] });
	const memberNode = memberNodeId(0, 1); // the git-status member (openable)
	const shaped = shapeCard(m, exp({ isMembersVisible: () => true }), SPIN, memberNode);
	const litNodes = shaped.lines.map((l, i) => (l.hovered ? shaped.rowMap[i] : undefined)).filter(Boolean);
	assert.deepEqual([...new Set(litNodes)], [memberNode]);
	assert.equal(litNodes.length, 1);
	const litIndex = shaped.lines.findIndex((l) => l.hovered);
	assert.notEqual(shaped.lines[litIndex].kind, "preview");
});

test("shapeCard leaves every line un-hovered when no node is hovered", () => {
	const m = model({ entries: [ge(cmds)] });
	const shaped = shapeCard(m, ALL_OPEN, SPIN);
	assert.equal(shaped.lines.some((l) => l.hovered), false);
	// An unknown hovered node id also lights nothing (defensive; e.g. after settle).
	const stale = shapeCard(m, ALL_OPEN, SPIN, "g99");
	assert.equal(stale.lines.some((l) => l.hovered), false);
});

test("a full-collapsed card can still hover its header row", () => {
	const m = model({ entries: [ge(cmds)] });
	const shaped = shapeCard(m, COLLAPSED, SPIN, HEADER_NODE);
	assert.equal(shaped.lines.length, 1);
	assert.equal(shaped.lines[0].hovered, true);
	assert.equal(shaped.lines[0].segments.at(-1)?.tone, "accent");
});

// ── Interrupted marker ──────────────────────────────────────────────────────────
// A card force-settled on an abnormal end (stream error / user Esc abort) carries
// interrupted:true, so its settled header says "· interrupted" (dim/warn tone)
// instead of pretending clean completion. Only on the settled header — never live.

test("interrupted settled header appends '· interrupted' after the duration", () => {
	const m = model({ interrupted: true, elapsedMs: 39000, entries: [ge(cmds)] });
	assert.equal(render(m)[0], "Worked for 39s · interrupted ▾");
	// Full-collapse keeps the marker on the header-only view.
	assert.equal(render(m, COLLAPSED)[0], "Worked for 39s · interrupted ▸");
});

test("interrupted marker sits AFTER the failure count", () => {
	const m = model({ interrupted: true, failures: 2, elapsedMs: 39000, entries: [ge(group({ items: [item({ isError: true })] }))] });
	assert.equal(render(m)[0], "Worked for 39s · 2 failed · interrupted ▾");
});

test("a LIVE card never shows the interrupted marker (only the settled header does)", () => {
	// Defensive: interrupted is only consulted once settled; a still-live model keeps
	// its "Working" header with no marker (a live card is never force-settled-in-place).
	const m = model({ live: true, interrupted: true, elapsedMs: 12000 });
	assert.equal(render(m)[0], `${SPIN} Working · 12s ▾`);
});

test("interrupted preserves the flushed open-thinking entry in its box (force-settle render)", () => {
	// The force-settle transition (grouper flushes the open thinking span,
	// buildCardEntries coalesces it) yields a settled thought entry whose captured
	// tail renders in the "Thinking" box.
	const partial = thought({ ms: 3000, summary: "inspecting events controller", tail: ["**Inspecting events controller and queue setup**"] });
	const m = model({ interrupted: true, elapsedMs: 42000, entries: [ge(cmds), te(partial)] });
	const lines = render(m, ALL_OPEN);
	assert.equal(lines[0], "Worked for 42s · interrupted ▾");
	// The thought row survives with its summary + openable chevron; the captured
	// tail now lives in the modal, not inline.
	assert.ok(lines.some((l) => l.includes("· Thought 3s · inspecting events controller") && l.endsWith("▸")));
	assert.ok(!lines.some((l) => l.includes("Inspecting events controller and queue setup")));
});
