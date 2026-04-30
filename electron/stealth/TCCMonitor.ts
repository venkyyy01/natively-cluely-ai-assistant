import { EventEmitter } from 'events';
import { loadNativeStealthModule } from './nativeStealthModule';
import { KNOWN_ENTERPRISE_TOOLS } from './enterpriseToolRegistry';

interface TCCMonitorOptions {
  platform?: string;
  checkIntervalMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  getProcessList?: () => Array<{ pid: number; ppid: number; name: string }>;
}

const TCC_DB_PATH = '/Library/Application Support/com.apple.TCC/TCC.db';

export class TCCMonitor extends EventEmitter {
  private readonly platform: string;
  private readonly checkIntervalMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly getProcessList: () => Array<{ pid: number; ppid: number; name: string }>;
  private checkHandle: unknown = null;
  private running = false;
  private grantedApps = new Map<string, string>();
  private suspiciousToolsDetected = new Set<string>();

  constructor(options: TCCMonitorOptions = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.checkIntervalMs = options.checkIntervalMs ?? 2000;
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
    this.logger.log('[TCCMonitor] Started monitoring ScreenCapture permissions');
  }

  stop(): void {
    if (this.checkHandle) {
      clearInterval(this.checkHandle as NodeJS.Timeout);
      this.checkHandle = null;
      this.logger.log('[TCCMonitor] Stopped monitoring');
    }
  }

  getGrantedApps(): Map<string, string> {
    return new Map(this.grantedApps);
  }

  getSuspiciousTools(): Set<string> {
    return new Set(this.suspiciousToolsDetected);
  }

  private async check(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.checkTCCDatabase();
      await this.checkEnterpriseTools();
    } catch (error) {
      this.logger.warn('[TCCMonitor] Check failed:', error);
    } finally {
      this.running = false;
    }
  }

  private async checkTCCDatabase(): Promise<void> {
    try {
      // T-001: Use better-sqlite3 instead of spawning sqlite3 child process
      const Database = require('better-sqlite3');
      const db = new Database(TCC_DB_PATH, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare(
          "SELECT client, auth_value FROM access WHERE service == 'kTCCServiceScreenCapture' AND auth_value > 0;"
        ).all() as Array<{ client: string; auth_value: number }>;

        const newGrantedApps = new Map<string, string>();

        for (const row of rows) {
          const bundleId = row.client?.trim();
          const authValue = String(row.auth_value);
          if (!bundleId) continue;
          newGrantedApps.set(bundleId, authValue);

          if (!this.grantedApps.has(bundleId)) {
            this.logger.log(`[TCCMonitor] New ScreenCapture grant: ${bundleId}`);
            this.emit('permission-granted', { bundleId, authValue });
          }
        }

        for (const bundleId of this.grantedApps.keys()) {
          if (!newGrantedApps.has(bundleId)) {
            this.logger.log(`[TCCMonitor] ScreenCapture revoked: ${bundleId}`);
            this.emit('permission-revoked', { bundleId });
          }
        }

        this.grantedApps = newGrantedApps;
      } finally {
        db.close();
      }
    } catch {
      // TCC.db may be inaccessible due to SIP, or better-sqlite3 unavailable
    }
  }

  private async checkEnterpriseTools(): Promise<void> {
    const newSuspicious = new Set<string>();
    const procs = this.getProcessList();

    for (const tool of KNOWN_ENTERPRISE_TOOLS) {
      try {
        const match = procs.find(p => p.name.includes(tool.bundleId) || p.name.includes(tool.name));
        if (match) {
          newSuspicious.add(tool.name);
          if (!this.suspiciousToolsDetected.has(tool.name)) {
            this.logger.log(`[TCCMonitor] Enterprise tool detected: ${tool.name} (${tool.category})`);
            this.emit('tool-detected', { ...tool, pid: String(match.pid) });
          }
        }
      } catch {
        // Process not found
      }
    }

    for (const toolName of this.suspiciousToolsDetected) {
      if (!newSuspicious.has(toolName)) {
        this.logger.log(`[TCCMonitor] Enterprise tool no longer running: ${toolName}`);
        this.emit('tool-lost', { name: toolName });
      }
    }

    this.suspiciousToolsDetected = newSuspicious;
  }
}
