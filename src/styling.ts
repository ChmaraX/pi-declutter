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
