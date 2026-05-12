import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createNativeProcessesProvider } from './nativeStealthModule';
import { KNOWN_ENTERPRISE_TOOLS } from './enterpriseToolRegistry';

export type ThreatCategory = 'monitoring' | 'proctoring' | 'remote-desktop' | 'screen-capture' | 'time-tracking' | 'remote-access';
export type ThreatSeverity = 'critical' | 'warning';

export interface DetectedThreat {
  name: string;
  pid: string;
  category: ThreatCategory;
  severity: ThreatSeverity;
}

export type DetectionLayer = 'process' | 'window-title' | 'filesystem' | 'launch-agent';

export interface MonitoringSignature {
  name: string;
  bundleId: string;
  category: ThreatCategory;
  /** Process name patterns */
  processPatterns: string[];
  /** Window title patterns (optional) */
  windowTitlePatterns?: string[];
  /** Filesystem artifacts to check (optional) */
  filesystemArtifacts?: string[];
  /** Launch agent plist paths (optional, macOS) */
  launchAgentPaths?: string[];
}

export interface DetectedThreatV2 extends DetectedThreat {
  detectionLayer: DetectionLayer;
  confidence: number; // 0.0 - 1.0
}

const CRITICAL_CATEGORIES: Set<ThreatCategory> = new Set(['monitoring', 'proctoring']);

/** Confidence levels per detection layer */
const LAYER_CONFIDENCE: Record<DetectionLayer, number> = {
  'process': 0.9,
  'window-title': 0.7,
  'filesystem': 0.8,
  'launch-agent': 0.85,
};

export interface MonitoringDetectorOptions {
  platform?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  getProcessList?: () => Array<{ pid: number; ppid: number; name: string }>;
  timeoutMs?: number;
}

export interface MonitoringDetectorV2Options extends MonitoringDetectorOptions {
  /** Path to JSON signature database */
  signatureDatabasePath?: string;
  /** Injected signatures (for testing) */
  signatures?: MonitoringSignature[];
  /** Window title provider (for testing) */
  getWindowTitles?: () => string[];
  /** Filesystem existence checker (for testing) */
  fileExists?: (filePath: string) => boolean;
}

export class MonitoringDetector {
  private readonly platform: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly getProcessList: () => Array<{ pid: number; ppid: number; name: string }>;
  private readonly timeoutMs: number;
  private readonly signatures: MonitoringSignature[];
  private readonly getWindowTitles: () => string[];
  private readonly fileExists: (filePath: string) => boolean;
  private running = false;

  constructor(options: MonitoringDetectorV2Options = {}) {
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? console;
    this.getProcessList = options.getProcessList ?? createNativeProcessesProvider({
      logger: this.logger,
      label: 'MonitoringDetector',
    });
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.signatures = this.loadSignatures(options);
    this.getWindowTitles = options.getWindowTitles ?? (() => []);
    this.fileExists = options.fileExists ?? ((filePath: string) => {
      try {
        return fs.existsSync(filePath);
      } catch {
        return false;
      }
    });
  }

  private loadSignatures(options: MonitoringDetectorV2Options): MonitoringSignature[] {
    // 1. Use injected signatures if provided (for testing)
    if (options.signatures && options.signatures.length > 0) {
      return options.signatures;
    }

    // 2. Try loading from signatureDatabasePath
    if (options.signatureDatabasePath) {
      try {
        const content = fs.readFileSync(options.signatureDatabasePath, 'utf-8');
        const db = JSON.parse(content);
        if (db && Array.isArray(db.tools) && db.tools.length > 0) {
          return db.tools as MonitoringSignature[];
        }
      } catch (error) {
        this.logger.warn('[MonitoringDetector] Failed to load signature database from path, falling back to hardcoded:', error);
      }
    }

    // 3. Try loading from default signatures.json location
    try {
      const defaultPath = path.join(__dirname, 'signatures.json');
      const content = fs.readFileSync(defaultPath, 'utf-8');
      const db = JSON.parse(content);
      if (db && Array.isArray(db.tools) && db.tools.length > 0) {
        return db.tools as MonitoringSignature[];
      }
    } catch {
      // Fall through to hardcoded fallback
    }

    // 4. Fallback to hardcoded KNOWN_ENTERPRISE_TOOLS
    return KNOWN_ENTERPRISE_TOOLS.map(tool => ({
      name: tool.name,
      bundleId: tool.bundleId,
      category: tool.category as ThreatCategory,
      processPatterns: [tool.name.toLowerCase(), tool.bundleId],
    }));
  }

  async detect(): Promise<DetectedThreatV2[]> {
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

  private async detectThreats(): Promise<DetectedThreatV2[]> {
    const allDetections: DetectedThreatV2[] = [];

    // Layer 1: Process name matching
    const processDetections = this.detectByProcess();
    allDetections.push(...processDetections);

    // Layer 2: Window title matching
    const windowDetections = this.detectByWindowTitle();
    allDetections.push(...windowDetections);

    // Layer 3: Filesystem artifact scanning
    const filesystemDetections = this.detectByFilesystem();
    allDetections.push(...filesystemDetections);

    // Layer 4: Launch agent inspection (macOS only)
    if (this.platform === 'darwin') {
      const launchAgentDetections = this.detectByLaunchAgent();
      allDetections.push(...launchAgentDetections);
    }

    // Deduplicate: same tool from multiple layers appears once with highest confidence
    return this.deduplicateThreats(allDetections);
  }

  private detectByProcess(): DetectedThreatV2[] {
    const threats: DetectedThreatV2[] = [];
    const procs = this.getProcessList();

    for (const sig of this.signatures) {
      try {
        const patterns = sig.processPatterns;
        if (!patterns || patterns.length === 0) continue;

        const match = procs.find(p => {
          const nameLower = p.name.toLowerCase();
          return patterns.some(pattern => nameLower.includes(pattern.toLowerCase()));
        });

        if (match) {
          const severity = CRITICAL_CATEGORIES.has(sig.category) ? 'critical' : 'warning';
          threats.push({
            name: sig.name,
            pid: String(match.pid),
            category: sig.category,
            severity,
            detectionLayer: 'process',
            confidence: LAYER_CONFIDENCE['process'],
          });
        }
      } catch {
        // Process not found - continue to next
      }
    }

    return threats;
  }

  private detectByWindowTitle(): DetectedThreatV2[] {
    const threats: DetectedThreatV2[] = [];

    let titles: string[];
    try {
      titles = this.getWindowTitles();
    } catch {
      this.logger.warn('[MonitoringDetector] Window title enumeration failed');
      return threats;
    }

    if (titles.length === 0) return threats;

    for (const sig of this.signatures) {
      const patterns = sig.windowTitlePatterns;
      if (!patterns || patterns.length === 0) continue;

      const matched = titles.some(title => {
        const titleLower = title.toLowerCase();
        return patterns.some(pattern => titleLower.includes(pattern.toLowerCase()));
      });

      if (matched) {
        const severity = CRITICAL_CATEGORIES.has(sig.category) ? 'critical' : 'warning';
        threats.push({
          name: sig.name,
          pid: '0', // No PID available from window title detection
          category: sig.category,
          severity,
          detectionLayer: 'window-title',
          confidence: LAYER_CONFIDENCE['window-title'],
        });
      }
    }

    return threats;
  }

  private detectByFilesystem(): DetectedThreatV2[] {
    const threats: DetectedThreatV2[] = [];

    for (const sig of this.signatures) {
      const artifacts = sig.filesystemArtifacts;
      if (!artifacts || artifacts.length === 0) continue;

      const found = artifacts.some(artifactPath => {
        const resolvedPath = this.resolveHomePath(artifactPath);
        try {
          return this.fileExists(resolvedPath);
        } catch {
          return false;
        }
      });

      if (found) {
        const severity = CRITICAL_CATEGORIES.has(sig.category) ? 'critical' : 'warning';
        threats.push({
          name: sig.name,
          pid: '0', // No PID available from filesystem detection
          category: sig.category,
          severity,
          detectionLayer: 'filesystem',
          confidence: LAYER_CONFIDENCE['filesystem'],
        });
      }
    }

    return threats;
  }

  private detectByLaunchAgent(): DetectedThreatV2[] {
    const threats: DetectedThreatV2[] = [];

    for (const sig of this.signatures) {
      const agentPaths = sig.launchAgentPaths;
      if (!agentPaths || agentPaths.length === 0) continue;

      const found = agentPaths.some(agentPath => {
        const resolvedPath = this.resolveHomePath(agentPath);
        try {
          return this.fileExists(resolvedPath);
        } catch {
          return false;
        }
      });

      if (found) {
        const severity = CRITICAL_CATEGORIES.has(sig.category) ? 'critical' : 'warning';
        threats.push({
          name: sig.name,
          pid: '0', // No PID available from launch agent detection
          category: sig.category,
          severity,
          detectionLayer: 'launch-agent',
          confidence: LAYER_CONFIDENCE['launch-agent'],
        });
      }
    }

    return threats;
  }

  private resolveHomePath(filePath: string): string {
    if (filePath.startsWith('~/')) {
      return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
  }

  private deduplicateThreats(threats: DetectedThreatV2[]): DetectedThreatV2[] {
    const bestByTool = new Map<string, DetectedThreatV2>();

    for (const threat of threats) {
      const existing = bestByTool.get(threat.name);
      if (!existing || threat.confidence > existing.confidence) {
        bestByTool.set(threat.name, threat);
      }
    }

    return Array.from(bestByTool.values());
  }

  isToolCritical(name: string): boolean {
    const tool = this.signatures.find(t => t.name === name)
      ?? KNOWN_ENTERPRISE_TOOLS.find(t => t.name === name);
    if (!tool) return false;
    return CRITICAL_CATEGORIES.has(tool.category as ThreatCategory);
  }

  getToolCategory(name: string): ThreatCategory | null {
    const tool = this.signatures.find(t => t.name === name)
      ?? KNOWN_ENTERPRISE_TOOLS.find(t => t.name === name);
    return (tool?.category as ThreatCategory) ?? null;
  }

  /** Get loaded signatures (for testing) */
  getSignatures(): MonitoringSignature[] {
    return this.signatures;
  }

  static getKnownTools() {
    return KNOWN_ENTERPRISE_TOOLS;
  }
}
