/**
 * Property-based tests for CaptureToolPatterns.
 *
 * Feature: stealth-hardening-quickwins
 * Validates: Requirements 6.1, 6.3, 6.4
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  CAPTURE_TOOL_REGEX,
  AMBIGUOUS_PATTERNS,
  matchCaptureToolProcess,
} from '../stealth/captureToolPatterns';

const PBT_CONFIG = { numRuns: 20 };

/**
 * Known legitimate capture tool process names that MUST match the regex.
 * Derived from the TOOL_NAMES array in the implementation.
 */
const LEGITIMATE_CAPTURE_TOOLS: string[] = [
  'obs',
  'OBS',
  'zoom.us',
  'zoom',
  'microsoft teams',
  'teams2',
  'teams for enterprise',
  'meet',
  'webex',
  'snipping',
  'screen studio',
  'screenstudio',
  'quicktime',
  'loom',
  'capture',
  'sharex',
  'greenshot',
  'flameshot',
  'discord',
  'slack',
  'ffmpeg',
  'screencapture',
  'vnc',
  'anydesk',
  'teamviewer',
  'screen recorder',
  'screenrecorder',
  'camtasia',
  'bandicam',
  'printwindow',
  'chromium',
  'msedge',
  'microsoft edge',
  'brave',
  'nvidia',
  'shadowplay',
  'geforce',
  'gamebar',
  'xbox',
  'skype',
  'gotomeeting',
  'goto',
  'bluejeans',
  'jitsi',
  'parallels',
  'vmware',
  'rdpclip',
  'mstsc',
  'remote desktop',
  'parsec',
  'nomachine',
  'distant',
  'screenrecording',
  'screencasting',
  'facet',
  'gather',
  'teramind',
  'activtrak',
  'time doctor',
  'hubstaff',
  'workpuls',
  'idletime',
  'screencastify',
  'vidyard',
  'wistia',
];

/**
 * False-positive process names that MUST NOT match.
 */
const FALSE_POSITIVES: string[] = ['coreaudiod', 'chrome', 'screenshot', 'airplay'];

/**
 * Collect all ambiguous pattern regexes for use in generators.
 */
const ambiguousRegexes = Array.from(AMBIGUOUS_PATTERNS.keys());

/**
 * Generator that produces process names matching an ambiguous pattern.
 * Picks from known ambiguous tool names that would trigger the ambiguous path.
 */
const ambiguousProcessNameArb = fc.constantFrom(
  'chromium',
  'Chromium',
  'CHROMIUM',
  'msedge',
  'Microsoft Edge',
  'brave',
  'Brave',
  'meet',
  'Meet',
  'capture',
  'Capture',
  'goto',
  'GoTo',
  'gotomeeting',
  'GoToMeeting',
);

/**
 * Generator for paths that do NOT match any known capture tool location.
 */
const nonMatchingPathArb = fc.constantFrom(
  '/usr/bin/some-random-app',
  '/Applications/SomeApp.app/Contents/MacOS/SomeApp',
  'C:\\Program Files\\RandomApp\\random.exe',
  '/home/user/.local/bin/myprocess',
  '/opt/tools/unknown-tool',
  '/usr/local/bin/not-a-capture-tool',
);

describe('Feature: stealth-hardening-quickwins, Property 15: Ambiguous Pattern Path Verification', () => {
  it('ambiguous matches without a path require path verification', () => {
    /**
     * Validates: Requirements 6.1, 6.3
     *
     * For any process name matching an ambiguous pattern, without a verified path,
     * `requiresPathVerification` is true.
     */
    fc.assert(
      fc.property(ambiguousProcessNameArb, (processName: string) => {
        const result = matchCaptureToolProcess(processName);

        // The process matches an ambiguous pattern, so without a path it should
        // require path verification
        if (result.matched) {
          assert.equal(
            result.requiresPathVerification,
            true,
            `Process "${processName}" matched ambiguous pattern but requiresPathVerification was false`,
          );
        }
      }),
      PBT_CONFIG,
    );
  });

  it('ambiguous matches with a non-matching path result in matched=false', () => {
    /**
     * Validates: Requirements 6.3
     *
     * For any process name matching an ambiguous pattern, with a non-matching path,
     * `matched` is false.
     */
    fc.assert(
      fc.property(
        ambiguousProcessNameArb,
        nonMatchingPathArb,
        (processName: string, path: string) => {
          const result = matchCaptureToolProcess(processName, path);

          // With a non-matching path, the ambiguous match should be rejected
          assert.equal(
            result.matched,
            false,
            `Process "${processName}" with non-matching path "${path}" should not match`,
          );
        },
      ),
      PBT_CONFIG,
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 16: Capture Tool Regex Coverage', () => {
  it('all known legitimate capture tool names match the regex', () => {
    /**
     * Validates: Requirements 6.4
     *
     * All known legitimate capture tool process names (from the previous pattern set,
     * excluding false positives) match the consolidated regex.
     */
    const legitimateToolArb = fc.constantFrom(...LEGITIMATE_CAPTURE_TOOLS);

    fc.assert(
      fc.property(legitimateToolArb, (toolName: string) => {
        const matches = CAPTURE_TOOL_REGEX.test(toolName);
        assert.equal(
          matches,
          true,
          `Legitimate capture tool "${toolName}" did not match CAPTURE_TOOL_REGEX`,
        );
      }),
      PBT_CONFIG,
    );
  });

  it('all false-positive names do NOT match', () => {
    /**
     * Validates: Requirements 6.1
     *
     * For any of the excluded false-positive names (coreaudiod, chrome, screenshot, airplay),
     * the regex SHALL NOT match via matchCaptureToolProcess.
     */
    const falsePositiveArb = fc.constantFrom(...FALSE_POSITIVES);

    fc.assert(
      fc.property(falsePositiveArb, (processName: string) => {
        const result = matchCaptureToolProcess(processName);
        assert.equal(
          result.matched,
          false,
          `False positive "${processName}" should NOT match but did`,
        );
      }),
      PBT_CONFIG,
    );
  });

  it('false positives in any case do NOT match via matchCaptureToolProcess', () => {
    /**
     * Validates: Requirements 6.1
     *
     * Case variations of false positives should also be excluded.
     */
    const caseVariantArb = fc.constantFrom(
      'coreaudiod', 'CoreAudioD', 'COREAUDIOD',
      'chrome', 'Chrome', 'CHROME',
      'screenshot', 'Screenshot', 'SCREENSHOT',
      'airplay', 'AirPlay', 'AIRPLAY',
    );

    fc.assert(
      fc.property(caseVariantArb, (processName: string) => {
        const result = matchCaptureToolProcess(processName);
        assert.equal(
          result.matched,
          false,
          `False positive case variant "${processName}" should NOT match`,
        );
      }),
      PBT_CONFIG,
    );
  });
});
