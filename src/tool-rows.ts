// Re-registered built-in tool rows (ticket 08). Splitting these out of index.ts
// keeps the tool-absorption view logic — the compact live row and the collapse to
// zero lines — in one small, dependency-injected module (ticket 38). Pure of any
// activityFeed() closure state: the only shared state is the AbsorbState set,
// passed in explicitly.

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describeCall, type ToolCallLike } from "./labels.ts";

/** Session-lived set of tool-call ids folded into a settled card; never cleared
 * (a row that has vanished must stay vanished for the transcript's life). */
export type AbsorbState = Set<string>;

// The call line of a re-registered built-in tool. While the call is live it is
// one compact dim line (ticket 05 wording via describeCall); once absorbed into
// a card it renders zero lines. render() reads the shared set every frame, so a
// single tui.requestRender() at turn_end makes every absorbed row disappear
// while it is still in the viewport (ticket 01 §3.2 / §6.10 — collapsing rows
// that have scrolled off would force a full redraw that wipes native scrollback).
export class ToolCallRow implements Component {
	constructor(
		private readonly toolCallId: string,
		private readonly label: string,
		private readonly theme: Theme,
		private readonly absorbed: AbsorbState,
	) {}

	render(_width: number): string[] {
		if (this.absorbed.has(this.toolCallId)) return [];
		return [this.theme.fg("dim", this.label)];
	}

	invalidate(): void {
		// Stateless; render() reads the shared absorbed set each frame.
	}
}

// The result slot of a re-registered built-in tool renders nothing: the call
// line already states the action, and the settled outcome (✓/✗ + duration) is
// reported by the card. Kept empty so the whole row collapses to zero lines
// once absorbed (renderShell:"self" ⇒ empty content ⇒ component hidden).
export class EmptyRow implements Component {
	render(_width: number): string[] {
		return [];
	}

	invalidate(): void {}
}

/** Built-in tools whose rows the feed absorbs. Order is display-irrelevant. */
// Typed with `any` params: the concrete factories return schema-specific
// definitions whose renderCall arg types are (contravariantly) incompatible with
// the default TSchema generic; `any` keeps registerTool happy without per-tool
// glue, and we never read args off a specific shape here (describeCall is generic).
export const BUILT_IN_FACTORIES: ((cwd: string) => ToolDefinition<any, any>)[] = [
	createReadToolDefinition,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	createGrepToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
];

// Re-register a built-in tool preserving its execution (and therefore its exact
// result/details shapes — ticket 01 §6.10) by spreading the whole definition and
// overriding ONLY renderShell/renderCall/renderResult.
export function absorbable(builtin: ToolDefinition<any, any>, absorbed: AbsorbState): ToolDefinition<any, any> {
	return {
		...builtin,
		renderShell: "self",
		renderCall: (args, theme, context) => {
			const call: ToolCallLike = { name: builtin.name, arguments: (args ?? {}) as Record<string, unknown> };
			return new ToolCallRow(context.toolCallId, describeCall(call), theme, absorbed);
		},
		renderResult: () => new EmptyRow(),
	};
}
