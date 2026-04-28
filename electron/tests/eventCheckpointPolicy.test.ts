import test from 'node:test';
import assert from 'node:assert/strict';

import { EventCheckpointPolicy } from '../memory/EventCheckpointPolicy';
import { SupervisorBus } from '../runtime/SupervisorBus';

test('EventCheckpointPolicy triggers on answer commit, meeting stop, phase transitions, and user actions with cooldown suppression', async () => {
  const bus = new SupervisorBus({ error() {} });
  const checkpoints: string[] = [];
  let now = 1000;
  const policy = new EventCheckpointPolicy({
    bus,
    now: () => now,
    cooldownMs: 5000,
    checkpointIdFactory: (trigger, detail) => `${trigger}:${detail ?? 'auto'}`,
    async triggerCheckpoint(checkpointId) {
      checkpoints.push(checkpointId);
    },
  });

  await bus.emit({ type: 'inference:answer-committed', requestId: 'req-1' });
  await bus.emit({ type: 'lifecycle:meeting-stopping' });
  now += 6000;
  await policy.notePhaseTransition('implementation');
  now += 6000;
  await policy.noteUserAction('pin-constraint');

  assert.deepEqual(checkpoints, [
    'answer-committed:req-1',
    'phase-transition:implementation',
    'user-action:pin-constraint',
  ]);
});
