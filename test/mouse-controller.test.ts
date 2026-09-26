/**
 * MouseController tests. Exercises its seams:
 *   - hover resolution commits undefined/undefined on a motion report that hits
 *     no card (leave),
 *   - click resolution returns false for a packet outside the rendered buffer
 *     (out-of-bounds row),
 *   - synthesizeMouseEvent's move vs press shape (button/clickCount),
 *   - handleTerminalInput end-to-end: press routes through the fake TUI's
 *     handleMouse, motion resolves + commits hover, and the SGR bytes are
 *     consumed (not leaked to the editor).
 *
 * Runs via Node's built-in TypeScript type-stripping: `node --test
 * test/mouse-controller.test.ts`. The fake TUI is a plain object (no pi-tui
 * runtime needed), matching the modal-controller/patch-controller pattern.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MouseController, MOUSE_DISABLE, MOUSE_ENABLE, type MouseRuntime } from "../src/mouse-controller.ts";
import type { MousePacket } from "../src/mouse.ts";

interface FakeTui {
	mode: "regular" | "fullscreen";
	terminal: { write(data: string): void };
	requestRender(): void;
	captureRenderState?: () => { previousViewportTop: number; previousLines: unknown[]; previousWidth: number };
	handleMouse?: (event: unknown) => unknown;
}

function makeFakeTui(overrides: Partial<FakeTui> = {}): FakeTui & { writes: string[]; renders: number } {
	const writes: string[] = [];
	let renders = 0;
	return {
		mode: "regular",
		terminal: {
			write(data: string) {
				writes.push(data);
			},
		},
		requestRender() {
			renders++;
		},
		captureRenderState: () => ({ previousViewportTop: 0, previousLines: ["a", "b", "c"], previousWidth: 80 }),
		writes,
		get renders() {
			return renders;
		},
		...overrides,
	} as FakeTui & { writes: string[]; renders: number };
}

function makeHoverSpy() {
	const commits: Array<[string | undefined, string | undefined]> = [];
	return {
		commits,
		commitHover: (cardId: string | undefined, nodeId: string | undefined) => {
			commits.push([cardId, nodeId]);
		},
		clearHover: () => {
			commits.push([undefined, undefined]);
		},
	};
}

function makeController(tui?: FakeTui) {
	const runtime: MouseRuntime = { tui: tui as never };
	const hover = makeHoverSpy();
	const controller = new MouseController({ runtime, commitHover: hover.commitHover, clearHover: hover.clearHover });
	return { controller, runtime, hover };
}

// A motion packet (any-motion 1003, code 35 = no-button hover).
const MOTION_PACKET: MousePacket = { code: 35, col: 5, row: 1, final: "M" };
// A left-button press packet (code 0).
const PRESS_PACKET: MousePacket = { code: 0, col: 5, row: 1, final: "M" };

test("resolveHoverToCard: commits undefined on no-hit (motion resolves to no card)", () => {
	const tui = makeFakeTui({ handleMouse: () => undefined }); // no MouseRegion caught it
	const { controller, hover } = makeController(tui);
	// biome-ignore lint: exercising the private resolver directly, matching the
	// controller's own private-method test pattern used elsewhere in the repo.
	(controller as unknown as { resolveHoverToCard(tui: unknown, packet: MousePacket): void }).resolveHoverToCard(
		tui,
		MOTION_PACKET,
	);
	assert.deepEqual(hover.commits, [[undefined, undefined]]);
});

test("resolveHoverToCard: commits the recorded hit after a move dispatch resolves a card", () => {
	const tui = makeFakeTui({
		handleMouse: () => {
			// Simulate onCardMouse (index.ts) recording a hit for this dispatch.
			controller.recordMoveHit("card-1", "node-2");
			return { handled: true, render: false };
		},
	});
	const { controller, hover } = makeController(tui);
	(controller as unknown as { resolveHoverToCard(tui: unknown, packet: MousePacket): void }).resolveHoverToCard(
		tui,
		MOTION_PACKET,
	);
	assert.deepEqual(hover.commits, [["card-1", "node-2"]]);
});

test("resolveClickToCard: returns false for a packet outside the rendered buffer (out of bounds)", () => {
	const tui = makeFakeTui({ handleMouse: () => ({ handled: true, render: true }) });
	const { controller } = makeController(tui);
	const outOfBounds: MousePacket = { code: 0, col: 1, row: 99, final: "M" }; // row 99 > 3 rendered lines
	const result = (
		controller as unknown as { resolveClickToCard(tui: unknown, packet: MousePacket): boolean }
	).resolveClickToCard(tui, outOfBounds);
	assert.equal(result, false);
});

test("resolveClickToCard: returns true when the dispatch hits a card", () => {
	const tui = makeFakeTui({ handleMouse: () => ({ handled: true, render: true }) });
	const { controller } = makeController(tui);
	const result = (
		controller as unknown as { resolveClickToCard(tui: unknown, packet: MousePacket): boolean }
	).resolveClickToCard(tui, PRESS_PACKET);
	assert.equal(result, true);
});

test("synthesizeMouseEvent: move shape has button 'none' and no clickCount", () => {
	const { controller } = makeController();
	const state = { previousViewportTop: 0, previousLines: ["a", "b", "c"], previousWidth: 80 };
	const event = (
		controller as unknown as {
			synthesizeMouseEvent(state: unknown, packet: MousePacket, type: "move" | "press"): Record<string, unknown> | undefined;
		}
	).synthesizeMouseEvent(state, MOTION_PACKET, "move");
	assert.ok(event);
	assert.equal(event.type, "move");
	assert.equal(event.button, "none");
	assert.equal("clickCount" in event, false);
	assert.equal(event.x, MOTION_PACKET.col - 1);
	assert.equal(event.y, MOTION_PACKET.row - 1);
});

test("synthesizeMouseEvent: press shape has button 'left' and clickCount 1", () => {
	const { controller } = makeController();
	const state = { previousViewportTop: 0, previousLines: ["a", "b", "c"], previousWidth: 80 };
	const event = (
		controller as unknown as {
			synthesizeMouseEvent(state: unknown, packet: MousePacket, type: "move" | "press"): Record<string, unknown> | undefined;
		}
	).synthesizeMouseEvent(state, PRESS_PACKET, "press");
	assert.ok(event);
	assert.equal(event.type, "press");
	assert.equal(event.button, "left");
	assert.equal(event.clickCount, 1);
});

test("synthesizeMouseEvent: undefined when the row is outside the rendered buffer", () => {
	const { controller } = makeController();
	const state = { previousViewportTop: 0, previousLines: ["a", "b", "c"], previousWidth: 80 };
	const event = (
		controller as unknown as {
			synthesizeMouseEvent(state: unknown, packet: MousePacket, type: "move" | "press"): unknown;
		}
	).synthesizeMouseEvent(state, { code: 0, col: 1, row: 99, final: "M" }, "press");
	assert.equal(event, undefined);
});

test("handleTerminalInput: a left-press packet dispatches through handleMouse and is consumed", () => {
	let dispatched: unknown;
	const tui = makeFakeTui({
		handleMouse: (event) => {
			dispatched = event;
			return { handled: true, render: true };
		},
	});
	const { controller, runtime } = makeController(tui);
	runtime.tui = tui as never;
	const data = "\x1b[<0;5;1M"; // left press at col 5, row 1
	const result = controller.handleTerminalInput(data);
	assert.deepEqual(result, { consume: true });
	assert.ok(dispatched);
});

test("handleTerminalInput: with the modal open, a press goes to the overlay layer, not the cards", () => {
	let cardDispatched = false;
	let overlayEvent: Record<string, unknown> | undefined;
	const tui = makeFakeTui({
		handleMouse: () => {
			cardDispatched = true;
			return { handled: true, render: true };
		},
	});
	(tui as unknown as { dispatchMouseToOverlay: (e: Record<string, unknown>) => unknown }).dispatchMouseToOverlay = (e) => {
		overlayEvent = e;
		return { hit: false };
	};
	const runtime: MouseRuntime = { tui: tui as never };
	const hover = makeHoverSpy();
	const controller = new MouseController({ runtime, ...hover, isModalOpen: () => true });
	const result = controller.handleTerminalInput("\x1b[<0;5;3M");
	assert.deepEqual(result, { consume: true });
	assert.equal(cardDispatched, false);
	assert.equal(overlayEvent?.type, "press");
	assert.equal(overlayEvent?.screenX, 4);
	assert.equal(overlayEvent?.screenY, 2);
	assert.equal(tui.renders, 1);
});

test("handleTerminalInput: a motion packet resolves hover without requiring a left press", () => {
	const tui = makeFakeTui({
		handleMouse: () => undefined, // no card under the cursor
	});
	const { controller, runtime, hover } = makeController(tui);
	runtime.tui = tui as never;
	const data = "\x1b[<35;5;1M"; // any-motion hover packet
	controller.handleTerminalInput(data);
	assert.deepEqual(hover.commits, [[undefined, undefined]]);
});

test("handleTerminalInput: returns undefined (does not touch input) outside regular mode", () => {
	const tui = makeFakeTui({ mode: "fullscreen" });
	const { controller, runtime } = makeController(tui);
	runtime.tui = tui as never;
	const result = controller.handleTerminalInput("\x1b[<0;5;1M");
	assert.equal(result, undefined);
});

test("handleTerminalInput: non-mouse keystrokes pass through untouched", () => {
	const tui = makeFakeTui();
	const { controller, runtime } = makeController(tui);
	runtime.tui = tui as never;
	const result = controller.handleTerminalInput("a");
	assert.equal(result, undefined);
});

test("enableMouseReporting: writes MOUSE_ENABLE once for a regular-mode TUI and stamps runtime.tui", () => {
	const tui = makeFakeTui();
	const { controller, runtime } = makeController();
	controller.enableMouseReporting(tui as never);
	controller.enableMouseReporting(tui as never); // idempotent — only one write
	assert.equal(runtime.tui, tui);
	assert.deepEqual(tui.writes, [MOUSE_ENABLE]);
});

test("enableMouseReporting: does not write for a fullscreen TUI (routes natively)", () => {
	const tui = makeFakeTui({ mode: "fullscreen" });
	const { controller } = makeController();
	controller.enableMouseReporting(tui as never);
	assert.deepEqual(tui.writes, []);
});

test("teardown: writes MOUSE_DISABLE, resets residual (a held fragment is dropped, not leaked), and clears hover", () => {
	const tui = makeFakeTui({ handleMouse: () => undefined });
	const { controller, runtime, hover } = makeController(tui);
	runtime.tui = tui as never;
	controller.enableMouseReporting(tui as never);
	// Hold a fragmented packet prefix as residual.
	controller.handleTerminalInput("\x1b[<0;5;");
	controller.teardown();
	assert.deepEqual(tui.writes, [MOUSE_ENABLE, MOUSE_DISABLE]);
	assert.deepEqual(hover.commits, [[undefined, undefined]]);
	// The held residual is gone: a bare completion byte now arrives as an
	// unmatched fragment (non-mouse passthrough), not a reassembled packet.
	let dispatched = false;
	tui.handleMouse = () => {
		dispatched = true;
		return undefined;
	};
	controller.handleTerminalInput("1M");
	assert.equal(dispatched, false);
});
