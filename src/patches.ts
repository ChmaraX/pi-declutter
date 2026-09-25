/**
 * Guarded runtime patch layer (tickets 30 + 31).
 *
 * The owner lifted the no-monkey-patching constraint (map "Out of scope",
 * 2026-09-15; pi-cc-extensions precedent): guarded RUNTIME patching of pi
 * internals from within the extension is now in scope — feature-detected,
 * fail-open, reversible, removed when upstream obsoletes it. Unguarded patching
 * stays out.
 *
 * The one patch here neutralizes the single irreducible blank the activity feed
 * could not remove with supported APIs (tickets 22/26/27): pi's
 * AssistantMessageComponent adds a LEADING `Spacer(1)` before a message's content
 * whenever the message has any visible RAW content, computed pre-transform from
 * text OR thinking (`assistant-message.js:74-76`):
 *
 *     const hasVisibleContent = message.content.some(
 *         (c) => (c.type === "text" && c.text.trim()) ||
 *                (c.type === "thinking" && c.thinking.trim()));
 *     if (hasVisibleContent) this.contentContainer.addChild(new Spacer(1));
 *
 * The extension suppresses native thinking with a markdown transformer that
 * blanks `assistant-thinking` to zero rows (src/index.ts), so a message whose
 * ONLY visible raw content is thinking (`[thinking, toolCall…]`, the shape a big
 * task emits dozens of — ticket 26) renders its thinking body to nothing yet
 * still keeps this leading Spacer. Those spacers stack additively into the
 * owner's audited ~40-blank gap.
 *
 * ── Ticket 31: patch the LIVE prototype, not the imported class copy ─────────
 * The first attempt (ticket 30) patched `AssistantMessageComponent.prototype`
 * from the class the extension `import`s. That had ZERO live effect: pi's CLI runs
 * a BUNDLE (`dist/bundle/chunks/chunk-*.js`) whose `AssistantMessageComponent` is
 * a DIFFERENT class object than the one the extension's
 * `import { AssistantMessageComponent }` resolves to (the unbundled `dist`). We
 * patched a prototype no live component uses. The probe imported the same
 * unbundled copy, so it was falsely green.
 *
 * The fix (this module): obtain the prototype from a LIVE component instance found
 * by walking the running chat tree from the captured TUI handle, and patch THAT.
 * Identity is established by DUCK-TYPING distinctive members
 * (updateContent + contentContainer + a thinking-block setter) — NOT by an
 * `instanceof` against an imported class, which the bundle/dist split makes
 * unreliable. The pi-tui `Spacer` used for the leading-child check is likewise
 * duck-typed (numeric `lines` + `setLines`/`render`, not a container), so the
 * bundle's Spacer instances are recognized without importing the dist class.
 *
 * The fingerprint (`matchesLeadingSpacerShape`) is whitespace-NORMALIZED so it
 * matches BOTH the readable `dist` source and the minified bundle source (the
 * bundle inlines `hasVisibleContent` and strips spaces, so the old spaced tokens
 * never matched it — a second reason the ticket-30 patch would have failed open
 * even against the right prototype).
 *
 * ── Ticket 33: strip ALL spacers bordering a suppressed thinking run ─────────
 * The leading Spacer is not the only blank. `updateContent` also adds a TRAILING
 * `Spacer(1)` after each thinking run when visible content follows
 * (`assistant-message.js:130`). Once our transformer blanks the thinking body to
 * zero rows, BOTH the leading and the trailing spacer become pure dead blanks —
 * so a `[thinking, text]` answer leaked 2 blanks above the text, and a multi-run
 * `[thinking, tool, thinking, text]` leaked 3. The original leading-only removal
 * (and its `onlyVisibleThinking` gate, which bailed the moment any text was
 * present) never touched these, which was the dominant remaining gap.
 *
 * This module now removes EVERY dead blank spacer around a suppressed thinking
 * run, on ANY message shape, by measuring what actually rendered
 * (`suppressedThinkingSpacersToRemove`): a Spacer is dead unless it sits strictly
 * between two visible (≥1-row, non-Spacer) blocks; exactly ONE leading margin is
 * kept when a real text/markdown block renders, so a text paragraph keeps the
 * single top margin pi would give it if the thinking were absent, and
 * `[thinking,tool]` (no visible block) drops to zero. The transcript's
 * stored/resent message is not touched at all — this is a render-tree edit,
 * applied AFTER pi builds the content container, so it cannot change what is
 * persisted or re-sent to the provider (the constraint that forbade the
 * `message_end` route, ticket 26).
 *
 * Guard contract (why this is safe to ship):
 *   - Feature-detected: the patch installs ONLY when the compiled pi 0.85.1
 *     `updateContent` still carries the exact leading-Spacer shape it targets
 *     (matchesLeadingSpacerShape over the function source). If pi changes that
 *     method — a version bump, a refactor — the fingerprint stops matching and
 *     the patch FAILS OPEN: nothing is wrapped, the blanks return, the extension
 *     keeps working, and the returned state records `reason: "shape-drift"` (a
 *     probe-detectable flag; a single warn is emitted if a logger is supplied).
 *   - Reversible: install returns an `uninstall()` that restores the original
 *     method (only if ours is still the installed one — downstream-aware, like
 *     pi-cc-extensions' patch registry), called on session_shutdown.
 *   - Idempotent: a marker on the prototype means a second install is a no-op
 *     that returns the existing active state.
 *   - Crash-safe: the wrapper always calls the original first and guards its own
 *     work in try/catch, so a patch fault can never break message rendering.
 *
 * The predicate, walk, and shape matcher are pure and dependency-free (no pi
 * imports — the root, prototype, and Spacer identity are all resolved at runtime
 * from the live tree), so they are unit-testable with plain objects
 * (test/patches.test.ts) and the blank-probe drift canary can drive them against
 * the REAL component (prototypes/blank-probe/patch-probe.mjs).
 *
 * ⚠️ Run `node prototypes/blank-probe/patch-probe.mjs` after ANY pi/extension
 * update: it asserts the patched blank counts (40×[thinking,tool] → 0 blanks) AND
 * that the guard deactivates on simulated shape drift. If it reports shape-drift,
 * the fingerprint below needs re-checking against the new pi source. Live-bundle
 * activation is separately checkable with the `/activity-patch` command.
 */

/** Minimal shape of a raw assistant message content block we inspect. */
export interface RawContentBlock {
	type: string;
	text?: string;
	thinking?: string;
}


/**
 * WHITESPACE-NORMALIZED source substrings that fingerprint the pi 0.85.1
 * `updateContent` leading-Spacer shape this patch targets. The source is matched
 * after `.replace(/\s+/g, "")`, so these tokens are themselves whitespace-free and
 * variable-name-agnostic — they match BOTH the readable `dist` build
 * (`(c.type === "text" && c.text.trim())` …) AND the minified bundle the CLI runs
 * (`c2.type==="text"&&c2.text.trim()` …), which inlines `hasVisibleContent` and
 * strips spaces (ticket 31). All must be present for the patch to install; a
 * missing token means the method drifted and we fail open. The last token is the
 * strongest fingerprint — it is the exact statement whose effect (a leading
 * `Spacer(1)` added to `contentContainer`) this patch reverses.
 */
export const LEADING_SPACER_SIGNATURE: readonly string[] = [
	"message.content.some",
	'.type==="text"',
	'.type==="thinking"',
	"this.contentContainer.addChild(newSpacer(1))",
];

/** True when `source` (an `updateContent.toString()`) still matches the exact
 * pi 0.85.1 leading-Spacer shape this patch targets. Whitespace is stripped first
 * so both the readable `dist` and the minified bundle source match (ticket 31). */
export function matchesLeadingSpacerShape(source: string): boolean {
	const normalized = source.replace(/\s+/g, "");
	return LEADING_SPACER_SIGNATURE.every((token) => normalized.includes(token));
}

/** Why the guard did not activate (the probe-detectable fail-open flag). */
export type PatchInactiveReason = "no-target" | "shape-drift" | "already-patched" | "no-instance";

/** State returned by installLeadingSpacerPatch — `active` plus, when it failed
 * open, the `reason`, plus a reversible `uninstall`. */
export interface LeadingSpacerPatch {
	active: boolean;
	reason?: PatchInactiveReason;
	uninstall(): void;
}

/** Minimal render-container shape the patch touches (pi-tui Container). */
interface PatchContentContainer {
	children: unknown[];
	removeChild(child: unknown): void;
}

/** Minimal AssistantMessageComponent instance shape after updateContent runs.
 * Exported (ticket 41) so index.ts can type the instance it captures at text_end
 * for later narration hide/no-op, without re-declaring the shape. */
export interface PatchTargetInstance {
	contentContainer?: PatchContentContainer;
	/** The raw message the component last rendered (used for retroactive removal). */
	lastMessage?: { content?: unknown };
	/** Re-render from `lastMessage` (or an explicitly passed message) through
	 * whatever updateContent is CURRENTLY bound — original or patched — so a
	 * narration hide (ticket 41, hideMessageTextBlock) composes with the spacer
	 * patch instead of bypassing it. */
	updateContent?: (message: { content?: unknown }, ...rest: unknown[]) => unknown;
}

/** The prototype carrying the `updateContent(message, isStreaming?)` method. */
interface PatchTargetPrototype {
	updateContent?: (this: PatchTargetInstance, message: { content?: unknown }, ...rest: unknown[]) => unknown;
}

/**
 * True when `child` looks like a pi-tui `Spacer` — the leading blank pi adds.
 * Duck-typed rather than `instanceof` because the bundle/dist split (ticket 31)
 * makes an imported `Spacer` class a different object than the live one; a Spacer
 * has a numeric `lines`, a `setLines`/`render` pair, and is NOT a container (no
 * `children` array). An optional live `spacerClass` (derived from a real leading
 * child) is honoured as a fast exact check when available.
 */
export function isLeadingSpacer(child: unknown, spacerClass?: Function): boolean {
	if (spacerClass && child instanceof spacerClass) return true;
	if (!child || typeof child !== "object") return false;
	const c = child as { lines?: unknown; setLines?: unknown; render?: unknown; children?: unknown };
	return (
		typeof c.lines === "number" &&
		typeof c.setLines === "function" &&
		typeof c.render === "function" &&
		!Array.isArray(c.children)
	);
}

/** A child of `contentContainer` that can report its rendered height. */
interface RenderableChild {
	render?: (width: number) => unknown;
}

/**
 * How many rows a `contentContainer` child renders at `width`. A suppressed
 * thinking run (our transformer blanks its Markdown/Text to nothing) reports 0;
 * a real text paragraph or a Spacer reports ≥1. Any render fault counts as
 * "visible" (returns a positive height) so the strip below never deletes a
 * spacer bordering a block it could not measure — fail safe toward pi's default.
 */
export function childRowCount(child: unknown, width: number): number {
	const r = (child as RenderableChild)?.render;
	if (typeof r !== "function") return 1;
	try {
		const lines = r.call(child, width);
		return Array.isArray(lines) ? lines.length : 1;
	} catch {
		return 1;
	}
}

/** Strip ANSI/OSC escape sequences, then check if what remains is only
 * whitespace. pi's HIDDEN-thinking path renders a Text of the (empty) hidden
 * label wrapped in italic+colour escapes plus right-padding — 1 physical line
 * that is VISUALLY blank (ticket 34: the real leak). childRowCount counts it as
 * 1, so it must be classified blank here or its bordering spacers look live. */
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;]*[A-Za-z]/g;
function lineIsBlank(line: string): boolean {
	return line.replace(ANSI_OSC, "").trim() === "";
}

/** Count only VISUALLY non-blank rows a child renders (ANSI/whitespace stripped).
 * A child that renders zero rows, or only blank/escape-padded rows (suppressed or
 * hidden-label thinking), returns 0 — the signal that it and its bordering
 * spacers are dead. On render fault, fail safe toward 1 (keep pi's output). */
export function visibleRowCount(child: unknown, width: number): number {
	const r = (child as RenderableChild)?.render;
	if (typeof r !== "function") return 1;
	try {
		const lines = r.call(child, width);
		if (!Array.isArray(lines)) return 1;
		return lines.filter((ln) => !lineIsBlank(String(ln))).length;
	} catch {
		return 1;
	}
}

/**
 * Given a `contentContainer`'s children (post-updateContent), return the subset
 * to REMOVE so that a thinking run we suppressed to zero rows contributes zero
 * total rows INCLUDING its bordering `Spacer(1)`s — while a real text paragraph
 * keeps exactly the single leading margin pi would give it if the thinking were
 * absent (ticket 33). Pure and render-measured, so it matches what actually
 * rendered rather than message content types.
 *
 * Rule (verified against the real component for [think,text], [think,tool],
 * [think,tool,think,text] and the 7-message workflow shape):
 *   1. A `Spacer` is DEAD when it has no visible (≥1-row, non-Spacer) neighbor on
 *      at least one side — i.e. it borders a zero-row suppressed-thinking run or
 *      the container edge, so it is pure blank. Mark all such spacers.
 *   2. EXCEPTION — keep exactly ONE leading margin: if any visible non-Spacer
 *      block renders in this container, retain the FIRST dead spacer that
 *      precedes the first visible block (that is the paragraph's top margin pi
 *      would emit for a text-bearing message). If NO visible block renders
 *      (e.g. [think,tool]: only a zero-row thinking run remains), keep none.
 * Everything marked-and-not-retained is removed.
 */
export function suppressedThinkingSpacersToRemove(children: readonly unknown[], width: number, spacerClass?: Function): unknown[] {
	// VISIBLE rows, not physical rows: a hidden-label thinking Text renders 1
	// physical but visually-blank row (ticket 34), so it must classify as 0 or its
	// bordering spacers look live and survive.
	const visible = children.map((c) => visibleRowCount(c, width));
	const physical = children.map((c) => childRowCount(c, width));
	const isSpacer = children.map((c) => isLeadingSpacer(c, spacerClass));
	// A "visible block" is a non-Spacer child that renders at least one non-blank row.
	const isVisible = children.map((c, i) => !isSpacer[i] && visible[i] > 0);
	const firstVisible = isVisible.indexOf(true);
	const hasVisible = firstVisible !== -1;

	const dead: number[] = [];
	for (let i = 0; i < children.length; i++) {
		if (isSpacer[i]) {
			const prevVisible = i > 0 && isVisible[i - 1];
			const nextVisible = i < children.length - 1 && isVisible[i + 1];
			// Dead when it does NOT sit strictly between two visible blocks.
			if (!(prevVisible && nextVisible)) dead.push(i);
		} else if (physical[i] > 0 && visible[i] === 0) {
			// PHANTOM row (ticket 34): a non-Spacer child that renders ≥1 physical row
			// but is VISUALLY blank — pi's hidden-label thinking Text (empty label wrapped
			// in italic/colour escapes + right-padding). It eats a real screen line, so
			// remove it. A genuinely 0-physical-row suppressed thinking (dist transformer
			// case) is left alone: it already contributes nothing. A real text paragraph
			// has ≥1 visible row and is never marked.
			dead.push(i);
		}
	}

	// Keep one leading margin: the first dead spacer that precedes the first
	// visible block is the top margin a text paragraph relies on.
	const retain = new Set<number>();
	if (hasVisible) {
		for (const i of dead) {
			if (isSpacer[i] && i < firstVisible) {
				retain.add(i);
				break;
			}
		}
	}
	return dead.filter((i) => !retain.has(i)).map((i) => children[i]);
}

/**
 * Duck-type an AssistantMessageComponent instance WITHOUT importing the class for
 * identity (ticket 31): it exposes `updateContent`, holds a `contentContainer`
 * whose `children` is an array, and carries a thinking-block setter
 * (`setHiddenThinkingLabel`/`setHideThinkingBlock`) — a combination no other
 * component in the tree has.
 */
export function isAssistantMessageComponentLike(value: unknown): value is PatchTargetInstance {
	if (!value || typeof value !== "object") return false;
	const v = value as {
		updateContent?: unknown;
		contentContainer?: { children?: unknown };
		setHiddenThinkingLabel?: unknown;
		setHideThinkingBlock?: unknown;
	};
	if (typeof v.updateContent !== "function") return false;
	if (!v.contentContainer || typeof v.contentContainer !== "object") return false;
	if (!Array.isArray(v.contentContainer.children)) return false;
	return typeof v.setHiddenThinkingLabel === "function" || typeof v.setHideThinkingBlock === "function";
}

/**
 * Shared guarded walk over a live component tree: descend `children` arrays and
 * `getMountedRoots?.()`, cycle-guarded by a seen-set, never throwing into pi
 * (mid-switch renderers may briefly have no mounted roots). `visit` runs for
 * every non-array object node; returning true STOPS the walk (early exit for
 * single-instance searches). One walker instead of per-caller copies — the
 * copies had already drifted subtly (early-stop vs full walk), which is exactly
 * the divergence this prevents.
 */
export function walkTree(root: unknown, visit: (node: object) => boolean | undefined): void {
	const seen = new Set<unknown>();
	let stopped = false;
	const step = (value: unknown): void => {
		if (stopped || !value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const child of value) step(child);
			return;
		}
		if (visit(value) === true) {
			stopped = true;
			return;
		}
		const children = (value as { children?: unknown }).children;
		if (Array.isArray(children)) for (const child of children) step(child);
		try {
			const mounted = (value as { getMountedRoots?: () => unknown }).getMountedRoots?.();
			if (Array.isArray(mounted)) for (const r of mounted) step(r);
		} catch {
			// mid-switch renderer; ignore
		}
	};
	step(root);
}

/**
 * Every AssistantMessageComponent-like instance under `root`, in tree order.
 * Duck-typed identity, so it works against the bundle.
 */
export function findAssistantMessageComponents(root: unknown): PatchTargetInstance[] {
	const found: PatchTargetInstance[] = [];
	walkTree(root, (node) => {
		if (isAssistantMessageComponentLike(node)) found.push(node);
		return undefined;
	});
	return found;
}

/** Per-instance registry of hidden text-block indices. Keyed on the live
 * component instance (WeakMap: dies with it), consulted by the per-instance
 * updateContent wrapper below so hides survive FUTURE native re-renders. */
const hiddenBlockIndices = new WeakMap<object, Set<number>>();

/** Shallow-copy `message` with every registered hidden text block blanked.
 * Never mutates the passed message or its content array — it may be pi's own
 * stored object (the byte-identical-context constraint, tickets 22/26). */
function blankHiddenBlocks(instance: object, message: { content?: unknown }): { content?: unknown } {
	const set = hiddenBlockIndices.get(instance);
	const content = message?.content;
	if (!set || set.size === 0 || !Array.isArray(content)) return message;
	const blanked = content.slice();
	let changed = false;
	for (const i of set) {
		const block = blanked[i] as { type?: unknown; text?: unknown } | undefined;
		if (block?.type === "text" && typeof block.text === "string" && block.text !== "") {
			blanked[i] = { ...block, text: "" };
			changed = true;
		}
	}
	return changed ? { ...message, content: blanked } : message;
}

/**
 * Retroactively hide ONE text content block of a live AssistantMessageComponent
 * instance (ticket 41): rebuild the message through whatever updateContent is
 * CURRENTLY bound (original or spacer-patched) with `content[contentIndex]`'s
 * text blanked, so it renders zero rows exactly like a suppressed thinking run —
 * the ALREADY-INSTALLED spacer patch (if active) then strips its bordering
 * spacer for free, since its detection is structural (visible-row count), not
 * keyed to message type. Used when a text block that streamed natively turns out
 * to be narration (something followed it), not the final answer.
 *
 * The hide is PERSISTENT for the instance's lifetime (owner bug report: a
 * one-shot blank was resurrected the moment the SAME message kept streaming —
 * thinking or a second text block after the narration re-renders the full
 * original content). The index is registered in hiddenBlockIndices and a
 * per-instance updateContent wrapper (own property, shadows the prototype
 * method) blanks every registered block on EVERY future call, native or ours.
 * The wrapper resolves the prototype method at CALL time, so it composes with
 * the spacer patch regardless of installation order and never recurses (the
 * prototype call bypasses the own property).
 *
 * NEVER mutates `instance.lastMessage` or its `content` array in place — only a
 * shallow copy is passed to updateContent — so this is render-only and cannot
 * touch what pi persists or resends to the provider (the byte-identical-context
 * constraint, tickets 22/26). Returns false (no-op) when the instance, its
 * message, or the indexed block don't look right — fails open rather than
 * risking a wrong removal.
 */
export function hideMessageTextBlock(instance: PatchTargetInstance, contentIndex: number): boolean {
	const content = instance.lastMessage?.content;
	if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) return false;
	const block = content[contentIndex] as { type?: unknown; text?: unknown };
	if (!block || block.type !== "text" || typeof block.text !== "string") return false;
	if (typeof instance.updateContent !== "function") return false;

	let set = hiddenBlockIndices.get(instance);
	const firstHide = set === undefined;
	if (!set) {
		set = new Set();
		hiddenBlockIndices.set(instance, set);
	}
	set.add(contentIndex);

	if (firstHide) {
		try {
			(instance as { updateContent?: unknown }).updateContent = function (
				this: PatchTargetInstance,
				message: { content?: unknown },
				...rest: unknown[]
			) {
				const proto = Object.getPrototypeOf(this) as
					| { updateContent?: (message: { content?: unknown }, ...rest: unknown[]) => unknown }
					| null;
				const fn = proto?.updateContent;
				if (typeof fn !== "function") return undefined;
				return fn.call(this, blankHiddenBlocks(this, message), ...rest);
			};
		} catch {
			// Fail open: wrapper install failed — the immediate blank below still runs
			// (one-shot behavior), a later native update may resurrect the text.
		}
	}

	try {
		// Pass an already-blanked copy (not relying on the wrapper) so the immediate
		// hide works even when the wrapper install failed; when the wrapper IS
		// installed, re-blanking an already-blank block is a no-op.
		instance.updateContent(blankHiddenBlocks(instance, { ...instance.lastMessage }));
	} catch {
		return false; // fail open: native rendering stays exactly as it was
	}
	return true;
}

/**
 * Undo a hideMessageTextBlock (ticket 41 promotion): de-register the index so
 * the per-instance wrapper stops blanking it, then re-render with `text`
 * restored. The original text must be passed back in — pi's updateContent
 * stores the blanked copy as lastMessage, so the component itself no longer
 * has it (we do: the narration entry kept the full text). Render-only and
 * fail-open, same contract as the hide.
 */
export function restoreMessageTextBlock(instance: PatchTargetInstance, contentIndex: number, text: string): boolean {
	const content = instance.lastMessage?.content;
	if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) return false;
	const block = content[contentIndex] as { type?: unknown; text?: unknown };
	if (!block || block.type !== "text" || typeof block.text !== "string") return false;
	if (typeof instance.updateContent !== "function") return false;
	hiddenBlockIndices.get(instance)?.delete(contentIndex);
	const restored = content.slice();
	restored[contentIndex] = { ...block, text };
	try {
		instance.updateContent({ ...instance.lastMessage, content: restored });
	} catch {
		return false;
	}
	return true;
}

/**
 * Re-apply hideMessageTextBlock across an ENTIRE live tree, for every text
 * block whose trimmed content matches one of `texts` (ticket 41). Needed after
 * ANY full transcript rebuild — compaction, /resume, /fork — rebuilds every
 * AssistantMessageComponent from the ORIGINAL, un-blanked stored messages
 * (hideMessageTextBlock is render-only and never touches what's persisted, by
 * the byte-identical-context constraint), so a paragraph already folded into an
 * activity card would otherwise reappear natively the moment the tree is
 * rebuilt. Matches by TRIMMED TEXT, not object/instance identity, since every
 * identity is gone after a rebuild — the one accepted imprecision: a genuinely
 * unrelated block with byte-identical text to a past narration entry would also
 * be hidden. `texts` should be every narration entry's full text still known
 * (every live/persisted card, plus any not-yet-committed pending block) so
 * nothing is missed. Returns the number of blocks hidden.
 */
export function rehideNarrationAfterRebuild(root: unknown, texts: ReadonlySet<string>): number {
	if (texts.size === 0) return 0;
	let hidden = 0;
	for (const instance of findAssistantMessageComponents(root)) {
		const content = instance.lastMessage?.content;
		if (!Array.isArray(content)) continue;
		for (let i = 0; i < content.length; i++) {
			const block = content[i] as { type?: unknown; text?: unknown };
			if (block?.type !== "text" || typeof block.text !== "string") continue;
			if (!texts.has(block.text.trim())) continue;
			if (hideMessageTextBlock(instance, i)) hidden++;
		}
	}
	return hidden;
}

/** Width used to measure child heights when deciding which spacers are dead.
 * Height of a Spacer or a suppressed (blanked) thinking run does not depend on
 * width, and a real text paragraph renders ≥1 row at any sane width, so a fixed
 * probe width classifies visible-vs-zero reliably. */
const SPACER_PROBE_WIDTH = 80;

/**
 * Remove the dead blank spacers a render left around suppressed-thinking runs in
 * an instance's `contentContainer` (ticket 33). Generalizes the old
 * leading-only removal: strips leading AND trailing spacers bordering zero-row
 * thinking on ANY message shape ([thinking,text], [thinking,text,tool],
 * multi-run), while preserving the single paragraph margin real text needs
 * (suppressedThinkingSpacersToRemove). Safe: only Spacers are ever removed, and
 * only those measured as pure blank. Returns the number of spacers removed.
 */
export function stripSuppressedThinkingSpacers(instance: PatchTargetInstance, spacerClass?: Function): number {
	const container = instance?.contentContainer;
	const children = container?.children;
	if (!container || !Array.isArray(children) || children.length === 0) return 0;
	const toRemove = suppressedThinkingSpacersToRemove(children, SPACER_PROBE_WIDTH, spacerClass);
	for (const child of toRemove) container.removeChild(child);
	return toRemove.length;
}

export interface LeadingSpacerPatchDeps {
	/** The LIVE `AssistantMessageComponent.prototype` (from Object.getPrototypeOf
	 * of a real instance — NOT an imported class, ticket 31). */
	prototype: PatchTargetPrototype;
	/** Optional live pi-tui `Spacer` class for an exact `instanceof` check; when
	 * absent the leading child is duck-typed (isLeadingSpacer), which is
	 * bundle-safe. */
	spacerClass?: Function;
	/** Called at most once with a human-readable message when the patch fails open. */
	warn?: (message: string) => void;
}

/** Shared marker so a second install on the same prototype is a no-op, and so an
 * uninstall only restores when OUR wrapper is still installed (downstream-aware). */
const PATCH_MARKER = Symbol.for("pi-activity-feed.leadingSpacerPatch");

type MarkedPrototype = PatchTargetPrototype & { [PATCH_MARKER]?: LeadingSpacerPatch };

/**
 * Install the guarded leading-Spacer patch on a LIVE prototype (tickets 30 + 31).
 * Feature-detects the pi 0.85.1 `updateContent` shape and, on match, wraps it so a
 * message whose only visible raw content is suppressed thinking drops its leading
 * `Spacer(1)`. On any mismatch it fails open — returns `{ active: false, reason }`,
 * warns once, and leaves pi untouched. Idempotent and reversible.
 */
export function installLeadingSpacerPatch(deps: LeadingSpacerPatchDeps): LeadingSpacerPatch {
	const proto = deps.prototype as MarkedPrototype;

	const existing = proto[PATCH_MARKER];
	if (existing?.active) {
		return { active: true, reason: "already-patched", uninstall: existing.uninstall };
	}

	const original = proto.updateContent;
	if (typeof original !== "function") {
		deps.warn?.("activity-feed: AssistantMessageComponent.updateContent not found — leading-spacer patch inactive (fail open).");
		return { active: false, reason: "no-target", uninstall() {} };
	}
	if (!matchesLeadingSpacerShape(original.toString())) {
		deps.warn?.("activity-feed: AssistantMessageComponent.updateContent shape drifted — leading-spacer patch inactive (fail open); run the blank-probe drift canary.");
		return { active: false, reason: "shape-drift", uninstall() {} };
	}

	const spacerClass = deps.spacerClass;
	const patched = function (this: PatchTargetInstance, message: { content?: unknown }, ...rest: unknown[]): unknown {
		// Always let pi build the content tree first (unchanged behavior), then
		// remove the dead blank spacers bordering any thinking run we suppressed —
		// leading AND trailing, on any message shape (ticket 33), while keeping the
		// single paragraph margin real text needs.
		const result = original.apply(this, [message, ...rest]);
		if (!patch.active) return result;
		try {
			stripSuppressedThinkingSpacers(this, spacerClass);
		} catch {
			// A patch fault must never break message rendering — the original already ran.
		}
		return result;
	};

	const patch: LeadingSpacerPatch = {
		active: true,
		uninstall() {
			if (!patch.active) return;
			patch.active = false;
			// Restore only if our wrapper is still the installed method (a later
			// downstream patch, if any, keeps its own wrapper — like pi-cc-extensions).
			if (proto.updateContent === patched) proto.updateContent = original;
			if (proto[PATCH_MARKER] === patch) delete proto[PATCH_MARKER];
		},
	};

	proto.updateContent = patched;
	proto[PATCH_MARKER] = patch;
	return patch;
}

/** Result of acquiring + installing the patch from a live root (ticket 31). */
export interface AcquireLeadingSpacerResult {
	patch: LeadingSpacerPatch;
	/** The last live AssistantMessageComponent instance found (undefined when none
	 * exist yet — the caller should retry on later assistant activity). */
	instance?: PatchTargetInstance;
}

/**
 * Acquire a LIVE AssistantMessageComponent prototype from the running tree and
 * install the guarded leading-Spacer patch on it (ticket 31). Walks `root` (the
 * captured TUI handle), duck-types the instances, derives the pi-tui `Spacer`
 * class from a real leading child when present, installs on
 * `Object.getPrototypeOf(instance)`, and — on success — retroactively drops the
 * leading Spacer any pre-patch render already added to the found instances.
 *
 * Returns `{ patch: { active:false, reason:"no-instance" } }` (no `instance`) when
 * no component exists yet, so the caller can retry on the next assistant message
 * without treating it as a terminal fail-open.
 */
export function acquireLeadingSpacerPatch(deps: { root: unknown; warn?: (message: string) => void }): AcquireLeadingSpacerResult {
	const instances = findAssistantMessageComponents(deps.root);
	if (instances.length === 0) {
		return { patch: { active: false, reason: "no-instance", uninstall() {} } };
	}
	// All instances share the same prototype; take it from the newest (last-added,
	// i.e. the streaming component) so the fingerprint check runs against the live
	// method the CLI actually invokes.
	const instance = instances[instances.length - 1];
	const proto = Object.getPrototypeOf(instance) as PatchTargetPrototype;
	const spacerClass = deriveSpacerClass(instances);
	const patch = installLeadingSpacerPatch({ prototype: proto, spacerClass, warn: deps.warn });
	if (patch.active) {
		// Messages already rendered pre-patch keep the dead spacers their first
		// updateContent added; strip them now across ALL existing components so
		// nothing finalized during the `pending` window leaks (ticket 33 part 4).
		// (Subsequent updateContent calls run through the patched method already.)
		for (const inst of instances) {
			try {
				stripSuppressedThinkingSpacers(inst, spacerClass);
			} catch {
				// Never let retroactive cleanup break acquisition.
			}
		}
	}
	return { patch, instance };
}

/** Derive the live pi-tui `Spacer` constructor from a real leading child, so the
 * wrapper's `instanceof` fast-path uses the class the bundle actually constructs
 * (ticket 31 — obtain the Spacer class the same live way). Falls back to
 * undefined (duck-typing then covers it). */
function deriveSpacerClass(instances: readonly PatchTargetInstance[]): Function | undefined {
	for (const inst of instances) {
		const children = inst.contentContainer?.children;
		if (Array.isArray(children) && children.length > 0 && isLeadingSpacer(children[0])) {
			const ctor = (children[0] as { constructor?: unknown }).constructor;
			if (typeof ctor === "function") return ctor;
		}
	}
	return undefined;
}

// ── Debug instrumentation (ticket 34) ──────────────────────────────────────────
// Env-gated, dormant by default. When PI_ACTIVITY_DEBUG=1, dumpTranscriptTree
// walks the live chat tree from the captured TUI handle and appends, to
// PI_ACTIVITY_DEBUG_LOG (default /tmp/activity-feed-debug.log), every top-level
// child with its constructor name + rendered line count at the given width, and
// for AssistantMessageComponent-like children their contentContainer children
// too. This measures the REAL bundle components in a live session, ending the
// probe(dist)-vs-bundle guessing (tickets 30-33).
function ctorName(v: unknown): string {
	const c = (v as { constructor?: { name?: string } })?.constructor;
	return (c && typeof c.name === "string" && c.name) || typeof v;
}
function safeRowCount(v: unknown, width: number): number {
	return childRowCount(v, width);
}
export function dumpTranscriptTree(root: unknown, width: number, label: string): string {
	const out: string[] = [`\n=== ${label} (width=${width}) @ ${new Date().toISOString()} ===`];
	// Find the chatContainer: the ancestor array holding assistant components.
	// Simplest robust approach — walk from root, and whenever we hit a container
	// whose children include an AssistantMessageComponent-like or a custom entry,
	// dump that container's direct children in order.
	const seen = new Set<unknown>();
	const dumpContainer = (children: unknown[], tag: string) => {
		out.push(`-- ${tag}: ${children.length} children --`);
		children.forEach((c, i) => {
			const name = ctorName(c);
			const rows = safeRowCount(c, width);
			out.push(`  [${i}] ${name} rows=${rows}`);
			const inner = (c as { contentContainer?: { children?: unknown[] } })?.contentContainer?.children;
			if (Array.isArray(inner)) {
				inner.forEach((ic, j) => {
					out.push(`       (${j}) ${ctorName(ic)} rows=${safeRowCount(ic, width)} vis=${visibleRowCount(ic, width)}`);
				});
			}
		});
	};
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const c of value) visit(c);
			return;
		}
		const children = (value as { children?: unknown }).children;
		if (Array.isArray(children)) {
			const hasInteresting = children.some(
				(c) => isAssistantMessageComponentLike(c) || /CustomEntry|Activity/i.test(ctorName(c)),
			);
			if (hasInteresting) dumpContainer(children, ctorName(value));
			for (const c of children) visit(c);
		}
		try {
			const mounted = (value as { getMountedRoots?: () => unknown }).getMountedRoots?.();
			if (Array.isArray(mounted)) for (const r of mounted) visit(r);
		} catch {
			// ignore mid-switch
		}
	};
	visit(root);
	return out.join("\n");
}

// ── Universal tool-row absorption patch (owner issue: MCP / extension tool rows
// render natively outside the card) ─────────────────────────────────────────────
//
// EVERY tool's native row — built-in, MCP-adapter, cursor-sdk, web-search,
// anything any extension registered — renders through pi's
// ToolExecutionComponent with its owner's renderers. Re-registering tools to
// override rendering is off the table (owner decision: it blocked
// pi-cursor-sdk's native tool replay and hard-conflicted with other display
// extensions). Instead: one guarded patch on the LIVE
// ToolExecutionComponent prototype (acquired from a real instance, so it works
// against the minified bundle exactly like the AMC spacer patch) that renders
// ZERO rows for any toolCallId the feed has absorbed. pi adds these components
// without surrounding spacers and its own `hideComponent` path already returns
// [] the same way, so an empty render collapses cleanly.

/** Duck-type for a live ToolExecutionComponent instance (bundle-safe). */
export function isToolExecutionComponentLike(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const v = value as {
		toolCallId?: unknown;
		toolName?: unknown;
		render?: unknown;
		updateResult?: unknown;
		markExecutionStarted?: unknown;
	};
	return (
		typeof v.toolCallId === "string" &&
		typeof v.toolName === "string" &&
		typeof v.render === "function" &&
		typeof v.updateResult === "function" &&
		typeof v.markExecutionStarted === "function"
	);
}

/** Marker so the render patch installs exactly once per prototype. */
const TOOL_ROW_PATCH_MARKER = "__activityFeedToolRowPatch";

/** Prototype slot holding the CURRENT isAbsorbed callback. The patched render
 * reads it at call time, and install() always rewrites it — so a /reload's
 * fresh runtime (new absorbed set, new closure) REBINDS the existing patch
 * instead of leaving it pointing at the dead runtime's set (which would let
 * every post-reload tool row render natively again). */
const TOOL_ROW_PATCH_CALLBACK = "__activityFeedToolRowPatchCb";

/**
 * Patch `proto.render` so any instance whose toolCallId `isAbsorbed` renders
 * zero rows. `isAbsorbed` is a callback (not a snapshot) reading the shared
 * absorbed set — one source of truth for every tool; ids are added at
 * tool_execution_start, so a row never paints a frame.
 * Returns false (fail open, native rows stay) when the prototype doesn't look
 * right. Render-only: never touches tool execution, results, or stored data.
 */
export function installToolRowHidePatch(proto: object, isAbsorbed: (toolCallId: string) => boolean): boolean {
	const p = proto as {
		render?: unknown;
		[TOOL_ROW_PATCH_MARKER]?: unknown;
		[TOOL_ROW_PATCH_CALLBACK]?: unknown;
	};
	try {
		// ALWAYS (re)bind the callback — this is what keeps the patch alive across
		// /reload (the patched render below reads it per call, never a closure).
		Object.defineProperty(p, TOOL_ROW_PATCH_CALLBACK, {
			value: isAbsorbed,
			enumerable: false,
			configurable: true,
			writable: true,
		});
	} catch {
		return false;
	}
	if (p[TOOL_ROW_PATCH_MARKER]) return true; // render already patched; rebind above sufficed
	if (typeof p.render !== "function") return false;
	const original = p.render as (this: unknown, width: number) => string[];
	try {
		p.render = function (this: { toolCallId?: unknown }, width: number): string[] {
			const cb = p[TOOL_ROW_PATCH_CALLBACK];
			const id = this?.toolCallId;
			if (typeof cb === "function" && typeof id === "string" && cb(id)) return [];
			return original.call(this, width);
		};
		Object.defineProperty(p, TOOL_ROW_PATCH_MARKER, { value: true, enumerable: false, configurable: true });
	} catch {
		return false;
	}
	return true;
}

/**
 * Collect every live ToolExecutionComponent's toolCallId under `root`.
 * Used after a rebuild (/reload) so the fresh runtime can re-absorb
 * HISTORICAL tool rows — its absorbed set starts empty, and rebinding the
 * render patch to it would otherwise let every pre-reload row render natively
 * again. The card is the only intended view of tool activity, so absorbing
 * everything found is the invariant, not a heuristic.
 */
export function collectToolExecutionIds(root: unknown): string[] {
	const ids: string[] = [];
	walkTree(root, (node) => {
		if (isToolExecutionComponentLike(node)) ids.push((node as { toolCallId: string }).toolCallId);
		return undefined;
	});
	return ids;
}

export interface ToolRowPatchResult {
	installed: boolean;
	/** Why acquisition/install did not happen (undefined when installed). */
	reason?: string;
}

/**
 * Find a live ToolExecutionComponent under `root` and patch its prototype.
 * Call repeatedly (idempotent, cheap once installed) — the first tool of a
 * session may not be mounted yet when the extension's handler runs.
 */
export function acquireToolRowHidePatch(root: unknown, isAbsorbed: (toolCallId: string) => boolean): ToolRowPatchResult {
	let instance: object | undefined;
	walkTree(root, (node) => {
		if (isToolExecutionComponentLike(node)) {
			instance = node;
			return true; // early exit: one instance is enough to reach the prototype
		}
		return undefined;
	});
	if (!instance) return { installed: false, reason: "no live ToolExecutionComponent found yet" };
	const proto = Object.getPrototypeOf(instance) as object | null;
	if (!proto) return { installed: false, reason: "instance has no prototype" };
	if (!installToolRowHidePatch(proto, isAbsorbed)) return { installed: false, reason: "prototype.render not patchable" };
	return { installed: true };
}

// ── Tool-mount hook (owner issue: a native tool row flashes for a moment before
// absorption) ───────────────────────────────────────────────────────────────────
//
// Even with absorption at tool_execution_start, two windows let a frame paint:
// pi's UI handler may mount + schedule a render before our event handler runs,
// and the FIRST tool of a fresh session has no live instance to acquire the
// render patch from until it already exists (and possibly painted). Hooking the
// bundle's Container.prototype.addChild closes both: the moment ANY container
// mounts a ToolExecutionComponent-like child — strictly before its first
// render — the callback absorbs its id and installs/rebinds the render patch
// from that very instance. TuiBase extends Container and addChild is defined
// once on Container.prototype, so one wrap (acquired by walking the prototype
// chain of the live TUI handle) covers every mount in the app.

const TOOL_MOUNT_HOOK_MARKER = "__activityFeedToolMountHook";
const TOOL_MOUNT_HOOK_CB = "__activityFeedToolMountHookCb";

/**
 * Wrap the bundle's Container.prototype.addChild so `onMount(child)` fires for
 * every ToolExecutionComponent-like child the instant it is added to any
 * container (before its first render). The callback lives in a prototype slot
 * that install always rewrites, so a /reload's fresh runtime rebinds the
 * existing wrap (same pattern as the render patch). Fail-open at every step;
 * the wrap never throws into pi's mounting path.
 */
export function installToolMountHook(root: unknown, onMount: (instance: object) => void): boolean {
	let proto: object | null = root && typeof root === "object" ? Object.getPrototypeOf(root) : null;
	while (proto && !Object.prototype.hasOwnProperty.call(proto, "addChild")) proto = Object.getPrototypeOf(proto);
	if (!proto) return false;
	const p = proto as {
		addChild?: unknown;
		[TOOL_MOUNT_HOOK_MARKER]?: unknown;
		[TOOL_MOUNT_HOOK_CB]?: unknown;
	};
	try {
		Object.defineProperty(p, TOOL_MOUNT_HOOK_CB, {
			value: onMount,
			enumerable: false,
			configurable: true,
			writable: true,
		});
	} catch {
		return false;
	}
	if (p[TOOL_MOUNT_HOOK_MARKER]) return true; // wrapped already; rebind above sufficed
	if (typeof p.addChild !== "function") return false;
	const original = p.addChild as (this: unknown, child: unknown, ...rest: unknown[]) => unknown;
	try {
		p.addChild = function (this: unknown, child: unknown, ...rest: unknown[]): unknown {
			try {
				if (isToolExecutionComponentLike(child)) {
					const cb = p[TOOL_MOUNT_HOOK_CB];
					if (typeof cb === "function") (cb as (instance: object) => void)(child as object);
				}
			} catch {
				// Never break pi's mounting path.
			}
			return original.call(this, child, ...rest);
		};
		Object.defineProperty(p, TOOL_MOUNT_HOOK_MARKER, { value: true, enumerable: false, configurable: true });
	} catch {
		return false;
	}
	return true;
}

// ── Click-away modal close (owner request; moved here from index.ts so ALL
// runtime patches live under one guard contract) ────────────────────────────────
//
// pi-tui routes a click that misses every overlay past the overlay layer
// (hit:false) straight into the transcript — an open modal never sees it.
// Wrap the live TUI INSTANCE's dispatchMouseToOverlay (instance property only,
// no prototype touched): an outside click while the modal is open closes it and
// swallows the click so it cannot also toggle a row underneath. The callbacks
// live in instance slots that install always rewrites, so a /reload's fresh
// runtime rebinds the existing wrap (same pattern as the other patches).
// Fail-open: without the method, Esc/q keep working exactly as before.

const CLICK_AWAY_MARKER = "__activityFeedClickAway";
const CLICK_AWAY_CB = "__activityFeedClickAwayCb";

export interface ClickAwayDeps {
	isModalOpen(): boolean;
	closeModal(): void;
}

export function installClickAwayClosePatch(tuiHandle: unknown, deps: ClickAwayDeps): boolean {
	const tui = tuiHandle as {
		dispatchMouseToOverlay?: (event: unknown) => { hit: boolean } | undefined;
		requestRender?: () => void;
		[CLICK_AWAY_MARKER]?: unknown;
		[CLICK_AWAY_CB]?: unknown;
	} | undefined;
	if (!tui || typeof tui.dispatchMouseToOverlay !== "function") return false;
	try {
		Object.defineProperty(tui, CLICK_AWAY_CB, { value: deps, enumerable: false, configurable: true, writable: true });
	} catch {
		return false;
	}
	if (tui[CLICK_AWAY_MARKER]) return true; // wrapped already; rebind above sufficed
	const original = tui.dispatchMouseToOverlay.bind(tui);
	try {
		tui.dispatchMouseToOverlay = (event: unknown) => {
			const out = original(event);
			const type = (event as { type?: unknown } | undefined)?.type;
			const cb = tui[CLICK_AWAY_CB] as ClickAwayDeps | undefined;
			if (out && out.hit === false && type === "click" && cb?.isModalOpen()) {
				cb.closeModal();
				tui.requestRender?.();
				return { hit: true };
			}
			return out;
		};
		Object.defineProperty(tui, CLICK_AWAY_MARKER, { value: true, enumerable: false, configurable: true });
	} catch {
		return false;
	}
	return true;
}
