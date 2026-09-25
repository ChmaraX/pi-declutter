// Pure card-building logic: convert the grouper's ordered flow entries into
// renderable card data. No closure state — testable directly.

import {
	type CardEntry,
	coalesceThoughts,
	deriveNarrationSummary,
	formatCallInput,
	MAX_CONTENT_CAPTURE,
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
	bodyKindOf,
	bucketCountsText,
	describeCall,
	describeCallIsGeneric,
	isCommandTool,
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
	/** Trimmed last-N output preview for command/search calls. */
	resultPreview?: string[];
	/** Exit code parsed from a failed command's output. */
	exitCode?: number;
	/** Full untruncated output for the modal: the whole tool_result text,
	 * bounded to MAX_MODAL_CAPTURE. When the command truncated its own output
	 * to a temp file, `fullOutputPath` points there and is read lazily on modal
	 * open (its content supersedes this). */
	fullOutput?: string;
	/** bash/powershell temp file holding the untruncated output when it truncated
	 * (BashToolDetails.fullOutputPath); read lazily when the modal opens. */
	fullOutputPath?: string;
	/** Display diff reported by a file-editing tool (EditToolDetails.diff),
	 * bounded at capture. */
	diff?: string;
	/** Pre-computed member label for SYNTHETIC calls (a provider tool step
	 * reconstructed from a thinking-channel dump, span-classify.ts) — there are
	 * no real args for describeCall to describe. */
	labelOverride?: string;
}

export interface CardEntryBuild {
	entries: CardEntry[];
	settledIds: string[];
	failures: number;
}

export function toCallLike(call: ToolCall): ToolCallLike {
	return { name: call.name, arguments: call.arguments };
}

/** Build one renderable tool item from a ledger call. */
export function toShapeItem(call: ToolCall): ShapeItem {
	const running = call.endMs === undefined;
	const durMs = Math.max(0, (call.endMs ?? Date.now()) - call.startMs);
	const callLike = toCallLike(call);
	let label = call.labelOverride ?? describeCall(callLike);
	// Append an args gist only for a bare generic ("Used …") tool label — keyed
	// off the structured predicate, not the label's prose. Never for a
	// synthetic call: its labelOverride already IS the whole story.
	if (call.labelOverride === undefined && describeCallIsGeneric(callLike)) {
		const gist = argsGist(callLike);
		if (gist) label = `${label} — ${gist}`;
	}
	const command = isCommandTool(call.name) ? asString(call.arguments.command) : undefined;
	// A file tool's own arguments say which file it touched and, for a write, what
	// went into it: the modal syntax-highlights both against that path.
	const isCode = bodyKindOf(call.name) === "code";
	const path = isCode ? (asString(call.arguments.path) ?? asString(call.arguments.file_path)) : undefined;
	const written = isCode ? asString(call.arguments.content) : undefined;
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
		diff: call.diff,
		path,
		content:
			written !== undefined && written.length > MAX_CONTENT_CAPTURE
				? `${written.slice(0, MAX_CONTENT_CAPTURE - 1)}\u2026`
				: written,
		// The `$ cmd` line IS a command tool's input, and a written file body is
		// shown as itself; everything else gets the pretty-printed args so the modal
		// is never empty.
		input: command === undefined && written === undefined ? formatCallInput(call.arguments) : undefined,
	};
}

/**
 * Convert the grouper's ordered top-level entries into renderable card data.
 * Each entry is either a group of consecutive tool calls or a meaningful
 * thinking run, kept IN EVENT ORDER: a group entry builds one ShapeItem per
 * call (a call with no end time is still running — spinner glyph) and derives
 * its collapsed label/count from the calls; a thought entry coalesces its
 * consecutive spans into one "· Thought Ns" row (total duration, last
 * meaningful summary, bounded tail). Thought text never appears at the
 * collapsed group level.
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
			// An intermediate assistant paragraph folded into the card because
			// something followed it (the true final answer never reaches here —
			// Grouper.finalize() pops it out first). Narration keeps a multi-line
			// prose budget — the renderer wraps it; … only after ~2-3 rows.
			const summary = deriveNarrationSummary(entry.text) || "Message";
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
	// streaming: the grouper always exposes the in-progress run as the LAST
	// snapshot entry, so its "Thinking… · Xs" row transforms in place to the
	// settled "Thought Ns · summary" once liveThinkingActive drops to false.
	if (liveThinkingActive) {
		const last = cardEntries[cardEntries.length - 1];
		if (last && last.kind === "thought") last.thought.live = true;
	}

	return { entries: cardEntries, settledIds, failures };
}

/** What settleResponse should do with a freshly-built card, given whether a
 * live card model already exists.
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
