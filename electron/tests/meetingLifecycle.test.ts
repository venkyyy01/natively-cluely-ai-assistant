import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

describe('Meeting Lifecycle Race Conditions', () => {
  let mockState: any;
  let listenerCount: number = 0;

  beforeEach(() => {
    listenerCount = 0;
    mockState = {
      isMeetingActive: false,
      meetingLifecycleState: 'idle',
      meetingStartSequence: 0,
      systemAudioCapture: null,
      microphoneCapture: null,
      googleSTT: null,
      googleSTT_User: null,
      audioRecoveryAttempted: false,
      removeAllListeners: mock.fn(() => {
        listenerCount++;
      }),
    };
  });

  it('should handle start→end race conditions', async () => {
    const startPromise = (async () => {
      mockState.meetingLifecycleState = 'starting';
      mockState.meetingStartSequence++;
      await new Promise(resolve => setTimeout(resolve, 10));
      mockState.isMeetingActive = true;
      mockState.meetingLifecycleState = 'active';
    })();

    const endPromise = (async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      mockState.meetingLifecycleState = 'stopping';
      mockState.isMeetingActive = false;
    })();

    await Promise.all([startPromise, endPromise]);
    
    assert.strictEqual(mockState.isMeetingActive, false);
    assert.ok(['idle', 'stopping'].includes(mockState.meetingLifecycleState));
  });

  it('should cleanup all listeners on end', () => {
    mockState.systemAudioCapture = { removeAllListeners: mockState.removeAllListeners };
    mockState.microphoneCapture = { removeAllListeners: mockState.removeAllListeners };
    mockState.googleSTT = { removeAllListeners: mockState.removeAllListeners };
    mockState.googleSTT_User = { removeAllListeners: mockState.removeAllListeners };

    const endMeeting = () => {
      mockState.systemAudioCapture?.removeAllListeners();
      mockState.microphoneCapture?.removeAllListeners();
      mockState.googleSTT?.removeAllListeners();
      mockState.googleSTT_User?.removeAllListeners();
    };

    endMeeting();
    
    assert.strictEqual(listenerCount, 4);
  });

  it('should save meeting data on forced quit', async () => {
    let savedMeetingData: any = null;
    const mockPersistence = {
      waitForPendingSaves: mock.fn(async (timeout: number) => {
        savedMeetingData = { transcript: [], usage: [] };
      }),
    };

    const beforeQuit = async () => {
      await mockPersistence.waitForPendingSaves(10000);
    };

    await beforeQuit();
    
    assert.strictEqual(mockPersistence.waitForPendingSaves.mock.calls.length, 1);
    assert.strictEqual(mockPersistence.waitForPendingSaves.mock.calls[0].arguments[0], 10000);
    assert.ok(savedMeetingData !== null);
  });

  it('should prevent duplicate meeting starts', async () => {
    let startCount = 0;
    const meetingStartMutex = Promise.resolve();

    const startMeeting = async (sequence: number) => {
      if (mockState.meetingLifecycleState === 'starting' || mockState.meetingLifecycleState === 'active') {
        return;
      }
      mockState.meetingLifecycleState = 'starting';
      mockState.meetingStartSequence = sequence;
      startCount++;
      mockState.isMeetingActive = true;
      mockState.meetingLifecycleState = 'active';
    };

    await Promise.all([
      startMeeting(1),
      startMeeting(2),
    ]);

    assert.strictEqual(startCount, 1);
  });

  it('should invalidate pending starts on end', async () => {
    let invalidatedSequence = 0;
    
    const startMeeting = async (sequence: number) => {
      mockState.meetingLifecycleState = 'starting';
      mockState.meetingStartSequence = sequence;
      await new Promise(resolve => setTimeout(resolve, 50));
      
      if (sequence !== mockState.meetingStartSequence) {
        invalidatedSequence = sequence;
        return;
      }
      
      mockState.meetingLifecycleState = 'active';
    };

    const endMeeting = () => {
      mockState.meetingStartSequence++;
      mockState.meetingLifecycleState = 'stopping';
    };

    const startPromise = startMeeting(1);
    endMeeting();
    await startPromise;

    assert.strictEqual(invalidatedSequence, 1);
  });

  it('should reset audio recovery flag on each new meeting', () => {
    mockState.audioRecoveryAttempted = true;

    const startMeeting = () => {
      mockState.audioRecoveryAttempted = false;
      mockState.isMeetingActive = true;
    };

    startMeeting();
    
    assert.strictEqual(mockState.audioRecoveryAttempted, false);

    startMeeting();
    
    assert.strictEqual(mockState.audioRecoveryAttempted, false);
  });
});
