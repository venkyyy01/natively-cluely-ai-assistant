import assert from "node:assert/strict";
import test from "node:test";

import {
	canArmStealth,
	canDisableStealth,
	canFaultStealth,
	transitionStealthState,
} from "../stealth/StealthStateMachine";

test("StealthStateMachine allows the main arm and disable flow", () => {
	assert.equal(transitionStealthState("OFF", "arm-requested"), "ARMING");
	assert.equal(
		transitionStealthState("ARMING", "arm-succeeded"),
		"FULL_STEALTH",
	);
	assert.equal(transitionStealthState("FULL_STEALTH", "disabled"), "OFF");
});

test("StealthStateMachine preserves current FAULT recovery permissiveness", () => {
	assert.equal(transitionStealthState("FAULT", "arm-requested"), "ARMING");
	assert.equal(transitionStealthState("FAULT", "disabled"), "OFF");
});

test("StealthStateMachine fails closed on illegal transitions", () => {
	assert.equal(transitionStealthState("OFF", "arm-succeeded"), "FAULT");
	assert.equal(
		transitionStealthState("FULL_STEALTH", "arm-succeeded"),
		"FAULT",
	);
	assert.equal(transitionStealthState("OFF", "disabled"), "FAULT");
});

test("StealthStateMachine exposes legal no-op guards used by the supervisor", () => {
	assert.equal(canArmStealth("OFF"), true);
	assert.equal(canArmStealth("ARMING"), false);
	assert.equal(canArmStealth("FULL_STEALTH"), false);
	assert.equal(canArmStealth("FAULT"), true);

	assert.equal(canDisableStealth("OFF"), false);
	assert.equal(canDisableStealth("ARMING"), true);
	assert.equal(canDisableStealth("FULL_STEALTH"), true);
	assert.equal(canDisableStealth("FAULT"), true);

	assert.equal(canFaultStealth("OFF"), true);
	assert.equal(canFaultStealth("ARMING"), true);
	assert.equal(canFaultStealth("FULL_STEALTH"), true);
	assert.equal(canFaultStealth("FAULT"), false);
});
