/**
 * ModalController lifecycle tests (ticket 38): open → swap → close, copy status,
 * and teardown. Previously trapped in the index.ts closure and untested.
 *
 * A fake UI context stands in for pi's ctx.ui.custom: it records each overlay
 * open, exposes the `done` callback (to simulate Esc/close) and a hide() spy on
 * the handle (to detect a swap-close), and records setStatus calls.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardModel } from "../src/card-model.ts";
import type { ShapeItem } from "../src/card-shape.ts";
import { ModalController } from "../src/modal-controller.ts";

interface OpenedOverlay {
	/** Fires the overlay's done(), simulating Esc/q/click-out close. */
	close: () => void;
	hidden: boolean;
}

function makeFakeCtx() {
	const opens: OpenedOverlay[] = [];
	const statuses: Array<[string, string | undefined]> = [];
	const toolsExpandedChanges: boolean[] = [];
	let toolsExpanded = false;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom(
				factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: void) => void) => unknown,
				options: { onHandle?: (h: unknown) => void },
			): Promise<void> {
				let resolveFn: () => void = () => {};
				const p = new Promise<void>((res) => {
					resolveFn = res;
				});
				const overlay: OpenedOverlay = { hidden: false, close: resolveFn };
				const keybindings = {
					matches: (data: string, action: string) => action === "app.tools.expand" && data === "configured-expand",
				};
				// Invoke the factory as pi would; the 4th arg is `done` (resolves custom()).
				factory({}, { fg: (_r: string, t: string) => t, bold: (t: string) => t }, keybindings, () => resolveFn());
				options.onHandle?.({
					hide() {
						overlay.hidden = true;
					},
				});
				opens.push(overlay);
				return p;
			},
			setStatus(key: string, value: string | undefined) {
				statuses.push([key, value]);
			},
			getToolsExpanded() {
				return toolsExpanded;
			},
			setToolsExpanded(expanded: boolean) {
				toolsExpanded = expanded;
				toolsExpandedChanges.push(expanded);
			},
		},
	};
	return { ctx, opens, statuses, toolsExpandedChanges };
}

function makeModel(entries: CardModel["entries"]): CardModel {
	return { live: false, startMs: 0, workedMs: 1000, failures: 0, entries };
}

function groupModel(item: ShapeItem): CardModel {
	return makeModel([{ kind: "group", group: { label: "Ran ls", counts: "1 command", items: [item] } }]);
}

function fakeItem(): ShapeItem {
	return {
		label: "Ran ls",
		durMs: 10,
		isError: false,
		running: false,
		preview: ["a", "b"],
		glyph: "$",
		command: "ls",
	};
}

type Enrich = (
	content: import("../src/modal.ts").ModalContent,
	item?: ShapeItem,
) => import("../src/modal.ts").ModalContent;

function makeController(model: CardModel | undefined, enrich?: Enrich, readFullOutput: () => string | undefined = () => undefined) {
	const { ctx, opens, statuses, toolsExpandedChanges } = makeFakeCtx();
	let copied: string | undefined;
	let renders = 0;
	let onCopy: (() => void) | undefined;
	const updates: import("../src/modal.ts").ModalContent[] = [];
	let matchesToolsExpand: ((data: string) => boolean) | undefined;
	let onToolsExpand: (() => void) | undefined;
	const contents: import("../src/modal.ts").ModalContent[] = [];
	const controller = new ModalController({
		enrich,
		getUiCtx: () => ctx as never,
		hasLiveUI: (c) => (c as { mode: string }).mode === "tui",
		getModel: () => model,
		readFullOutput,
		copyToClipboard: async (t: string) => {
			copied = t;
		},
		requestRender: () => {
			renders++;
		},
		makeModal: (content, _theme, _done, copy, matches, onToggle) => {
			contents.push(content);
			onCopy = copy;
			matchesToolsExpand = matches;
			onToolsExpand = onToggle;
			return {
				setTerminalHeight() {},
				setTerminalWidth() {},
				showCopied() {},
				clearCopied() {},
				setContent(next) {
					updates.push(next);
				},
			};
		},
	});
	return {
		controller,
		opens,
		statuses,
		toolsExpandedChanges,
		getCopied: () => copied,
		copy: () => onCopy?.(),
		renders: () => renders,
		updates,
		contents,
		matchesToolsExpand: (data: string) => matchesToolsExpand?.(data) ?? false,
		toggleToolsExpand: () => onToolsExpand?.(),
	};
}

test("ModalController: the injected enricher decorates the content the modal renders", () => {
	const seen: Array<string | undefined> = [];
	const { controller, contents } = makeController(groupModel(fakeItem()), (content, item) => {
		seen.push(item?.label);
		return { ...content, bodyStyled: content.body.map((l) => `<${l}>`) };
	});
	controller.openMemberModal("card", 0, 0);
	assert.deepEqual(seen, ["Ran ls"]);
	assert.deepEqual(contents[0].bodyStyled, contents[0].body.map((l) => `<${l}>`));
	// Styling never touches what `c` copies.
	assert.equal(contents[0].copyText.includes("<"), false);
});

test("ModalController: a failing enricher still opens the plain modal", () => {
	const { controller, opens, contents } = makeController(groupModel(fakeItem()), () => {
		throw new Error("renderer blew up");
	});
	controller.openMemberModal("card", 0, 0);
	assert.equal(opens.length, 1);
	assert.equal(contents[0].bodyStyled, undefined);
});

test("ModalController: opens a member modal", () => {
	const { controller, opens } = makeController(groupModel(fakeItem()));
	assert.equal(controller.isOpen(), false);
	controller.openMemberModal("card", 0, 0);
	assert.equal(opens.length, 1);
	assert.equal(controller.isOpen(), true);
});

test("ModalController: opening a second modal swaps (hides the first)", () => {
	const { controller, opens } = makeController(groupModel(fakeItem()));
	controller.openMemberModal("card", 0, 0);
	controller.openMemberModal("card", 0, 0);
	assert.equal(opens.length, 2);
	assert.equal(opens[0].hidden, true, "first overlay hidden on swap");
	assert.equal(controller.isOpen(), true);
});

test("ModalController: closeModal hides the overlay and clears open state", () => {
	const { controller, opens } = makeController(groupModel(fakeItem()));
	controller.openMemberModal("card", 0, 0);
	controller.closeModal();
	assert.equal(opens[0].hidden, true);
	assert.equal(controller.isOpen(), false);
});

test("ModalController: a stale/out-of-range click opens nothing", () => {
	const { controller, opens } = makeController(groupModel(fakeItem()));
	controller.openMemberModal("card", 5, 0); // no such entry
	controller.openMemberModal("card", 0, 9); // no such item
	assert.equal(opens.length, 0);
	assert.equal(controller.isOpen(), false);
});

test("ModalController: thought modal only opens on a thought entry", () => {
	const thoughtModel = makeModel([
		{ kind: "thought", thought: { ms: 2000, summary: "Planning", tail: ["line"], fullText: "line", live: false } },
	]);
	const { controller, opens } = makeController(thoughtModel);
	controller.openThoughtModal("card", 0);
	assert.equal(opens.length, 1);
	// A group index on openThoughtModal is a no-op.
	const g = makeController(groupModel(fakeItem()));
	g.controller.openThoughtModal("card", 0);
	assert.equal(g.opens.length, 0);
});

test("ModalController: thought modal body is the FULL captured text (ticket 40), not the compact tail", () => {
	// tail is what the card row's glance view would show (short/capped); fullText is
	// the real untruncated capture. The modal must render fullText, proving the
	// fix threads entry.thought.fullText into thoughtModalContent — not tail.
	const full = "Paragraph one of real reasoning.\nParagraph two, much longer than the compact tail would ever keep.";
	const thoughtModel = makeModel([
		{ kind: "thought", thought: { ms: 4000, summary: "Planning", tail: ["Paragraph one\u2026"], fullText: full, live: false } },
	]);
	const { controller, contents } = makeController(thoughtModel);
	controller.openThoughtModal("card", 0);
	assert.equal(contents.length, 1);
	assert.equal(contents[0].copyText, full);
	assert.deepEqual(contents[0].body, full.split("\n"));
	// It must NOT be the truncated tail's single line.
	assert.notDeepEqual(contents[0].body, ["Paragraph one\u2026"]);
});

test("ModalController: teardown closes an open modal", () => {
	const { controller, opens } = makeController(groupModel(fakeItem()));
	controller.openMemberModal("card", 0, 0);
	controller.teardown();
	assert.equal(opens[0].hidden, true);
	assert.equal(controller.isOpen(), false);
});

test("ModalController: forwards the configured tool-expansion action through the official UI state", () => {
	const { controller, matchesToolsExpand, toggleToolsExpand, toolsExpandedChanges } = makeController(groupModel(fakeItem()));
	controller.openMemberModal("card", 0, 0);
	assert.equal(matchesToolsExpand("ctrl+o"), false, "the physical key is not hard-coded");
	assert.equal(matchesToolsExpand("configured-expand"), true);

	toggleToolsExpand();
	toggleToolsExpand();
	assert.deepEqual(toolsExpandedChanges, [true, false]);
	assert.equal(controller.isOpen(), true, "toggling does not close the modal");
});

test("copy feedback is contained to the modal: showCopied after the copy, clearCopied on the timer", async () => {
	const { ctx } = makeFakeCtx();
	let renders = 0;
	const calls: string[] = [];
	let capturedOnCopy: (() => void) | undefined;
	const controller = new ModalController({
		getUiCtx: () => ctx as never,
		hasLiveUI: () => true,
		getModel: () => groupModel(fakeItem()),
		readFullOutput: () => undefined,
		copyToClipboard: async () => {},
		requestRender: () => {
			renders++;
		},
		makeModal: (_content, _theme, _done, onCopy) => {
			capturedOnCopy = onCopy;
			return {
				setTerminalHeight() {},
				setTerminalWidth() {},
				showCopied() {
					calls.push("show");
				},
				clearCopied() {
					calls.push("clear");
				},
				setContent() {},
			};
		},
	});
	controller.openMemberModal("card", 0, 0);
	assert.ok(capturedOnCopy);
	capturedOnCopy?.();
	await new Promise((r) => setTimeout(r, 0)); // let the copy promise resolve
	assert.deepEqual(calls, ["show"]);
	assert.ok(renders >= 1);
	controller.teardown(); // clears the pending feedback timer (no dangling handle)
});

// ── following a streaming row ─────────────────────────────────────────────────

function liveThought(fullText: string, ms: number, live = true): CardModel["entries"][number] {
	return { kind: "thought", thought: { ms, summary: live ? "" : "Planning", tail: [], fullText, live } };
}

test("refresh: a modal opened on a live thinking span fills in as the text streams, then settles once", () => {
	const model = makeModel([liveThought("", 1000)]);
	const { controller, contents, updates, renders } = makeController(model);
	controller.openThoughtModal("card", 0);
	assert.deepEqual(contents[0].body, []);
	assert.equal(contents[0].title, "Thinking\u2026 \u00b7 1s");

	model.entries = [liveThought("First idea", 2000)];
	controller.refresh();
	assert.equal(updates.at(-1)?.copyText, "First idea");

	model.entries = [liveThought("First idea\nSecond idea", 3000, false)];
	controller.refresh();
	assert.equal(updates.at(-1)?.copyText, "First idea\nSecond idea");
	assert.equal(updates.at(-1)?.title, "Thought 3s \u00b7 Planning");
	const settled = updates.length;
	assert.ok(renders() >= 2);

	// Settled: nothing changes after, so no further updates.
	model.entries = [liveThought("First idea\nSecond idea\nlater", 4000, false)];
	controller.refresh();
	assert.equal(updates.length, settled);
});

test("refresh: a ticking duration with unchanged text updates the title only", () => {
	const model = makeModel([liveThought("same text", 1000)]);
	const { controller, updates } = makeController(model, (content) => ({ ...content, bodyStyled: ["styled"] }));
	controller.openThoughtModal("card", 0);
	model.entries = [liveThought("same text", 2000)];
	controller.refresh();
	assert.equal(updates.at(-1)?.title, "Thinking\u2026 \u00b7 2s");
	assert.deepEqual(updates.at(-1)?.bodyStyled, ["styled"]);
	// Identical content: no update at all.
	const count = updates.length;
	controller.refresh();
	assert.equal(updates.length, count);
});

test("refresh: a different span at the same index leaves the last content in place", () => {
	const model = makeModel([liveThought("Reasoning about A", 1000)]);
	const { controller, updates } = makeController(model);
	controller.openThoughtModal("card", 0);
	model.entries = [liveThought("Something else entirely", 2000)];
	controller.refresh();
	model.entries = [{ kind: "group", group: { label: "Ran ls", counts: "1 command", items: [fakeItem()] } }];
	controller.refresh();
	assert.equal(updates.length, 0);
});

test("refresh: a running tool's modal shows its partial output, then the final output once", () => {
	const running: ShapeItem = { ...fakeItem(), running: true, preview: [], fullOutput: "line 1" };
	const model = groupModel(running);
	const { controller, contents, updates } = makeController(model, undefined, () => "final from file");
	controller.openMemberModal("card", 0, 0);
	assert.ok(contents[0].copyText.includes("line 1"));

	model.entries = [{ kind: "group", group: { label: "Ran ls", counts: "1 command", items: [{ ...running, fullOutput: "line 1\nline 2" }] } }];
	controller.refresh();
	assert.ok(updates.at(-1)?.copyText.includes("line 2"));

	model.entries = [{ kind: "group", group: { label: "Ran ls", counts: "1 command", items: [{ ...running, running: false }] } }];
	controller.refresh();
	assert.ok(updates.at(-1)?.copyText.includes("final from file"));
	const count = updates.length;
	controller.refresh();
	assert.equal(updates.length, count);
});

test("refresh: a different tool now at the same position is not swapped in", () => {
	const running: ShapeItem = { ...fakeItem(), running: true, fullOutput: "x" };
	const model = groupModel(running);
	const { controller, updates } = makeController(model);
	controller.openMemberModal("card", 0, 0);
	model.entries = [{ kind: "group", group: { label: "Read a.ts", counts: "1 file", items: [{ ...running, label: "Read a.ts", fullOutput: "y" }] } }];
	controller.refresh();
	assert.equal(updates.length, 0);
});

test("refresh: copy takes the latest content, and closed or narration modals never refresh", async () => {
	const model = makeModel([liveThought("v1", 1000)]);
	const { controller, updates, copy, getCopied } = makeController(model);
	controller.openThoughtModal("card", 0);
	model.entries = [liveThought("v1 v2", 2000)];
	controller.refresh();
	copy();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(getCopied(), "v1 v2");

	controller.closeModal();
	model.entries = [liveThought("v1 v2 v3", 3000)];
	controller.refresh();
	assert.equal(updates.length, 1);

	const narration = makeController(makeModel([{ kind: "narration", narration: { text: "note", summary: "note" } }]));
	narration.controller.openNarrationModal("card", 0);
	narration.controller.refresh();
	assert.equal(narration.updates.length, 0);
	controller.teardown();
	narration.controller.teardown();
});
