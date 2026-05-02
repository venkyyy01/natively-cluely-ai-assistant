import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProtectionEventType } from "../stealth/protectionStateTypes";
import { StartupProtectionGate } from "../stealth/StartupProtectionGate";

describe("StartupProtectionGate", () => {
	it("allows default observe-only startup reveal while recording the would-block failure", async () => {
		const events: ProtectionEventType[] = [];
		let blocked = 0;
		const gate = new StartupProtectionGate({
			verifyProtection: () => false,
			isStrictProtectionEnabled: () => false,
			recordProtectionEvent: (type) => {
				events.push(type);
			},
			onBlocked: () => {
				blocked += 1;
			},
			logger: { log() {}, warn() {}, error() {} },
		});

		const decision = await gate.evaluateReveal({
			source: "test.observe",
			windowRole: "primary",
		});

		assert.equal(decision.allowReveal, true);
		assert.equal(decision.wouldBlock, true);
		assert.equal(decision.reason, "startup-verification-failed");
		assert.deepEqual(events, ["verification-failed"]);
		assert.equal(blocked, 0);
	});

	it("blocks strict startup reveal when protection verification fails", async () => {
		const events: ProtectionEventType[] = [];
		let blockedReason: string | null = null;
		const gate = new StartupProtectionGate({
			verifyProtection: () => false,
			isStrictProtectionEnabled: () => true,
			recordProtectionEvent: (type) => {
				events.push(type);
			},
			onBlocked: (decision) => {
				blockedReason = decision.reason;
			},
			logger: { log() {}, warn() {}, error() {} },
		});

		const decision = await gate.evaluateReveal({
			source: "test.strict",
			windowRole: "primary",
		});

		assert.equal(decision.allowReveal, false);
		assert.equal(decision.strict, true);
		assert.equal(decision.reason, "startup-verification-failed");
		assert.equal(blockedReason, "startup-verification-failed");
		assert.deepEqual(events, ["verification-failed"]);
	});

	it("allows strict startup reveal after positive verification", async () => {
		const events: ProtectionEventType[] = [];
		const gate = new StartupProtectionGate({
			verifyProtection: () => true,
			isStrictProtectionEnabled: () => true,
			recordProtectionEvent: (type) => {
				events.push(type);
			},
			logger: { log() {}, warn() {}, error() {} },
		});

		const decision = await gate.evaluateReveal({
			source: "test.pass",
			windowRole: "primary",
		});

		assert.equal(decision.allowReveal, true);
		assert.equal(decision.verified, true);
		assert.equal(decision.reason, "protection-verified");
		assert.deepEqual(events, ["verification-passed"]);
	});

	it("fails closed on strict startup verification timeout", async () => {
		let blockedReason: string | null = null;
		const gate = new StartupProtectionGate({
			verifyProtection: () => new Promise<boolean>(() => {}),
			isStrictProtectionEnabled: () => true,
			timeoutMs: 1,
			onBlocked: (decision) => {
				blockedReason = decision.reason;
			},
			logger: { log() {}, warn() {}, error() {} },
		});

		const decision = await gate.evaluateReveal({
			source: "test.timeout",
			windowRole: "primary",
		});

		assert.equal(decision.allowReveal, false);
		assert.equal(decision.reason, "startup-verification-timeout");
		assert.equal(blockedReason, "startup-verification-timeout");
	});

	it("fails closed on strict startup verification errors", async () => {
		const gate = new StartupProtectionGate({
			verifyProtection: () => {
				throw new Error("native verification unavailable");
			},
			isStrictProtectionEnabled: () => true,
			logger: { log() {}, warn() {}, error() {} },
		});

		const decision = await gate.evaluateReveal({
			source: "test.error",
			windowRole: "primary",
		});

		assert.equal(decision.allowReveal, false);
		assert.equal(decision.reason, "startup-verification-error");
	});
});
