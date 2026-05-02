import assert from "node:assert/strict";
import test from "node:test";

import { createAppleSiliconQoS } from "../runtime/AppleSiliconQoS";

test("AppleSiliconQoS uses the native helper on darwin arm64 when it loads", () => {
	const calls: string[] = [];
	const qos = createAppleSiliconQoS({
		platform: "darwin",
		arch: "arm64",
		addonLoader: () => ({
			setCurrentThreadQoS(qosClass) {
				calls.push(qosClass);
			},
		}),
		logger: { warn() {} },
	});

	assert.equal(qos.supported, true);
	qos.setCurrentThreadQoS("USER_INTERACTIVE");
	assert.deepEqual(calls, ["USER_INTERACTIVE"]);
});

test("AppleSiliconQoS falls back to a no-op handle when the addon is unavailable", () => {
	const qos = createAppleSiliconQoS({
		platform: "darwin",
		arch: "arm64",
		addonLoader: () => {
			throw new Error("missing addon");
		},
		logger: { warn() {} },
	});

	assert.equal(qos.supported, false);
	assert.doesNotThrow(() => qos.setCurrentThreadQoS("BACKGROUND"));
});

test("AppleSiliconQoS does not warn when the optional addon module is absent", () => {
	let warnCount = 0;
	const qos = createAppleSiliconQoS({
		platform: "darwin",
		arch: "arm64",
		addonLoader: () => {
			const error = new Error(
				"Cannot find module '../native/qos_helper.node'",
			) as NodeJS.ErrnoException;
			error.code = "MODULE_NOT_FOUND";
			throw error;
		},
		logger: {
			warn() {
				warnCount += 1;
			},
		},
	});

	assert.equal(qos.supported, false);
	assert.equal(warnCount, 0);
});
