import assert from "node:assert/strict";
import test from "node:test";

import { ChromiumCaptureDetector } from "../stealth/ChromiumCaptureDetector";

const silentLogger = {
	log() {},
	warn() {},
	error() {},
};

test("ChromiumCaptureDetector treats native false as authoritative without Python fallback", async () => {
	const detector = new ChromiumCaptureDetector({
		platform: "darwin",
		logger: silentLogger,
	});
	const execCalls: Array<{ command: string; args: string[] }> = [];

	(detector as any).nativeModule = {
		checkBrowserCaptureWindows: () => false,
	};
	(detector as any).execPromise = async (command: string, args: string[]) => {
		execCalls.push({ command, args });
		return "CAPTURE_DETECTED";
	};

	const result = await (detector as any).checkBrowserWindowTitleCapture();

	assert.equal(result, false);
	assert.deepEqual(execCalls, []);
});

test("NAT-027: single-signal event does not trigger capture-active", async () => {
	const detector = new ChromiumCaptureDetector({
		platform: "darwin",
		checkIntervalMs: 100,
		logger: console,
	});

	let captureActiveCount = 0;
	detector.on("capture-active", () => {
		captureActiveCount += 1;
	});

	// Pre-populate a detected browser so checkCaptureActivity does not bail out early
	(detector as any).detectedBrowsers.set("Chrome-12345", {
		pid: 12345,
		name: "Chrome",
	});

	// Prevent detectBrowserProcesses from clearing our stubbed entries
	(detector as any).detectBrowserProcesses = async () => {};

	// Override internal checks to simulate only signal A (parentage)
	(detector as any).checkScreenCaptureAgentParentage = async () => true;
	(detector as any).checkBrowserWindowTitleCapture = async () => false;

	detector.start();
	// Wait for multiple check cycles
	await new Promise((r) => setTimeout(r, 600));
	detector.stop();

	assert.strictEqual(
		captureActiveCount,
		0,
		"Only one corroborating signal should not trigger capture-active",
	);
});

test("NAT-027: confirmed dual-signal detection triggers capture-active after confirmation window", async () => {
	const detector = new ChromiumCaptureDetector({
		platform: "darwin",
		checkIntervalMs: 100,
		logger: console,
	});

	let captureActiveCount = 0;
	detector.on("capture-active", () => {
		captureActiveCount += 1;
	});

	(detector as any).detectedBrowsers.set("Chrome-12345", {
		pid: 12345,
		name: "Chrome",
	});

	// Prevent detectBrowserProcesses from clearing our stubbed entries
	(detector as any).detectBrowserProcesses = async () => {};

	(detector as any).checkScreenCaptureAgentParentage = async () => true;
	(detector as any).checkBrowserWindowTitleCapture = async () => true;

	detector.start();
	// Wait long enough for confirmation window (1500ms) + some buffer
	await new Promise((r) => setTimeout(r, 1800));
	detector.stop();

	assert.strictEqual(
		captureActiveCount,
		1,
		"Dual-signal detection should trigger exactly one capture-active after confirmation",
	);
});

test("NAT-027: 5-second hysteresis prevents rapid re-trigger", async () => {
	const detector = new ChromiumCaptureDetector({
		platform: "darwin",
		checkIntervalMs: 100,
		logger: console,
	});

	let captureActiveCount = 0;
	detector.on("capture-active", () => {
		captureActiveCount += 1;
	});

	// Pre-populate a detected browser so checkCaptureActivity does not bail out early
	(detector as any).detectedBrowsers.set("Chrome-12345", {
		pid: 12345,
		name: "Chrome",
	});

	// Prevent detectBrowserProcesses from clearing our stubbed entries
	(detector as any).detectBrowserProcesses = async () => {};

	(detector as any).checkScreenCaptureAgentParentage = async () => true;
	(detector as any).checkBrowserWindowTitleCapture = async () => true;

	detector.start();
	// Wait for first confirmation
	await new Promise((r) => setTimeout(r, 1800));

	// Briefly drop signals then restore (simulating flapping)
	(detector as any).checkScreenCaptureAgentParentage = async () => false;
	await new Promise((r) => setTimeout(r, 300));
	(detector as any).checkScreenCaptureAgentParentage = async () => true;

	// Wait again within hysteresis window
	await new Promise((r) => setTimeout(r, 1000));
	detector.stop();

	assert.strictEqual(
		captureActiveCount,
		1,
		"Hysteresis should prevent rapid re-trigger within 5 seconds",
	);
});
