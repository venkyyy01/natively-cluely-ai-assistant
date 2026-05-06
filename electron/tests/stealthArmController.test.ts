import assert from "node:assert/strict";
import test from "node:test";

import { StealthArmController } from "../stealth/StealthArmController";

test("StealthArmController arms by enabling, verifying, and starting heartbeat", async () => {
	const calls: string[] = [];
	const controller = new StealthArmController({
		armNativeStealth: async () => {
			calls.push("armNativeStealth");
			return true;
		},
		setEnabled: async (enabled: boolean) => {
			calls.push(`setEnabled:${enabled}`);
		},
		verifyStealthState: async () => {
			calls.push("verify");
			return true;
		},
		startHeartbeat: async () => {
			calls.push("startHeartbeat");
		},
		stopHeartbeat: async () => {
			calls.push("stopHeartbeat");
		},
	});

	await controller.arm();

	assert.deepEqual(calls, [
		"armNativeStealth",
		"setEnabled:true",
		"verify",
		"startHeartbeat",
	]);
});

test("StealthArmController rejects arm when verification fails", async () => {
	const controller = new StealthArmController({
		setEnabled: async () => {},
		verifyStealthState: async () => false,
	});

	await assert.rejects(() => controller.arm(), /stealth verification failed/);
});

test("StealthArmController falls back to Electron-only stealth when native helper is unavailable", async () => {
	const calls: string[] = [];
	const controller = new StealthArmController({
		armNativeStealth: async () => {
			calls.push("armNativeStealth:false");
			return false;
		},
		setEnabled: async (enabled: boolean) => {
			calls.push(`setEnabled:${enabled}`);
		},
		verifyStealthState: async () => {
			calls.push("verify");
			return true;
		},
		startHeartbeat: async () => {
			calls.push("startHeartbeat");
		},
	});

	await controller.arm();

	assert.deepEqual(calls, [
		"armNativeStealth:false",
		"setEnabled:true",
		"verify",
		"startHeartbeat",
	]);
});

test("StealthArmController disarms by stopping heartbeat before disabling", async () => {
	const calls: string[] = [];
	const controller = new StealthArmController({
		armNativeStealth: async () => {
			calls.push("armNativeStealth");
			return true;
		},
		faultNativeStealth: async (reason: string) => {
			calls.push(`faultNativeStealth:${reason}`);
		},
		setEnabled: async (enabled: boolean) => {
			calls.push(`setEnabled:${enabled}`);
		},
		verifyStealthState: async () => true,
		startHeartbeat: async () => {
			calls.push("startHeartbeat");
		},
		stopHeartbeat: async () => {
			calls.push("stopHeartbeat");
		},
	});

	await controller.arm();
	calls.length = 0;

	await controller.disarm();

	assert.deepEqual(calls, [
		"faultNativeStealth:stealth disabled",
		"stopHeartbeat",
		"setEnabled:false",
	]);
});

test("StealthArmController aggregates all disarm cleanup failures", async () => {
	const calls: string[] = [];
	const controller = new StealthArmController({
		faultNativeStealth: async () => {
			calls.push("faultNativeStealth");
			throw new Error("native fault failed");
		},
		stopHeartbeat: async () => {
			calls.push("stopHeartbeat");
			throw new Error("heartbeat stop failed");
		},
		setEnabled: async () => {
			calls.push("setEnabled:false");
			throw new Error("disable failed");
		},
		verifyStealthState: async () => true,
	});

	await assert.rejects(
		() => controller.disarm(),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.equal(error.errors.length, 3);
			assert.match(error.message, /multiple cleanup errors/);
			return true;
		},
	);
	assert.deepEqual(calls, [
		"faultNativeStealth",
		"stopHeartbeat",
		"setEnabled:false",
	]);
});
