/**
 * Tests for the hanging-indent row layout (styleLineRows): continuation rows of
 * a wrapped card row line up under the text after the row's marker ("› ", "· ",
 * "$ ", a glyph) instead of returning to the card's left edge.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ShapeLine } from "../src/card-shape.ts";
import { styleLineRows } from "../src/styling.ts";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => `**${text}**` } as never;

/** Plain word wrap for tests: greedy, splits on spaces. */
function wrap(text: string, width: number): string[] {
	const words = text.split(" ");
	const rows: string[] = [];
	let row = "";
	for (const word of words) {
		if (row && row.length + 1 + word.length > width) {
			rows.push(row);
			row = word;
		} else {
			row = row ? `${row} ${word}` : word;
		}
	}
	if (row) rows.push(row);
	return rows.length > 0 ? rows : [""];
}

function line(indent: number, ...segments: Array<[string, string]>): ShapeLine {
	return { kind: "narration", indent, segments: segments.map(([text, tone]) => ({ text, tone: tone as never })) };
}

test("continuation rows hang under the text after the marker", () => {
	const l = line(2, ["›", "dim"], [" I'm tracing how settle changes entries and what shifts", "text"]);
	const rows = styleLineRows(theme, l, 30, wrap);
	assert.equal(rows[0], "  › I'm tracing how settle");
	// Every continuation row is indented by indent(2) + marker("› " = 2).
	for (const row of rows.slice(1)) assert.match(row, /^ {4}\S/);
	// Nothing is lost across the wrap.
	assert.equal(rows.join(" ").replace(/ +/g, " ").trim(), "› I'm tracing how settle changes entries and what shifts");
});

test("a marker split across segments keeps each segment's own styling", () => {
	const themed = {
		fg: (role: string, text: string) => `[${role}:${text}]`,
		bold: (text: string) => text,
	} as never;
	const l = line(2, ["·", "dim"], [" Thought 3s · long enough text to wrap over rows", "muted"]);
	const rows = styleLineRows(themed, l, 28, (text, width) => wrap(text.replace(/\[|\]|dim:|muted:/g, ""), width));
	assert.match(rows[0], /^ {2}\[dim:·\]/);
});

test("rows without an indent (the header) wrap plainly at the left edge", () => {
	const l: ShapeLine = { kind: "header", indent: 0, segments: [{ text: "Worked for 5s and then some", tone: "bold" }] };
	const rows = styleLineRows(theme, l, 12, wrap);
	assert.ok(rows.length > 1);
	for (const row of rows) assert.match(row, /^\*?\S/);
});

test("a hovered row bolds both the marker and the wrapped body", () => {
	const l = { ...line(2, ["›", "dim"], [" short note", "text"]), hovered: true };
	const rows = styleLineRows(theme, l, 40, (text) => [text]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0], "  **› ****short note**");
});

test("a narrow terminal never produces a zero-width wrap target", () => {
	const l = line(2, ["›", "dim"], [" abc def", "text"]);
	const rows = styleLineRows(theme, l, 3, (text, width) => {
		assert.ok(width >= 1);
		return wrap(text, width);
	});
	assert.ok(rows.length >= 1);
});
