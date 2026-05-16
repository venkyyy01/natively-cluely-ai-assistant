/**
 * Unit tests for MonitoringDetector v2.
 *
 * Validates: Requirements 4.1, 4.2, 4.4
 *
 * Tests JSON signature loading and fallback, each detection layer independently,
 * and deduplication across layers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MonitoringDetector,
  type MonitoringSignature,
  type DetectedThreatV2,
  type MonitoringDetectorV2Options,
} from '../stealth/MonitoringDetector';

const silentLogger = { log() {}, warn() {}, error() {} };

/** Helper to create a detector with injectable dependencies */
function createDetector(options: Partial<MonitoringDetectorV2Options> = {}): MonitoringDetector {
  return new MonitoringDetector({
    logger: silentLogger,
    platform: options.platform ?? 'darwin',
    getProcessList: options.getProcessList ?? (() => []),
    getWindowTitles: options.getWindowTitles ?? (() => []),
    fileExists: options.fileExists ?? (() => false),
    signatures: options.signatures,
    signatureDatabasePath: options.signatureDatabasePath,
    ...options,
  });
}

/** Minimal signature for testing */
function createSignature(overrides: Partial<MonitoringSignature> = {}): MonitoringSignature {
  return {
    name: overrides.name ?? 'TestTool',
    bundleId: overrides.bundleId ?? 'com.test.tool',
    category: overrides.category ?? 'monitoring',
    processPatterns: overrides.processPatterns ?? ['testtool'],
    windowTitlePatterns: overrides.windowTitlePatterns,
    filesystemArtifacts: overrides.filesystemArtifacts,
    launchAgentPaths: overrides.launchAgentPaths,
  };
}

// --- JSON Signature Loading and Fallback ---

test('loads injected signatures when provided', () => {
  const sigs: MonitoringSignature[] = [
    createSignature({ name: 'Injected1' }),
    createSignature({ name: 'Injected2' }),
  ];

  const detector = createDetector({ signatures: sigs });
  const loaded = detector.getSignatures();

  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].name, 'Injected1');
  assert.equal(loaded[1].name, 'Injected2');
});

test('falls back to KNOWN_ENTERPRISE_TOOLS when no signatures or path provided', () => {
  const detector = createDetector({ signatures: undefined, signatureDatabasePath: undefined });
  const loaded = detector.getSignatures();

  // Should have loaded from signatures.json or fallback to KNOWN_ENTERPRISE_TOOLS
  assert.ok(loaded.length > 0, 'should have loaded some signatures');
});

test('falls back when signatureDatabasePath points to invalid file', () => {
  const detector = createDetector({
    signatures: undefined,
    signatureDatabasePath: '/nonexistent/path/signatures.json',
  });
  const loaded = detector.getSignatures();

  // Should fall back to either default signatures.json or KNOWN_ENTERPRISE_TOOLS
  assert.ok(loaded.length > 0, 'should fall back to available signatures');
});

test('empty injected signatures array triggers fallback', () => {
  const detector = createDetector({ signatures: [] });
  const loaded = detector.getSignatures();

  // Empty array should trigger fallback
  assert.ok(loaded.length > 0, 'empty signatures should trigger fallback');
});

// --- Process Detection Layer ---

test('detects tool by process name matching', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'Teramind',
      category: 'monitoring',
      processPatterns: ['teramind', 'tm_agent'],
    })],
    getProcessList: () => [
      { pid: 100, ppid: 1, name: 'teramind' },
    ],
  });

  const threats = await detector.detect();

  assert.equal(threats.length, 1);
  assert.equal(threats[0].name, 'Teramind');
  assert.equal(threats[0].detectionLayer, 'process');
  assert.equal(threats[0].confidence, 0.9);
  assert.equal(threats[0].pid, '100');
});

test('process detection is case-insensitive', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'Hubstaff',
      category: 'time-tracking',
      processPatterns: ['hubstaff'],
    })],
    getProcessList: () => [
      { pid: 200, ppid: 1, name: 'HubstaffHelper' },
    ],
  });

  const threats = await detector.detect();

  assert.equal(threats.length, 1);
  assert.equal(threats[0].name, 'Hubstaff');
  assert.equal(threats[0].severity, 'warning'); // time-tracking is not critical
});

test('process detection returns empty when no match', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'Teramind',
      processPatterns: ['teramind'],
    })],
    getProcessList: () => [
      { pid: 300, ppid: 1, name: 'chrome' },
      { pid: 301, ppid: 1, name: 'node' },
    ],
  });

  const threats = await detector.detect();
  assert.equal(threats.length, 0);
});

// --- Window Title Detection Layer ---

test('detects tool by window title matching', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'Honorlock',
      category: 'proctoring',
      processPatterns: ['honorlock'],
      windowTitlePatterns: ['Honorlock', 'Honorlock Proctoring'],
    })],
    getProcessList: () => [],
    getWindowTitles: () => ['Honorlock Proctoring Session'],
  });

  const threats = await detector.detect();

  assert.equal(threats.length, 1);
  assert.equal(threats[0].name, 'Honorlock');
  assert.equal(threats[0].detectionLayer, 'window-title');
  assert.equal(threats[0].confidence, 0.7);
  assert.equal(threats[0].severity, 'critical'); // proctoring is critical
});

test('window title detection is case-insensitive', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'DeskTime',
      category: 'time-tracking',
      processPatterns: ['desktime'],
      windowTitlePatterns: ['DeskTime'],
    })],
    getProcessList: () => [],
    getWindowTitles: () => ['desktime - tracking active'],
  });

  const threats = await detector.detect();

  assert.equal(threats.length, 1);
  assert.equal(threats[0].name, 'DeskTime');
});

test('window title detection skips signatures without windowTitlePatterns', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'StealthTool',
      processPatterns: ['stealthtool'],
      windowTitlePatterns: undefined,
    })],
    getProcessList: () => [],
    getWindowTitles: () => ['StealthTool Window'],
  });

  const threats = await detector.detect();
  assert.equal(threats.length, 0);
});

test('window title detection skips signatures with empty windowTitlePatterns', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'ActivTrak',
      processPatterns: ['activtrak'],
      windowTitlePatterns: [],
    })],
    getProcessList: () => [],
    getWindowTitles: () => ['ActivTrak Dashboard'],
  });

  const threats = await detector.detect();
  assert.equal(threats.length, 0);
});

// --- Filesystem Artifact Detection Layer ---

test('detects tool by filesystem artifact', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'Teramind',
      category: 'monitoring',
      processPatterns: ['teramind'],
      filesystemArtifacts: [
        '/Library/Application Support/Teramind',
        '~/Library/LaunchAgents/com.teramind.agent.plist',
      ],
    })],
    getProcessList: () => [],
    fileExists: (p: string) => p === '/Library/Application Support/Teramind',
  });

  const threats = await detector.detect();

  assert.equal(threats.length, 1);
  assert.equal(threats[0].name, 'Teramind');
  assert.equal(threats[0].detectionLayer, 'filesystem');
  assert.equal(threats[0].confidence, 0.8);
});

test('filesystem detection resolves ~ paths', async () => {
  const homedir = require('node:os').homedir();
  let checkedPath = '';

  const detector = createDetector({
    signatures: [createSignature({
      name: 'Hubstaff',
      category: 'time-tracking',
      processPatterns: ['hubstaff'],
      filesystemArtifacts: ['~/Library/Application Support/Hubstaff'],
    })],
    getProcessList: () => [],
    fileExists: (p: string) => {
      checkedPath = p;
      return p.startsWith(homedir);
    },
  });

  const threats = await detector.detect();

  assert.equal(threats.length, 1);
  assert.ok(
    checkedPath.startsWith(homedir),
    `path should be resolved from ~: got ${checkedPath}`,
  );
});

test('filesystem detection returns empty when no artifacts exist', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'Veriato',
      processPatterns: ['veriato'],
      filesystemArtifacts: ['/Library/Application Support/Veriato'],
    })],
    getProcessList: () => [],
    fileExists: () => false,
  });

  const threats = await detector.detect();
  assert.equal(threats.length, 0);
});

test('filesystem detection skips signatures without filesystemArtifacts', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'NoArtifacts',
      processPatterns: ['noartifacts'],
      filesystemArtifacts: undefined,
    })],
    getProcessList: () => [],
    fileExists: () => true, // Would match if checked
  });

  const threats = await detector.detect();
  assert.equal(threats.length, 0);
});

// --- Launch Agent Detection Layer ---

test('detects tool by launch agent path on macOS', async () => {
  const detector = createDetector({
    platform: 'darwin',
    signatures: [createSignature({
      name: 'Kickidler',
      category: 'monitoring',
      processPatterns: ['kickidler'],
      launchAgentPaths: [
        '/Library/LaunchDaemons/com.kickidler.agent.plist',
      ],
    })],
    getProcessList: () => [],
    fileExists: (p: string) => p === '/Library/LaunchDaemons/com.kickidler.agent.plist',
  });

  const threats = await detector.detect();

  assert.equal(threats.length, 1);
  assert.equal(threats[0].name, 'Kickidler');
  assert.equal(threats[0].detectionLayer, 'launch-agent');
  assert.equal(threats[0].confidence, 0.85);
});

test('launch agent detection is skipped on non-macOS platforms', async () => {
  const detector = createDetector({
    platform: 'win32',
    signatures: [createSignature({
      name: 'Kickidler',
      category: 'monitoring',
      processPatterns: ['kickidler'],
      launchAgentPaths: [
        '/Library/LaunchDaemons/com.kickidler.agent.plist',
      ],
    })],
    getProcessList: () => [],
    fileExists: () => true, // Would match if checked
  });

  const threats = await detector.detect();
  assert.equal(threats.length, 0);
});

test('launch agent detection skips signatures without launchAgentPaths', async () => {
  const detector = createDetector({
    platform: 'darwin',
    signatures: [createSignature({
      name: 'NoAgents',
      processPatterns: ['noagents'],
      launchAgentPaths: undefined,
    })],
    getProcessList: () => [],
    fileExists: () => true,
  });

  const threats = await detector.detect();
  assert.equal(threats.length, 0);
});

// --- Deduplication Across Layers ---

test('same tool detected by multiple layers is deduplicated to highest confidence', async () => {
  const detector = createDetector({
    platform: 'darwin',
    signatures: [createSignature({
      name: 'Teramind',
      category: 'monitoring',
      processPatterns: ['teramind'],
      windowTitlePatterns: ['Teramind Agent'],
      filesystemArtifacts: ['/Library/Application Support/Teramind'],
      launchAgentPaths: ['/Library/LaunchDaemons/com.teramind.agent.plist'],
    })],
    getProcessList: () => [{ pid: 42, ppid: 1, name: 'teramind' }],
    getWindowTitles: () => ['Teramind Agent Dashboard'],
    fileExists: () => true,
  });

  const threats = await detector.detect();

  // Should be deduplicated to a single entry
  assert.equal(threats.length, 1);
  assert.equal(threats[0].name, 'Teramind');
  // Process layer has highest confidence (0.9)
  assert.equal(threats[0].detectionLayer, 'process');
  assert.equal(threats[0].confidence, 0.9);
});

test('different tools detected by different layers are all reported', async () => {
  const detector = createDetector({
    platform: 'darwin',
    signatures: [
      createSignature({
        name: 'Teramind',
        category: 'monitoring',
        processPatterns: ['teramind'],
        windowTitlePatterns: [],
        filesystemArtifacts: [],
        launchAgentPaths: [],
      }),
      createSignature({
        name: 'Hubstaff',
        category: 'time-tracking',
        processPatterns: ['hubstaff_nomatch'],
        windowTitlePatterns: ['Hubstaff'],
        filesystemArtifacts: [],
        launchAgentPaths: [],
      }),
      createSignature({
        name: 'Kickidler',
        category: 'monitoring',
        processPatterns: ['kickidler_nomatch'],
        windowTitlePatterns: [],
        filesystemArtifacts: ['/Library/Application Support/Kickidler'],
        launchAgentPaths: [],
      }),
    ],
    getProcessList: () => [{ pid: 10, ppid: 1, name: 'teramind' }],
    getWindowTitles: () => ['Hubstaff Tracker'],
    fileExists: (p: string) => p === '/Library/Application Support/Kickidler',
  });

  const threats = await detector.detect();

  assert.equal(threats.length, 3);
  const names = threats.map(t => t.name).sort();
  assert.deepEqual(names, ['Hubstaff', 'Kickidler', 'Teramind']);
});

test('deduplication keeps process detection over filesystem when both match', async () => {
  const detector = createDetector({
    platform: 'darwin',
    signatures: [createSignature({
      name: 'ActivTrak',
      category: 'monitoring',
      processPatterns: ['activtrak'],
      filesystemArtifacts: ['/Library/Application Support/ActivTrak'],
      launchAgentPaths: [],
      windowTitlePatterns: [],
    })],
    getProcessList: () => [{ pid: 55, ppid: 1, name: 'activtrak' }],
    fileExists: (p: string) => p === '/Library/Application Support/ActivTrak',
  });

  const threats = await detector.detect();

  assert.equal(threats.length, 1);
  assert.equal(threats[0].detectionLayer, 'process');
  assert.equal(threats[0].confidence, 0.9);
  assert.equal(threats[0].pid, '55');
});

// --- Severity Classification ---

test('monitoring category tools are classified as critical', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'Teramind',
      category: 'monitoring',
      processPatterns: ['teramind'],
    })],
    getProcessList: () => [{ pid: 1, ppid: 0, name: 'teramind' }],
  });

  const threats = await detector.detect();
  assert.equal(threats[0].severity, 'critical');
});

test('proctoring category tools are classified as critical', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'Proctorio',
      category: 'proctoring',
      processPatterns: ['proctorio'],
    })],
    getProcessList: () => [{ pid: 2, ppid: 0, name: 'proctorio' }],
  });

  const threats = await detector.detect();
  assert.equal(threats[0].severity, 'critical');
});

test('time-tracking category tools are classified as warning', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'Hubstaff',
      category: 'time-tracking',
      processPatterns: ['hubstaff'],
    })],
    getProcessList: () => [{ pid: 3, ppid: 0, name: 'hubstaff' }],
  });

  const threats = await detector.detect();
  assert.equal(threats[0].severity, 'warning');
});

test('remote-access category tools are classified as warning', async () => {
  const detector = createDetector({
    signatures: [createSignature({
      name: 'TeamViewer',
      category: 'remote-access',
      processPatterns: ['teamviewer'],
    })],
    getProcessList: () => [{ pid: 4, ppid: 0, name: 'teamviewer' }],
  });

  const threats = await detector.detect();
  assert.equal(threats[0].severity, 'warning');
});

// --- Re-entry Guard ---

test('concurrent detect() calls return empty while detection is in progress', async () => {
  let resolveFirst: () => void;
  const firstCallPromise = new Promise<void>((r) => { resolveFirst = r; });

  const detector = createDetector({
    signatures: [createSignature({
      name: 'SlowTool',
      processPatterns: ['slowtool'],
    })],
    getProcessList: () => {
      // Block until we resolve
      return [{ pid: 1, ppid: 0, name: 'slowtool' }];
    },
  });

  // Start first detection
  const first = detector.detect();

  // Second call while first is in progress should return empty
  const second = await detector.detect();
  assert.deepEqual(second, []);

  // First should complete normally
  const firstResult = await first;
  assert.equal(firstResult.length, 1);
});

// --- Helper Methods ---

test('isToolCritical returns true for monitoring tools', () => {
  const detector = createDetector({
    signatures: [createSignature({ name: 'Teramind', category: 'monitoring' })],
  });

  assert.equal(detector.isToolCritical('Teramind'), true);
});

test('isToolCritical returns true for proctoring tools', () => {
  const detector = createDetector({
    signatures: [createSignature({ name: 'Proctorio', category: 'proctoring' })],
  });

  assert.equal(detector.isToolCritical('Proctorio'), true);
});

test('isToolCritical returns false for time-tracking tools', () => {
  const detector = createDetector({
    signatures: [createSignature({ name: 'Hubstaff', category: 'time-tracking' })],
  });

  assert.equal(detector.isToolCritical('Hubstaff'), false);
});

test('isToolCritical returns false for unknown tools', () => {
  const detector = createDetector({ signatures: [] });
  assert.equal(detector.isToolCritical('UnknownTool'), false);
});

test('getToolCategory returns correct category', () => {
  const detector = createDetector({
    signatures: [createSignature({ name: 'Teramind', category: 'monitoring' })],
  });

  assert.equal(detector.getToolCategory('Teramind'), 'monitoring');
});

test('getToolCategory returns null for unknown tools', () => {
  const detector = createDetector({ signatures: [] });
  assert.equal(detector.getToolCategory('UnknownTool'), null);
});

test('getKnownTools returns the static enterprise tool list', () => {
  const tools = MonitoringDetector.getKnownTools();
  assert.ok(Array.isArray(tools));
  assert.ok(tools.length > 0);
  assert.ok(tools.some(t => t.name === 'Teramind'));
});
