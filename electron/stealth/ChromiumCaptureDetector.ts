import { EventEmitter } from 'events';
import { loadNativeStealthModule } from './nativeStealthModule';
import type { NativeStealthBindings } from './StealthManager';

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
  getProcessList?: () => Array<{ pid: number; ppid: number; name: string }>;
}

const BROWSER_PATTERNS = [
  { name: 'Chrome', pattern: /Google Chrome/i, bundleId: 'com.google.Chrome' },
  { name: 'Chromium', pattern: /Chromium/i, bundleId: 'org.chromium.Chromium' },
  { name: 'Edge', pattern: /Microsoft Edge/i, bundleId: 'com.microsoft.edgemac' },
  { name: 'Brave', pattern: /Brave Browser/i, bundleId: 'com.brave.Browser' },
  { name: 'Opera', pattern: /Opera/i, bundleId: 'com.operasoftware.Opera' },
  { name: 'Arc', pattern: /Arc/i, bundleId: 'company.thebrowser.Browser' },
];

const CONFIRMATION_WINDOW_MS = 1500;
const HYSTERESIS_MS = 5000;

export class ChromiumCaptureDetector extends EventEmitter {
  private readonly platform: string;
  private readonly checkIntervalMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly getProcessList: () => Array<{ pid: number; ppid: number; name: string }>;
  private checkHandle: unknown = null;
  private running = false;
  private detectedBrowsers = new Map<string, ChromiumProcessInfo>();
  private captureActive = false;
  private confirmationStartTime: number | null = null;
  private lastActiveEmitTime = 0;

  constructor(options: ChromiumCaptureDetectorOptions = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.checkIntervalMs = options.checkIntervalMs ?? 500;
    this.logger = options.logger ?? console;
    this.getProcessList = options.getProcessList ?? (() => {
      const mod = loadNativeStealthModule({ retryOnFailure: false });
      return mod?.getRunningProcesses?.() ?? [];
    });
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
    const procs = this.getProcessList();

    for (const browser of BROWSER_PATTERNS) {
      const matches = procs.filter(p => browser.pattern.test(p.name));
      for (const m of matches) {
        const key = `${browser.name}-${m.pid}`;
        if (!this.detectedBrowsers.has(key)) {
          this.logger.log(`[ChromiumCaptureDetector] Detected ${browser.name} (PID: ${m.pid})`);
          this.emit('browser-detected', { name: browser.name, pid: m.pid, bundleId: browser.bundleId });
        }
        newDetected.set(key, { pid: m.pid, name: browser.name, bundleId: browser.bundleId });
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
      const procs = this.getProcessList();
      const scAgent = procs.find(p => /ScreenCaptureAgent/i.test(p.name));
      if (!scAgent) return false;
      const parent = procs.find(p => p.pid === scAgent.ppid);
      if (!parent) return false;
      return BROWSER_PATTERNS.some(b => b.pattern.test(parent.name));
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

    this.logger.log('[ChromiumCaptureDetector] Native module unavailable; assuming no browser capture');
    return false;
  }
}
