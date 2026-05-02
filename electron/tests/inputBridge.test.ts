import assert from "node:assert/strict";
import test from "node:test";

import { InputBridge } from "../stealth/inputBridge";

test("InputBridge forwards keyboard and character events", () => {
	const forwarded: Array<Record<string, unknown>> = [];
	const bridge = new InputBridge();

	bridge.forward(
		{ sendInputEvent: (event) => forwarded.push(event) },
		{
			kind: "keyboard",
			type: "keyDown",
			key: "a",
			code: "KeyA",
			modifiers: [],
		},
	);

	assert.equal(forwarded.length, 2);
	assert.deepEqual(forwarded[0], {
		type: "rawKeyDown",
		keyCode: "a",
		code: "KeyA",
		modifiers: [],
	});
	assert.deepEqual(forwarded[1], { type: "char", keyCode: "a", modifiers: [] });
});

test("InputBridge forwards mouse, wheel, keyUp, and focus events without extra char events", () => {
	const forwarded: Array<Record<string, unknown>> = [];
	const bridge = new InputBridge();
	const target = {
		sendInputEvent: (event: Record<string, unknown>) => forwarded.push(event),
	};

	bridge.forward(target, {
		kind: "mouse",
		type: "mouseMove",
		x: 4,
		y: 5,
		modifiers: ["shift"],
	});
	bridge.forward(target, {
		kind: "wheel",
		type: "mouseWheel",
		x: 1,
		y: 2,
		deltaX: 3,
		deltaY: 4,
		modifiers: ["meta"],
	});
	bridge.forward(target, {
		kind: "keyboard",
		type: "keyUp",
		key: "Enter",
		code: "Enter",
		modifiers: [],
	});
	bridge.forward(target, {
		kind: "keyboard",
		type: "keyDown",
		key: "x",
		code: "KeyX",
		modifiers: ["meta"],
	});
	bridge.forward(target, { kind: "focus", type: "focus" });

	assert.deepEqual(forwarded, [
		{
			type: "mouseMove",
			x: 4,
			y: 5,
			button: undefined,
			clickCount: 1,
			modifiers: ["shift"],
		},
		{
			type: "mouseWheel",
			x: 1,
			y: 2,
			deltaX: 3,
			deltaY: 4,
			modifiers: ["meta"],
		},
		{ type: "keyUp", keyCode: "Enter", code: "Enter", modifiers: [] },
		{ type: "rawKeyDown", keyCode: "x", code: "KeyX", modifiers: ["meta"] },
		{ type: "focus" },
	]);
});
