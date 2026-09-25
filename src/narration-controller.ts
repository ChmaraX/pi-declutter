// NarrationController owns the pending→confirm-hide→promote/restore→
// rehide-on-rebuild narration lifecycle as its own unit (same deps-injected
// pattern as ModalController/PatchController), so the state machine is
// unit-testable without pi's runtime.
//
// The PURE pieces stay where they are: Grouper.finalize()'s promoted/
// finalAnswer decision (grouping.ts) and narrationTexts() (card-shape.ts) are
// dependency-free and already unit-tested there. This controller ORCHESTRATES
// them against the live AssistantMessageComponent tree via injected
// hide/restore/rehide/find functions (patches.ts, wired by index.ts).

import type { CardEntry } from "./card-shape.ts";
import { narrationTexts } from "./card-shape.ts";
import { hasNonWhitespace } from "./grouping.ts";
import type { PatchTargetInstance } from "./patches.ts";

/** One retroactively hidden (or hideable) narration text block: the live
 * component instance, which content block, and the trimmed text (used for
 * rebuild re-hides and promotion restore). */
export interface NarrationHide {
	instance: PatchTargetInstance;
	contentIndex: number;
	text: string;
}

export interface NarrationControllerDeps {
	/** Hide a text content block's native rendering (patches.ts
	 * hideMessageTextBlock), injected so this module needs no pi-tui runtime
	 * shapes to unit test. */
	hide(instance: PatchTargetInstance, contentIndex: number): boolean;
	/** Restore a previously-hidden text block (patches.ts restoreMessageTextBlock). */
	restore(instance: PatchTargetInstance, contentIndex: number, text: string): boolean;
	/** Re-apply hides across a rebuilt tree by trimmed-text match (patches.ts
	 * rehideNarrationAfterRebuild). */
	rehideAfterRebuild(root: unknown, texts: ReadonlySet<string>): number;
	/** Find every live AssistantMessageComponent instance in a tree (patches.ts
	 * findAssistantMessageComponents). */
	findInstances(root: unknown): PatchTargetInstance[];
	/** Repaint request so a hide/restore shows promptly. */
	requestRender(): void;
}

export class NarrationController {
	// The most recently completed text block, captured at text_end, awaiting
	// confirmation: AT MOST one at a time, since text blocks stream serially.
	// If something follows it (a new tool call, new thinking, or another text
	// block) it is confirmed non-final and its native rendering is hidden
	// (folded into the card instead). If NOTHING follows before the response
	// settles, it was the true final answer — never touched, stays visible
	// exactly as pi always rendered it. Cleared on every confirm-or-reset
	// boundary so a stale reference never leaks into the next response.
	private pending: NarrationHide | undefined;
	/** Every narration hide of the CURRENT response, in confirm order: when
	 * finalize() promotes the last narration back out as the answer, the
	 * matching record restores its native text block. */
	private hides: NarrationHide[] = [];
	private readonly deps: NarrationControllerDeps;

	constructor(deps: NarrationControllerDeps) {
		this.deps = deps;
	}

	/** Current pending block's text, if any (used by session_compact's rehide
	 * sweep, which must also protect an unconfirmed block from reappearing). */
	pendingText(): string | undefined {
		return this.pending?.text;
	}

	/** A fresh response begins (or resetResponse defensively re-runs): drop
	 * pending/hide state WITHOUT hiding anything — a still-pending block from a
	 * PREVIOUS response is moot: if it was genuinely that response's final
	 * answer, its native rendering must stay untouched. */
	reset(): void {
		this.pending = undefined;
		this.hides = [];
	}

	/**
	 * Capture the text block that just ended, unambiguous at this exact moment
	 * since no later message has started yet. Held until either confirmed
	 * non-final (hidden, folded into the card) or the response settles with
	 * nothing after it (the true final answer — left alone). No-op for an
	 * empty/whitespace-only block (mirrors the grouper's own break condition).
	 */
	captureTextEnd(root: unknown, contentIndex: number, content: string): void {
		if (!hasNonWhitespace(content)) return;
		const instances = this.deps.findInstances(root);
		const instance = instances[instances.length - 1];
		if (instance) this.pending = { instance, contentIndex, text: content.trim() };
	}

	/**
	 * Confirm any pending narration block as NON-final and hide its native
	 * rendering, folding it into the card instead. Called the moment ANY
	 * activity is known to follow it: a new tool call, a new thinking span, or
	 * another text block starting — each is proof the pending block was not the
	 * last thing in the response. No-op when nothing is pending. Best-effort: a
	 * failed hide (component gone, shape drifted) leaves the text visible
	 * natively — the card row still exists from Grouper.textEnd either way, so
	 * nothing is ever lost, only occasionally shown in both places.
	 */
	confirmNonFinal(): void {
		if (!this.pending) return;
		const hidden = this.deps.hide(this.pending.instance, this.pending.contentIndex);
		// Record the hide (in confirm order) so settle() can RESTORE the last one
		// when the response ends without a final answer (promotion — grouping.ts).
		if (hidden) this.hides.push(this.pending);
		this.pending = undefined;
		if (hidden) this.deps.requestRender();
	}

	/**
	 * Resolve the narration lifecycle at settle, given Grouper.finalize()'s
	 * promoted/finalAnswer decision (grouping.ts — stays pure/unchanged).
	 * Whatever `pending` pointed at is now resolved either way (folded into the
	 * finalized entries as a narration entry, or popped out as the final
	 * answer) — clear it defensively.
	 *
	 * Promotion: when a provider trails thinking/tool activity after the real
	 * answer, or a turn ends on tool calls, the response produces no trailing
	 * text, so finalize pulls the LAST narration back out as the answer. Its
	 * native block was hidden at confirm time — restore it so the response is
	 * never visibly answerless. Match by text, last record first (records and
	 * entries append in the same order).
	 */
	settle(finalAnswer: string | undefined, promoted: boolean | undefined): void {
		this.pending = undefined;
		if (promoted && finalAnswer !== undefined) {
			for (let i = this.hides.length - 1; i >= 0; i--) {
				const record = this.hides[i];
				if (record.text === finalAnswer) {
					if (this.deps.restore(record.instance, record.contentIndex, finalAnswer)) {
						this.deps.requestRender();
					}
					break;
				}
			}
		}
		this.hides = [];
	}

	/**
	 * Re-hide folded narration after a transcript rebuild (e.g. /reload). The
	 * rebuilt tree renders the ORIGINAL un-blanked stored messages, and a
	 * reload also throws away the old hide registry, so every narration text
	 * known from persisted card entries must be re-applied. `cardEntryLists` is
	 * every card's `entries` the caller collected (pi-specific traversal of
	 * session entries stays in the caller — this module takes only the
	 * already-extracted CardEntry arrays, per its no-pi-event-types contract).
	 */
	sweepAfterRebuild(root: unknown, cardEntryLists: Iterable<readonly CardEntry[]>): void {
		const texts = new Set<string>();
		for (const entries of cardEntryLists) for (const t of narrationTexts(entries)) texts.add(t);
		if (texts.size > 0) this.deps.rehideAfterRebuild(root, texts);
	}
}
