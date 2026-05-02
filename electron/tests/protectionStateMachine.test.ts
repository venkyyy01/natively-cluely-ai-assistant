import assert from "node:assert";
import { describe, it } from "node:test";

import { ProtectionStateMachine } from "../stealth/ProtectionStateMachine";

describe("ProtectionStateMachine", () => {
	it("tracks the normal hidden protection flow without violations", () => {
		let now = 1000;
		const machine = new ProtectionStateMachine({ now: () => now++ });

		machine.record("window-created", { source: "test", windowRole: "primary" });
		machine.record("protection-apply-started", {
			source: "test",
			windowRole: "primary",
			visible: false,
		});
		machine.record("protection-apply-finished", {
			source: "test",
			windowRole: "primary",
			visible: false,
		});
		const snapshot = machine.record("verification-passed", {
			source: "test",
			windowRole: "primary",
		});

		assert.equal(snapshot.state, "verified-hidden");
		assert.equal(snapshot.eventCount, 4);
		assert.deepEqual(snapshot.violations, []);
		assert.equal(snapshot.lastEventType, "verification-passed");
	});

	it("records show-before-verify as observe-only violation", () => {
		const warnings: unknown[] = [];
		const machine = new ProtectionStateMachine({
			logger: { warn: (...args: unknown[]) => warnings.push(args), log() {} },
			now: () => 2000,
		});

		const snapshot = machine.record("show-requested", {
			source: "test.show",
			windowRole: "primary",
			windowId: "window:1:0",
		});

		assert.equal(snapshot.state, "boot");
		assert.equal(snapshot.violations.length, 1);
		assert.equal(snapshot.violations[0]?.type, "show-before-verified");
		assert.equal(snapshot.violations[0]?.stateBefore, "boot");
		assert.equal(warnings.length, 1);
	});

	it("records a visible protection apply as observe-only violation", () => {
		const machine = new ProtectionStateMachine({ now: () => 3000 });

		const snapshot = machine.record("protection-apply-started", {
			source: "test.apply",
			windowRole: "primary",
			visible: true,
		});

		assert.equal(snapshot.state, "protecting-hidden");
		assert.equal(snapshot.violations.length, 1);
		assert.equal(snapshot.violations[0]?.type, "protecting-visible-window");
	});

	it("moves to visible-protected only after verification", () => {
		const machine = new ProtectionStateMachine({ now: () => 4000 });

		machine.record("protection-apply-started", {
			source: "test",
			visible: false,
		});
		machine.record("protection-apply-finished", {
			source: "test",
			visible: false,
		});
		machine.record("verification-passed", { source: "test" });
		const visible = machine.record("shown", {
			source: "test.show",
			visible: true,
		});

		assert.equal(visible.state, "visible-protected");
		assert.equal(visible.violations.length, 0);

		const hidden = machine.record("hidden", {
			source: "test.hide",
			visible: false,
		});
		assert.equal(hidden.state, "verified-hidden");
	});

	it("enters fault-contained and can begin recovery", () => {
		const machine = new ProtectionStateMachine({ now: () => 5000 });

		const faulted = machine.record("fault", {
			source: "test.fault",
			reason: "verification failed",
		});
		assert.equal(faulted.state, "fault-contained");

		const recovering = machine.record("recovery-requested", {
			source: "test.recovery",
		});
		assert.equal(recovering.state, "protecting-hidden");
	});

	it("returns defensive snapshot copies", () => {
		const machine = new ProtectionStateMachine({ now: () => 6000 });
		const snapshot = machine.record("show-requested", { source: "test" });
		snapshot.violations.length = 0;

		assert.equal(machine.getSnapshot().violations.length, 1);
	});
});
