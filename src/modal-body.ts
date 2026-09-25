/**
 * Richer display rows for a modal body: a coloured diff for a file edit,
 * syntax-highlighted file text, and clickable URLs and file paths. The plain body stays the source of truth (it
 * is what `c` copies); this only adds a parallel `bodyStyled` array of the same
 * length, so the scroll math and the copy text are untouched.
 *
 * pi's renderers are injected rather than imported, so this module stays
 * pi-import-free and unit-tests headlessly. Every branch falls back to the
 * plain body when its inputs are missing or unexpected.
 */

import type { ShapeItem } from "./card-shape.ts";
import { CONTENT_HEADING, DIFF_HEADING, type ModalContent, OUTPUT_HEADING } from "./modal.ts";

export interface RichBodyDeps {
	/** pi's `renderDiff`: colours a display diff through the active theme. */
	renderDiff(diff: string): string;
	/** Wrap text in a terminal hyperlink. Absent when the terminal cannot render
	 * them; text is then left raw for the terminal's own URL detection. */
	link?(text: string, url: string): string;
	/** URL for a file path mentioned in the output, or undefined when it does not
	 * resolve to an existing file. */
	fileUrl?(path: string): string | undefined;
	/** pi's `highlightCode`: one styled row per source line. */
	highlight?(code: string, lang: string): string[];
	/** pi's `getLanguageFromPath`; undefined for a file type with no highlighter. */
	languageOf?(path: string): string | undefined;
}

/** Highlighting a whole large file costs more than it gives, so past this many
 * rows the file text stays plain. */
export const MAX_HIGHLIGHT_ROWS = 500;

/** `read` output prefixes every line with a line-number gutter; it is not part
 * of the source and must not reach the highlighter. */
const GUTTER = /^\s*\d+\t/;

// A URL, or a path anchored by `/`, `./`, `../` or `~/`. Anchoring keeps prose
// like "and/or" out; a bare relative path is left alone for the same reason.
const LINK_PATTERN = /(https?:\/\/[^\s<>"'`]+)|((?:~|\.{1,2})?\/[^\s<>"'`,:;]+)/g;

/** Trailing characters that read as sentence punctuation, not part of a target. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/** Turn URLs and resolvable file paths in one plain line into hyperlinks;
 * returns the line unchanged when nothing linkable is found. */
export function linkifyLine(line: string, deps: RichBodyDeps): string {
	const link = deps.link;
	if (!link || line === "") return line;
	return line.replace(LINK_PATTERN, (match) => {
		const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? "";
		const target = trailing ? match.slice(0, match.length - trailing.length) : match;
		if (target === "") return match;
		const url = target.startsWith("http") ? target : deps.fileUrl?.(target);
		return url ? link(target, url) + trailing : match;
	});
}

/** Syntax-highlight a run of file rows, keeping any line-number gutter intact.
 * Returns undefined when the rows are not highlightable (no language, too many
 * rows, or a renderer that does not answer row-for-row). */
function highlightRows(rows: readonly string[], lang: string, deps: RichBodyDeps): string[] | undefined {
	if (!deps.highlight || rows.length === 0 || rows.length > MAX_HIGHLIGHT_ROWS) return undefined;
	const gutters = rows.map((row) => GUTTER.exec(row)?.[0] ?? "");
	const code = rows.map((row, i) => row.slice(gutters[i].length));
	let styled: string[];
	try {
		styled = deps.highlight(code.join("\n"), lang);
	} catch {
		return undefined;
	}
	if (styled.length !== rows.length) return undefined;
	return styled.map((row, i) => gutters[i] + row);
}

/** The row range holding a file's text: everything a Content section lists, or
 * everything a read call printed after its Output heading. */
function codeRange(content: ModalContent, item: ShapeItem): { start: number; end: number } | undefined {
	if (item.content !== undefined) {
		const start = content.body.indexOf(CONTENT_HEADING) + 1;
		return start > 0 ? { start, end: start + item.content.split("\n").length } : undefined;
	}
	const start = content.body.indexOf(OUTPUT_HEADING) + 1;
	return start > 0 && start < content.body.length ? { start, end: content.body.length } : undefined;
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
	const linked = content.body.map((line) => linkifyLine(line, deps));
	let rows = linked.some((line, i) => line !== content.body[i]) ? linked : undefined;
	const diff = item?.diff;
	const start = diff === undefined ? -1 : content.body.indexOf(DIFF_HEADING) + 1;
	if (diff !== undefined && start > 0) {
		let styled: string[] | undefined;
		try {
			styled = deps.renderDiff(diff).split("\n");
		} catch {
			styled = undefined;
		}
		// A renderer that changed the row count would desynchronise the styled rows
		// from the plain ones; keep those rows plain rather than misalign them.
		if (styled && styled.length === diff.split("\n").length) {
			rows = overlayRows(rows ?? content.body, start, styled) ?? rows;
		}
	}
	const lang = item?.path ? deps.languageOf?.(item.path) : undefined;
	if (item && lang) {
		const range = codeRange(content, item);
		if (range) {
			const styled = highlightRows(content.body.slice(range.start, range.end), lang, deps);
			if (styled) rows = overlayRows(rows ?? content.body, range.start, styled) ?? rows;
		}
	}
	return rows ? { ...content, bodyStyled: rows } : content;
}
