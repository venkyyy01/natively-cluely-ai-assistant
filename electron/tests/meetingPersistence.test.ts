import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { DatabaseManager } from '../db/DatabaseManager';
import { MeetingPersistence } from '../MeetingPersistence';
import type { Meeting } from '../db/DatabaseManager';
import type { MeetingSnapshot } from '../SessionTracker';

function installElectronMock(): () => void {
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'electron') {
      return {
        BrowserWindow: {
          getAllWindows: (): unknown[] => [],
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
