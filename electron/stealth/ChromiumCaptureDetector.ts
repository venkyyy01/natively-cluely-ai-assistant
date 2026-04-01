import { execFile } from 'node:child_process';
import { EventEmitter } from 'events';

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

export class ChromiumCaptureDetector extends EventEmitter {
  private readonly platform: string;
  private readonly checkIntervalMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private checkHandle: unknown = null;
  private running = false;
  private detectedBrowsers = new Map<string, ChromiumProcessInfo>();
  private captureActive = false;

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
        this.emit('capture-inactive');
      }
      return;
    }

    try {
      const hasActiveCapture = await this.checkBrowserWindowCapture();

      if (hasActiveCapture && !this.captureActive) {
        this.captureActive = true;
        this.logger.log('[ChromiumCaptureDetector] Browser-based screen capture likely active');
        this.emit('capture-active');
      } else if (!hasActiveCapture && this.captureActive) {
        this.captureActive = false;
        this.logger.log('[ChromiumCaptureDetector] Browser-based screen capture ended');
        this.emit('capture-inactive');
      }
    } catch (error) {
      this.logger.warn('[ChromiumCaptureDetector] Capture activity check failed:', error);
    }
  }

  private async checkBrowserWindowCapture(): Promise<boolean> {
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

    try {
      const stdout = await this.execPromise('ioreg', ['-r', '-c', 'AppleDisplay', '-l']);
      if (stdout && stdout.toLowerCase().includes('screen')) {
        const hasBrowserCapture = await this.checkCGWindowListForBrowserCapture();
        if (hasBrowserCapture) {
          return true;
        }
      }
    } catch {
      // Ignore errors
    }

    return false;
  }

  private async checkCGWindowListForBrowserCapture(): Promise<boolean> {
    try {
      const stdout = await this.execPromise('python3', ['-c', `
import Quartz
import sys

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

for window in windows:
    owner_bundle = window.get('kCGWindowOwnerBundleIdentifier', '')
    if owner_bundle in browser_bundle_ids:
        window_name = window.get('kCGWindowName', '')
        if any(keyword in window_name.lower() for keyword in ['sharing', 'presenting', 'screen', 'broadcast']):
            print('CAPTURE_DETECTED')
            sys.exit(0)

print('NO_CAPTURE')
`]);

      return stdout.includes('CAPTURE_DETECTED');
    } catch {
      return false;
    }
  }

  private execPromise(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 5000 }, (error, stdout) => {
        const err = error as NodeJS.ErrnoException | null;
        if (err && err.code !== '1') {
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });
  }
}
