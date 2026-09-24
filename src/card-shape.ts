/**
 * Pure render-shaping for the activity card (tickets 12 + 16).
 *
 * The activity card renders in its FINAL shape from the first tool call and
 * grows in place: while the response is live it shows "⟳ Working · Xs" with the
 * group rows accumulating underneath, and at settle only the header word/spinner
 * changes — no other layout shift (ticket 12 req 1). This module turns a plain,
 * render-ready model into an ordered list of styled lines; it carries no TUI or
 * pi-agent dependency, so it is unit-testable with plain objects
 * (test/card-shape.test.ts). The Component in src/index.ts maps each segment's
 * `tone` through the live Theme and prefixes `indent` spaces.
 *
 * Ticket 21 — the card is an ordered TOP-LEVEL sequence of Thought entries and
 * Group entries in true event order (Codex-only reference):
 *
 *   header (level 1)            Worked for Xs ▾        ← full-collapse toggle
 *     · Thought 4s · planning approach ▸  (thought entry) ← expandable box
 *     • Ran commands · 2 commands ▾   (group entry)     ← members toggle
 *        $ Ran git status (0.3s) ▾    (level 3 member)   ← output-box toggle
 *           ┌ Shell ───────┐         (level 4 box)      ← bordered box (ticket 17)
 *           │ $ git status     │
 *           └──── ✓ Success ┘
 *     · Thought 2s · checking output ▸
 *     $ Ran make test (4.0s) ▸        (singleton group)  ← member row directly
 *
 * A group entry is a run of consecutive tool calls; a thought entry is a
 * meaningful thinking run (grouper-coalesced total >= MIN_THOUGHT_MS). Thinking
 * separates groups: meaningful thinking (and visible text) closes the open group,
 * so thought entries sit BETWEEN groups in chronological order. Sub-threshold
 * thinking is dropped upstream (grouping.ts) and never reaches this module. No
 * thought text appears in a collapsed group row.
 *
 * Member rows carry a tool-family glyph mark (ticket 17 / toolGlyph); each
 * expandable node carries a chevron (`▸` collapsed / `▾` expanded) at the
 * END of its row (atlas anatomy). Expansion is per-node, supplied by the caller
 * via CardExpansion: the card is full-collapsed (header only) or in its default
 * view, each multi-member group entry independently shows/hides its members, each
 * member with output independently shows/hides its box, and each thought entry
 * independently shows/hides its "Thinking" box. Singleton groups render as the
 * member row directly (atlas U02); their chevron toggles the box.
 *
 * shapeCard returns `lines` AND a parallel `rowMap` (line index → node id) so
 * src/index.ts can resolve which node a mouse click landed on without the shape
 * logic leaking into the Component. Node ids are produced by HEADER_NODE /
 * groupNodeId / memberNodeId / thoughtNodeId and parsed back with parseNodeId.
 */

import { MIN_THOUGHT_MS } from "./grouping.ts";
import { toolTraitGlyph } from "./labels.ts";

// Re-exported so callers/tests keep importing the 1s thinking threshold from
// card-shape; grouping.ts owns it (it drives the group-breaking decision).
export { MIN_THOUGHT_MS };

/** Theme roles the Component knows how to colour (maps to Theme.fg/bold). */
export type Tone = "accent" | "bold" | "dim" | "muted" | "success" | "error" | "text";

/** One coloured run of text within a line. */
export interface Segment {
	text: string;
	tone: Tone;
}

export type LineKind = "header" | "group" | "thought" | "narration" | "item" | "preview";

/** One rendered line: `indent` leading spaces then the concatenated segments. */
export interface ShapeLine {
	kind: LineKind;
	indent: number;
	segments: Segment[];
	/** True when this is the mouse-hovered clickable row (ticket 24): the Component
	 * bolds it for a theme-consistent highlight. Only primary rows (header/group/
	 * thought/item) are ever marked — box/preview lines stay untouched. */
	hovered?: boolean;
}

// ── Node identity (tickets 16 + 21) ─────────────────────────────────────────────
// Stable string ids for the tree levels over the TOP-LEVEL entry sequence
// (ticket 21). The header is a single node; every top-level entry is addressed by
// its index k in the model's `entries`: a group entry is `g<k>` (members
// `g<k>.m<j>`), a thought entry is `t<k>`. The distinct `g`/`t` prefixes keep
// group and thought ids collision-free. Box (level 3) lines carry their owning
// member's id, so clicking a box line toggles (closes) it.

/** The card-level node: toggles full-collapse ↔ default. */
export const HEADER_NODE = "header";

/** Node id for the group entry at top-level index `k`: toggles its members. */
export function groupNodeId(k: number): string {
	return `g${k}`;
}

/** Node id for member `j` of the group entry at top-level index `k`: toggles its
 * output box. */
export function memberNodeId(k: number, j: number): string {
	return `g${k}.m${j}`;
}

/** Node id for the thought entry at top-level index `k` (ticket 21): toggles its
 * "Thinking" box. The `t` prefix keeps it collision-free from group ids. */
export function thoughtNodeId(k: number): string {
	return `t${k}`;
}

/** Node id for the narration entry at top-level index `k` (ticket 41): opens its
 * modal. The `n` prefix keeps it collision-free from group/thought ids. */
export function narrationNodeId(k: number): string {
	return `n${k}`;
}

/** A parsed node id: which level (and top-level entry / member index) a row is. */
export type ParsedNode =
	| { kind: "header" }
	| { kind: "group"; entryIndex: number }
	| { kind: "thought"; entryIndex: number }
	| { kind: "narration"; entryIndex: number }
	| { kind: "member"; entryIndex: number; itemIndex: number };

/** Inverse of the *NodeId helpers. Unknown ids resolve to the header (inert). */
export function parseNodeId(id: string): ParsedNode {
	const member = /^g(\d+)\.m(\d+)$/.exec(id);
	if (member) return { kind: "member", entryIndex: Number(member[1]), itemIndex: Number(member[2]) };
	const thought = /^t(\d+)$/.exec(id);
	if (thought) return { kind: "thought", entryIndex: Number(thought[1]) };
	const narration = /^n(\d+)$/.exec(id);
	if (narration) return { kind: "narration", entryIndex: Number(narration[1]) };
	const group = /^g(\d+)$/.exec(id);
	if (group) return { kind: "group", entryIndex: Number(group[1]) };
	return { kind: "header" };
}

/**
 * Per-node expansion state the caller supplies to shapeCard (tickets 16 + 21).
 * Kept as predicates so card-shape.ts stays decoupled from how src/index.ts
 * stores the state (Sets keyed by entry id). `fullCollapsed` hides everything but
 * the header (atlas G2); otherwise each multi-member group entry's members, each
 * member's box, and each thought entry's box are shown only when their predicate
 * returns true. All indices are TOP-LEVEL entry indices (ticket 21).
 */
export interface CardExpansion {
	fullCollapsed: boolean;
	isMembersVisible: (entryIndex: number) => boolean;
}

/** shapeCard output: styled lines plus a parallel line-index → node-id map. */
export interface ShapedCard {
	lines: ShapeLine[];
	/** rowMap[i] is the node id owning lines[i]; same length as `lines`. */
	rowMap: string[];
}

/** Chevron for an expandable node: ▾ when its children are shown, ▸ when hidden. */
export const CHEVRON_OPEN = "▾";
export const CHEVRON_CLOSED = "▸";

/** One tool call as the card renders it. */
export interface ShapeItem {
	/** Target label, e.g. "Read package.json" / "Ran git status". */
	label: string;
	durMs: number;
	isError: boolean;
	/** True while the call is still executing (no end time yet). */
	running: boolean;
	/** Output preview lines (already trimmed/truncated); empty when none. */
	preview: string[];
	/** Tool-family glyph for the member-row mark (ticket 17); see toolGlyph(). */
	glyph: string;
	/** Raw shell command for command-family tools: drives the modal's `$ cmd` line
	 * and the "Shell" caption. Undefined for non-command tools. */
	command?: string;
	/** Exit code extracted from a failed command's output (ticket 17 badge). */
	exitCode?: number;
	/** Full untruncated output text for the modal (ticket 35), bounded at capture;
	 * carried on the item so the modal works after the ledger is cleared and
	 * survives persistence. Undefined when nothing was captured. */
	fullOutput?: string;
	/** bash/powershell temp-file path holding the untruncated output when the
	 * command truncated it; read lazily when the modal opens (ticket 35). */
	fullOutputPath?: string;
	/** Pretty-printed call arguments for the modal's Input section (owner issue:
	 * MCP/extension tool modals opened with nothing in them). Undefined for
	 * command tools (the `$ cmd` line already IS the input) and empty args. */
	input?: string;
}

/** Character cap for a captured Input JSON \u2014 keeps persisted card data bounded
 * (huge tool args like whole file bodies get end-truncated). */
export const MAX_INPUT_CAPTURE = 4096;

/**
 * Pretty-print a tool call's arguments for the modal's Input section.
 * Returns undefined when there is nothing meaningful to show (no args, empty
 * object, or unserializable). Bounded to MAX_INPUT_CAPTURE.
 */
export function formatCallInput(args: Record<string, unknown> | undefined): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	if (Object.keys(args).length === 0) return undefined;
	try {
		const json = JSON.stringify(args, null, 2);
		if (!json || json === "{}") return undefined;
		return json.length > MAX_INPUT_CAPTURE ? `${json.slice(0, MAX_INPUT_CAPTURE - 1)}\u2026` : json;
	} catch {
		return undefined; // circular / bigint / hostile args: skip the section
	}
}

/**
 * One coalesced thought entry as the card renders it (ticket 21): total duration,
 * a one-line summary, and a bounded tail for the expandable "Thinking" box. Only
 * meaningful thinking runs (grouper-enforced total >= MIN_THOUGHT_MS) reach here.
 */
export interface ShapeThought {
	ms: number;
	/** One-line summary of the kept thinking span (ticket 20); "" when none. */
	summary: string;
	/** COMPACT preview only: last ~10 lines of the kept span's text, each
	 * end-truncated to MAX_PREVIEW_LINE_LEN (ticket 20). Drives the collapsed card
	 * row's glance view — NOT the modal. [] when none. */
	tail: string[];
	/** The kept span's RAW untruncated text (up to THINKING_BUF_MAX, the capture
	 * ceiling — no line/length capping). This is what the "Thinking" modal shows so
	 * long reasoning reads to its natural end (ticket 40). "" when none. */
	fullText: string;
	/**
	 * True while the underlying thinking span is still streaming (ticket 23). The
	 * row then renders "⟳ Thinking… · Xs" with the running spinner mark instead of
	 * the settled "· Thought Ns · <summary>"; the box (when expanded) shows the live
	 * text tail, refreshed by the tick. Only the row text/mark differ from the
	 * settled entry — same node id, same indent — so expansion state survives the
	 * in-place live→settled transform.
	 */
	live?: boolean;
}

/** A maximal run of consecutive tool calls, as the card renders it. Thinking is
 * NOT nested here (ticket 21) — it lives as its own top-level entry. */
export interface ShapeGroup {
	/** Settled verb-phrase label ("Read files, ran commands"). */
	label: string;
	/** Bucket count summary ("3 files, 2 commands"); "" for a single-tool group. */
	counts: string;
	items: ShapeItem[];
}

/**
 * A narration entry as the card renders it (ticket 41): an intermediate
 * assistant text block that turned out NOT to be the final answer (something
 * followed it), so it folds into the card in its chronological spot instead of
 * floating in the transcript as a separate paragraph. `summary` is a truncated
 * one-line label for the row; `text` is the full content the modal shows.
 */
export interface ShapeNarration {
	text: string;
	summary: string;
}

/**
 * One top-level entry in the card's ordered flow (ticket 21): a group of
 * consecutive tool calls, a coalesced meaningful thinking run, or a narration
 * text block (ticket 41), interleaved in true event order.
 */
export type CardEntry =
	| { kind: "group"; group: ShapeGroup }
	| { kind: "thought"; thought: ShapeThought }
	| { kind: "narration"; narration: ShapeNarration };

/** Every narration entry's full text from a card's entries, in order (ticket 41).
 * Used to re-identify (by content, since object identity is gone) which native
 * text blocks a full transcript rebuild \u2014 compaction, /resume, /fork \u2014 must have
 * its hides re-applied to, so a previously-folded paragraph doesn't reappear
 * natively just because the tree was rebuilt from the original, un-blanked
 * stored messages (hideMessageTextBlock never touches what's persisted). */
export function narrationTexts(entries: readonly CardEntry[]): string[] {
	const out: string[] = [];
	for (const entry of entries) if (entry.kind === "narration") out.push(entry.narration.text);
	return out;
}

/** True when a thought entry carries an expandable "Thinking" box (captured tail). */
export function thoughtHasBox(thought: ShapeThought): boolean {
	return thought.tail.length > 0;
}

/**
 * True when a group entry renders a level-2 group row with a members toggle: it
 * holds more than one tool call. A single-tool group renders as the member row
 * directly (atlas U02, ticket 21 rule 7).
 */
export function groupHasMembersToggle(group: ShapeGroup): boolean {
	return group.items.length > 1;
}

export interface CardShapeModel {
	/** True while the response is active — render "⟳ Working ·"; else "▸/▾ Worked for". */
	live: boolean;
	/** Elapsed so far while live, or total worked time once settled. */
	elapsedMs: number;
	failures: number;
	/** Ordered top-level flow: group + thought entries in event order (ticket 21). */
	entries: CardEntry[];
	/**
	 * True when the settled duration is unknown (ticket 25 layer 3): a persisted
	 * snapshot that was saved mid-response (live:true, workedMs 0) renders
	 * "Worked for —" instead of a bogus "Worked for 0s". Only consulted on the
	 * settled header (never while live).
	 */
	unknownDuration?: boolean;
	/**
	 * True when the card was FORCE-SETTLED on an abnormal end (ticket 32): a stream
	 * error or a user abort (Esc) ended the response without a clean agent_settled,
	 * so the settled header shows "Worked for Xs · interrupted" (dim/warn tone)
	 * instead of pretending completion. Only consulted on the settled header.
	 */
	interrupted?: boolean;
}

/**
 * Tool-family glyph for a member-row mark (ticket 17 G4, atlas "Row anatomy").
 * One clean single-width glyph per family, rendered theme-dim by the Component:
 *   shell (bash/powershell) `$`, read `▤`, search/grep `⌕`, list/find `≡`,
 *   edit/write `✎`, generic tool `◆`. Chevrons use ▸/▾ so none are reused here.
 */
export function toolGlyph(toolName: string): string {
	return toolTraitGlyph(toolName);
}

/** Braille spinner frames for a currently-running row (ticket 12 req 2/3) AND the
 * live header (ticket 36). These are pi's OWN composer working-indicator frames
 * verbatim — `DEFAULT_FRAMES` in pi-tui `dist/components/loader.js` — so the card
 * header spins identically to the working bar below the editor
 * (`WorkingStatusIndicator` → `Loader`, no custom indicator ⇒ these defaults). All
 * ten are single-cell (East-Asian width Narrow), so swapping them frame-to-frame
 * never shifts the row-map line widths. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
/** pi's spinner frame interval (`DEFAULT_INTERVAL_MS` in pi-tui loader.js). The
 * header/row frame index is derived from `Date.now()` at this cadence so it
 * matches the working bar; pi's own 80 ms working-indicator renders drive our
 * card `render()` for free while it animates (ticket 36). */
export const SPINNER_INTERVAL_MS = 80;
/** Current spinner frame for a wall-clock instant (pure, testable): pi advances
 * one frame every `SPINNER_INTERVAL_MS`, cycling the ten braille glyphs. */
export function spinnerFrame(nowMs: number): string {
	return SPINNER_FRAMES[Math.floor(nowMs / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
}
/** Max characters of a thought-row summary (ticket 20 rule 1). */
export const MAX_THOUGHT_SUMMARY_LEN = 48;
/** Max lines shown in an expanded "Thinking" box (ticket 20 rule 1, bounded tail). */
export const MAX_THOUGHT_TAIL = 10;
/** Output preview: last N lines of a command/search result (ticket 12 req 5,
 * bumped to ~8 tail lines in ticket 17). Still capped/trimmed at capture time. */
export const MAX_PREVIEW_LINES = 8;
/** Truncate each preview line to this many characters. */
export const MAX_PREVIEW_LINE_LEN = 120;

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

export function formatSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Last ~N non-empty lines of a tool result's text, each truncated. Pure: used
 * to build ShapeItem.preview for command/search calls (ticket 12 req 5).
 */
export function previewLines(text: string, maxLines = MAX_PREVIEW_LINES): string[] {
	if (!text) return [];
	// Drop trailing blank lines so the preview ends on real output.
	const lines = text.replace(/\s+$/, "").split("\n");
	const tail = lines.slice(Math.max(0, lines.length - maxLines));
	return tail.map((line) => {
		const trimmed = line.replace(/\t/g, "  ");
		return trimmed.length > MAX_PREVIEW_LINE_LEN ? `${trimmed.slice(0, MAX_PREVIEW_LINE_LEN - 1)}…` : trimmed;
	});
}

// ── Thinking coalescing (ticket 20) ────────────────────────────────────────────
// A group can hold several bursty thinking spans (some sub-second — ticket 06
// finding 3). We coalesce their durations into one "· Thought Ns" row, and derive
// its summary + expandable box from a single kept span (the LAST span that is
// itself >= MIN_THOUGHT_MS with real text — matches how the native compact view
// keeps the latest summary title). Sub-second spans still count toward the total
// duration but never supply the summary. Pure so index.ts and tests share it.

/** One captured thinking span: self-timed ms + the text streamed for it. */
export interface ThoughtSpanInput {
	ms: number;
	text: string;
}

/** Coalesced thinking for one group: total ms, a one-line summary, a compact box
 * tail (glance view), and the raw untruncated text for the modal (ticket 40). */
export interface CoalescedThought {
	ms: number;
	summary: string;
	tail: string[];
	fullText: string;
}

/**
 * First meaningful line of a thinking span, stripped of markdown emphasis /
 * heading / bullet markers and end-truncated to MAX_THOUGHT_SUMMARY_LEN
 * (ticket 20 rule 1). Providers stream reasoning as bold summary titles
 * (e.g. "**Comparing LRU cache data structures**"); this yields the clean
 * "Comparing LRU cache data structures". "" when the span carried no text.
 */
export function deriveThoughtSummary(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw
			.replace(/[*_`]+/g, "") // markdown emphasis / inline-code markers
			.replace(/^\s*#+\s*/, "") // heading hashes
			.replace(/^\s*[>\-]\s*/, "") // blockquote / bullet
			.trim();
		if (line) return truncateEnd(line, MAX_THOUGHT_SUMMARY_LEN);
	}
	return "";
}

/** Character budget for a narration row's inline summary \u2014 roughly 2\u20133 wrapped
 * terminal rows at common widths before the \u2026 cut (owner request: don't clip to
 * one line; wrap first, truncate only after a few lines). */
export const MAX_NARRATION_SUMMARY_LEN = 240;

/**
 * Narration summary (ticket 41): unlike a thought summary (one dim metadata
 * line), a narration row IS the assistant's prose \u2014 keep much more of it.
 * Collapse all whitespace runs (newlines included) to single spaces so the
 * renderer's natural Text wrapping flows it as a paragraph, strip the same
 * markdown noise as thought summaries, and end-truncate at
 * MAX_NARRATION_SUMMARY_LEN. Click still opens the full text in the modal.
 */
export function deriveNarrationSummary(text: string): string {
	const collapsed = text
		.replace(/[*_`]+/g, "")
		.replace(/^\s*#+\s*/gm, "")
		.replace(/^\s*[>\-]\s*/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	return truncateEnd(collapsed, MAX_NARRATION_SUMMARY_LEN);
}

/**
 * Coalesce a group's thinking spans (ticket 20 rules 1 + 3): sum every span's
 * duration, then take the LAST span that is itself >= MIN_THOUGHT_MS and carries
 * text as the source for the summary + box tail. When no such span exists (all
 * sub-second, or none streamed text) the summary/tail are empty — the row then
 * degrades to a bare "· Thought Ns" with no chevron.
 */
export function coalesceThoughts(spans: readonly ThoughtSpanInput[]): CoalescedThought {
	let ms = 0;
	let chosen: ThoughtSpanInput | undefined;
	const texts: string[] = [];
	for (const span of spans) {
		ms += Math.max(0, span.ms);
		if (span.text.trim()) texts.push(span.text.trim());
		if (span.ms >= MIN_THOUGHT_MS && span.text.trim()) chosen = span; // last wins
	}
	return {
		ms,
		summary: chosen ? deriveThoughtSummary(chosen.text) : "",
		tail: chosen ? previewLines(chosen.text, MAX_THOUGHT_TAIL) : [],
		// EVERY span's text in stream order, not just the chosen one (owner bug:
		// providers that stream reasoning as many small spans \u2014 Cursor \u2014 had all
		// but the last span silently dropped from the modal, and the content
		// appeared to be "overwritten" as each new span replaced it). Summary/tail
		// stay chosen-span (the glance view); the modal shows the whole run.
		// Per-span text is bounded at capture (THINKING_BUF_MAX); the join is
		// capped here as a final guard.
		fullText: texts.join("\n\n").slice(0, MAX_THOUGHT_FULLTEXT),
	};
}

/** Cap for a coalesced thought's joined full text (modal body). */
export const MAX_THOUGHT_FULLTEXT = 65536;

function seg(text: string, tone: Tone): Segment {
	return { text, tone };
}

/**
 * Leading mark for a member row (ticket 17 — atlas "Row anatomy"): the
 * tool-family glyph, theme-dim and consistent; a spinner while the call runs.
 * Success/failure moves to the output-box badge + the header failure count, so
 * the row carries one clean glyph (atlas shows no per-row ✓/✗).
 */
function itemMark(item: ShapeItem, spinner: string): Segment {
	if (item.running) return seg(spinner, "accent");
	return seg(item.glyph, "dim");
}

function itemText(item: ShapeItem): string {
	return item.running ? item.label : `${item.label} (${formatSeconds(item.durMs)})`;
}

/** Chevron segment (` ▸`/` ▾`) appended to an expandable row. */
function chevron(open: boolean): Segment {
	return seg(` ${open ? CHEVRON_OPEN : CHEVRON_CLOSED}`, "muted");
}

/** The "openable" affordance on a row whose content opens the floating modal
 * (ticket 35): a static closed chevron. It signals the row is clickable to open
 * its output/thinking overlay — there is no inline box to toggle anymore. */
function openableChevron(): Segment {
	return seg(` ${CHEVRON_CLOSED}`, "muted");
}

/**
 * The node id at visual row `rowIndex` of a card's expanded row-map, or undefined
 * when the row is outside the card's rows (ticket 24). Pure: the mouse layer uses
 * it to resolve which node a motion/hover landed on (undefined = off the card =
 * clear hover / leave). Shared with tests so the resolution + out-of-range guard
 * are locked without a live terminal.
 */
export function hoveredNodeAt(rowMap: readonly string[], rowIndex: number): string | undefined {
	return rowIndex >= 0 && rowIndex < rowMap.length ? rowMap[rowIndex] : undefined;
}

/**
 * Highlight the hovered clickable row (ticket 24). Pure decision over the built
 * lines + rowMap: every PRIMARY row line (header/group/thought/item) whose node
 * id === `hoveredNode` gets `hovered` set and its trailing chevron bumped to
 * `accent`; box/preview lines (kind "preview") are left untouched so only the
 * clickable row lights up, not its expanded body. No-op when `hoveredNode` is
 * undefined (mouse disabled, or the cursor is off this card).
 */
function applyHover(lines: ShapeLine[], rowMap: readonly string[], hoveredNode: string | undefined): void {
	if (!hoveredNode) return;
	for (let i = 0; i < lines.length; i++) {
		if (rowMap[i] !== hoveredNode || lines[i].kind === "preview") continue;
		lines[i].hovered = true;
		const segments = lines[i].segments;
		const last = segments[segments.length - 1];
		if (last && (last.text === ` ${CHEVRON_OPEN}` || last.text === ` ${CHEVRON_CLOSED}`)) {
			last.tone = "accent";
		}
	}
}

/**
 * Shape the whole card into the four-level tree (ticket 16), returning the styled
 * lines AND a parallel node-id row-map for mouse resolution. `expansion` selects
 * which nodes are open; `spinner` is the current animation frame for any running
 * row; `hoveredNode` (ticket 24) is the node id under the mouse, whose primary
 * row is highlighted. The live and settled views share this one function — only
 * the header word/spinner and a running row's glyph differ (ticket 12 req 1).
 */
export function shapeCard(model: CardShapeModel, expansion: CardExpansion, spinner: string, hoveredNode?: string): ShapedCard {
	const lines: ShapeLine[] = [];
	const rowMap: string[] = [];
	const push = (node: string, line: ShapeLine): void => {
		lines.push(line);
		rowMap.push(node);
	};

	// ── Header (level 1): full-collapse toggle; chevron at the end (atlas). ──
	const header: Segment[] = [];
	if (model.live) {
		// Animated braille spinner (ticket 36) — the SAME frame pi's composer working
		// bar shows, so the card header and the bar spin in lockstep; `spinner` is the
		// current frame (spinnerFrame(Date.now()) in index.ts).
		header.push(seg(spinner, "accent"), seg(` Working · ${formatDuration(model.elapsedMs)}`, "bold"));
	} else {
		// Graceful stale render (ticket 25): a resumed snapshot with no recorded
		// duration shows "—" rather than a misleading "0s".
		const dur = model.unknownDuration ? "—" : formatDuration(model.elapsedMs);
		header.push(seg(`Worked for ${dur}`, "bold"));
	}
	if (model.failures > 0) header.push(seg(` · ${model.failures} failed`, "error"));
	// Abnormal-end marker (ticket 32): a force-settled card (stream error / user
	// abort) says "· interrupted" in a calm dim tone instead of pretending clean
	// completion. Only on the settled header — a live card never shows it.
	if (!model.live && model.interrupted) header.push(seg(" · interrupted", "muted"));
	header.push(chevron(!expansion.fullCollapsed));
	push(HEADER_NODE, { kind: "header", indent: 0, segments: header });

	// Full-collapse hides everything below the header (atlas G2).
	if (expansion.fullCollapsed) {
		applyHover(lines, rowMap, hoveredNode);
		return { lines, rowMap };
	}

	// Render one tool member row. `k` is the owning group entry's top-level index,
	// `j` the member index within that group. A member with box-worthy content
	// (command / output / failure) is clickable to OPEN THE OUTPUT MODAL (ticket 35)
	// — the inline box is gone, so the row carries an "openable" chevron (▸) as the
	// affordance; clicking dispatches the member node, which index.ts opens as a
	// floating overlay instead of toggling an inline box.
	const pushTool = (k: number, j: number, item: ShapeItem, indent: number, kind: LineKind): void => {
		const memberNode = memberNodeId(k, j);
		const segments: Segment[] = [itemMark(item, spinner), seg(` ${itemText(item)}`, "dim")];
		if (itemHasBox(item)) segments.push(openableChevron());
		push(memberNode, { kind, indent, segments });
	};

	// Walk the ordered top-level entry sequence (ticket 21): thought entries and
	// group entries render in true event order, each addressed by its index k.
	model.entries.forEach((entry, k) => {
		// Thought entry: "· Thought Ns · <summary> ▸", expandable to its "Thinking" box.
		// Only meaningful runs reach here (the grouper drops sub-threshold thinking).
		if (entry.kind === "thought") {
			const thought = entry.thought;
			const thoughtNode = thoughtNodeId(k);
			// Live entry (ticket 23): a spinner mark + "Thinking… · Xs" (no summary yet);
			// at close it transforms in place to "· Thought Ns · <summary>" — same node,
			// same indent, so only the row text/mark change (no layout jump).
			const segments: Segment[] = thought.live
				? [seg(spinner, "accent"), seg(` Thinking… · ${formatDuration(thought.ms)}`, "dim")]
				: [seg(`· Thought ${formatDuration(thought.ms)}`, "dim")];
			if (!thought.live && thought.summary) segments.push(seg(` · ${thought.summary}`, "muted"));
			// A settled thought with captured text is clickable to open the Thinking
			// modal (ticket 35); live entries have no stable box yet.
			if (!thought.live && thoughtHasBox(thought)) segments.push(openableChevron());
			push(thoughtNode, { kind: "thought", indent: 2, segments });
			return;
		}

		// Narration entry (ticket 41): "\u203a <summary> \u25b8", clickable to open the full
		// text in a modal \u2014 always openable, since a narration entry only ever exists
		// when it captured non-whitespace text. The summary reads as NORMAL body text
		// (theme "text" role, owner request) \u2014 it IS the assistant's prose, folded, not
		// metadata like the dim thought/duration rows around it.
		if (entry.kind === "narration") {
			const narrationNode = narrationNodeId(k);
			const segments: Segment[] = [seg("\u203a", "dim"), seg(` ${entry.narration.summary}`, "text"), openableChevron()];
			push(narrationNode, { kind: "narration", indent: 2, segments });
			return;
		}

		// Group entry (only remaining case here \u2014 TS narrows CardEntry to "group"
		// after the thought/narration early returns above).
		const group = entry.group;
		const groupNode = groupNodeId(k);
		const running = group.items.some((item) => item.running);

		// Singleton tool group (level 2≡3): render the member row directly (atlas U02,
		// ticket 21 rule 7). Its chevron toggles the output box when it has one.
		if (group.items.length === 1) {
			pushTool(k, 0, group.items[0], 2, "group");
			return;
		}

		// Multi-member group row (level 2): chevron toggles its members.
		const membersOpen = expansion.isMembersVisible(k);
		const glyph: Segment = running ? seg(spinner, "accent") : seg("•", "muted");
		const groupSegs: Segment[] = [glyph, seg(` ${group.label}`, "muted")];
		if (group.counts) groupSegs.push(seg(` · ${group.counts}`, "dim"));
		groupSegs.push(chevron(membersOpen));
		push(groupNode, { kind: "group", indent: 2, segments: groupSegs });
		if (!membersOpen) return;

		// Member rows (level 3): each with output gets a chevron toggling its box.
		group.items.forEach((item, j) => pushTool(k, j, item, 4, "item"));
	});

	applyHover(lines, rowMap, hoveredNode);
	return { lines, rowMap };
}

/**
 * Expand a logical row-map (one entry per shape line) into VISUAL-row space
 * (ticket 16 fix). Mouse clicks arrive in wrapped visual rows, but shapeCard
 * indexes rowMap by logical shape line; a wide box/command line can wrap to ≥2
 * visual rows on a narrow terminal, which would otherwise shift every node below
 * it. `heights[i]` is the number of rendered rows shape line i occupies at the
 * render width (measured by the Component, which owns the width and wrapping).
 * Each line's node id repeats once per rendered row; a 0-height line contributes
 * nothing (matches the Box container, which pushes no lines for an empty child).
 */
export function expandRowMapToVisual(rowMap: readonly string[], heights: readonly number[]): string[] {
	const visual: string[] = [];
	for (let i = 0; i < rowMap.length; i++) {
		const height = heights[i] ?? 0;
		for (let row = 0; row < height; row++) visual.push(rowMap[i]);
	}
	return visual;
}

// ── Output helpers (ticket 17 badge/capture, ticket 35 modal) ──────────────────
// The inline bordered output box was removed in ticket 35 (clicking a row now
// opens a floating modal instead). What survives here is the pure content logic
// the modal and capture path still need: end-truncation, the box-worthy
// predicate, capture cleaning, and the status badge.

/** End-truncate to `max` display cells, appending `…` when it overflows. */
export function truncateEnd(text: string, max: number): string {
	const chars = [...text];
	if (chars.length <= max) return text;
	return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/**
 * A member has openable output-modal content when it has a command OR output
 * (ticket 17) — and also whenever it failed (ticket 18). A failed call with no
 * box-worthy output (e.g. a failed read/edit or a failed MCP tool) otherwise
 * has no affordance, so its only failure signal is the header count; making it
 * openable keeps the `Exit code N` / `✗ Failed` badge discoverable in the modal,
 * matching Codex's "failure = badge, no red ✗ row" style.
 */
export function itemHasBox(item: ShapeItem): boolean {
	return item.command !== undefined || item.preview.length > 0 || item.isError;
}

/**
 * Clean a captured output tail (ticket 19). Two fixes for the noise seen in
 * failed-command output: (1) when the exit code is known (`exitCode` set), strip
 * a trailing `Command exited with code N` line that repeats it — the shell tool
 * throws that text on a non-zero exit, so it lands in the captured output and
 * duplicates the badge; (2) drop any trailing blank lines it leaves behind so the
 * body ends on real output. Pure so index.ts and tests share one rule.
 */
export function boxTail(preview: readonly string[], exitCode?: number): string[] {
	const lines = [...preview];
	const trimTrailingBlanks = (): void => {
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	};
	trimTrailingBlanks();
	if (exitCode !== undefined && lines.length > 0) {
		const match = /^\s*Command exited with code (\d+)\s*$/.exec(lines[lines.length - 1]);
		if (match && Number(match[1]) === exitCode) {
			lines.pop();
			trimTrailingBlanks();
		}
	}
	return lines;
}

/**
 * Status badge for an output modal (atlas): success, a captured exit code, or a
 * generic failure when no exit code is available. Pure so index.ts, the modal,
 * and tests share one rule.
 */
export function itemBadge(item: ShapeItem): { text: string; tone: Tone } {
	if (!item.isError) return { text: "✓ Success", tone: "success" };
	if (item.exitCode !== undefined) return { text: `Exit code ${item.exitCode}`, tone: "error" };
	return { text: "✗ Failed", tone: "error" };
}
