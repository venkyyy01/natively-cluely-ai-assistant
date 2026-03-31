import { execFile } from 'node:child_process';
import { EventEmitter } from 'events';

interface EnterpriseToolInfo {
  name: string;
  bundleId: string;
  category: 'monitoring' | 'proctoring' | 'remote-desktop' | 'screen-capture';
}

interface TCCMonitorOptions {
  platform?: string;
  checkIntervalMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

const KNOWN_ENTERPRISE_TOOLS: EnterpriseToolInfo[] = [
  { name: 'Teramind', bundleId: 'com.teramind.agent', category: 'monitoring' },
  { name: 'ActivTrak', bundleId: 'com.activtrak.agent', category: 'monitoring' },
  { name: 'Hubstaff', bundleId: 'com.hubstaff.desktop', category: 'monitoring' },
  { name: 'Time Doctor', bundleId: 'com.timedoctor.mac', category: 'monitoring' },
  { name: 'Veriato', bundleId: 'com.veriato.recorder', category: 'monitoring' },
  { name: 'ProctorU', bundleId: 'com.proctoru.app', category: 'proctoring' },
  { name: 'Proctorio', bundleId: 'com.proctorio.extension', category: 'proctoring' },
  { name: 'ExamSoft', bundleId: 'com.examsoft.examplanner', category: 'proctoring' },
  { name: 'Respondus LockDown', bundleId: 'com.respondus.lockdownbrowser', category: 'proctoring' },
  { name: 'TeamViewer', bundleId: 'com.teamviewer.TeamViewer', category: 'remote-desktop' },
  { name: 'AnyDesk', bundleId: 'com.anydesk.AnyDesk', category: 'remote-desktop' },
  { name: 'VNC', bundleId: 'com.realvnc.VNCServer', category: 'remote-desktop' },
  { name: 'Zoom', bundleId: 'us.zoom.xos', category: 'screen-capture' },
  { name: 'OBS', bundleId: 'com.obsproject.obs-studio', category: 'screen-capture' },
  { name: 'QuickTime', bundleId: 'com.apple.QuickTimePlayerX', category: 'screen-capture' },
  { name: 'Loom', bundleId: 'com.loom.desktop', category: 'screen-capture' },
];

export class TCCMonitor extends EventEmitter {
  private readonly platform: string;
  private readonly checkIntervalMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private checkHandle: unknown = null;
  private running = false;
  private grantedApps = new Map<string, string>();
  private suspiciousToolsDetected = new Set<string>();

  constructor(options: TCCMonitorOptions = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.checkIntervalMs = options.checkIntervalMs ?? 2000;
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.checkHandle || this.platform !== 'darwin') {
      return;
    }

    this.checkHandle = setInterval(() => this.check(), this.checkIntervalMs);
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
      const stdout = await this.execPromise('sqlite3', [
        '/Library/Application Support/com.apple.TCC/TCC.db',
        "SELECT client, auth_value FROM access WHERE service == 'kTCCServiceScreenCapture' AND auth_value > 0;",
      ]);

      const newGrantedApps = new Map<string, string>();

      if (stdout && stdout.trim()) {
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const parts = line.split('|');
          if (parts.length >= 2) {
            const bundleId = parts[0].trim();
            const authValue = parts[1].trim();
            newGrantedApps.set(bundleId, authValue);

            if (!this.grantedApps.has(bundleId)) {
              this.logger.log(`[TCCMonitor] New ScreenCapture grant: ${bundleId}`);
              this.emit('permission-granted', { bundleId, authValue });
            }
          }
        }
      }

      for (const bundleId of this.grantedApps.keys()) {
        if (!newGrantedApps.has(bundleId)) {
          this.logger.log(`[TCCMonitor] ScreenCapture revoked: ${bundleId}`);
          this.emit('permission-revoked', { bundleId });
        }
      }

      this.grantedApps = newGrantedApps;
    } catch {
      // TCC.db may be inaccessible due to SIP
    }
  }

  private async checkEnterpriseTools(): Promise<void> {
    const newSuspicious = new Set<string>();

    for (const tool of KNOWN_ENTERPRISE_TOOLS) {
      try {
        const stdout = await this.execPromise('pgrep', ['-lf', tool.bundleId]);
        if (stdout && stdout.trim()) {
          newSuspicious.add(tool.name);
          if (!this.suspiciousToolsDetected.has(tool.name)) {
            this.logger.log(`[TCCMonitor] Enterprise tool detected: ${tool.name} (${tool.category})`);
            this.emit('tool-detected', { ...tool, pid: stdout.trim().split(/\s+/)[0] });
          }
        }
      } catch {
        // pgrep returns non-zero when no matches
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
