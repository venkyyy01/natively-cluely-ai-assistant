import assert from "node:assert/strict";
import test from "node:test";
import { StealthSupervisor } from "../runtime/StealthSupervisor";
import { SupervisorBus } from "../runtime/SupervisorBus";

test("stealth supervisor: renderer-hang fault retains native protection", async () => {
	const bus = new SupervisorBus({ error: () => {} });
	const faults: string[] = [];
	bus.subscribe("stealth:fault", async (event) => {
		faults.push(event.reason);
	});

	let nativeArmed = false;
	let nativeFaulted = false;

	const supervisor = new StealthSupervisor(
		{
			setEnabled: () => {},
			isEnabled: () => true,
			verifyStealthState: () => true,
		},
		bus,
		{
			nativeBridge: {
				arm: async () => {
					nativeArmed = true;
					return { connected: true };
				},
				heartbeat: async () => ({ connected: true, healthy: true }),
				fault: async () => {
					nativeFaulted = true;
				},
				getStatus: async () => ({ state: "active" }),
			} as any,
		},
	);

	await supervisor.start();
	await supervisor.setEnabled(true);
	assert.equal(supervisor.getStealthState(), "FULL_STEALTH");
	assert.equal(nativeArmed, true);

	// Simulate renderer crash / hang
	await supervisor.reportFault(new Error("renderer hang"));

	assert.equal(supervisor.getStealthState(), "FAULT");
	// FS-01 prevents calling disarm or faulting the native bridge intentionally
	assert.equal(
		nativeFaulted,
		false,
		"native protection should not be disabled on fault",
	);
	assert.deepEqual(faults, ["renderer hang"]);
});

test("stealth supervisor: native-heartbeat failure throws and fails closed", async () => {
	const bus = new SupervisorBus({ error: () => {} });
	const faults: string[] = [];
	const heartbeatTicks: Array<() => void> = [];
	bus.subscribe("stealth:fault", async (event) => {
		faults.push(event.reason);
	});

	let heartbeatCheckCount = 0;

	const supervisor = new StealthSupervisor(
		{
			setEnabled: () => {},
			isEnabled: () => true,
			verifyStealthState: () => true,
		},
		bus,
		{
			nativeBridge: {
				arm: async () => ({ connected: true }),
				heartbeat: async () => {
					heartbeatCheckCount++;
					return { connected: true, healthy: false };
				},
				fault: async () => {},
				getStatus: async () => ({ state: "active" }),
			} as any,
			intervalScheduler: (cb) => {
				heartbeatTicks.push(cb);
				return { unref() {} };
			},
			heartbeatIntervalMs: 100,
		},
	);

	await supervisor.start();
	await supervisor.setEnabled(true);

	heartbeatTicks[0]?.();
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(supervisor.getStealthState(), "FAULT");
	assert.ok(
		faults.some((f) => f.includes("stealth heartbeat missed")),
		"should report heartbeat missed",
	);
	assert.equal(heartbeatCheckCount, 1);
});
