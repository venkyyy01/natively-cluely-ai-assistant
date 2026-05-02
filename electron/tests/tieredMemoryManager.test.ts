import test from 'node:test';
import assert from 'node:assert/strict';

import { TieredMemoryManager } from '../memory/TieredMemoryManager';
import { SupervisorBus } from '../runtime/SupervisorBus';

test('TieredMemoryManager demotes hot to warm and warm to cold and evicts persisted entries from memory', async () => {
  const persisted: string[] = [];
  const manager = new TieredMemoryManager<string>({
    hotCeilingBytes: 10,
    warmCeilingBytes: 10,
    persistCold: async (entries) => {
      persisted.push(...entries.map((entry) => entry.id));
    },
  });

  await manager.addHotEntry({ id: 'a', sizeBytes: 6, value: 'a' });
  await manager.addHotEntry({ id: 'b', sizeBytes: 6, value: 'b' });
  await manager.addHotEntry({ id: 'c', sizeBytes: 6, value: 'c' });

  assert.deepEqual(manager.getHotState().map((entry) => entry.id), ['c']);
  assert.deepEqual(manager.getWarmState().map((entry) => entry.id), ['b']);
  // NAT-013: a successful persistCold now removes the persisted batch
  // from the in-memory cold list. The cold tier exists on disk, not
  // forever in RAM.
  assert.deepEqual(manager.getColdState().map((entry) => entry.id), []);
  assert.deepEqual(persisted, ['a']);
});

test('TieredMemoryManager retains cold entries in memory when no persist sink is configured', async () => {
  const manager = new TieredMemoryManager<string>({
    hotCeilingBytes: 10,
    warmCeilingBytes: 10,
  });

  await manager.addHotEntry({ id: 'a', sizeBytes: 6, value: 'a' });
  await manager.addHotEntry({ id: 'b', sizeBytes: 6, value: 'b' });
  await manager.addHotEntry({ id: 'c', sizeBytes: 6, value: 'c' });

  // Without a persist sink, cold remains in memory until the hard cap
  // (MAX_COLD_IN_MEMORY) kicks in.
  assert.deepEqual(manager.getColdState().map((entry) => entry.id), ['a']);
});

test('TieredMemoryManager compacts under critical budget pressure', async () => {
  const bus = new SupervisorBus({ error() {} });
  const manager = new TieredMemoryManager<string>({
    bus,
    hotCeilingBytes: 20,
    warmCeilingBytes: 20,
  });

  await manager.addHotEntry({ id: 'a', sizeBytes: 8, value: 'a' });
  await manager.addHotEntry({ id: 'b', sizeBytes: 8, value: 'b' });
  await manager.addHotEntry({ id: 'c', sizeBytes: 8, value: 'c' });
  await bus.emit({ type: 'budget:pressure', lane: 'background', level: 'critical' });

  assert.deepEqual(manager.getHotState().map((entry) => entry.id), ['c']);
});
