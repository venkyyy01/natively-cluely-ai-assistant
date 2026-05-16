import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  MonitoringDetector,
  type MonitoringSignature,
  type ThreatCategory,
  type DetectionLayer,
} from '../stealth/MonitoringDetector';

/**
 * Feature: stealth-hardening-quickwins
 * Property-based tests for MonitoringDetector v2
 *
 * Validates: Requirements 4.3, 4.5
 */

// --- Test Helpers ---

/** Silent logger for tests */
const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

/** Confidence levels per detection layer (must match MonitoringDetector implementation) */
const LAYER_CONFIDENCE: Record<DetectionLayer, number> = {
  'process': 0.9,
  'window-title': 0.7,
  'filesystem': 0.8,
  'launch-agent': 0.85,
};

/** Arbitrary for threat categories */
const categoryArb: fc.Arbitrary<ThreatCategory> = fc.constantFrom(
  'monitoring' as ThreatCategory,
  'proctoring' as ThreatCategory,
  'remote-desktop' as ThreatCategory,
  'screen-capture' as ThreatCategory,
  'time-tracking' as ThreatCategory,
  'remote-access' as ThreatCategory,
);

/** Efficient arbitrary for a tool name (no filtering needed) */
const toolNameArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('Tool', 'Agent', 'Monitor', 'Tracker', 'Guard', 'Watch', 'Spy', 'Scan'),
    fc.integer({ min: 1, max: 9999 }),
  )
  .map(([prefix, num]) => `${prefix}${num}`);

/** Efficient arbitrary for a process pattern */
const processPatternArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('agent', 'daemon', 'svc', 'proc', 'mon', 'track', 'watch', 'scan'),
    fc.integer({ min: 1, max: 999 }),
  )
  .map(([prefix, num]) => `${prefix}_${num}`);

/** Efficient arbitrary for a window title pattern */
const windowTitlePatternArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('Dashboard', 'Monitor', 'Tracker', 'Agent', 'Console', 'Panel'),
    fc.integer({ min: 1, max: 999 }),
  )
  .map(([prefix, num]) => `${prefix} ${num}`);

/** Efficient arbitrary for a filesystem artifact path */
const filesystemArtifactArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('/Library/Application Support', '/usr/local/lib', '/opt'),
    fc.constantFrom('monitor', 'agent', 'tracker', 'guard'),
    fc.integer({ min: 1, max: 999 }),
  )
  .map(([dir, name, num]) => `${dir}/${name}${num}`);

/** Efficient arbitrary for a launch agent path */
const launchAgentPathArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('/Library/LaunchDaemons', '/Library/LaunchAgents'),
    fc.constantFrom('com.monitor', 'com.agent', 'com.tracker', 'com.guard'),
    fc.integer({ min: 1, max: 999 }),
  )
  .map(([dir, prefix, num]) => `${dir}/${prefix}.${num}.plist`);

/** Generate a monitoring signature with all layers populated */
function signatureArb(): fc.Arbitrary<MonitoringSignature> {
  return fc
    .tuple(
      toolNameArb,
      categoryArb,
      fc.array(processPatternArb, { minLength: 1, maxLength: 2 }),
      fc.array(windowTitlePatternArb, { minLength: 1, maxLength: 2 }),
      fc.array(filesystemArtifactArb, { minLength: 1, maxLength: 2 }),
      fc.array(launchAgentPathArb, { minLength: 1, maxLength: 2 }),
    )
    .map(([name, category, processPatterns, windowTitlePatterns, filesystemArtifacts, launchAgentPaths]) => ({
      name,
      bundleId: `com.test.${name.toLowerCase()}`,
      category,
      processPatterns,
      windowTitlePatterns,
      filesystemArtifacts,
      launchAgentPaths,
    }));
}

/** Generate N unique signatures */
function uniqueSignaturesArb(count: number): fc.Arbitrary<MonitoringSignature[]> {
  return fc.array(signatureArb(), { minLength: count, maxLength: count }).map((sigs) => {
    // Ensure unique names by appending index
    return sigs.map((sig, idx) => ({
      ...sig,
      name: `${sig.name}_${idx}`,
      processPatterns: sig.processPatterns.map((p) => `${p}_${idx}`),
      windowTitlePatterns: sig.windowTitlePatterns!.map((p) => `${p}_${idx}`),
      filesystemArtifacts: sig.filesystemArtifacts!.map((p) => `${p}_${idx}`),
      launchAgentPaths: sig.launchAgentPaths!.map((p) => `${p.replace('.plist', `_${idx}.plist`)}`),
    }));
  });
}

/** Arbitrary for selecting which layers to activate (at least 2) */
const layerSubsetArb: fc.Arbitrary<DetectionLayer[]> = fc
  .subarray(['process', 'window-title', 'filesystem', 'launch-agent'] as DetectionLayer[], {
    minLength: 2,
    maxLength: 4,
  });

// --- Property Tests ---

describe('Feature: stealth-hardening-quickwins, Property 12: Monitoring Deduplication', () => {
  /**
   * Validates: Requirements 4.3
   *
   * For any monitoring tool detected by multiple detection layers simultaneously,
   * the result set SHALL contain exactly one entry for that tool, attributed to
   * the highest-confidence detection layer.
   */
  test('same tool from multiple layers appears once with highest confidence', async () => {
    await fc.assert(
      fc.asyncProperty(signatureArb(), layerSubsetArb, async (signature, layersToDetect) => {
        // Create process list that matches if 'process' layer is included
        const getProcessList = (): Array<{ pid: number; ppid: number; name: string }> => {
          if (layersToDetect.includes('process')) {
            return [{ pid: 1234, ppid: 1, name: signature.processPatterns[0] }];
          }
          return [];
        };

        // Create window titles that match if 'window-title' layer is included
        const getWindowTitles = (): string[] => {
          if (layersToDetect.includes('window-title') && signature.windowTitlePatterns && signature.windowTitlePatterns.length > 0) {
            return [signature.windowTitlePatterns[0]];
          }
          return [];
        };

        // Create file existence checker that matches if 'filesystem' or 'launch-agent' layer is included
        const fileExists = (filePath: string): boolean => {
          if (layersToDetect.includes('filesystem') && signature.filesystemArtifacts) {
            if (signature.filesystemArtifacts.some((a) => filePath.endsWith(a) || filePath === a)) {
              return true;
            }
          }
          if (layersToDetect.includes('launch-agent') && signature.launchAgentPaths) {
            if (signature.launchAgentPaths.some((a) => filePath.endsWith(a) || filePath === a)) {
              return true;
            }
          }
          return false;
        };

        const detector = new MonitoringDetector({
          platform: 'darwin',
          logger: silentLogger,
          signatures: [signature],
          getProcessList,
          getWindowTitles,
          fileExists,
        });

        const results = await detector.detect();

        // The tool should appear at most once in the results
        const toolEntries = results.filter((r) => r.name === signature.name);
        assert.ok(
          toolEntries.length <= 1,
          `Tool "${signature.name}" detected by layers [${layersToDetect.join(', ')}] should appear at most once, but appeared ${toolEntries.length} times`,
        );

        // If detected, it should have the highest confidence among the layers that detected it
        if (toolEntries.length === 1) {
          const entry = toolEntries[0];

          // Determine which layers actually detected the tool
          const detectingLayers: DetectionLayer[] = [];
          if (layersToDetect.includes('process') && signature.processPatterns.length > 0) {
            detectingLayers.push('process');
          }
          if (layersToDetect.includes('window-title') && signature.windowTitlePatterns && signature.windowTitlePatterns.length > 0) {
            detectingLayers.push('window-title');
          }
          if (layersToDetect.includes('filesystem') && signature.filesystemArtifacts && signature.filesystemArtifacts.length > 0) {
            detectingLayers.push('filesystem');
          }
          if (layersToDetect.includes('launch-agent') && signature.launchAgentPaths && signature.launchAgentPaths.length > 0) {
            detectingLayers.push('launch-agent');
          }

          if (detectingLayers.length > 0) {
            const maxConfidence = Math.max(...detectingLayers.map((l) => LAYER_CONFIDENCE[l]));
            assert.equal(
              entry.confidence,
              maxConfidence,
              `Tool "${signature.name}" should have confidence ${maxConfidence} (highest among [${detectingLayers.join(', ')}]), got ${entry.confidence}`,
            );
          }
        }
      }),
      { numRuns: 20 },
    );
  });

  test('multiple distinct tools detected by overlapping layers each appear exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(uniqueSignaturesArb(3), async (signatures) => {
        // Make all tools detectable via process and filesystem layers
        const getProcessList = (): Array<{ pid: number; ppid: number; name: string }> =>
          signatures.map((sig, idx) => ({
            pid: 1000 + idx,
            ppid: 1,
            name: sig.processPatterns[0],
          }));

        const getWindowTitles = (): string[] => [];

        const fileExists = (filePath: string): boolean => {
          return signatures.some(
            (sig) =>
              sig.filesystemArtifacts &&
              sig.filesystemArtifacts.some((a) => filePath.endsWith(a) || filePath === a),
          );
        };

        const detector = new MonitoringDetector({
          platform: 'darwin',
          logger: silentLogger,
          signatures,
          getProcessList,
          getWindowTitles,
          fileExists,
        });

        const results = await detector.detect();

        // Each tool should appear at most once
        const nameCount = new Map<string, number>();
        for (const r of results) {
          nameCount.set(r.name, (nameCount.get(r.name) ?? 0) + 1);
        }

        for (const [name, count] of nameCount) {
          assert.equal(count, 1, `Tool "${name}" should appear exactly once, appeared ${count} times`);
        }
      }),
      { numRuns: 20 },
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 13: Detection Layer Attribution', () => {
  /**
   * Validates: Requirements 4.5
   *
   * For any threat detected via the filesystem-artifact or launch-agent detection
   * layer, the threat report SHALL include the detectionLayer field set to the
   * correct layer identifier.
   */
  test('filesystem detections include correct detectionLayer', async () => {
    await fc.assert(
      fc.asyncProperty(signatureArb(), async (signature) => {
        // Only trigger filesystem detection — no process, no window title, no launch agent
        const getProcessList = (): Array<{ pid: number; ppid: number; name: string }> => [];
        const getWindowTitles = (): string[] => [];

        // Only filesystem artifacts exist
        const fileExists = (filePath: string): boolean => {
          if (!signature.filesystemArtifacts || signature.filesystemArtifacts.length === 0) return false;
          return signature.filesystemArtifacts.some((a) => filePath.endsWith(a) || filePath === a);
        };

        // Ensure the signature only triggers filesystem detection
        const sigFilesystemOnly: MonitoringSignature = {
          ...signature,
          processPatterns: ['__nonexistent_process_xyz_never_match__'],
          windowTitlePatterns: [],
          launchAgentPaths: [],
        };

        const detector = new MonitoringDetector({
          platform: 'darwin',
          logger: silentLogger,
          signatures: [sigFilesystemOnly],
          getProcessList,
          getWindowTitles,
          fileExists,
        });

        const results = await detector.detect();

        // If detected, the detection layer should be 'filesystem'
        const toolEntries = results.filter((r) => r.name === signature.name);
        for (const entry of toolEntries) {
          assert.equal(
            entry.detectionLayer,
            'filesystem',
            `Tool "${signature.name}" detected via filesystem should have detectionLayer='filesystem', got '${entry.detectionLayer}'`,
          );
          assert.equal(
            entry.confidence,
            LAYER_CONFIDENCE['filesystem'],
            `Filesystem detection should have confidence ${LAYER_CONFIDENCE['filesystem']}, got ${entry.confidence}`,
          );
        }

        // Verify at least one detection occurred (since we always have filesystem artifacts)
        if (signature.filesystemArtifacts && signature.filesystemArtifacts.length > 0) {
          assert.ok(
            toolEntries.length === 1,
            `Expected exactly 1 filesystem detection for "${signature.name}", got ${toolEntries.length}`,
          );
        }
      }),
      { numRuns: 20 },
    );
  });

  test('launch-agent detections include correct detectionLayer', async () => {
    await fc.assert(
      fc.asyncProperty(signatureArb(), async (signature) => {
        // Only trigger launch-agent detection
        const getProcessList = (): Array<{ pid: number; ppid: number; name: string }> => [];
        const getWindowTitles = (): string[] => [];

        // Only launch agent paths exist
        const fileExists = (filePath: string): boolean => {
          if (!signature.launchAgentPaths || signature.launchAgentPaths.length === 0) return false;
          return signature.launchAgentPaths.some((a) => filePath.endsWith(a) || filePath === a);
        };

        // Ensure the signature only triggers launch-agent detection
        const sigLaunchAgentOnly: MonitoringSignature = {
          ...signature,
          processPatterns: ['__nonexistent_process_xyz_never_match__'],
          windowTitlePatterns: [],
          filesystemArtifacts: [],
        };

        const detector = new MonitoringDetector({
          platform: 'darwin', // launch-agent only runs on darwin
          logger: silentLogger,
          signatures: [sigLaunchAgentOnly],
          getProcessList,
          getWindowTitles,
          fileExists,
        });

        const results = await detector.detect();

        // If detected, the detection layer should be 'launch-agent'
        const toolEntries = results.filter((r) => r.name === signature.name);
        for (const entry of toolEntries) {
          assert.equal(
            entry.detectionLayer,
            'launch-agent',
            `Tool "${signature.name}" detected via launch-agent should have detectionLayer='launch-agent', got '${entry.detectionLayer}'`,
          );
          assert.equal(
            entry.confidence,
            LAYER_CONFIDENCE['launch-agent'],
            `Launch-agent detection should have confidence ${LAYER_CONFIDENCE['launch-agent']}, got ${entry.confidence}`,
          );
        }

        // Verify at least one detection occurred (since we always have launch agent paths)
        if (signature.launchAgentPaths && signature.launchAgentPaths.length > 0) {
          assert.ok(
            toolEntries.length === 1,
            `Expected exactly 1 launch-agent detection for "${signature.name}", got ${toolEntries.length}`,
          );
        }
      }),
      { numRuns: 20 },
    );
  });

  test('when filesystem and launch-agent both detect, highest confidence layer wins', async () => {
    await fc.assert(
      fc.asyncProperty(signatureArb(), async (signature) => {
        // Trigger both filesystem and launch-agent detection, but not process or window-title
        const getProcessList = (): Array<{ pid: number; ppid: number; name: string }> => [];
        const getWindowTitles = (): string[] => [];

        const fileExists = (filePath: string): boolean => {
          const matchesFs =
            signature.filesystemArtifacts &&
            signature.filesystemArtifacts.some((a) => filePath.endsWith(a) || filePath === a);
          const matchesLa =
            signature.launchAgentPaths &&
            signature.launchAgentPaths.some((a) => filePath.endsWith(a) || filePath === a);
          return !!(matchesFs || matchesLa);
        };

        const sigNoProcess: MonitoringSignature = {
          ...signature,
          processPatterns: ['__nonexistent_process_xyz_never_match__'],
          windowTitlePatterns: [],
        };

        const detector = new MonitoringDetector({
          platform: 'darwin',
          logger: silentLogger,
          signatures: [sigNoProcess],
          getProcessList,
          getWindowTitles,
          fileExists,
        });

        const results = await detector.detect();
        const toolEntries = results.filter((r) => r.name === signature.name);

        // Both filesystem and launch-agent should detect, but deduplication keeps only highest confidence
        if (toolEntries.length === 1) {
          const entry = toolEntries[0];
          const hasFs = signature.filesystemArtifacts && signature.filesystemArtifacts.length > 0;
          const hasLa = signature.launchAgentPaths && signature.launchAgentPaths.length > 0;

          if (hasFs && hasLa) {
            // launch-agent (0.85) > filesystem (0.8), so launch-agent should win
            assert.equal(
              entry.detectionLayer,
              'launch-agent',
              `When both filesystem and launch-agent detect, launch-agent (0.85) should win over filesystem (0.8), got '${entry.detectionLayer}'`,
            );
            assert.equal(entry.confidence, LAYER_CONFIDENCE['launch-agent']);
          } else if (hasLa) {
            assert.equal(entry.detectionLayer, 'launch-agent');
            assert.equal(entry.confidence, LAYER_CONFIDENCE['launch-agent']);
          } else if (hasFs) {
            assert.equal(entry.detectionLayer, 'filesystem');
            assert.equal(entry.confidence, LAYER_CONFIDENCE['filesystem']);
          }
        }
      }),
      { numRuns: 20 },
    );
  });
});
