import test from 'node:test';
import assert from 'node:assert';

import {
  pauseAudioForStealth,
  resumeAudioAfterStealth,
  type StealthAudioPauseSnapshot,
} from '../audio/stealthAudioCoordinator';

test('pauseAudioForStealth stops only active captures and clears buffered audio', () => {
  const calls: string[] = [];
  const snapshot = pauseAudioForStealth({
    systemAudioCapture: {
      isCapturing: () => true,
      stop: () => calls.push('system-stop'),
      start() {},
      getSampleRate: () => 48_000,
    },
    microphoneCapture: {
      isCapturing: () => false,
      stop: () => calls.push('mic-stop'),
      start() {},
      getSampleRate: () => 44_100,
    },
    clearBufferedSystemAudio: (reason) => calls.push(`clear:${reason}`),
  }, 'screen-share');

  assert.deepEqual(calls, ['clear:stealth pause:screen-share', 'system-stop']);
  assert.deepEqual(snapshot, {
    active: true,
    reason: 'screen-share',
    systemWasCapturing: true,
    microphoneWasCapturing: false,
  });
});

test('resumeAudioAfterStealth restarts paused captures and refreshes STT sample rates', async () => {
  const calls: string[] = [];
  const snapshot: StealthAudioPauseSnapshot = {
    active: true,
    reason: 'screen-share',
    systemWasCapturing: true,
    microphoneWasCapturing: true,
  };

  await resumeAudioAfterStealth({
    systemAudioCapture: {
      start: () => calls.push('system-start'),
      stop() {},
      getSampleRate: () => 48_000,
      isCapturing: () => true,
      waitForReady: async () => 44_100,
    },
    microphoneCapture: {
      start: () => calls.push('mic-start'),
      stop() {},
      getSampleRate: () => 48_000,
      isCapturing: () => true,
    },
    interviewerStt: {
      setSampleRate: (rate) => calls.push(`interviewer-rate:${rate}`),
    },
    userStt: {
      setSampleRate: (rate) => calls.push(`user-rate:${rate}`),
    },
    setAudioChannelCount: (_stt, count) => calls.push(`channels:${count}`),
    beginSystemAudioBuffering: (reason) => calls.push(`buffer:${reason}`),
    flushBufferedSystemAudio: (reason) => calls.push(`flush:${reason}`),
  }, snapshot);

  assert.deepEqual(calls, [
    'buffer:stealth resume:screen-share',
    'system-start',
    'interviewer-rate:44100',
    'channels:1',
    'flush:stealth resume:screen-share',
    'user-rate:48000',
    'channels:1',
    'mic-start',
  ]);
});

test('resumeAudioAfterStealth reports restart failures through onError and clears buffered system audio', async () => {
  const calls: string[] = [];
  const errors: Array<{ source: string; message: string }> = [];
  const snapshot: StealthAudioPauseSnapshot = {
    active: true,
    reason: 'screen-share',
    systemWasCapturing: true,
    microphoneWasCapturing: false,
  };

  await resumeAudioAfterStealth({
    systemAudioCapture: {
      start: () => {
        throw new Error('system boom');
      },
      stop() {},
      getSampleRate: () => 48_000,
      isCapturing: () => false,
    },
    microphoneCapture: null,
    interviewerStt: null,
    userStt: null,
    setAudioChannelCount() {},
    beginSystemAudioBuffering: (reason) => calls.push(`buffer:${reason}`),
    clearBufferedSystemAudio: (reason) => calls.push(`clear:${reason}`),
    onError: (source, error) => {
      errors.push({ source, message: error.message });
    },
  }, snapshot);

  assert.deepEqual(calls, [
    'buffer:stealth resume:screen-share',
    'clear:stealth resume failed:screen-share',
  ]);
  assert.deepEqual(errors, [{ source: 'system', message: 'system boom' }]);
});
