// electron/tests/stealthOpacityFlickerDisabled.test.ts
//
// NAT-010 / audit S-1: the deterministic 500 ms opacity-flicker loop is a
// timing fingerprint, not a stealth gain. By default, no `setInterval`-style
// callback for the flicker loop must be scheduled by `StealthManager`. The
// flicker only schedules when `featureFlags.enableOpacityFlicker === true`
// (reserved for capture-bypass test fixtures, NAT-082).

import assert from "node:assert/strict";
import test from "node:test";

import { setOptimizationFlagsForTesting } from "../config/optimizations";
import { StealthManager } from "../stealth/StealthManager";

const silentLogger = {
	log() {},
	warn() {},
	error() {},
};

interface ScheduledInterval {
	callback: () => Promise<void> | void;
	intervalMs: number;
}

function buildManager(opts: { enableOpacityFlicker?: boolean }) {
	// Enhanced stealth path (which `ensureOpacityFlicker` lives on) is gated
	// by the `useStealthMode` optimization flag.
	setOptimizationFlagsForTesting({
		accelerationEnabled: true,
		useStealthMode: true,
	});

	const intervals: ScheduledInterval[] = [];
	const intervalScheduler = (
		cb: () => Promise<void> | void,
		intervalMs: number,
	) => {
		intervals.push({ callback: cb, intervalMs });
		return intervals.length;
	};

	const manager = new StealthManager(
		{ enabled: true },
		{
			platform: "darwin",
			logger: silentLogger,
			intervalScheduler,
			clearIntervalScheduler: () => {},
			timeoutScheduler: (cb) => {
				cb();
				return 0;
			},
			featureFlags:
				opts.enableOpacityFlicker !== undefined
					? { enableOpacityFlicker: opts.enableOpacityFlicker }
					: {},
		},
	);

	// Force the macOS 15.4+ branch on without invoking the real `sw_vers`
	// sub-process. `ensureOpacityFlicker()` early-returns unless the host is
	// detected as macOS 15.4+, so we have to fake it for the test to be
	// meaningful regardless of the actual machine running CI.
	(manager as unknown as { isMacOS15Plus: boolean }).isMacOS15Plus = true;

	return { manager, intervals };
}

test("NAT-010: opacity flicker is NOT scheduled by default on macOS 15.4+", () => {
	const { manager, intervals } = buildManager({});

	// Drive the codepath that calls `ensureOpacityFlicker()` from
	// `ensureBackgroundMonitors()` -> `ensureOpacityFlicker()`. We just
	// call the private method directly here to avoid pulling in the
	// power-monitor / display-events plumbing.
	(
		manager as unknown as { ensureOpacityFlicker: () => void }
	).ensureOpacityFlicker();

	const flickerIntervals = intervals.filter(
		(entry) => entry.intervalMs === 500,
	);
	assert.equal(
		flickerIntervals.length,
		0,
		`no 500ms flicker interval should be scheduled by default; saw ${flickerIntervals.length}`,
	);
});

test("NAT-010: opacity flicker IS scheduled when featureFlags.enableOpacityFlicker = true", () => {
	const { manager, intervals } = buildManager({ enableOpacityFlicker: true });

	(
		manager as unknown as { ensureOpacityFlicker: () => void }
	).ensureOpacityFlicker();

	const flickerIntervals = intervals.filter(
		(entry) => entry.intervalMs === 500,
	);
	assert.equal(
		flickerIntervals.length,
		1,
		`exactly one 500ms flicker interval expected when explicitly opted in; saw ${flickerIntervals.length}`,
	);
});

test("NAT-010: opacity flicker is NOT scheduled even when opted in if not macOS 15.4+", () => {
	setOptimizationFlagsForTesting({
		accelerationEnabled: true,
		useStealthMode: true,
	});

	const intervals: ScheduledInterval[] = [];
	const intervalScheduler = (
		cb: () => Promise<void> | void,
		intervalMs: number,
	) => {
		intervals.push({ callback: cb, intervalMs });
		return intervals.length;
	};

	const manager = new StealthManager(
		{ enabled: true },
		{
			platform: "darwin",
			logger: silentLogger,
			intervalScheduler,
			clearIntervalScheduler: () => {},
			featureFlags: { enableOpacityFlicker: true },
		},
	);
	// The constructor runs `detectMacOSVersion()` which shells out to
	// `sw_vers` and may legitimately set `isMacOS15Plus = true` on the host
	// CI / dev machine. To exercise the "pre-15.4 macOS" branch
	// deterministically, we override the field back to false here.
	(manager as unknown as { isMacOS15Plus: boolean }).isMacOS15Plus = false;
	(
		manager as unknown as { ensureOpacityFlicker: () => void }
	).ensureOpacityFlicker();

	const flickerIntervals = intervals.filter(
		(entry) => entry.intervalMs === 500,
	);
	assert.equal(
		flickerIntervals.length,
		0,
		"pre-15.4 macOS still gets no flicker interval",
	);
});
