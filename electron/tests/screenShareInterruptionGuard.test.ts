import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectExternalScreenShare,
  resolveSafeSystemAudioDeviceId,
} from '../stealth/screenShareInterruptionGuard';

test('detectExternalScreenShare reports inactive on non-macOS platforms', async () => {
  const snapshot = await detectExternalScreenShare({
    platform: 'linux',
    processEnumerator: async () => {
      throw new Error('should not enumerate processes');
    },
  });

  assert.deepEqual(snapshot, {
    active: false,
    reason: 'unsupported-platform',
    processLines: [],
  });
});

test('detectExternalScreenShare reports inactive when ScreenCaptureAgent is absent', async () => {
  const snapshot = await detectExternalScreenShare({
    platform: 'darwin',
    processEnumerator: async () => '',
  });

  assert.deepEqual(snapshot, {
    active: false,
    reason: 'no-screen-capture-agent',
    processLines: [],
  });
});

test('detectExternalScreenShare treats active ScreenCaptureAgent as an interruption risk', async () => {
  const calls: string[] = [];
  const snapshot = await detectExternalScreenShare({
    platform: 'darwin',
    processEnumerator: async (_command, args) => {
      calls.push(args.join(' '));
      if (args.includes('ScreenCaptureAgent')) {
        return '123 /System/Library/CoreServices/ScreenCaptureAgent\n';
      }
      return '456 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n';
    },
  });

  assert.equal(snapshot.active, true);
  assert.equal(snapshot.reason, 'screen-capture-agent-with-meeting-app');
  assert.equal(snapshot.processLines.length, 2);
  assert.deepEqual(calls, [
    '-lf ScreenCaptureAgent',
    '-lf Google Chrome|Chromium|Microsoft Edge|Brave Browser|Microsoft Teams|teams2|zoom\\.us|Slack|Webex|Loom|Discord',
  ]);
});

test('resolveSafeSystemAudioDeviceId downgrades ScreenCaptureKit while an external screen share is active', () => {
  const resolvedDeviceId = resolveSafeSystemAudioDeviceId('sck', {
    active: true,
    reason: 'screen-capture-agent-with-meeting-app',
    processLines: [
      '123 /System/Library/CoreServices/ScreenCaptureAgent',
      '456 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ],
  });

  assert.equal(resolvedDeviceId, undefined);
});
