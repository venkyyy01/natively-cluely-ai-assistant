import test from 'node:test';
import assert from 'node:assert/strict';
import { AnswerLatencyTracker } from '../latency/AnswerLatencyTracker';

test('AnswerLatencyTracker records route, capability, marks, and completion safely', () => {
  const tracker = new AnswerLatencyTracker();
  const requestId = tracker.start('fast_standard_answer', 'streaming');

  tracker.mark(requestId, 'promptPrepared');
  const beforeComplete = tracker.getSnapshot(requestId);
  assert.equal(beforeComplete?.route, 'fast_standard_answer');
  assert.equal(beforeComplete?.capability, 'streaming');
  assert.ok(beforeComplete?.marks.startedAt);
  assert.ok(beforeComplete?.marks.promptPrepared);

  const completed = tracker.complete(requestId);
  assert.equal(completed?.completed, true);
  assert.ok(completed?.marks.completedAt);

  tracker.mark(requestId, 'shouldBeIgnored');
  const afterComplete = tracker.getSnapshot(requestId);
  assert.equal(afterComplete?.marks.shouldBeIgnored, undefined);
});
