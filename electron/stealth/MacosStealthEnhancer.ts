import { execFile } from 'node:child_process';
import { EventEmitter } from 'events';
import { decideStealthFallback } from './StealthFallbackPolicy';
import { loadNativeStealthModule } from './nativeStealthModule';

interface StealthEnhancerOptions {
  platform?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  commandRunner?: (command: string, args: string[]) => Promise<string>;
  nativeModule?: NativeMacosStealthBindings | null;
}

interface NativeMacosWindowInfo {
  windowNumber: number;
  ownerPid: number;
}

interface NativeMacosStealthBindings {
  applyMacosWindowStealth?: (windowNumber: number) => void;
  removeMacosWindowStealth?: (windowNumber: number) => void;
  setMacosWindowLevel?: (windowNumber: number, level: number) => void;
  listVisibleWindows?: () => NativeMacosWindowInfo[];
}

// kCGUtilityWindowLevel equivalent (NSWindowLevel.utility = 19)
// See electron/stealth/implementation-plan.md §6.2 / §8.1
const MACOS_UTILITY_WINDOW_LEVEL = 19;

export class MacosStealthEnhancer extends EventEmitter {
  private readonly platform: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly commandRunner: (command: string, args: string[]) => Promise<string>;
  private nativeModule: NativeMacosStealthBindings | null | undefined;
  private enhancedWindows = new Set<number>();

  constructor(options: StealthEnhancerOptions = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? console;
    this.commandRunner = options.commandRunner ?? ((command, args) => this.execPromise(command, args));
    this.nativeModule = options.nativeModule;
  }

  async enhanceWindowProtection(windowNumber: number): Promise<boolean> {
    if (this.platform !== 'darwin') {
      return false;
    }

    try {
      const safeWindowNumber = this.normalizeWindowNumber(windowNumber);
      await this.applyWindowLevel(safeWindowNumber, MACOS_UTILITY_WINDOW_LEVEL);
      await this.disableWindowSharing(safeWindowNumber);
      // EXPERIMENTAL (NATIVELY_TRY_SCK_TAG=1): also write the
      // reverse-engineered CGS tag bit. No-op by default.
      // disableWindowSharing already calls
      // `[NSWindow setSharingType:.none]` (the documented capture
      // exclusion API), so this is opt-in extra.
      this.applySckExclusionDirect(safeWindowNumber);
      this.enhancedWindows.add(safeWindowNumber);
      this.logger.log(`[MacosStealthEnhancer] Enhanced protection applied to window ${safeWindowNumber}`);
      this.emit('window-enhanced', safeWindowNumber);
      return true;
    } catch (error) {
      this.logger.warn('[MacosStealthEnhancer] Failed to enhance window protection:', error);
      return false;
    }
  }

  /**
   * EXPERIMENTAL: Apply the reverse-engineered CGS tag bit directly via
   * the native module. The same bit is exposed by
   * `StealthManager.applySckExclusion`; this direct path exists for
   * Chromium-capture countermeasures where we want to write the bit
   * without going through the manager's record bookkeeping.
   *
   * Default OFF. Opt in via `NATIVELY_TRY_SCK_TAG=1`. The verifier loops
   * endlessly with false negatives on macOS 15+, so we keep the
   * experiment as an explicit env-only flag.
   */
  private applySckExclusionDirect(windowNumber: number): void {
    if (process.env.NATIVELY_TRY_SCK_TAG !== '1') {
      return;
    }
    const nativeModule = this.getNativeModule();
    const mod = nativeModule as Record<string, unknown> | null;
    if (mod && typeof mod.applySckExclusion === 'function') {
      try {
        (mod.applySckExclusion as (wn: number) => void)(windowNumber);
      } catch (error) {
        this.logger.warn('[MacosStealthEnhancer] SCK exclusion direct apply failed:', error);
      }
    } else if (mod && typeof mod.excludeFromCapture === 'function') {
      try {
        (mod.excludeFromCapture as (wn: number) => void)(windowNumber);
      } catch (error) {
        this.logger.warn('[MacosStealthEnhancer] excludeFromCapture direct apply failed:', error);
      }
    }
  }

  async removeEnhancedProtection(windowNumber: number): Promise<void> {
    if (this.platform !== 'darwin') {
      return;
    }

    try {
      const safeWindowNumber = this.normalizeWindowNumber(windowNumber);
      await this.enableWindowSharing(safeWindowNumber);
      this.enhancedWindows.delete(safeWindowNumber);
      this.logger.log(`[MacosStealthEnhancer] Enhanced protection removed from window ${safeWindowNumber}`);
      this.emit('window-degraded', safeWindowNumber);
    } catch (error) {
      this.logger.warn('[MacosStealthEnhancer] Failed to remove enhanced protection:', error);
    }
  }

  async detectChromiumCaptureAttempt(targetWindowNumber: number): Promise<boolean> {
    if (this.platform !== 'darwin') {
      return false;
    }

    try {
      const safeWindowNumber = this.normalizeWindowNumber(targetWindowNumber);
      const chromePids = await this.getChromePids();
      if (chromePids.size === 0) {
        return false;
      }

      const capturedWindows = await this.getWindowsCapturedByPids(chromePids);
      return capturedWindows.has(safeWindowNumber);
    } catch {
      return false;
    }
  }

  private normalizeWindowNumber(windowNumber: number): number {
    if (!Number.isSafeInteger(windowNumber) || windowNumber <= 0) {
      throw new Error(`Invalid macOS window number: ${windowNumber}`);
    }

    return windowNumber;
  }

  async getActiveScreenCaptureSessions(): Promise<Array<{ pid: number; name: string }>> {
    if (this.platform !== 'darwin') {
      return [];
    }

    const sessions: Array<{ pid: number; name: string }> = [];

    try {
      const stdout = await this.execPromise('pgrep', ['-lf', 'ScreenCaptureAgent']);
      if (stdout && stdout.trim()) {
        const lines = stdout.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const parts = line.split(/\s+/);
          const pid = parseInt(parts[0], 10);
          if (Number.isFinite(pid)) {
            const parentInfo = await this.getParentProcessInfo(pid);
            if (parentInfo) {
              sessions.push({ pid: parentInfo.pid, name: parentInfo.name });
            }
          }
        }
      }
    } catch {
      // Ignore errors
    }

    return sessions;
  }

  private async applyWindowLevel(windowNumber: number, level: number): Promise<void> {
    const nativeModule = this.getNativeModule();
    if (nativeModule?.setMacosWindowLevel) {
      nativeModule.setMacosWindowLevel(windowNumber, level);
      return;
    }

    await this.execDevelopmentPythonFallback(`
import Cocoa
import sys

window_number = ${windowNumber}
level = ${level}

app = Cocoa.NSApplication.sharedApplication()
windows = app.windows()

for window in windows:
    if window.windowNumber() == window_number:
        window.setLevel_(level)
        break
`);
  }

  private async disableWindowSharing(windowNumber: number): Promise<void> {
    const nativeModule = this.getNativeModule();
    // The native module sets `NSWindow.sharingType = .none` (the documented
    // capture-exclusion API) and reinforces it via the private CGS SPI
    // `CGSSetWindowSharingState`. Both calls run on every macOS version
    // (mac branch parity, restored after the slopcode 15+ skip).
    if (nativeModule?.applyMacosWindowStealth) {
      nativeModule.applyMacosWindowStealth(windowNumber);
      return;
    }

    this.logger.warn('[MacosStealthEnhancer] Native module unavailable, skipping window sharing disable');
  }

  private async enableWindowSharing(windowNumber: number): Promise<void> {
    const nativeModule = this.getNativeModule();
    // Always use the native module — it handles macOS version branching internally.
    if (nativeModule?.removeMacosWindowStealth) {
      nativeModule.removeMacosWindowStealth(windowNumber);
      return;
    }

    this.logger.warn('[MacosStealthEnhancer] Native module unavailable, skipping window sharing restore');
  }

  private async getChromePids(): Promise<Set<number>> {
    const pids = new Set<number>();

    try {
      const stdout = await this.execPromise('pgrep', ['-f', 'Google Chrome']);
      if (stdout && stdout.trim()) {
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const pid = parseInt(line.split(/\s+/)[0], 10);
          if (Number.isFinite(pid)) {
            pids.add(pid);
          }
        }
      }
    } catch {
      // Ignore
    }

    try {
      const stdout = await this.execPromise('pgrep', ['-f', 'Microsoft Edge']);
      if (stdout && stdout.trim()) {
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const pid = parseInt(line.split(/\s+/)[0], 10);
          if (Number.isFinite(pid)) {
            pids.add(pid);
          }
        }
      }
    } catch {
      // Ignore
    }

    return pids;
  }

  private async getWindowsCapturedByPids(pids: Set<number>): Promise<Set<number>> {
    const capturedWindows = new Set<number>();

    try {
      const nativeModule = this.getNativeModule();
      if (!nativeModule?.listVisibleWindows) {
        throw new Error('native listVisibleWindows unavailable');
      }

      for (const window of nativeModule.listVisibleWindows()) {
        if (pids.has(window.ownerPid) && window.windowNumber > 0) {
          capturedWindows.add(window.windowNumber);
        }
      }
    } catch {
      // Ignore
    }

    return capturedWindows;
  }

  private async getParentProcessInfo(pid: number): Promise<{ pid: number; name: string } | null> {
    try {
      const stdout = await this.execPromise('ps', ['-o', 'ppid,comm=', '-p', String(pid)]);
      if (stdout && stdout.trim()) {
        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 2) {
          const parentPid = parseInt(parts[0], 10);
          const parentName = parts.slice(1).join(' ');
          if (Number.isFinite(parentPid)) {
            return { pid: parentPid, name: parentName };
          }
        }
      }
    } catch {
      // Ignore
    }

    return null;
  }

  private getNativeModule(): NativeMacosStealthBindings | null {
    if (this.nativeModule !== undefined) {
      return this.nativeModule;
    }

    this.nativeModule = loadNativeStealthModule({ retryOnFailure: false });
    return this.nativeModule;
  }

  private async execDevelopmentPythonFallback(script: string): Promise<string> {
    const decision = decideStealthFallback({ kind: 'python' });
    if (!decision.allow) {
      this.logger.warn(`[MacosStealthEnhancer] Python fallback blocked: ${decision.reason}`);
      throw new Error(decision.reason);
    }

    this.logger.log(`[MacosStealthEnhancer] Python fallback policy: ${decision.reason}`);
    return this.commandRunner('python3', ['-c', script]);
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
