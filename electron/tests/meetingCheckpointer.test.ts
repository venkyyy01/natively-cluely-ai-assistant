import test from 'node:test';
import assert from 'node:assert/strict';

import { MeetingCheckpointer } from '../MeetingCheckpointer';
import type { MeetingSnapshot } from '../SessionTracker';

test('MeetingCheckpointer writes provisional snapshots', async () => {
  const writes: Array<{ id: string; durationMs: number }> = [];
  const checkpointer = new MeetingCheckpointer(
    {} as never,
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
    {
      async saveSnapshot(meetingId: string, snapshot: MeetingSnapshot) {
        writes.push({ id: meetingId, durationMs: snapshot.durationMs });
      },
    } as never,
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
    {} as never,
    () => ({
      createSnapshot(): MeetingSnapshot {
        return { transcript: [], usage: [], startTime: 0, durationMs: 0, context: '', meetingMetadata: null };
      },
    }) as never,
    { async saveSnapshot() { writes += 1; } } as never,
  );

  checkpointer.start('meeting-3');
  await (checkpointer as unknown as { checkpoint: () => Promise<void> }).checkpoint();
  checkpointer.stop();

  assert.equal(writes, 0);
});

test('MeetingCheckpointer ignores checkpoint requests when no meeting is active', async () => {
  let snapshots = 0;
  let writes = 0;
  const checkpointer = new MeetingCheckpointer(
    {} as never,
    () => ({
      createSnapshot(): MeetingSnapshot {
        snapshots += 1;
        return { transcript: [], usage: [], startTime: 0, durationMs: 0, context: '', meetingMetadata: null };
      },
    }) as never,
    { async saveSnapshot() { writes += 1; } } as never,
  );

  await (checkpointer as unknown as { checkpoint: () => Promise<void> }).checkpoint();

  assert.equal(snapshots, 0);
  assert.equal(writes, 0);
});

test('MeetingCheckpointer preserves metadata on provisional checkpoints', async () => {
  const writes: Array<{ title: string; source: string; calendarEventId: string | undefined }> = [];
  const checkpointer = new MeetingCheckpointer(
    {} as never,
    () => ({
      createSnapshot(): MeetingSnapshot {
        return {
          transcript: [{ speaker: 'interviewer', text: 'hello', timestamp: Date.now(), final: true }],
          usage: [],
          startTime: Date.now() - 65_000,
          durationMs: 65_000,
          context: '[INTERVIEWER]: hello',
          meetingMetadata: {
            title: 'Roadmap Review',
            source: 'calendar',
            calendarEventId: 'evt-123',
          },
        };
      },
    }) as never,
    {
      async saveSnapshot(_meetingId: string, snapshot: MeetingSnapshot) {
        writes.push({
          title: snapshot.meetingMetadata?.title || '',
          source: snapshot.meetingMetadata?.source || 'manual',
          calendarEventId: snapshot.meetingMetadata?.calendarEventId,
        });
      },
    } as never,
  );

  checkpointer.start('meeting-4');
  await (checkpointer as unknown as { checkpoint: () => Promise<void> }).checkpoint();
  checkpointer.stop();

  assert.deepEqual(writes, [
    {
      title: 'Roadmap Review',
      source: 'calendar',
      calendarEventId: 'evt-123',
    },
  ]);
});

test('MeetingCheckpointer swallows database checkpoint errors', async () => {
  const checkpointer = new MeetingCheckpointer(
    {} as never,
    () => ({
      createSnapshot(): MeetingSnapshot {
        return {
          transcript: [{ speaker: 'interviewer', text: 'hello', timestamp: Date.now(), final: true }],
          usage: [],
          startTime: Date.now() - 5_000,
          durationMs: 5_000,
          context: '[INTERVIEWER]: hello',
          meetingMetadata: null,
        };
      },
    }) as never,
    {
      async saveSnapshot() {
        throw new Error('write failed');
      },
    } as never,
  );

  checkpointer.start('meeting-5');
  await assert.doesNotReject(async () => {
    await (checkpointer as unknown as { checkpoint: () => Promise<void> }).checkpoint();
  });
  checkpointer.stop();
});
