// Pure card-building logic (tickets 12 + 21), split out of index.ts (ticket 38):
// convert the grouper's ordered flow entries into renderable card data. No
// closure state — testable directly.

import {
	type CardEntry,
	coalesceThoughts,
	deriveThoughtSummary,
	type ShapeGroup,
	type ShapeItem,
	type ShapeNarration,
	type ShapeThought,
	toolGlyph,
} from "./card-shape.ts";
import type { Entry } from "./grouping.ts";
import {
	argsGist,
	asString,
	bucketCountsText,
	describeCall,
	describeCallIsGeneric,
	settledLabel,
	type ToolCallLike,
} from "./labels.ts";

/** One tool call accumulated during a response, with its live/settled fields. */
export interface ToolCall {
	toolCallId: string;
	name: string;
	arguments: Record<string, unknown>;
	startMs: number;
	endMs?: number;
	isError?: boolean;
	/** Trimmed last-N output preview for command/search calls (ticket 12 req 5). */
	resultPreview?: string[];
	/** Exit code parsed from a failed command's output (ticket 17 badge). */
	exitCode?: number;
	/** Full untruncated output for the modal (ticket 35): the whole tool_result
	 * text, bounded to MAX_MODAL_CAPTURE. When the command truncated its own output
	 * to a temp file, `fullOutputPath` points there and is read lazily on modal open
	 * (its content supersedes this). */
	fullOutput?: string;
	/** bash/powershell temp file holding the untruncated output when it truncated
	 * (BashToolDetails.fullOutputPath); read lazily when the modal opens. */
	fullOutputPath?: string;
}

export interface CardEntryBuild {
	entries: CardEntry[];
	settledIds: string[];
	failures: number;
}

export function toCallLike(call: ToolCall): ToolCallLike {
	return { name: call.name, arguments: call.arguments };
}

/** Build one renderable tool item from a ledger call (ticket 12). */
export function toShapeItem(call: ToolCall): ShapeItem {
	const running = call.endMs === undefined;
	const durMs = Math.max(0, (call.endMs ?? Date.now()) - call.startMs);
	const callLike = toCallLike(call);
	let label = describeCall(callLike);
	// Append an args gist only for a bare generic ("Used …") tool label — keyed off
	// the structured predicate, not the label's prose (ticket 37).
	if (describeCallIsGeneric(callLike)) {
		const gist = argsGist(callLike);
		if (gist) label = `${label} — ${gist}`;
	}
	const command = call.name === "bash" || call.name === "powershell" ? asString(call.arguments.command) : undefined;
	return {
		label,
		durMs,
		isError: Boolean(call.isError),
		running,
		preview: call.resultPreview ?? [],
		glyph: toolGlyph(call.name),
		command,
		exitCode: call.exitCode,
		fullOutput: call.fullOutput,
		fullOutputPath: call.fullOutputPath,
	};
}

/**
 * Convert the grouper's ordered top-level entries into renderable card data
 * (ticket 12 + 21). Each entry is either a group of consecutive tool calls or a
 * meaningful thinking run, kept IN EVENT ORDER: a group entry builds one
 * ShapeItem per call (a call with no end time is still running — spinner glyph,
 * req 2/3) and derives its collapsed label/count from the calls; a thought entry
 * coalesces its consecutive spans into one "· Thought Ns" row (total duration,
 * last meaningful summary, bounded tail). Thought text never appears at the
 * collapsed group level (ticket 21).
 */
export function buildCardEntries(entries: ReadonlyArray<Entry<ToolCall>>, liveThinkingActive = false): CardEntryBuild {
	const cardEntries: CardEntry[] = [];
	const settledIds: string[] = [];
	let failures = 0;

	for (const entry of entries) {
		if (entry.kind === "thought") {
			const thought = coalesceThoughts(entry.spans);
			const shapeThought: ShapeThought = { ms: thought.ms, summary: thought.summary, tail: thought.tail, fullText: thought.fullText };
			cardEntries.push({ kind: "thought", thought: shapeThought });
			continue;
		}
		if (entry.kind === "narration") {
			// Ticket 41: an intermediate assistant paragraph folded into the card because
			// something followed it (the true final answer never reaches here \u2014
			// Grouper.finalize() pops it out first). Reuse the thought summary deriver
			// (generic prose truncation, not thinking-specific).
			const summary = deriveThoughtSummary(entry.text) || "Message";
			const narration: ShapeNarration = { text: entry.text, summary };
			cardEntries.push({ kind: "narration", narration });
			continue;
		}
		const items: ShapeItem[] = [];
		for (const call of entry.calls) {
			if (call.isError) failures++;
			items.push(toShapeItem(call));
			settledIds.push(call.toolCallId);
		}
		const callLikes = entry.calls.map(toCallLike);
		const label = callLikes.length > 0 ? settledLabel(callLikes) : "";
		// The count suffix is only useful for multi-tool groups; a single-tool
		// group already names its target.
		const counts = callLikes.length > 1 ? bucketCountsText(callLikes) : "";
		const group: ShapeGroup = { label, counts, items };
		cardEntries.push({ kind: "group", group });
	}

	// Mark the trailing thought entry as live while a thinking span is still
	// streaming (ticket 23): the grouper always exposes the in-progress run as the
	// LAST snapshot entry, so its "Thinking… · Xs" row transforms in place to the
	// settled "Thought Ns · summary" once liveThinkingActive drops to false.
	if (liveThinkingActive) {
		const last = cardEntries[cardEntries.length - 1];
		if (last && last.kind === "thought") last.thought.live = true;
	}

	return { entries: cardEntries, settledIds, failures };
}

/** What settleResponse should do with a freshly-built card, given whether a live
 * card model already exists (ticket 38: the settle decision made pure + testable).
 *   - "freeze-empty": nothing renderable → freeze any live card collapsed;
 *   - "settle-live": mutate the existing live model in place;
 *   - "append-settled": no live card (tool-less response) → append a settled one. */
export type SettleAction = "freeze-empty" | "settle-live" | "append-settled";

/** Decide the settle action from the built entries + whether a live card exists.
 * Pure: the branching that settleResponse applies imperatively. */
export function settleAction(build: CardEntryBuild, hasLiveCard: boolean): SettleAction {
	const hasRenderable = build.entries.some((entry) => {
		if (entry.kind === "thought" || entry.kind === "narration") return true;
		return Boolean(entry.group.label || entry.group.items.length > 0);
	});
	if (!hasRenderable) return "freeze-empty";
	return hasLiveCard ? "settle-live" : "append-settled";
}
