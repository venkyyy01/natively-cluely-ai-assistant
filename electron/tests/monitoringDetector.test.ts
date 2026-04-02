import test from 'node:test';
import assert from 'node:assert';

import { MonitoringDetector, type MonitoringSoftwareSignature } from '../stealth/MonitoringDetector';

const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

function createSignature(overrides: Partial<MonitoringSoftwareSignature> = {}): MonitoringSoftwareSignature {
  return {
    name: 'ProctorU',
    category: 'proctoring',
    processNames: ['ProctorU.exe'],
    windowTitles: ['ProctorU'],
    installPaths: ['%ProgramFiles%\\ProctorU'],
    fileArtifacts: ['%ProgramData%\\ProctorU'],
    networkEndpoints: ['proctoru.com'],
    launchAgents: ['com.proctoru.app.plist'],
    registryKeys: ['HKLM\\Software\\ProctorU'],
    ...overrides,
  };
}

test('MonitoringDetector detects matching Windows processes', async () => {
  const detector = new MonitoringDetector({
    platform: 'win32',
    logger: silentLogger,
    signatures: [createSignature()],
    execCommand: async (command) => {
      if (command === 'tasklist') {
        return '"ProctorU.exe","444","Console","1","12,000 K"\n';
      }

      return '';
    },
  });

  const result = await detector.detectAll();

  assert.equal(result.detected, true);
  assert.equal(result.detectionMethod, 'process');
  assert.equal(result.threats[0]?.vector, 'process');
  assert.match(result.threats[0]?.details ?? '', /ProctorU\.exe/);
});

test('MonitoringDetector detects filesystem artifacts', async () => {
  const signature = createSignature({
    name: 'Time Doctor',
    processNames: [],
    windowTitles: [],
    installPaths: ['%ProgramFiles%\\Time Doctor'],
    fileArtifacts: ['%AppData%\\Time Doctor'],
  });

  const detector = new MonitoringDetector({
    platform: 'win32',
    logger: silentLogger,
    signatures: [signature],
    execCommand: async () => '',
    existsSync: (candidatePath) => candidatePath.endsWith('Time Doctor'),
    env: {
      ProgramFiles: 'C:\\Program Files',
      AppData: 'C:\\Users\\tester\\AppData\\Roaming',
    },
  });

  const result = await detector.detectAll();

  assert.equal(result.detected, true);
  assert.equal(result.detectionMethod, 'file');
  assert.equal(result.threats[0]?.vector, 'file');
});

test('MonitoringDetector detects matching macOS launch agents', async () => {
  const detector = new MonitoringDetector({
    platform: 'darwin',
    logger: silentLogger,
    signatures: [
      createSignature({
        name: 'Teramind',
        processNames: [],
        windowTitles: [],
        installPaths: [],
        fileArtifacts: [],
        launchAgents: ['com.teramind.agent.plist'],
      }),
    ],
    execCommand: async () => '',
    readdirSync: () => ['com.teramind.agent.plist'],
    homeDir: '/Users/tester',
  });

  const result = await detector.detectAll();

  assert.equal(result.detected, true);
  assert.equal(result.detectionMethod, 'launch-agent');
  assert.equal(result.threats[0]?.vector, 'launch-agent');
});

test('MonitoringDetector returns no threats when nothing matches', async () => {
  const detector = new MonitoringDetector({
    platform: 'win32',
    logger: silentLogger,
    signatures: [createSignature()],
    execCommand: async () => '',
    existsSync: () => false,
  });

  const result = await detector.detectAll();

  assert.equal(result.detected, false);
  assert.equal(result.detectionMethod, 'none');
  assert.deepEqual(result.threats, []);
});

test('MonitoringDetector keeps scanning when one layer fails', async () => {
  const detector = new MonitoringDetector({
    platform: 'win32',
    logger: silentLogger,
    signatures: [
      createSignature({
        name: 'Hubstaff',
        processNames: ['Hubstaff.exe'],
        windowTitles: ['Hubstaff'],
        installPaths: ['%ProgramFiles%\\Hubstaff'],
        fileArtifacts: [],
      }),
    ],
    execCommand: async (command) => {
      if (command === 'tasklist' || command === 'powershell') {
        throw new Error(`failed:${command}`);
      }

      return '';
    },
    existsSync: (candidatePath) => candidatePath.endsWith('Hubstaff'),
    env: {
      ProgramFiles: 'C:\\Program Files',
    },
  });

  const result = await detector.detectAll();

  assert.equal(result.detected, true);
  assert.equal(result.detectionMethod, 'file');
  assert.equal(result.threats[0]?.name, 'Hubstaff');
});
