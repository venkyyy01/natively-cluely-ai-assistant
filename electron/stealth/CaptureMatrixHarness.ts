import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type CaptureMatrixExpectedResult = 'hidden' | 'visible';
export type CaptureMatrixActualResult = CaptureMatrixExpectedResult | 'skipped' | 'failed';

export interface CaptureMatrixRow {
  id: string;
  platform: NodeJS.Platform | 'unknown';
  osVersion: string;
  appVersion: string;
  captureTool: string;
  mode: 'mock' | 'screenshot' | 'window-enumeration' | 'browser' | 'video' | 'manual';
  monitors: number;
  strict: boolean;
  surface: string;
  expectedResult: CaptureMatrixExpectedResult;
  canaryToken: string;
  externalAppName?: string;
  externalAppVersion?: string;
  externalCaptureMode?: string;
}

export interface CaptureMatrixArtifact {
  canaryVisible: boolean;
  capturePath?: string;
  log: string;
  metadata?: Record<string, unknown>;
}

export interface CaptureMatrixArtifactPaths {
  capture?: string;
  metadata: string;
  log: string;
}

export interface CaptureMatrixRowResult {
  row: CaptureMatrixRow;
  adapter: string;
  actualResult: CaptureMatrixActualResult;
  passed: boolean;
  reason?: string;
  artifactPaths: CaptureMatrixArtifactPaths;
  artifactMetadata?: Record<string, unknown>;
}

export interface CaptureMatrixRunResult {
  runId: string;
  generatedAt: string;
  outputRoot: string;
  passed: boolean;
  results: CaptureMatrixRowResult[];
}

export interface CaptureAdapterSession {
  id: string;
}

export interface CaptureMatrixAdapter {
  name: string;
  prepare(row: CaptureMatrixRow): Promise<void>;
  startCapture(row: CaptureMatrixRow): Promise<CaptureAdapterSession>;
  triggerVisibility(row: CaptureMatrixRow, session: CaptureAdapterSession): Promise<void>;
  collectArtifact(row: CaptureMatrixRow, session: CaptureAdapterSession): Promise<CaptureMatrixArtifact>;
  analyze(row: CaptureMatrixRow, artifact: CaptureMatrixArtifact): Promise<Pick<CaptureMatrixRowResult, 'actualResult' | 'passed' | 'reason'>>;
  cleanup(row: CaptureMatrixRow, session: CaptureAdapterSession): Promise<void>;
}

export interface RunCaptureMatrixOptions {
  rows: CaptureMatrixRow[];
  adapter: CaptureMatrixAdapter;
  outputRoot: string;
  runId?: string;
  generatedAt?: string;
}

export class CaptureMatrixSkipError extends Error {
  override readonly name = 'CaptureMatrixSkipError';

  constructor(message: string) {
    super(message);
  }
}

export function analyzeCanaryVisibility(row: CaptureMatrixRow, canaryVisible: boolean): Pick<CaptureMatrixRowResult, 'actualResult' | 'passed' | 'reason'> {
  const actualResult: CaptureMatrixExpectedResult = canaryVisible ? 'visible' : 'hidden';
  const passed = actualResult === row.expectedResult;
  return {
    actualResult,
    passed,
    reason: passed ? undefined : `expected ${row.expectedResult} but canary was ${actualResult}`,
  };
}

export function validateCaptureMatrixRow(row: CaptureMatrixRow): string[] {
  const errors: string[] = [];
  if (!row.id || !/^[a-z0-9][a-z0-9-_.]*$/i.test(row.id)) {
    errors.push('id must be non-empty and filesystem-safe');
  }
  if (!row.platform) {
    errors.push('platform is required');
  }
  if (!row.osVersion) {
    errors.push('osVersion is required');
  }
  if (!row.appVersion) {
    errors.push('appVersion is required');
  }
  if (!row.captureTool) {
    errors.push('captureTool is required');
  }
  if (!Number.isInteger(row.monitors) || row.monitors < 1) {
    errors.push('monitors must be a positive integer');
  }
  if (!row.surface) {
    errors.push('surface is required');
  }
  if (!row.canaryToken) {
    errors.push('canaryToken is required');
  }

  return errors;
}

export class MockCaptureAdapter implements CaptureMatrixAdapter {
  readonly name = 'mock';
  private readonly canaryVisibilityByRow = new Map<string, boolean>();

  constructor(canaryVisibilityByRow: Record<string, boolean> = {}) {
    for (const [rowId, visible] of Object.entries(canaryVisibilityByRow)) {
      this.canaryVisibilityByRow.set(rowId, visible);
    }
  }

  async prepare(row: CaptureMatrixRow): Promise<void> {
    this.assertValid(row);
  }

  async startCapture(row: CaptureMatrixRow): Promise<CaptureAdapterSession> {
    return { id: `mock-${row.id}` };
  }

  async triggerVisibility(_row: CaptureMatrixRow, _session: CaptureAdapterSession): Promise<void> {
    return;
  }

  async collectArtifact(row: CaptureMatrixRow, session: CaptureAdapterSession): Promise<CaptureMatrixArtifact> {
    const canaryVisible = this.canaryVisibilityByRow.get(row.id) ?? row.expectedResult === 'visible';
    return {
      canaryVisible,
      log: `session=${session.id} canary=${row.canaryToken} visible=${canaryVisible}`,
    };
  }

  async analyze(row: CaptureMatrixRow, artifact: CaptureMatrixArtifact): Promise<Pick<CaptureMatrixRowResult, 'actualResult' | 'passed' | 'reason'>> {
    return analyzeCanaryVisibility(row, artifact.canaryVisible);
  }

  async cleanup(_row: CaptureMatrixRow, _session: CaptureAdapterSession): Promise<void> {
    return;
  }

  private assertValid(row: CaptureMatrixRow): void {
    const errors = validateCaptureMatrixRow(row);
    if (errors.length > 0) {
      throw new Error(`invalid capture matrix row ${row.id || '<missing>'}: ${errors.join(', ')}`);
    }
  }
}

export function createDefaultMockCaptureMatrixRows(input: {
  platform?: NodeJS.Platform | 'unknown';
  osVersion?: string;
  appVersion?: string;
  strict?: boolean;
} = {}): CaptureMatrixRow[] {
  const platform = input.platform ?? process.platform;
  const osVersion = input.osVersion ?? 'mock-os';
  const appVersion = input.appVersion ?? 'mock-app';
  const strict = input.strict ?? true;

  return [
    {
      id: 'mock-protected-screen-share',
      platform,
      osVersion,
      appVersion,
      captureTool: 'mock-screen-share',
      mode: 'mock',
      monitors: 1,
      strict,
      surface: 'protected-shell',
      expectedResult: 'hidden',
      canaryToken: 'NATIVELY_CAPTURE_CANARY_PROTECTED',
    },
    {
      id: 'mock-unprotected-control',
      platform,
      osVersion,
      appVersion,
      captureTool: 'mock-screen-share',
      mode: 'mock',
      monitors: 1,
      strict: false,
      surface: 'unprotected-control',
      expectedResult: 'visible',
      canaryToken: 'NATIVELY_CAPTURE_CANARY_CONTROL',
    },
  ];
}

export async function runCaptureMatrix(options: RunCaptureMatrixOptions): Promise<CaptureMatrixRunResult> {
  const runId = options.runId ?? 'mock-run';
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const outputRoot = path.resolve(options.outputRoot, runId);
  await mkdir(outputRoot, { recursive: true });

  const results: CaptureMatrixRowResult[] = [];
  for (const row of options.rows) {
    const result = await runCaptureMatrixRow(row, options.adapter, outputRoot);
    results.push(result);
  }

  const runResult: CaptureMatrixRunResult = {
    runId,
    generatedAt,
    outputRoot,
    passed: results.every((result) => result.passed),
    results,
  };

  await writeFile(
    path.join(outputRoot, 'summary.json'),
    `${JSON.stringify(runResult, null, 2)}\n`,
    'utf8',
  );

  return runResult;
}

async function runCaptureMatrixRow(
  row: CaptureMatrixRow,
  adapter: CaptureMatrixAdapter,
  outputRoot: string,
): Promise<CaptureMatrixRowResult> {
  const rowOutputDir = path.join(outputRoot, sanitizePathSegment(row.id));
  await mkdir(rowOutputDir, { recursive: true });
  const metadataPath = path.join(rowOutputDir, 'metadata.json');
  const logPath = path.join(rowOutputDir, 'capture.log');

  let session: CaptureAdapterSession | null = null;
  try {
    await adapter.prepare(row);
    session = await adapter.startCapture(row);
    await adapter.triggerVisibility(row, session);
    const artifact = await adapter.collectArtifact(row, session);
    const analysis = await adapter.analyze(row, artifact);
    await writeFile(logPath, `${artifact.log}\n`, 'utf8');
    const capturePath = artifact.capturePath
      ? await persistCaptureArtifact(artifact.capturePath, rowOutputDir)
      : undefined;

    const result: CaptureMatrixRowResult = {
      row,
      adapter: adapter.name,
      actualResult: analysis.actualResult,
      passed: analysis.passed,
      reason: analysis.reason,
      artifactPaths: {
        capture: capturePath,
        metadata: metadataPath,
        log: logPath,
      },
      artifactMetadata: artifact.metadata,
    };
    await writeFile(metadataPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const skipped = error instanceof CaptureMatrixSkipError;
    const result: CaptureMatrixRowResult = {
      row,
      adapter: adapter.name,
      actualResult: skipped ? 'skipped' : 'failed',
      passed: false,
      reason: message,
      artifactPaths: {
        metadata: metadataPath,
        log: logPath,
      },
    };
    await writeFile(logPath, `${message}\n`, 'utf8');
    await writeFile(metadataPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
  } finally {
    if (session) {
      await adapter.cleanup(row, session);
    }
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-z0-9-_.]/gi, '_');
}

async function persistCaptureArtifact(capturePath: string, rowOutputDir: string): Promise<string> {
  const targetName = sanitizePathSegment(path.basename(capturePath));
  const targetPath = path.join(rowOutputDir, targetName || 'capture-artifact');
  if (path.resolve(capturePath) !== path.resolve(targetPath)) {
    await copyFile(capturePath, targetPath);
  }
  return targetPath;
}
