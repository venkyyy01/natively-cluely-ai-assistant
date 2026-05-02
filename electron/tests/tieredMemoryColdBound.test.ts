import assert from "node:assert/strict";
import test from "node:test";

import { TieredMemoryManager } from "../memory/TieredMemoryManager";

// NAT-013: even with a stub persistCold that does nothing useful (returns
// fast and leaves entries notionally persisted), the in-memory cold list
// must not grow without bound. The hard cap is the safety net for missing,
// slow, or failing sinks.
test("TieredMemoryManager.coldEntries stays bounded by MAX_COLD_IN_MEMORY when persist is a no-op", async () => {
	const persistedBatches: number[] = [];
	const manager = new TieredMemoryManager<number>({
		hotCeilingBytes: 1, // Force every add to immediately demote to warm
		warmCeilingBytes: 1, // Then immediately to cold
		persistCold: async (entries) => {
			// Acknowledge persistence but do not actually remove anything,
			// simulating a sink that has crashed silently.
			persistedBatches.push(entries.length);
		},
	});

	// 2048 entries × 4 bytes each. The current cap is 1024 cold-in-memory.
	for (let i = 0; i < 2048; i += 1) {
		await manager.addHotEntry({ id: `entry-${i}`, sizeBytes: 4, value: i });
	}

	// After persist evicts the batch from memory, the cold list should hover
	// near zero. With persist running for every demotion, getColdState must
	// never exceed MAX_COLD_IN_MEMORY (1024) even in the worst case.
	assert.equal(manager.getColdState().length <= 1024, true);
	assert.equal(persistedBatches.length > 0, true);
});

test("TieredMemoryManager.coldEntries hard-caps to MAX_COLD_IN_MEMORY when persist throws", async () => {
	const manager = new TieredMemoryManager<number>({
		hotCeilingBytes: 1,
		warmCeilingBytes: 1,
		persistCold: async () => {
			throw new Error("disk full");
		},
	});

	for (let i = 0; i < 2048; i += 1) {
		await manager.addHotEntry({ id: `entry-${i}`, sizeBytes: 4, value: i });
	}

	// Hard cap must hold even when persist fails — that is the only
	// protection against runaway memory in this scenario.
	assert.equal(manager.getColdState().length <= 1024, true);
});

test("TieredMemoryManager.coldEntries hard-caps when no persist sink is configured", async () => {
	const manager = new TieredMemoryManager<number>({
		hotCeilingBytes: 1,
		warmCeilingBytes: 1,
	});

	for (let i = 0; i < 2048; i += 1) {
		await manager.addHotEntry({ id: `entry-${i}`, sizeBytes: 4, value: i });
	}

	assert.equal(manager.getColdState().length <= 1024, true);
});

test("TieredMemoryManager.getColdState returns a snapshot copy", async () => {
	const manager = new TieredMemoryManager<number>({
		hotCeilingBytes: 1,
		warmCeilingBytes: 1,
	});

	await manager.addHotEntry({ id: "a", sizeBytes: 4, value: 1 });
	await manager.addHotEntry({ id: "b", sizeBytes: 4, value: 2 });
	await manager.addHotEntry({ id: "c", sizeBytes: 4, value: 3 });

	const snapshot = manager.getColdState();
	snapshot.push({
		id: "mutated",
		sizeBytes: 4,
		value: 999,
		createdAt: Date.now(),
	});

	// Mutating the returned array must not affect the manager's internal state.
	assert.equal(
		manager.getColdState().some((entry) => entry.id === "mutated"),
		false,
	);
});
