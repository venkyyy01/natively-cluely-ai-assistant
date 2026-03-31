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
