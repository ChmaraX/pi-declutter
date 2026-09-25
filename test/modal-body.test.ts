/**
 * Styled modal bodies: the plain body stays authoritative (it is what `c`
 * copies) and `bodyStyled` mirrors it row for row. pi's renderers are stubbed,
 * so these run headlessly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ShapeItem } from "../src/card-shape.ts";
import { linkifyLine, type RichBodyDeps, withStyledBody } from "../src/modal-body.ts";
import { itemModalContent } from "../src/modal.ts";

/** Stand-in for pi's renderDiff: marks every row so placement is visible. */
const fakeRenderDiff = (diff: string): string =>
	diff
		.split("\n")
		.map((line) => `[${line}]`)
		.join("\n");

/** Stand-ins for pi-tui's hyperlink() and a filesystem-backed path resolver. */
const linkDeps: RichBodyDeps = {
	renderDiff: fakeRenderDiff,
	link: (text, url) => `{${url}|${text}}`,
	fileUrl: (p) => (p.endsWith(".ts") ? `file://${p}` : undefined),
};

function editItem(overrides: Partial<ShapeItem> = {}): ShapeItem {
	return {
		label: "Edited src/x.ts",
		durMs: 120,
		isError: false,
		running: false,
		preview: [],
		glyph: "✎",
		diff: " 1 const a = 1;\n-2 const b = 2;\n+2 const b = 42;",
		fullOutput: "Successfully replaced 1 block(s) in src/x.ts.",
		...overrides,
	};
}

test("an edit modal leads with a Diff section instead of the raw argument JSON", () => {
	const content = itemModalContent(editItem({ input: '{"path":"src/x.ts"}' }), "Successfully replaced 1 block(s).");
	assert.equal(content.caption, "Diff");
	assert.deepEqual(content.body.slice(0, 4), ["Diff:", " 1 const a = 1;", "-2 const b = 2;", "+2 const b = 42;"]);
	assert.equal(content.body.includes("Input:"), false);
	assert.ok(content.body.includes("Output:"));
	// Copy stays plain, and carries the diff verbatim.
	assert.ok(content.copyText.includes("-2 const b = 2;"));
	assert.equal(content.copyText.includes("["), false);
});

test("withStyledBody colours exactly the diff rows, leaving the rest of the body alone", () => {
	const item = editItem();
	const content = withStyledBody(itemModalContent(item, "done"), item, { renderDiff: fakeRenderDiff });
	assert.ok(content.bodyStyled);
	assert.equal(content.bodyStyled?.length, content.body.length);
	assert.deepEqual(content.bodyStyled?.slice(0, 4), [
		"Diff:",
		"[ 1 const a = 1;]",
		"[-2 const b = 2;]",
		"[+2 const b = 42;]",
	]);
	// Rows after the diff keep their plain text.
	assert.deepEqual(content.bodyStyled?.slice(4), content.body.slice(4));
	assert.equal(content.copyText.includes("["), false);
});

test("withStyledBody leaves a body with no diff untouched", () => {
	const item = editItem({ diff: undefined });
	const content = withStyledBody(itemModalContent(item, "output"), item, { renderDiff: fakeRenderDiff });
	assert.equal(content.bodyStyled, undefined);
});

test("withStyledBody keeps the plain body when the renderer changes the row count or throws", () => {
	const item = editItem();
	const plain = itemModalContent(item, "done");
	const dropped = withStyledBody(plain, item, { renderDiff: (d) => d.split("\n").slice(1).join("\n") });
	assert.equal(dropped.bodyStyled, undefined);
	const threw = withStyledBody(plain, item, {
		renderDiff: () => {
			throw new Error("no theme");
		},
	});
	assert.equal(threw.bodyStyled, undefined);
});

test("linkifyLine links URLs and resolvable file paths, leaving prose alone", () => {
	assert.equal(
		linkifyLine("see https://example.com/a for /tmp/x.ts and/or nothing", linkDeps),
		"see {https://example.com/a|https://example.com/a} for {file:///tmp/x.ts|/tmp/x.ts} and/or nothing",
	);
});

test("linkifyLine keeps sentence punctuation outside the link", () => {
	assert.equal(linkifyLine("open https://example.com/a.", linkDeps), "open {https://example.com/a|https://example.com/a}.");
	assert.equal(linkifyLine("edited /tmp/x.ts:42", linkDeps), "edited {file:///tmp/x.ts|/tmp/x.ts}:42");
});

test("linkifyLine leaves a path that does not resolve as plain text", () => {
	assert.equal(linkifyLine("missing /tmp/gone.txt here", linkDeps), "missing /tmp/gone.txt here");
});

test("without hyperlink support every line is left raw for the terminal to detect", () => {
	const line = "see https://example.com/a and /tmp/x.ts";
	assert.equal(linkifyLine(line, { renderDiff: fakeRenderDiff }), line);
	const item = editItem({ diff: undefined, fullOutput: line });
	const content = withStyledBody(itemModalContent(item, line), item, { renderDiff: fakeRenderDiff });
	assert.equal(content.bodyStyled, undefined);
});

test("links and a rendered diff coexist in one styled body, and copy stays plain", () => {
	const item = editItem({ fullOutput: "wrote /tmp/x.ts" });
	const content = withStyledBody(itemModalContent(item, "wrote /tmp/x.ts"), item, linkDeps);
	assert.ok(content.bodyStyled);
	assert.equal(content.bodyStyled?.length, content.body.length);
	assert.deepEqual(content.bodyStyled?.slice(1, 4), ["[ 1 const a = 1;]", "[-2 const b = 2;]", "[+2 const b = 42;]"]);
	assert.ok(content.bodyStyled?.some((row) => row.includes("{file:///tmp/x.ts|/tmp/x.ts}")));
	assert.ok(content.copyText.includes("wrote /tmp/x.ts"));
	assert.equal(content.copyText.includes("{file://"), false);
});

test("a command modal ignores a diff (its body is the shell transcript)", () => {
	const item = editItem({ command: "git diff", glyph: "$", fullOutput: "output" });
	const content = withStyledBody(itemModalContent(item, "output"), item, { renderDiff: fakeRenderDiff });
	assert.equal(content.caption, "Shell");
	assert.equal(content.bodyStyled, undefined);
});
