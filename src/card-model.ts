/**
 * Card model + persistence policy (extracted from card-shape.ts, which now
 * holds only pure render shaping). This module owns the LIVE/PERSISTED card
 * model shapes and the pure decisions around them: how a stale on-disk
 * snapshot degrades into a settled render model, whether a settled card must
 * be re-appended after a compaction, and the native-thinking-suppression
 * decision behind the markdown transformer src/index.ts registers. It carries
 * no TUI or pi-agent runtime dependency, so it is unit-testable with plain
 * objects (test/card-model.test.ts) — same pattern as modal-controller.ts /
 * patch-controller.ts.
 */

import type { CardEntry, CardShapeModel } from "./card-shape.ts";

// ── Native thinking suppression (tickets 20 + 22) ───────────────────────────────
// The pure decision behind the markdown transformer src/index.ts registers, kept
// here so it is unit-tested. It is lever 1 of ticket 22 — the ONLY supported
// reduction of the native thinking display — and the reason it works: returning
// "" for "assistant-thinking" makes pi's Markdown component render ZERO lines for
// the thinking body (Markdown.render early-returns [] when the transformed text
// trims to empty — pi-tui `dist/components/markdown.js:186-196`), so nothing is
// drawn where the native "Planning…" block would be. Non-thinking markdown
// ("user"/"assistant") passes through byte-for-byte.
//
// What it CANNOT do (tickets 22 + 26 investigation): the transformer only
// rewrites the thinking TEXT. AssistantMessageComponent decides whether to add
// the surrounding `Spacer(1)` siblings from the RAW, pre-transform message
// content (`hasVisibleContent` / `hasVisibleContentAfter`,
// assistant-message.js:74-77,120-127). A message whose only visible raw block is
// thinking (shape [thinking, toolCall…] — thinking + tools, no text) is therefore
// still "visible" and gets ONE leading Spacer, even though the thinking body
// renders 0 lines and every absorbed tool row renders 0 lines. Ticket 26: a big
// task is dozens of such separate messages, so the leading Spacers stack (N
// messages → N blank lines — the owner's ~40-blank gap); the empty [] final
// message renders 0. Removing the Spacer would require stripping the thinking
// from the message, and pi mutates the finalized message in place for BOTH the
// rendered tree and the provider-resent/persisted state (agent-session.js:453-466)
// — that breaks the byte-identical-context constraint (drops `thinkingSignature`);
// `MessageEndEventResult` exposes only `message`, no render-only variant — so it
// is rejected. One blank per thinking-bearing message is therefore the documented
// irreducible floor; see the ticket 22 + 26 Answers for the full trace + probe
// counts (prototypes/blank-probe/probe.mjs).
export function suppressThinkingMarkdown(markdown: string, messageType: string): string {
	return messageType === "assistant-thinking" ? "" : markdown;
}

// ── Stale-snapshot shaping (ticket 25 layer 3) ─────────────────────────────────
// The card model is stored BY REFERENCE on the appended session entry and mutated
// in place as the response runs, but appendEntry serializes the entry's data ONCE
// at append time (session-manager.js _persist → appendFileSync of a single JSON
// line). Because the card is appended EARLY (first tool, ticket 11) its persisted
// line captures the empty live snapshot {live:true, workedMs:0, entries:[]}; the
// later settle mutation only reaches disk if a full _rewriteFile runs (migration /
// branch / fork), which a plain /resume does not trigger. So on a fresh-process
// resume the renderer is handed that stale live snapshot. This shaping renders it
// GRACEFULLY: live:true is treated as settled (never a ticking ghost), the
// duration degrades to "—" when it was never recorded, and whatever entries the
// snapshot carries are shown as-is.

/** The persisted shape of a card entry's data (a structural subset of
 * CardModel), as it arrives from a session file on resume. */
export interface PersistedCardData {
	live?: boolean;
	workedMs?: number;
	failures?: number;
	entries?: CardEntry[];
	/** True when the response was force-settled on an abnormal end (ticket 32); a
	 * resumed interrupted card keeps its "· interrupted" marker. */
	interrupted?: boolean;
}

/** The live/runtime card model (ticket 11) the extension mutates in place and
 * stores by reference on the entry. A superset of the persisted snapshot with
 * the required live fields (`startMs` for the elapsed clock). */
export interface CardModel {
	/** True while the response is active — render the "⟳ Working · Xs" header. */
	live: boolean;
	/** Response start (first turn_start) for the live elapsed clock. */
	startMs: number;
	/** Total elapsed, frozen at settle. */
	workedMs: number;
	failures: number;
	/** Ordered top-level flow: group + thought entries in event order (ticket 21). */
	entries: CardEntry[];
	/**
	 * True when this card was FORCE-SETTLED on an abnormal end (ticket 32): a stream
	 * error (assistant stopReason "error") or a user abort (Esc, stopReason
	 * "aborted") ended the response without a clean agent_settled for THIS card. The
	 * settled header then shows "Worked for Xs · interrupted" rather than pretending
	 * completion. Frozen at settle like every other field.
	 */
	interrupted?: boolean;
}

/**
 * Shape a persisted snapshot into a SETTLED CardShapeModel (ticket 25 layer 3).
 * A snapshot is always rendered settled — a `live:true` snapshot is a
 * mid-response save with no timer to tick it, so treating it as live would show a
 * frozen "⟳ Working" ghost. The duration is unknown (`—`) when the snapshot was
 * still live with no recorded workedMs; a genuinely settled snapshot keeps its
 * recorded workedMs. Pure so index.ts and tests share one rule.
 */
export function staleCardShapeModel(data: PersistedCardData): CardShapeModel {
	const workedMs = data.workedMs ?? 0;
	return {
		live: false,
		elapsedMs: workedMs,
		failures: data.failures ?? 0,
		entries: Array.isArray(data.entries) ? data.entries : [],
		unknownDuration: Boolean(data.live) && workedMs === 0,
		interrupted: Boolean(data.interrupted),
	};
}

// ── Compaction survival: dedup decision (ticket 25 layer 2) ────────────────────

/**
 * Decide whether to re-append a settled card after a compaction (ticket 25
 * layer 2). A compaction drops every entry before its firstKeptEntryId from the
 * rebuilt transcript (interactive-mode rebuildChatFromMessages →
 * buildContextEntries), so a card appended earlier in the response VANISHES. If
 * the last card entry did not survive into the kept context AND we have not
 * already re-appended it, a fresh settled card must be re-appended so the
 * response stays visible. Deduped per source entry so one response never yields
 * two cards. Pure so index.ts and tests share one rule.
 */
export function shouldReappendCard(params: {
	/** Id of the most recent card entry (undefined when no card was appended). */
	lastCardEntryId: string | undefined;
	/** Ids of the entries that survived the compaction (the kept context). */
	survivingEntryIds: readonly string[];
	/** Whether this exact source entry was already re-appended (dedup guard). */
	alreadyReappended: boolean;
}): boolean {
	const { lastCardEntryId, survivingEntryIds, alreadyReappended } = params;
	if (!lastCardEntryId || alreadyReappended) return false;
	return !survivingEntryIds.includes(lastCardEntryId);
}
