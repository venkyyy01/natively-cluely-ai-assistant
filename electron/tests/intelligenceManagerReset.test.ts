import test from 'node:test';
import assert from 'node:assert/strict';

import { IntelligenceManager } from '../IntelligenceManager';

test('IntelligenceManager reset preserves facade event forwarding for existing listeners', async () => {
  const manager = new IntelligenceManager({} as any);
  const forwarded: string[] = [];

  manager.on('suggested_answer', (answer: string) => {
    forwarded.push(answer);
  });

  await manager.reset();
  (manager as any).engine.emit('suggested_answer', 'post-reset answer', 'question', 0.8);

  assert.deepEqual(forwarded, ['post-reset answer']);
});
