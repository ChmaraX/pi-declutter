// Card VIEW layer: the per-card expansion state, hover highlighting, and the
// ActivityCard render component itself. This module owns how a CardModel
// becomes on-screen lines + a line-index → node-id row map; it does not own
// the model's lifecycle (append/settle/ledger — that stays in index.ts) or
// mouse-event dispatch (mouse-controller.ts) or the floating modal
// (modal-controller.ts).

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	type CardExpansion,
	type CardShapeModel,
	expandRowMapToVisual,
	groupHasMembersToggle,
	shapeCard,
	spinnerFrame,
} from "./card-shape.ts";
import { type CardModel, type PersistedCardData, staleCardShapeModel } from "./card-model.ts";
import { styleLine } from "./styling.ts";

// The card renders inside a Box with vertical padding 1, so its first content
// line (the header) sits at rendered index 1. A click's card-local y maps to a
// visual row by subtracting this top padding.
export const CARD_BOX_PADDING_Y = 1;
// The same Box has horizontal padding 1 (new Box(1, 1, …)); each child Text is
// rendered at width − 2×this, which is where line wrapping happens. The row-map
// is expanded into that wrapped space in ActivityCard.render so clicks on a
// card whose lines wrap still resolve to the right node.
export const CARD_BOX_PADDING_X = 1;

// Per-card expansion state over the top-level entry sequence. `fullCollapsed`
// hides everything but the header; otherwise `membersVisible` holds the
// top-level indices of multi-member group entries showing their members.
// Output/thinking are shown via a floating modal (not inline boxes) —
// clicking a member/thought row opens it, so there is no per-box visibility
// state to track here.
export interface CardView {
	fullCollapsed: boolean;
	membersVisible: Set<number>;
}

export interface ViewState {
	/** Per-card tree expansion, keyed by entry id (lazily created). */
	cards: Map<string, CardView>;
	/** The card models by entry id, so the keyboard shortcut can enumerate nodes. */
	models: Map<string, CardModel>;
	/** Entry ids in first-seen (append) order; the last is the newest card. */
	order: string[];
}

/** The card's expansion state, created on first access with the default tree. */
export function getCardView(view: ViewState, id: string): CardView {
	let cv = view.cards.get(id);
	if (!cv) {
		cv = { fullCollapsed: false, membersVisible: new Set() };
		view.cards.set(id, cv);
	}
	return cv;
}

/** True when every expandable node of the card is open (the all-expanded
 * state). "Expandable" means only multi-member group entries showing their
 * members — thought and narration rows have no separate expand state, they
 * just open a modal on click. */
export function isAllExpanded(model: CardModel, cv: CardView): boolean {
	if (cv.fullCollapsed) return false;
	return model.entries.every((entry, k) => {
		if (entry.kind !== "group") return true;
		return !groupHasMembersToggle(entry.group) || cv.membersVisible.has(k);
	});
}

/** Open every expandable node (every multi-member group's members). */
export function setAllExpanded(model: CardModel, cv: CardView): void {
	cv.fullCollapsed = false;
	cv.membersVisible.clear();
	model.entries.forEach((entry, k) => {
		if (entry.kind === "group" && groupHasMembersToggle(entry.group)) cv.membersVisible.add(k);
	});
}

// Which clickable node the mouse is currently over. Session-lived, shared
// with every card: `cardId` names the hovered card, `nodeId` its hovered
// node. Empty (both undefined) when the mouse is off every card or disabled,
// so no row is highlighted. commitHover() is the single writer + render throttle.
export interface HoverState {
	cardId?: string;
	nodeId?: string;
}

/** Set the hovered card/node, re-rendering ONLY when it actually changes:
 * motion reports are dense, but a move within the same row (or off every card
 * while already cleared) does nothing. Passing undefined ids clears the hover
 * (leave). `requestRender` is injected so this module never needs the live
 * TUI handle directly. */
export function commitHover(
	hover: HoverState,
	cardId: string | undefined,
	nodeId: string | undefined,
	requestRender: () => void,
): void {
	if (hover.cardId === cardId && hover.nodeId === nodeId) return;
	hover.cardId = cardId;
	hover.nodeId = nodeId;
	requestRender();
}

/** Clear any hover highlight: on card settle re-render + teardown, so a
 * finalized card (whose node ids may have shifted) never keeps a stale row lit. */
export function clearHover(hover: HoverState, requestRender: () => void): void {
	commitHover(hover, undefined, undefined, requestRender);
}

// ── Settled activity card ────────────────────────────────────────────────
// A live-reading Component: render() consults the per-card expansion state every
// frame, so a single tui.requestRender() after a per-node click or the toggle
// shortcut re-renders every card without needing per-entry invalidation (which
// pi does not expose).
// One rendered line, matching pi-tui's Text component's render() contract
// (wraps its content at the given width, returning the wrapped lines).
export interface CardLine {
	render(width: number): string[];
}

// The box ActivityCard renders into, matching pi-tui's Box component's
// addChild()/render() contract. Both this and CardLine are structural
// subsets of the real pi-tui types — declared here (not imported as values)
// so ActivityCard is unit-testable without the pi-tui runtime (mirrors
// ModalController's injected `makeModal`).
export interface CardBox {
	addChild(line: CardLine): void;
	render(width: number): string[];
}

/** Builds the real pi-tui primitives ActivityCard renders into. Injected so
 * this module never imports Box/Text as values (index.ts supplies the real
 * pi-tui-backed factory; tests supply a fake one). */
export interface CardRenderPrimitives {
	/** The card's outer box: padding 1/1, background painted via `bg`. */
	makeBox(bg: (text: string) => string): CardBox;
	/** One already-themed line, ready to wrap at the box's content width. */
	makeLine(content: string): CardLine;
}

export class ActivityCard implements Component {
	private readonly model: CardModel;
	private readonly theme: Theme;
	private readonly cardId: string;
	private readonly view: ViewState;
	/** Shared line-index → node-id map by card id, refreshed each render for
	 * mouse resolution (onCardMouse reads the last rendered rowMap). */
	private readonly rowMaps: Map<string, string[]>;
	/** Shared hover state: the row highlighted this frame is the one whose
	 * node id matches when this card is the hovered card. */
	private readonly hover: HoverState;
	/** True when this card is being rendered from a PERSISTED snapshot on a
	 * fresh-process resume: render it settled/graceful, never as a ticking
	 * live card, since no timer exists to advance it. */
	private readonly stale: boolean;
	/** The real pi-tui Box/Text factory in production; a fake in tests. */
	private readonly primitives: CardRenderPrimitives;

	// Plain field assignment (not TS constructor parameter properties): pi loads
	// the extension through jiti (full TS transform, either syntax works), but
	// Node's strip-only TS mode used by `node --test` cannot erase parameter
	// properties (they emit code, not just types) — this class is unit-tested
	// directly (test/card-view.test.ts), so it uses the same plain-field pattern
	// as ModalController/MouseController/PatchController.
	constructor(
		model: CardModel,
		theme: Theme,
		cardId: string,
		view: ViewState,
		rowMaps: Map<string, string[]>,
		hover: HoverState,
		primitives: CardRenderPrimitives,
		stale = false,
	) {
		this.model = model;
		this.theme = theme;
		this.cardId = cardId;
		this.view = view;
		this.rowMaps = rowMaps;
		this.hover = hover;
		this.primitives = primitives;
		this.stale = stale;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const box = this.primitives.makeBox((text) => theme.bg("customMessageBg", text));

		// The card renders in its FINAL shape from the first tool and grows in
		// place: the same shapeCard() drives the live and settled views, so the
		// only change at settle is the header word/spinner and a running row
		// losing its spinner. Read the mutable model + per-node expansion each
		// frame; a captured tui.requestRender() ticks it while live. A stale
		// resumed snapshot is shaped settled/graceful instead — live:true
		// becomes settled, workedMs 0 becomes "Worked for —".
		const shapeModel: CardShapeModel = this.stale
			? staleCardShapeModel(this.model as PersistedCardData)
			: {
					live: this.model.live,
					elapsedMs: this.model.live ? Date.now() - this.model.startMs : this.model.workedMs,
					failures: this.model.failures,
					entries: this.model.entries,
					// A card force-settled in the running process (Esc-abort / stream
					// error) is rendered through THIS non-stale branch, so the flag must
					// flow to shapeCard or the "· interrupted" marker is silently
					// dropped in its primary scenario — only the resumed/stale path set
					// it before.
					interrupted: this.model.interrupted,
				};
		const cv = getCardView(this.view, this.cardId);
		const expansion: CardExpansion = {
			fullCollapsed: cv.fullCollapsed,
			isMembersVisible: (k) => cv.membersVisible.has(k),
		};
		// The header + any running-row mark use pi's OWN spinner cadence:
		// spinnerFrame(Date.now()) advances every SPINNER_INTERVAL_MS (80 ms),
		// matching the composer working bar. It animates for free because pi's
		// working indicator re-renders the whole tree ~every 80 ms while the
		// agent works; our 500 ms LIVE_TICK_MS timer stays as the fallback
		// repaint/content cadence. Once settled no running rows remain, so the
		// frame is irrelevant.
		const spinner = spinnerFrame(Date.now());
		// Highlight the hovered row only when THIS card is the hovered one;
		// undefined otherwise, so shapeCard applies no highlight (also the
		// mouse-disabled case — hover is never written).
		const hoveredNode = this.hover.cardId === this.cardId ? this.hover.nodeId : undefined;
		const shaped = shapeCard(shapeModel, expansion, spinner, hoveredNode);
		// Stash the row-map so a click on this card resolves to the right node.
		// Clicks arrive in VISUAL (wrapped) rows, but shaped.rowMap is indexed by
		// logical shape lines — a wide box/command line wraps to ≥2 rows on a
		// narrow terminal, which would shift every node below it. Measure each
		// line at the Box's inner content width (width − 2×paddingX, where Text
		// wraps) and expand the row-map into wrapped-row space so onCardMouse's
		// event.y indexes it correctly.
		const contentWidth = Math.max(1, width - CARD_BOX_PADDING_X * 2);
		const heights: number[] = [];
		for (const line of shaped.lines) {
			const text = this.primitives.makeLine(styleLine(theme, line));
			heights.push(text.render(contentWidth).length);
			box.addChild(text);
		}
		this.rowMaps.set(this.cardId, expandRowMapToVisual(shaped.rowMap, heights));
		return box.render(width);
	}

	invalidate(): void {
		// No cached state; render() reads live data + view each frame.
	}
}
