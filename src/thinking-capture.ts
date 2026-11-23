/**
 * Capture of the CURRENT thinking span: self-timed start plus the streamed
 * text, bounded so a long reasoning stream never grows retention.
 *
 * Provider thinking events carry no timestamps, so the span is timed from
 * thinking_start to thinking_end with the caller's clock. At most one span is
 * open at a time; a new start replaces any open one.
 */

import type { LiveThinking, ThoughtSpan } from "./grouping.ts";

/** Per-span text cap: ~2KB is enough for the summary line plus a 10-line
 * tail box; anything beyond is dropped (bounded retention, like the
 * tool-output previews). */
export const THINKING_BUF_MAX = 2048;

export class ThinkingCapture {
	private startMs: number | undefined;
	private buf = "";
	private readonly maxChars: number;

	constructor(maxChars = THINKING_BUF_MAX) {
		this.maxChars = maxChars;
	}

	/** True while a span is open (drives the tick condition + live thought row). */
	get active(): boolean {
		return this.startMs !== undefined;
	}

	/** Open a new span, discarding any previous buffer. */
	start(now: number): void {
		this.startMs = now;
		this.buf = "";
	}

	/** Append streamed text, truncating at the cap. */
	append(delta: string): void {
		if (this.buf.length >= this.maxChars) return;
		this.buf += delta;
		if (this.buf.length > this.maxChars) this.buf = this.buf.slice(0, this.maxChars);
	}

	/** The open span as of `now`, or undefined when none is open. `text` is the
	 * live buffer; downstream copies only a bounded tail. */
	live(now: number): LiveThinking | undefined {
		if (this.startMs === undefined) return undefined;
		return { ms: now - this.startMs, text: this.buf };
	}

	/** Close the span and return it. A close without a matching start yields a
	 * 0 ms span with whatever text streamed. */
	end(now: number): ThoughtSpan {
		const span = { ms: this.startMs === undefined ? 0 : now - this.startMs, text: this.buf };
		this.reset();
		return span;
	}

	/** Drop any open span without reporting it. */
	reset(): void {
		this.startMs = undefined;
		this.buf = "";
	}
}
