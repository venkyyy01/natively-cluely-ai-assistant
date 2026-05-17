import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchCaptureToolProcess,
  CAPTURE_TOOL_REGEX,
  AMBIGUOUS_PATTERNS,
} from '../stealth/captureToolPatterns';

/**
 * Unit tests for capture tool pattern matching.
 * Validates: Requirements 6.2, 6.4
 */

describe('CaptureToolPatterns – false-positive exclusions (Req 6.2)', () => {
  const falsePositives = ['coreaudiod', 'chrome', 'screenshot', 'airplay'];

  for (const name of falsePositives) {
    it(`should NOT match excluded false-positive: "${name}"`, () => {
      const result = matchCaptureToolProcess(name);
      assert.equal(result.matched, false);
      assert.equal(result.toolName, null);
      assert.equal(result.requiresPathVerification, false);
    });
  }

  it('should NOT match false positives regardless of case', () => {
    const result1 = matchCaptureToolProcess('Chrome');
    assert.equal(result1.matched, false);

    const result2 = matchCaptureToolProcess('COREAUDIOD');
    assert.equal(result2.matched, false);

    const result3 = matchCaptureToolProcess('Screenshot');
    assert.equal(result3.matched, false);

    const result4 = matchCaptureToolProcess('AirPlay');
    assert.equal(result4.matched, false);
  });
});

describe('CaptureToolPatterns – known capture tools match (Req 6.4)', () => {
  const knownTools: Array<{ process: string; expectedTool: string }> = [
    { process: 'obs', expectedTool: 'OBS' },
    { process: 'zoom.us', expectedTool: 'Zoom' },
    { process: 'ffmpeg', expectedTool: 'FFmpeg' },
    { process: 'teamviewer', expectedTool: 'TeamViewer' },
    { process: 'discord', expectedTool: 'Discord' },
    { process: 'slack', expectedTool: 'Slack' },
    { process: 'loom', expectedTool: 'Loom' },
    { process: 'sharex', expectedTool: 'ShareX' },
    { process: 'greenshot', expectedTool: 'Greenshot' },
    { process: 'flameshot', expectedTool: 'Flameshot' },
    { process: 'vnc', expectedTool: 'VNC' },
    { process: 'anydesk', expectedTool: 'AnyDesk' },
    { process: 'quicktime', expectedTool: 'QuickTime' },
    { process: 'camtasia', expectedTool: 'Camtasia' },
    { process: 'bandicam', expectedTool: 'Bandicam' },
    { process: 'skype', expectedTool: 'Skype' },
    { process: 'webex', expectedTool: 'Webex' },
    { process: 'jitsi', expectedTool: 'Jitsi' },
    { process: 'parsec', expectedTool: 'Parsec' },
    { process: 'nomachine', expectedTool: 'NoMachine' },
    { process: 'teramind', expectedTool: 'Teramind' },
    { process: 'activtrak', expectedTool: 'ActivTrak' },
    { process: 'hubstaff', expectedTool: 'Hubstaff' },
  ];

  for (const { process: proc, expectedTool } of knownTools) {
    it(`should match known capture tool: "${proc}" → ${expectedTool}`, () => {
      const result = matchCaptureToolProcess(proc);
      assert.equal(result.matched, true);
      assert.equal(result.toolName, expectedTool);
    });
  }

  it('should match case-insensitively', () => {
    const result = matchCaptureToolProcess('OBS');
    assert.equal(result.matched, true);
    assert.equal(result.toolName, 'OBS');

    const result2 = matchCaptureToolProcess('TeamViewer');
    assert.equal(result2.matched, true);
    assert.equal(result2.toolName, 'TeamViewer');
  });
});

describe('CaptureToolPatterns – ambiguous pattern path verification (Req 6.2, 6.4)', () => {
  it('should flag "chromium" without path as requiring verification', () => {
    const result = matchCaptureToolProcess('chromium');
    assert.equal(result.matched, true);
    assert.equal(result.requiresPathVerification, true);
    assert.equal(result.toolName, 'Chromium');
  });

  it('should confirm "chromium" with correct path as matched (no verification needed)', () => {
    const result = matchCaptureToolProcess(
      'chromium',
      '/usr/bin/chromium'
    );
    assert.equal(result.matched, true);
    assert.equal(result.requiresPathVerification, false);
    assert.equal(result.toolName, 'Chromium');
  });

  it('should reject "chromium" with wrong path as not matched', () => {
    const result = matchCaptureToolProcess(
      'chromium',
      '/some/random/path/chromium'
    );
    assert.equal(result.matched, false);
    assert.equal(result.toolName, null);
    assert.equal(result.requiresPathVerification, false);
  });

  it('should flag "brave" without path as requiring verification', () => {
    const result = matchCaptureToolProcess('brave');
    assert.equal(result.matched, true);
    assert.equal(result.requiresPathVerification, true);
    assert.equal(result.toolName, 'Brave');
  });

  it('should confirm "brave" with correct macOS path', () => {
    const result = matchCaptureToolProcess(
      'brave',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    );
    assert.equal(result.matched, true);
    assert.equal(result.requiresPathVerification, false);
  });

  it('should reject "brave" with wrong path', () => {
    const result = matchCaptureToolProcess(
      'brave',
      '/usr/local/bin/brave-custom'
    );
    assert.equal(result.matched, false);
    assert.equal(result.toolName, null);
  });

  it('should flag "msedge" without path as requiring verification', () => {
    const result = matchCaptureToolProcess('msedge');
    assert.equal(result.matched, true);
    assert.equal(result.requiresPathVerification, true);
  });

  it('should confirm "msedge" with correct Windows path', () => {
    const result = matchCaptureToolProcess(
      'msedge',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    );
    assert.equal(result.matched, true);
    assert.equal(result.requiresPathVerification, false);
  });

  it('should reject "msedge" with wrong path', () => {
    const result = matchCaptureToolProcess(
      'msedge',
      'D:\\Custom\\msedge.exe'
    );
    assert.equal(result.matched, false);
  });

  it('should flag "meet" without path as requiring verification', () => {
    const result = matchCaptureToolProcess('meet');
    assert.equal(result.matched, true);
    assert.equal(result.requiresPathVerification, true);
  });

  it('should confirm "meet" with correct path', () => {
    const result = matchCaptureToolProcess(
      'meet',
      '/Applications/Google Meet.app/Contents/MacOS/Google Meet'
    );
    assert.equal(result.matched, true);
    assert.equal(result.requiresPathVerification, false);
  });

  it('should reject "meet" with wrong path', () => {
    const result = matchCaptureToolProcess(
      'meet',
      '/usr/bin/meetup-cli'
    );
    assert.equal(result.matched, false);
  });

  it('should handle path matching case-insensitively', () => {
    const result = matchCaptureToolProcess(
      'Chromium',
      '/USR/BIN/CHROMIUM'
    );
    assert.equal(result.matched, true);
    assert.equal(result.requiresPathVerification, false);
  });
});

describe('CaptureToolPatterns – non-matching processes', () => {
  it('should not match random process names', () => {
    const result = matchCaptureToolProcess('node');
    assert.equal(result.matched, false);

    const result2 = matchCaptureToolProcess('python3');
    assert.equal(result2.matched, false);

    const result3 = matchCaptureToolProcess('systemd');
    assert.equal(result3.matched, false);
  });
});
