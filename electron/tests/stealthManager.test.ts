import assert from "node:assert";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setOptimizationFlagsForTesting } from "../config/optimizations";
import {
	type NativeStealthBindings,
	type StealthConfig,
	StealthManager,
} from "../stealth/StealthManager";

const silentLogger = {
	log() {},
	warn() {},
	error() {},
};

class FakeWindow extends EventEmitter {
	private static readonly instances = new Set<FakeWindow>();
	public contentProtectionCalls: boolean[] = [];
	public skipTaskbarCalls: boolean[] = [];
	public hiddenInMissionControlCalls: boolean[] = [];
	public excludedFromShownWindowsMenuCalls: boolean[] = [];
	public excludeFromCaptureCalls: boolean[] = [];
	public hideCalls = 0;
	public showCalls = 0;
	public setOpacityCalls: number[] = [];
	public nativeHandle: Buffer = Buffer.from([0x2a, 0, 0, 0, 0, 0, 0, 0]);
	public mediaSourceId = "window:101:0";
	public destroyed = false;
	public visible = true;
	public bounds = { x: 10, y: 20, width: 1280, height: 720 };
	public setBoundsCalls: Array<{
		x: number;
		y: number;
		width: number;
		height: number;
	}> = [];

	constructor() {
		super();
		FakeWindow.instances.add(this);
	}

	setContentProtection(value: boolean): void {
		this.contentProtectionCalls.push(value);
	}

	setExcludeFromCapture(value: boolean): void {
		this.excludeFromCaptureCalls.push(value);
	}

	setSkipTaskbar(value: boolean): void {
		this.skipTaskbarCalls.push(value);
	}

	setHiddenInMissionControl(value: boolean): void {
		this.hiddenInMissionControlCalls.push(value);
	}

	setExcludedFromShownWindowsMenu(value: boolean): void {
		this.excludedFromShownWindowsMenuCalls.push(value);
	}

	setOpacity(value: number): void {
		this.setOpacityCalls.push(value);
		this.visible = value > 0;
	}

	getNativeWindowHandle(): Buffer {
		return this.nativeHandle;
	}

	getMediaSourceId(): string {
		return this.mediaSourceId;
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}

	hide(): void {
		this.hideCalls += 1;
		this.visible = false;
	}

	show(): void {
		this.showCalls += 1;
		this.visible = true;
	}

	isVisible(): boolean {
		return this.visible;
	}

	getBounds(): { x: number; y: number; width: number; height: number } {
		return { ...this.bounds };
	}

	setBounds(bounds: {
		x: number;
		y: number;
		width: number;
		height: number;
	}): void {
		this.bounds = { ...bounds };
		this.setBoundsCalls.push({ ...bounds });
	}

	destroy(): void {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		FakeWindow.instances.delete(this);
		this.emit("closed");
	}

	static destroyAll(): void {
		for (const win of [...FakeWindow.instances]) {
			win.destroy();
		}
		FakeWindow.instances.clear();
	}
}

describe("StealthManager", () => {
	beforeEach(() => {
		setOptimizationFlagsForTesting({
			accelerationEnabled: true,
			useStealthMode: true,
		});
	});

	afterEach(() => {
		FakeWindow.destroyAll();
		setOptimizationFlagsForTesting({
			accelerationEnabled: false,
			useStealthMode: true,
		});
	});

	async function flushAsyncWork(): Promise<void> {
		await new Promise((resolve) => setImmediate(resolve));
	}

	it("returns stealth-ready window defaults when enabled", () => {
		const manager = new StealthManager({ enabled: true });
		const options = manager.getBrowserWindowOptions();

		assert.deepStrictEqual(options, {
			contentProtection: true,
			excludeFromCapture: true,
			skipTaskbar: false,
		});
	});

	it("does nothing when stealth is disabled", () => {
		const win = new FakeWindow();
		const manager = new StealthManager({ enabled: false });

		manager.applyToWindow(win as any);

		assert.deepStrictEqual(win.contentProtectionCalls, []);
		assert.deepStrictEqual(win.skipTaskbarCalls, []);
	});

	it("applies native Windows stealth and re-applies it on lifecycle events", () => {
		const calls: string[] = [];
		const nativeModule: NativeStealthBindings = {
			applyWindowsWindowStealth(handle: Buffer) {
				calls.push(`apply:${handle.readUInt8(0)}`);
			},
		};
		const win = new FakeWindow();
		const manager = new StealthManager(
			{ enabled: true },
			{ nativeModule, platform: "win32", logger: silentLogger },
		);

		manager.applyToWindow(win as any, true, { role: "primary" });
		win.emit("restore");
		win.emit("unminimize");
		win.emit("move");

		assert.deepStrictEqual(win.contentProtectionCalls, [
			true,
			true,
			true,
			true,
		]);
		assert.deepStrictEqual(calls, [
			"apply:42",
			"apply:42",
			"apply:42",
			"apply:42",
		]);
	});

	it("records observe-only protection violations without blocking application", () => {
		const win = new FakeWindow();
		win.visible = true;
		const manager = new StealthManager(
			{ enabled: true },
			{ platform: "darwin", logger: silentLogger, nativeModule: null },
		);

		manager.applyToWindow(win as any, true, { role: "primary" });

		const snapshot = manager.getProtectionStateSnapshot();
		assert.equal(win.contentProtectionCalls.length > 0, true);
		assert.equal(
			snapshot.violations.some(
				(violation) => violation.type === "protecting-visible-window",
			),
			true,
		);
	});

	it("applies auxiliary UI hardening on macOS windows", () => {
		const nativeModule: NativeStealthBindings = {
			applyMacosWindowStealth(windowNumber: number) {
				assert.strictEqual(windowNumber, 101);
			},
		};
		const win = new FakeWindow();
		const manager = new StealthManager(
			{ enabled: true },
			{ nativeModule, platform: "darwin", logger: silentLogger },
		);

		manager.applyToWindow(win as any, true, { role: "auxiliary" });

		assert.deepStrictEqual(win.contentProtectionCalls, [true]);
		assert.deepStrictEqual(win.skipTaskbarCalls, [true]);
		assert.deepStrictEqual(win.hiddenInMissionControlCalls, [true]);
		assert.deepStrictEqual(win.excludedFromShownWindowsMenuCalls, [true]);
	});

	it("falls back cleanly when native stealth throws", () => {
		const win = new FakeWindow();
		const manager = new StealthManager(
			{ enabled: true },
			{
				nativeModule: {
					applyWindowsWindowStealth() {
						throw new Error("boom");
					},
				},
				logger: silentLogger,
				platform: "win32",
			},
		);

		assert.doesNotThrow(() =>
			manager.applyToWindow(win as any, true, { role: "primary" }),
		);
		assert.deepStrictEqual(win.contentProtectionCalls, [true]);
	});

	it("ignores destroyed windows when releasing virtual display isolation", () => {
		const releaseCalls: string[] = [];
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "darwin",
				logger: silentLogger,
				featureFlags: {
					enableVirtualDisplayIsolation: true,
				},
				virtualDisplayCoordinator: {
					ensureIsolationForWindow: async () => ({
						ready: true,
						surfaceToken: "display-1",
					}),
					releaseIsolationForWindow: async ({
						windowId,
					}: {
						windowId: string;
					}) => {
						releaseCalls.push(windowId);
					},
				} as any,
			},
		);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, {
			role: "auxiliary",
			allowVirtualDisplayIsolation: true,
		});
		win.destroyed = true;
		win.mediaSourceId = "window:999:0";

		assert.doesNotThrow(() => win.emit("closed"));
		assert.deepStrictEqual(releaseCalls, []);
	});

	it("reapplies managed windows after power monitor events", () => {
		const nativeCalls: number[] = [];
		const powerMonitor = new EventEmitter();
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "win32",
				powerMonitor,
				nativeModule: {
					applyWindowsWindowStealth() {
						nativeCalls.push(Date.now());
					},
				},
				logger: silentLogger,
			},
		);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, { role: "primary" });
		powerMonitor.emit("unlock-screen");
		powerMonitor.emit("resume");

		assert.strictEqual(nativeCalls.length, 3);
	});

	it("reapplies managed windows after display metrics changes on Windows", () => {
		const nativeCalls: number[] = [];
		const displayEvents = new EventEmitter();
		const manager = new StealthManager({ enabled: true }, {
			platform: "win32",
			displayEvents,
			nativeModule: {
				applyWindowsWindowStealth() {
					nativeCalls.push(Date.now());
				},
			},
			logger: silentLogger,
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, { role: "primary" });
		displayEvents.emit("display-metrics-changed");

		assert.strictEqual(nativeCalls.length, 2);
	});

	it("reapplies managed windows after screen-api display metrics changes on Windows", () => {
		const nativeCalls: number[] = [];
		const screenApi = new EventEmitter() as EventEmitter & {
			getAllDisplays: () => Array<{
				id: number;
				workArea: { x: number; y: number; width: number; height: number };
			}>;
		};
		screenApi.getAllDisplays = () => [];

		const manager = new StealthManager({ enabled: true }, {
			platform: "win32",
			screenApi,
			nativeModule: {
				applyWindowsWindowStealth() {
					nativeCalls.push(Date.now());
				},
			},
			logger: silentLogger,
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, { role: "primary" });
		screenApi.emit("display-metrics-changed");

		assert.strictEqual(nativeCalls.length, 2);
	});

	it("reapplies managed windows after macOS display add and remove events", () => {
		const nativeCalls: number[] = [];
		const displayEvents = new EventEmitter();
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			displayEvents,
			nativeModule: {
				applyMacosWindowStealth() {
					nativeCalls.push(Date.now());
				},
			},
			logger: silentLogger,
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, { role: "primary" });
		displayEvents.emit("display-added");
		displayEvents.emit("display-removed");

		assert.strictEqual(nativeCalls.length, 3);
	});

	it("enables the private macOS stealth path only when the feature flag is set", () => {
		const nativeCalls: string[] = [];
		const nativeModule: NativeStealthBindings = {
			applyMacosWindowStealth() {
				nativeCalls.push("base");
			},
			applyMacosPrivateWindowStealth() {
				nativeCalls.push("private");
			},
		};
		const win = new FakeWindow();

		const disabledManager = new StealthManager(
			{ enabled: true },
			{ nativeModule, platform: "darwin", logger: silentLogger },
		);
		disabledManager.applyToWindow(win as any, true, { role: "primary" });

		const enabledManager = new StealthManager(
			{ enabled: true },
			{
				nativeModule,
				platform: "darwin",
				logger: silentLogger,
				featureFlags: { enablePrivateMacosStealthApi: true },
			},
		);
		enabledManager.applyToWindow(win as any, true, { role: "primary" });

		assert.deepStrictEqual(nativeCalls, ["base", "base", "private"]);
	});

	it("starts the capture watchdog and hides then restores visible windows on detection", async () => {
		const powerMonitor = new EventEmitter();
		const intervals: Array<() => Promise<void> | void> = [];
		const timeouts: Array<() => void> = [];
		let enumeratorCallCount = 0;
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			powerMonitor,
			logger: silentLogger,
			featureFlags: { enableCaptureDetectionWatchdog: true },
			intervalScheduler: (fn: () => Promise<void> | void) => {
				intervals.push(fn);
				return intervals.length;
			},
			clearIntervalScheduler() {},
			timeoutScheduler: (fn: () => void) => {
				timeouts.push(fn);
				return timeouts.length;
			},
			nativeModule: {
				getRunningProcesses: () => {
					enumeratorCallCount++;
					return enumeratorCallCount <= 1
						? [{ pid: 1, ppid: 1, name: "obs" }]
						: [];
				},
			},
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, { role: "primary" });
		assert.ok(intervals.length >= 1);

		await intervals[0]();
		assert.deepStrictEqual(win.setOpacityCalls, [0]);

		timeouts[0]();
		await new Promise((r) => setTimeout(r, 0));
		assert.deepStrictEqual(win.setOpacityCalls, [0, 1]);
		win.destroy();
	});

	it("keeps the capture watchdog alive until the last managed window closes", () => {
		const intervals: Array<() => Promise<void> | void> = [];
		const cleared: unknown[] = [];
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			logger: silentLogger,
			featureFlags: { enableCaptureDetectionWatchdog: true },
			intervalScheduler: (fn: () => Promise<void> | void) => {
				intervals.push(fn);
				return intervals.length;
			},
			clearIntervalScheduler(handle: unknown) {
				cleared.push(handle);
			},
			timeoutScheduler() {
				return 1;
			},
			nativeModule: {
				getRunningProcesses: (): Array<{
					pid: number;
					ppid: number;
					name: string;
				}> => [],
			},
		} as any);
		const first = new FakeWindow();
		const second = new FakeWindow();

		manager.applyToWindow(first as any, true, { role: "primary" });
		manager.applyToWindow(second as any, true, { role: "auxiliary" });

		assert.ok(intervals.length >= 1);
		first.destroy();
		assert.deepStrictEqual(cleared, []);

		second.destroy();
		assert.ok(cleared.includes(1));
	});

	it("keeps Windows affinity verification on a separate interval handle", () => {
		const intervals: Array<() => Promise<void> | void> = [];
		const cleared: unknown[] = [];
		const manager = new StealthManager({ enabled: true }, {
			platform: "win32",
			logger: silentLogger,
			featureFlags: { enableCaptureDetectionWatchdog: true },
			intervalScheduler: (fn: () => Promise<void> | void) => {
				intervals.push(fn);
				return intervals.length;
			},
			clearIntervalScheduler(handle: unknown) {
				cleared.push(handle);
			},
			timeoutScheduler() {
				return 1;
			},
			nativeModule: {
				getRunningProcesses: (): Array<{
					pid: number;
					ppid: number;
					name: string;
				}> => [],
			},
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, { role: "primary" });
		assert.strictEqual(intervals.length, 2);

		win.destroy();
		assert.deepStrictEqual(cleared, [1, 2]);
	});

	it("uses a configurable capture tool matcher list for watchdog detection", async () => {
		const intervals: Array<() => Promise<void> | void> = [];
		const win = new FakeWindow();
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			logger: silentLogger,
			featureFlags: { enableCaptureDetectionWatchdog: false },
			captureToolPatterns: [/internal recorder/i],
			intervalScheduler: (fn: () => Promise<void> | void) => {
				intervals.push(fn);
				return intervals.length;
			},
			clearIntervalScheduler() {},
			timeoutScheduler() {
				return 1;
			},
			nativeModule: {
				getRunningProcesses: (): Array<{
					pid: number;
					ppid: number;
					name: string;
				}> => [],
			},
		} as any);

		manager.applyToWindow(win as any, true, { role: "primary" });
		win.destroy();
	});

	it("logs capture detections when the watchdog hides windows", async () => {
		const intervals: Array<() => Promise<void> | void> = [];
		const logs: string[] = [];
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			logger: {
				log(message: string) {
					logs.push(message);
				},
				warn() {},
				error() {},
			},
			featureFlags: { enableCaptureDetectionWatchdog: true },
			intervalScheduler: (fn: () => Promise<void> | void) => {
				intervals.push(fn);
				return intervals.length;
			},
			clearIntervalScheduler() {},
			timeoutScheduler() {
				return 1;
			},
			nativeModule: {
				getRunningProcesses: () => [{ pid: 1, ppid: 1, name: "obs" }],
			},
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, { role: "primary" });
		await intervals[0]();

		assert.ok(
			logs.some((entry) =>
				entry.includes("Capture watchdog detected suspicious tools running"),
			),
		);
		win.destroy();
	});

	it("uses native process list for capture detection", async () => {
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "darwin",
				logger: silentLogger,
				nativeModule: {
					getRunningProcesses: () => [
						{
							pid: 1,
							ppid: 1,
							name: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
						},
						{ pid: 2, ppid: 1, name: "/usr/bin/obs" },
					],
				},
			},
		);

		const matches = await (manager as any).detectCaptureProcesses();

		assert.ok(matches.some((pattern: RegExp) => pattern.test("chrome")));
		assert.ok(matches.some((pattern: RegExp) => pattern.test("obs")));
	});

	it("verifies applied stealth state through native bindings", () => {
		const win = new FakeWindow();
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "darwin",
				logger: silentLogger,
				nativeModule: {
					applyMacosWindowStealth() {},
					verifyMacosStealthState() {
						return 0;
					},
				},
			},
		);

		manager.applyToWindow(win as any, true, { role: "primary" });

		assert.strictEqual(manager.verifyStealth(win as any), true);
	});

	it("accepts the private macOS stealth path when NSWindow sharingType does not reflect CGS state", () => {
		const win = new FakeWindow();
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "darwin",
				logger: silentLogger,
				featureFlags: { enablePrivateMacosStealthApi: true },
				nativeModule: {
					applyMacosWindowStealth() {},
					applyMacosPrivateWindowStealth() {},
					verifyMacosStealthState() {
						return 1;
					},
				},
			},
		);

		(manager as any).macOSMajor = 15;
		(manager as any).macOSMinor = 4;

		manager.applyToWindow(win as any, true, { role: "primary" });

		assert.strictEqual(manager.verifyStealth(win as any), true);
	});

	it("verifies all managed windows through native bindings", () => {
		const first = new FakeWindow();
		const second = new FakeWindow();
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "darwin",
				logger: silentLogger,
				nativeModule: {
					applyMacosWindowStealth() {},
					verifyMacosStealthState() {
						return 0;
					},
				},
			},
		);

		manager.applyToWindow(first as any, true, { role: "primary" });
		manager.applyToWindow(second as any, true, { role: "auxiliary" });

		assert.strictEqual(manager.verifyManagedWindows(), true);
	});

	it("NAT-029: hidden managed windows are still verified (visibility gate removed)", () => {
		let verifyCalls = 0;
		const first = new FakeWindow();
		const second = new FakeWindow();
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "darwin",
				logger: silentLogger,
				nativeModule: {
					applyMacosWindowStealth() {},
					verifyMacosStealthState() {
						verifyCalls += 1;
						return 0;
					},
				},
			},
		);

		manager.applyToWindow(first as any, true, { role: "primary" });
		manager.applyToWindow(second as any, true, { role: "auxiliary" });
		first.hide();
		second.hide();
		const verifyCallsBefore = verifyCalls;

		assert.strictEqual(manager.verifyManagedWindows(), true);
		// NAT-029: hidden windows still run verifyStealth, so we expect 2 additional calls
		assert.strictEqual(verifyCalls - verifyCallsBefore, 2);
		assert.ok(
			!manager
				.getStealthDegradationWarnings()
				.includes("stealth_verification_failed"),
		);
	});

	it("fails managed-window verification when native stealth is unavailable in stealth mode", () => {
		const win = new FakeWindow();
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "darwin",
				logger: silentLogger,
				nativeModule: null,
			},
		);

		manager.applyToWindow(win as any, true, { role: "primary" });

		assert.strictEqual(manager.verifyManagedWindows(), false);
		assert.ok(
			manager
				.getStealthDegradationWarnings()
				.includes("native_module_unavailable"),
		);
	});

	it("marks capture visibility as degraded when native and Python probes are both unavailable", async () => {
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "darwin",
				logger: silentLogger,
				execFileFn: (
					_file: string,
					_args: readonly string[],
					_options: { timeout?: number },
					callback: (
						error: Error | null,
						stdout: string,
						stderr: string,
					) => void,
				) => {
					callback(new Error("python unavailable"), "", "");
				},
			},
		);

		(manager as any).nativeModule = {
			listVisibleWindows: () => {
				throw new Error("native unavailable");
			},
		};

		await (manager as any).pollCGWindowVisibility();

		assert.ok(
			manager
				.getStealthDegradationWarnings()
				.includes("capture_visibility_unknown"),
		);
	});

	it("falls back to hide and show when opacity APIs are unavailable", async () => {
		const intervals: Array<() => Promise<void> | void> = [];
		const timeouts: Array<() => void> = [];
		let enumeratorCallCount = 0;
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			logger: silentLogger,
			featureFlags: { enableCaptureDetectionWatchdog: true },
			intervalScheduler: (fn: () => Promise<void> | void) => {
				intervals.push(fn);
				return intervals.length;
			},
			clearIntervalScheduler() {},
			timeoutScheduler: (fn: () => void) => {
				timeouts.push(fn);
				return timeouts.length;
			},
			nativeModule: {
				getRunningProcesses: () => {
					enumeratorCallCount++;
					return enumeratorCallCount <= 1
						? [{ pid: 1, ppid: 1, name: "obs" }]
						: [];
				},
			},
		} as any);
		const win = new FakeWindow();
		(win as any).setOpacity = undefined;

		manager.applyToWindow(win as any, true, { role: "primary" });
		await intervals[0]();

		timeouts[0]();
		await new Promise((r) => setTimeout(r, 0));

		assert.strictEqual(win.hideCalls, 1);
		assert.strictEqual(win.showCalls, 1);
	});

	it("ignores stale capture detections when the watchdog is paused after a poll has already started", async () => {
		const intervals: Array<() => Promise<void> | void> = [];
		let resolveEnumerator!: (value: string) => void;
		const enumeratorPromise = new Promise<string>((resolve) => {
			resolveEnumerator = resolve;
		});
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			logger: silentLogger,
			featureFlags: { enableCaptureDetectionWatchdog: true },
			intervalScheduler: (fn: () => Promise<void> | void) => {
				intervals.push(fn);
				return intervals.length;
			},
			clearIntervalScheduler() {},
			nativeModule: {
				getRunningProcesses: async () => {
					await enumeratorPromise;
					return [{ pid: 1, ppid: 1, name: "screencapture" }];
				},
			},
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, { role: "primary" });

		const pollPromise = Promise.resolve(intervals[0]?.());
		manager.pauseWatchdog();
		manager.pauseWatchdog();
		manager.pauseWatchdog();
		resolveEnumerator("screencapture");
		await pollPromise;

		assert.deepStrictEqual(win.setOpacityCalls, []);
		assert.strictEqual(win.hideCalls, 0);
		assert.ok(
			!manager
				.getStealthDegradationWarnings()
				.includes("capture_tools_still_running"),
		);
	});

	it("ignores in-flight capture detections even if the watchdog resumes before the stale poll completes", async () => {
		const intervals: Array<() => Promise<void> | void> = [];
		let resolveEnumerator!: (value: string) => void;
		const enumeratorPromise = new Promise<string>((resolve) => {
			resolveEnumerator = resolve;
		});
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			logger: silentLogger,
			featureFlags: { enableCaptureDetectionWatchdog: true },
			intervalScheduler: (fn: () => Promise<void> | void) => {
				intervals.push(fn);
				return intervals.length;
			},
			clearIntervalScheduler() {},
			nativeModule: {
				getRunningProcesses: async () => {
					await enumeratorPromise;
					return [{ pid: 1, ppid: 1, name: "screencapture" }];
				},
			},
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, { role: "primary" });

		const pollPromise = Promise.resolve(intervals[0]?.());
		manager.pauseWatchdog();
		manager.resumeWatchdog();
		resolveEnumerator("screencapture");
		await pollPromise;

		assert.deepStrictEqual(win.setOpacityCalls, []);
		assert.strictEqual(win.hideCalls, 0);
	});

	it("verifies Windows stealth state through native bindings", () => {
		const win = new FakeWindow();
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "win32",
				logger: silentLogger,
				nativeModule: {
					applyWindowsWindowStealth() {},
					verifyWindowsStealthState() {
						return 0x11;
					},
				},
			},
		);

		manager.applyToWindow(win as any, true, { role: "primary" });

		assert.strictEqual(manager.verifyStealth(win as any), true);
	});

	it("clears the capture-visibility warning once windows are no longer visible to capture tools", async () => {
		const win = new FakeWindow();
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "darwin",
				logger: silentLogger,
				nativeModule: {
					applyMacosWindowStealth() {},
					verifyMacosStealthState() {
						return 0;
					},
				},
			},
		);

		manager.applyToWindow(win as any, true, { role: "primary" });

		(manager as any).getWindowNumbersVisibleToCapture = async () =>
			new Set([101]);
		await (manager as any).pollCGWindowVisibility();
		assert.ok(
			manager
				.getStealthDegradationWarnings()
				.includes("window_visible_to_capture"),
		);

		(manager as any).getWindowNumbersVisibleToCapture = async () =>
			new Set<number>();
		await (manager as any).pollCGWindowVisibility();
		assert.ok(
			!manager
				.getStealthDegradationWarnings()
				.includes("window_visible_to_capture"),
		);
	});

	it("clears transient capture warnings when stealth is disabled", () => {
		const win = new FakeWindow();
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "darwin",
				logger: silentLogger,
			},
		);

		manager.applyToWindow(win as any, true, { role: "primary" });
		(manager as any).addWarning("chromium_capture_active");
		(manager as any).addWarning("scstream_capture_detected");
		(manager as any).addWarning("window_visible_to_capture");

		manager.setEnabled(false);

		assert.ok(
			!manager
				.getStealthDegradationWarnings()
				.includes("chromium_capture_active"),
		);
		assert.ok(
			!manager
				.getStealthDegradationWarnings()
				.includes("scstream_capture_detected"),
		);
		assert.ok(
			!manager
				.getStealthDegradationWarnings()
				.includes("window_visible_to_capture"),
		);
	});

	it("starts macOS virtual display isolation with the current window bounds when the feature flag is enabled", async () => {
		const calls: Array<{
			action: string;
			windowId: string;
			width?: number;
			height?: number;
		}> = [];
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			screenApi: {
				getAllDisplays() {
					return [
						{ id: 777, workArea: { x: 200, y: 100, width: 1600, height: 900 } },
					];
				},
			},
			logger: silentLogger,
			featureFlags: { enableVirtualDisplayIsolation: true },
			virtualDisplayCoordinator: {
				ensureIsolationForWindow({
					windowId,
					width,
					height,
				}: {
					windowId: string;
					width: number;
					height: number;
				}) {
					calls.push({ action: "ensure", windowId, width, height });
					return Promise.resolve({
						ready: true,
						sessionId: windowId,
						mode: "virtual-display" as const,
						surfaceToken: "display-777",
					});
				},
				releaseIsolationForWindow({ windowId }: { windowId: string }) {
					calls.push({ action: "release", windowId });
					return Promise.resolve();
				},
			},
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, {
			role: "primary",
			allowVirtualDisplayIsolation: true,
		});
		await Promise.resolve();
		manager.applyToWindow(win as any, false, {
			role: "primary",
			allowVirtualDisplayIsolation: true,
		});

		assert.deepStrictEqual(calls, [
			{ action: "ensure", windowId: "window:101:0", width: 1280, height: 720 },
			{ action: "release", windowId: "window:101:0" },
		]);
		assert.deepStrictEqual(win.setBoundsCalls, [
			{ x: 200, y: 100, width: 1280, height: 720 },
		]);
	});

	it("retries moving macOS windows to the virtual display until Electron reports the display", async () => {
		const timeouts: Array<() => void> = [];
		const displays: Array<{
			id: number;
			workArea: { x: number; y: number; width: number; height: number };
		}> = [];
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			screenApi: {
				getAllDisplays() {
					return [...displays];
				},
			},
			logger: silentLogger,
			featureFlags: { enableVirtualDisplayIsolation: true },
			timeoutScheduler: (fn: () => void) => {
				timeouts.push(fn);
				return timeouts.length;
			},
			virtualDisplayCoordinator: {
				ensureIsolationForWindow({ windowId }: { windowId: string }) {
					return Promise.resolve({
						ready: true,
						sessionId: windowId,
						mode: "virtual-display" as const,
						surfaceToken: "display-777",
					});
				},
				releaseIsolationForWindow() {
					return Promise.resolve();
				},
			},
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, {
			role: "primary",
			allowVirtualDisplayIsolation: true,
		});
		await Promise.resolve();

		assert.deepStrictEqual(win.setBoundsCalls, []);
		assert.strictEqual(timeouts.length, 1);

		displays.push({
			id: 777,
			workArea: { x: 200, y: 100, width: 1600, height: 900 },
		});
		timeouts[0]();

		assert.deepStrictEqual(win.setBoundsCalls, [
			{ x: 200, y: 100, width: 1280, height: 720 },
		]);
	});

	it("serializes virtual display isolation requests so a second window waits for the first helper call to finish", async () => {
		const calls: string[] = [];
		const displays = [
			{ id: 777, workArea: { x: 200, y: 100, width: 1600, height: 900 } },
		];
		let resolveFirstRequest: (() => void) | null = null;
		const firstRequestSettled = new Promise<void>((resolve) => {
			resolveFirstRequest = resolve;
		});
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			screenApi: {
				getAllDisplays() {
					return displays;
				},
			},
			logger: silentLogger,
			featureFlags: { enableVirtualDisplayIsolation: true },
			virtualDisplayCoordinator: {
				ensureIsolationForWindow({ windowId }: { windowId: string }) {
					calls.push(windowId);
					if (calls.length === 1) {
						return firstRequestSettled.then(() => ({
							ready: true,
							sessionId: windowId,
							mode: "virtual-display" as const,
							surfaceToken: "display-777",
						}));
					}

					return Promise.resolve({
						ready: true,
						sessionId: windowId,
						mode: "virtual-display" as const,
						surfaceToken: "display-777",
					});
				},
				releaseIsolationForWindow() {
					return Promise.resolve();
				},
			},
		} as any);
		const first = new FakeWindow();
		const second = new FakeWindow();
		second.mediaSourceId = "window:202:0";

		manager.applyToWindow(first as any, true, {
			role: "primary",
			allowVirtualDisplayIsolation: true,
		});
		manager.applyToWindow(second as any, true, {
			role: "primary",
			allowVirtualDisplayIsolation: true,
		});
		await flushAsyncWork();

		assert.deepStrictEqual(calls, ["window:101:0"]);

		resolveFirstRequest?.();
		await flushAsyncWork();
		await flushAsyncWork();

		assert.deepStrictEqual(calls, ["window:101:0", "window:202:0"]);
	});

	it("does not start virtual display isolation unless the window opts in", async () => {
		const calls: Array<{ action: string; windowId: string }> = [];
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			logger: silentLogger,
			featureFlags: { enableVirtualDisplayIsolation: true },
			virtualDisplayCoordinator: {
				ensureIsolationForWindow({ windowId }: { windowId: string }) {
					calls.push({ action: "ensure", windowId });
					return Promise.resolve({
						ready: true,
						sessionId: windowId,
						mode: "virtual-display" as const,
						surfaceToken: "display-777",
					});
				},
				releaseIsolationForWindow({ windowId }: { windowId: string }) {
					calls.push({ action: "release", windowId });
					return Promise.resolve();
				},
			},
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, { role: "primary" });
		await Promise.resolve();
		manager.applyToWindow(win as any, false, { role: "primary" });

		assert.deepStrictEqual(calls, []);
	});

	it("retries virtual display isolation after a non-ready helper response", async () => {
		const calls: string[] = [];
		let ready = false;
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			screenApi: {
				getAllDisplays() {
					return [
						{ id: 777, workArea: { x: 200, y: 100, width: 1600, height: 900 } },
					];
				},
			},
			logger: silentLogger,
			featureFlags: { enableVirtualDisplayIsolation: true },
			virtualDisplayCoordinator: {
				ensureIsolationForWindow({ windowId }: { windowId: string }) {
					calls.push(ready ? "ready" : "not-ready");
					if (ready) {
						return Promise.resolve({
							ready: true,
							sessionId: windowId,
							mode: "virtual-display" as const,
							surfaceToken: "display-777",
						});
					}
					return Promise.resolve({
						ready: false,
						sessionId: windowId,
						reason: "warming-up",
					});
				},
				releaseIsolationForWindow() {
					return Promise.resolve();
				},
			},
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, {
			role: "primary",
			allowVirtualDisplayIsolation: true,
		});
		await Promise.resolve();

		ready = true;
		manager.reapplyAfterShow(win as any);
		await flushAsyncWork();

		assert.deepStrictEqual(calls, ["not-ready", "ready"]);
		assert.deepStrictEqual(win.setBoundsCalls, [
			{ x: 200, y: 100, width: 1280, height: 720 },
		]);
	});

	it("cancels pending virtual display moves when stealth is disabled", async () => {
		const timeouts: Array<() => void> = [];
		const displays: Array<{
			id: number;
			workArea: { x: number; y: number; width: number; height: number };
		}> = [];
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			screenApi: {
				getAllDisplays() {
					return [...displays];
				},
			},
			logger: silentLogger,
			featureFlags: { enableVirtualDisplayIsolation: true },
			timeoutScheduler: (fn: () => void) => {
				timeouts.push(fn);
				return timeouts.length;
			},
			virtualDisplayCoordinator: {
				ensureIsolationForWindow({ windowId }: { windowId: string }) {
					return Promise.resolve({
						ready: true,
						sessionId: windowId,
						mode: "virtual-display" as const,
						surfaceToken: "display-777",
					});
				},
				releaseIsolationForWindow() {
					return Promise.resolve();
				},
			},
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, {
			role: "primary",
			allowVirtualDisplayIsolation: true,
		});
		await Promise.resolve();
		manager.applyToWindow(win as any, false, {
			role: "primary",
			allowVirtualDisplayIsolation: true,
		});

		displays.push({
			id: 777,
			workArea: { x: 200, y: 100, width: 1600, height: 900 },
		});
		timeouts[0]();

		assert.deepStrictEqual(win.setBoundsCalls, []);
	});

	it("allows virtual display isolation to retry after display move retries are exhausted", async () => {
		const calls: string[] = [];
		const timeouts: Array<() => void> = [];
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			screenApi: {
				getAllDisplays(): Array<{
					id: number;
					workArea: { x: number; y: number; width: number; height: number };
				}> {
					return [];
				},
			},
			logger: silentLogger,
			featureFlags: { enableVirtualDisplayIsolation: true },
			timeoutScheduler: (fn: () => void) => {
				timeouts.push(fn);
				return timeouts.length;
			},
			virtualDisplayCoordinator: {
				ensureIsolationForWindow({ windowId }: { windowId: string }) {
					calls.push(windowId);
					return Promise.resolve({
						ready: true,
						sessionId: windowId,
						mode: "virtual-display" as const,
						surfaceToken: "display-777",
					});
				},
				releaseIsolationForWindow() {
					return Promise.resolve();
				},
			},
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, {
			role: "primary",
			allowVirtualDisplayIsolation: true,
		});
		await Promise.resolve();

		for (let i = 0; i < 10; i += 1) {
			timeouts[i]();
		}

		manager.reapplyAfterShow(win as any);
		await flushAsyncWork();

		assert.deepStrictEqual(calls, ["window:101:0", "window:101:0"]);
	});

	it("releases virtual display isolation when an opted-in window closes", async () => {
		const calls: Array<{ action: string; windowId: string }> = [];
		const manager = new StealthManager({ enabled: true }, {
			platform: "darwin",
			logger: silentLogger,
			featureFlags: { enableVirtualDisplayIsolation: true },
			virtualDisplayCoordinator: {
				ensureIsolationForWindow({ windowId }: { windowId: string }) {
					calls.push({ action: "ensure", windowId });
					return Promise.resolve({
						ready: true,
						sessionId: windowId,
						mode: "virtual-display" as const,
						surfaceToken: "display-777",
					});
				},
				releaseIsolationForWindow({ windowId }: { windowId: string }) {
					calls.push({ action: "release", windowId });
					return Promise.resolve();
				},
			},
		} as any);
		const win = new FakeWindow();

		manager.applyToWindow(win as any, true, {
			role: "primary",
			allowVirtualDisplayIsolation: true,
		});
		await Promise.resolve();
		win.destroy();

		assert.deepStrictEqual(calls, [
			{ action: "ensure", windowId: "window:101:0" },
			{ action: "release", windowId: "window:101:0" },
		]);
	});

	it("treats native shareable CG windows as visible to capture without Python fallback", async () => {
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "darwin",
				logger: silentLogger,
			},
		);

		(manager as any).nativeModule = {
			listVisibleWindows: () => [
				{
					windowNumber: 12345,
					ownerName: "Natively",
					ownerPid: 1,
					windowTitle: "Protected",
					isOnScreen: true,
					sharingState: 1,
					alpha: 1,
				},
				{
					windowNumber: 22222,
					ownerName: "Hidden",
					ownerPid: 2,
					windowTitle: "Hidden",
					isOnScreen: true,
					sharingState: 1,
					alpha: 0,
				},
				{
					windowNumber: 33333,
					ownerName: "Private",
					ownerPid: 3,
					windowTitle: "Private",
					isOnScreen: true,
					sharingState: 0,
					alpha: 1,
				},
			],
		};

		const result = await (manager as any).getWindowNumbersVisibleToCapture();

		assert.ok(result instanceof Set, "should return a Set");
		assert.deepEqual(Array.from(result), [12345]);
	});

	it("uses Python capture fallback only when native enumeration fails in development", async () => {
		let embeddedScript = "";
		const manager = new StealthManager(
			{ enabled: true },
			{
				platform: "darwin",
				logger: silentLogger,
				execFileFn: (
					_file: string,
					args: readonly string[],
					_options: { timeout?: number },
					callback: (
						error: Error | null,
						stdout: string,
						stderr: string,
					) => void,
				) => {
					embeddedScript = args[1] ?? "";
					callback(null, "12345\n67890\n", "");
				},
			},
		);

		(manager as any).nativeModule = {
			listVisibleWindows: () => {
				throw new Error("native unavailable");
			},
		};

		const result = await (manager as any).getWindowNumbersVisibleToCapture();

		assert.ok(result instanceof Set, "should return a Set");
		assert.ok(
			embeddedScript.includes("Quartz"),
			"should use Python Quartz when native fails",
		);
		assert.ok(
			embeddedScript.includes("sharing_state"),
			"should check sharing_state in Python",
		);
		assert.strictEqual(result.size, 2);
		assert.ok(result.has(12345));
		assert.ok(result.has(67890));
	});

	it("blocks Python capture fallback in strict production mode", async () => {
		const previousNodeEnv = process.env.NODE_ENV;
		const previousStrict = process.env.NATIVELY_STRICT_PROTECTION;
		process.env.NODE_ENV = "production";
		process.env.NATIVELY_STRICT_PROTECTION = "1";

		try {
			const manager = new StealthManager(
				{ enabled: true },
				{
					platform: "darwin",
					logger: silentLogger,
					execFileFn: (
						_file: string,
						_args: readonly string[],
						_options: { timeout?: number },
						callback: (
							error: Error | null,
							stdout: string,
							stderr: string,
						) => void,
					) => {
						callback(null, "12345\n", "");
					},
				},
			);

			(manager as any).nativeModule = {
				listVisibleWindows: () => {
					throw new Error("native unavailable");
				},
			};

			const result = await (manager as any).getWindowNumbersVisibleToCapture();

			assert.ok(result instanceof Set);
			assert.equal(result.size, 0);
			assert.ok(
				manager
					.getStealthDegradationWarnings()
					.includes("stealth_python_fallback_blocked"),
			);
		} finally {
			if (previousNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = previousNodeEnv;
			}
			if (previousStrict === undefined) {
				delete process.env.NATIVELY_STRICT_PROTECTION;
			} else {
				process.env.NATIVELY_STRICT_PROTECTION = previousStrict;
			}
		}
	});

	it("compares macOS versions using both major and minor components", () => {
		const manager = new StealthManager(
			{ enabled: true },
			{ platform: "darwin", logger: silentLogger },
		);

		(manager as any).macOSMajor = 15;
		(manager as any).macOSMinor = 3;
		assert.strictEqual(
			(manager as any).isMacOSVersionCompatible("15.4"),
			false,
		);

		(manager as any).macOSMinor = 4;
		assert.strictEqual((manager as any).isMacOSVersionCompatible("15.4"), true);
	});
});
