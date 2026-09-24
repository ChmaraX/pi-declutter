// Output modal component (ticket 35), split out of index.ts (ticket 38). A
// focused overlay showing one member's full output (or one thought's text),
// scrollable and copyable. Rendered via ctx.ui.custom({overlay:true}); the TUI
// gives it keyboard focus and calls handleInput. Bordered like the old inline box
// but full-height and scrollable: title bar (label + duration + badge / thought
// summary), a scroll window over the body, and a footer hint line. `c` copies the
// untruncated raw text; ↑/↓/PgUp/PgDn/Home/End scroll; Esc closes.
//
// Pure of any activityFeed() closure state: the content, theme, and the
// done/copy callbacks are all injected by the ModalController that owns it.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Tone } from "./card-shape.ts";
import { clampScrollTop, type ModalContent, scrollHint, visibleSlice, wrapBody } from "./modal.ts";
import { styleTone } from "./styling.ts";

/** Max body rows the modal shows before scrolling (ticket 35). The overlay's
 * maxHeight:80% ultimately bounds the box; this caps the body window so a huge
 * output scrolls rather than overflowing the overlay. */
const MODAL_BODY_MAX_ROWS = 24;

/** Non-body rows the modal frame always draws: top border, title, caption,
 * caption separator, footer separator, footer, bottom border (review P2 #4).
 * Subtracted from the overlay's height when sizing the body viewport. */
const MODAL_CHROME_ROWS = 7;

/** End-truncate to a visible-width budget, appending … on overflow. */
export function truncateVisible(text: string, max: number): string {
	if (visibleWidth(text) <= max) return text;
	const chars = [...text];
	let out = "";
	let w = 0;
	for (const ch of chars) {
		const cw = visibleWidth(ch);
		if (w + cw > Math.max(0, max - 1)) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/** Colour a modal badge through the theme (success/error/dim tone). */
export function styleBadge(theme: Theme, badge: { text: string; tone: Tone }): string {
	return styleTone(theme, badge.tone, badge.text);
}

export class OutputModal implements Focusable {
	focused = false;
	private top = 0;
	/** Rows the body area got last render, so PgUp/PgDn page by a real screen. */
	private lastViewport = 10;
	/** Live terminal height, fed by the overlay's `visible(termW, termH)` callback
	 * each render cycle (review P2 #4). Lets the body viewport fit the real overlay
	 * (maxHeight 80%) instead of a fixed cap that clips the footer on short
	 * terminals. 0 until the first callback; render() then falls back to the cap. */
	private termHeight = 0;
	/** Live terminal width, fed by the overlay's `visible(termW, termH)` callback
	 * (ticket 39). Lets a mid-session resize reflow the open modal. 0 until the
	 * first callback; render() wraps against its own width argument regardless. */
	private termWidth = 0;
	/** Body wrapped to the last render width, memoized so wrapping runs once per
	 * width change rather than every frame (ticket 39). */
	private wrappedBody: string[] = [];
	private wrappedForWidth = -1;
	/** Content width the body was last wrapped/scrolled against, so handleInput's
	 * paging math uses the same total row count render() produced. */
	private lastInnerContentWidth = 78;
	private readonly content: ModalContent;
	private readonly theme: Theme;
	private readonly done: (result: void) => void;
	private readonly onCopy: () => void;
	/** True while the footer shows "\u2713 Copied" (set/cleared by ModalController
	 * around its feedback timer). */
	private copiedVisible = false;

	constructor(content: ModalContent, theme: Theme, done: (result: void) => void, onCopy: () => void) {
		this.content = content;
		this.theme = theme;
		this.done = done;
		this.onCopy = onCopy;
	}

	/** Called from the overlay's `visible` callback with the current terminal
	 * height so render() can size the body to the actual overlay height. */
	setTerminalHeight(height: number): void {
		this.termHeight = height;
	}

	showCopied(): void {
		this.copiedVisible = true;
	}

	clearCopied(): void {
		this.copiedVisible = false;
	}

	/** Called from the overlay's `visible` callback with the current terminal width
	 * so a resize reflows the wrapped body (ticket 39). */
	setTerminalWidth(width: number): void {
		this.termWidth = width;
	}

	/** The body wrapped to `innerContentWidth`, memoized per width (ticket 39). */
	private bodyRows(innerContentWidth: number): string[] {
		if (this.wrappedForWidth !== innerContentWidth) {
			this.wrappedBody = wrapBody(this.content.body, innerContentWidth, visibleWidth);
			this.wrappedForWidth = innerContentWidth;
		}
		return this.wrappedBody;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done(undefined);
			return;
		}
		if (data === "c" || data === "C") {
			this.onCopy();
			return;
		}
		const total = this.bodyRows(this.lastInnerContentWidth).length;
		const page = Math.max(1, this.lastViewport - 1);
		if (matchesKey(data, "up")) this.top -= 1;
		else if (matchesKey(data, "down")) this.top += 1;
		else if (matchesKey(data, "pageUp")) this.top -= page;
		else if (matchesKey(data, "pageDown")) this.top += page;
		else if (matchesKey(data, "home")) this.top = 0;
		else if (matchesKey(data, "end")) this.top = total;
		else return;
		// Clamp against the last render's viewport; re-clamped precisely in render().
		this.top = clampScrollTop(this.top, total, this.lastViewport);
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(10, width - 2);
		const lines: string[] = [];
		const pad = (s: string, len: number): string => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};
		const border = (s: string): string => th.fg("border", s);
		const rowLine = (content: string): string => border("│") + pad(content, innerW) + border("│");

		// Title bar: label (+ badge on the right).
		const badge = this.content.badge;
		const badgeText = badge ? badge.text : "";
		const badgeVis = badge ? visibleWidth(badgeText) + 1 : 0;
		const titleRoom = Math.max(0, innerW - 1 - badgeVis);
		const title = ` ${truncateVisible(this.content.title, titleRoom)}`;
		const badgeStyled = badge ? `${styleBadge(th, badge)} ` : "";
		const titlePad = Math.max(0, innerW - visibleWidth(title) - visibleWidth(badgeText) - (badge ? 1 : 0));
		lines.push(border("╭") + border("─".repeat(innerW)) + border("╮"));
		lines.push(border("│") + th.fg("accent", title) + " ".repeat(titlePad) + badgeStyled + border("│"));
		lines.push(rowLine(` ${th.fg("dim", this.content.caption)}`));
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));

		// Body: a scroll window. Chrome is title(2)+caption(1)+sep(1)+footersep(1)
		// +footer(1)+top/bottom border(2) = MODAL_CHROME_ROWS. When the overlay has
		// reported a terminal height (review P2 #4), size the viewport to fit
		// 80% of it (matching maxHeight:"80%") minus chrome, so the footer/bottom
		// border are never clipped on a short terminal; otherwise fall back to the
		// fixed cap. Either way scroll covers any overflow.
		const overlayRows = this.termHeight > 0 ? Math.floor(this.termHeight * 0.8) : MODAL_BODY_MAX_ROWS + MODAL_CHROME_ROWS;
		const roomForBody = Math.max(1, overlayRows - MODAL_CHROME_ROWS);
		// Body is word-wrapped to the content width (ticket 39), so long lines flow
		// onto as many display rows as needed instead of being truncated with "…".
		// The body cell has one leading space, so wrap to innerW - 1.
		const innerContentWidth = Math.max(1, innerW - 1);
		this.lastInnerContentWidth = innerContentWidth;
		const wrapped = this.bodyRows(innerContentWidth);
		const viewport = Math.max(1, Math.min(wrapped.length, MODAL_BODY_MAX_ROWS, roomForBody));
		this.lastViewport = viewport;
		this.top = clampScrollTop(this.top, wrapped.length, viewport);
		const slice = visibleSlice(wrapped, this.top, viewport);
		for (const bodyLine of slice) {
			lines.push(rowLine(` ${th.fg("dim", bodyLine)}`));
		}
		// Pad the body area to a stable height so the box doesn't jump while scrolling
		// a short tail (only when there IS content to stabilize around).
		for (let i = slice.length; i < viewport; i++) lines.push(rowLine(""));

		// Footer hint. After a copy, "c copy" becomes a success-toned "✓ Copied"
		// for a moment (owner request: feedback contained to the floating pane).
		const hint = scrollHint(this.top, viewport, wrapped.length);
		const hintPart = hint ? `${hint}  ·  ` : "";
		const footer = this.copiedVisible
			? ` ${th.fg("dim", `${hintPart}↑/↓/PgUp scroll · `)}${th.fg("success", "✓ Copied")}${th.fg("dim", " · Esc close")}`
			: ` ${th.fg("dim", `${hintPart}↑/↓/PgUp scroll · c copy · Esc close`)}`;
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		lines.push(rowLine(footer));
		lines.push(border("╰") + border("─".repeat(innerW)) + border("╯"));
		return lines;
	}
}
