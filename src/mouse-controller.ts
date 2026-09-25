/**
 * MouseController owns regular-mode SGR mouse reporting end to end — enabling
 * it on the captured TUI handle, parsing packets from raw terminal input
 * (residual buffering for boundary-split packets), and resolving a click/move
 * packet into a synthesized TUI mouse dispatch that the retained component
 * tree routes to the card under the cursor. Regular mode does not route mouse
 * events to components natively (the terminal owns scrollback), so this
 * reimplements just enough of that routing. Fullscreen routes clicks/moves to
 * MouseRegion natively and never calls this controller.
 *
 * The pure SGR packet parsing (parseSgrMousePackets / isSgrLeftPress /
 * isSgrMotion) stays in ./mouse.ts, dependency-free and unit-tested without a
 * terminal (test/mouse.test.ts); this controller USES that module, it does not
 * duplicate it. Injected deps (commitHover/clearHover) keep the controller
 * unit-testable with a fake TUI, matching the ModalController/PatchController
 * extraction pattern.
 */

import type { TUI, TuiMainScreenRenderState, TuiMouseEvent } from "@earendil-works/pi-tui";
import { isSgrLeftPress, isSgrMotion, type MousePacket, parseSgrMousePackets } from "./mouse.ts";

// SGR button tracking (1000) + ANY-MOTION tracking (1003) + SGR extended
// coordinates (1006). Hover needs motion reports WITHOUT a button held, so
// 1003 (any-motion) is the required mode: 1002 (button-motion) only reports
// movement while a button is down and cannot drive a bare hover. 1003 is a
// superset of 1000; keeping 1000h is harmless. The trade-off is heavier input
// traffic (a packet per cell the cursor crosses) — bounded by rendering ONLY
// when the hovered node changes (commitHover), and it shares the existing
// selection trade-off (Shift/Option-drag still selects natively).
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1003l\x1b[?1006l";

// Regular-mode TUI exposes captureRenderState() (the buffer + viewport top we
// need to resolve a click row to a card); it is not on the base TUI interface.
export type RegularTui = TUI & { captureRenderState?: () => TuiMainScreenRenderState };

/** A live TUI handle holder — the same `runtime` object the capture widget fills. */
export interface MouseRuntime {
	tui: TUI | undefined;
}

export interface MouseControllerDeps {
	/** Shared TUI-handle holder (index.ts's CaptureWidget fills it; the controller
	 * re-stamps it defensively in enableMouseReporting, mirroring the prior
	 * inline behavior). */
	runtime: MouseRuntime;
	/** Set the hovered card/node, re-rendering ONLY when it actually changes
	 * (throttled). Passing undefined ids clears the hover (leave). */
	commitHover(cardId: string | undefined, nodeId: string | undefined): void;
	/** Clear any hover highlight — called on teardown so a finalized/torn-down
	 * session never keeps a stale row lit. */
	clearHover(): void;
}

export class MouseController {
	private readonly deps: MouseControllerDeps;
	private mouseReportingOn = false;
	// Residual buffer for a mouse packet split across a read boundary:
	// handleTerminalInput holds any trailing incomplete "\x1b[<…" here and
	// prepends it to the next chunk so the completing bytes never leak into the
	// editor.
	private mouseResidual = "";
	// Last move hit recorded by onCardMouse (it can't return a value up through
	// handleMouse). A synthesized regular-mode dispatch clears this, dispatches,
	// then commits it — so a move that hit NO card clears hover (leave). The
	// fullscreen path commits directly inside onCardMouse; the record is unused
	// there and harmless.
	private lastMoveHit: { cardId: string; nodeId: string | undefined } | undefined;

	constructor(deps: MouseControllerDeps) {
		this.deps = deps;
	}

	/** Record the node a "move" dispatch resolved to (called from index.ts's
	 * onCardMouse, the retained tree's MouseRegion mouse-event entry point,
	 * which this controller's synthesized dispatch routes through). */
	recordMoveHit(cardId: string, nodeId: string | undefined): void {
		this.lastMoveHit = { cardId, nodeId };
	}

	private readLastMoveHit(): typeof this.lastMoveHit {
		return this.lastMoveHit;
	}

	enableMouseReporting(tui: TUI): void {
		this.deps.runtime.tui = tui;
		if (this.mouseReportingOn || tui.mode !== "regular") return; // fullscreen routes natively
		try {
			tui.terminal.write(MOUSE_ENABLE);
			this.mouseReportingOn = true;
		} catch {
			// Terminal may be unavailable; the keyboard shortcut still works.
		}
	}

	/** Disable mouse reporting and reset per-session mouse state (called at
	 * session teardown). */
	teardown(): void {
		if (this.mouseReportingOn && this.deps.runtime.tui) {
			try {
				this.deps.runtime.tui.terminal.write(MOUSE_DISABLE);
			} catch {
				// Terminal may already be closed during shutdown.
			}
		}
		this.mouseReportingOn = false;
		this.mouseResidual = ""; // drop any half-parsed packet on teardown
		this.deps.clearHover(); // no stale highlight after teardown
	}

	handleTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
		const tui = this.deps.runtime.tui as RegularTui | undefined;
		if (!tui || tui.mode !== "regular") return undefined;
		// Prepend any held incomplete-packet residual so a packet fragmented at the
		// previous read boundary completes here instead of leaking.
		const input = this.mouseResidual + data;
		const parsed = parseSgrMousePackets(input);
		this.mouseResidual = parsed.residual;

		if (parsed.packets.length === 0) {
			// No complete packet this chunk. Either the whole chunk was swallowed into a
			// held residual (a fragmented packet — wait for its completion), or a held
			// residual turned out non-mouse and is now released as passthrough (must
			// reach the editor). Only override the byte stream when we changed it.
			if (parsed.residual) return { consume: true };
			return parsed.passthrough === data ? undefined : { data: parsed.passthrough };
		}

		let toggled = false;
		let lastMotion: MousePacket | undefined;
		for (const packet of parsed.packets) {
			if (isSgrLeftPress(packet)) {
				if (this.resolveClickToCard(tui, packet)) toggled = true;
			} else if (isSgrMotion(packet)) {
				// Only the FINAL motion position matters for hover: a fast 1003 burst
				// packs many motions per chunk, but resolving every one would dispatch
				// captureRenderState + handleMouse per packet. Keep the last and
				// resolve once below.
				lastMotion = packet;
			}
		}
		// Resolve the last motion to a card/node and re-render only when the
		// hovered node changes (commitHover throttles). A move over no card
		// clears the hover (leave).
		if (lastMotion) this.resolveHoverToCard(tui, lastMotion);
		if (toggled) tui.requestRender();
		// Consume the recognized SGR mouse packets — clicks, releases, wheel,
		// right/middle — so raw \x1b[<..M bytes never leak into the editor. Any
		// trailing non-mouse bytes that arrived in the same chunk are forwarded
		// to the editor as passthrough; a trailing incomplete packet is held in
		// mouseResidual (nothing to forward, so consume the rest).
		if (parsed.passthrough.length > 0) return { data: parsed.passthrough };
		return { consume: true };
	}

	/** Build the synthesized TuiMouseEvent both regular-mode resolvers dispatch
	 * (shared shape — SGR rows/cols are 1-based in the viewport; viewportTop is
	 * the buffer index of the topmost visible line). Undefined when the point is
	 * outside the rendered buffer. */
	private synthesizeMouseEvent(
		state: TuiMainScreenRenderState,
		packet: MousePacket,
		type: "move" | "press",
	): TuiMouseEvent | undefined {
		const contentY = state.previousViewportTop + (packet.row - 1);
		if (contentY < 0 || contentY >= state.previousLines.length) return undefined;
		const x = Math.max(0, packet.col - 1);
		return {
			type,
			button: type === "press" ? "left" : "none",
			x,
			y: contentY,
			screenX: x,
			screenY: contentY,
			width: state.previousWidth || 0,
			height: state.previousLines.length,
			shift: (packet.code & 4) !== 0,
			alt: (packet.code & 8) !== 0,
			ctrl: (packet.code & 16) !== 0,
			...(type === "press" ? { clickCount: 1 } : {}),
		};
	}

	/**
	 * Resolve a regular-mode motion report to a hovered card/node and commit
	 * it. Uses the SAME dispatch path as clicks — a synthesized "move"
	 * TuiMouseEvent through the TUI's handleMouse, which the retained tree
	 * routes to the card under the cursor (onCardMouse stashes the resolved
	 * node via recordMoveHit). If the move lands on no card, the stash stays
	 * undefined and commitHover clears the hover (leave).
	 */
	private resolveHoverToCard(tui: RegularTui, packet: MousePacket): void {
		const state = tui.captureRenderState?.();
		const handleMouse = tui.handleMouse;
		if (!state || typeof handleMouse !== "function") return;
		this.lastMoveHit = undefined;
		const event = this.synthesizeMouseEvent(state, packet, "move");
		if (event) handleMouse.call(tui, event);
		// Commit whatever the dispatch recorded — undefined (no card hit) clears
		// the hover (leave); a hit re-commits the same values (idempotent). Read
		// through a method so TS doesn't narrow past the indirect write above.
		const hit = this.readLastMoveHit();
		this.deps.commitHover(hit?.cardId, hit?.nodeId);
	}

	private resolveClickToCard(tui: RegularTui, packet: MousePacket): boolean {
		const state = tui.captureRenderState?.();
		const handleMouse = tui.handleMouse;
		if (!state || typeof handleMouse !== "function") return false;
		const event = this.synthesizeMouseEvent(state, packet, "press");
		if (!event) return false;
		// The retained tree resolves y → component by summed child heights (Container
		// mouseLayout), routing to the clicked card's MouseRegion → onCardMouse.
		return Boolean(handleMouse.call(tui, event));
	}
}
