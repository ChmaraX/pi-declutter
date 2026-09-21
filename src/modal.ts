/**
 * Pure modal-content model + scroll windowing for the floating output overlay
 * (ticket 35). The inline bordered output box (ticket 17) was hard to read and
 * copy; clicking a member/thought row now opens a focused overlay instead. This
 * module owns everything renderable-and-testable: the title bar (label +
 * duration + Success/Exit badge, or "Thought Ns · summary"), the raw body text
 * used for both display and clipboard copy, and the scroll window math. The
 * overlay Component in index.ts is a thin shell around this.
 *
 * Kept pi-import-free so it unit-tests headlessly.
 */

import type { ShapeItem, ShapeThought, Tone } from "./card-shape.ts";
import { boxTail, formatDuration, formatSeconds, itemBadge } from "./card-shape.ts";

/** One modal's full content: what the overlay renders and what `c` copies. */
export interface ModalContent {
	/** Title bar text left segment (label / thought summary). */
	title: string;
	/** Optional badge on the title's right (Success / Exit code N / ✗ Failed). */
	badge?: { text: string; tone: Tone };
	/** Caption shown above the body ("Shell" / "Output" / "Thinking"). */
	caption: string;
	/** Body lines as raw text (no ANSI); rendered and copied verbatim. */
	body: string[];
	/** The exact text `c` copies — the untruncated raw body. */
	copyText: string;
	/** True when the body was loaded from a truncated capture's full-output file. */
	full: boolean;
}

/** Compose the modal content for a tool member row. `fullText`, when provided,
 * is the untruncated output (from the bash fullOutputPath or the raised capture
 * cap); otherwise the shaped preview tail is used. A command tool leads its body
 * with the `$ <command>` line so the modal is self-describing. */
export function itemModalContent(item: ShapeItem, fullText?: string): ModalContent {
	const badge = itemBadge(item);
	const isCommand = item.command !== undefined;
	const caption = isCommand ? "Shell" : "Output";
	const raw = fullText !== undefined && fullText.length > 0 ? fullText : item.preview.join("\n");
	const splitLines = raw.length > 0 ? raw.split("\n") : [];
	// Ticket-19 cleanup for the modal body (review P2 #2): drop trailing blanks
	// and the duplicated "Command exited with code N" line the Exit-code badge
	// already carries. boxTail is pure and shared with the former inline box.
	const rawLines = boxTail(splitLines, item.exitCode);
	const body: string[] = [];
	if (isCommand) body.push(`$ ${item.command}`);
	body.push(...rawLines);
	// Copy the command + output together for a command tool, or just the output.
	const copyText = isCommand ? [`$ ${item.command}`, ...rawLines].join("\n") : rawLines.join("\n");
	return {
		// Match the member row's duration format (formatSeconds → "0.3s").
		title: `${item.label} (${formatSeconds(item.durMs)})`,
		badge,
		caption,
		body,
		copyText,
		full: fullText !== undefined && fullText.length > 0,
	};
}

/** Compose the modal content for a thought row: the full captured span text. */
export function thoughtModalContent(thought: ShapeThought, fullText?: string): ModalContent {
	const summary = thought.summary ? ` · ${thought.summary}` : "";
	const raw = fullText !== undefined && fullText.length > 0 ? fullText : thought.tail.join("\n");
	const body = raw.length > 0 ? raw.split("\n") : [];
	return {
		title: `Thought ${formatDuration(thought.ms)}${summary}`,
		caption: "Thinking",
		body,
		copyText: raw,
		full: false,
	};
}

/** A vertical scroll window over `total` lines showing `viewport` at a time.
 * Clamped so `top` never scrolls past the last full page. Pure. */
export interface ScrollWindow {
	top: number;
	viewport: number;
	total: number;
}

/** Clamp a desired top to [0, maxTop] where maxTop keeps the last line reachable
 * without over-scrolling into blank space below the content. */
export function clampScrollTop(desiredTop: number, total: number, viewport: number): number {
	const maxTop = Math.max(0, total - viewport);
	if (desiredTop < 0) return 0;
	if (desiredTop > maxTop) return maxTop;
	return desiredTop;
}

/** The slice of body lines visible for a given scroll window. */
export function visibleSlice(body: readonly string[], top: number, viewport: number): string[] {
	const clamped = clampScrollTop(top, body.length, viewport);
	return body.slice(clamped, clamped + viewport);
}

/** Scroll-position hint like "12–31 / 148" (1-based, inclusive) or "" when the
 * whole body fits in the viewport. */
export function scrollHint(top: number, viewport: number, total: number): string {
	if (total <= viewport) return "";
	const clamped = clampScrollTop(top, total, viewport);
	const first = clamped + 1;
	const last = Math.min(total, clamped + viewport);
	return `${first}\u2013${last} / ${total}`;
}
