import assert from "node:assert/strict";
import test from "node:test";

import { EventCheckpointPolicy } from "../memory/EventCheckpointPolicy";
import { TieredMemoryManager } from "../memory/TieredMemoryManager";
import { RecoverySupervisor } from "../runtime/RecoverySupervisor";
import { SupervisorBus } from "../runtime/SupervisorBus";

test("RecoverySupervisor integrates event checkpoints and tiered memory during restore-oriented flows", async () => {
	const calls: string[] = [];
	const bus = new SupervisorBus({ error() {} });
	const tieredMemoryManager = new TieredMemoryManager<string>();
	let supervisor: RecoverySupervisor;

	const checkpointPolicy = new EventCheckpointPolicy({
		bus,
		cooldownMs: 0,
		checkpointIdFactory: (trigger, detail) => `${trigger}:${detail ?? "auto"}`,
		async triggerCheckpoint(checkpointId) {
			await supervisor.checkpoint(checkpointId);
		},
	});

	supervisor = new RecoverySupervisor({
		bus,
		checkpointPolicy,
		tieredMemoryManager,
		delegate: {
			async checkpoint(checkpointId) {
				calls.push(`checkpoint:${checkpointId}`);
			},
			async restore(sessionId) {
				calls.push(`restore:${sessionId}`);
			},
		},
	});

	await tieredMemoryManager.addHotEntry({
		id: "recent-turn",
		sizeBytes: 32,
		value: "turn",
	});
	await bus.emit({ type: "inference:answer-committed", requestId: "req-1" });
	await supervisor.notePhaseTransition("wrap_up");
	await supervisor.restore("session-9");

	assert.deepEqual(calls, [
		"checkpoint:answer-committed:req-1",
		"checkpoint:phase-transition:wrap_up",
		"restore:session-9",
	]);
	assert.equal(supervisor.getTieredMemoryManager(), tieredMemoryManager);
});
