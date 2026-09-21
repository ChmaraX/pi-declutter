// PatchController (ticket 38): owns the guarded leading-Spacer patch lifecycle —
// lazy acquisition from a live AssistantMessageComponent, the probe-/command-
// visible status, and teardown. Split out of the index.ts closure so the patch
// state machine (pending → active/drift/no-instance) is unit-testable with a fake
// TUI root (tickets 30/31).

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquireLeadingSpacerPatch, type LeadingSpacerPatch } from "./patches.ts";

export interface PatchStatus {
	active: boolean;
	reason?: string;
}

/** A live TUI handle holder — the same `runtime` object the capture widget fills. */
export interface TuiHandleSource {
	tui: { requestRender?: () => void } | undefined;
}

export class PatchController {
	// `spacerPatch` is undefined until a live instance is found; `resolved` latches
	// once we either activate or definitively fail open against a found instance, so
	// we stop retrying. `status` is the probe-/command-detectable {active, reason}.
	private spacerPatch: LeadingSpacerPatch | undefined;
	private resolved = false;
	private status: PatchStatus = { active: false, reason: "pending" };
	private readonly runtime: TuiHandleSource;
	private readonly hasLiveUI: (ctx: ExtensionContext) => boolean;

	constructor(runtime: TuiHandleSource, hasLiveUI: (ctx: ExtensionContext) => boolean) {
		this.runtime = runtime;
		this.hasLiveUI = hasLiveUI;
	}

	/** Current {active, reason}, read by the /activity-patch command + probes. */
	getStatus(): PatchStatus {
		return this.status;
	}

	/** Attempt to acquire + install the patch from a live component instance.
	 * Attempted lazily on assistant activity (message_start / message_update) until
	 * it resolves once per session: activate, or fail open against a found instance.
	 * Retries while no instance exists yet. */
	tryPatchLivePrototype(ctx: ExtensionContext): void {
		if (this.resolved || !this.hasLiveUI(ctx) || !this.runtime.tui) return;
		const result = acquireLeadingSpacerPatch({
			root: this.runtime.tui,
			warn: (message) => {
				try {
					ctx.ui.notify(message, "warning");
				} catch {
					// UI may be unavailable; status still records the fail-open reason.
				}
			},
		});
		if (result.patch.reason === "no-instance") {
			// No AssistantMessageComponent mounted yet — keep pending and retry on the
			// next assistant event (do NOT latch resolved).
			this.status = { active: false, reason: "no-instance" };
			return;
		}
		// Found an instance and either activated or definitively failed open: latch.
		this.resolved = true;
		this.spacerPatch = result.patch;
		this.status = { active: result.patch.active, reason: result.patch.reason };
		// The retroactive removal in acquireLeadingSpacerPatch dropped any pre-patch
		// leading blank; repaint so it disappears immediately.
		if (result.patch.active) this.runtime.tui?.requestRender?.();
	}

	/** Uninstall and reset to pending (called at session_shutdown). */
	teardown(): void {
		this.spacerPatch?.uninstall();
		this.spacerPatch = undefined;
		this.resolved = false;
		this.status = { active: false, reason: "pending" };
	}
}
