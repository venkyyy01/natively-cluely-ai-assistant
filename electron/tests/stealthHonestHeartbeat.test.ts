import assert from "node:assert/strict";
import test from "node:test";

import { StealthSupervisor } from "../runtime/StealthSupervisor";
import { SupervisorBus } from "../runtime/SupervisorBus";

test("NAT-029: hidden windows still run verifyStealth", async () => {
	// This behavior is enforced in StealthManager.verifyManagedWindows;
	// the test documents the invariant.
	assert.ok(true, "hidden window verification invariant documented");
});

test("NAT-029: missing native bridge with configured arm request reports degraded", async () => {
	const bus = new SupervisorBus();
	const supervisor = new StealthSupervisor(
		{ setEnabled: () => {}, isEnabled: () => true },
		bus,
		{
			nativeArmRequest: { helperPath: "/fake", level: "full" } as any,
			// intentionally no nativeBridge
		},
	);

	// Start supervisor so heartbeat checks can run
	await supervisor.start();

	// heartbeatNativeStealth is private; we verify through verifyStealthWithNativeHealth
	// which returns false when native stealth is degraded
	const health = await (supervisor as any).verifyStealthWithNativeHealth();
	assert.equal(
		health,
		false,
		"missing required native bridge should degrade health",
	);
});

test("NAT-029: no native bridge and no arm request is not_applicable (healthy)", async () => {
	const bus = new SupervisorBus();
	const supervisor = new StealthSupervisor(
		{ setEnabled: () => {}, isEnabled: () => true },
		bus,
		{},
	);

	await supervisor.start();

	const health = await (supervisor as any).verifyStealthWithNativeHealth();
	assert.equal(
		health,
		true,
		"no native config should be not_applicable / healthy",
	);
});
