import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

import {
  CaptureMatrixSkipError,
  analyzeCanaryVisibility,
  validateCaptureMatrixRow,
  type CaptureAdapterSession,
  type CaptureMatrixAdapter,
  type CaptureMatrixArtifact,
  type CaptureMatrixRow,
  type CaptureMatrixRowResult,
} from './CaptureMatrixHarness';
import { loadNativeStealthModule } from './nativeStealthModule';
import type { NativeStealthBindings, WindowInfo } from './StealthManager';

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type ExecFileRunner = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<ExecFileResult>;

export interface CanaryColor {
  r: number;
  g: number;
  b: number;
}

export interface CanaryPixelDetectionOptions {
  primary?: CanaryColor;
  secondary?: CanaryColor;
  tolerance?: number;
  minPixelsPerColor?: number;
  minTotalRatio?: number;
}

export interface CanaryPixelDetectionResult {
  visible: boolean;
  totalPixels: number;
  primaryPixels: number;
  secondaryPixels: number;
  markerRatio: number;
  minPixelsPerColor: number;
  minTotalRatio: number;
}

export interface CanaryFixturePaths {
  htmlPath: string;
  pngPath: string;
}

export interface LocalCaptureAdapterOptions {
  platform?: NodeJS.Platform;
  osVersion?: string;
  appVersion?: string;
  monitors?: number;
  strict?: boolean;
}

export interface MacosScreencaptureAdapterOptions {
  platform?: NodeJS.Platform;
  commandPath?: string;
  execFile?: ExecFileRunner;
  detector?: typeof detectCanaryMarkerInImage;
  canaryArmed?: boolean;
}

export interface MacosCgWindowEnumerationAdapterOptions {
  platform?: NodeJS.Platform;
  nativeModule?: Pick<NativeStealthBindings, 'listVisibleWindows'> | null;
  canaryArmed?: boolean;
}

export interface MacosScreenCaptureKitAdapterOptions {
  platform?: NodeJS.Platform;
  enabled?: boolean;
  capture?: (row: CaptureMatrixRow, artifactDir: string) => Promise<{ capturePath: string; log?: string }>;
  detector?: typeof detectCanaryMarkerInImage;
}

interface LocalCaptureSession extends CaptureAdapterSession {
  artifactDir: string;
  canaryHtmlPath?: string;
  canaryPngPath?: string;
}

const DEFAULT_PRIMARY: CanaryColor = { r: 255, g: 0, b: 255 };
const DEFAULT_SECONDARY: CanaryColor = { r: 0, g: 255, b: 0 };
const DEFAULT_TOLERANCE = 48;
const DEFAULT_MIN_PIXELS_PER_COLOR = 250;
const DEFAULT_MIN_TOTAL_RATIO = 0.0005;

export function createCanarySvg(canaryToken: string): string {
  const safeToken = escapeHtml(canaryToken);
  const square = 24;
  const columns = 14;
  const rows = 5;
  const markerWidth = columns * square;
  const markerHeight = rows * square;
  const width = markerWidth + 48;
  const height = markerHeight + 88;
  const squares: string[] = [];

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const fill = (row + column) % 2 === 0 ? '#ff00ff' : '#00ff00';
      squares.push(`<rect x="${24 + column * square}" y="${20 + row * square}" width="${square}" height="${square}" fill="${fill}"/>`);
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#000"/>',
    '<title>Natively capture canary</title>',
    `<rect x="16" y="12" width="${markerWidth + 16}" height="${markerHeight + 16}" fill="none" stroke="#fff" stroke-width="8"/>`,
    ...squares,
    `<text x="24" y="${height - 30}" fill="#fff" font-family="Menlo, Consolas, monospace" font-size="18">${safeToken}</text>`,
    '</svg>',
  ].join('');
}

export async function renderCanaryPngBuffer(canaryToken: string): Promise<Buffer> {
  return sharp(Buffer.from(createCanarySvg(canaryToken), 'utf8')).png().toBuffer();
}

export async function writeCanaryFixtureFiles(row: CaptureMatrixRow, outputDir: string): Promise<CanaryFixturePaths> {
  const pngPath = path.join(outputDir, `${sanitizePathSegment(row.id)}-canary.png`);
  const htmlPath = path.join(outputDir, `${sanitizePathSegment(row.id)}-canary.html`);
  const png = await renderCanaryPngBuffer(row.canaryToken);
  await writeFile(pngPath, png);
  await writeFile(
    htmlPath,
    [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<meta charset="utf-8">',
      `<title>${escapeHtml(row.canaryToken)}</title>`,
      '<style>html,body{margin:0;width:100%;height:100%;background:#000;display:grid;place-items:center;}</style>',
      '</head>',
      '<body>',
      `<img src="./${path.basename(pngPath)}" alt="${escapeHtml(row.canaryToken)}">`,
      '</body>',
      '</html>',
      '',
    ].join('\n'),
    'utf8',
  );

  return { htmlPath, pngPath };
}

export async function detectCanaryMarkerInImage(
  input: string | Buffer,
  options: CanaryPixelDetectionOptions = {},
): Promise<CanaryPixelDetectionResult> {
  const primary = options.primary ?? DEFAULT_PRIMARY;
  const secondary = options.secondary ?? DEFAULT_SECONDARY;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const minPixelsPerColor = options.minPixelsPerColor ?? DEFAULT_MIN_PIXELS_PER_COLOR;
  const minTotalRatio = options.minTotalRatio ?? DEFAULT_MIN_TOTAL_RATIO;
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  let primaryPixels = 0;
  let secondaryPixels = 0;

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    if (alpha < 64) {
      continue;
    }

    const color = {
      r: data[index] ?? 0,
      g: data[index + 1] ?? 0,
      b: data[index + 2] ?? 0,
    };

    if (matchesColor(color, primary, tolerance)) {
      primaryPixels++;
    } else if (matchesColor(color, secondary, tolerance)) {
      secondaryPixels++;
    }
  }

  const totalPixels = info.width * info.height;
  const markerRatio = totalPixels > 0 ? (primaryPixels + secondaryPixels) / totalPixels : 0;
  const visible = primaryPixels >= minPixelsPerColor
    && secondaryPixels >= minPixelsPerColor
    && markerRatio >= minTotalRatio;

  return {
    visible,
    totalPixels,
    primaryPixels,
    secondaryPixels,
    markerRatio,
    minPixelsPerColor,
    minTotalRatio,
  };
}

export class MacosScreencaptureAdapter implements CaptureMatrixAdapter {
  readonly name = 'macos-screencapture';
  private readonly platform: NodeJS.Platform;
  private readonly commandPath: string;
  private readonly runExecFile: ExecFileRunner;
  private readonly detect: typeof detectCanaryMarkerInImage;
  private readonly canaryArmed: boolean;

  constructor(options: MacosScreencaptureAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.commandPath = options.commandPath ?? '/usr/sbin/screencapture';
    this.runExecFile = options.execFile ?? defaultExecFileRunner;
    this.detect = options.detector ?? detectCanaryMarkerInImage;
    this.canaryArmed = options.canaryArmed ?? process.env.NATIVELY_CAPTURE_MATRIX_CANARY_ARMED === '1';
  }

  async prepare(row: CaptureMatrixRow): Promise<void> {
    assertValidRow(row);
    if (this.platform !== 'darwin') {
      throw new CaptureMatrixSkipError('macOS screencapture adapter only runs on darwin');
    }
    if (row.mode !== 'screenshot') {
      throw new CaptureMatrixSkipError(`macOS screencapture adapter requires screenshot mode, got ${row.mode}`);
    }
  }

  async startCapture(row: CaptureMatrixRow): Promise<LocalCaptureSession> {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), `capture-matrix-${row.id}-`));
    const fixture = await writeCanaryFixtureFiles(row, artifactDir);
    return {
      id: `macos-screencapture-${row.id}`,
      artifactDir,
      canaryHtmlPath: fixture.htmlPath,
      canaryPngPath: fixture.pngPath,
    };
  }

  async triggerVisibility(_row: CaptureMatrixRow, _session: CaptureAdapterSession): Promise<void> {
    return;
  }

  async collectArtifact(row: CaptureMatrixRow, session: CaptureAdapterSession): Promise<CaptureMatrixArtifact> {
    const localSession = asLocalCaptureSession(session);
    const capturePath = path.join(localSession.artifactDir, `${sanitizePathSegment(row.id)}-screencapture.png`);
    if (!this.canaryArmed) {
      throw new CaptureMatrixSkipError([
        'canary surface is not armed; load the generated canary HTML in the protected/control test surface',
        `canaryHtml=${localSession.canaryHtmlPath ?? '<none>'}`,
        'set NATIVELY_CAPTURE_MATRIX_CANARY_ARMED=1 when the fixture is visible',
      ].join('; '));
    }

    try {
      await this.runExecFile(this.commandPath, ['-x', capturePath], { timeoutMs: 15000 });
    } catch (error) {
      throw new CaptureMatrixSkipError(`screencapture unavailable or not permitted: ${getErrorMessage(error)}`);
    }

    let detection: CanaryPixelDetectionResult;
    try {
      detection = await this.detect(capturePath);
    } catch (error) {
      throw new CaptureMatrixSkipError(`captured image could not be analyzed: ${getErrorMessage(error)}`);
    }

    return {
      canaryVisible: detection.visible,
      capturePath,
      log: [
        `session=${session.id}`,
        `capture=${capturePath}`,
        `canaryHtml=${localSession.canaryHtmlPath ?? '<none>'}`,
        `canaryPng=${localSession.canaryPngPath ?? '<none>'}`,
        `primaryPixels=${detection.primaryPixels}`,
        `secondaryPixels=${detection.secondaryPixels}`,
        `markerRatio=${detection.markerRatio}`,
        `visible=${detection.visible}`,
      ].join('\n'),
    };
  }

  async analyze(row: CaptureMatrixRow, artifact: CaptureMatrixArtifact): Promise<Pick<CaptureMatrixRowResult, 'actualResult' | 'passed' | 'reason'>> {
    return analyzeCanaryVisibility(row, artifact.canaryVisible);
  }

  async cleanup(_row: CaptureMatrixRow, _session: CaptureAdapterSession): Promise<void> {
    return;
  }
}

export class MacosCgWindowEnumerationAdapter implements CaptureMatrixAdapter {
  readonly name = 'macos-cgwindow-enumeration';
  private readonly platform: NodeJS.Platform;
  private readonly nativeModule: Pick<NativeStealthBindings, 'listVisibleWindows'> | null;
  private readonly canaryArmed: boolean;

  constructor(options: MacosCgWindowEnumerationAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.nativeModule = options.nativeModule ?? loadNativeStealthModule({ retryOnFailure: true });
    this.canaryArmed = options.canaryArmed ?? process.env.NATIVELY_CAPTURE_MATRIX_CANARY_ARMED === '1';
  }

  async prepare(row: CaptureMatrixRow): Promise<void> {
    assertValidRow(row);
    if (this.platform !== 'darwin') {
      throw new CaptureMatrixSkipError('CGWindow enumeration adapter only runs on darwin');
    }
    if (row.mode !== 'window-enumeration') {
      throw new CaptureMatrixSkipError(`CGWindow enumeration adapter requires window-enumeration mode, got ${row.mode}`);
    }
    if (!this.nativeModule?.listVisibleWindows) {
      throw new CaptureMatrixSkipError('native listVisibleWindows binding is unavailable');
    }
    if (!this.canaryArmed) {
      throw new CaptureMatrixSkipError('canary surface is not armed; expose the canary token in the protected/control window title and set NATIVELY_CAPTURE_MATRIX_CANARY_ARMED=1');
    }
  }

  async startCapture(row: CaptureMatrixRow): Promise<CaptureAdapterSession> {
    return { id: `macos-cgwindow-${row.id}` };
  }

  async triggerVisibility(_row: CaptureMatrixRow, _session: CaptureAdapterSession): Promise<void> {
    return;
  }

  async collectArtifact(row: CaptureMatrixRow, session: CaptureAdapterSession): Promise<CaptureMatrixArtifact> {
    if (!this.nativeModule?.listVisibleWindows) {
      throw new CaptureMatrixSkipError('native listVisibleWindows binding is unavailable');
    }

    let windows: WindowInfo[];
    try {
      windows = this.nativeModule.listVisibleWindows();
    } catch (error) {
      throw new CaptureMatrixSkipError(`native CGWindow enumeration failed: ${getErrorMessage(error)}`);
    }

    const matches = windows.filter((window) => windowContainsCanary(window, row.canaryToken));
    return {
      canaryVisible: matches.length > 0,
      log: [
        `session=${session.id}`,
        `windowCount=${windows.length}`,
        `matchedWindowNumbers=${matches.map((window) => window.windowNumber).join(',') || '<none>'}`,
        `matchedOwners=${matches.map((window) => window.ownerName).filter(Boolean).join(',') || '<none>'}`,
        `visible=${matches.length > 0}`,
      ].join('\n'),
    };
  }

  async analyze(row: CaptureMatrixRow, artifact: CaptureMatrixArtifact): Promise<Pick<CaptureMatrixRowResult, 'actualResult' | 'passed' | 'reason'>> {
    return analyzeCanaryVisibility(row, artifact.canaryVisible);
  }

  async cleanup(_row: CaptureMatrixRow, _session: CaptureAdapterSession): Promise<void> {
    return;
  }
}

export class MacosScreenCaptureKitAdapter implements CaptureMatrixAdapter {
  readonly name = 'macos-screencapturekit-explicit';
  private readonly platform: NodeJS.Platform;
  private readonly enabled: boolean;
  private readonly capture?: MacosScreenCaptureKitAdapterOptions['capture'];
  private readonly detect: typeof detectCanaryMarkerInImage;

  constructor(options: MacosScreenCaptureKitAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.enabled = options.enabled ?? process.env.NATIVELY_CAPTURE_MATRIX_ENABLE_SCK === '1';
    this.capture = options.capture;
    this.detect = options.detector ?? detectCanaryMarkerInImage;
  }

  async prepare(row: CaptureMatrixRow): Promise<void> {
    assertValidRow(row);
    if (this.platform !== 'darwin') {
      throw new CaptureMatrixSkipError('ScreenCaptureKit adapter only runs on darwin');
    }
    if (row.mode !== 'video') {
      throw new CaptureMatrixSkipError(`ScreenCaptureKit adapter requires video mode, got ${row.mode}`);
    }
    if (!this.enabled) {
      throw new CaptureMatrixSkipError('ScreenCaptureKit adapter is explicit opt-in; set NATIVELY_CAPTURE_MATRIX_ENABLE_SCK=1 for release qualification');
    }
    if (!this.capture) {
      throw new CaptureMatrixSkipError('ScreenCaptureKit capture runner is not configured');
    }
  }

  async startCapture(row: CaptureMatrixRow): Promise<LocalCaptureSession> {
    return {
      id: `macos-sck-${row.id}`,
      artifactDir: await mkdtemp(path.join(os.tmpdir(), `capture-matrix-sck-${row.id}-`)),
    };
  }

  async triggerVisibility(_row: CaptureMatrixRow, _session: CaptureAdapterSession): Promise<void> {
    return;
  }

  async collectArtifact(row: CaptureMatrixRow, session: CaptureAdapterSession): Promise<CaptureMatrixArtifact> {
    const localSession = asLocalCaptureSession(session);
    if (!this.capture) {
      throw new CaptureMatrixSkipError('ScreenCaptureKit capture runner is not configured');
    }

    const capture = await this.capture(row, localSession.artifactDir);
    const detection = await this.detect(capture.capturePath);
    return {
      canaryVisible: detection.visible,
      capturePath: capture.capturePath,
      log: [
        `session=${session.id}`,
        capture.log ?? '',
        `primaryPixels=${detection.primaryPixels}`,
        `secondaryPixels=${detection.secondaryPixels}`,
        `markerRatio=${detection.markerRatio}`,
        `visible=${detection.visible}`,
      ].filter(Boolean).join('\n'),
    };
  }

  async analyze(row: CaptureMatrixRow, artifact: CaptureMatrixArtifact): Promise<Pick<CaptureMatrixRowResult, 'actualResult' | 'passed' | 'reason'>> {
    return analyzeCanaryVisibility(row, artifact.canaryVisible);
  }

  async cleanup(_row: CaptureMatrixRow, _session: CaptureAdapterSession): Promise<void> {
    return;
  }
}

export class WindowsCaptureAdapterStub implements CaptureMatrixAdapter {
  readonly name = 'windows-graphics-capture-stub';
  private readonly platform: NodeJS.Platform;

  constructor(options: { platform?: NodeJS.Platform } = {}) {
    this.platform = options.platform ?? process.platform;
  }

  async prepare(row: CaptureMatrixRow): Promise<void> {
    assertValidRow(row);
    if (this.platform !== 'win32') {
      throw new CaptureMatrixSkipError('Windows capture adapter only runs on win32');
    }
    throw new CaptureMatrixSkipError('Windows Graphics Capture automation is not implemented in this harness yet');
  }

  async startCapture(row: CaptureMatrixRow): Promise<CaptureAdapterSession> {
    return { id: `windows-stub-${row.id}` };
  }

  async triggerVisibility(_row: CaptureMatrixRow, _session: CaptureAdapterSession): Promise<void> {
    return;
  }

  async collectArtifact(_row: CaptureMatrixRow, _session: CaptureAdapterSession): Promise<CaptureMatrixArtifact> {
    throw new CaptureMatrixSkipError('Windows Graphics Capture automation is not implemented in this harness yet');
  }

  async analyze(row: CaptureMatrixRow, artifact: CaptureMatrixArtifact): Promise<Pick<CaptureMatrixRowResult, 'actualResult' | 'passed' | 'reason'>> {
    return analyzeCanaryVisibility(row, artifact.canaryVisible);
  }

  async cleanup(_row: CaptureMatrixRow, _session: CaptureAdapterSession): Promise<void> {
    return;
  }
}

export function createDefaultMacosScreencaptureRows(input: LocalCaptureAdapterOptions = {}): CaptureMatrixRow[] {
  return createProtectedAndControlRows({
    ...input,
    captureTool: 'macos-screencapture',
    mode: 'screenshot',
    protectedId: 'macos-screencapture-protected',
    controlId: 'macos-screencapture-control',
  });
}

export function createDefaultMacosCgWindowRows(input: LocalCaptureAdapterOptions = {}): CaptureMatrixRow[] {
  return createProtectedAndControlRows({
    ...input,
    captureTool: 'macos-cgwindow-enumeration',
    mode: 'window-enumeration',
    protectedId: 'macos-cgwindow-protected',
    controlId: 'macos-cgwindow-control',
  });
}

export function createDefaultMacosScreenCaptureKitRows(input: LocalCaptureAdapterOptions = {}): CaptureMatrixRow[] {
  return createProtectedAndControlRows({
    ...input,
    captureTool: 'macos-screencapturekit',
    mode: 'video',
    protectedId: 'macos-sck-protected',
    controlId: 'macos-sck-control',
  });
}

export function createDefaultWindowsCaptureRows(input: LocalCaptureAdapterOptions = {}): CaptureMatrixRow[] {
  return createProtectedAndControlRows({
    ...input,
    platform: input.platform ?? 'win32',
    captureTool: 'windows-graphics-capture',
    mode: 'manual',
    protectedId: 'windows-wgc-protected',
    controlId: 'windows-wgc-control',
  });
}

function createProtectedAndControlRows(input: LocalCaptureAdapterOptions & {
  captureTool: string;
  mode: CaptureMatrixRow['mode'];
  protectedId: string;
  controlId: string;
}): CaptureMatrixRow[] {
  const platform = input.platform ?? process.platform;
  const osVersion = input.osVersion ?? `${os.type()} ${os.release()}`;
  const appVersion = input.appVersion ?? process.env.NATIVELY_APP_VERSION ?? 'local-dev';
  const monitors = input.monitors ?? 1;
  const strict = input.strict ?? true;

  return [
    {
      id: input.protectedId,
      platform,
      osVersion,
      appVersion,
      captureTool: input.captureTool,
      mode: input.mode,
      monitors,
      strict,
      surface: 'protected-canary-surface',
      expectedResult: 'hidden',
      canaryToken: 'NATIVELY_CAPTURE_CANARY_PROTECTED',
    },
    {
      id: input.controlId,
      platform,
      osVersion,
      appVersion,
      captureTool: input.captureTool,
      mode: input.mode,
      monitors,
      strict: false,
      surface: 'unprotected-canary-control',
      expectedResult: 'visible',
      canaryToken: 'NATIVELY_CAPTURE_CANARY_CONTROL',
    },
  ];
}

function assertValidRow(row: CaptureMatrixRow): void {
  const errors = validateCaptureMatrixRow(row);
  if (errors.length > 0) {
    throw new Error(`invalid capture matrix row ${row.id || '<missing>'}: ${errors.join(', ')}`);
  }
}

function asLocalCaptureSession(session: CaptureAdapterSession): LocalCaptureSession {
  const localSession = session as Partial<LocalCaptureSession>;
  if (!localSession.artifactDir) {
    throw new Error(`capture session ${session.id} does not include an artifact directory`);
  }
  return localSession as LocalCaptureSession;
}

function defaultExecFileRunner(file: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: options?.timeoutMs ?? 15000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}${stderr ? `: ${stderr}` : ''}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function windowContainsCanary(window: WindowInfo, canaryToken: string): boolean {
  return window.windowTitle.includes(canaryToken) || window.ownerName.includes(canaryToken);
}

function matchesColor(actual: CanaryColor, expected: CanaryColor, tolerance: number): boolean {
  return Math.abs(actual.r - expected.r) <= tolerance
    && Math.abs(actual.g - expected.g) <= tolerance
    && Math.abs(actual.b - expected.b) <= tolerance;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-z0-9-_.]/gi, '_');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
