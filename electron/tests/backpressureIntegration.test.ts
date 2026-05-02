import assert from "node:assert/strict";
import test from "node:test";

import { InferenceSupervisor } from "../runtime/InferenceSupervisor";
import { SupervisorBus } from "../runtime/SupervisorBus";
import { WarmStandbyManager } from "../runtime/WarmStandbyManager";

test("budget pressure disables speculation and defers nonessential warm standby work", async () => {
	const bus = new SupervisorBus({ error() {} });
	const calls: string[] = [];
	const inference = new InferenceSupervisor({
		bus,
		delegate: {
			async onBudgetPressure(lane, level) {
				calls.push(`${lane}:${level}`);
			},
		},
	});
	const warmStandby = new WarmStandbyManager({
		bus,
		workerPool: {
			async warmUp() {
				calls.push("worker:warm");
				return { id: "worker" };
			},
			checkHealth: () => true,
		},
		logger: { warn() {} },
	});

	await bus.emit({
		type: "budget:pressure",
		lane: "background",
		level: "critical",
	});
	const health = await warmStandby.warmUp();

	assert.equal(inference.isSpeculationAllowed(), false);
	assert.equal(health.workerPool.ready, false);
	assert.deepEqual(calls, ["background:critical"]);
});
