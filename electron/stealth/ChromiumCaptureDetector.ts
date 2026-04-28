import { execFile } from 'node:child_process';
import { EventEmitter } from 'events';
import { loadNativeStealthModule } from './nativeStealthModule';
import {
  getOptionalPythonFallbackReason,
  getProcessErrorSummary,
  withStderr,
} from './pythonFallback';
import type { NativeStealthBindings } from './StealthManager';
import { decideStealthFallback } from './StealthFallbackPolicy';

interface ChromiumProcessInfo {
  pid: number;
  name: string;
  bundleId?: string;
  isCapturing?: boolean;
}

interface ChromiumCaptureDetectorOptions {
  platform?: string;
  checkIntervalMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

const BROWSER_PATTERNS = [
  { name: 'Chrome', pattern: /Google Chrome/i, bundleId: 'com.google.Chrome' },
  { name: 'Chromium', pattern: /Chromium/i, bundleId: 'org.chromium.Chromium' },
  { name: 'Edge', pattern: /Microsoft Edge/i, bundleId: 'com.microsoft.edgemac' },
  { name: 'Brave', pattern: /Brave Browser/i, bundleId: 'com.brave.Browser' },
  { name: 'Opera', pattern: /Opera/i, bundleId: 'com.operasoftware.Opera' },
  { name: 'Arc', pattern: /Arc/i, bundleId: 'company.thebrowser.Browser' },
];

const MEETING_SITE_PATTERNS = [
  /meet\.google\.com/i,
  /teams\.microsoft\.com/i,
  /zoom\.us/i,
  /webex\.com/i,
  /app\.slack\.com/i,
  /discord\.com/i,
];

const CAPTURE_KEYWORDS = ['sharing', 'presenting', 'screen', 'broadcast'];

const CONFIRMATION_WINDOW_MS = 1500;
const HYSTERESIS_MS = 5000;

export class ChromiumCaptureDetector extends EventEmitter {
  private readonly platform: string;
  private readonly checkIntervalMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private checkHandle: unknown = null;
  private running = false;
  private detectedBrowsers = new Map<string, ChromiumProcessInfo>();
  private captureActive = false;
  private confirmationStartTime: number | null = null;
  private lastActiveEmitTime = 0;
  private readonly pythonFallbackNotices = new Set<string>();

  constructor(options: ChromiumCaptureDetectorOptions = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.checkIntervalMs = options.checkIntervalMs ?? 500;
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.checkHandle || this.platform !== 'darwin') {
      return;
    }

    const handle = setInterval(() => this.check(), this.checkIntervalMs);
    handle.unref?.();
    this.checkHandle = handle;
    this.logger.log('[ChromiumCaptureDetector] Monitor started');
  }

  stop(): void {
    if (this.checkHandle) {
      clearInterval(this.checkHandle as NodeJS.Timeout);
      this.checkHandle = null;
      this.logger.log('[ChromiumCaptureDetector] Monitor stopped');
    }
  }

  getDetectedBrowsers(): Map<string, ChromiumProcessInfo> {
    return new Map(this.detectedBrowsers);
  }

  isCaptureLikelyActive(): boolean {
    return this.captureActive;
  }

  private logPythonFallbackNoticeOnce(key: string, message: string): void {
    if (this.pythonFallbackNotices.has(key)) {
      return;
    }

    this.pythonFallbackNotices.add(key);
    this.logger.log(message);
  }

  private async check(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.detectBrowserProcesses();
      await this.checkCaptureActivity();
    } catch (error) {
      this.logger.warn('[ChromiumCaptureDetector] Check failed:', error);
    } finally {
      this.running = false;
    }
  }

  private async detectBrowserProcesses(): Promise<void> {
    if (this.platform !== 'darwin') {
      return;
    }

    const newDetected = new Map<string, ChromiumProcessInfo>();

    for (const browser of BROWSER_PATTERNS) {
      try {
        const stdout = await this.execPromise('pgrep', ['-lf', browser.pattern.source]);
        if (stdout && stdout.trim()) {
          const lines = stdout.trim().split('\n').filter(Boolean);
          for (const line of lines) {
            const parts = line.split(/\s+/);
            const pid = parseInt(parts[0], 10);
            if (Number.isFinite(pid) && pid > 0) {
              const key = `${browser.name}-${pid}`;
              if (!this.detectedBrowsers.has(key)) {
                this.logger.log(`[ChromiumCaptureDetector] Detected ${browser.name} (PID: ${pid})`);
                this.emit('browser-detected', { name: browser.name, pid, bundleId: browser.bundleId });
              }
              newDetected.set(key, { pid, name: browser.name, bundleId: browser.bundleId });
            }
          }
        }
      } catch {
        // pgrep returns non-zero when no matches found
      }
    }

    for (const key of this.detectedBrowsers.keys()) {
      if (!newDetected.has(key)) {
        const info = this.detectedBrowsers.get(key);
        if (info) {
          this.logger.log(`[ChromiumCaptureDetector] ${info.name} (PID: ${info.pid}) no longer detected`);
          this.emit('browser-lost', info);
        }
      }
    }

    this.detectedBrowsers = newDetected;
  }

  private async checkCaptureActivity(): Promise<void> {
    if (this.platform !== 'darwin' || this.detectedBrowsers.size === 0) {
      if (this.captureActive) {
        this.captureActive = false;
        this.confirmationStartTime = null;
        this.emit('capture-inactive');
      }
      return;
    }

    const [signalParentage, signalWindowTitle] = await Promise.all([
      this.checkScreenCaptureAgentParentage(),
      this.checkBrowserWindowTitleCapture(),
    ]);

    const bothSignals = signalParentage && signalWindowTitle;
    const hysteresisExpired = Date.now() - this.lastActiveEmitTime > HYSTERESIS_MS;

    if (bothSignals) {
      if (!this.captureActive && hysteresisExpired) {
        if (this.confirmationStartTime === null) {
          this.confirmationStartTime = Date.now();
          this.logger.log('[ChromiumCaptureDetector] Both corroborating signals detected; starting confirmation window');
        } else if (Date.now() - this.confirmationStartTime >= CONFIRMATION_WINDOW_MS) {
          this.captureActive = true;
          this.lastActiveEmitTime = Date.now();
          this.logger.log('[ChromiumCaptureDetector] Browser-based screen capture confirmed after corroboration window');
          this.emit('capture-active');
        }
      }
      // If captureActive is already true, stay active (no re-emit needed)
    } else {
      // One or both signals lost
      if (this.confirmationStartTime !== null) {
        this.confirmationStartTime = null;
        this.logger.log('[ChromiumCaptureDetector] Corroboration lost before confirmation; cancelled');
      }
      if (this.captureActive) {
        this.captureActive = false;
        this.logger.log('[ChromiumCaptureDetector] Browser-based screen capture ended');
        this.emit('capture-inactive');
      }
    }
  }

  private async checkScreenCaptureAgentParentage(): Promise<boolean> {
    try {
      const stdout = await this.execPromise('pgrep', ['-lf', 'ScreenCaptureAgent']);
      if (stdout && stdout.trim()) {
        const screenCaptureAgentPid = stdout.trim().split(/\s+/)[0];
        const ppidStdout = await this.execPromise('ps', ['-o', 'ppid=', '-p', screenCaptureAgentPid]);
        if (ppidStdout && ppidStdout.trim()) {
          const ppid = parseInt(ppidStdout.trim(), 10);
          if (Number.isFinite(ppid)) {
            const parentStdout = await this.execPromise('ps', ['-o', 'comm=', '-p', String(ppid)]);
            if (parentStdout) {
              const parentName = parentStdout.trim().toLowerCase();
              for (const browser of BROWSER_PATTERNS) {
                if (browser.pattern.test(parentName)) {
                  this.logger.log(`[ChromiumCaptureDetector] ScreenCaptureAgent spawned by ${browser.name}`);
                  return true;
                }
              }
            }
          }
        }
      }
    } catch {
      // Ignore errors in capture detection
    }
    return false;
  }

  private nativeModule: NativeStealthBindings | null = null;

  private async checkBrowserWindowTitleCapture(): Promise<boolean> {
    // S-8: Native result is authoritative. False means no matching browser capture window.
    try {
      if (!this.nativeModule) {
        this.nativeModule = loadNativeStealthModule({ retryOnFailure: false });
      }
      if (this.nativeModule?.checkBrowserCaptureWindows) {
        this.logger.log('[ChromiumCaptureDetector] S-8: Trying native checkBrowserCaptureWindows');
        const nativeResult = this.nativeModule.checkBrowserCaptureWindows();
        if (nativeResult) {
          this.logger.log('[ChromiumCaptureDetector] S-8: Native detected capture');
          return true;
        }
        this.logger.log('[ChromiumCaptureDetector] S-8: Native returned no browser capture windows');
        return false;
      }
    } catch (nativeError) {
      this.logger.warn('[ChromiumCaptureDetector] S-8: Native checkBrowserCaptureWindows failed, checking fallback policy:', nativeError);
    }

    // Development-only fallback for local diagnosis when the native module is unavailable.
    const pythonPolicy = decideStealthFallback({ kind: 'python' });
    if (!pythonPolicy.allow) {
      this.logPythonFallbackNoticeOnce(
        `policy:${pythonPolicy.warning}`,
        `[ChromiumCaptureDetector] S-8: Python fallback blocked by policy (${pythonPolicy.reason}); continuing without browser-title corroboration`
      );
      return false;
    }
    this.logPythonFallbackNoticeOnce(
      `policy:${pythonPolicy.warning}`,
      `[ChromiumCaptureDetector] S-8: Python fallback policy: ${pythonPolicy.reason}`
    );

    try {
      this.logger.log('[ChromiumCaptureDetector] S-8: Using Python fallback for browser capture detection');
      const stdout = await this.execPromise('python3', ['-c', `
import Quartz
import sys
import re

windows = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionAll,
    Quartz.kCGNullWindowID
)

browser_bundle_ids = {
    'com.google.Chrome',
    'org.chromium.Chromium',
    'com.microsoft.edgemac',
    'com.brave.Browser',
    'com.operasoftware.Opera',
    'company.thebrowser.Browser'
}

meeting_patterns = [
    r'meet\\.google\\.com',
    r'teams\\.microsoft\\.com',
    r'zoom\\.us',
    r'webex\\.com',
    r'app\\.slack\\.com',
    r'discord\\.com',
]

for window in windows:
    owner_bundle = window.get('kCGWindowOwnerBundleIdentifier', '')
    if owner_bundle in browser_bundle_ids:
        window_name = window.get('kCGWindowName', '')
        lower_name = window_name.lower()
        has_capture_keyword = any(keyword in lower_name for keyword in ['sharing', 'presenting', 'screen', 'broadcast'])
        has_meeting_pattern = any(re.search(p, window_name) for p in meeting_patterns)
        if has_capture_keyword or has_meeting_pattern:
            print('CAPTURE_DETECTED')
            sys.exit(0)

print('NO_CAPTURE')
`]);

      return stdout.includes('CAPTURE_DETECTED');
    } catch (pythonError) {
      const optionalReason = getOptionalPythonFallbackReason(pythonError);
      if (optionalReason) {
        this.logPythonFallbackNoticeOnce(
          `optional:${optionalReason}`,
          `[ChromiumCaptureDetector] S-8: Python fallback unavailable (${optionalReason}); continuing without browser-title corroboration`
        );
        return false;
      }

      const summary = getProcessErrorSummary(pythonError);
      this.logPythonFallbackNoticeOnce(
        `unexpected:${summary}`,
        '[ChromiumCaptureDetector] S-8: Python fallback failed; continuing without browser-title corroboration'
      );
      return false;
    }
  }

  private execPromise(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
        const err = withStderr(error, stderr);
        if (err && err.code !== '1') {
          reject(err);
          return;
        }
        resolve(stdout);
      });
    });
  }
}
