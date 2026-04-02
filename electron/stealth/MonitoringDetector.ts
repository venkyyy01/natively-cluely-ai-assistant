import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  defaultExecCommand,
  findCaseInsensitiveMatches,
  getWindowEnumerationCommand,
  type ExecCommand,
} from './detectorUtils';
import defaultSignatures from './signatures/monitoring-software.json';

export interface MonitoringSoftwareSignature {
  name: string;
  category: 'proctoring' | 'enterprise' | 'security' | 'parental';
  processNames: string[];
  windowTitles: string[];
  installPaths: string[];
  fileArtifacts: string[];
  networkEndpoints: string[];
  launchAgents?: string[];
  registryKeys?: string[];
}

export interface ThreatInfo {
  name: string;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  vector: 'process' | 'window' | 'file' | 'launch-agent';
  details: string;
}

export interface DetectionResult {
  detected: boolean;
  threats: ThreatInfo[];
  timestamp: number;
  detectionMethod: string;
}

interface MonitoringDetectorOptions {
  platform?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  signatures?: MonitoringSoftwareSignature[];
  execCommand?: ExecCommand;
  existsSync?: (candidatePath: string) => boolean;
  readdirSync?: (candidatePath: string) => string[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
}

const MACOS_LAUNCH_AGENT_PATHS = [
  '~/Library/LaunchAgents',
  '/Library/LaunchAgents',
  '/Library/LaunchDaemons',
];

function uniqueThreats(threats: ThreatInfo[]): ThreatInfo[] {
  const seen = new Set<string>();
  const unique: ThreatInfo[] = [];

  for (const threat of threats) {
    const key = `${threat.name}:${threat.vector}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(threat);
  }

  return unique;
}

export class MonitoringDetector {
  private readonly platform: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly signatures: MonitoringSoftwareSignature[];
  private readonly execCommand: ExecCommand;
  private readonly pathExists: (candidatePath: string) => boolean;
  private readonly readDirectory: (candidatePath: string) => string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private readonly now: () => number;

  constructor(options: MonitoringDetectorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? console;
    this.signatures = options.signatures ?? (defaultSignatures as MonitoringSoftwareSignature[]);
    this.execCommand = options.execCommand ?? defaultExecCommand;
    this.pathExists = options.existsSync ?? existsSync;
    this.readDirectory = options.readdirSync ?? ((candidatePath) => readdirSync(candidatePath, { encoding: 'utf8' }));
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? os.homedir();
    this.now = options.now ?? (() => Date.now());
  }

  async detectAll(): Promise<DetectionResult> {
    const layerResults = await Promise.all([
      this.runLayer('process', () => this.detectByProcess()),
      this.runLayer('window', () => this.detectByWindow()),
      this.runLayer('file', () => this.detectByFileSystem()),
      this.runLayer('launch-agent', () => this.detectByLaunchAgents()),
    ]);

    const threats = uniqueThreats(layerResults.flatMap((result) => result.threats));
    const detectionMethods = layerResults
      .filter((result) => result.threats.length > 0)
      .map((result) => result.name);

    return {
      detected: threats.length > 0,
      threats,
      timestamp: this.now(),
      detectionMethod: detectionMethods.length > 0 ? detectionMethods.join(',') : 'none',
    };
  }

  async detectByProcess(): Promise<ThreatInfo[]> {
    const stdout = await this.readProcessList();
    if (!stdout.trim()) {
      return [];
    }

    return this.signatures.flatMap((signature) => {
      const matches = findCaseInsensitiveMatches(stdout, signature.processNames);
      if (matches.length === 0) {
        return [];
      }

      return [{
        name: signature.name,
        category: signature.category,
        confidence: 'high',
        vector: 'process',
        details: `Matched process names: ${matches.join(', ')}`,
      }];
    });
  }

  async detectByWindow(): Promise<ThreatInfo[]> {
    const command = getWindowEnumerationCommand(this.platform);
    if (!command) {
      return [];
    }

    const stdout = await this.execCommand(command.command, command.args);
    if (!stdout.trim()) {
      return [];
    }

    return this.signatures.flatMap((signature) => {
      const matches = findCaseInsensitiveMatches(stdout, signature.windowTitles);
      if (matches.length === 0) {
        return [];
      }

      return [{
        name: signature.name,
        category: signature.category,
        confidence: 'high',
        vector: 'window',
        details: `Matched window titles: ${matches.join(', ')}`,
      }];
    });
  }

  async detectByFileSystem(): Promise<ThreatInfo[]> {
    return this.signatures.flatMap((signature) => {
      const candidates = [...signature.installPaths, ...signature.fileArtifacts];
      const matches = candidates
        .map((candidate) => this.expandCandidatePath(candidate))
        .filter((candidatePath) => candidatePath.length > 0 && this.safeExists(candidatePath));

      if (matches.length === 0) {
        return [];
      }

      return [{
        name: signature.name,
        category: signature.category,
        confidence: 'medium',
        vector: 'file',
        details: `Matched filesystem artifacts: ${matches.join(', ')}`,
      }];
    });
  }

  async detectByLaunchAgents(): Promise<ThreatInfo[]> {
    if (this.platform !== 'darwin') {
      return [];
    }

    const discoveredAgents = new Set<string>();
    for (const directory of MACOS_LAUNCH_AGENT_PATHS) {
      const resolvedPath = this.expandCandidatePath(directory);
      try {
        for (const entry of this.readDirectory(resolvedPath)) {
          discoveredAgents.add(entry);
        }
      } catch {
        // Missing directories are expected on many systems.
      }
    }

    if (discoveredAgents.size === 0) {
      return [];
    }

    const haystack = Array.from(discoveredAgents).join('\n');
    return this.signatures.flatMap((signature) => {
      const matches = findCaseInsensitiveMatches(haystack, signature.launchAgents ?? []);
      if (matches.length === 0) {
        return [];
      }

      return [{
        name: signature.name,
        category: signature.category,
        confidence: 'high',
        vector: 'launch-agent',
        details: `Matched launch agents: ${matches.join(', ')}`,
      }];
    });
  }

  private async runLayer(
    name: string,
    fn: () => Promise<ThreatInfo[]>,
  ): Promise<{ name: string; threats: ThreatInfo[] }> {
    try {
      return { name, threats: await fn() };
    } catch (error) {
      this.logger.warn(`[MonitoringDetector] ${name} detection failed:`, error);
      return { name, threats: [] };
    }
  }

  private async readProcessList(): Promise<string> {
    if (this.platform === 'win32') {
      return this.execCommand('tasklist', ['/FO', 'CSV', '/NH']);
    }

    if (this.platform === 'darwin') {
      return this.execCommand('ps', ['-axo', 'pid,comm,args']);
    }

    return this.execCommand('ps', ['-A', '-o', 'pid,comm,args']);
  }

  private expandCandidatePath(candidate: string): string {
    if (!candidate) {
      return '';
    }

    let expanded = candidate;
    expanded = expanded.replace(/^~(?=$|[\\/])/, this.homeDir);
    expanded = expanded.replace(/%([^%]+)%/g, (_match, envName: string) => this.env[envName] ?? '');
    return path.normalize(expanded);
  }

  private safeExists(candidatePath: string): boolean {
    try {
      return this.pathExists(candidatePath);
    } catch {
      return false;
    }
  }
}
