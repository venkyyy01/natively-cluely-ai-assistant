import { execFile } from 'node:child_process';
import { EventEmitter } from 'events';

interface WindowInfo {
  windowId: number;
  ownerPid: number;
  ownerName: string;
  bundleId?: string;
  layer: number;
  alpha: number;
  sharingState?: string;
}

interface StealthEnhancerOptions {
  platform?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  commandRunner?: (command: string, args: string[]) => Promise<string>;
}

const CHROME_BUNDLE_IDS = new Set([
  'com.google.Chrome',
  'org.chromium.Chromium',
  'com.microsoft.edgemac',
  'com.brave.Browser',
  'com.operasoftware.Opera',
  'company.thebrowser.Browser',
]);

export class MacosStealthEnhancer extends EventEmitter {
  private readonly platform: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly commandRunner: (command: string, args: string[]) => Promise<string>;
  private enhancedWindows = new Set<number>();

  constructor(options: StealthEnhancerOptions = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? console;
    this.commandRunner = options.commandRunner ?? ((command, args) => this.execPromise(command, args));
  }

  async enhanceWindowProtection(windowNumber: number): Promise<boolean> {
    if (this.platform !== 'darwin') {
      return false;
    }

    try {
      const safeWindowNumber = this.normalizeWindowNumber(windowNumber);
      await this.applyWindowLevel(safeWindowNumber, 0);
      await this.disableWindowSharing(safeWindowNumber);
      this.enhancedWindows.add(safeWindowNumber);
      this.logger.log(`[MacosStealthEnhancer] Enhanced protection applied to window ${safeWindowNumber}`);
      this.emit('window-enhanced', safeWindowNumber);
      return true;
    } catch (error) {
      this.logger.warn('[MacosStealthEnhancer] Failed to enhance window protection:', error);
      return false;
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
    await this.execPython(`
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
    await this.execPython(`
import Cocoa
import sys

window_number = ${windowNumber}

app = Cocoa.NSApplication.sharedApplication()
windows = app.windows()

for window in windows:
    if window.windowNumber() == window_number:
        window.setSharingType_(0)
        break
`);
  }

  private async enableWindowSharing(windowNumber: number): Promise<void> {
    await this.execPython(`
import Cocoa
import sys

window_number = ${windowNumber}

app = Cocoa.NSApplication.sharedApplication()
windows = app.windows()

for window in windows:
    if window.windowNumber() == window_number:
        window.setSharingType_(1)
        break
`);
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
      const pidList = Array.from(pids).join(',');
      const stdout = await this.execPython(`
import Quartz
import sys

target_pids = {${pidList}}
windows = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionAll,
    Quartz.kCGNullWindowID
)

captured = []
for window in windows:
    owner_pid = window.get('kCGWindowOwnerPID', -1)
    if owner_pid in target_pids:
        window_id = window.get('kCGWindowNumber', -1)
        captured.append(window_id)

print(','.join(str(w) for w in captured))
`);

      if (stdout && stdout.trim()) {
        for (const part of stdout.trim().split(',')) {
          const windowId = parseInt(part, 10);
          if (Number.isFinite(windowId) && windowId > 0) {
            capturedWindows.add(windowId);
          }
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

  private async execPython(script: string): Promise<string> {
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
