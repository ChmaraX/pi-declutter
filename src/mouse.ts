/**
 * Pure SGR mouse-packet parser.
 *
 * Regular mode does not route mouse events to components, so the extension turns
 * on SGR mouse reporting and parses the raw packets out of onTerminalInput
 * itself. SGR encoding is `ESC [ < code ; col ; row` followed by `M` (press) or
 * `m` (release), with 1-based coords. No TUI/pi-agent dependency, so it is
 * unit-testable with plain strings (test/mouse.test.ts).
 *
 * Fragmented packets must NOT leak into the editor: under DECSET 1003 a
 * fast-motion burst floods packets that can split at a read boundary, so a
 * chunk may end mid-packet (e.g. "…\x1b[<35;40;1" with no final M/m).
 * parseSgrMousePackets therefore consumes only the COMPLETE-packet prefix of a
 * chunk, returns any trailing incomplete "\x1b[<…" as a `residual` the caller
 * prepends to the next chunk (so the packet completes and is parsed there
 * instead of leaking), and returns the remaining non-mouse bytes as
 * `passthrough` for the editor. The residual is capped (SGR_RESIDUAL_MAX): a
 * would-be prefix that grows past the cap, or that turns out not to be a mouse
 * prefix at all, is released as passthrough rather than held or dropped.
 */

/** One parsed SGR mouse packet (press/release/motion). */
export interface MousePacket {
	code: number;
	col: number;
	row: number;
	final: "M" | "m";
}

/** Result of parsing one (residual-prepended) input chunk. */
export interface SgrMouseParse {
	/** Complete mouse packets consumed from the leading contiguous run. */
	packets: MousePacket[];
	/** Non-mouse bytes to forward to the editor (a keystroke that arrived in the
	 * same chunk, or a released residual that turned out non-mouse). "" when the
	 * whole chunk was mouse data. */
	passthrough: string;
	/** Trailing incomplete mouse-packet prefix to prepend to the next chunk so a
	 * boundary-split packet completes there instead of leaking. "" when none. */
	residual: string;
}

/** Max bytes held as an incomplete-packet residual. A real SGR packet prefix is
 * well under this (`\x1b[<` + three ≤4-digit fields ≈ 16 bytes); anything longer
 * is not a fragmented packet, so it is flushed to the editor instead of held. */
export const SGR_RESIDUAL_MAX = 32;

/** A complete SGR mouse packet. Global so parseSgrMousePackets can walk the run. */
const SGR_MOUSE_PACKET_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** A trailing INCOMPLETE mouse-packet prefix (no final M/m yet): any proper
 * prefix of a packet — `\x1b`, `\x1b[`, `\x1b[<`, or `\x1b[<` + digits/`;`. Kept
 * strict (requires the `<` past `\x1b[`) so ordinary CSI keys like `\x1b[A`
 * (arrow) or `\x1b[3~` (delete) are NOT mistaken for a fragment and held. */
const SGR_MOUSE_PREFIX_RE = /^\x1b(\[(<[\d;]*)?)?$/;

/**
 * Parse the leading complete-packet run of a chunk. Returns the parsed
 * packets, a trailing incomplete-packet `residual` to carry into the next
 * chunk, and any remaining non-mouse `passthrough` for the editor. Pure: the
 * caller owns the residual buffer across chunks.
 */
export function parseSgrMousePackets(data: string): SgrMouseParse {
	const packets: MousePacket[] = [];
	let offset = 0;
	SGR_MOUSE_PACKET_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = SGR_MOUSE_PACKET_RE.exec(data)) !== null) {
		// Only a CONTIGUOUS leading run of packets is consumed; the first gap ends
		// it (the remainder is non-mouse passthrough / an incomplete residual).
		if (match.index !== offset) break;
		offset = match.index + match[0].length;
		packets.push({
			code: Number(match[1]),
			col: Number(match[2]),
			row: Number(match[3]),
			final: match[4] as "M" | "m",
		});
	}
	const rest = data.slice(offset);
	// Hold a trailing incomplete mouse-packet prefix so a boundary-split packet
	// completes on the next chunk instead of leaking to the editor. Capped: a
	// prefix past SGR_RESIDUAL_MAX, or one that is not actually a mouse prefix, is
	// released as passthrough (flush/discard) rather than held or swallowed.
	if (rest.length > 0 && rest.length <= SGR_RESIDUAL_MAX && SGR_MOUSE_PREFIX_RE.test(rest)) {
		return { packets, passthrough: "", residual: rest };
	}
	return { packets, passthrough: rest, residual: "" };
}

/** Base button after stripping shift/meta/ctrl/motion bits (4/8/16/32). */
export function isSgrLeftButton(code: number): boolean {
	return (code & ~(4 | 8 | 16 | 32)) === 0;
}

/** Left-button press (final "M", not a motion report). */
export function isSgrLeftPress(packet: MousePacket): boolean {
	return packet.final === "M" && isSgrLeftButton(packet.code) && (packet.code & 32) === 0;
}

/** A motion report (any-motion 1003 sets bit 32). Covers both no-button hover
 * (code 35) and button-held drag motion — both update hover. */
export function isSgrMotion(packet: MousePacket): boolean {
	return (packet.code & 32) !== 0;
}
