// Pure theme-styling helpers shared by the card renderer and the output modal.
// They translate the pure card-shape Tone/Segment/Line data into themed
// strings; no closure state, only the live Theme passed in.

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Segment, ShapeLine, Tone } from "./card-shape.ts";

// The theme foreground role each Tone maps to. `bold` is the one special case
// (it uses theme.bold(), not a foreground colour) and is handled in styleTone.
const TONE_ROLE: Record<Exclude<Tone, "bold">, "accent" | "muted" | "success" | "error" | "dim" | "text"> = {
	accent: "accent",
	muted: "muted",
	success: "success",
	error: "error",
	dim: "dim",
	text: "text",
};

/** Colour text for a Tone through the live theme (shared by segments + badges). */
export function styleTone(theme: Theme, tone: Tone, text: string): string {
	return tone === "bold" ? theme.bold(text) : theme.fg(TONE_ROLE[tone], text);
}

/** Colour one shape segment through the live theme. */
export function styleSegment(theme: Theme, segment: Segment): string {
	return styleTone(theme, segment.tone, segment.text);
}

/** Render one shape line: `indent` leading spaces then the themed segments. A
 * hovered clickable row is bolded for a theme-consistent highlight (its
 * chevron is already bumped to `accent` in shapeCard); bold avoids the ANSI
 * bg-reset seam that nesting a second background inside the card's
 * customMessageBg Box would leave on the row's trailing pad. */
export function styleLine(theme: Theme, line: ShapeLine): string {
	const body = line.segments.map((segment) => styleSegment(theme, segment)).join("");
	const styled = line.hovered ? theme.bold(body) : body;
	return line.indent > 0 ? " ".repeat(line.indent) + styled : styled;
}

/** Wraps styled text to a display width, keeping ANSI state intact per row. */
export type RowWrap = (text: string, width: number) => string[];

/** Split segments at a code-point offset into [head, tail]. */
function splitSegments(segments: readonly Segment[], offset: number): [Segment[], Segment[]] {
	const head: Segment[] = [];
	const tail: Segment[] = [];
	let remaining = offset;
	for (const segment of segments) {
		const chars = [...segment.text];
		if (remaining >= chars.length) {
			head.push(segment);
			remaining -= chars.length;
		} else if (remaining > 0) {
			head.push({ ...segment, text: chars.slice(0, remaining).join("") });
			tail.push({ ...segment, text: chars.slice(remaining).join("") });
			remaining = 0;
		} else {
			tail.push(segment);
		}
	}
	return [head, tail];
}

/**
 * Render one shape line as display rows no wider than `width`, with a hanging
 * indent: a row that starts with a marker ("\u203a ", "\u00b7 ", "$ ", a tool glyph or
 * spinner frame) wraps its continuation rows under the first word after the
 * marker, not back at the card's left edge. Rows without an indent (the
 * header) wrap plainly.
 */
export function styleLineRows(
	theme: Theme,
	line: ShapeLine,
	width: number,
	wrap: RowWrap,
	measure: (text: string) => number = (text) => [...text].length,
): string[] {
	const plain = line.segments.map((segment) => segment.text).join("");
	const marker = line.indent > 0 ? /^\S+ /.exec(plain)?.[0] : undefined;
	if (!marker) return wrap(styleLine(theme, line), width);
	const [head, tail] = splitSegments(line.segments, [...marker].length);
	const style = (segments: Segment[]): string => {
		const body = segments.map((segment) => styleSegment(theme, segment)).join("");
		return line.hovered ? theme.bold(body) : body;
	};
	const hang = line.indent + measure(marker);
	const rows = wrap(style(tail), Math.max(1, width - hang));
	const first = " ".repeat(line.indent) + style(head);
	const pad = " ".repeat(hang);
	return rows.map((row, i) => (i === 0 ? first + row : pad + row));
}
