/**
 * NarrationController lifecycle tests (ticket 41, review follow-up: owning
 * module). Previously trapped across index.ts + patches.ts and untested as a
 * unit. hide/restore/rehideAfterRebuild/findInstances are INJECTED (same
 * deps-injected pattern as ModalController), so these drive the orchestration
 * with plain stub functions instead of a real AssistantMessageComponent tree
 * — patches.ts's own hide/restore/rehide implementations stay covered by
 * test/patches.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardEntry } from "../src/card-shape.ts";
import { NarrationController, type NarrationControllerDeps } from "../src/narration-controller.ts";
import type { PatchTargetInstance } from "../src/patches.ts";

function fakeInstance(id: string): PatchTargetInstance {
	// Identity is all that matters to these tests — a bare marker object.
	return { id } as unknown as PatchTargetInstance;
}

interface Recorder {
	hideCalls: Array<{ instance: PatchTargetInstance; contentIndex: number }>;
	restoreCalls: Array<{ instance: PatchTargetInstance; contentIndex: number; text: string }>;
	rehideCalls: Array<{ root: unknown; texts: string[] }>;
	renders: number;
}

/** A controller wired with stub deps that record every call, plus the
 * recorder to assert against. `hideResult`/`restoreResult` let a test force
 * the fail-open path. `instances` is what findInstances returns (defaults to
 * a single fresh instance per call, mirroring the live "most recent AMC"). */
function makeController(opts?: {
	hideResult?: boolean;
	restoreResult?: boolean;
	instances?: PatchTargetInstance[];
}): { controller: NarrationController; rec: Recorder } {
	const rec: Recorder = { hideCalls: [], restoreCalls: [], rehideCalls: [], renders: 0 };
	const deps: NarrationControllerDeps = {
		hide(instance, contentIndex) {
			rec.hideCalls.push({ instance, contentIndex });
			return opts?.hideResult ?? true;
		},
		restore(instance, contentIndex, text) {
			rec.restoreCalls.push({ instance, contentIndex, text });
			return opts?.restoreResult ?? true;
		},
		rehideAfterRebuild(root, texts) {
			rec.rehideCalls.push({ root, texts: [...texts] });
			return texts.size;
		},
		findInstances(_root) {
			return opts?.instances ?? [fakeInstance("live")];
		},
		requestRender() {
			rec.renders++;
		},
	};
	return { controller: new NarrationController(deps), rec };
}

function cardEntries(...texts: string[]): CardEntry[] {
	return texts.map((text) => ({ kind: "narration" as const, narration: { text, summary: text } }));
}

// ── pending capture → confirm hides via injected hide fn ─────────────────────

test("captureTextEnd + confirmNonFinal: hides the captured block via the injected hide fn and requests a render", () => {
	const { controller, rec } = makeController();
	controller.captureTextEnd({}, 2, "  Intermediate paragraph.  ");
	assert.equal(controller.pendingText(), "Intermediate paragraph."); // trimmed
	assert.equal(rec.hideCalls.length, 0, "not hidden until confirmed");

	controller.confirmNonFinal();
	assert.equal(rec.hideCalls.length, 1);
	assert.equal(rec.hideCalls[0].contentIndex, 2);
	assert.equal(rec.renders, 1);
	assert.equal(controller.pendingText(), undefined, "cleared after confirm");
});

test("captureTextEnd: whitespace-only content is never captured (mirrors the grouper's own break condition)", () => {
	const { controller, rec } = makeController();
	controller.captureTextEnd({}, 0, "   \n\t  ");
	assert.equal(controller.pendingText(), undefined);
	controller.confirmNonFinal();
	assert.equal(rec.hideCalls.length, 0);
});

test("captureTextEnd: no-op when no live instance is found (findInstances returns [])", () => {
	const { controller } = makeController({ instances: [] });
	controller.captureTextEnd({}, 0, "Answer.");
	assert.equal(controller.pendingText(), undefined);
});

test("confirmNonFinal: no-op when nothing is pending", () => {
	const { controller, rec } = makeController();
	controller.confirmNonFinal();
	assert.equal(rec.hideCalls.length, 0);
	assert.equal(rec.renders, 0);
});

test("confirmNonFinal: a failed hide (fail-open) is not recorded for later promotion, and no render is requested", () => {
	const { controller, rec } = makeController({ hideResult: false });
	controller.captureTextEnd({}, 0, "Paragraph.");
	controller.confirmNonFinal();
	assert.equal(rec.hideCalls.length, 1, "hide was still attempted");
	assert.equal(rec.renders, 0, "no render on a failed hide");
	// A failed hide never entered `hides`, so a later promotion can't restore it —
	// verified indirectly: settle() with a matching finalAnswer finds nothing to restore.
	controller.settle("Paragraph.", true);
	assert.equal(rec.restoreCalls.length, 0);
});

test("confirmNonFinal: two confirmed blocks in a row are both recorded, in confirm order", () => {
	const { controller, rec } = makeController();
	controller.captureTextEnd({}, 0, "First.");
	controller.confirmNonFinal();
	controller.captureTextEnd({}, 1, "Second.");
	controller.confirmNonFinal();
	assert.deepEqual(
		rec.hideCalls.map((c) => c.contentIndex),
		[0, 1],
	);
});

// ── promotion restores the matching record (last-by-text) ──────────────────

test("settle: promotion restores the LAST hide matching finalAnswer by text", () => {
	const { controller, rec } = makeController();
	// Two confirmed hides, the second one's text happens to repeat later in the
	// response's final paragraph — settle must restore the LAST record with a
	// matching text (records append in confirm order; search runs newest-first).
	controller.captureTextEnd({}, 0, "Repeated text.");
	controller.confirmNonFinal();
	controller.captureTextEnd({}, 1, "Repeated text.");
	controller.confirmNonFinal();
	rec.renders = 0; // isolate settle()'s own render count

	controller.settle("Repeated text.", true);

	assert.equal(rec.restoreCalls.length, 1);
	assert.equal(rec.restoreCalls[0].contentIndex, 1, "restored the LAST matching record");
	assert.equal(rec.renders, 1);
});

test("settle: no promotion (promoted false/undefined) restores nothing, regardless of finalAnswer", () => {
	const { controller, rec } = makeController();
	controller.captureTextEnd({}, 0, "Answer.");
	controller.confirmNonFinal();
	rec.renders = 0;

	controller.settle("Answer.", false);
	assert.equal(rec.restoreCalls.length, 0);
	assert.equal(rec.renders, 0);

	controller.settle("Answer.", undefined);
	assert.equal(rec.restoreCalls.length, 0);
});

test("settle: promoted true but finalAnswer undefined restores nothing (defensive — matches grouping.ts's contract)", () => {
	const { controller, rec } = makeController();
	controller.captureTextEnd({}, 0, "Answer.");
	controller.confirmNonFinal();
	controller.settle(undefined, true);
	assert.equal(rec.restoreCalls.length, 0);
});

test("settle: promoted true with no matching text hides nothing (fail-open, no crash)", () => {
	const { controller, rec } = makeController();
	controller.captureTextEnd({}, 0, "Answer.");
	controller.confirmNonFinal();
	controller.settle("Some other text entirely.", true);
	assert.equal(rec.restoreCalls.length, 0);
});

test("settle: a failed restore (fail-open) still clears the pending state and requests no render", () => {
	const { controller, rec } = makeController({ restoreResult: false });
	controller.captureTextEnd({}, 0, "Answer.");
	controller.confirmNonFinal();
	rec.renders = 0;
	controller.settle("Answer.", true);
	assert.equal(rec.restoreCalls.length, 1);
	assert.equal(rec.renders, 0);
});

test("settle: always clears any still-pending (unconfirmed) block defensively", () => {
	const { controller } = makeController();
	controller.captureTextEnd({}, 0, "Never confirmed.");
	assert.equal(controller.pendingText(), "Never confirmed.");
	controller.settle(undefined, undefined);
	assert.equal(controller.pendingText(), undefined);
});

// ── reset drops state ───────────────────────────────────────────────────────

test("reset: drops a pending capture WITHOUT hiding it", () => {
	const { controller, rec } = makeController();
	controller.captureTextEnd({}, 0, "Final answer, never followed.");
	controller.reset();
	assert.equal(controller.pendingText(), undefined);
	assert.equal(rec.hideCalls.length, 0, "reset must never hide — the block may have been the true final answer");
});

test("reset: drops accumulated hide records so a later settle can't promote/restore them", () => {
	const { controller, rec } = makeController();
	controller.captureTextEnd({}, 0, "Paragraph.");
	controller.confirmNonFinal();
	controller.reset();
	controller.settle("Paragraph.", true);
	assert.equal(rec.restoreCalls.length, 0, "hides were dropped by reset, nothing left to restore");
});

// ── sweep collects texts from provided card models ──────────────────────────

test("sweepAfterRebuild: collects narration texts across multiple card entry lists and rehides via the injected fn", () => {
	const { controller, rec } = makeController();
	const lists = [cardEntries("First card's paragraph."), cardEntries("Second card's paragraph.", "Another one.")];
	controller.sweepAfterRebuild({ root: true }, lists);

	assert.equal(rec.rehideCalls.length, 1);
	assert.deepEqual(
		new Set(rec.rehideCalls[0].texts),
		new Set(["First card's paragraph.", "Second card's paragraph.", "Another one."]),
	);
});

test("sweepAfterRebuild: non-narration entries (group/thought) are ignored", () => {
	const { controller, rec } = makeController();
	const entries: CardEntry[] = [
		{ kind: "group", group: { label: "Ran ls", counts: "1 command", items: [] } },
		{ kind: "thought", thought: { ms: 1000, summary: "Thinking", tail: [], fullText: "" } },
	];
	controller.sweepAfterRebuild({}, [entries]);
	assert.equal(rec.rehideCalls.length, 0, "no narration texts \u2014 rehideAfterRebuild must not be called");
});

test("sweepAfterRebuild: an empty card entry list set is a complete no-op (rehideAfterRebuild never called)", () => {
	const { controller, rec } = makeController();
	controller.sweepAfterRebuild({}, []);
	assert.equal(rec.rehideCalls.length, 0);
});

test("sweepAfterRebuild: duplicate texts across lists are deduped into one set", () => {
	const { controller, rec } = makeController();
	controller.sweepAfterRebuild({}, [cardEntries("Same text."), cardEntries("Same text.")]);
	assert.equal(rec.rehideCalls.length, 1);
	assert.deepEqual(rec.rehideCalls[0].texts, ["Same text."]);
});
