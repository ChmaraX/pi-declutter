import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { acquireLeadingSpacerPatch, installLeadingSpacerPatch } from "../src/patches.ts";

const REGISTRY = Symbol.for("pi-zentui.prototype-patch-registry");
const ADAPTER = "thinking-experimental-update-content";
type Method = (this: unknown, ...args: unknown[]) => unknown;
type Target = { updateContent: Method; render?: Method; [REGISTRY]?: Map<string, unknown> };

// A Zentui-shaped fake of its public-symbol registry contract (pi-zentui 0.31):
// - replacing updateContent displaces the thinking renderer (method identity);
// - the wrapper calls the record's CURRENT predecessor, then matches pi's native
//   layout, where a thinking/text message starts with a Spacer. A changed layout
//   is Zentui's "renderer shape is incompatible", and it gives up.
function installThinkingWrapper(target: object) {
	const proto = target as Target;
	const predecessor = proto.updateContent;
	let calls = 0;
	let displaced = false;
	let shapeFailed = false;
	const record: { method: string; predecessor: Method; wrapper: Method } = { method: "updateContent", predecessor, wrapper: predecessor };
	const wrapper: Method = function zentuiPrototypeWrapper(this: unknown, ...args) {
		calls++;
		if (proto.updateContent !== wrapper) displaced = true;
		const result = Reflect.apply(record.predecessor, this, args);
		const content = (args[0] as { content?: { type: string }[] } | undefined)?.content ?? [];
		const first = (this as { contentContainer?: { children?: unknown[] } }).contentContainer?.children?.[0];
		const startsWithSpacer = (first as { constructor?: { name?: string } } | undefined)?.constructor?.name === "Spacer";
		if (content.some((c) => c.type === "thinking" || c.type === "text") && !startsWithSpacer) shapeFailed = true;
		return result;
	};
	record.wrapper = wrapper;
	proto.updateContent = wrapper;
	proto[REGISTRY] = new Map([[ADAPTER, record]]);
	return {
		record,
		get calls() { return calls; },
		get displaced() { return displaced; },
		get shapeFailed() { return shapeFailed; },
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
	return { proto, instance };
}

const THINKING = { content: [{ type: "thinking", thinking: "Planning" }, { type: "toolCall", id: "1", name: "read", arguments: {} }] };

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
	assert.equal(zentui.shapeFailed, false, "Zentui still sees pi's native layout");
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

test("Zentui: later unknown updateContent is left untouched at render time and reported", (t) => {
	const { proto, instance } = makeTarget();
	const zentui = installThinkingWrapper(proto);
	const warnings: string[] = [];
	const patch = installLeadingSpacerPatch({ prototype: proto as never, warn: (m) => warnings.push(m) });
	t.after(() => { patch.uninstall(); zentui.uninstall(); });
	assert.equal(patch.active, true);
	instance.updateContent(THINKING);
	const children = [...instance.contentContainer.children];
	proto.updateContent = function () {};
	assert.deepEqual(instance.render(80), [""]);
	assert.deepEqual(instance.contentContainer.children, children, "unknown renderer's actual Spacer must be left alone");
	assert.equal(patch.degraded, true, "/activity-patch must not keep reporting active");
	instance.render(80);
	assert.equal(warnings.length, 1);
});

test("Zentui: cleanup resumes when Zentui owns updateContent again", (t) => {
	const { proto, instance } = makeTarget();
	const zentui = installThinkingWrapper(proto);
	const warnings: string[] = [];
	const patch = installLeadingSpacerPatch({ prototype: proto as never, warn: (m) => warnings.push(m) });
	t.after(() => { patch.uninstall(); zentui.uninstall(); });
	const zentuiUpdate = proto.updateContent;
	instance.updateContent(THINKING);
	proto.updateContent = function foreignWrapper(this: unknown, ...args) {
		return Reflect.apply(zentuiUpdate, this, args);
	};
	assert.deepEqual(instance.render(80), [""], "paused while an unknown wrapper owns updateContent");
	proto.updateContent = zentuiUpdate;
	assert.deepEqual(instance.render(80), [], "the same message is cleaned on the next render");
	assert.equal(patch.degraded, false);
	assert.equal(warnings.length, 1);
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
	assert.equal(zentui.shapeFailed, false, "Zentui still sees pi's native layout");
});

test("Zentui: an unchanged message is not re-measured on every frame", (t) => {
	initTheme("dark", false);
	const proto = AssistantMessageComponent.prototype;
	const zentui = installThinkingWrapper(proto);
	const patch = installLeadingSpacerPatch({ prototype: proto as never });
	t.after(() => { patch.uninstall(); zentui.uninstall(); });
	assert.equal(patch.active, true);
	const message = { ...THINKING, content: [THINKING.content[0], { type: "text", text: "Answer with **markdown**" }] };
	const component = new AssistantMessageComponent(
		message as never, false, undefined, "", 1,
		[(text, ctx) => ctx.messageType === "assistant-thinking" ? "" : text],
	);
	const frames = 30;
	const counts = new Map<object, number>();
	for (const child of (component as unknown as { contentContainer: { children: { render(w: number): string[] }[] } }).contentContainer.children) {
		const render = child.render.bind(child);
		child.render = (width) => { counts.set(child, (counts.get(child) ?? 0) + 1); return render(width); };
	}
	const first = component.render(120);
	for (let i = 1; i < frames; i++) assert.deepEqual(component.render(120), first);
	// One frame each, plus the single cleanup pass after the content changed.
	for (const n of counts.values()) assert.ok(n <= frames + 2, `child rendered ${n} times in ${frames} frames`);
	component.updateContent(message as never);
	assert.deepEqual(component.render(120), first, "a content change is cleaned up again");
	assert.equal(zentui.shapeFailed, false);
});
