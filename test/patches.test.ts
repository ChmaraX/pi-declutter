/**
 * Headless tests for the guarded leading-Spacer patch (ticket 30).
 *
 * Runs via Node's built-in TypeScript type-stripping (Node >= 23.6), no TUI:
 * `node --test test/patches.test.ts`. These lock the guard contract so the patch
 * only ever fires on the exact pi 0.85.1 shape it targets and fails open safely:
 *   - onlyVisibleThinking distinguishes a suppressed-thinking-only message (drop
 *     the leading blank) from one with visible text (keep normal spacing),
 *   - matchesLeadingSpacerShape recognizes the pi 0.85.1 fingerprint and rejects
 *     drift (a renamed/removed leading-Spacer statement),
 *   - installLeadingSpacerPatch strips the leading Spacer for thinking-only,
 *     leaves text messages untouched, is idempotent, reversible, and fails open
 *     (no-target / shape-drift) with a single warn.
 *
 * The install tests drive a FAKE prototype whose updateContent mirrors pi's
 * (leading `this.contentContainer.addChild(new Spacer(1))` when the message has
 * visible raw content), so the pure guard logic is exercised without a terminal.
 * The blank-probe drift canary (prototypes/blank-probe/patch-probe.mjs) asserts
 * the same behaviour against the REAL shipped AssistantMessageComponent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	acquireLeadingSpacerPatch,
	findAssistantMessageComponents,
	installLeadingSpacerPatch,
	isAssistantMessageComponentLike,
	isLeadingSpacer,
	LEADING_SPACER_SIGNATURE,
	matchesLeadingSpacerShape,
	onlyVisibleThinking,
	type RawContentBlock,
	stripSuppressedThinkingSpacers,
	suppressedThinkingSpacersToRemove,
} from "../src/patches.ts";

// ── onlyVisibleThinking predicate ────────────────────────────────────────────

test("onlyVisibleThinking: true when the only visible content is thinking", () => {
	assert.equal(onlyVisibleThinking([{ type: "thinking", thinking: "Planning" }]), true);
	// thinking + tool call (the ticket-26 shape) — tool blocks are not visible content.
	assert.equal(
		onlyVisibleThinking([
			{ type: "thinking", thinking: "Planning" },
			{ type: "toolCall" } as RawContentBlock,
		]),
		true,
	);
	// multiple thinking runs, still no text.
	assert.equal(
		onlyVisibleThinking([
			{ type: "thinking", thinking: "A" },
			{ type: "toolCall" } as RawContentBlock,
			{ type: "thinking", thinking: "B" },
		]),
		true,
	);
	// thinking + a whitespace-only text block is still thinking-only (matches pi's trim()).
	assert.equal(
		onlyVisibleThinking([
			{ type: "thinking", thinking: "A" },
			{ type: "text", text: "   " },
		]),
		true,
	);
});

test("onlyVisibleThinking: false when visible text is present (keep normal spacing)", () => {
	assert.equal(
		onlyVisibleThinking([
			{ type: "thinking", thinking: "Planning" },
			{ type: "text", text: "Answer" },
		]),
		false,
	);
	assert.equal(onlyVisibleThinking([{ type: "text", text: "Answer" }]), false);
});

test("onlyVisibleThinking: false for tool-only, empty, and whitespace-thinking messages", () => {
	assert.equal(onlyVisibleThinking([]), false);
	assert.equal(onlyVisibleThinking([{ type: "toolCall" } as RawContentBlock]), false);
	assert.equal(onlyVisibleThinking([{ type: "thinking", thinking: "   " }]), false);
	assert.equal(onlyVisibleThinking([{ type: "thinking" }]), false);
});

// ── matchesLeadingSpacerShape fingerprint ────────────────────────────────────

// A faithful copy of the pi 0.85.1 updateContent leading-Spacer region
// (assistant-message.js:74-76). The probe asserts the same against the REAL
// shipped source; this locks the fingerprint tokens at the unit level.
const PI_0_85_1_SNIPPET = `updateContent(message, isStreaming = this.isStreaming) {
    this.lastMessage = message;
    this.contentContainer.clear();
    const hasVisibleContent = message.content.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));
    if (hasVisibleContent) {
        this.contentContainer.addChild(new Spacer(1));
    }
}`;

test("matchesLeadingSpacerShape: recognizes the pi 0.85.1 fingerprint", () => {
	assert.equal(matchesLeadingSpacerShape(PI_0_85_1_SNIPPET), true);
});

// The CLI runs a MINIFIED bundle, not the readable dist (ticket 31): variable
// names differ (c2 vs c), spaces are stripped, and hasVisibleContent is inlined.
// The whitespace-normalized fingerprint must still match it, or the patch fails
// open against the very method the CLI invokes.
const PI_0_85_1_BUNDLE_SNIPPET = `updateContent(message,isStreaming=this.isStreaming){this.lastMessage=message,this.isStreaming=isStreaming,this.contentContainer.clear(),message.content.some(c2=>c2.type==="text"&&c2.text.trim()||c2.type==="thinking"&&c2.thinking.trim())&&this.contentContainer.addChild(new Spacer(1));let thinkingRunIndex=0;`;

test("matchesLeadingSpacerShape: recognizes the minified BUNDLE fingerprint (ticket 31)", () => {
	assert.equal(matchesLeadingSpacerShape(PI_0_85_1_BUNDLE_SNIPPET), true);
});

test("matchesLeadingSpacerShape: rejects drift (leading-Spacer statement gone/renamed)", () => {
	// The leading Spacer add was removed upstream (the ideal upstream fix).
	const removed = PI_0_85_1_SNIPPET.replace("this.contentContainer.addChild(new Spacer(1));", "");
	assert.equal(matchesLeadingSpacerShape(removed), false);
	// The predicate was refactored (no more content.some).
	const refactored = PI_0_85_1_SNIPPET.replace("message.content.some", "this.computeVisibility");
	assert.equal(matchesLeadingSpacerShape(refactored), false);
	// A completely different method.
	assert.equal(matchesLeadingSpacerShape("render(width) { return []; }"), false);
});

test("LEADING_SPACER_SIGNATURE contains the strongest (whitespace-normalized) fingerprint token", () => {
	assert.ok(LEADING_SPACER_SIGNATURE.includes("this.contentContainer.addChild(newSpacer(1))"));
});

// ── installLeadingSpacerPatch: a faithful fake prototype ─────────────────────

// Named `Spacer` so the fake updateContent source below carries the exact
// fingerprint token `this.contentContainer.addChild(new Spacer(1))`, and so the
// injected spacerClass instanceof check matches the leading child.
class Spacer {
	lines: number;
	constructor(lines = 1) {
		this.lines = lines;
	}
	// A faithful pi-tui Spacer surface (lines + setLines + render, no children) so
	// isLeadingSpacer duck-types it even when the live class object is unknown.
	setLines(lines: number): void {
		this.lines = lines;
	}
	render(): string[] {
		return Array.from({ length: this.lines }, () => "");
	}
}

// Faithful children with a render() so the ticket-33 strip walk (which measures
// rendered rows) classifies them like the real components: a suppressed thinking
// run renders 0 rows, a text paragraph renders 1.
class FakeThinking {
	kind = "thinking" as const;
	// Suppressed by our transformer → zero rows (like the blanked Markdown/Text).
	render(): string[] {
		return [];
	}
}
class FakeText {
	kind = "text" as const;
	render(): string[] {
		return ["Answer"];
	}
}

class FakeContainer {
	children: unknown[] = [];
	addChild(child: unknown): void {
		this.children.push(child);
	}
	removeChild(child: unknown): void {
		const index = this.children.indexOf(child);
		if (index !== -1) this.children.splice(index, 1);
	}
	clear(): void {
		this.children = [];
	}
}

interface FakeMessage {
	content: RawContentBlock[];
}

/** Build a fresh fake prototype + instance mirroring pi's updateContent so each
 * test mutates its own prototype (install patches the prototype in place). */
function makeFakeTarget(): {
	proto: { updateContent(this: FakeInstance, message: FakeMessage): void };
	instance: FakeInstance;
} {
	interface FakeInstanceShape {
		contentContainer: FakeContainer;
		lastMessage?: FakeMessage;
		updateContent(message: FakeMessage): void;
	}
	const proto = {
		// Mirrors pi 0.85.1 updateContent (assistant-message.js:69-135): a leading
		// Spacer when the message has visible raw content, a zero-row thinking child
		// per run, and a TRAILING Spacer after a thinking run when visible content
		// follows. This is what the ticket-33 strip must clean up.
		updateContent(this: FakeInstanceShape, message: FakeMessage): void {
			this.contentContainer.clear();
			this.lastMessage = message;
			const hasVisibleContent = message.content.some(
				(c) => (c.type === "text" && (c.text ?? "").trim()) || (c.type === "thinking" && (c.thinking ?? "").trim()),
			);
			if (hasVisibleContent) {
				this.contentContainer.addChild(new Spacer(1));
			}
			for (let i = 0; i < message.content.length; i++) {
				const c = message.content[i];
				if (c.type === "text" && (c.text ?? "").trim()) {
					this.contentContainer.addChild(new FakeText());
				} else if (c.type === "thinking" && (c.thinking ?? "").trim()) {
					this.contentContainer.addChild(new FakeThinking());
					const hasVisibleAfter = message.content
						.slice(i + 1)
						.some((n) => (n.type === "text" && (n.text ?? "").trim()) || (n.type === "thinking" && (n.thinking ?? "").trim()));
					if (hasVisibleAfter) this.contentContainer.addChild(new Spacer(1));
				}
			}
		},
	};
	const instance = Object.create(proto) as FakeInstanceShape;
	instance.contentContainer = new FakeContainer();
	return { proto, instance: instance as FakeInstance };
}

type FakeInstance = {
	contentContainer: FakeContainer;
	lastMessage?: FakeMessage;
	updateContent(message: FakeMessage): void;
};

const THINKING_ONLY: FakeMessage = { content: [{ type: "thinking", thinking: "Planning" }, { type: "toolCall" } as RawContentBlock] };
const WITH_TEXT: FakeMessage = { content: [{ type: "thinking", thinking: "Planning" }, { type: "text", text: "Answer" }] };

test("installLeadingSpacerPatch: activates on the matching shape and strips the leading Spacer for thinking-only", () => {
	const { proto, instance } = makeFakeTarget();
	const patch = installLeadingSpacerPatch({ prototype: proto, spacerClass: Spacer });
	assert.equal(patch.active, true);
	assert.equal(patch.reason, undefined);

	instance.updateContent(THINKING_ONLY);
	// No leading Spacer: only the thinking content child remains.
	assert.equal(instance.contentContainer.children.some((c) => c instanceof Spacer), false);
	assert.equal(instance.contentContainer.children.length, 1);
	patch.uninstall();
});

test("installLeadingSpacerPatch: leaves visible-text messages' spacing untouched", () => {
	const { proto, instance } = makeFakeTarget();
	const patch = installLeadingSpacerPatch({ prototype: proto, spacerClass: Spacer });

	instance.updateContent(WITH_TEXT);
	// Leading Spacer kept (message has visible text → normal paragraph spacing).
	assert.equal(instance.contentContainer.children[0] instanceof Spacer, true);
	patch.uninstall();
});

test("installLeadingSpacerPatch: uninstall restores the original (leading Spacer returns)", () => {
	const { proto, instance } = makeFakeTarget();
	const patch = installLeadingSpacerPatch({ prototype: proto, spacerClass: Spacer });
	patch.uninstall();
	assert.equal(patch.active, false);

	instance.updateContent(THINKING_ONLY);
	// After uninstall pi's original behaviour is back: the leading Spacer is present.
	assert.equal(instance.contentContainer.children[0] instanceof Spacer, true);
});

test("installLeadingSpacerPatch: idempotent — a second install returns the active patch", () => {
	const { proto } = makeFakeTarget();
	const first = installLeadingSpacerPatch({ prototype: proto, spacerClass: Spacer });
	const second = installLeadingSpacerPatch({ prototype: proto, spacerClass: Spacer });
	assert.equal(second.active, true);
	assert.equal(second.reason, "already-patched");
	first.uninstall();
});

test("installLeadingSpacerPatch: fails open on shape drift (no patch, single warn, probe-detectable flag)", () => {
	const proto = {
		// A drifted updateContent whose source lacks the leading-Spacer fingerprint.
		updateContent(this: FakeInstance, message: FakeMessage): void {
			this.contentContainer.clear();
			for (const c of message.content) this.contentContainer.addChild(c.type === "text" ? new FakeText() : new FakeThinking());
		},
	};
	const instance = Object.create(proto) as FakeInstance;
	instance.contentContainer = new FakeContainer();
	const warnings: string[] = [];
	const patch = installLeadingSpacerPatch({ prototype: proto, spacerClass: Spacer, warn: (m) => warnings.push(m) });

	assert.equal(patch.active, false);
	assert.equal(patch.reason, "shape-drift");
	assert.equal(warnings.length, 1);
	// The original method is left untouched and still runs.
	assert.doesNotThrow(() => instance.updateContent(THINKING_ONLY));
	assert.equal(instance.contentContainer.children.length, 2);
});

test("installLeadingSpacerPatch: fails open when updateContent is absent (no-target)", () => {
	const warnings: string[] = [];
	const patch = installLeadingSpacerPatch({ prototype: {}, spacerClass: Spacer, warn: (m) => warnings.push(m) });
	assert.equal(patch.active, false);
	assert.equal(patch.reason, "no-target");
	assert.equal(warnings.length, 1);
	assert.doesNotThrow(() => patch.uninstall());
});

test("installLeadingSpacerPatch: strips the leading Spacer by DUCK-TYPING when no spacerClass is given (bundle-safe)", () => {
	const { proto, instance } = makeFakeTarget();
	// No spacerClass: the wrapper must duck-type the leading child (ticket 31 — an
	// imported class is unreliable across the bundle/dist split).
	const patch = installLeadingSpacerPatch({ prototype: proto });
	assert.equal(patch.active, true);
	instance.updateContent(THINKING_ONLY);
	assert.equal(instance.contentContainer.children.some((c) => c instanceof Spacer), false);
	assert.equal(instance.contentContainer.children.length, 1);
	patch.uninstall();
});

// ── isLeadingSpacer duck-typing (ticket 31) ───────────────────────────────

test("isLeadingSpacer: duck-types a pi-tui Spacer and rejects containers/content", () => {
	// Duck-typed (no class): numeric lines + setLines + render, not a container.
	const spacerLike = { lines: 1, setLines() {}, render: () => [""] };
	assert.equal(isLeadingSpacer(spacerLike), true);
	// Exact class fast-path.
	assert.equal(isLeadingSpacer(new Spacer(1), Spacer), true);
	// A container (has children) is never a spacer, even if it had spacer-ish members.
	assert.equal(isLeadingSpacer({ lines: 1, setLines() {}, render: () => [], children: [] }), false);
	// A Markdown/Text-like content node.
	assert.equal(isLeadingSpacer({ text: "hi", render: () => ["hi"] }), false);
	assert.equal(isLeadingSpacer(undefined), false);
	assert.equal(isLeadingSpacer(null), false);
});

// ── isAssistantMessageComponentLike duck-typing (ticket 31) ──────────────────

test("isAssistantMessageComponentLike: identifies the component without importing the class", () => {
	const amc = {
		updateContent() {},
		contentContainer: { children: [] },
		setHiddenThinkingLabel() {},
	};
	assert.equal(isAssistantMessageComponentLike(amc), true);
	// setHideThinkingBlock is an accepted alternative distinctive member.
	assert.equal(
		isAssistantMessageComponentLike({ updateContent() {}, contentContainer: { children: [] }, setHideThinkingBlock() {} }),
		true,
	);
	// Missing the thinking setter — e.g. a generic container — is rejected.
	assert.equal(isAssistantMessageComponentLike({ updateContent() {}, contentContainer: { children: [] } }), false);
	// No contentContainer / wrong shape.
	assert.equal(isAssistantMessageComponentLike({ updateContent() {}, setHiddenThinkingLabel() {} }), false);
	assert.equal(isAssistantMessageComponentLike({ contentContainer: { children: [] }, setHiddenThinkingLabel() {} }), false);
	assert.equal(isAssistantMessageComponentLike(null), false);
});

// ── findAssistantMessageComponents: live-tree walk (ticket 31) ────────────────

/** A minimal AMC-like instance whose prototype carries a fingerprint-matching
 * updateContent, so acquireLeadingSpacerPatch can derive + patch its prototype. */
function makeLiveAmc(content?: RawContentBlock[]): FakeInstance & { setHiddenThinkingLabel(): void; lastMessage?: FakeMessage } {
	const { proto, instance } = makeFakeTarget();
	(proto as unknown as { setHiddenThinkingLabel(): void }).setHiddenThinkingLabel = function () {};
	const amc = instance as FakeInstance & { setHiddenThinkingLabel(): void; lastMessage?: FakeMessage };
	if (content) {
		amc.updateContent({ content });
		amc.lastMessage = { content };
	}
	return amc;
}

test("findAssistantMessageComponents: walks children + getMountedRoots and guards cycles", () => {
	const a = makeLiveAmc();
	const b = makeLiveAmc();
	const nested = { children: [{ notAComponent: true }, b] };
	const root: { children: unknown[]; getMountedRoots(): unknown[] } = {
		children: [a, nested],
		getMountedRoots() {
			return [root]; // cycle back to root; the seen-set must not loop
		},
	};
	const found = findAssistantMessageComponents(root);
	assert.equal(found.length, 2);
	assert.ok(found.includes(a));
	assert.ok(found.includes(b));
});

test("findAssistantMessageComponents: returns [] when no component is mounted", () => {
	assert.deepEqual(findAssistantMessageComponents({ children: [{ x: 1 }] }), []);
	assert.deepEqual(findAssistantMessageComponents(undefined), []);
});

// ── suppressedThinkingSpacersToRemove (ticket 33: strip ALL dead spacers) ─────

// Build a children array the way pi's updateContent does, so the render-measured
// strip rule is tested against realistic shapes. `t` = suppressed thinking (0
// rows), `x` = visible text (1 row), `_` = Spacer.
function shapeChildren(spec: string): unknown[] {
	const out: unknown[] = [];
	for (const ch of spec) {
		if (ch === "_") out.push(new Spacer(1));
		else if (ch === "t") out.push(new FakeThinking());
		else if (ch === "x") out.push(new FakeText());
	}
	return out;
}
function blankRows(children: readonly unknown[]): number {
	return children.reduce<number>((n, c) => n + ((c as { render(w: number): string[] }).render(80).filter((l) => l.trim() === "").length), 0);
}

test("suppressedThinkingSpacersToRemove: [think,text] drops the trailing spacer, keeps one leading margin (== [text])", () => {
	// pi renders [think,text] as: _ t _ x  → want _ t x (1 blank, same as plain text).
	const children = shapeChildren("_t_x");
	const remove = suppressedThinkingSpacersToRemove(children, 80, Spacer);
	assert.equal(remove.length, 1);
	const kept = children.filter((c) => !remove.includes(c));
	assert.equal(blankRows(kept), 1);
	assert.equal(kept[0] instanceof Spacer, true); // leading margin retained
});

test("suppressedThinkingSpacersToRemove: [think,tool] drops the leading spacer entirely (0 blanks)", () => {
	// [think,tool] renders as _ t (tool row is elsewhere) → want just t (0 blanks).
	const children = shapeChildren("_t");
	const remove = suppressedThinkingSpacersToRemove(children, 80, Spacer);
	assert.equal(remove.length, 1);
	const kept = children.filter((c) => !remove.includes(c));
	assert.equal(blankRows(kept), 0);
});

test("suppressedThinkingSpacersToRemove: multi-run [think,tool,think,text] leaves only the answer margin (1 blank)", () => {
	// _ t _ t _ x  → want _ t t x (1 blank).
	const children = shapeChildren("_t_t_x");
	const remove = suppressedThinkingSpacersToRemove(children, 80, Spacer);
	assert.equal(remove.length, 2);
	const kept = children.filter((c) => !remove.includes(c));
	assert.equal(blankRows(kept), 1);
});

test("suppressedThinkingSpacersToRemove: plain [text] is untouched (keeps its single margin)", () => {
	const children = shapeChildren("_x");
	assert.equal(suppressedThinkingSpacersToRemove(children, 80, Spacer).length, 0);
});

test("suppressedThinkingSpacersToRemove: two real paragraphs keep their separating margin", () => {
	// _ x _ x : the middle spacer separates two visible blocks → never removed.
	const children = shapeChildren("_x_x");
	assert.deepEqual(suppressedThinkingSpacersToRemove(children, 80, Spacer), []);
});

test("stripSuppressedThinkingSpacers: mutates the container and reports the removed count", () => {
	const instance = { contentContainer: new FakeContainer() };
	for (const c of shapeChildren("_t_x")) instance.contentContainer.addChild(c);
	const removed = stripSuppressedThinkingSpacers(instance, Spacer);
	assert.equal(removed, 1);
	assert.equal(blankRows(instance.contentContainer.children), 1);
});

test("stripSuppressedThinkingSpacers: empty / no-container instances are a safe no-op", () => {
	assert.equal(stripSuppressedThinkingSpacers({ contentContainer: new FakeContainer() }), 0);
	assert.equal(stripSuppressedThinkingSpacers({} as never), 0);
});

// ── acquireLeadingSpacerPatch: end-to-end live acquisition (ticket 31) ────────

test("acquireLeadingSpacerPatch: finds the live instance, patches its prototype, and retroactively drops the spacer", () => {
	const amc = makeLiveAmc(THINKING_ONLY.content);
	assert.equal(amc.contentContainer.children[0] instanceof Spacer, true);
	const result = acquireLeadingSpacerPatch({ root: { children: [amc] } });
	assert.equal(result.patch.active, true);
	assert.equal(result.instance, amc);
	// Retroactive removal cleared the pre-patch leading blank.
	assert.equal(amc.contentContainer.children.some((c) => c instanceof Spacer), false);
	// And future renders through the patched prototype stay spacer-free.
	amc.updateContent(THINKING_ONLY);
	assert.equal(amc.contentContainer.children.some((c) => c instanceof Spacer), false);
	result.patch.uninstall();
});

test("acquireLeadingSpacerPatch: reports no-instance (retry, not fail-open) when nothing is mounted", () => {
	const result = acquireLeadingSpacerPatch({ root: { children: [] } });
	assert.equal(result.patch.active, false);
	assert.equal(result.patch.reason, "no-instance");
	assert.equal(result.instance, undefined);
});

test("acquireLeadingSpacerPatch: fails open on a drifted live prototype (found instance, shape-drift)", () => {
	const proto = {
		updateContent(this: FakeInstance, message: FakeMessage): void {
			this.contentContainer.clear();
			for (const c of message.content) this.contentContainer.addChild(c.type === "text" ? new FakeText() : new FakeThinking());
		},
		setHiddenThinkingLabel(): void {},
	};
	const amc = Object.create(proto) as FakeInstance & { setHiddenThinkingLabel(): void };
	amc.contentContainer = new FakeContainer();
	const warnings: string[] = [];
	const result = acquireLeadingSpacerPatch({ root: { children: [amc] }, warn: (m) => warnings.push(m) });
	assert.equal(result.patch.active, false);
	assert.equal(result.patch.reason, "shape-drift");
	assert.equal(result.instance, amc);
	assert.equal(warnings.length, 1);
});
