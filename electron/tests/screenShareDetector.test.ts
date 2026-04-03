import test from 'node:test';
import assert from 'node:assert';

import { ScreenShareDetector } from '../stealth/ScreenShareDetector';

const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

test('ScreenShareDetector does not report active sharing on Windows from process presence alone', async () => {
  const detector = new ScreenShareDetector({
    platform: 'win32',
    logger: silentLogger,
    signatures: [
      {
        name: 'Zoom',
        processNames: ['Zoom.exe'],
        windowTitles: ['You are screen sharing'],
      },
    ],
    execCommand: async (command) => {
      if (command === 'tasklist') {
        return '"Zoom.exe","1024","Console","1","25,000 K"\n';
      }

      return '';
    },
    now: () => 123,
  });

  const status = await detector.detect();

  assert.deepEqual(status, {
    active: false,
    confidence: 'low',
    source: 'heuristic',
    timestamp: 123,
    matches: [],
  });
});

test('ScreenShareDetector treats a Windows share window as active and upgrades confidence when the process also matches', async () => {
  const detector = new ScreenShareDetector({
    platform: 'win32',
    logger: silentLogger,
    signatures: [
      {
        name: 'Zoom',
        processNames: ['Zoom.exe'],
        windowTitles: ['You are screen sharing'],
      },
    ],
    execCommand: async (command) => {
      if (command === 'tasklist') {
        return '"Zoom.exe","1024","Console","1","25,000 K"\n';
      }

      if (command === 'powershell') {
        return 'Zoom|You are screen sharing\n';
      }

      return '';
    },
    now: () => 456,
  });

  const status = await detector.detect();

  assert.deepEqual(status, {
    active: true,
    confidence: 'high',
    source: 'window',
    timestamp: 456,
    matches: ['Zoom:You are screen sharing', 'Zoom:Zoom.exe'],
  });
});

test('ScreenShareDetector falls back to window-title detection', async () => {
  const detector = new ScreenShareDetector({
    platform: 'win32',
    logger: silentLogger,
    signatures: [
      {
        name: 'Microsoft Teams',
        processNames: ['Teams.exe'],
        windowTitles: ["You're presenting"],
      },
    ],
    execCommand: async (command) => {
      if (command === 'powershell') {
        return "Teams|You're presenting to everyone\n";
      }

      return '';
    },
  });

  const status = await detector.detect();

  assert.equal(status.active, true);
  assert.equal(status.source, 'window');
  assert.deepEqual(status.matches, ["Microsoft Teams:You're presenting"]);
});

test('ScreenShareDetector returns inactive when nothing matches', async () => {
  const detector = new ScreenShareDetector({
    platform: 'win32',
    logger: silentLogger,
    signatures: [
      {
        name: 'Loom',
        processNames: ['Loom.exe'],
        windowTitles: ['Recording'],
      },
    ],
    execCommand: async () => '',
  });

  const status = await detector.detect();

  assert.deepEqual(status, {
    active: false,
    confidence: 'low',
    source: 'heuristic',
    timestamp: status.timestamp,
    matches: [],
  });
});

test('ScreenShareDetector does not treat browser processes as active capture without a share window title', async () => {
  const detector = new ScreenShareDetector({
    platform: 'win32',
    logger: silentLogger,
    signatures: [
      {
        name: 'Chrome Screen Share',
        processNames: ['chrome.exe'],
        windowTitles: ['Sharing this tab'],
        processDetection: 'window-only',
      },
    ],
    execCommand: async (command) => {
      if (command === 'tasklist') {
        return '"chrome.exe","8124","Console","1","125,000 K"\n';
      }

      return 'Chrome|Inbox - Gmail\n';
    },
  });

  const status = await detector.detect();

  assert.equal(status.active, false);
  assert.equal(status.source, 'heuristic');
  assert.deepEqual(status.matches, []);
});

test('ScreenShareDetector returns the safe default when all probes fail', async () => {
  const detector = new ScreenShareDetector({
    platform: 'win32',
    logger: silentLogger,
    signatures: [
      {
        name: 'OBS Studio',
        processNames: ['obs64.exe'],
        windowTitles: ['OBS'],
      },
    ],
    nativeDetect: async () => {
      throw new Error('native failed');
    },
    execCommand: async () => {
      throw new Error('exec failed');
    },
  });

  const status = await detector.detect();

  assert.equal(status.active, false);
  assert.equal(status.source, 'heuristic');
  assert.equal(status.confidence, 'low');
  assert.deepEqual(status.matches, []);
});
