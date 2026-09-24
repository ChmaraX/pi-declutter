// ModalController (ticket 38): owns the output/thought modal lifecycle — open,
// swap, copy, close, and teardown — extracted from the index.ts closure so the
// open→swap→close sequencing is unit-testable with a fake UI context.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CardEntry, CardModel, ShapeItem } from "./card-shape.ts";
import { itemModalContent, type ModalContent, narrationModalContent, thoughtModalContent } from "./modal.ts";

/** A live modal component the controller shows in the overlay. Kept as an
 * injected interface so the controller does not import the pi-tui-backed
 * modal-view (which keeps it unit-testable without the pi-tui runtime). */
export interface ModalComponent {
	setTerminalHeight(height: number): void;
	setTerminalWidth(width: number): void;
	/** Show the in-modal "\u2713 Copied" footer feedback (owner request: contained
	 * to the floating pane, not pi's status bar). */
	showCopied(): void;
	clearCopied(): void;
}

/** Minimal overlay handle: hide() closes the overlay (a swap or teardown). */
export interface ModalOverlayHandle {
	hide(): void;
}

/** How long the in-modal "\u2713 Copied" footer feedback stays visible. */
const MODAL_COPY_FEEDBACK_MS = 1500;

/** Widest the modal ever gets, in columns \u2014 on wide terminals a full-width
 * floating pane reads poorly (owner request: smaller max width). */
const MODAL_MAX_WIDTH_COLS = 100;

export interface ModalControllerDeps {
	/** The live UI context, or undefined outside a live TUI. */
	getUiCtx(): ExtensionContext | undefined;
	hasLiveUI(ctx: ExtensionContext): boolean;
	/** The card model addressed by a click, or undefined if gone/stale. */
	getModel(cardId: string): CardModel | undefined;
	/** Read a member's full untruncated output for the modal (lazy file read). */
	readFullOutput(item: ShapeItem): string | undefined;
	/** Copy raw text to the clipboard (pi's supported helper). */
	copyToClipboard(text: string): Promise<void>;
	/** Repaint request so the in-modal copy feedback shows/clears promptly. */
	requestRender(): void;
	/** Build the overlay component (injected so the controller does not import the
	 * pi-tui-backed modal-view). `done` closes the overlay; `onCopy` copies. */
	makeModal(content: ModalContent, theme: unknown, done: (r: void) => void, onCopy: () => void): ModalComponent;
}

export class ModalController {
	private modalHandle: ModalOverlayHandle | undefined;
	private modalCopyTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly deps: ModalControllerDeps;

	constructor(deps: ModalControllerDeps) {
		this.deps = deps;
	}

	/** True while a modal overlay is open (test/inspection aid). */
	isOpen(): boolean {
		return this.modalHandle !== undefined;
	}

	closeModal(): void {
		if (!this.modalHandle) return;
		try {
			this.modalHandle.hide();
		} catch {
			// Overlay may already be gone; ignore.
		}
		this.modalHandle = undefined;
	}

	/** Look up the CardModel entry a node addresses, tolerant of a stale click after
	 * the card re-shaped (out-of-range → undefined). */
	private entryAt(cardId: string, entryIndex: number): CardEntry | undefined {
		const model = this.deps.getModel(cardId);
		return model?.entries[entryIndex];
	}

	showModal(content: ModalContent): void {
		const ctx = this.deps.getUiCtx();
		if (!ctx || !this.deps.hasLiveUI(ctx)) return;
		// Swap semantics: close any open modal before opening the next.
		this.closeModal();
		// custom() resolves when the overlay closes; we don't need the result. The
		// onHandle callback captures the handle so a later open can swap it, and
		// teardown can force-close it.
		// Capture the live modal so the overlay's `visible` callback can feed it the
		// current terminal height (review P2 #4). `visible` fires each render cycle.
		let modal: ModalComponent | undefined;
		// Width: 80% of the terminal but never wider than MODAL_MAX_WIDTH_COLS \u2014
		// computed at open (the overlay option is static; a mid-open resize still
		// reflows the body via render width).
		const cols = process.stdout.columns ?? 80;
		const modalWidth = Math.min(Math.max(40, Math.floor(cols * 0.8)), MODAL_MAX_WIDTH_COLS);
		void ctx.ui
			.custom<void>(
				(_tui, theme, _kb, done) => {
					modal = this.deps.makeModal(content, theme, done, () => this.copyModal(content, modal));
					return modal as never;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: modalWidth,
						maxHeight: "80%",
						visible: (termWidth, termHeight) => {
							modal?.setTerminalHeight(termHeight);
							modal?.setTerminalWidth(termWidth);
							return true;
						},
					},
					onHandle: (handle) => {
						this.modalHandle = handle;
					},
				},
			)
			.then(() => {
				// Resolves only when THIS overlay closes via done() (Esc / q / click-out) —
				// NOT on OverlayHandle.hide() used for a swap (interactive-mode only resolves
				// custom() on done, review P2 #5). So on a genuine close we clear the handle;
				// a swap path clears/repoints modalHandle itself in closeModal()/onHandle. A
				// swapped-away OutputModal (≤64KB) is retained until process exit — bounded and
				// user-paced, accepted as a known minor.
				this.modalHandle = undefined;
			});
	}

	private copyModal(content: ModalContent, modal: ModalComponent | undefined): void {
		void this.deps.copyToClipboard(content.copyText).then(
			() => {
				// Feedback lives INSIDE the modal footer (owner request), not pi's
				// status bar near the input.
				modal?.showCopied();
				this.deps.requestRender();
			},
			() => {
				/* clipboard may be unavailable; silent */
			},
		);
		if (this.modalCopyTimer) clearTimeout(this.modalCopyTimer);
		this.modalCopyTimer = setTimeout(() => {
			modal?.clearCopied();
			this.deps.requestRender();
			this.modalCopyTimer = undefined;
		}, MODAL_COPY_FEEDBACK_MS);
	}

	openMemberModal(cardId: string, entryIndex: number, itemIndex: number): void {
		const entry = this.entryAt(cardId, entryIndex);
		if (!entry || entry.kind !== "group") return;
		const item = entry.group.items[itemIndex];
		if (!item) return;
		const full = this.deps.readFullOutput(item);
		this.showModal(itemModalContent(item, full));
	}

	openThoughtModal(cardId: string, entryIndex: number): void {
		const entry = this.entryAt(cardId, entryIndex);
		if (!entry || entry.kind !== "thought") return;
		// Pass the raw untruncated span text (ticket 40) so the modal shows the full
		// reasoning, not the compact previewLines-capped `tail` (that stays the card
		// row's glance view). Mirrors the tool-row fullText pattern.
		this.showModal(thoughtModalContent(entry.thought, entry.thought.fullText));
	}

	openNarrationModal(cardId: string, entryIndex: number): void {
		const entry = this.entryAt(cardId, entryIndex);
		if (!entry || entry.kind !== "narration") return;
		this.showModal(narrationModalContent(entry.narration));
	}

	/** Force-close and clear the copy-status timer (called at session_shutdown). */
	teardown(): void {
		this.closeModal();
		if (this.modalCopyTimer) {
			clearTimeout(this.modalCopyTimer);
			this.modalCopyTimer = undefined;
		}
	}
}
