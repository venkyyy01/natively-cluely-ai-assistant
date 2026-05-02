import assert from "node:assert/strict";
import test from "node:test";

import {
	getDefaultProtectedWindows,
	getUnprotectedWindows,
	StealthCaptureFixture,
} from "../stealth/StealthCaptureFixture";

test("NAT-082: mock mode passes when all windows have content protection", async () => {
	const fixture = new StealthCaptureFixture({ mode: "mock" });
	const windows = getDefaultProtectedWindows();
	const results = await fixture.run(windows);

	assert.equal(results.length, 5);
	assert.ok(
		results.every((r) => r.passed),
		"all protected windows should pass",
	);
	assert.ok(
		results.every((r) => r.blank),
		"all should report blank",
	);
});

test("NAT-082: mock mode fails when content protection is removed", async () => {
	const fixture = new StealthCaptureFixture({ mode: "mock" });
	const windows = getUnprotectedWindows();
	const results = await fixture.run(windows);

	assert.equal(results.length, 5);
	assert.ok(
		results.every((r) => !r.passed),
		"all unprotected windows should fail",
	);
	assert.ok(
		results.every((r) => !r.blank),
		"none should report blank",
	);
});

test("NAT-082: default protected windows include all expected surfaces", () => {
	const windows = getDefaultProtectedWindows();
	const names = windows.map((w) => w.name);
	assert.ok(names.includes("shell"));
	assert.ok(names.includes("content"));
	assert.ok(names.includes("privacy-shield"));
	assert.ok(names.includes("launcher"));
	assert.ok(names.includes("overlay"));
});

test("NAT-082: all default windows have expected NSWindow level", () => {
	const windows = getDefaultProtectedWindows();
	for (const w of windows) {
		assert.equal(
			w.expectedNsWindowLevel,
			19,
			`${w.name} should have NSWindow level 19`,
		);
	}
});

test("NAT-082: live mode returns placeholder failure", async () => {
	const fixture = new StealthCaptureFixture({ mode: "live" });
	const windows = getDefaultProtectedWindows();
	const results = await fixture.run(windows);

	assert.equal(results.length, 5);
	assert.ok(
		results.every((r) => !r.passed),
		"live mode should return not-yet-implemented",
	);
	assert.ok(
		results.every((r) => r.reason?.includes("live mode not yet implemented")),
	);
});

test("NAT-082: partial protection fails fixture", async () => {
	const fixture = new StealthCaptureFixture({ mode: "mock" });
	const windows = [
		{ name: "shell", contentProtection: true },
		{ name: "content", contentProtection: false },
	];
	const results = await fixture.run(windows);

	assert.equal(results[0].passed, true);
	assert.equal(results[1].passed, false);
});
