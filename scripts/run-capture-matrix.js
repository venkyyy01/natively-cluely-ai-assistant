#!/usr/bin/env node

const path = require('node:path');

const {
  MockCaptureAdapter,
  createDefaultMockCaptureMatrixRows,
  runCaptureMatrix,
} = require('../dist-electron/electron/stealth/CaptureMatrixHarness.js');
const {
  MacosCgWindowEnumerationAdapter,
  MacosScreenCaptureKitAdapter,
  MacosScreencaptureAdapter,
  WindowsCaptureAdapterStub,
  createDefaultMacosCgWindowRows,
  createDefaultMacosScreenCaptureKitRows,
  createDefaultMacosScreencaptureRows,
  createDefaultWindowsCaptureRows,
} = require('../dist-electron/electron/stealth/CaptureMatrixLocalAdapters.js');
const {
  BrowserGetDisplayMediaAdapter,
  ManualExternalCaptureAdapter,
  createDefaultBrowserGetDisplayMediaRows,
  createDefaultMeetingAppRows,
} = require('../dist-electron/electron/stealth/CaptureMatrixExternalAdapters.js');

function parseArgs(argv) {
  const rawArgs = argv.slice(2);
  const args = new Set(rawArgs);
  return {
    mock: args.has('--mock') || args.size === 0,
    local: args.has('--local'),
    macosScreencapture: args.has('--macos-screencapture'),
    macosCgWindow: args.has('--macos-cgwindow'),
    macosSck: args.has('--macos-sck'),
    windowsStub: args.has('--windows-stub'),
    browserGdm: args.has('--browser-get-display-media'),
    manualExternal: args.has('--manual-external'),
    outputRoot: getArgValue(rawArgs, '--output-root'),
    runId: getArgValue(rawArgs, '--run-id'),
  };
}

async function main() {
  const options = parseArgs(process.argv);
  const runs = createRuns(options);

  for (const run of runs) {
    const result = await runCaptureMatrix({
      rows: run.rows,
      adapter: run.adapter,
      outputRoot: path.resolve(options.outputRoot || run.outputRoot),
      runId: options.runId || run.runId,
      generatedAt: run.generatedAt,
    });

    for (const row of result.results) {
      const status = row.passed ? 'PASS' : row.actualResult === 'skipped' ? 'SKIP' : 'FAIL';
      console.log(`[${status}] ${row.adapter}:${row.row.id} expected=${row.row.expectedResult} actual=${row.actualResult}${row.reason ? ` reason=${row.reason}` : ''}`);
    }
    console.log(`Artifacts: ${result.outputRoot}`);

    if (!result.passed && result.results.some((row) => row.actualResult !== 'skipped')) {
      process.exitCode = 1;
    }
  }
}

function createRuns(options) {
  if (options.local) {
    if (process.platform === 'darwin') {
      return [
        createMacosScreencaptureRun(),
        createMacosCgWindowRun(),
        createMacosSckRun(),
      ];
    }
    if (process.platform === 'win32') {
      return [createWindowsStubRun()];
    }
    return [createUnsupportedLocalRun()];
  }

  const runs = [];
  if (options.mock) {
    runs.push(createMockRun());
  }
  if (options.macosScreencapture) {
    runs.push(createMacosScreencaptureRun());
  }
  if (options.macosCgWindow) {
    runs.push(createMacosCgWindowRun());
  }
  if (options.macosSck) {
    runs.push(createMacosSckRun());
  }
  if (options.windowsStub) {
    runs.push(createWindowsStubRun());
  }
  if (options.browserGdm) {
    runs.push(createBrowserGetDisplayMediaRun());
  }
  if (options.manualExternal) {
    runs.push(createManualExternalRun());
  }

  if (runs.length === 0) {
    runs.push(createMockRun());
  }

  return runs;
}

function createMockRun() {
  return {
    rows: createDefaultMockCaptureMatrixRows(),
    adapter: new MockCaptureAdapter(),
    outputRoot: 'output/capture-matrix/mock',
    runId: 'mock-run',
    generatedAt: '1970-01-01T00:00:00.000Z',
  };
}

function createMacosScreencaptureRun() {
  return {
    rows: createDefaultMacosScreencaptureRows({ platform: process.platform }),
    adapter: new MacosScreencaptureAdapter(),
    outputRoot: 'output/capture-matrix/local/macos-screencapture',
    runId: 'macos-screencapture-run',
  };
}

function createMacosCgWindowRun() {
  return {
    rows: createDefaultMacosCgWindowRows({ platform: process.platform }),
    adapter: new MacosCgWindowEnumerationAdapter(),
    outputRoot: 'output/capture-matrix/local/macos-cgwindow',
    runId: 'macos-cgwindow-run',
  };
}

function createMacosSckRun() {
  return {
    rows: createDefaultMacosScreenCaptureKitRows({ platform: process.platform }),
    adapter: new MacosScreenCaptureKitAdapter(),
    outputRoot: 'output/capture-matrix/local/macos-sck',
    runId: 'macos-sck-run',
  };
}

function createWindowsStubRun() {
  return {
    rows: createDefaultWindowsCaptureRows({ platform: process.platform }),
    adapter: new WindowsCaptureAdapterStub(),
    outputRoot: 'output/capture-matrix/local/windows',
    runId: 'windows-stub-run',
  };
}

function createBrowserGetDisplayMediaRun() {
  return {
    rows: createDefaultBrowserGetDisplayMediaRows({ platform: process.platform }),
    adapter: new BrowserGetDisplayMediaAdapter(),
    outputRoot: 'output/capture-matrix/external/browser-get-display-media',
    runId: 'browser-get-display-media-run',
  };
}

function createManualExternalRun() {
  return {
    rows: createDefaultMeetingAppRows({ platform: process.platform }),
    adapter: new ManualExternalCaptureAdapter(),
    outputRoot: 'output/capture-matrix/external/manual',
    runId: 'manual-external-run',
  };
}

function createUnsupportedLocalRun() {
  return {
    rows: createDefaultWindowsCaptureRows({ platform: process.platform }),
    adapter: new WindowsCaptureAdapterStub({ platform: process.platform }),
    outputRoot: 'output/capture-matrix/local/unsupported',
    runId: 'unsupported-local-run',
  };
}

function getArgValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
