import test from 'node:test';
import assert from 'node:assert/strict';

import { MeetingCheckpointer } from '../MeetingCheckpointer';
import type { MeetingSnapshot } from '../SessionTracker';

test('MeetingCheckpointer writes provisional snapshots', async () => {
  const writes: Array<{ id: string; durationMs: number }> = [];
  const checkpointer = new MeetingCheckpointer(
    {
      createOrUpdateMeetingProcessingRecord(meeting: { id: string }, _startTime: number, durationMs: number) {
        writes.push({ id: meeting.id, durationMs });
      },
    } as never,
    () => ({
      createSnapshot(): MeetingSnapshot {
        return {
          transcript: [{ speaker: 'interviewer', text: 'hello', timestamp: Date.now(), final: true }],
          usage: [],
          startTime: Date.now() - 1_000,
          durationMs: 1_000,
          context: '[INTERVIEWER]: hello',
          meetingMetadata: null,
        };
      },
    }) as never,
  );

  checkpointer.start('meeting-1');
  await (checkpointer as unknown as { checkpoint: () => Promise<void> }).checkpoint();
  checkpointer.stop();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, 'meeting-1');
});

test('MeetingCheckpointer destroy clears the active timer state', () => {
  const checkpointer = new MeetingCheckpointer(
    { createOrUpdateMeetingProcessingRecord() {} } as never,
    () => ({
      createSnapshot(): MeetingSnapshot {
        return { transcript: [], usage: [], startTime: 0, durationMs: 0, context: '', meetingMetadata: null };
      },
    }) as never,
  );

  checkpointer.start('meeting-2');
  checkpointer.destroy();

  const internal = checkpointer as unknown as { interval: NodeJS.Timeout | null; meetingId: string | null };
  assert.equal(internal.interval, null);
  assert.equal(internal.meetingId, null);
});

test('MeetingCheckpointer skips writes when the snapshot has no transcript', async () => {
  let writes = 0;
  const checkpointer = new MeetingCheckpointer(
    { createOrUpdateMeetingProcessingRecord() { writes += 1; } } as never,
    () => ({
      createSnapshot(): MeetingSnapshot {
        return { transcript: [], usage: [], startTime: 0, durationMs: 0, context: '', meetingMetadata: null };
      },
    }) as never,
  );

  checkpointer.start('meeting-3');
  await (checkpointer as unknown as { checkpoint: () => Promise<void> }).checkpoint();

  assert.equal(writes, 0);
});
