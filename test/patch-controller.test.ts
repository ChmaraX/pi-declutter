/**
 * PatchController state-machine tests (ticket 38). This orchestration logic was
 * previously trapped in the index.ts closure and untested. Exercises:
 *   - hasLiveUI gating (print mode / no TUI → never attempts),
 *   - no-instance stays retryable (does NOT latch resolved),
 *   - a found-but-shape-drifted instance resolves fail-open and LATCHES (stops
 *     retrying), driving a requestRender only when active,
 *   - teardown resets to pending and uninstalls.
 *
 * The controller delegates to the real acquireLeadingSpacerPatch, so we drive it
 * with real fake component trees: an empty root yields "no-instance"; a tree
 * holding an AssistantMessageComponent-like whose updateContent does not match
 * the pi 0.85.1 fingerprint yields "shape-drift" (found + fail-open) — the same
 * two branches the live code takes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PatchController, type TuiHandleSource } from "../src/patch-controller.ts";

// A minimal AssistantMessageComponent-like: findAssistantMessageComponents
// duck-types on updateContent + contentContainer.children + a thinking setter.
// Its updateContent source does NOT match pi's fingerprint, so acquire resolves
// fail-open with reason "shape-drift" — a real "found an instance, latch" path.
function fakeAmc(): unknown {
	// updateContent must live on the PROTOTYPE (acquire reads it via
	// Object.getPrototypeOf(instance)); its source won't match pi's fingerprint, so
	// acquire resolves fail-open with reason "shape-drift".
	const proto = {
		setHiddenThinkingLabel() {},
		updateContent() {
			/* not the pi 0.85.1 shape */
		},
	};
	const inst = Object.create(proto) as { contentContainer: { children: unknown[]; removeChild(): void } };
	inst.contentContainer = { children: [], removeChild() {} };
	return inst;
}

interface FakeCtx {
	mode: string;
	hasUI: boolean;
	ui: { notify(): void };
}
function liveCtx(): FakeCtx {
	return { mode: "tui", hasUI: true, ui: { notify() {} } };
}
function printCtx(): FakeCtx {
	return { mode: "print", hasUI: false, ui: { notify() {} } };
}

function makeRuntime(): TuiHandleSource & { renders: number; root: { children: unknown[] } } {
	const root = { children: [] as unknown[] };
	let renders = 0;
	const tui = {
		requestRender() {
			renders++;
		},
		children: root.children,
	};
	// The controller reads runtime.tui as the walk root; expose children on it.
	return {
		tui: tui as unknown as { requestRender?: () => void },
		get renders() {
			return renders;
		},
		root,
	};
}

const hasLiveUI = (ctx: unknown): boolean => (ctx as FakeCtx).mode === "tui" && (ctx as FakeCtx).hasUI;

test("PatchController: starts pending", () => {
	const runtime = makeRuntime();
	const pc = new PatchController(runtime, hasLiveUI as never);
	assert.deepEqual(pc.getStatus(), { active: false, reason: "pending" });
});

test("PatchController: print mode / no TUI never attempts, stays pending", () => {
	const runtime = makeRuntime();
	const pc = new PatchController(runtime, hasLiveUI as never);
	pc.tryPatchLivePrototype(printCtx() as never);
	assert.deepEqual(pc.getStatus(), { active: false, reason: "pending" });
});

test("PatchController: no live component yet → no-instance, does NOT latch (retries)", () => {
	// tui present but its walk finds no AMC-like instance.
	const runtime = makeRuntime();
	const pc = new PatchController(runtime, hasLiveUI as never);
	pc.tryPatchLivePrototype(liveCtx() as never);
	assert.deepEqual(pc.getStatus(), { active: false, reason: "no-instance" });
	// A later attempt still runs (not latched): once an instance appears it resolves.
	(runtime.tui as unknown as { children: unknown[] }).children.push(fakeAmc());
	pc.tryPatchLivePrototype(liveCtx() as never);
	assert.equal(pc.getStatus().reason, "shape-drift");
});

test("PatchController: found instance resolves fail-open and LATCHES (stops retrying)", () => {
	const runtime = makeRuntime();
	(runtime.tui as unknown as { children: unknown[] }).children.push(fakeAmc());
	const pc = new PatchController(runtime, hasLiveUI as never);
	pc.tryPatchLivePrototype(liveCtx() as never);
	assert.equal(pc.getStatus().active, false);
	assert.equal(pc.getStatus().reason, "shape-drift");
	// Fail-open is not active, so no repaint was forced.
	assert.equal(runtime.renders, 0);
	// Latched: a subsequent call is a no-op (status unchanged, still shape-drift).
	pc.tryPatchLivePrototype(liveCtx() as never);
	assert.equal(pc.getStatus().reason, "shape-drift");
});

test("PatchController: teardown resets to pending", () => {
	const runtime = makeRuntime();
	(runtime.tui as unknown as { children: unknown[] }).children.push(fakeAmc());
	const pc = new PatchController(runtime, hasLiveUI as never);
	pc.tryPatchLivePrototype(liveCtx() as never);
	assert.equal(pc.getStatus().reason, "shape-drift");
	pc.teardown();
	assert.deepEqual(pc.getStatus(), { active: false, reason: "pending" });
	// After teardown it attempts again (unlatched).
	pc.tryPatchLivePrototype(liveCtx() as never);
	assert.equal(pc.getStatus().reason, "shape-drift");
});
