// Tests for span-classify.ts (provider-stream normalization): thinking-channel
// tool dumps become tool steps; genuine reasoning stays reasoning.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyThinkingSpan, MAX_SPAN_TOOL_LABEL_LEN } from "../src/span-classify.ts";

test("Cursor shell dumps classify as bash-family tool steps with the first line as label", () => {
	const dump = "Cursor shell: cd /Users/x/projects/novu && npx biome lint apps/**\n$ cd /Users/x && npx biome lint\n\nChecked 8 files in 13ms.\n\nTook 19.3s";
	const cls = classifyThinkingSpan(dump);
	assert.equal(cls.kind, "tool");
	if (cls.kind === "tool") {
		assert.equal(cls.family, "bash");
		assert.ok(cls.label.startsWith("Cursor shell: cd /Users/x"));
	}
});

test("pseudo-shell '$ …' dumps (glob/grep through the $ prefix) classify as bash", () => {
	const cls = classifyThinkingSpan("$ glob **/biome.json* in /Users/x/projects/novu/apps\n\nNo files found matching pattern");
	assert.equal(cls.kind, "tool");
	if (cls.kind === "tool") assert.equal(cls.family, "bash");
});

test("read-with-path dumps classify as read-family; grep/glob dumps get their families", () => {
	const read = classifyThinkingSpan("read /Users/x/projects/novu/biome.json\n\n }\n}");
	assert.equal(read.kind, "tool");
	if (read.kind === "tool") assert.equal(read.family, "read");
	const grep = classifyThinkingSpan('grep "includes|enabled" /Users/x/biome.json\n\n../../biome.json');
	assert.equal(grep.kind, "tool");
	if (grep.kind === "tool") assert.equal(grep.family, "grep");
	const glob = classifyThinkingSpan("glob **/*.spec.ts\n\nfound 3");
	assert.equal(glob.kind, "tool");
	if (glob.kind === "tool") assert.equal(glob.family, "find");
});

test("genuine reasoning stays reasoning — even when it MENTIONS commands or starts with 'read the'", () => {
	for (const text of [
		"I want to check whether test files are covered by biome's linting, so I should look at biome.json.",
		"Let me check lines 417-450 to make sure nothing later re-enables the linter.",
		"read the file first, then decide", // prose 'read', no path arg
		"The command `$ ls` failed earlier — reconsidering.", // $ mid-prose, not first line shape
		"",
		"   \n  \n",
	]) {
		assert.equal(classifyThinkingSpan(text).kind, "reasoning", `misclassified: ${text.slice(0, 40)}`);
	}
});

test("a long dump first line is end-truncated to the label cap", () => {
	const cls = classifyThinkingSpan(`$ ${"x".repeat(300)}`);
	assert.equal(cls.kind, "tool");
	if (cls.kind === "tool") {
		assert.equal(cls.label.length, MAX_SPAN_TOOL_LABEL_LEN);
		assert.ok(cls.label.endsWith("…"));
	}
});

test("leading blank lines are skipped when finding the classifying first line", () => {
	const cls = classifyThinkingSpan("\n\n$ npm test\n\nok");
	assert.equal(cls.kind, "tool");
});
