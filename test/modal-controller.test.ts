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
import type { CardModel, ShapeItem } from "../src/card-shape.ts";
import { ModalController } from "../src/modal-controller.ts";

interface OpenedOverlay {
	/** Fires the overlay's done(), simulating Esc/q/click-out close. */
	close: () => void;
	hidden: boolean;
}

function makeFakeCtx() {
	const opens: OpenedOverlay[] = [];
	const statuses: Array<[string, string | undefined]> = [];
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
				// Invoke the factory as pi would; the 4th arg is `done` (resolves custom()).
				factory({}, { fg: (_r: string, t: string) => t, bold: (t: string) => t }, {}, () => resolveFn());
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
		},
	};
	return { ctx, opens, statuses };
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

function makeController(model: CardModel | undefined) {
	const { ctx, opens, statuses } = makeFakeCtx();
	let copied: string | undefined;
	const controller = new ModalController({
		getUiCtx: () => ctx as never,
		hasLiveUI: (c) => (c as { mode: string }).mode === "tui",
		getModel: () => model,
		readFullOutput: () => undefined,
		copyToClipboard: async (t: string) => {
			copied = t;
		},
		makeModal: () => ({ setTerminalHeight() {} }),
	});
	return { controller, opens, statuses, getCopied: () => copied };
}

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
		{ kind: "thought", thought: { ms: 2000, summary: "Planning", tail: ["line"], live: false } },
	]);
	const { controller, opens } = makeController(thoughtModel);
	controller.openThoughtModal("card", 0);
	assert.equal(opens.length, 1);
	// A group index on openThoughtModal is a no-op.
	const g = makeController(groupModel(fakeItem()));
	g.controller.openThoughtModal("card", 0);
	assert.equal(g.opens.length, 0);
});

test("ModalController: teardown closes an open modal", () => {
	const { controller, opens } = makeController(groupModel(fakeItem()));
	controller.openMemberModal("card", 0, 0);
	controller.teardown();
	assert.equal(opens[0].hidden, true);
	assert.equal(controller.isOpen(), false);
});
