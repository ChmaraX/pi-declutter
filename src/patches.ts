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
 * True when a message's ONLY visible raw content is thinking — i.e. it has a
 * non-empty thinking block and NO non-empty text block. This mirrors pi's own
 * `hasVisibleContent` computation (`assistant-message.js:74-76`) split into its
 * two halves: for such a message the leading Spacer pi adds is a pure blank once
 * our transformer suppresses the thinking body, so it is safe to drop. A message
 * with visible text keeps its spacer (legitimate paragraph spacing).
 */
export function onlyVisibleThinking(content: readonly RawContentBlock[]): boolean {
	let hasThinking = false;
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
			hasText = true;
		} else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== "") {
			hasThinking = true;
		}
	}
	return hasThinking && !hasText;
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
	 * whatever updateContent is CURRENTLY bound \u2014 original or patched \u2014 so a
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
 * Walk the live component tree from `root` (the captured TUI handle) and return
 * every AssistantMessageComponent-like instance, in tree order. Mirrors
 * pi-cc-extensions' component walk: descend `value.children` and
 * `value.getMountedRoots?.()`, guarding cycles with a `seen` set. Pure and
 * dependency-free — identity is duck-typed, so it works against the bundle.
 */
export function findAssistantMessageComponents(root: unknown): PatchTargetInstance[] {
	const found: PatchTargetInstance[] = [];
	const seen = new Set<unknown>();
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const child of value) visit(child);
			return;
		}
		if (isAssistantMessageComponentLike(value)) found.push(value);
		const children = (value as { children?: unknown }).children;
		if (Array.isArray(children)) {
			for (const child of children) visit(child);
		}
		try {
			const mounted = (value as { getMountedRoots?: () => unknown }).getMountedRoots?.();
			if (Array.isArray(mounted)) {
				for (const r of mounted) visit(r);
			}
		} catch {
			// A renderer mid-switch may briefly have no mounted roots; ignore.
		}
	};
	visit(root);
	return found;
}

/**
 * Retroactively hide ONE text content block of a live AssistantMessageComponent
 * instance (ticket 41): rebuild the message through whatever updateContent is
 * CURRENTLY bound (original or spacer-patched) with `content[contentIndex]`'s
 * text blanked, so it renders zero rows exactly like a suppressed thinking run \u2014
 * the ALREADY-INSTALLED spacer patch (if active) then strips its bordering
 * spacer for free, since its detection is structural (visible-row count), not
 * keyed to message type. Used when a text block that streamed natively turns out
 * to be narration (something followed it), not the final answer \u2014 which is why
 * this call must happen promptly, while the block is still likely in-viewport
 * (same safety reasoning as absorbing tool rows at turn_end, ticket 08).
 *
 * NEVER mutates `instance.lastMessage` or its `content` array in place \u2014 only a
 * shallow copy is passed to updateContent \u2014 so this is render-only and cannot
 * touch what pi persists or resends to the provider (the byte-identical-context
 * constraint, tickets 22/26). Returns false (no-op) when the instance, its
 * message, or the indexed block don't look right \u2014 fails open rather than
 * risking a wrong removal.
 */
export function hideMessageTextBlock(instance: PatchTargetInstance, contentIndex: number): boolean {
	const content = instance.lastMessage?.content;
	if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) return false;
	const block = content[contentIndex] as { type?: unknown; text?: unknown };
	if (!block || block.type !== "text" || typeof block.text !== "string") return false;
	if (typeof instance.updateContent !== "function") return false;
	const blanked = content.slice();
	blanked[contentIndex] = { ...block, text: "" };
	try {
		instance.updateContent({ ...instance.lastMessage, content: blanked });
	} catch {
		return false; // fail open: native rendering stays exactly as it was
	}
	return true;
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
