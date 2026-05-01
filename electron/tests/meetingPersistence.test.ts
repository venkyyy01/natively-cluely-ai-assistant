import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { DatabaseManager } from '../db/DatabaseManager';
import { MeetingPersistence } from '../MeetingPersistence';
import type { Meeting } from '../db/DatabaseManager';
import type { MeetingSnapshot } from '../SessionTracker';

function installElectronMock(windows: unknown[] = []): () => void {
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'electron') {
      return {
        BrowserWindow: {
          getAllWindows: (): unknown[] => windows,
        },
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

test('MeetingPersistence uses the meeting start time for placeholder records', async () => {
  const placeholderWrites: Meeting[] = [];
  const finalizedWrites: Meeting[] = [];
  const originalGetInstance = DatabaseManager.getInstance;
  const restoreElectron = installElectronMock();
  const startTime = Date.UTC(2024, 0, 2, 3, 4, 5);

  DatabaseManager.getInstance = ((() => ({
    createOrUpdateMeetingProcessingRecord(meeting: Meeting) {
      placeholderWrites.push(meeting);
    },
    finalizeMeetingProcessing(meeting: Meeting) {
      finalizedWrites.push(meeting);
    },
    markMeetingProcessingFailed() {
      return false;
    },
  })) as unknown) as typeof DatabaseManager.getInstance;

  try {
    const persistence = new MeetingPersistence(
      {
        flushInterimTranscript() {},
        createSnapshot(): MeetingSnapshot {
          return {
            transcript: [{ speaker: 'interviewer', text: 'hello', timestamp: startTime, final: true }],
            usage: [],
            startTime,
            durationMs: 5_000,
            context: '[INTERVIEWER]: hello',
            meetingMetadata: null,
          };
        },
        async flushPersistenceNow() {},
        createSuccessorSession() {
          return this;
        },
      } as never,
      {
        generateMeetingSummary: async () => 'Recovered Title',
      } as never,
    );

    await persistence.stopMeeting('meeting-1');
    await persistence.waitForPendingSaves();

    assert.equal(placeholderWrites[0]?.date, new Date(startTime).toISOString());
    assert.equal(finalizedWrites[0]?.date, new Date(startTime).toISOString());
  } finally {
    DatabaseManager.getInstance = originalGetInstance;
    restoreElectron();
  }
});

test('MeetingPersistence regenerates titles for recovered placeholder meetings', async () => {
  const finalizedWrites: Meeting[] = [];
  const originalGetInstance = DatabaseManager.getInstance;
  const restoreElectron = installElectronMock();
  const originalDate = '2024-01-02T03:04:05.000Z';

  DatabaseManager.getInstance = ((() => ({
    getUnprocessedMeetings() {
      return [{ id: 'meeting-2' }];
    },
    getMeetingDetails() {
      return {
        id: 'meeting-2',
        title: 'Processing...',
        date: originalDate,
        duration: '1:00',
        summary: '',
        detailedSummary: { actionItems: [] as string[], keyPoints: [] as string[] },
        calendarEventId: undefined as string | undefined,
        source: 'manual',
        transcript: [
          { speaker: 'interviewer', text: 'one', timestamp: 1 },
          { speaker: 'user', text: 'two', timestamp: 2 },
          { speaker: 'interviewer', text: 'three', timestamp: 3 },
        ],
        usage: [] as Meeting['usage'],
      };
    },
    finalizeMeetingProcessing(meeting: Meeting) {
      finalizedWrites.push(meeting);
    },
  })) as unknown) as typeof DatabaseManager.getInstance;

  try {
    const persistence = new MeetingPersistence(
      { createSnapshot() { throw new Error('unused'); } } as never,
      {
        generateMeetingSummary: async (prompt: string) => {
          if (prompt.includes('Generate a concise 3-6 word title')) {
            return 'Recovered Title';
          }

          return JSON.stringify({ overview: 'Recovered overview', keyPoints: [], actionItems: [] });
        },
      } as never,
    );

    await persistence.recoverUnprocessedMeetings();

    assert.equal(finalizedWrites[0]?.title, 'Recovered Title');
    assert.equal(finalizedWrites[0]?.date, originalDate);
  } finally {
    DatabaseManager.getInstance = originalGetInstance;
    restoreElectron();
  }
});

test('MeetingPersistence regenerates titles when metadata carries a placeholder title', async () => {
  const finalizedWrites: Meeting[] = [];
  const originalGetInstance = DatabaseManager.getInstance;
  const restoreElectron = installElectronMock();
  const llmCalls: string[] = [];

  DatabaseManager.getInstance = ((() => ({
    finalizeMeetingProcessing(meeting: Meeting) {
      finalizedWrites.push(meeting);
    },
    markMeetingProcessingFailed() {
      return false;
    },
  })) as unknown) as typeof DatabaseManager.getInstance;

  try {
    const persistence = new MeetingPersistence(
      { createSnapshot() { throw new Error('unused'); } } as never,
      {
        generateMeetingSummary: async (prompt: string) => {
          llmCalls.push(prompt);
          return 'Recovered Title';
        },
      } as never,
    );

    await (persistence as unknown as {
      processAndSaveMeeting: (snapshot: MeetingSnapshot, meetingId: string) => Promise<void>;
    }).processAndSaveMeeting({
      transcript: [
        { speaker: 'interviewer', text: 'one', timestamp: 1, final: true },
        { speaker: 'user', text: 'two', timestamp: 2, final: true },
      ],
      usage: [],
      startTime: 65_000,
      durationMs: 65_000,
      context: '[INTERVIEWER]: one\n[ME]: two',
      meetingMetadata: {
        title: 'Processing...',
        source: 'manual',
      },
    }, 'meeting-placeholder-title');

    assert.ok(llmCalls.some(prompt => prompt.includes('Generate a concise 3-6 word title')));
    assert.equal(finalizedWrites[0]?.title, 'Recovered Title');
  } finally {
    DatabaseManager.getInstance = originalGetInstance;
    restoreElectron();
  }
});

test('MeetingPersistence skips placeholder and background saves for meetings shorter than one second', async () => {
  const placeholderWrites: Meeting[] = [];
  const finalizedWrites: Meeting[] = [];
  const originalGetInstance = DatabaseManager.getInstance;
  const restoreElectron = installElectronMock();
  const successorSession = { id: 'successor' };

  DatabaseManager.getInstance = ((() => ({
    createOrUpdateMeetingProcessingRecord(meeting: Meeting) {
      placeholderWrites.push(meeting);
    },
    finalizeMeetingProcessing(meeting: Meeting) {
      finalizedWrites.push(meeting);
    },
    markMeetingProcessingFailed() {
      return false;
    },
  })) as unknown) as typeof DatabaseManager.getInstance;

  try {
    const persistence = new MeetingPersistence(
      {
        flushInterimTranscript() {},
        createSnapshot(): MeetingSnapshot {
          return {
            transcript: [{ speaker: 'interviewer', text: 'hello', timestamp: 1, final: true }],
            usage: [],
            startTime: 1,
            durationMs: 999,
            context: '[INTERVIEWER]: hello',
            meetingMetadata: null,
          };
        },
        async flushPersistenceNow() {},
        createSuccessorSession() {
          return successorSession;
        },
      } as never,
      {
        generateMeetingSummary: async () => 'unused',
      } as never,
    );

    const returnedSession = await persistence.stopMeeting('meeting-short');

    assert.equal(returnedSession, successorSession);
    assert.deepEqual(placeholderWrites, []);
    assert.deepEqual(finalizedWrites, []);
  } finally {
    DatabaseManager.getInstance = originalGetInstance;
    restoreElectron();
  }
});

test('MeetingPersistence waits for pending saves and tolerates timeout expiry', async () => {
  const persistence = new MeetingPersistence({} as never, {} as never);
  const pendingSaves = (persistence as unknown as { pendingSaves: Set<Promise<void>> }).pendingSaves;
  pendingSaves.add(new Promise<void>(() => {}));

  await assert.doesNotReject(async () => {
    await persistence.waitForPendingSaves(1);
  });

  assert.equal(pendingSaves.size, 1);
});

test('MeetingPersistence reuses meaningful metadata titles and skips summary generation for short transcripts', async () => {
  const finalizedWrites: Meeting[] = [];
  const originalGetInstance = DatabaseManager.getInstance;
  const restoreElectron = installElectronMock();
  const llmCalls: string[] = [];

  DatabaseManager.getInstance = ((() => ({
    finalizeMeetingProcessing(meeting: Meeting) {
      finalizedWrites.push(meeting);
    },
    markMeetingProcessingFailed() {
      return false;
    },
  })) as unknown) as typeof DatabaseManager.getInstance;

  try {
    const persistence = new MeetingPersistence(
      { createSnapshot() { throw new Error('unused'); } } as never,
      {
        generateMeetingSummary: async (prompt: string) => {
          llmCalls.push(prompt);
          return 'unused';
        },
      } as never,
    );

    await (persistence as unknown as {
      processAndSaveMeeting: (snapshot: MeetingSnapshot, meetingId: string) => Promise<void>;
    }).processAndSaveMeeting({
      transcript: [
        { speaker: 'interviewer', text: 'one', timestamp: 1, final: true },
        { speaker: 'user', text: 'two', timestamp: 2, final: true },
      ],
      usage: [],
      startTime: 65_000,
      durationMs: 65_000,
      context: '[INTERVIEWER]: one\n[ME]: two',
      meetingMetadata: {
        title: 'Calendar Sync',
        calendarEventId: 'evt-123',
        source: 'calendar',
      },
    }, 'meeting-calendar');

    assert.deepEqual(llmCalls, []);
    assert.equal(finalizedWrites[0]?.title, 'Calendar Sync');
    assert.equal(finalizedWrites[0]?.source, 'calendar');
    assert.equal(finalizedWrites[0]?.calendarEventId, 'evt-123');
    assert.deepEqual(finalizedWrites[0]?.detailedSummary, { actionItems: [], keyPoints: [] });
  } finally {
    DatabaseManager.getInstance = originalGetInstance;
    restoreElectron();
  }
});

test('MeetingPersistence marks failed finalization attempts and notifies listeners', async () => {
  const originalGetInstance = DatabaseManager.getInstance;
  const notifications: string[] = [];
  const restoreElectron = installElectronMock([
    {
      webContents: {
        send(channel: string) {
          notifications.push(channel);
        },
      },
    },
  ]);
  const failed: Array<{ id: string; message: string }> = [];

  DatabaseManager.getInstance = ((() => ({
    finalizeMeetingProcessing() {
      throw new Error('persist failed');
    },
    markMeetingProcessingFailed(id: string, error: unknown) {
      failed.push({
        id,
        message: error instanceof Error ? error.message : String(error),
      });
      return true;
    },
  })) as unknown) as typeof DatabaseManager.getInstance;

  try {
    const persistence = new MeetingPersistence(
      { createSnapshot() { throw new Error('unused'); } } as never,
      { generateMeetingSummary: async () => 'unused' } as never,
    );

    await (persistence as unknown as {
      processAndSaveMeeting: (snapshot: MeetingSnapshot, meetingId: string) => Promise<void>;
    }).processAndSaveMeeting({
      transcript: [
        { speaker: 'interviewer', text: 'one', timestamp: 1, final: true },
        { speaker: 'user', text: 'two', timestamp: 2, final: true },
      ],
      usage: [],
      startTime: 65_000,
      durationMs: 65_000,
      context: '[INTERVIEWER]: one\n[ME]: two',
      meetingMetadata: null,
    }, 'meeting-finalize-error');

    assert.deepEqual(failed, [{ id: 'meeting-finalize-error', message: 'persist failed' }]);
    assert.deepEqual(notifications, ['meeting-save-failed', 'meetings-updated']);
  } finally {
    DatabaseManager.getInstance = originalGetInstance;
    restoreElectron();
  }
});

test('MeetingPersistence retries final save failures before succeeding', async () => {
  const originalGetInstance = DatabaseManager.getInstance;
  const restoreElectron = installElectronMock();
  let finalizeCalls = 0;
  const failed: string[] = [];

  DatabaseManager.getInstance = ((() => ({
    finalizeMeetingProcessing() {
      finalizeCalls += 1;
      if (finalizeCalls < 3) {
        throw new Error(`persist failed ${finalizeCalls}`);
      }
    },
    markMeetingProcessingFailed(id: string) {
      failed.push(id);
      return true;
    },
  })) as unknown) as typeof DatabaseManager.getInstance;

  try {
    const persistence = new MeetingPersistence(
      { createSnapshot() { throw new Error('unused'); } } as never,
      { generateMeetingSummary: async () => 'unused' } as never,
      { finalizeRetryDelaysMs: [0, 0] },
    );

    await (persistence as unknown as {
      processAndSaveMeeting: (snapshot: MeetingSnapshot, meetingId: string) => Promise<void>;
    }).processAndSaveMeeting({
      transcript: [
        { speaker: 'interviewer', text: 'one', timestamp: 1, final: true },
        { speaker: 'user', text: 'two', timestamp: 2, final: true },
      ],
      usage: [],
      startTime: 65_000,
      durationMs: 65_000,
      context: '[INTERVIEWER]: one\n[ME]: two',
      meetingMetadata: null,
    }, 'meeting-retry-success');

    assert.equal(finalizeCalls, 3);
    assert.deepEqual(failed, []);
  } finally {
    DatabaseManager.getInstance = originalGetInstance;
    restoreElectron();
  }
});

test('MeetingPersistence emits meeting-save-failed after exhausting final save retries', async () => {
  const originalGetInstance = DatabaseManager.getInstance;
  const notifications: Array<{ channel: string; payload: unknown }> = [];
  const restoreElectron = installElectronMock([
    {
      webContents: {
        send(channel: string, payload?: unknown) {
          notifications.push({ channel, payload });
        },
      },
    },
  ]);
  let finalizeCalls = 0;

  DatabaseManager.getInstance = ((() => ({
    finalizeMeetingProcessing() {
      finalizeCalls += 1;
      throw new Error('persist failed');
    },
    markMeetingProcessingFailed() {
      return true;
    },
  })) as unknown) as typeof DatabaseManager.getInstance;

  try {
    const persistence = new MeetingPersistence(
      { createSnapshot() { throw new Error('unused'); } } as never,
      { generateMeetingSummary: async () => 'unused' } as never,
      { finalizeRetryDelaysMs: [0, 0] },
    );

    await (persistence as unknown as {
      processAndSaveMeeting: (snapshot: MeetingSnapshot, meetingId: string) => Promise<void>;
    }).processAndSaveMeeting({
      transcript: [
        { speaker: 'interviewer', text: 'one', timestamp: 1, final: true },
        { speaker: 'user', text: 'two', timestamp: 2, final: true },
      ],
      usage: [],
      startTime: 65_000,
      durationMs: 65_000,
      context: '[INTERVIEWER]: one\n[ME]: two',
      meetingMetadata: null,
    }, 'meeting-retry-failed');

    assert.equal(finalizeCalls, 3);
    assert.deepEqual(notifications, [
      { channel: 'meeting-save-failed', payload: { meetingId: 'meeting-retry-failed', retryCount: 3, error: 'persist failed' } },
      { channel: 'meetings-updated', payload: undefined },
    ]);
  } finally {
    DatabaseManager.getInstance = originalGetInstance;
    restoreElectron();
  }
});

test('MeetingPersistence parses duration strings defensively', () => {
  const persistence = new MeetingPersistence({} as never, {} as never);
  const internals = persistence as unknown as { parseDurationToMs: (duration: string) => number };

  assert.equal(internals.parseDurationToMs('1:05'), 65_000);
  assert.equal(internals.parseDurationToMs('1:01:01'), 3_661_000);
  assert.equal(internals.parseDurationToMs('not-a-duration'), 0);
  assert.equal(internals.parseDurationToMs('12'), 0);
});

test('MeetingPersistence accepts session replacement and derives fallback meeting dates', () => {
  const initialSession = {
    flushInterimTranscript() {},
    createSnapshot() { throw new Error('unused'); },
    createSuccessorSession() { return this; },
  };
  const replacementSession = {
    flushInterimTranscript() {},
    createSnapshot() { throw new Error('unused'); },
    createSuccessorSession() { return this; },
  };
  const persistence = new MeetingPersistence(initialSession as never, {} as never);
  const internals = persistence as unknown as {
    session: unknown;
    toMeetingDate: (startTimeMs: number, fallbackDate?: string) => string;
  };

  persistence.setSession(replacementSession as never);

  assert.equal(internals.session, replacementSession);
  assert.equal(internals.toMeetingDate(0, '2024-02-03T04:05:06.000Z'), '2024-02-03T04:05:06.000Z');

  const derivedDate = internals.toMeetingDate(0, 'not-a-date');
  assert.ok(!Number.isNaN(Date.parse(derivedDate)));
});

test('MeetingPersistence falls back to placeholder titles and manual source for provisional saves', async () => {
  const placeholderWrites: Meeting[] = [];
  const originalGetInstance = DatabaseManager.getInstance;
  const restoreElectron = installElectronMock();

  DatabaseManager.getInstance = ((() => ({
    createOrUpdateMeetingProcessingRecord(meeting: Meeting) {
      placeholderWrites.push(meeting);
    },
    finalizeMeetingProcessing() {},
    markMeetingProcessingFailed() {
      return false;
    },
  })) as unknown) as typeof DatabaseManager.getInstance;

  try {
    const persistence = new MeetingPersistence(
      {
        flushInterimTranscript() {},
        createSnapshot(): MeetingSnapshot {
          return {
            transcript: [
              { speaker: 'interviewer', text: 'hello', timestamp: 1, final: true },
              { speaker: 'user', text: 'world', timestamp: 2, final: true },
            ],
            usage: [],
            startTime: 5_000,
            durationMs: 5_000,
            context: '[INTERVIEWER]: hello\n[ME]: world',
            meetingMetadata: {
              title: 'Processing...',
            },
          };
        },
        async flushPersistenceNow() {},
        createSuccessorSession() {
          return this;
        },
      } as never,
      {
        generateMeetingSummary: async () => 'unused',
      } as never,
    );

    await persistence.stopMeeting('meeting-placeholder');

    assert.equal(placeholderWrites[0]?.title, 'Processing...');
    assert.equal(placeholderWrites[0]?.source, 'manual');
  } finally {
    DatabaseManager.getInstance = originalGetInstance;
    restoreElectron();
  }
});

test('MeetingPersistence waits for tracker flush before snapshotting', async () => {
  const originalGetInstance = DatabaseManager.getInstance;
  const restoreElectron = installElectronMock();
  const callOrder: string[] = [];

  DatabaseManager.getInstance = ((() => ({
    createOrUpdateMeetingProcessingRecord() {},
    finalizeMeetingProcessing() {},
    markMeetingProcessingFailed() {
      return false;
    },
  })) as unknown) as typeof DatabaseManager.getInstance;

  try {
    let releaseFlush: (() => void) | null = null;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });

    const persistence = new MeetingPersistence(
      {
        flushInterimTranscript() {
          callOrder.push('flushInterim');
        },
        async flushPersistenceNow() {
          callOrder.push('flushPersistence:start');
          await flushGate;
          callOrder.push('flushPersistence:end');
        },
        createSnapshot(): MeetingSnapshot {
          callOrder.push('createSnapshot');
          return {
            transcript: [
              { speaker: 'interviewer', text: 'hello', timestamp: 1, final: true },
              { speaker: 'user', text: 'world', timestamp: 2, final: true },
            ],
            usage: [],
            startTime: 5_000,
            durationMs: 5_000,
            context: '[INTERVIEWER]: hello\n[ME]: world',
            meetingMetadata: null,
          };
        },
        createSuccessorSession() {
          callOrder.push('createSuccessor');
          return this;
        },
      } as never,
      {
        generateMeetingSummary: async () => 'unused',
      } as never,
    );

    const stopPromise = persistence.stopMeeting('meeting-flush-order');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(callOrder, ['flushInterim', 'flushPersistence:start']);

    releaseFlush?.();
    await stopPromise;

    assert.ok(callOrder.indexOf('createSnapshot') > callOrder.indexOf('flushPersistence:end'));
  } finally {
    DatabaseManager.getInstance = originalGetInstance;
    restoreElectron();
  }
});

test('MeetingPersistence tracks the final save so callers can wait for it before downstream processing', async () => {
  const originalGetInstance = DatabaseManager.getInstance;
  const restoreElectron = installElectronMock();
  const callOrder: string[] = [];
  let releaseSave: (() => void) | null = null;

  DatabaseManager.getInstance = ((() => ({
    createOrUpdateMeetingProcessingRecord() {},
    finalizeMeetingProcessing() {},
    markMeetingProcessingFailed() {
      return false;
    },
  })) as unknown) as typeof DatabaseManager.getInstance;

  try {
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });

    const persistence = new MeetingPersistence(
      {
        flushInterimTranscript() {},
        async flushPersistenceNow() {},
        createSnapshot(): MeetingSnapshot {
          return {
            transcript: [
              { speaker: 'interviewer', text: 'hello', timestamp: 1, final: true },
              { speaker: 'user', text: 'world', timestamp: 2, final: true },
            ],
            usage: [],
            startTime: 5_000,
            durationMs: 5_000,
            context: '[INTERVIEWER]: hello\n[ME]: world',
            meetingMetadata: null,
          };
        },
        createSuccessorSession() {
          return this;
        },
      } as never,
      {
        generateMeetingSummary: async () => 'unused',
      } as never,
    );

    (persistence as unknown as {
      processAndSaveMeeting: (snapshot: MeetingSnapshot, meetingId: string) => Promise<void>;
    }).processAndSaveMeeting = async (_snapshot: MeetingSnapshot, meetingId: string) => {
      callOrder.push(`save:start:${meetingId}`);
      await saveGate;
      callOrder.push(`save:end:${meetingId}`);
    };

    const stopPromise = persistence.stopMeeting('meeting-pending-save');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(callOrder, ['save:start:meeting-pending-save']);
    assert.equal((persistence as unknown as { pendingSaves: Set<Promise<void>> }).pendingSaves.size, 1);

    const waitPromise = persistence.waitForPendingSaves(1000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(callOrder, ['save:start:meeting-pending-save']);

    releaseSave?.();
    await stopPromise;
    await waitPromise;

    assert.deepEqual(callOrder, [
      'save:start:meeting-pending-save',
      'save:end:meeting-pending-save',
    ]);
    assert.equal((persistence as unknown as { pendingSaves: Set<Promise<void>> }).pendingSaves.size, 0);
  } finally {
    DatabaseManager.getInstance = originalGetInstance;
    restoreElectron();
  }
});

test('MeetingPersistence no-ops recovery when there are no unfinished meetings or details', async () => {
  const originalGetInstance = DatabaseManager.getInstance;
  const restoreElectron = installElectronMock();
  let detailsLookups = 0;

  try {
    DatabaseManager.getInstance = ((() => ({
      getUnprocessedMeetings(): Array<{ id: string }> {
        return [];
      },
      getMeetingDetails(): null {
        detailsLookups += 1;
        return null;
      },
    })) as unknown) as typeof DatabaseManager.getInstance;

    const persistence = new MeetingPersistence(
      { createSnapshot() { throw new Error('unused'); } } as never,
      { generateMeetingSummary: async () => 'unused' } as never,
    );
    await persistence.recoverUnprocessedMeetings();
    assert.equal(detailsLookups, 0);

    DatabaseManager.getInstance = ((() => ({
      getUnprocessedMeetings(): Array<{ id: string }> {
        return [{ id: 'meeting-missing' }];
      },
      getMeetingDetails(): null {
        detailsLookups += 1;
        return null;
      },
    })) as unknown) as typeof DatabaseManager.getInstance;

    await persistence.recoverUnprocessedMeetings();
    assert.equal(detailsLookups, 1);
  } finally {
    DatabaseManager.getInstance = originalGetInstance;
    restoreElectron();
  }
});
