import { execFile } from 'node:child_process';

export type ThreatCategory = 'monitoring' | 'proctoring' | 'remote-desktop' | 'screen-capture';
export type ThreatSeverity = 'critical' | 'warning';

export interface DetectedThreat {
  name: string;
  pid: string;
  category: ThreatCategory;
  severity: ThreatSeverity;
}

interface EnterpriseToolInfo {
  name: string;
  bundleId: string;
  category: ThreatCategory;
}

// Shared with TCCMonitor - these are the 16 known enterprise tools
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

const CRITICAL_CATEGORIES: Set<ThreatCategory> = new Set(['monitoring', 'proctoring']);

export interface MonitoringDetectorOptions {
  platform?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  execFileFn?: typeof execFile;
  timeoutMs?: number;
}

export class MonitoringDetector {
  private readonly platform: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly execFileFn: typeof execFile;
  private readonly timeoutMs: number;
  private running = false;

  constructor(options: MonitoringDetectorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? console;
    this.execFileFn = options.execFileFn ?? execFile;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async detect(): Promise<DetectedThreat[]> {
    if (this.running) {
      return [];
    }

    this.running = true;
    try {
      return await this.detectThreats();
    } catch (error) {
      this.logger.warn('[MonitoringDetector] Detection failed:', error);
      return [];
    } finally {
      this.running = false;
    }
  }

  private async detectThreats(): Promise<DetectedThreat[]> {
    const threats: DetectedThreat[] = [];

    for (const tool of KNOWN_ENTERPRISE_TOOLS) {
      try {
        const pid = await this.checkProcess(tool.bundleId);
        if (pid) {
          const severity = CRITICAL_CATEGORIES.has(tool.category) ? 'critical' : 'warning';
          threats.push({
            name: tool.name,
            pid,
            category: tool.category,
            severity,
          });
        }
      } catch {
        // Process not found - continue to next
      }
    }

    return threats;
  }

  private async checkProcess(bundleId: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.execFileFn('pgrep', ['-lf', bundleId], { timeout: this.timeoutMs }, (error, stdout) => {
        const err = error as NodeJS.ErrnoException | null;
        if (err && err.code !== '1') {
          reject(error);
          return;
        }
        if (stdout && stdout.trim()) {
          // Extract PID from first line
          const pid = stdout.trim().split(/\s+/)[0];
          resolve(pid);
        } else {
          resolve(null);
        }
      });
    });
  }

  isToolCritical(name: string): boolean {
    const tool = KNOWN_ENTERPRISE_TOOLS.find(t => t.name === name);
    return tool ? CRITICAL_CATEGORIES.has(tool.category) : false;
  }

  getToolCategory(name: string): ThreatCategory | null {
    const tool = KNOWN_ENTERPRISE_TOOLS.find(t => t.name === name);
    return tool?.category ?? null;
  }

  static getKnownTools(): readonly EnterpriseToolInfo[] {
    return KNOWN_ENTERPRISE_TOOLS;
  }
}
