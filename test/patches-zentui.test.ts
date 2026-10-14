import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { acquireLeadingSpacerPatch, installLeadingSpacerPatch, installToolMountHook } from "../src/patches.ts";

const REGISTRY = Symbol.for("pi-zentui.prototype-patch-registry");
const ADAPTER = "thinking-experimental-update-content";
type Method = (this: unknown, ...args: unknown[]) => unknown;
type Target = { updateContent: Method; render?: Method; [REGISTRY]?: Map<string, unknown> };

// Mirror Zentui's public-symbol registry contract, including its method-identity
// ownership check. Replacing updateContent displaces the thinking renderer.
function installThinkingWrapper(target: object) {
	const proto = target as Target;
	const predecessor = proto.updateContent;
	let calls = 0;
	let displaced = false;
	const wrapper: Method = function zentuiPrototypeWrapper(...args) {
		calls++;
		if (proto.updateContent !== wrapper) displaced = true;
		return Reflect.apply(predecessor, this, args);
	};
	const record = { method: "updateContent", predecessor, wrapper };
	proto.updateContent = wrapper;
	proto[REGISTRY] = new Map([[ADAPTER, record]]);
	return {
		record,
		get calls() { return calls; },
		get displaced() { return displaced; },
		uninstall() {
			if (proto.updateContent === wrapper) proto.updateContent = predecessor;
			delete proto[REGISTRY];
		},
	};
}

function makeTarget() {
	class Spacer {
		lines: number;
		constructor(lines = 1) { this.lines = lines; }
		setLines(lines: number) { this.lines = lines; }
		render() { return Array.from({ length: this.lines }, () => ""); }
	}
	const container = {
		children: [] as { render(width: number): string[] }[],
		clear() { this.children = []; },
		addChild(child: { render(width: number): string[] }) { this.children.push(child); },
		removeChild(child: unknown) { this.children = this.children.filter((c) => c !== child); },
	};
	const proto = {
		setHiddenThinkingLabel() {},
		updateContent(this: { contentContainer: typeof container }, message: { content: { type: string }[] }) {
			this.contentContainer.clear();
			if (message.content.some((c) => c.type === "text" || c.type === "thinking")) {
				this.contentContainer.addChild(new Spacer(1));
			}
			this.contentContainer.addChild({ render: () => [] });
		},
		render(this: { contentContainer: typeof container }, width: number) {
			return this.contentContainer.children.flatMap((c) => c.render(width));
		},
	};
	const instance = Object.assign(Object.create(proto), { contentContainer: container });
	return { proto, instance, Spacer };
}

const THINKING = { content: [{ type: "thinking", thinking: "Planning" }, { type: "toolCall", id: "1", name: "read", arguments: {} }] };

test("native updateContent wrapper preserves opaque results, receiver, arguments and thrown values", (t) => {
	const { proto, instance, Spacer } = makeTarget();
	const result = { native: true };
	const failure = new Error("native update failed");
	const calls: unknown[][] = [];
	proto.updateContent = function (message, ...rest: unknown[]) {
		calls.push([this, message, ...rest]);
		this.contentContainer.clear();
		if (message.content.some((c) => c.type === "text" || c.type === "thinking")) {
			this.contentContainer.addChild(new Spacer(1));
		}
		if (rest[0] === "throw") throw failure;
		return result;
	};
	const patch = installLeadingSpacerPatch({ prototype: proto as never });
	t.after(() => patch.uninstall());
	assert.equal(patch.active, true);
	assert.equal(instance.updateContent(THINKING, "native argument", 42), result);
	assert.deepEqual(calls, [[instance, THINKING, "native argument", 42]]);
	assert.throws(() => instance.updateContent(THINKING, "throw"), (error) => error === failure);
});

test("native mount wrapper preserves opaque results even when the typed callback fails", () => {
	const result = { mounted: true };
	const failure = new Error("native mount failed");
	const calls: unknown[][] = [];
	const proto = {
		addChild(this: unknown, child: unknown, ...rest: unknown[]) {
			calls.push([this, child, ...rest]);
			if (rest[0] === "throw") throw failure;
			return result;
		},
	};
	const root = Object.create(proto) as typeof proto;
	const child = { toolCallId: "1", toolName: "read", render: () => [], updateResult() {}, markExecutionStarted() {} };
	const mounted: string[] = [];
	assert.equal(installToolMountHook(root, (instance) => {
		mounted.push(instance.toolCallId);
		assert.equal(instance, child);
		throw new Error("callback failed");
	}), true);
	assert.equal(root.addChild(child, "native argument", 42), result);
	assert.deepEqual(calls, [[root, child, "native argument", 42]]);
	assert.deepEqual(mounted, ["1"]);
	assert.throws(() => root.addChild(child, "throw"), (error) => error === failure);
	assert.equal(root.addChild({ toolCallId: "not a complete tool component" }), result);
	assert.deepEqual(mounted, ["1", "1"], "near-miss objects must not reach the typed callback");
});

test("Zentui: registered wrapper activates without displacing updateContent", (t) => {
	const { proto, instance } = makeTarget();
	const zentui = installThinkingWrapper(proto);
	const originalRender = proto.render;
	const warnings: string[] = [];
	const patch = installLeadingSpacerPatch({ prototype: proto as never, warn: (m) => warnings.push(m) });
	t.after(() => { patch.uninstall(); zentui.uninstall(); });
	assert.equal(patch.active, true);
	assert.deepEqual(warnings, []);
	assert.equal(proto.updateContent, zentui.record.wrapper);
	const second = installLeadingSpacerPatch({ prototype: proto as never });
	assert.equal(second.active, true);
	assert.equal(second.reason, "already-patched");
	for (let i = 0; i < 40; i++) {
		instance.updateContent(THINKING);
		assert.deepEqual(instance.render(80), []);
	}
	assert.equal(zentui.calls, 40);
	assert.equal(zentui.displaced, false);
	patch.uninstall();
	assert.equal(proto.render, originalRender);
	assert.equal(proto.updateContent, zentui.record.wrapper);
	instance.updateContent(THINKING);
	assert.deepEqual(instance.render(80), [""]);
});

test("Zentui: live acquisition cleans existing messages and future renders", (t) => {
	const { proto, instance } = makeTarget();
	const zentui = installThinkingWrapper(proto);
	instance.updateContent(THINKING);
	const { patch } = acquireLeadingSpacerPatch({ root: { children: [instance] } });
	t.after(() => { patch.uninstall(); zentui.uninstall(); });
	assert.equal(patch.active, true);
	assert.deepEqual(instance.render(80), []);
	instance.updateContent(THINKING);
	assert.deepEqual(instance.render(80), []);
	assert.equal(zentui.displaced, false);
});

test("Zentui: rejects missing, malformed, stale and drifted registry records", () => {
	for (const corrupt of [
		(proto: Target) => { delete proto[REGISTRY]; },
		(proto: Target) => { proto[REGISTRY] = {} as never; },
		(proto: Target) => { proto[REGISTRY]!.set(ADAPTER, null); },
		(proto: Target) => { Object.defineProperty(proto, REGISTRY, { configurable: true, get() { throw new Error("bad registry"); } }); },
		(proto: Target) => { proto[REGISTRY]!.set(ADAPTER, { get method() { throw new Error("bad record"); } }); },
		(_proto: Target, record: { method: string }) => { record.method = "render"; },
		(_proto: Target, record: { wrapper: Method }) => { record.wrapper = () => []; },
		(_proto: Target, record: { predecessor: Method }) => { record.predecessor = () => []; },
	]) {
		const { proto } = makeTarget();
		const zentui = installThinkingWrapper(proto);
		corrupt(proto as unknown as Target, zentui.record);
		const update = proto.updateContent;
		const render = proto.render;
		const warnings: string[] = [];
		const patch = installLeadingSpacerPatch({ prototype: proto as never, warn: (m) => warnings.push(m) });
		assert.equal(patch.active, false);
		assert.equal(patch.reason, "shape-drift");
		assert.equal(warnings.length, 1);
		assert.equal(proto.updateContent, update);
		assert.equal(proto.render, render);
		zentui.uninstall();
	}
});

test("Zentui: missing render target fails open", () => {
	const { proto } = makeTarget();
	const zentui = installThinkingWrapper(proto);
	delete (proto as unknown as Target).render;
	const patch = installLeadingSpacerPatch({ prototype: proto as never });
	assert.equal(patch.active, false);
	assert.equal(patch.reason, "shape-drift");
	zentui.uninstall();
});

test("Zentui: later unknown updateContent is left untouched at render time", (t) => {
	const { proto, instance } = makeTarget();
	const zentui = installThinkingWrapper(proto);
	const patch = installLeadingSpacerPatch({ prototype: proto as never });
	t.after(() => { patch.uninstall(); zentui.uninstall(); });
	assert.equal(patch.active, true);
	instance.updateContent(THINKING);
	const children = [...instance.contentContainer.children];
	proto.updateContent = function () {};
	assert.deepEqual(instance.render(80), [""]);
	assert.deepEqual(instance.contentContainer.children, children, "unknown renderer's actual Spacer must be left alone");
});

test("Zentui: cleanup preserves a downstream render wrapper and can uninstall first", (t) => {
	const { proto, instance } = makeTarget();
	const zentui = installThinkingWrapper(proto);
	const patch = installLeadingSpacerPatch({ prototype: proto as never });
	t.after(() => { patch.uninstall(); zentui.uninstall(); });
	assert.equal(patch.active, true);
	const patchedRender = proto.render;
	const downstream = proto.render = function (width) { return patchedRender.call(this, width); };
	zentui.uninstall();
	instance.updateContent(THINKING);
	assert.deepEqual(instance.render(80), []);
	patch.uninstall();
	assert.equal(proto.render, downstream);
	instance.updateContent(THINKING);
	assert.deepEqual(instance.render(80), [""]);
});

test("Zentui: guard and cleanup faults do not prevent native render", (t) => {
	const { proto, instance } = makeTarget();
	const zentui = installThinkingWrapper(proto);
	const patch = installLeadingSpacerPatch({ prototype: proto as never });
	t.after(() => { patch.uninstall(); zentui.uninstall(); });
	assert.equal(patch.active, true);
	instance.updateContent(THINKING);
	Object.defineProperty(proto.updateContent, "toString", { configurable: true, value() { throw new Error("bad guard"); } });
	assert.deepEqual(instance.render(80), [""]);
	delete (proto.updateContent as unknown as { toString?: unknown }).toString;
	instance.contentContainer.removeChild = () => { throw new Error("bad cleanup"); };
	assert.deepEqual(instance.render(80), [""]);
});

test("Zentui: original render return value, arguments, receiver and thrown errors are preserved", (t) => {
	const { proto, instance } = makeTarget();
	const result = ["native"];
	const failure = new Error("native failure");
	const calls: unknown[][] = [];
	proto.render = function (width) {
		calls.push([this, width]);
		if (width === 0) throw failure;
		return result;
	};
	const zentui = installThinkingWrapper(proto);
	const patch = installLeadingSpacerPatch({ prototype: proto as never });
	t.after(() => { patch.uninstall(); zentui.uninstall(); });
	assert.equal(patch.active, true);
	assert.equal(instance.render(42), result);
	assert.deepEqual(calls, [[instance, 42]]);
	assert.throws(() => instance.render(0), (error) => error === failure);
});

test("Zentui: real Pi renderer keeps thinking-only messages at zero rows and answer spacing intact", (t) => {
	initTheme("dark", false);
	const proto = AssistantMessageComponent.prototype;
	const zentui = installThinkingWrapper(proto);
	const patch = installLeadingSpacerPatch({ prototype: proto as never });
	t.after(() => { patch.uninstall(); zentui.uninstall(); });
	assert.equal(patch.active, true);
	const make = (content: unknown[]) => new AssistantMessageComponent(
		{ ...THINKING, content } as never, false, undefined, "", 1,
		[(text, ctx) => ctx.messageType === "assistant-thinking" ? "" : text],
	);
	const originalContent = structuredClone(THINKING.content);
	for (let i = 0; i < 40; i++) assert.deepEqual(make(THINKING.content).render(80), []);
	assert.deepEqual(THINKING.content, originalContent, "cleanup is render-only, never a transcript edit");
	const text = { type: "text", text: "Answer" };
	const plain = make([text]).render(80).map(stripVTControlCharacters);
	assert.deepEqual(make([THINKING.content[0], text]).render(80).map(stripVTControlCharacters), plain);
	assert.deepEqual(make([THINKING.content[0], THINKING.content[1], THINKING.content[0], text]).render(80).map(stripVTControlCharacters), plain);
	const visible = new AssistantMessageComponent(THINKING as never);
	assert.ok(visible.render(80).length > 0, "visible thinking must not be suppressed");
	assert.equal(zentui.displaced, false);
});
