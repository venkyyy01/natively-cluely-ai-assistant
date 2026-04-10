import test from 'node:test';
import assert from 'node:assert/strict';

import { TieredMemoryManager } from '../memory/TieredMemoryManager';
import { SupervisorBus } from '../runtime/SupervisorBus';

test('TieredMemoryManager demotes hot to warm and warm to cold while persisting cold entries', async () => {
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
  assert.deepEqual(manager.getColdState().map((entry) => entry.id), ['a']);
  assert.deepEqual(persisted, ['a']);
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
