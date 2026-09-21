/**
 * Pure flow state machine for the activity feed (tickets 10 + 21).
 *
 * The card represents the agent's ACTUAL flow as an ordered TOP-LEVEL sequence
 * of entries — Thought entries and Group entries — in event order (ticket 21):
 *
 *     · Thought 4s · planning approach          (thought entry)
 *     • Ran commands · 2 commands               (group entry: consecutive tools)
 *     · Thought 2s · checking output            (thought entry)
 *     $ Ran make test (4.0s)                     (group entry: singleton tool)
 *
 * A "group" is a maximal run of consecutive tool calls uninterrupted by either
 * MEANINGFUL thinking or visible assistant text — both now close the open group.
 *
 * Boundary rules:
 *   - Visible assistant text closes the open group (ticket 10, overturning
 *     ticket 07's `text_start` break): on the first non-whitespace `text_delta`,
 *     or at `text_end` if the whole block turned out to be non-empty. Empty /
 *     whitespace-only text blocks do NOT break. Turn boundaries never break
 *     (a run of tool-only turns stays one group — Codex U01/U04 fat groups).
 *   - MEANINGFUL thinking closes the open group and becomes its own top-level
 *     Thought entry between the groups it separated (ticket 21). Meaningful =
 *     a run of CONSECUTIVE thinking spans whose durations total >= MIN_THOUGHT_MS
 *     (coalesced into one entry). Sub-threshold thinking is ignored entirely: it
 *     does not break groups and does not render (protects against the 1–4 ms
 *     bursty spans from spike finding 3, so tool bursts without real thinking
 *     still form one fat group).
 *
 * A thinking run is "consecutive" only until a tool call or visible text
 * interrupts it; those events resolve the pending run (emit it if meaningful,
 * discard it otherwise) before recording the tool / breaking the group.
 *
 * The machine is generic over the call payload (`C`) so it carries no TUI or
 * pi-agent dependency and is unit-testable with plain objects.
 */

/** Meaningful-thinking threshold: a coalesced thinking run shorter than this is
 * ignored (does not break a group, does not render) — ticket 06 finding 3. This
 * is the single source of truth for the 1s threshold; card-shape re-exports it. */
export const MIN_THOUGHT_MS = 1000;

/** True when `text` contains at least one non-whitespace character. */
export function hasNonWhitespace(text: string): boolean {
	return /\S/.test(text);
}

/** One captured thinking span: self-timed duration plus the streamed text
 * (ticket 20 — the text drives the thought-entry summary + expandable box). */
export interface ThoughtSpan {
	ms: number;
	text: string;
}

/**
 * The in-progress thinking span passed to snapshot() (ticket 23): the elapsed ms
 * of the currently-streaming span and its current streamed text. `text` is a live
 * reference — snapshot copies only a bounded tail downstream (buildCardEntries →
 * coalesceThoughts), so the full buffer is never retained here.
 */
export interface LiveThinking {
	ms: number;
	text: string;
}

/**
 * The live tick condition (ticket 23): the timer runs while tool calls are
 * executing OR a thinking span is active. Tools drive their row spinners and
 * durations; an active thinking span drives the live "Thinking… · Xs" entry and
 * its crossing of MIN_THOUGHT_MS. The timer tears down only when neither is true.
 * Pure so index.ts and tests share one rule.
 */
export function shouldTick(runningTools: number, thinkingActive: boolean): boolean {
	return runningTools > 0 || thinkingActive;
}

/**
 * One top-level entry in the card's ordered flow (ticket 21): a group of
 * consecutive tool calls, a coalesced run of meaningful thinking spans, or a
 * narration text block (ticket 41 \u2014 an intermediate assistant paragraph that
 * turned out NOT to be the final answer, folded into the card in its
 * chronological spot instead of floating in the transcript).
 */
export type Entry<C> =
	| { kind: "group"; calls: C[] }
	| { kind: "thought"; spans: ThoughtSpan[] }
	| { kind: "narration"; text: string };

/** Result of finalize() (ticket 41): the settled entry sequence, plus the FINAL
 * answer text when the response's last thing was a text block with nothing after
 * it (popped out of `entries` \u2014 it renders as the normal transcript response,
 * not a card row). Undefined when the response ended on a group/thought, or had
 * no narration at all. */
export interface FinalizeResult<C> {
	entries: Entry<C>[];
	finalAnswer?: string;
}

export class Grouper<C> {
	private entries: Entry<C>[] = [];
	/** The open group's calls (consecutive tools not yet closed). */
	private currentCalls: C[] = [];
	/** The pending thinking run (consecutive spans), unresolved until a tool call,
	 * visible text, or finalize decides whether it is meaningful. */
	private pendingSpans: ThoughtSpan[] = [];
	/** True once the currently-open assistant text block has already broken the group. */
	private brokeForBlock = false;
	private readonly minThoughtMs: number;

	constructor(minThoughtMs = MIN_THOUGHT_MS) {
		this.minThoughtMs = minThoughtMs;
	}

	/** Record a tool call in the open group. Resolves any pending thinking first,
	 * so a meaningful run before this call closes the group + emits its entry. */
	addCall(call: C): void {
		this.resolvePending();
		this.currentCalls.push(call);
	}

	/**
	 * Record a thinking span (ms + captured text) into the pending run (ticket 21).
	 * The run stays pending — invisible and non-breaking — until a tool call,
	 * visible text, or finalize resolves it: emitted as one coalesced Thought
	 * entry if its total duration is meaningful, discarded otherwise. Zero/negative
	 * spans are dropped; `text` is "" when the provider streamed no thinking text.
	 */
	addThought(ms: number, text = ""): void {
		if (ms <= 0) return;
		this.pendingSpans.push({ ms, text });
	}

	/** An assistant text block started: nothing breaks yet; reset per-block state. */
	textStart(): void {
		this.brokeForBlock = false;
	}

	/** A text delta arrived: break the group on the first non-whitespace content. */
	textDelta(delta: string): void {
		if (!this.brokeForBlock && hasNonWhitespace(delta)) this.breakOnText();
	}

	/** A text block ended: break if it had non-empty content and hasn't broken yet
	 * (unchanged), then record it as a narration entry (ticket 41) \u2014 folded into
	 * the card in its chronological spot unless finalize() later finds it trailing
	 * (the true final answer, popped back out). Whitespace-only blocks record
	 * nothing, matching the existing no-break rule. */
	textEnd(content: string): void {
		if (!this.brokeForBlock && hasNonWhitespace(content)) this.breakOnText();
		if (hasNonWhitespace(content)) this.entries.push({ kind: "narration", text: content.trim() });
		this.brokeForBlock = false;
	}

	/** Close the open flow (resolve trailing thinking, close the open group) and
	 * return the full ordered entry sequence. If the trailing entry is narration
	 * (ticket 41), pop it out and return it as `finalAnswer` \u2014 it was never
	 * followed by anything, so it's the true final answer, not folded content. */
	finalize(): FinalizeResult<C> {
		this.resolvePending();
		this.closeGroup();
		const last = this.entries[this.entries.length - 1];
		if (last && last.kind === "narration") {
			const finalAnswer = last.text;
			this.entries = this.entries.slice(0, -1);
			return { entries: this.entries, finalAnswer };
		}
		return { entries: this.entries };
	}

	/** Discard all accumulated state (start a fresh agent response). */
	reset(): void {
		this.entries = [];
		this.currentCalls = [];
		this.pendingSpans = [];
		this.brokeForBlock = false;
	}

	/**
	 * Read the ordered entries accumulated so far WITHOUT resolving the pending
	 * thinking run or closing the open group. The open group is appended at the
	 * tail as a live group entry (ticket 21 rule 6 — the running group grows at the
	 * tail).
	 *
	 * Ticket 23 — pending thinking is now EXPOSED as a live thought entry at its
	 * chronological position (after the open group), but ONLY once the run's total
	 * duration crosses the threshold. The run = the ended-but-unresolved spans
	 * (`pendingSpans`) plus the optional in-progress `live` span. When it crosses,
	 * the trailing thought entry appears and the open group above it reads as
	 * closed (the thought sits after it, exactly like the final semantics of
	 * ticket 21); below the threshold the run stays hidden and the open group is
	 * the live tail. The entry keeps a STABLE top-level index across the live→
	 * settled transform: it is always the last entry, and once resolvePending()
	 * commits it at the same position no index before it shifts, so the card's
	 * thought node id survives the transform. Snapshots are deep copies so the live
	 * card never mutates the grouper's internal arrays.
	 */
	snapshot(live?: LiveThinking): Entry<C>[] {
		const out: Entry<C>[] = this.entries.map(cloneEntry);
		if (this.currentCalls.length > 0) out.push({ kind: "group", calls: [...this.currentCalls] });
		const spans: ThoughtSpan[] = this.pendingSpans.map((span) => ({ ...span }));
		if (live && live.ms > 0) spans.push({ ms: live.ms, text: live.text });
		const total = spans.reduce((sum, span) => sum + span.ms, 0);
		if (spans.length > 0 && total >= this.minThoughtMs) out.push({ kind: "thought", spans });
		return out;
	}

	/** Visible text closes the open group; a meaningful pending thinking run is
	 * resolved first so it still lands as an ordered entry before the break. */
	private breakOnText(): void {
		this.resolvePending();
		this.closeGroup();
		this.brokeForBlock = true;
	}

	/** Resolve the pending thinking run: emit it as its own Thought entry (after
	 * closing the open group) when its total duration is meaningful; discard it
	 * otherwise. Clears the pending run either way. */
	private resolvePending(): void {
		if (this.pendingSpans.length === 0) return;
		const total = this.pendingSpans.reduce((sum, span) => sum + span.ms, 0);
		if (total >= this.minThoughtMs) {
			this.closeGroup();
			this.entries.push({ kind: "thought", spans: this.pendingSpans });
		}
		this.pendingSpans = [];
	}

	/** Close the open group into an entry (if it has any calls). */
	private closeGroup(): void {
		if (this.currentCalls.length > 0) {
			this.entries.push({ kind: "group", calls: this.currentCalls });
			this.currentCalls = [];
		}
	}
}

/** Deep-copy one entry so a snapshot never shares the grouper's arrays. */
function cloneEntry<C>(entry: Entry<C>): Entry<C> {
	if (entry.kind === "thought") return { kind: "thought", spans: entry.spans.map((span) => ({ ...span })) };
	if (entry.kind === "narration") return { kind: "narration", text: entry.text };
	return { kind: "group", calls: [...entry.calls] };
}
