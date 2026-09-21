// ModalController (ticket 38): owns the output/thought modal lifecycle — open,
// swap, copy, close, and teardown — extracted from the index.ts closure so the
// open→swap→close sequencing is unit-testable with a fake UI context.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CardEntry, CardModel, ShapeItem } from "./card-shape.ts";
import { itemModalContent, type ModalContent, thoughtModalContent } from "./modal.ts";

/** A live modal component the controller shows in the overlay. Kept as an
 * injected interface so the controller does not import the pi-tui-backed
 * modal-view (which keeps it unit-testable without the pi-tui runtime). */
export interface ModalComponent {
	setTerminalHeight(height: number): void;
	setTerminalWidth(width: number): void;
}

/** Minimal overlay handle: hide() closes the overlay (a swap or teardown). */
export interface ModalOverlayHandle {
	hide(): void;
}

const MODAL_COPY_STATUS_KEY = "activity-feed-modal-copy";
const MODAL_COPY_STATUS_MS = 1500;

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
		void ctx.ui
			.custom<void>(
				(_tui, theme, _kb, done) => {
					modal = this.deps.makeModal(content, theme, done, () => this.copyModal(content));
					return modal as never;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "80%",
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

	private copyModal(content: ModalContent): void {
		void this.deps.copyToClipboard(content.copyText).then(
			() => {
				try {
					this.deps.getUiCtx()?.ui.setStatus(MODAL_COPY_STATUS_KEY, "Copied to clipboard");
				} catch {
					// UI may be gone; the copy still happened.
				}
			},
			() => {
				/* clipboard may be unavailable; silent */
			},
		);
		if (this.modalCopyTimer) clearTimeout(this.modalCopyTimer);
		this.modalCopyTimer = setTimeout(() => {
			try {
				this.deps.getUiCtx()?.ui.setStatus(MODAL_COPY_STATUS_KEY, undefined);
			} catch {
				// ignore
			}
			this.modalCopyTimer = undefined;
		}, MODAL_COPY_STATUS_MS);
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
		this.showModal(thoughtModalContent(entry.thought));
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
