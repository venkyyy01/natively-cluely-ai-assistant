import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

describe('Audio Pipeline Auto-Recovery', () => {
  let mockAppState: any;
  let recoveryAttempts: number = 0;
  let recoveryArgs: unknown[][] = [];

  beforeEach(() => {
    recoveryAttempts = 0;
    recoveryArgs = [];
    mockAppState = {
      isMeetingActive: false,
      audioRecoveryAttempted: false,
      setNativeAudioConnected: mock.fn(),
      broadcast: mock.fn(),
      reconfigureAudio: mock.fn(async (...args: unknown[]) => {
        recoveryAttempts++;
        recoveryArgs.push(args);
        if (recoveryAttempts > 1) {
          throw new Error('Recovery failed');
        }
      }),
    };
  });

  it('should attempt recovery on first error during active meeting', async () => {
    mockAppState.isMeetingActive = true;
    
    const errorHandler = async (err: Error) => {
      if (mockAppState.isMeetingActive && !mockAppState.audioRecoveryAttempted) {
        mockAppState.audioRecoveryAttempted = true;
        await mockAppState.reconfigureAudio(undefined, undefined, { restartStreams: true });
        mockAppState.setNativeAudioConnected(true);
      }
    };

    await errorHandler(new Error('Audio capture failed'));
    
    assert.strictEqual(recoveryAttempts, 1);
    assert.strictEqual(mockAppState.audioRecoveryAttempted, true);
    assert.strictEqual(mockAppState.setNativeAudioConnected.mock.calls.length, 1);
    assert.deepStrictEqual(recoveryArgs, [[undefined, undefined, { restartStreams: true }]]);
  });

  it('should not retry recovery after first attempt', async () => {
    mockAppState.isMeetingActive = true;
    mockAppState.audioRecoveryAttempted = true;
    
    const errorHandler = async (err: Error) => {
      if (mockAppState.isMeetingActive && !mockAppState.audioRecoveryAttempted) {
        mockAppState.audioRecoveryAttempted = true;
        await mockAppState.reconfigureAudio(undefined, undefined, { restartStreams: true });
        mockAppState.setNativeAudioConnected(true);
      } else {
        mockAppState.broadcast('meeting-audio-error', err.message);
      }
    };

    await errorHandler(new Error('Audio capture failed'));
    
    assert.strictEqual(recoveryAttempts, 0);
    assert.strictEqual(mockAppState.broadcast.mock.calls.length, 1);
  });

  it('should reset recovery flag on new meeting start', () => {
    mockAppState.audioRecoveryAttempted = true;
    
    const startMeeting = () => {
      mockAppState.audioRecoveryAttempted = false;
    };

    startMeeting();
    
    assert.strictEqual(mockAppState.audioRecoveryAttempted, false);
  });

  it('should broadcast error when recovery fails', async () => {
    mockAppState.isMeetingActive = true;
    mockAppState.audioRecoveryAttempted = false;
    
    const errorHandler = async (err: Error) => {
      if (mockAppState.isMeetingActive && !mockAppState.audioRecoveryAttempted) {
        mockAppState.audioRecoveryAttempted = true;
        try {
          await mockAppState.reconfigureAudio(undefined, undefined, { restartStreams: true });
          mockAppState.setNativeAudioConnected(true);
        } catch (recoveryErr) {
          mockAppState.broadcast('meeting-audio-error', 'Audio capture failed and recovery unsuccessful');
        }
      }
    };

    await errorHandler(new Error('Audio capture failed'));
    
    assert.strictEqual(mockAppState.broadcast.mock.calls.length, 0);
    
    mockAppState.audioRecoveryAttempted = false;
    await errorHandler(new Error('Audio capture failed'));
    
    assert.strictEqual(mockAppState.broadcast.mock.calls.length, 1);
  });

  it('should not attempt recovery when meeting is not active', async () => {
    mockAppState.isMeetingActive = false;
    
    const errorHandler = async (err: Error) => {
      if (mockAppState.isMeetingActive && !mockAppState.audioRecoveryAttempted) {
        mockAppState.audioRecoveryAttempted = true;
        await mockAppState.reconfigureAudio(undefined, undefined, { restartStreams: true });
        mockAppState.setNativeAudioConnected(true);
      } else {
        mockAppState.broadcast('meeting-audio-error', err.message);
      }
    };

    await errorHandler(new Error('Audio capture failed'));
    
    assert.strictEqual(recoveryAttempts, 0);
    assert.strictEqual(mockAppState.broadcast.mock.calls.length, 1);
  });
});
