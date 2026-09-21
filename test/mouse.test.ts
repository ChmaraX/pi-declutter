/**
 * Headless tests for the pure SGR mouse-packet parser (tickets 09 + 24).
 *
 * Runs via Node's built-in TypeScript type-stripping (Node >= 23.6), no TUI:
 * `node --test test/mouse.test.ts`. These lock the reviewer-P1 residual-buffer
 * behaviour so a mouse packet split across a read boundary NEVER leaks into the
 * editor:
 *   - a packet split at every byte position is reassembled across chunks,
 *   - a complete+partial mix consumes the complete run and holds the partial,
 *   - a held residual that turns out non-mouse is passed through (not dropped),
 *   - an over-cap would-be prefix is flushed as passthrough, not held,
 *   - trailing non-mouse bytes in a mouse chunk are returned as passthrough,
 *   - the button/motion classifiers still recognize left-press and motion.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	isSgrLeftPress,
	isSgrMotion,
	type MousePacket,
	parseSgrMousePackets,
	SGR_RESIDUAL_MAX,
} from "../src/mouse.ts";

/** Feed a sequence of chunks through the residual buffer the way handleTerminalInput
 * does, returning every parsed packet, every non-empty passthrough, and the final
 * residual left held. */
function feed(chunks: readonly string[]): { packets: MousePacket[]; passthroughs: string[]; residual: string } {
	let residual = "";
	const packets: MousePacket[] = [];
	const passthroughs: string[] = [];
	for (const chunk of chunks) {
		const parsed = parseSgrMousePackets(residual + chunk);
		residual = parsed.residual;
		packets.push(...parsed.packets);
		if (parsed.passthrough) passthroughs.push(parsed.passthrough);
	}
	return { packets, passthroughs, residual };
}

// ── Whole-chunk packets (no fragmentation) ──────────────────────────────────────

test("a chunk that is entirely one packet parses it with no residual/passthrough", () => {
	const parsed = parseSgrMousePackets("\x1b[<0;5;9M");
	assert.equal(parsed.packets.length, 1);
	assert.deepEqual(parsed.packets[0], { code: 0, col: 5, row: 9, final: "M" });
	assert.equal(parsed.passthrough, "");
	assert.equal(parsed.residual, "");
});

test("a run of back-to-back packets is fully consumed", () => {
	const parsed = parseSgrMousePackets("\x1b[<35;10;5M\x1b[<35;11;5M\x1b[<0;11;5m");
	assert.equal(parsed.packets.length, 3);
	assert.equal(parsed.packets[2].final, "m");
	assert.equal(parsed.passthrough, "");
	assert.equal(parsed.residual, "");
});

test("plain (non-mouse) input passes through unchanged, nothing held", () => {
	const parsed = parseSgrMousePackets("hello");
	assert.deepEqual(parsed.packets, []);
	assert.equal(parsed.passthrough, "hello");
	assert.equal(parsed.residual, "");
});

// ── Reviewer P1: fragmentation at a read boundary ───────────────────────────────

test("split at EVERY boundary position of a packet reassembles across two chunks", () => {
	const packet = "\x1b[<35;40;12M"; // code 35, col 40, row 12, press
	for (let i = 1; i < packet.length; i++) {
		const chunks = [packet.slice(0, i), packet.slice(i)];
		const { packets, passthroughs, residual } = feed(chunks);
		assert.equal(packets.length, 1, `split at ${i}: expected exactly one packet`);
		assert.deepEqual(packets[0], { code: 35, col: 40, row: 12, final: "M" }, `split at ${i}`);
		assert.deepEqual(passthroughs, [], `split at ${i}: nothing should leak`);
		assert.equal(residual, "", `split at ${i}: residual drained`);
	}
});

test("complete packets + a trailing partial: consume the run, hold the partial", () => {
	const parsed = parseSgrMousePackets("\x1b[<35;10;5M\x1b[<35;11;5M\x1b[<35;12;");
	assert.equal(parsed.packets.length, 2);
	assert.equal(parsed.passthrough, "");
	assert.equal(parsed.residual, "\x1b[<35;12;");
	// The completion of the held partial parses on the next chunk (nothing leaked).
	const next = parseSgrMousePackets(parsed.residual + "5M");
	assert.equal(next.packets.length, 1);
	assert.deepEqual(next.packets[0], { code: 35, col: 12, row: 5, final: "M" });
	assert.equal(next.residual, "");
	assert.equal(next.passthrough, "");
});

test("a trailing keystroke in the same chunk is returned as passthrough after the packet", () => {
	const parsed = parseSgrMousePackets("\x1b[<0;5;5Mq");
	assert.equal(parsed.packets.length, 1);
	assert.equal(parsed.passthrough, "q");
	assert.equal(parsed.residual, "");
});

// ── Reviewer P1: a held residual that turns out NON-mouse must pass through ──────

test("a residual that completes into a non-mouse escape (arrow key) is passed through", () => {
	// Chunk ends exactly on "\x1b[" (a valid prefix, optimistically held) …
	const first = parseSgrMousePackets("\x1b[");
	assert.deepEqual(first.packets, []);
	assert.equal(first.residual, "\x1b[");
	assert.equal(first.passthrough, "");
	// … then the next byte disambiguates it as CSI "A" (up arrow), NOT a mouse
	// packet: it must be released to the editor, not dropped or swallowed.
	const second = parseSgrMousePackets(first.residual + "A");
	assert.deepEqual(second.packets, []);
	assert.equal(second.residual, "");
	assert.equal(second.passthrough, "\x1b[A");
});

test("a bare CSI key (\\x1b[3~ delete) split at \\x1b[3 is not mistaken for a fragment", () => {
	// "\x1b[3" has digits but no leading "<", so it is not a mouse prefix: it is
	// released immediately as passthrough rather than held.
	const parsed = parseSgrMousePackets("\x1b[3");
	assert.deepEqual(parsed.packets, []);
	assert.equal(parsed.residual, "");
	assert.equal(parsed.passthrough, "\x1b[3");
});

// ── Reviewer P1: residual cap ───────────────────────────────────────────────────

test("a would-be prefix longer than the cap is flushed as passthrough, not held", () => {
	const overCap = `\x1b[<${"1;".repeat(20)}`; // matches the prefix shape but > cap
	assert.ok(overCap.length > SGR_RESIDUAL_MAX);
	const parsed = parseSgrMousePackets(overCap);
	assert.deepEqual(parsed.packets, []);
	assert.equal(parsed.residual, "");
	assert.equal(parsed.passthrough, overCap);
});

test("residual accumulation across chunks flushes once it passes the cap", () => {
	// Seed a valid, held prefix, then keep feeding digits without ever closing the
	// packet: held while small, released to passthrough once it exceeds the cap.
	let residual = "\x1b[<";
	let flushed = false;
	for (let i = 0; i < 40 && !flushed; i++) {
		const parsed = parseSgrMousePackets(residual + "1;");
		residual = parsed.residual;
		if (parsed.passthrough) flushed = true;
	}
	// It did not grow unbounded: the buffer was released rather than held forever.
	assert.ok(flushed);
	assert.ok(residual.length <= SGR_RESIDUAL_MAX);
});

// ── Button / motion classifiers (moved to ./mouse.ts) ───────────────────────────

test("isSgrLeftPress accepts a plain left press and rejects motion/release", () => {
	assert.equal(isSgrLeftPress({ code: 0, col: 1, row: 1, final: "M" }), true);
	assert.equal(isSgrLeftPress({ code: 0, col: 1, row: 1, final: "m" }), false); // release
	assert.equal(isSgrLeftPress({ code: 35, col: 1, row: 1, final: "M" }), false); // motion bit set
	// Shift/alt/ctrl-modified left press still counts as left.
	assert.equal(isSgrLeftPress({ code: 4, col: 1, row: 1, final: "M" }), true);
});

test("isSgrMotion is true exactly when the motion bit (32) is set", () => {
	assert.equal(isSgrMotion({ code: 35, col: 1, row: 1, final: "M" }), true); // 1003 hover
	assert.equal(isSgrMotion({ code: 32, col: 1, row: 1, final: "M" }), true); // drag motion
	assert.equal(isSgrMotion({ code: 0, col: 1, row: 1, final: "M" }), false); // press
});
