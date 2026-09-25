/**
 * Richer display rows for a modal body: a coloured diff for a file edit. The
 * plain body stays the source of truth (it is what `c` copies); this only adds
 * a parallel `bodyStyled` array of the same length, so the scroll math and the
 * copy text are untouched.
 *
 * pi's renderers are injected rather than imported, so this module stays
 * pi-import-free and unit-tests headlessly. Every branch falls back to the
 * plain body when its inputs are missing or unexpected.
 */

import type { ShapeItem } from "./card-shape.ts";
import { DIFF_HEADING, type ModalContent } from "./modal.ts";

export interface RichBodyDeps {
	/** pi's `renderDiff`: colours a display diff through the active theme. */
	renderDiff(diff: string): string;
}

/** Overlay a row range of `body` with styled rows, or return undefined when the
 * replacement does not line up row-for-row (then the plain body is kept). */
function overlayRows(body: readonly string[], start: number, styled: readonly string[]): string[] | undefined {
	if (start < 0 || start + styled.length > body.length) return undefined;
	const rows = [...body];
	for (let i = 0; i < styled.length; i++) rows[start + i] = styled[i];
	return rows;
}

/**
 * Add `bodyStyled` to a tool modal's content when the item carries data a
 * richer rendering needs. Returns the content unchanged otherwise.
 */
export function withStyledBody(content: ModalContent, item: ShapeItem | undefined, deps: RichBodyDeps): ModalContent {
	const diff = item?.diff;
	if (diff === undefined) return content;
	const start = content.body.indexOf(DIFF_HEADING) + 1;
	if (start <= 0) return content;
	let styled: string[];
	try {
		styled = deps.renderDiff(diff).split("\n");
	} catch {
		return content;
	}
	// A renderer that changed the row count would desynchronise the styled rows
	// from the plain ones; keep the plain body rather than misalign them.
	if (styled.length !== diff.split("\n").length) return content;
	const bodyStyled = overlayRows(content.body, start, styled);
	return bodyStyled ? { ...content, bodyStyled } : content;
}
