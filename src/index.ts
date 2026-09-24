/**
 * pi-activity-feed — v1 extension.
 *
 * Renders agent activity (tool calls + thinking) the way the Codex/Cursor GUI
 * apps do, using only supported pi extension APIs (no monkey-patching, no prompt
 * injection):
 *
 *   • Built-in tool rows (read/bash/edit/write/grep/find/ls) are re-registered
 *     with the built-in execution preserved (we spread the exported
 *     create*ToolDefinition factory and override ONLY renderCall/renderResult):
 *     while a call runs its row is a single compact dim line; once the call is
 *     absorbed into a settled card the row renders ZERO lines and vanishes
 *     (renderShell:"self" ⇒ empty content collapses the whole component,
 *     ticket 01 §6.10). MCP/custom tool rows are left alone (other extensions
 *     own them) but are still counted in the card.
 *   • The activity card is the LIVE surface (Cursor behaviour, ticket 11): it is
 *     appended EARLY — on the FIRST tool_execution_start of a response — so it
 *     lands ABOVE the streamed answer text (appendEntry inserts before the live
 *     streaming component; the final answer arrives in a later message appended
 *     below the card). It renders in its FINAL SHAPE from that first tool and
 *     grows in place (ticket 12): a ticking header "⟳ Working · Xs" with group
 *     rows accumulating underneath (live bucket counts, a spinner on a running
 *     call). The whole shape — live and settled — is produced by the pure
 *     shapeCard() in src/card-shape.ts; ActivityCard just colours its segments.
 *     render() reads a mutable card model each frame and a captured
 *     tui.requestRender() (widget-factory trick, research §3) ticks it. There is
 *     no separate live widget panel; the native working message
 *     (setWorkingMessage) still mirrors the bucket counter next to the editor.
 *   • Thinking is part of the card's ORDERED FLOW (tickets 20 + 21): the card is
 *     a top-level sequence of Group entries and Thought entries in event order.
 *     A group is a run of consecutive tool calls; MEANINGFUL thinking (a run of
 *     consecutive spans totalling >= MIN_THOUGHT_MS) closes the open group and
 *     becomes its own Thought entry BETWEEN groups — so think→tools→think→tool
 *     renders in exactly that order. Sub-threshold thinking is ignored entirely
 *     (does not break a group, does not render), which absorbs the bursty 1–4 ms
 *     spans (spike finding 3). A Thought entry shows "· Thought Ns · <summary> ▸"
 *     (span text captured via message_update thinking_delta, bounded ~2KB/span,
 *     coalesced) and expands to a bordered "Thinking" box (captured tail, no
 *     badge). Thinking is also LIVE like tool rows (ticket 23): once an in-progress
 *     span exceeds MIN_THOUGHT_MS the grouper exposes it in snapshot() as a
 *     trailing live thought entry "⟳ Thinking… · Xs ▸" at its chronological position
 *     (closing the open group), ticked by the live timer; at thinking_end the SAME
 *     entry (stable node id) transforms in place to "· Thought Ns · <summary> ▸",
 *     and when expanded mid-stream its box shows the live text tail (thinkingBuf
 *     referenced live, copied to a bounded tail only at close). Native thinking
 *     rendering is suppressed with supported levers only
 *     — a markdown transformer that blanks "assistant-thinking" (streaming +
 *     settled) plus setHiddenThinkingLabel("") for the ctrl+t-hidden placeholder
 *     — so thinking never appears twice.
 *   • At agent_settled the SAME entry settles in place: ONLY the header changes
 *     to "▸ Worked for Xs" (anchored on the FIRST turn_start of the response) and
 *     the ticking stops — no other layout shift (ticket 12). The card keeps its
 *     settled group labels accumulated across all its turns, ordered
 *     "Thought Ns" entries, and a failure count in the header (a deliberate
 *     deviation from Codex — ticket 18 — the one failure signal that survives
 *     the collapsed state). Failures do NOT auto-expand (Codex-faithful,
 *     ticket 18); the per-call signal is the output-box badge. After settle the
 *     model is frozen (renders identical output), so no further repaints touch it.
 *   • The card is a four-level tree with PER-NODE expansion (ticket 16, atlas
 *     G1+G2): header → group rows → member rows → output box, each with a
 *     chevron (▸ collapsed / ▾ expanded). A left-click on the header cycles
 *     full-collapse ↔ default; a click on a group row toggles its members; a
 *     click on a member row toggles its output box (box body = the preview lines
 *     until ticket 17). Clicks are ON by default (opt out with
 *     --no-activity-mouse); shapeCard returns a parallel row-map (line → node id)
 *     so onCardMouse resolves the clicked node. The keyboard shortcut
 *     (ctrl+shift+a) is the fallback: it cycles the NEWEST card through
 *     full-collapse → default → all-expanded → back. Regular mode has no native
 *     mouse routing, so we enable SGR mouse reporting, parse the click packets
 *     from onTerminalInput, and synthesize a dispatch into the retained tree;
 *     fullscreen routes clicks natively via MouseRegion (ticket 09).
 *
 * Design provenance: tickets 01 (API), 02 (grouping), 03 (lifecycle),
 * 05 (label heuristics), 06 (live spike — ported patterns below),
 * 08 (absorb built-in rows + one card per response),
 * 11 (card above the answer), 12 (final card shape + previews),
 * 16 (four-level tree with per-node expansion + full-collapse state),
 * 18 (Codex-faithful failure handling: no auto-expand, failure = box badge),
 * 20 (thinking absorbed into the card stack: expandable Thought rows +
 * supported-lever native suppression).
 *
 * Ticket 08: the owner tested v1 interactively and overturned two ticket-03
 * defaults — raw green built-in tool rows staying visible, and one card per
 * turn. This version absorbs the built-in rows and emits one card per response.
 *
 * Key constraints honoured (from ticket 06 findings):
 *   - Tool lifecycle events carry no timestamps → durations are self-measured
 *     (Date.now() at start → end), keyed by toolCallId.
 *   - "Worked for Xs" anchors on turn_start.timestamp → Date.now().
 *   - Groups break only on assistant text with non-whitespace content (ticket
 *     10); empty/whitespace text blocks, thinking, and turn boundaries do NOT
 *     break, so sequential tool-only turns stay one group. The boundary logic is
 *     the pure, unit-tested Grouper in src/grouping.ts.
 *   - Thinking spans are bursty (some 1–4 ms) → a consecutive run coalesces into
 *     one "Thought Ns" entry, and runs whose total is sub-1s are ignored
 *     entirely (no entry, no group break) — ticket 21.
 *   - turn_end AND agent_settled both fire → settle is idempotent.
 *   - Everything that touches UI is guarded by ctx.mode === "tui" && ctx.hasUI;
 *     it no-ops cleanly in print mode (which emits no tool events anyway).
 */

import type {
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	MessageEndEvent,
	MessageStartEvent,
	CustomEntry,
	EntryRenderOptions,
	ExtensionAPI,
	ExtensionContext,
	MessageUpdateEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	Theme,
	ToolDefinition,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	MouseRegion,
	Text,
	type TUI,
	type TuiMainScreenRenderState,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import {
	type CardExpansion,
	type CardModel,
	type CardShapeModel,
	expandRowMapToVisual,
	groupHasMembersToggle,
	hoveredNodeAt,
	narrationTexts,
	parseNodeId,
	type PersistedCardData,
	previewLines,
	shapeCard,
	shouldReappendCard,
	staleCardShapeModel,
	type ShapeItem,
	spinnerFrame,
	suppressThinkingMarkdown,
} from "./card-shape.ts";
import { Grouper, hasNonWhitespace, shouldTick } from "./grouping.ts";
import { classifyThinkingSpan } from "./span-classify.ts";
import {
	acquireToolRowHidePatch,
	dumpTranscriptTree,
	findAssistantMessageComponents,
	hideMessageTextBlock,
	type PatchTargetInstance,
	rehideNarrationAfterRebuild,
	restoreMessageTextBlock,
} from "./patches.ts";
import { PatchController } from "./patch-controller.ts";
import { isSgrLeftPress, isSgrMotion, type MousePacket, parseSgrMousePackets } from "./mouse.ts";
import { bucketCountsText } from "./labels.ts";

import { OutputModal } from "./modal-view.ts";
import { styleLine } from "./styling.ts";
import { ModalController } from "./modal-controller.ts";
import { buildCardEntries, settleAction, type ToolCall, toCallLike } from "./card-build.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

const CARD_TYPE = "activity-feed-summary";
const TOGGLE_SHORTCUT = "ctrl+shift+a" as const;
// The toggle shortcut used to print a persistent "Activity feed: <state>" line
// into the transcript via notify() (ticket 19 noise): the chevron change is the
// real feedback. Echo the new state on a transient, keyed footer status instead
// and clear it after a moment so nothing sticks in the transcript.
const TOGGLE_STATUS_KEY = "activity-feed-toggle";
const TOGGLE_STATUS_MS = 2000;
// Live tick capped at 500ms (ticket 11 / research §3 limits): while the live card
// is still in the bottom viewport this is a cheap differential repaint, but once
// it scrolls above the viewport each tick forces a full redraw that wipes native
// scrollback — a low cadence bounds that cost. The timer only runs while tools
// are executing OR a thinking span is active (ticket 23 shouldTick) — the
// windows the card mutates.
const LIVE_TICK_MS = 500;
// The card is rendered inside a Box with vertical padding 1, so its first content
// line (the header) sits at rendered index 1. A click's card-local y maps to a
// visual row by subtracting this top padding (ticket 16 mouse mapping).
const CARD_BOX_PADDING_Y = 1;
// The same Box has horizontal padding 1 (new Box(1, 1, …)); each child Text is
// rendered at width − 2×this, which is where line wrapping happens. The row-map is
// expanded into that wrapped space in ActivityCard.render so clicks on a card whose
// lines wrap still resolve to the right node (reviewer P1).
const CARD_BOX_PADDING_X = 1;
// Tool families whose result output we surface as an expanded preview (ticket 12
// req 5): commands and searches. read/edit/write are skipped (their target line
// already says everything useful, and file bodies would be huge).
const PREVIEW_TOOLS = new Set(["bash", "powershell", "grep", "find", "ls"]);
// Per-thinking-span capture cap (ticket 20): ~2KB is enough for the summary line
// plus a 10-line tail box; anything beyond is dropped (bounded retention, like
// the tool-output previews).
const THINKING_BUF_MAX = 2048;
// Per-call full-output capture cap for the modal (ticket 35): the inline preview
// was ~8 lines; the modal shows the whole output, but stored capture stays bounded
// at 64KB. Larger truncated command output lives in a temp file (fullOutputPath)
// read lazily on open, so this cap only bounds in-memory retention.
const MAX_MODAL_CAPTURE = 64 * 1024;
// Transient "Copied to clipboard" status after `c` in a modal (ticket 35).

// Zero-line widget that captures the live TUI handle (research §3 widget-factory
// trick) so the card can request global re-renders; also the anchor for opt-in
// mouse reporting (ticket 09). Registered in every live-UI session.
const CAPTURE_WIDGET_KEY = "activity-feed-capture";
// Click-to-toggle is ON by default (ticket 12 req 4, owner decision); pass
// --no-activity-mouse to opt out (Shift/Option-drag still selects natively).
const NO_MOUSE_FLAG = "no-activity-mouse";
// SGR button tracking (1000) + ANY-MOTION tracking (1003) + SGR extended
// coordinates (1006). Ticket 24 hover needs motion reports WITHOUT a button held,
// so 1003 (any-motion) is the required mode: 1002 (button-motion) only reports
// movement while a button is down and cannot drive a bare hover — matching the
// mode pi-cc-extensions' renderer/mouse uses for regular-mode hover
// (TOOL_MOUSE_MOTION_ENABLE = "\x1b[?1003h\x1b[?1006h"). 1003 is a superset of
// 1000; keeping 1000h is harmless. The trade-off is heavier input traffic (a
// packet per cell the cursor crosses) — bounded by rendering ONLY when the hovered
// node changes (commitHover), and it shares the existing selection trade-off
// (Shift/Option-drag still selects natively).
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1003l\x1b[?1006l";

// Regular-mode TUI exposes captureRenderState() (the buffer + viewport top we
// need to resolve a click row to a card); it is not on the base TUI interface.
type RegularTui = TUI & { captureRenderState?: () => TuiMainScreenRenderState };

// The minimal SGR mouse-packet parsing seam (ticket 09 + reviewer P1) lives in
// the pure, dependency-free ./mouse.ts so it is unit-testable without a terminal;
// see MousePacket / parseSgrMousePackets / isSgrLeftPress / isSgrMotion there.

// ── Data shapes ──────────────────────────────────────────────────────────────

/**
 * Mutable, render-ready model stored (by reference) on the appended entry
 * (ticket 11). While the response is active `live` is true and the card renders
 * the rolling counter; the model is mutated as tools run and a captured
 * tui.requestRender() ticks the card. At agent_settled the model is frozen
 * (`live: false`, `entries` finalized) so every subsequent render is identical
 * and no further repaints touch it. It is the same object appendEntry received,
 * so mutations are reflected without any "update entry" API (which pi lacks).
 */
// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Exit code from a failed command's output. The built-in shell tools throw
 * `Command exited with code N` on a non-zero exit (bash.js), which becomes the
 * error result's text; parse it for the box badge. Returns undefined when the
 * output carries no such marker (e.g. a non-shell failure).
 */
function extractExitCode(text: string): number | undefined {
	const match = /Command exited with code (\d+)/.exec(text);
	return match ? Number(match[1]) : undefined;
}

/** Extract the joined text blocks of a tool result (ticket 12 req 5). */
function extractResultText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}

/**
 * Resolve the full output text for a member's modal (ticket 35). Prefers the
 * bash/powershell temp file (`fullOutputPath`) that holds the UNTRUNCATED output
 * when the command truncated it; falls back to the bounded in-memory capture.
 * The file read is best-effort and bounded — a missing/oversized file falls back
 * cleanly. Returns undefined when nothing is available (the modal then shows the
 * shaped preview tail already on the item).
 */
function readFullOutput(item: ShapeItem): string | undefined {
	if (item.fullOutputPath) {
		try {
			// biome-ignore lint/style/useNodejsImportProtocol: keep require for jiti loader parity
			const fs = require("node:fs") as typeof import("node:fs");
			// BOUNDED read (ticket 35 review P1): fullOutputPath is written precisely
			// when the command TRUNCATED, so the file holds large untruncated output.
			// readFileSync would pull the whole file into memory before slicing —
			// blocking the event loop and risking OOM on the exact modal path. Read at
			// most MAX_MODAL_CAPTURE bytes from the front via a fixed buffer instead.
			const fd = fs.openSync(item.fullOutputPath, "r");
			try {
				const buf = Buffer.alloc(MAX_MODAL_CAPTURE);
				const read = fs.readSync(fd, buf, 0, MAX_MODAL_CAPTURE, 0);
				return buf.toString("utf8", 0, read);
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			// File may be gone; fall back to the in-memory capture below.
		}
	}
	return item.fullOutput;
}

// ── Settled activity card ────────────────────────────────────────────────
// A live-reading Component: render() consults the per-card expansion state every
// frame, so a single tui.requestRender() after a per-node click or the toggle
// shortcut re-renders every card without needing per-entry invalidation (which
// pi does not expose).

// Per-card expansion state over the top-level entry sequence (tickets 16 + 21).
// `fullCollapsed` hides everything but the header; otherwise `membersVisible`
// holds the top-level indices of multi-member group entries showing their
// members. Output/thinking BOXES are no longer inline (ticket 35) — clicking a
// member/thought row opens a floating modal instead, so there is no per-box
// visibility state to track here.
interface CardView {
	fullCollapsed: boolean;
	membersVisible: Set<number>;
}

interface ViewState {
	/** Per-card tree expansion, keyed by entry id (lazily created). */
	cards: Map<string, CardView>;
	/** The card models by entry id, so the keyboard shortcut can enumerate nodes. */
	models: Map<string, CardModel>;
	/** Entry ids in first-seen (append) order; the last is the newest card. */
	order: string[];
}

/** The card's expansion state, created on first access with the default tree. */
function getCardView(view: ViewState, id: string): CardView {
	let cv = view.cards.get(id);
	if (!cv) {
		cv = { fullCollapsed: false, membersVisible: new Set() };
		view.cards.set(id, cv);
	}
	return cv;
}

/** Toggle a value's membership in a set (add if absent, remove if present). */
function toggleInSet<T>(set: Set<T>, value: T): void {
	if (set.has(value)) set.delete(value);
	else set.add(value);
}

/** True when every expandable node of the card is open (the all-expanded state).
 * With inline boxes gone (ticket 35), "expandable" now means only multi-member
 * group entries showing their members \u2014 thought and narration rows (ticket 41)
 * have no separate expand state, they just open a modal on click. */
function isAllExpanded(model: CardModel, cv: CardView): boolean {
	if (cv.fullCollapsed) return false;
	return model.entries.every((entry, k) => {
		if (entry.kind !== "group") return true;
		return !groupHasMembersToggle(entry.group) || cv.membersVisible.has(k);
	});
}

/** Open every expandable node (every multi-member group's members). */
function setAllExpanded(model: CardModel, cv: CardView): void {
	cv.fullCollapsed = false;
	cv.membersVisible.clear();
	model.entries.forEach((entry, k) => {
		if (entry.kind === "group" && groupHasMembersToggle(entry.group)) cv.membersVisible.add(k);
	});
}

// Which clickable node the mouse is currently over (ticket 24). Session-lived,
// shared with every card: `cardId` names the hovered card, `nodeId` its hovered
// node. Empty (both undefined) when the mouse is off every card or disabled, so
// no row is highlighted. commitHover() is the single writer + render throttle.
interface HoverState {
	cardId?: string;
	nodeId?: string;
}

class ActivityCard implements Component {
	constructor(
		private readonly model: CardModel,
		private readonly theme: Theme,
		private readonly cardId: string,
		private readonly view: ViewState,
		/** Shared line-index → node-id map by card id, refreshed each render for
		 * mouse resolution (onCardMouse reads the last rendered rowMap). */
		private readonly rowMaps: Map<string, string[]>,
		/** Shared hover state (ticket 24): the row highlighted this frame is the one
		 * whose node id matches when this card is the hovered card. */
		private readonly hover: HoverState,
		/** True when this card is being rendered from a PERSISTED snapshot on a
		 * fresh-process resume (ticket 25 layer 3): render it settled/graceful, never
		 * as a ticking live card, since no timer exists to advance it. */
		private readonly stale = false,
	) {}

	render(width: number): string[] {
		const theme = this.theme;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));

		// The card renders in its FINAL shape from the first tool and grows in place
		// (ticket 12): the same shapeCard() drives the live and settled views, so the
		// only change at settle is the header word/spinner and a running row losing its
		// spinner. read the mutable model + per-node expansion each frame; a captured
		// tui.requestRender() ticks it while live. A stale resumed snapshot (ticket 25)
		// is shaped settled/graceful instead — live:true becomes settled, workedMs 0
		// becomes "Worked for —".
		const shapeModel: CardShapeModel = this.stale
			? staleCardShapeModel(this.model as PersistedCardData)
			: {
					live: this.model.live,
					elapsedMs: this.model.live ? Date.now() - this.model.startMs : this.model.workedMs,
					failures: this.model.failures,
					entries: this.model.entries,
					// A card force-settled in the running process (Esc-abort / stream error) is
					// rendered through THIS non-stale branch, so the flag must flow to shapeCard
					// or the "· interrupted" marker (ticket 32 point 3) is silently dropped in
					// its primary scenario — only the resumed/stale path set it before.
					interrupted: this.model.interrupted,
				};
		const cv = getCardView(this.view, this.cardId);
		const expansion: CardExpansion = {
			fullCollapsed: cv.fullCollapsed,
			isMembersVisible: (k) => cv.membersVisible.has(k),
		};
		// The header + any running-row mark use pi's OWN spinner cadence (ticket 36):
		// spinnerFrame(Date.now()) advances every SPINNER_INTERVAL_MS (80 ms), matching
		// the composer working bar. It animates for free because pi's working indicator
		// re-renders the whole tree ~every 80 ms while the agent works; our 500 ms
		// LIVE_TICK_MS timer stays as the fallback repaint/content cadence. Once settled
		// no running rows remain, so the frame is irrelevant.
		const spinner = spinnerFrame(Date.now());
		// Highlight the hovered row only when THIS card is the hovered one (ticket 24);
		// undefined otherwise, so shapeCard applies no highlight (also the mouse-disabled
		// case — hover is never written).
		const hoveredNode = this.hover.cardId === this.cardId ? this.hover.nodeId : undefined;
		const shaped = shapeCard(shapeModel, expansion, spinner, hoveredNode);
		// Stash the row-map so a click on this card resolves to the right node. Clicks
		// arrive in VISUAL (wrapped) rows, but shaped.rowMap is indexed by logical shape
		// lines — a wide box/command line wraps to ≥2 rows on a narrow terminal, which
		// would shift every node below it (reviewer P1). Measure each line at the Box's
		// inner content width (width − 2×paddingX, where Text wraps) and expand the
		// row-map into wrapped-row space so onCardMouse's event.y indexes it correctly.
		const contentWidth = Math.max(1, width - CARD_BOX_PADDING_X * 2);
		const heights: number[] = [];
		for (const line of shaped.lines) {
			const text = new Text(styleLine(theme, line), 0, 0);
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

// ── TUI-handle capture widget ───────────────────────────────────────────────────
interface Runtime {
	tui: TUI | undefined;
}

// A zero-line widget whose only jobs are to capture the live TUI handle — the
// widget factory is one of the few places an extension is handed the TUI object
// (research §3 mechanism 3) — and, when the mouse flag is set, turn on SGR mouse
// reporting. The captured handle drives tui.requestRender() for the live card
// (ticket 11) and the toggle shortcut. Renders nothing, so it never occupies a
// line. There is no separate live-counter widget anymore: the transcript card
// is the live surface.
class CaptureWidget implements Component {
	constructor(tui: TUI, runtime: Runtime, onTui: (tui: TUI) => void) {
		runtime.tui = tui;
		onTui(tui);
	}

	render(_width: number): string[] {
		return [];
	}

	invalidate(): void {}
}

// ── Absorbable built-in tool rows ──────────────────────────────────────────────
// Shared, session-lived set of tool-call ids that have been folded into a
// settled card. Never cleared: a row that has vanished must stay vanished for
// the life of the transcript (clearing it would make hidden rows reappear on the
// next full redraw). Ids are strings → negligible memory.
// ── Extension ────────────────────────────────────────────────────────────────

export default function activityFeed(pi: ExtensionAPI): void {
	// Click-to-toggle is ON by default (ticket 12 req 4, owner decision). Enabling
	// mouse reporting in regular mode intercepts the terminal's own click-drag
	// selection and wheel scroll (ticket 09) — Shift/Option-drag still selects
	// natively — so --no-activity-mouse opts out. The keyboard shortcut is always on.
	pi.registerFlag(NO_MOUSE_FLAG, {
		type: "boolean",
		default: false,
		description: "Disable click-to-toggle for activity cards (regular mode otherwise captures the mouse; see README trade-offs).",
	});
	const mouseEnabled = pi.getFlag(NO_MOUSE_FLAG) !== true;

	// ── Native thinking suppression (ticket 20) ────────────────────────────────
	// The owner wants thinking to live inside the card's grouped stack, not float
	// outside it as pi's native "Planning…" / "Confirming…" block. The only
	// supported levers (research §2; no monkey-patching) are a markdown transformer
	// on "assistant-thinking" and setHiddenThinkingLabel. The transformer fires in
	// the SHOWN branch of AssistantMessageComponent for BOTH streaming and settled
	// renders (assistant-message.js:88-118), so returning "" blanks the native
	// thinking TEXT throughout its lifecycle — pi's Markdown then renders ZERO lines
	// (markdown.js:186-196); setHiddenThinkingLabel("") blanks the collapsed
	// placeholder shown after ctrl+t hides thinking. The decision is the pure,
	// unit-tested suppressThinkingMarkdown (card-shape.ts).
	//
	// Residual blank lines (tickets 22 + 26 investigation): AssistantMessageComponent
	// adds Spacer(1) siblings around a thinking run from the RAW pre-transform content
	// it cannot see us rewrite — a LEADING Spacer whenever the message has any visible
	// raw content, incl. a message whose only visible block is thinking
	// (assistant-message.js:74-77), and a TRAILING Spacer when visible content follows
	// the run (assistant-message.js:120-127). Ticket 26 root cause: a big task is
	// dozens of SEPARATE assistant messages of shape [thinking, toolCall…] (thinking +
	// tools, no visible text). Each is its own AssistantMessageComponent; the thinking
	// body renders 0 lines (transformer) and every built-in tool row renders 0 lines
	// INCLUDING its own constructor Spacer (renderShell:"self" ⇒
	// ToolExecutionComponent.render() returns [] when the self-render container is
	// empty, tool-execution.js:176-198) — yet each message still emits its ONE leading
	// Spacer keyed off the raw thinking. So a 40-message response stacked 40 blank
	// lines (the owner's 16:38 audit).
	//
	// Ticket 30 removes that last blank with a GUARDED RUNTIME PATCH (src/patches.ts,
	// installed in session_start below, TUI only): once the owner lifted the
	// no-monkey-patching constraint (map "Out of scope", pi-cc-extensions precedent),
	// the leading Spacer for a suppressed-thinking-only message is dropped from the
	// render tree AFTER pi builds it — never touching the stored/resent message, so
	// the byte-identical constraint that forbade the message_end route (ticket 26)
	// still holds. It is feature-detected + fail-open: on a pi shape drift it no-ops
	// and the 40-blank floor returns (blank-probe drift canary). Messages with visible
	// text keep normal paragraph spacing; the empty [] final message renders 0 lines.
	// ctrl+t interaction: the transformer blanks the shown state and the label blanks
	// the hidden state, so ctrl+t no longer reveals a readable native block — the
	// card's expandable Thought rows are the single home for thinking (README).
	pi.registerMarkdownTransformer((markdown, mtCtx) => suppressThinkingMarkdown(markdown, mtCtx.messageType));

	// Per-response mutable state (accumulated across all turns of one agent
	// response, agent_start → agent_settled).
	const ledger = new Map<string, ToolCall>();
	// Pure group-boundary state machine (ticket 10): groups break only on
	// assistant text with non-whitespace content, never on turn boundaries.
	const grouper = new Grouper<ToolCall>();
	/** Anchored on the FIRST turn_start of the response; 0 until that fires. */
	let responseStartMs = 0;
	let runningTools = 0;
	let thinkingStartMs: number | undefined;
	// Text streamed for the CURRENT thinking span, bounded to ~2KB (ticket 20):
	// enough for a summary line + a 10-line tail box, negligible retention. Reset
	// on thinking_start, flushed into the group on thinking_end.
	let thinkingBuf = "";
	// Monotonic id source for synthetic calls reconstructed from thinking-channel
	// tool dumps (span-classify.ts) \u2014 they have no provider toolCallId.
	let syntheticCallSeq = 0;
	// The most recently completed text block, captured at text_end, awaiting
	// confirmation (ticket 41): AT MOST one at a time, since text blocks stream
	// serially. If something follows it (a new tool call, new thinking, or another
	// text block) it is confirmed non-final and its native rendering is hidden
	// (folded into the card instead). If NOTHING follows before the response
	// settles, it was the true final answer \u2014 never touched, stays visible exactly
	// as pi always rendered it. Cleared on every confirm-or-reset boundary so a
	// stale reference never leaks into the next response.
	let pendingNarration: { instance: PatchTargetInstance; contentIndex: number; text: string } | undefined;
	/** Every narration hide of the CURRENT response, in confirm order (ticket 41
	 * promotion): when finalize() promotes the last narration back out as the
	 * answer, the matching record restores its native text block. */
	let narrationHides: { instance: PatchTargetInstance; contentIndex: number; text: string }[] = [];

	// Tool-call ids whose native rows the card absorbs (session-lived; never
	// cleared \u2014 a hidden row must stay hidden for the transcript's life). Ids are
	// added at tool_execution_start so the native row never paints a frame; the
	// ToolExecutionComponent render patch (patches.ts) is the ONLY hiding
	// mechanism \u2014 this extension registers NO tools. Deliberate (owner decision):
	// re-registering built-ins made pi-cursor-sdk skip its native tool replay
	// ("name already owned by another extension") and fall back to thinking-text
	// transcripts, and it hard-conflicted with other display extensions.
	const absorbed = new Set<string>();

	// UI-lifecycle state.
	let uiCtx: ExtensionContext | undefined;
	let liveTimer: ReturnType<typeof setInterval> | undefined;
	const runtime: Runtime = { tui: undefined };
	const view: ViewState = { cards: new Map(), models: new Map(), order: [] };
	// Last rendered line-index → node-id map per card, for mouse resolution (ticket 16).
	const rowMaps = new Map<string, string[]>();
	// Current mouse-hovered node (ticket 24). Read by every ActivityCard each frame;
	// written only by commitHover (the render throttle) and cleared on leave/settle/
	// teardown. Empty while the mouse is off every card or --no-activity-mouse is set.
	const hover: HoverState = {};
	// During a synthesized regular-mode move dispatch the resolved card/node are
	// stashed here (onCardMouse can't return a value up through handleMouse); the
	// caller commits them after so a move that hit NO card clears hover (leave).
	let inSyntheticMove = false;
	let synthMoveCardId: string | undefined;
	let synthMoveNodeId: string | undefined;

	// The live card model for the CURRENT response (ticket 11). Appended on the
	// first tool_execution_start, mutated as tools run, frozen at settle. Undefined
	// between responses (and once frozen, so no further mutation touches it).
	let cardModel: CardModel | undefined;
	let cardAppended = false;

	// ── In-memory card registry (ticket 25 layer 1) ────────────────────────────
	// The renderer PREFERS these in-memory models over the persisted entry.data
	// snapshot. `liveModels` holds every model object this process appended (live,
	// settled, or re-appended): entry.data is the SAME object by reference in-process
	// (pi does not clone appendEntry data — session-manager.js appendCustomEntry), so
	// membership discriminates "our live/settled model" from "a persisted snapshot
	// deserialized on a fresh-process resume". We do not RELY on the reference being
	// stable across in-process rebuilds (the ticket's caution): even if pi ever
	// handed back a different object, `view.models` (keyed by entry id, populated on
	// first render) keeps the correct model, and a resumed snapshot is rendered
	// gracefully as settled either way. Ids in `staleCards` are rendered from a
	// persisted snapshot (fresh process) and stay stale for the process lifetime so
	// they never flip into a ticking ghost on a later render.
	const liveModels = new WeakSet<CardModel>();
	const staleCards = new Set<string>();
	// Compaction survival (ticket 25 layer 2): the set of dropped card entries we
	// have already re-appended (dedup — one response never yields two cards).
	const reappendedFrom = new Set<string>();

	// Capture-widget / mouse state.
	let captureShown = false;
	// Transient toggle-status clear timer (ticket 19).
	let toggleStatusTimer: ReturnType<typeof setTimeout> | undefined;
	let mouseUnsub: (() => void) | undefined;
	let mouseReportingOn = false;
	// Residual buffer for a mouse packet split across a read boundary (reviewer P1):
	// handleTerminalInput holds any trailing incomplete "\x1b[<…" here and prepends
	// it to the next chunk so the completing bytes never leak into the editor.
	let mouseResidual = "";

	const hasLiveUI = (ctx: ExtensionContext): boolean => ctx.mode === "tui" && ctx.hasUI;

	// Guarded leading-Spacer patch (tickets 30 + 31): acquired LAZILY from the first
	// LIVE AssistantMessageComponent instance in the running tree (patching the
	// imported class had no live effect — the CLI runs the bundle, ticket 31), applied
	// ONCE per TUI session, torn down at shutdown (ticket 38: owned by PatchController).
	const patchController = new PatchController(runtime, hasLiveUI);

	function captureCtx(ctx: ExtensionContext): void {
		if (hasLiveUI(ctx)) uiCtx = ctx;
	}

	/** Start a fresh agent response. Absorbed rows persist (session-lived set).
	 *
	 * CATCH-ALL force-settle (ticket 32 point 1): before dropping the previous
	 * response's state, force-settle any card that is STILL live. A stream error
	 * (assistant stopReason "error") is retryable, and pi's retry runs as a fresh
	 * agent loop that emits a NEW agent_start (agent-loop.js runAgentLoopContinue)
	 * WITHOUT ever delivering a settle for the errored card — so the previous card
	 * would be orphaned on "⟳ Thinking…" forever (the 2026-09-20 evidence session:
	 * line 74 stopReason=error mid-thinking, line 75 a fresh live card). Settling
	 * here, at the exact boundary where the next response begins, guarantees AT MOST
	 * ONE live card regardless of which events the error path skipped. Idempotent:
	 * settleResponse() drops cardModel via clearLive(), so a card already settled by
	 * the direct message_end/agent_end handling below is a no-op here. Runs BEFORE
	 * grouper.reset()/responseStartMs=0 so the interrupted card keeps the previous
	 * response's entries + elapsed clock.
	 */
	function resetResponse(): void {
		forceSettleLingering();
		ledger.clear();
		grouper.reset();
		responseStartMs = 0;
		runningTools = 0;
		thinkingStartMs = undefined;
		thinkingBuf = "";
		cardModel = undefined;
		cardAppended = false;
		// A pending narration from the PREVIOUS response is moot for a fresh one
		// (ticket 41) \u2014 drop it without hiding (its native rendering, if it was
		// genuinely the previous response's final answer, must stay untouched).
		pendingNarration = undefined;
		narrationHides = [];
	}

	/**
	 * Confirm any pending narration block as NON-final (ticket 41) and hide its
	 * native rendering, folding it into the card instead. Called the moment ANY
	 * activity is known to follow it: a new tool call, a new thinking span, or
	 * another text block starting \u2014 each is proof the pending block was not the
	 * last thing in the response. No-op when nothing is pending. Best-effort: a
	 * failed hide (component gone, shape drifted) leaves the text visible natively
	 * \u2014 the card row still exists from Grouper.textEnd either way, so nothing is
	 * ever lost, only occasionally shown in both places.
	 */
	function confirmNarrationNonFinal(): void {
		if (!pendingNarration) return;
		const hidden = hideMessageTextBlock(pendingNarration.instance, pendingNarration.contentIndex);
		// Record the hide (in confirm order) so settle can RESTORE the last one when
		// the response ends without a final answer (promotion \u2014 grouping.ts).
		if (hidden) narrationHides.push(pendingNarration);
		pendingNarration = undefined;
		if (hidden) runtime.tui?.requestRender();
	}

	/**
	 * Flush an OPEN thinking span into the grouper (ticket 32 point 3). On a normal
	 * settle thinking_end already fired, so thinkingStartMs is undefined and this is
	 * a no-op. On an abnormal end the stream died mid-thinking (no thinking_end), so
	 * the in-progress span is captured here — its elapsed time + the partial streamed
	 * buffer — so the interrupted card's thought entry closes with a real duration and
	 * keeps its partial text in the "Thinking" box (subject to the same MIN_THOUGHT_MS
	 * coalescing as any span; a visible live "⟳ Thinking…" is by definition already
	 * above that threshold).
	 */
	function flushOpenThinking(): void {
		if (thinkingStartMs === undefined) return;
		grouper.addThought(Date.now() - thinkingStartMs, thinkingBuf);
		thinkingStartMs = undefined;
		thinkingBuf = "";
	}

	/** Force-settle the current card as INTERRUPTED if it is still live (ticket 32).
	 * The single guarded entry point for the catch-all + the direct abnormal-end
	 * handlers; a no-op when no live card exists (already settled, or none appended). */
	function forceSettleLingering(): void {
		if (cardModel && cardModel.live) settleResponse(true);
	}

	/** Direct abnormal-end handling (ticket 32 point 2): settle the live card the
	 * moment an assistant message ends with an error/abort stopReason, so the
	 * "· interrupted" marker appears immediately instead of only at the next
	 * response's agent_start. Only "error"/"aborted" are abnormal — "stop"/"toolUse"/
	 * "length" are normal completions handled by agent_settled. */
	function settleIfAbnormal(stopReason: string | undefined): void {
		if (stopReason === "error" || stopReason === "aborted") forceSettleLingering();
	}

	/**
	 * Safety net: ensure every ledger id is in the absorbed set. Primary
	 * absorption happens at tool_execution_start (before the row's first
	 * frame); this catches any id that slipped past. Idempotent — Set.
	 */
	function absorbCurrentRows(): void {
		let added = false;
		for (const id of ledger.keys()) {
			if (!absorbed.has(id)) {
				absorbed.add(id);
				added = true;
			}
		}
		if (added) runtime.tui?.requestRender();
	}

	// \u2500\u2500 Universal tool-row absorption \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// EVERY tool's native row (built-in, MCP, extension) is hidden by ONE guarded
	// prototype patch on pi's ToolExecutionComponent, driven by the shared
	// `absorbed` set; ids are added at tool_execution_start so rows never paint a
	// frame. The old ticket-08 re-registration mechanism is gone (owner decision:
	// it blocked pi-cursor-sdk's native tool replay and hard-conflicted with
	// other display extensions). Fail-open: while the patch is not installed,
	// rows render natively (pi default) \u2014 noisier but fully functional.
	let toolRowPatchInstalled = false;
	function tryAcquireToolRowPatch(): void {
		if (toolRowPatchInstalled || !runtime.tui) return;
		const result = acquireToolRowHidePatch(runtime.tui, (id) => absorbed.has(id));
		if (result.installed) toolRowPatchInstalled = true;
	}

	// \u2500\u2500 Click-away modal close (owner request) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// pi-tui routes a click OUTSIDE every overlay past the overlay layer (hit:
	// false) straight into the transcript \u2014 the modal never sees it. Wrap the
	// captured TUI INSTANCE's dispatchMouseToOverlay (feature-detected, instance
	// property only \u2014 no prototype touched): when a click misses all overlays
	// while our modal is open, close the modal and swallow the click so it can't
	// also toggle whatever row happened to sit underneath. Fail-open: without the
	// method, Esc/q keep working exactly as before.
	let clickAwayInstalled = false;
	function installClickAwayClose(): void {
		if (clickAwayInstalled) return;
		const tui = runtime.tui as unknown as {
			dispatchMouseToOverlay?: (event: unknown) => { hit: boolean } | undefined;
			requestRender?: () => void;
		} | undefined;
		if (!tui || typeof tui.dispatchMouseToOverlay !== "function") return;
		const original = tui.dispatchMouseToOverlay.bind(tui);
		try {
			tui.dispatchMouseToOverlay = (event: unknown) => {
				const out = original(event);
				const type = (event as { type?: unknown } | undefined)?.type;
				if (out && out.hit === false && type === "click" && modalController.isOpen()) {
					modalController.closeModal();
					tui.requestRender?.();
					return { hit: true };
				}
				return out;
			};
			clickAwayInstalled = true;
		} catch {
			// Instance not writable \u2014 keep keyboard-only close.
		}
	}

	// ── Live card plumbing (ticket 11) ────────────────────────────────────────
	/**
	 * Append the activity card EARLY — on the first tool_execution_start of the
	 * response — so it lands ABOVE the streamed answer text (appendEntry inserts
	 * before the live streaming component; the final answer arrives in a later
	 * message appended below the card). Idempotent per response via cardAppended.
	 * The appended object is kept BY REFERENCE (pi does not clone entry data), so
	 * later mutations to cardModel are what the card renders; a captured
	 * tui.requestRender() ticks it. Appended unconditionally (not gated on uiCtx):
	 * it only fires on a real tool event, which print mode never emits.
	 */
	function ensureCard(): void {
		if (cardAppended) return;
		const model: CardModel = {
			live: true,
			startMs: responseStartMs || Date.now(),
			workedMs: 0,
			failures: 0,
			entries: [],
		};
		cardModel = model;
		cardAppended = true;
		appendCard(model);
	}

	/**
	 * Append a card entry AND register its model in the in-memory registry
	 * (ticket 25 layer 1). Membership in `liveModels` marks the object as ours (so
	 * the renderer never mistakes an in-process model for a stale persisted
	 * snapshot); `view.models` is keyed by the new entry's id (the session leaf after
	 * the synchronous appendCustomEntry — agent-session.js appendEntry) so the renderer
	 * and keyboard shortcut resolve the model without waiting for the first render.
	 */
	function appendCard(model: CardModel): void {
		liveModels.add(model);
		pi.appendEntry<CardModel>(CARD_TYPE, model);
		const id = uiCtx?.sessionManager.getLeafId() ?? undefined;
		if (id) view.models.set(id, model);
	}

	/** The in-progress thinking span for the live card (ticket 23): elapsed ms +
	 * the current streamed buffer. Undefined when no thinking span is active. The
	 * buffer is passed by reference each tick (never retained by the grouper); the
	 * card copies only a bounded tail. */
	function liveThinking(): { ms: number; text: string } | undefined {
		if (thinkingStartMs === undefined) return undefined;
		return { ms: Date.now() - thinkingStartMs, text: thinkingBuf };
	}

	/** True while a thinking span is streaming (drives the tick condition + the
	 * live thought row) — ticket 23. */
	function thinkingActive(): boolean {
		return thinkingStartMs !== undefined;
	}

	function refreshLive(): void {
		// The snapshot exposes the open group at the tail (ticket 21 rule 6) AND a
		// suprathreshold in-progress thinking run as a trailing live thought entry
		// (ticket 23). Passing the live span lets that entry appear/tick before the
		// span closes; buildCardEntries marks it live so its row shows "Thinking… · Xs".
		const live = liveThinking();
		const snapshot = grouper.snapshot(live);
		// Append the card as soon as there is live content — the first tool's open
		// group OR a suprathreshold thinking run (ticket 23) — so it sits above the
		// answer. Idempotent (cardAppended guard).
		if (snapshot.length > 0) ensureCard();
		if (cardModel) {
			// Keep the same card populated while work runs: resolved thought + group
			// entries accumulate in order, the running group grows at the tail (any
			// running call keeping `running: true` for its spinner), and the live thought
			// entry (if any) transforms in place to its settled row once thinking closes.
			const shaped = buildCardEntries(snapshot, live !== undefined);
			cardModel.entries = shaped.entries;
			cardModel.failures = shaped.failures;

			// The native working message beside the editor still mirrors the bucket
			// counter (the card header itself now shows just "⟳ Working · Xs").
			const calls = Array.from(ledger.values(), toCallLike);
			const details = calls.length > 0 ? bucketCountsText(calls) : "";
			if (uiCtx) uiCtx.ui.setWorkingMessage(details ? `Working · ${details}` : "Working");
		}
		runtime.tui?.requestRender();
	}

	/** Tear down live-only surfaces (timer + working message). The card itself,
	 * if it was appended, is left frozen in place by settleResponse. */
	// Freeze a live card that finalized with nothing renderable (unreachable
	// today — any tool ⇒ ≥1 entry) so clearLive() cannot orphan a ⟳ Exploring line;
	// an interrupted force-settle stamps the marker so it reads "· interrupted"
	// rather than feigning completion (ticket 32 / 37).
	function freezeEmptyCard(interrupted: boolean): void {
		if (cardModel) {
			cardModel.live = false;
			if (interrupted) cardModel.interrupted = true;
		}
		clearLive();
	}

	function clearLive(): void {
		stopTimer();
		cardModel = undefined;
		// Clear any hover highlight at settle (ticket 24): the card re-renders into its
		// finalized shape here, where node ids may shift, so a stale lit row is wrong.
		clearHover();
		if (uiCtx) uiCtx.ui.setWorkingMessage();
		runtime.tui?.requestRender();
	}

	function startTimer(): void {
		if (liveTimer || !uiCtx) return;
		liveTimer = setInterval(refreshLive, LIVE_TICK_MS);
	}

	function stopTimer(): void {
		if (liveTimer) {
			clearInterval(liveTimer);
			liveTimer = undefined;
		}
	}

	// ── Mouse click-to-toggle (regular mode) ──────────────────────────────────
	// Regular mode does not route mouse events to components (the terminal owns
	// scrollback), so we enable SGR button reporting ourselves, parse the packets
	// from onTerminalInput, and synthesize a TUI mouse dispatch that the retained
	// component tree resolves to the clicked card (ticket 09; technique ported from
	// pi-cc-extensions renderer/mouse, no shared code). In fullscreen the TUI routes
	// clicks natively straight to each card's MouseRegion, so we skip all of this.
	/** Apply a click on one node (tickets 16 + 21): header cycles full-collapse ↔
	 * default; a group entry toggles its members; a thought entry toggles its
	 * "Thinking" box; a member toggles its output box. Indices are top-level. */
	/** Set the hovered card/node, re-rendering ONLY when it actually changes
	 * (ticket 24 throttle): motion reports are dense, but a move within the same row
	 * (or off every card while already cleared) does nothing. Passing undefined ids
	 * clears the hover (leave). */
	function commitHover(cardId: string | undefined, nodeId: string | undefined): void {
		if (hover.cardId === cardId && hover.nodeId === nodeId) return;
		hover.cardId = cardId;
		hover.nodeId = nodeId;
		runtime.tui?.requestRender();
	}

	/** Clear any hover highlight (ticket 24): on card settle re-render + teardown, so
	 * a finalized card (whose node ids may have shifted) never keeps a stale row lit. */
	function clearHover(): void {
		commitHover(undefined, undefined);
	}

	function toggleNode(id: string, nodeId: string): void {
		// Any node interaction may open a modal \u2014 make sure click-away close is
		// wired first (idempotent, cheap after the first call).
		installClickAwayClose();
		const cv = getCardView(view, id);
		const node = parseNodeId(nodeId);
		switch (node.kind) {
			case "header":
				cv.fullCollapsed = !cv.fullCollapsed;
				break;
			case "group":
				toggleInSet(cv.membersVisible, node.entryIndex);
				break;
			case "thought":
				// Ticket 35: a thought row opens the floating "Thinking" modal instead of
				// an inline box. Renders nothing new in the tree, so no requestRender.
				modalController.openThoughtModal(id, node.entryIndex);
				return;
			case "narration":
				// Ticket 41: a narration row opens the floating modal with its full text.
				modalController.openNarrationModal(id, node.entryIndex);
				return;
			case "member":
				// Ticket 35: a member row opens the floating output modal.
				modalController.openMemberModal(id, node.entryIndex, node.itemIndex);
				return;
		}
		runtime.tui?.requestRender();
	}

	// ── Floating output modal (ticket 35) ─────────────────────────────────────────
	// Clicking a member/thought row opens a focused overlay (ctx.ui.custom overlay)
	// showing the FULL output/thinking text, scrollable and copyable, instead of the
	// old inline ASCII box. Only one modal at a time: opening another closes the
	// current one first (handle.hide()), then shows the new content. The handle is
	// also hidden on teardown / settle-abort so no overlay outlives its card.
	// Modal lifecycle (open/swap/copy/close/teardown) is owned by ModalController
	// (ticket 38); it reads the live model + UI context through injected accessors.
	const modalController = new ModalController({
		getUiCtx: () => uiCtx,
		hasLiveUI,
		getModel: (cardId) => view.models.get(cardId),
		readFullOutput,
		copyToClipboard,
		requestRender: () => runtime.tui?.requestRender(),
		makeModal: (content, theme, done, onCopy) => new OutputModal(content, theme as Theme, done, onCopy),
	});

	function onCardMouse(id: string, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const rowMap = rowMaps.get(id);
		// event.y is local to the card's rendered lines; subtract the Box top padding to
		// get the VISUAL row index, then resolve its node via the expanded row-map (built
		// in ActivityCard.render in wrapped-row space, so wrapped lines map correctly).
		const rowIndex = event.y - CARD_BOX_PADDING_Y;
		const node = rowMap ? hoveredNodeAt(rowMap, rowIndex) : undefined;

		// Hover (ticket 24): a move over this card sets the hovered node (or clears it
		// on the card's own padding rows). In a synthesized regular-mode dispatch the
		// result is stashed for the caller to commit (so a move over NO card can clear
		// hover); fullscreen routes moves here natively, so commit directly.
		if (event.type === "move") {
			if (inSyntheticMove) {
				synthMoveCardId = id;
				synthMoveNodeId = node;
			} else {
				commitHover(id, node);
			}
			return { handled: true, render: false };
		}

		// Toggle on the press only; native fullscreen also emits release/click, and
		// double-handling would cancel the toggle out.
		if (event.type !== "press" || event.button !== "left") return undefined;
		if (node === undefined) return undefined;
		toggleNode(id, node);
		return { handled: true, render: true };
	}

	/**
	 * Register the zero-line capture widget in every live-UI session so the live
	 * card and toggle shortcut always have a tui.requestRender() handle (ticket 11
	 * — there is no live-counter widget to capture it anymore). Unless
	 * --no-activity-mouse is set the same widget also turns on SGR mouse reporting
	 * and we subscribe to raw terminal input for click-to-toggle (ticket 09/12).
	 */
	function setupCapture(ctx: ExtensionContext): void {
		if (captureShown) return;
		ctx.ui.setWidget(
			CAPTURE_WIDGET_KEY,
			(tui) => new CaptureWidget(tui, runtime, (t) => { if (mouseEnabled) enableMouseReporting(t); }),
			{ placement: "belowEditor" },
		);
		captureShown = true;
		if (mouseEnabled) mouseUnsub = ctx.ui.onTerminalInput(handleTerminalInput);
	}

	function enableMouseReporting(tui: TUI): void {
		runtime.tui = tui;
		if (mouseReportingOn || tui.mode !== "regular") return; // fullscreen routes natively
		try {
			tui.terminal.write(MOUSE_ENABLE);
			mouseReportingOn = true;
		} catch {
			// Terminal may be unavailable; the keyboard shortcut still works.
		}
	}

	function teardownCapture(): void {
		mouseUnsub?.();
		mouseUnsub = undefined;
		if (mouseReportingOn && runtime.tui) {
			try {
				runtime.tui.terminal.write(MOUSE_DISABLE);
			} catch {
				// Terminal may already be closed during shutdown.
			}
		}
		mouseReportingOn = false;
		mouseResidual = ""; // reviewer P1: drop any half-parsed packet on teardown
		clearHover(); // ticket 24: no stale highlight after teardown
		modalController.closeModal(); // ticket 35: no overlay outlives its card
		if (uiCtx && captureShown) {
			try {
				uiCtx.ui.setWidget(CAPTURE_WIDGET_KEY, undefined);
			} catch {
				// UI context may already be torn down.
			}
		}
		captureShown = false;
	}

	function handleTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
		const tui = runtime.tui as RegularTui | undefined;
		if (!tui || tui.mode !== "regular") return undefined;
		// Prepend any held incomplete-packet residual so a packet fragmented at the
		// previous read boundary completes here instead of leaking (reviewer P1).
		const input = mouseResidual + data;
		const parsed = parseSgrMousePackets(input);
		mouseResidual = parsed.residual;

		if (parsed.packets.length === 0) {
			// No complete packet this chunk. Either the whole chunk was swallowed into a
			// held residual (a fragmented packet — wait for its completion), or a held
			// residual turned out non-mouse and is now released as passthrough (must
			// reach the editor). Only override the byte stream when we changed it.
			if (parsed.residual) return { consume: true };
			return parsed.passthrough === data ? undefined : { data: parsed.passthrough };
		}

		let toggled = false;
		let lastMotion: MousePacket | undefined;
		for (const packet of parsed.packets) {
			if (isSgrLeftPress(packet)) {
				if (resolveClickToCard(tui, packet)) toggled = true;
			} else if (isSgrMotion(packet)) {
				// Only the FINAL motion position matters for hover (reviewer P2): a fast
				// 1003 burst packs many motions per chunk, but resolving every one would
				// dispatch captureRenderState + handleMouse per packet. Keep the last and
				// resolve once below.
				lastMotion = packet;
			}
		}
		// Hover (ticket 24): resolve the last motion to a card/node and re-render only
		// when the hovered node changes (commitHover throttles). A move over no card
		// clears the hover (leave).
		if (lastMotion) resolveHoverToCard(tui, lastMotion);
		if (toggled) tui.requestRender();
		// Consume the recognized SGR mouse packets — clicks, releases, wheel,
		// right/middle — so raw \x1b[<..M bytes never leak into the editor (ticket 09
		// fix). Any trailing non-mouse bytes that arrived in the same chunk are
		// forwarded to the editor as passthrough; a trailing incomplete packet is held
		// in mouseResidual (nothing to forward, so consume the rest).
		if (parsed.passthrough.length > 0) return { data: parsed.passthrough };
		return { consume: true };
	}

	/**
	 * Resolve a regular-mode motion report to a hovered card/node and commit it
	 * (ticket 24). Uses the SAME dispatch path as clicks — a synthesized "move"
	 * TuiMouseEvent through the TUI's handleMouse, which the retained tree routes to
	 * the card under the cursor (onCardMouse stashes the resolved node). If the move
	 * lands on no card, the stash stays undefined and commitHover clears the hover
	 * (leave). Renders only when the hovered node actually changed.
	 */
	function resolveHoverToCard(tui: RegularTui, packet: MousePacket): void {
		const state = tui.captureRenderState?.();
		const handleMouse = tui.handleMouse;
		if (!state || typeof handleMouse !== "function") return;
		const contentY = state.previousViewportTop + (packet.row - 1);
		synthMoveCardId = undefined;
		synthMoveNodeId = undefined;
		inSyntheticMove = true;
		try {
			if (contentY >= 0 && contentY < state.previousLines.length) {
				const x = Math.max(0, packet.col - 1);
				const event: TuiMouseEvent = {
					type: "move",
					button: "none",
					x,
					y: contentY,
					screenX: x,
					screenY: contentY,
					width: state.previousWidth || 0,
					height: state.previousLines.length,
					shift: (packet.code & 4) !== 0,
					alt: (packet.code & 8) !== 0,
					ctrl: (packet.code & 16) !== 0,
				};
				handleMouse.call(tui, event);
			}
		} finally {
			inSyntheticMove = false;
		}
		commitHover(synthMoveCardId, synthMoveNodeId);
	}

	function resolveClickToCard(tui: RegularTui, packet: MousePacket): boolean {
		const state = tui.captureRenderState?.();
		const handleMouse = tui.handleMouse;
		if (!state || typeof handleMouse !== "function") return false;
		// SGR rows/cols are 1-based within the visible viewport; previousViewportTop is
		// the buffer index of the topmost visible line (tui-main-screen.js), so the full
		// content row of the click is viewportTop + (row - 1).
		const contentY = state.previousViewportTop + (packet.row - 1);
		if (contentY < 0 || contentY >= state.previousLines.length) return false;
		const x = Math.max(0, packet.col - 1);
		const event: TuiMouseEvent = {
			type: "press",
			button: "left",
			x,
			y: contentY,
			screenX: x,
			screenY: contentY,
			width: state.previousWidth || 0,
			height: state.previousLines.length,
			shift: (packet.code & 4) !== 0,
			alt: (packet.code & 8) !== 0,
			ctrl: (packet.code & 16) !== 0,
			clickCount: 1,
		};
		// The retained tree resolves y → component by summed child heights (Container
		// mouseLayout), routing to the clicked card's MouseRegion → onCardMouse.
		return Boolean(handleMouse.call(tui, event));
	}

	// ── Settle one agent response into its card (idempotent) ──────────────────
	// Called at agent_settled; accumulates every turn's groups. turn_end only
	// flushes the open group, it does not settle — so one card covers the whole
	// response (ticket 08), anchored on the first turn_start (responseStartMs).
	// The card was already appended live on the first tool (ticket 11); here we
	// FREEZE that same model in place (live → false, groups finalized) so it
	// settles into the collapsed "Worked for Xs" card and never mutates again.
	function settleResponse(interrupted = false): void {
		// Close any open thinking span first (ticket 32): on a normal settle this is a
		// no-op, but on an abnormal end (stream died mid-thinking) it captures the
		// in-progress span so the interrupted card preserves its partial thought.
		flushOpenThinking();
		const { entries: finalEntries, finalAnswer, promoted } = grouper.finalize();
		// Whatever `pendingNarration` pointed at is now resolved either way (folded
		// into finalEntries as a narration entry, or popped out as the final answer
		// above) \u2014 clear it defensively; resetResponse() would anyway (ticket 41).
		pendingNarration = undefined;
		// Promotion (owner bug: Cursor trails thinking/tool dumps AFTER the real
		// answer, and a turn can end on tool calls): the response produced no
		// trailing text, so finalize pulled the LAST narration back out as the
		// answer. Its native block was hidden at confirm time \u2014 restore it so the
		// response is never visibly answerless. Match by text, last record first
		// (records and entries append in the same order).
		if (promoted && finalAnswer !== undefined) {
			for (let i = narrationHides.length - 1; i >= 0; i--) {
				const record = narrationHides[i];
				if (record.text === finalAnswer) {
					if (restoreMessageTextBlock(record.instance, record.contentIndex, finalAnswer)) {
						runtime.tui?.requestRender();
					}
					break;
				}
			}
		}
		narrationHides = [];

		if (finalEntries.length === 0) {
			// Defensive: a card appended on a tool-less path (unreachable today — any
			// tool ⇒ ≥1 entry) is frozen collapsed rather than left ticking.
			freezeEmptyCard(interrupted);
			return; // nothing to report, or already settled
		}

		const workedMs = Math.max(0, Date.now() - (responseStartMs || Date.now()));
		const shaped = buildCardEntries(finalEntries);
		const { entries: cardEntries, settledIds, failures } = shaped;
		const action = settleAction(shaped, cardModel !== undefined);

		// Mark this response settled BEFORE mutating so a trailing duplicate
		// agent_settled is a no-op (finalize() then returns []).
		grouper.reset();

		if (action === "freeze-empty") {
			// Same defensive freeze as the empty-entries branch above.
			freezeEmptyCard(interrupted);
			return;
		}

		// Safety net: rows are normally absorbed at turn_end (while in the viewport,
		// avoiding a scrollback wipe). Re-absorb here in case any call finished after
		// the last turn_end but before settle; the subsequent clearLive() issues the
		// requestRender. Idempotent (absorbed is a Set); custom/MCP ids are inert.
		// Same teardown parity for interrupted cards (ticket 32 point 4).
		for (const id of settledIds) absorbed.add(id);

		if (action === "settle-live" && cardModel) {
			// Settle the live card in place: same entry, now the collapsed "Worked for
			// Xs" card. This is the last write to the model — clearLive() then drops our
			// reference and stops the timer, so nothing repaints it again (ticket 11).
			cardModel.workedMs = workedMs;
			cardModel.failures = failures;
			cardModel.entries = cardEntries;
			cardModel.interrupted = interrupted;
			cardModel.live = false;
		} else {
			// No tool ran this response (e.g. a long thinking-only turn), so no live
			// card was appended. Emit a settled card now; it lands after the answer,
			// which is acceptable for the rare tool-less case (ticket 11 residual note).
			const frozen: CardModel = {
				live: false,
				startMs: responseStartMs || Date.now(),
				workedMs,
				failures,
				entries: cardEntries,
				interrupted,
			};
			appendCard(frozen);
		}

		clearLive();

		// Debug (ticket 34): env-gated live transcript dump — measures the REAL
		// bundle components so we stop guessing dist-vs-bundle. Off by default.
		if (process.env.PI_ACTIVITY_DEBUG === "1" && runtime.tui) {
			try {
				const fs = require("node:fs");
				const log = process.env.PI_ACTIVITY_DEBUG_LOG || "/tmp/activity-feed-debug.log";
				fs.appendFileSync(log, dumpTranscriptTree(runtime.tui, 120, "settle") + "\n");
			} catch {
				// debug best-effort only
			}
		}
	}

	// ── Card renderer (safe to register in any mode; no-ops in print) ─────────
	pi.registerEntryRenderer<CardModel>(
		CARD_TYPE,
		(entry: CustomEntry<CardModel>, _options: EntryRenderOptions, theme: Theme): Component | undefined => {
			// Prefer the in-memory registry over the persisted snapshot (ticket 25 layer
			// 1). In-process the registry holds the live/settled model we mutate; only a
			// fresh-process resume misses it, and then entry.data is the persisted
			// snapshot (frozen at append time — stale for a card saved mid-response).
			let model = view.models.get(entry.id);
			if (!model) {
				const persisted = entry.data;
				if (!persisted) return undefined;
				if (liveModels.has(persisted)) {
					// Our own model (appendCard adds it before pi renders it); in-process
					// live/settled — render the mutable object.
					model = persisted;
				} else {
					// Fresh-process persisted snapshot: render it settled/graceful and mark
					// the id stale for the process lifetime so a later render never flips it
					// into a ticking live ghost (ticket 25 layer 3).
					model = persisted;
					staleCards.add(entry.id);
				}
				view.models.set(entry.id, model);
			}
			if (!view.cards.has(entry.id)) view.order.push(entry.id);
			const stale = staleCards.has(entry.id);
			// A failure no longer auto-expands the card (ticket 18, Codex-faithful):
			// failures stay calm — the per-call signal is the output-box `Exit code N`
			// / `✗ Failed` badge (discoverable on expand; a failed call always has a
			// box now, itemHasBox) plus the deliberate `· N failed` header count.
			// While live this ActivityCard reads the mutating model each frame; once
			// frozen at settle it renders the collapsed card (ticket 11); a stale resumed
			// snapshot renders settled/graceful (ticket 25).
			const card = new ActivityCard(model, theme, entry.id, view, rowMaps, hover, stale);
			// Wrap in MouseRegion so a click toggles this one card. Fullscreen routes
			// clicks here natively; regular mode reaches it only via the synthesized
			// dispatch in handleTerminalInput (ticket 09).
			return new MouseRegion(card, (event) => onCardMouse(entry.id, event));
		},
	);

	// ── Toggle shortcut: cycle the newest card's card-level state ──────────────
	// Keyboard fallback for the per-node mouse toggles (ticket 16): cycle the
	// NEWEST card full-collapse → default → all-expanded → back. Per-node clicks
	// live in onCardMouse; this gives a mouse-free way to reach each card-level
	// state on the card the user is most likely looking at.
	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: "Activity feed: cycle newest card (full-collapse / default / expanded)",
		handler: (ctx: ExtensionContext) => {
			if (!hasLiveUI(ctx)) return;
			const id = view.order[view.order.length - 1];
			if (!id) return;
			const model = view.models.get(id);
			if (!model) return;
			const cv = getCardView(view, id);
			let label: string;
			if (cv.fullCollapsed) {
				// full → default: the groups tree with members hidden (boxes are modals now).
				cv.fullCollapsed = false;
				cv.membersVisible.clear();
				label = "default";
			} else if (isAllExpanded(model, cv)) {
				// all-expanded → full-collapse.
				cv.fullCollapsed = true;
				label = "collapsed";
			} else {
				// default → all-expanded.
				setAllExpanded(model, cv);
				label = "expanded";
			}
			runtime.tui?.requestRender();
			// Transient keyed footer status (ticket 19): echoes the new state without a
			// persistent transcript line, then self-clears.
			ctx.ui.setStatus(TOGGLE_STATUS_KEY, `Activity feed: ${label}`);
			if (toggleStatusTimer) clearTimeout(toggleStatusTimer);
			toggleStatusTimer = setTimeout(() => {
				ctx.ui.setStatus(TOGGLE_STATUS_KEY, undefined);
				toggleStatusTimer = undefined;
			}, TOGGLE_STATUS_MS);
		},
	});

	// ── Guarded leading-Spacer patch: LIVE-instance acquisition (ticket 31) ────
	// Patching the imported AssistantMessageComponent.prototype (ticket 30) had ZERO
	// live effect: the CLI runs a BUNDLE whose class object differs from the one the
	// extension imports, and the bundle also minifies updateContent so the old
	// fingerprint never matched it. Instead we acquire the prototype from a LIVE
	// instance found by walking the running tree from the captured TUI handle, and
	// patch THAT (identity duck-typed, Spacer duck-typed, fingerprint whitespace-
	// normalized — all in src/patches.ts). Attempted lazily on assistant activity
	// (message_start / message_update) until it resolves once per session: activate,
	// or fail open against a found instance. Retries while no instance exists yet.
	// Patch acquisition is owned by PatchController (ticket 38); see
	// patchController.tryPatchLivePrototype below.

	// ── Visibility command (ticket 31 part 3) ─────────────────────────────────
	// `/activity-patch` prints the live patch status {active, reason} so activation
	// is checkable in a real pane (the false-green ticket-30 failure was invisible).
	pi.registerCommand("activity-patch", {
		description: "Show the activity-feed blank-line patch status (active/reason)",
		handler: async (_args, ctx) => {
			const status = patchController.getStatus();
			const state = status.active
				? "active — leading blank suppressed on the live AssistantMessageComponent"
				: `inactive (${status.reason ?? "unknown"})`;
			try {
				ctx.ui.notify(`activity-feed patch: ${state}`, status.active ? "info" : "warning");
			} catch {
				// No UI to notify through; nothing else to do.
			}
		},
	});

	// ── Lifecycle wiring ──────────────────────────────────────────────────────
	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		// Blank the collapsed-thinking placeholder so the ctrl+t-hidden state adds no
		// visible label either (ticket 20; pairs with the markdown transformer above).
		if (hasLiveUI(ctx)) ctx.ui.setHiddenThinkingLabel("");
		// Always register the capture widget so the live card / toggle shortcut have a
		// requestRender handle; it also enables mouse reporting unless --no-activity-mouse.
		if (hasLiveUI(ctx)) setupCapture(ctx);
		// The leading-Spacer patch is acquired lazily on the first assistant message
		// (tryPatchLivePrototype) once a live component exists — a component is mounted
		// only after a message starts, so there is nothing to patch here yet.

		// Re-hide folded narration after ANY rebuild that re-activates the extension
		// (owner bug: /reload showed every folded paragraph natively again). The
		// rebuilt tree renders the ORIGINAL un-blanked stored messages, and a reload
		// also threw away the old runtime's hide registry. Collect known narration
		// from every persisted card entry — an in-process /reload keeps the live
		// mutated card data objects, so this is complete there. (A cross-process
		// /resume still has empty snapshots — known open limitation.) The tree may
		// not be mounted yet at session_start, so retry on a short back-off;
		// idempotent + render-only, so extra sweeps are harmless.
		const sweepNarration = (): void => {
			try {
				const texts = new Set<string>();
				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type !== "custom") continue;
					const custom = entry as CustomEntry<CardModel>;
					if (custom.customType !== CARD_TYPE) continue;
					for (const t of narrationTexts(custom.data?.entries ?? [])) texts.add(t);
				}
				if (texts.size === 0 || !runtime.tui) return;
				if (rehideNarrationAfterRebuild(runtime.tui, texts) > 0) runtime.tui.requestRender();
			} catch {
				// Fail open: narration stays visible natively (never lost, only doubled).
			}
		};
		sweepNarration();
		setTimeout(sweepNarration, 150);
		setTimeout(sweepNarration, 600);
	});

	pi.on("message_start", (event: MessageStartEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		// The streaming AssistantMessageComponent is created + mounted when an assistant
		// message starts (interactive-mode message_start). Acquire the live prototype now
		// so the patch is in place before the message's leading Spacer would persist.
		if (event.message?.role === "assistant") patchController.tryPatchLivePrototype(ctx);
	});

	pi.on("agent_start", (_event: AgentStartEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		// A new agent response begins: clear per-response accumulation (which first
		// force-settles any card still live from an abnormally-ended prior response —
		// ticket 32 catch-all). The card is appended live on the first tool (ticket 11)
		// and settled in place at agent_settled, covering every turn in between.
		resetResponse();
	});

	// ── Direct abnormal-end handling (ticket 32 point 2) ──────────────────────
	// message_end fires for EVERY assistant message carrying its final stopReason
	// (agent-session.js _handleAgentEvent), including the errored/aborted one that
	// ends a broken stream (agent-loop.js streamAssistantResponse emits message_end
	// on both the "done" and "error" stream events). When that stopReason is "error"
	// (stream failure) or "aborted" (user Esc), settle the live card as interrupted
	// NOW so the "· interrupted" marker shows immediately, rather than waiting for the
	// retry's agent_start (error) or the trailing agent_settled (abort). Normal
	// "stop"/"toolUse"/"length" messages are left for agent_settled.
	pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		const message = event.message;
		if (message?.role === "assistant") settleIfAbnormal((message as { stopReason?: string }).stopReason);
	});

	// agent_end carries the run's messages with the terminal assistant's stopReason
	// (agent-loop.js emits it right after the errored/aborted turn_end). A redundant
	// safety net for the message_end path above — idempotent, so double-settling the
	// same card is a no-op (forceSettleLingering guards on cardModel.live).
	pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				settleIfAbnormal((message as { stopReason?: string }).stopReason);
				break;
			}
		}
	});

	// ── Compaction survival (ticket 25 layer 2) ─────────────────────────────
	// A compaction drops every entry before its firstKeptEntryId from the rebuilt
	// transcript (interactive-mode compaction_end → chatContainer.clear() then
	// renderSessionEntries(buildContextEntries()); a custom entry appended earlier in
	// the response is not in the kept context, so its card VANISHES — the owner's
	// audited bug). When the last card entry did not survive, re-append a fresh
	// SETTLED card so the response stays visible; pi renders the new entry
	// immediately (agent-session entry_appended → addCustomEntryToChat) and it lands
	// in the kept context, so it also survives the next /resume. Deduped per source
	// entry (reappendedFrom) so one response never yields two cards.
	pi.on("session_compact", (_event: SessionCompactEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		// Re-hide already-folded narration (ticket 41): a compaction rebuild recreates
		// every AssistantMessageComponent from the ORIGINAL, un-blanked stored messages
		// (hideMessageTextBlock never touches what's persisted \u2014 the byte-identical-
		// context constraint), so any paragraph already folded into a card would
		// otherwise reappear natively the instant the tree is rebuilt. Sweep EVERY
		// tracked card (past + current) plus a still-unconfirmed pending block, and
		// re-apply the hide to the freshly-rebuilt tree by text match. Independent of
		// the card-survival logic below \u2014 must run even if that decides there's
		// nothing to re-append.
		const texts = new Set<string>();
		for (const model of view.models.values()) for (const t of narrationTexts(model.entries ?? [])) texts.add(t);
		if (pendingNarration) texts.add(pendingNarration.text);
		if (runtime.tui) rehideNarrationAfterRebuild(runtime.tui, texts);

		const entries = ctx.sessionManager.getEntries();
		let lastCard: CustomEntry<CardModel> | undefined;
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === CARD_TYPE) lastCard = entry as CustomEntry<CardModel>;
		}
		if (!lastCard) return;
		const survivingEntryIds = ctx.sessionManager.buildContextEntries().map((entry) => entry.id);
		const reappend = shouldReappendCard({
			lastCardEntryId: lastCard.id,
			survivingEntryIds,
			alreadyReappended: reappendedFrom.has(lastCard.id),
		});
		if (!reappend) return;
		reappendedFrom.add(lastCard.id);
		const source = lastCard.data;
		if (source && liveModels.has(source)) {
			// In-process model (same object by reference): re-append it AS-IS. If the
			// response already settled it renders settled; if the compaction fired
			// mid-response the SAME live model keeps ticking in the new entry and settles
			// in place at agent_settled (settleResponse mutates this object). appendCard
			// registers the new id and keeps it out of staleCards, so the live path runs.
			appendCard(source);
		} else {
			// Stale persisted snapshot (a resumed session then compacted): render it
			// gracefully as settled via the stale path ("Worked for —" when the duration
			// was never recorded), never a ticking ghost.
			const frozen = (source ?? {}) as CardModel;
			pi.appendEntry<CardModel>(CARD_TYPE, frozen);
			const id = uiCtx?.sessionManager.getLeafId() ?? undefined;
			if (id) {
				staleCards.add(id);
				view.models.set(id, frozen);
			}
		}
	});

	pi.on("turn_start", (event: TurnStartEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		// A turn boundary does NOT break the group (ticket 10): sequential tool-only
		// turns stay one group. Only anchor the "Worked for Xs" clock on the first
		// turn_start of the response.
		if (responseStartMs === 0) responseStartMs = event.timestamp ?? Date.now();
	});

	pi.on("message_update", (event: MessageUpdateEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		// Fallback acquisition (ticket 31): if message_start ran before the streaming
		// component was mounted (or the walk missed it), retry here — updateContent is
		// called on every streaming delta, so patching now still catches the message.
		patchController.tryPatchLivePrototype(ctx);
		const ame = event.assistantMessageEvent;
		switch (ame.type) {
			case "thinking_start":
				// New thinking starting is proof anything pending was not the final answer
				// (ticket 41).
				confirmNarrationNonFinal();
				thinkingStartMs = Date.now();
				thinkingBuf = "";
				// Tick while the span streams so the live thought entry can appear at
				// MIN_THOUGHT_MS and its timer/tail refresh (ticket 23). No-ops in print
				// mode (startTimer guards on uiCtx). If tools are running the timer is
				// already ticking; this keeps it alive across the thinking span.
				startTimer();
				break;
			case "thinking_delta":
				// Capture the streamed reasoning/summary text for this span (ticket 20).
				// Providers that stream reasoning text (Anthropic) or summary titles
				// (OpenAI Responses) both deliver it here; a span with no text keeps an
				// empty buffer and its row degrades to a bare "· Thought Ns".
				if (thinkingBuf.length < THINKING_BUF_MAX) {
					thinkingBuf += (ame as { delta?: string }).delta ?? "";
					if (thinkingBuf.length > THINKING_BUF_MAX) thinkingBuf = thinkingBuf.slice(0, THINKING_BUF_MAX);
				}
				break;
			case "thinking_end": {
				const ms = thinkingStartMs ? Date.now() - thinkingStartMs : 0;
				// Provider-stream normalization (span-classify.ts, owner issue): some
				// providers (Cursor) stream TOOL ACTIVITY through the thinking channel \u2014
				// "$ grep \u2026", "read /path", "Cursor shell: <cmd>" dumps with output, no
				// real tool events at all. A span classified as a tool step becomes a
				// synthetic settled call (a proper card member with the dump as its modal
				// output) instead of polluting/overwriting the Thought entry.
				const cls = classifyThinkingSpan(thinkingBuf);
				if (cls.kind === "tool") {
					syntheticCallSeq += 1;
					grouper.addCall({
						toolCallId: `span-syn-${syntheticCallSeq}`,
						name: cls.family,
						arguments: {},
						startMs: Date.now() - ms,
						endMs: Date.now(),
						fullOutput: thinkingBuf.slice(0, MAX_MODAL_CAPTURE),
						labelOverride: cls.label,
					});
				} else {
					// Copy the buffer into the span AT CLOSE (ticket 23 bounded retention): the
					// live box referenced thinkingBuf each tick; here the span freezes to it.
					grouper.addThought(ms, thinkingBuf);
				}
				thinkingStartMs = undefined;
				thinkingBuf = "";
				// Transform the live "Thinking…" row to its settled "Thought Ns" form in
				// place, then stop ticking if neither tools nor thinking remain active.
				refreshLive();
				if (!shouldTick(runningTools, thinkingActive())) stopTimer();
				break;
			}
			case "text_start":
				// A NEW text block starting is ALSO proof any pending one wasn't final
				// (ticket 41) \u2014 two text blocks can stream back to back with nothing
				// else between them.
				confirmNarrationNonFinal();
				// A text block opened, but empty/whitespace-only blocks must NOT break
				// the group (ticket 10): defer the break until non-whitespace content
				// actually arrives (text_delta / text_end).
				grouper.textStart();
				break;
			case "text_delta":
				// First non-whitespace delta breaks the current tool group (ticket 10).
				grouper.textDelta(ame.delta);
				break;
			case "text_end":
				// Break on a non-empty block even if no delta carried content (some
				// providers deliver the whole text in text_end).
				grouper.textEnd(ame.content);
				// Capture the instance NOW (ticket 41) \u2014 unambiguous at this exact
				// moment, since no later message has started yet. Held until either
				// confirmed non-final (hidden, folded into the card) or the response
				// settles with nothing after it (the true final answer \u2014 left alone).
				if (hasNonWhitespace(ame.content)) {
					const instances = findAssistantMessageComponents(runtime.tui);
					const instance = instances[instances.length - 1];
					if (instance) pendingNarration = { instance, contentIndex: ame.contentIndex, text: ame.content.trim() };
				}
				// Reflect the new narration entry in the card NOW (it's already in the
				// grouper's entries \u2014 snapshot() never withholds it), instead of waiting for
				// the next unrelated event to happen to call refreshLive.
				refreshLive();
				break;
			default:
				break;
		}
	});

	pi.on("tool_execution_start", (event: ToolExecutionStartEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		// Universal tool-row absorption: hide this call's native row from its FIRST
		// frame (the card is the only view of tool activity \u2014 Codex style). The id
		// goes into the set BEFORE the component's first render; the render patch
		// then returns zero rows for it, so nothing paints and nothing collapses
		// later (no differential-repaint/scrollback concerns at all).
		absorbed.add(event.toolCallId);
		// Acquire the ToolExecutionComponent prototype patch as soon as a live
		// instance exists. This event may run before pi's own UI handler mounts the
		// component, so tool_execution_end retries too. No-op once installed.
		tryAcquireToolRowPatch();
		// A new tool call starting is proof anything pending wasn't the final answer
		// (ticket 41).
		confirmNarrationNonFinal();
		const call: ToolCall = {
			toolCallId: event.toolCallId,
			name: event.toolName,
			arguments: (event.args ?? {}) as Record<string, unknown>,
			startMs: Date.now(),
		};
		ledger.set(event.toolCallId, call);
		grouper.addCall(call);
		runningTools++;
		// First tool of the response: append the card NOW so it sits above the answer
		// (ticket 11). Idempotent for the rest of the response.
		ensureCard();
		startTimer();
		refreshLive();
	});

	pi.on("tool_execution_update", (_event: ToolExecutionUpdateEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		// Updates don't change the ledger shape; the live elapsed clock is driven
		// by the timer. Nothing to accumulate here.
	});

	pi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		tryAcquireToolRowPatch();
		const call = ledger.get(event.toolCallId);
		if (call) {
			call.endMs = Date.now();
			call.isError = event.isError;
			// Capture the FULL output for EVERY tool (owner issue: MCP/extension tool
			// modals opened empty \u2014 capture was gated to command/search tools). Bounded
			// at MAX_MODAL_CAPTURE; truncated command output additionally sets
			// fullOutputPath (tool_result below), read lazily on open and preferred.
			const text = extractResultText(event.result);
			if (text.length > 0) call.fullOutput = text.slice(0, MAX_MODAL_CAPTURE);
			// The short INLINE preview stays gated to command/search calls (ticket 12
			// req 5): read/edit/write target lines say enough, file bodies are huge.
			if (PREVIEW_TOOLS.has(call.name)) {
				const preview = previewLines(text);
				if (preview.length > 0) call.resultPreview = preview;
				// On a failed command, capture the exit code for the box badge (ticket 17).
				if (event.isError) {
					const code = extractExitCode(text);
					if (code !== undefined) call.exitCode = code;
				}
			}
		}
		runningTools = Math.max(0, runningTools - 1);
		// Refresh BEFORE stopping the timer so the just-finished call's ✓/✗ +
		// duration lands in real time (ticket 12 req 3, reviewer P2): the ledger call
		// now has an endMs, so this snapshot drops its spinner. Ordering is safe —
		// refreshLive() never (re)starts the timer, so the stopTimer() below still
		// ends the ticking once the last tool of the batch settles. The timer also
		// stays alive if a thinking span is streaming (ticket 23) — shouldTick().
		refreshLive();
		if (!shouldTick(runningTools, thinkingActive())) stopTimer();
	});

	// Ticket 35: tool_result carries the TYPED details, incl. bash/powershell
	// fullOutputPath — the temp file holding untruncated output when the command
	// truncated it. Store the path so the modal reads the complete output lazily.
	pi.on("tool_result", (event: ToolResultEvent) => {
		const call = ledger.get(event.toolCallId);
		if (!call) return;
		if ((event.toolName === "bash" || event.toolName === "powershell") && event.details) {
			const path = (event.details as { fullOutputPath?: unknown }).fullOutputPath;
			if (typeof path === "string" && path.length > 0) call.fullOutputPath = path;
		}
	});

	pi.on("turn_end", (_event: TurnEndEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		// A turn ends: do NOT settle and do NOT break the group (ticket 10 —
		// sequential tool-only turns stay one group; the group only breaks on
		// assistant text). One card per response is emitted at agent_settled
		// (ticket 08). Absorb this turn's tool rows now, while they are still in the
		// viewport — collapsing them here is a cheap differential repaint, whereas
		// waiting for agent_settled would force a full redraw (scrollback wipe) once
		// earlier turns scroll off (ticket 08 fix).
		absorbCurrentRows();
	});

	pi.on("agent_settled", (_event: AgentSettledEvent, ctx: ExtensionContext) => {
		captureCtx(ctx);
		settleResponse();
		// Safety net: never leave a timer or widget running after a run settles.
		stopTimer();
		clearLive();
	});

	pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
		stopTimer();
		clearLive();
		// Reverse the guarded runtime patch (tickets 30 + 31) so pi's live
		// AssistantMessageComponent prototype is restored exactly as found; only restores
		// if our wrapper is still installed (owned by PatchController, ticket 38).
		patchController.teardown();
		if (toggleStatusTimer) {
			clearTimeout(toggleStatusTimer);
			toggleStatusTimer = undefined;
			if (hasLiveUI(ctx)) {
				try {
					ctx.ui.setStatus(TOGGLE_STATUS_KEY, undefined);
				} catch {
					// UI context may already be torn down.
				}
			}
		}
		modalController.teardown();
		teardownCapture();
	});
}
