/**
 * Group-label heuristics for the activity feed — typed TypeScript port of
 * `prototypes/labels/heuristics.mjs` (ticket 05) with the two upgrades the
 * prototype report recommends (`prototypes/labels/report.md`):
 *
 *   1. A per-tool label map for self-describing custom / MCP tools, so tools
 *      that fall into the generic `tools` bucket render an informative label
 *      ("Read Linear issue NV-8634", "Used Cursor") instead of "Used <name>".
 *   2. Unwrapping leading `cd …`, `export …`, `pushd …`, `source …` prefixes
 *      from bash commands, so a wrapped command ("cd app && pnpm build") labels
 *      the real program ("Ran pnpm") instead of the wrapper ("Ran cd").
 *
 * All functions are pure: same input → same output, no side effects.
 *
 * Ticket-02 bucket rules (see .scratch/activity-feed/issues/02-grouping-semantics.md):
 *   files    = read | edit | write
 *   searches = grep | find | ls
 *   commands = bash | powershell
 *   tools    = everything else (MCP / custom)
 *   Live counter:  "Exploring · N files, M searches, K commands, T tools"
 *                  only nonzero buckets, order files > searches > commands > tools.
 *   Settled label: past-tense verb phrase per bucket present, joined ", ",
 *                  first letter capitalized ("Read files, ran commands").
 *   Single-member group: names its target ("Read package.json").
 */

export type Bucket = "files" | "searches" | "commands" | "tools";

export interface ToolCallLike {
	name: string;
	arguments?: Record<string, unknown>;
}

const BUCKET_OF: Record<string, Bucket> = {
	read: "files",
	edit: "files",
	write: "files",
	grep: "searches",
	find: "searches",
	ls: "searches",
	bash: "commands",
	powershell: "commands",
};

// Bucket display order (also the order used in both outputs).
const BUCKET_ORDER: Bucket[] = ["files", "searches", "commands", "tools"];

// Live-counter noun per bucket, with singular/plural forms.
const LIVE_NOUN: Record<Bucket, [string, string]> = {
	files: ["file", "files"],
	searches: ["search", "searches"],
	commands: ["command", "commands"],
	tools: ["tool", "tools"],
};

// Settled-label verb phrase per bucket (plural / multi-member form).
const SETTLED_PHRASE: Record<Bucket, string> = {
	files: "read files",
	searches: "searched",
	commands: "ran commands",
	tools: "used tools",
};

export function bucketOf(name: string | undefined): Bucket {
	return (name && BUCKET_OF[name]) || "tools";
}

function countBuckets(calls: ToolCallLike[]): Record<Bucket, number> {
	const counts: Record<Bucket, number> = { files: 0, searches: 0, commands: 0, tools: 0 };
	for (const call of calls) counts[bucketOf(call?.name)]++;
	return counts;
}

function capitalizeFirst(text: string): string {
	return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function basename(p: unknown): string {
	if (typeof p !== "string" || p.length === 0) return "";
	const trimmed = p.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/);
	return parts[parts.length - 1] || trimmed;
}

// ── Upgrade 2: unwrap cd/export/pushd/source prefixes ─────────────────────────
// Strip leading wrapper segments ("cd app &&", "export X=Y;", "pushd d &&",
// "source env;") so the real program is labelled. Bare "cd app" (no follow-on
// command) is left intact — it genuinely is a cd.
function stripCommandWrappers(command: string): string {
	let cmd = command.trim();
	// Repeatedly remove a leading wrapper followed by a && / ; / || separator.
	// Word wrappers use \b; the bare-`.` source shorthand uses a whitespace
	// lookahead instead, since \b never matches between `.` and a following space.
	const wrapper = /^(?:(?:cd|pushd|popd|export|source)\b|\.(?=\s))[^&;|\n]*?\s*(?:&&|;|\|\||\n)\s*/;
	for (;;) {
		const next = cmd.replace(wrapper, "");
		if (next === cmd) break;
		cmd = next.trim();
	}
	return cmd;
}

// Max length of a member-row command label before end-truncation (ticket 17 /
// atlas "Row anatomy": long commands truncate with …).
const MAX_COMMAND_LABEL = 56;

// Concrete command target for a member row (ticket 17): the unwrapped command
// with collapsed whitespace, end-truncated with … — e.g. "git log --oneline -5",
// or "pnpm nx run-many --target=test --all --output-style=static > /tmp/…".
function commandTarget(command: unknown): string {
	if (typeof command !== "string") return "a command";
	const cmd = stripCommandWrappers(command).replace(/\s+/g, " ").trim();
	if (cmd.length === 0) return "a command";
	return cmd.length > MAX_COMMAND_LABEL ? `${cmd.slice(0, MAX_COMMAND_LABEL - 1)}…` : cmd;
}

// ── Upgrade 1: per-tool label map for self-describing custom / MCP tools ──────
// Keyed by exact tool name; each reads obvious self-describing args. Unknown
// tools fall through to family-prefix humanization, then "Used <name>".
const CUSTOM_TOOL_LABELS: Record<string, (args: Record<string, unknown>) => string> = {
	cursor: (a) => asString(a.activityTitle) ?? asString(a.activitySummary) ?? "Used Cursor",
	subagent: (a) => {
		const kind = asString(a.agentType) ?? asString(a.type);
		return kind ? `Ran ${kind} subagent` : "Ran subagent";
	},
	linear_get_issue: (a) => {
		const id = asString(a.id) ?? asString(a.issueId);
		return id ? `Read Linear issue ${id}` : "Read Linear issue";
	},
	linear_list_issues: () => "Listed Linear issues",
	linear_list_comments: () => "Listed Linear comments",
	linear_create_comment: () => "Commented on Linear issue",
	web_search: (a) => {
		const q = asString(a.query) ?? asString(a.q);
		return q ? `Searched the web for ${q}` : "Searched the web";
	},
	fetch_content: (a) => {
		const url = asString(a.url) ?? asString(a.uri);
		return url ? `Fetched ${url}` : "Fetched content";
	},
};

// Humanize a namespaced tool name within a known family, e.g.
// "linear_list_issues" → "Linear: list issues".
const TOOL_FAMILIES: { prefix: string; label: string }[] = [
	{ prefix: "linear_", label: "Linear" },
	{ prefix: "github_", label: "GitHub" },
	{ prefix: "herdr_", label: "Herdr" },
	{ prefix: "agent_browser", label: "Browser" },
];

function customToolLabel(name: string, args: Record<string, unknown>): string {
	const exact = CUSTOM_TOOL_LABELS[name];
	if (exact) return exact(args);
	for (const family of TOOL_FAMILIES) {
		if (name.startsWith(family.prefix)) {
			const rest = name.slice(family.prefix.length).replace(/_/g, " ").trim();
			return rest ? `${family.label}: ${rest}` : `Used ${family.label}`;
		}
	}
	return `Used ${name}`;
}

// Whether describeCall(call) resolves to a BARE generic fallback label
// ("Used Cursor" / "Used <family>" / "Used <name>") rather than a concrete,
// self-describing one. The itemized ledger appends an args gist only for these
// (ticket 07 / 37): structured signal, so a wording change to a concrete custom
// label can never silently flip the gist on/off. Mirrors describeCall's switch
// (its explicit file/search/command cases are never generic) and
// customToolLabel's own "Used …" branches for the default (tools-bucket) case.
export function describeCallIsGeneric(call: ToolCallLike): boolean {
	const name = call?.name;
	switch (name) {
		case "read":
		case "edit":
		case "write":
		case "grep":
		case "find":
		case "ls":
		case "bash":
		case "powershell":
			return false;
		default:
			return customToolLabel(name ?? "a tool", call?.arguments ?? {}).startsWith("Used ");
	}
}

// ── Single-member / per-row target label ──────────────────────────────────────
// Names the concrete target of one tool call. Used for single-member group
// labels and for every itemized-ledger row.
export function describeCall(call: ToolCallLike): string {
	const name = call?.name;
	const args = call?.arguments ?? {};
	switch (name) {
		case "read":
			return `Read ${basename(args.path) || "a file"}`;
		case "edit":
			return `Edited ${basename(args.path) || "a file"}`;
		case "write":
			return `Wrote ${basename(args.path) || "a file"}`;
		case "grep":
		case "find":
			return `Searched for ${asString(args.pattern) ?? "a pattern"}`;
		case "ls":
			return `Listed ${basename(args.path) || "."}`;
		case "bash":
		case "powershell":
			return `Ran ${commandTarget(args.command)}`;
		default:
			return customToolLabel(name ?? "a tool", args);
	}
}

// ── Short args gist for a custom / MCP tool row (name + gist + duration) ──────
// A compact one-line hint of what a generic tool was invoked with, for the
// itemized ledger. Returns "" when no obvious scalar arg is present.
export function argsGist(call: ToolCallLike): string {
	const args = call?.arguments ?? {};
	const preferred = ["query", "q", "id", "issueId", "url", "uri", "path", "name", "title", "activityTitle"];
	for (const key of preferred) {
		const value = asString(args[key]);
		if (value) return value.length > 48 ? `${value.slice(0, 47)}…` : value;
	}
	// Fall back to the first short scalar argument, if any.
	for (const [, value] of Object.entries(args)) {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			const text = String(value);
			if (text.length > 0 && text.length <= 48) return text;
		}
	}
	return "";
}

// ── Bucket count summary ────────────────────────────────────────────────────
// "N files, M searches, K commands, T tools" — nonzero buckets only, in display
// order. "" when there are no calls. Used for the live counter (below) and for a
// group's collapsed count suffix (ticket 12 req 2).
export function bucketCountsText(calls: ToolCallLike[]): string {
	const counts = countBuckets(calls);
	const parts: string[] = [];
	for (const bucket of BUCKET_ORDER) {
		const n = counts[bucket];
		if (n === 0) continue;
		const [one, many] = LIVE_NOUN[bucket];
		parts.push(`${n} ${n === 1 ? one : many}`);
	}
	return parts.join(", ");
}


// ── Settled label ──────────────────────────────────────────────────────────────
// Single member → named target. Otherwise past-tense verb phrases joined ", ".
export function settledLabel(calls: ToolCallLike[]): string {
	if (!Array.isArray(calls) || calls.length === 0) return "";
	if (calls.length === 1) return describeCall(calls[0]);

	const counts = countBuckets(calls);
	const phrases: string[] = [];
	for (const bucket of BUCKET_ORDER) {
		if (counts[bucket] > 0) phrases.push(SETTLED_PHRASE[bucket]);
	}
	return capitalizeFirst(phrases.join(", "));
}
