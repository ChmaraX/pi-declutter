/**
 * Card VIEW layer tests (review follow-up to the ticket-38 controller split
 * that already pulled out mouse handling): per-card expansion round-trip,
 * hover commit/clear throttling, and ActivityCard.render's row-map
 * registration — the piece onCardMouse (index.ts) depends on to resolve a
 * click to a node id.
 *
 * ActivityCard is unit-tested directly (not through a controller), because it
 * has no pi-tui value dependency left: Box/Text are injected via
 * CardRenderPrimitives (mirrors ModalController's injected `makeModal`, see
 * test/modal-controller.test.ts) and Theme is faked the same way that suite
 * fakes its UI context.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardModel } from "../src/card-model.ts";
import type { ShapeItem } from "../src/card-shape.ts";
import {
	ActivityCard,
	type CardBox,
	type CardLine,
	type CardRenderPrimitives,
	clearHover,
	commitHover,
	getCardView,
	type HoverState,
	isAllExpanded,
	setAllExpanded,
	type ViewState,
} from "../src/card-view.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A fake Theme: fg/bg pass the text through tagged with the role so assertions
 * can check which role/tone was applied; bold wraps in markers. Mirrors the
 * fake theme shape test/modal-controller.test.ts uses for its overlay factory. */
function fakeTheme() {
	return {
		fg: (role: string, text: string) => `[${role}]${text}`,
		bg: (role: string, text: string) => `<${role}>${text}</${role}>`,
		bold: (text: string) => `**${text}**`,
	} as never;
}

/** A fake CardLine/CardBox pair: `render` just word-splits into one line per
 * newline (no real wrapping) — good enough to exercise the row-map expansion
 * without pi-tui. Records every line's content for assertions. */
function fakePrimitives(): { primitives: CardRenderPrimitives; renderedLines: string[] } {
	const renderedLines: string[] = [];
	const primitives: CardRenderPrimitives = {
		makeBox: (bg): CardBox => {
			const children: CardLine[] = [];
			return {
				addChild(line: CardLine) {
					children.push(line);
				},
				render(width: number): string[] {
					const out: string[] = [];
					for (const child of children) out.push(...child.render(width));
					return out.map((l) => bg(l));
				},
			};
		},
		makeLine: (content: string): CardLine => {
			renderedLines.push(content);
			return { render: () => [content] };
		},
	};
	return { primitives, renderedLines };
}

function makeModel(entries: CardModel["entries"]): CardModel {
	return { live: false, startMs: 0, workedMs: 1000, failures: 0, entries };
}

function fakeItem(overrides: Partial<ShapeItem> = {}): ShapeItem {
	return {
		label: "Ran ls",
		durMs: 10,
		isError: false,
		running: false,
		preview: ["a", "b"],
		glyph: "$",
		command: "ls",
		...overrides,
	};
}

function twoMemberGroupModel(): CardModel {
	return makeModel([
		{
			kind: "group",
			group: { label: "Ran commands", counts: "2 commands", items: [fakeItem(), fakeItem({ label: "Ran pwd" })] },
		},
	]);
}

// ── Expansion round-trip ────────────────────────────────────────────────────

test("getCardView creates the default tree on first access and reuses it after", () => {
	const view: ViewState = { cards: new Map(), models: new Map(), order: [] };
	const cv1 = getCardView(view, "card-1");
	assert.equal(cv1.fullCollapsed, false);
	assert.equal(cv1.membersVisible.size, 0);
	cv1.membersVisible.add(0);
	const cv2 = getCardView(view, "card-1");
	assert.equal(cv2, cv1, "same object on repeat access");
	assert.ok(cv2.membersVisible.has(0));
});

test("setAllExpanded / isAllExpanded round-trip through full-collapse and default", () => {
	const view: ViewState = { cards: new Map(), models: new Map(), order: [] };
	const model = twoMemberGroupModel();
	const cv = getCardView(view, "card-1");

	assert.equal(isAllExpanded(model, cv), false, "default view (members hidden) is not all-expanded");

	setAllExpanded(model, cv);
	assert.equal(cv.fullCollapsed, false);
	assert.ok(cv.membersVisible.has(0), "the only group entry's members are now visible");
	assert.equal(isAllExpanded(model, cv), true);

	cv.fullCollapsed = true;
	assert.equal(isAllExpanded(model, cv), false, "full-collapse is never all-expanded");

	cv.fullCollapsed = false;
	cv.membersVisible.clear();
	assert.equal(isAllExpanded(model, cv), false, "back to default (members hidden) round-trips cleanly");
});

test("isAllExpanded ignores thought/narration entries (only group members toggle)", () => {
	const view: ViewState = { cards: new Map(), models: new Map(), order: [] };
	const model = makeModel([
		{ kind: "thought", thought: { ms: 2000, summary: "s", tail: ["x"], fullText: "x" } },
		{ kind: "narration", narration: { text: "hello", summary: "hello" } },
	]);
	const cv = getCardView(view, "card-1");
	assert.equal(isAllExpanded(model, cv), true, "no group entries means nothing left to expand");
});

// ── Hover commit/clear ──────────────────────────────────────────────────────

test("commitHover writes both fields and requests a render only on an actual change", () => {
	const hover: HoverState = {};
	let renders = 0;
	commitHover(hover, "card-1", "g0", () => renders++);
	assert.deepEqual(hover, { cardId: "card-1", nodeId: "g0" });
	assert.equal(renders, 1);

	// Same values again (a dense "move" report over the same row): no-op.
	commitHover(hover, "card-1", "g0", () => renders++);
	assert.equal(renders, 1, "throttled: no render request for an unchanged hover");

	commitHover(hover, "card-1", "g0.m1", () => renders++);
	assert.deepEqual(hover, { cardId: "card-1", nodeId: "g0.m1" });
	assert.equal(renders, 2);
});

test("clearHover resets both fields and is a no-op once already clear", () => {
	const hover: HoverState = { cardId: "card-1", nodeId: "g0" };
	let renders = 0;
	clearHover(hover, () => renders++);
	assert.deepEqual(hover, { cardId: undefined, nodeId: undefined });
	assert.equal(renders, 1);

	clearHover(hover, () => renders++);
	assert.equal(renders, 1, "clearing an already-clear hover requests no render");
});

// ── ActivityCard.render row-map registration ────────────────────────────────

test("ActivityCard.render registers a row map resolving the header and each member node id", () => {
	const view: ViewState = { cards: new Map(), models: new Map(), order: [] };
	const rowMaps = new Map<string, string[]>();
	const hover: HoverState = {};
	const model = twoMemberGroupModel();
	// Expand the group's members up front so both member rows render (not just
	// the collapsed group summary row) and get their own row-map entries.
	setAllExpanded(model, getCardView(view, "card-1"));

	const { primitives } = fakePrimitives();
	const card = new ActivityCard(model, fakeTheme(), "card-1", view, rowMaps, hover, primitives);
	const lines = card.render(80);

	assert.ok(lines.length > 0, "render produced output lines");
	const rowMap = rowMaps.get("card-1");
	assert.ok(rowMap, "render registered a row map for this card id");
	assert.equal(rowMap?.length, lines.length, "row map has one entry per rendered line");
	assert.equal(rowMap?.[0], "header", "the first line belongs to the header node");
	assert.ok(rowMap?.includes("g0.m0"), "first member's row resolves to g0.m0");
	assert.ok(rowMap?.includes("g0.m1"), "second member's row resolves to g0.m1");
});

test("ActivityCard.render re-registers the row map on every call (last render wins)", () => {
	const view: ViewState = { cards: new Map(), models: new Map(), order: [] };
	const rowMaps = new Map<string, string[]>();
	const hover: HoverState = {};
	const model = twoMemberGroupModel();

	const { primitives } = fakePrimitives();
	const card = new ActivityCard(model, fakeTheme(), "card-1", view, rowMaps, hover, primitives);

	card.render(80);
	const collapsedRowMap = rowMaps.get("card-1");
	assert.ok(collapsedRowMap && !collapsedRowMap.includes("g0.m0"), "members collapsed by default: no member rows yet");

	setAllExpanded(model, getCardView(view, "card-1"));
	card.render(80);
	const expandedRowMap = rowMaps.get("card-1");
	assert.ok(expandedRowMap?.includes("g0.m0"), "re-render after expanding replaces the stale row map");
});

test("ActivityCard.render highlights only the hovered card's hovered row", () => {
	// A rendered line whose Segment tones are all plain "text"/"muted" (never
	// "bold") is only ever wrapped in "**" by ActivityCard's own `line.hovered`
	// bolding (styleLine), not by shapeCard's tone styling \u2014 so member rows are
	// the clean signal (the header row is unconditionally bold-toned already).
	const view: ViewState = { cards: new Map(), models: new Map(), order: [] };
	const rowMaps = new Map<string, string[]>();
	const model = twoMemberGroupModel();
	setAllExpanded(model, getCardView(view, "card-1"));

	const { primitives, renderedLines } = fakePrimitives();
	// Hover a member of a DIFFERENT card: this card must render with no
	// highlighted row (hover.cardId mismatch), proving cross-card isolation.
	const hoverElsewhere: HoverState = { cardId: "card-2", nodeId: "g0.m0" };
	new ActivityCard(model, fakeTheme(), "card-1", view, rowMaps, hoverElsewhere, primitives).render(80);
	const memberLinesUnhovered = renderedLines.filter((l) => l.includes("Ran ls") || l.includes("Ran pwd"));
	assert.ok(memberLinesUnhovered.length > 0, "sanity: member rows rendered");
	assert.ok(
		memberLinesUnhovered.every((l) => !l.includes("**")),
		"no member line is bold-wrapped when the hover belongs to a different card",
	);

	renderedLines.length = 0;
	const hoverHere: HoverState = { cardId: "card-1", nodeId: "g0.m0" };
	new ActivityCard(model, fakeTheme(), "card-1", view, rowMaps, hoverHere, primitives).render(80);
	const memberLinesHovered = renderedLines.filter((l) => l.includes("Ran ls") || l.includes("Ran pwd"));
	assert.ok(
		memberLinesHovered.some((l) => l.includes("**")),
		"the hovered member row is bold-wrapped when this card is the hovered one",
	);
});
