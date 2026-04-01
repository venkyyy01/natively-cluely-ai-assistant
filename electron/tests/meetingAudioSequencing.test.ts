import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configureMeetingAudioPipeline,
  restartMeetingAudioStreamsAfterReconfigure,
  startMeetingAudioStreams,
} from '../audio/meetingAudioSequencing';

test('configureMeetingAudioPipeline uses cached system rate before capture start', () => {
  const calls: string[] = [];
  const interviewerStt = {
    setSampleRate(rate: number) {
      calls.push(`interviewer:setSampleRate:${rate}`);
    },
  };
  const userStt = {
    setSampleRate(rate: number) {
      calls.push(`user:setSampleRate:${rate}`);
    },
  };

  const rates = configureMeetingAudioPipeline({
    systemAudioCapture: {
      getSampleRate: () => 48_000,
    },
    microphoneCapture: {
      getSampleRate: () => 44_100,
    },
    interviewerStt,
    userStt,
    setAudioChannelCount(stt, count) {
      calls.push(`${stt === interviewerStt ? 'interviewer' : 'user'}:setChannels:${count}`);
    },
  });

  assert.deepEqual(rates, { systemRate: 48_000, microphoneRate: 44_100 });
  assert.deepEqual(calls, [
    'interviewer:setSampleRate:48000',
    'interviewer:setChannels:1',
    'user:setSampleRate:44100',
    'user:setChannels:1',
  ]);
});

test('startMeetingAudioStreams waits for native system audio readiness before starting interviewer STT', async () => {
  const calls: string[] = [];

  const interviewerStt = {
    setSampleRate(rate: number) {
      calls.push(`interviewer:setSampleRate:${rate}`);
    },
    start() {
      calls.push('interviewer:start');
    },
  };
  const userStt = {
    setSampleRate(rate: number) {
      calls.push(`user:setSampleRate:${rate}`);
    },
    start() {
      calls.push('user:start');
    },
  };

  const rates = await startMeetingAudioStreams({
    systemAudioCapture: {
      start() {
        calls.push('system:start');
      },
      async waitForReady() {
        calls.push('system:waitForReady');
        return 44_100;
      },
      getSampleRate() {
        calls.push('system:getSampleRate');
        return 48_000;
      },
    },
    microphoneCapture: {
      start() {
        calls.push('mic:start');
      },
      getSampleRate() {
        calls.push('mic:getSampleRate');
        return 48_000;
      },
    },
    interviewerStt,
    userStt,
    setAudioChannelCount(stt, count) {
      calls.push(`${stt === interviewerStt ? 'interviewer' : 'user'}:setChannels:${count}`);
    },
  });

  assert.deepEqual(rates, { systemRate: 44_100, microphoneRate: 48_000 });
  assert.deepEqual(calls, [
    'system:start',
    'system:waitForReady',
    'interviewer:setSampleRate:44100',
    'interviewer:setChannels:1',
    'mic:getSampleRate',
    'user:setSampleRate:48000',
    'user:setChannels:1',
    'interviewer:start',
    'user:start',
    'mic:start',
  ]);
});

test('restartMeetingAudioStreamsAfterReconfigure buffers system audio until interviewer STT is reconnected', async () => {
  const calls: string[] = [];

  await restartMeetingAudioStreamsAfterReconfigure({
    systemAudioCapture: {
      start() {
        calls.push('system:start');
      },
      async waitForReady() {
        calls.push('system:waitForReady');
        return 44_100;
      },
      getSampleRate() {
        calls.push('system:getSampleRate');
        return 48_000;
      },
    },
    microphoneCapture: {
      start() {
        calls.push('mic:start');
      },
      getSampleRate() {
        calls.push('mic:getSampleRate');
        return 48_000;
      },
    },
    beforeSystemAudioStart() {
      calls.push('system:buffering');
    },
    reconnectInterviewerStt: async (rate: number) => {
      calls.push(`interviewer:reconnect:${rate}`);
    },
    afterInterviewerSttReady() {
      calls.push('system:flush');
    },
    reconnectUserStt: async () => {
      calls.push('user:reconnect');
    },
  });

  assert.deepEqual(calls, [
    'system:buffering',
    'system:start',
    'system:waitForReady',
    'interviewer:reconnect:44100',
    'system:flush',
    'user:reconnect',
    'mic:start',
  ]);
});
