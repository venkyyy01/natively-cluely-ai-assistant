import screenShareSignatures from './signatures/screen-share-apps.json';
import {
  defaultExecCommand,
  findCaseInsensitiveMatches,
  getWindowEnumerationCommand,
  type ExecCommand,
} from './detectorUtils';

interface ScreenShareSignature {
  name: string;
  processNames: string[];
  windowTitles: string[];
  processDetection?: 'process-or-window' | 'window-only';
}

export interface ScreenShareStatus {
  active: boolean;
  confidence: 'high' | 'medium' | 'low';
  source: 'native' | 'tcc' | 'process' | 'window' | 'heuristic';
  timestamp: number;
  matches: string[];
}

interface ScreenShareDetectorOptions {
  platform?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  signatures?: ScreenShareSignature[];
  execCommand?: ExecCommand;
  nativeDetect?: () => Promise<boolean | null | undefined> | boolean | null | undefined;
  tccProbe?: () => Promise<boolean | null | undefined> | boolean | null | undefined;
  now?: () => number;
}

export class ScreenShareDetector {
  private readonly platform: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly signatures: ScreenShareSignature[];
  private readonly execCommand: ExecCommand;
  private readonly nativeDetect?: () => Promise<boolean | null | undefined> | boolean | null | undefined;
  private readonly tccProbe?: () => Promise<boolean | null | undefined> | boolean | null | undefined;
  private readonly now: () => number;

  constructor(options: ScreenShareDetectorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? console;
    this.signatures = options.signatures ?? (screenShareSignatures as ScreenShareSignature[]);
    this.execCommand = options.execCommand ?? defaultExecCommand;
    this.nativeDetect = options.nativeDetect;
    this.tccProbe = options.tccProbe;
    this.now = options.now ?? (() => Date.now());
  }

  async detect(): Promise<ScreenShareStatus> {
    try {
      const nativeActive = await this.resolveOptionalProbe(this.nativeDetect);
      if (nativeActive) {
        return this.activeStatus('native', 'high', ['native-guard']);
      }
    } catch (error) {
      this.logger.warn('[ScreenShareDetector] Native detection failed:', error);
    }

    if (this.platform === 'darwin') {
      try {
        const tccActive = await this.resolveOptionalProbe(this.tccProbe);
        if (tccActive) {
          return this.activeStatus('tcc', 'medium', ['tcc-screen-capture-grant']);
        }
      } catch (error) {
        this.logger.warn('[ScreenShareDetector] TCC probe failed:', error);
      }
    }

    try {
      const processMatches = await this.detectByProcess();
      if (processMatches.length > 0) {
        return this.activeStatus('process', 'high', processMatches);
      }
    } catch (error) {
      this.logger.warn('[ScreenShareDetector] Process detection failed:', error);
    }

    try {
      const windowMatches = await this.detectByWindow();
      if (windowMatches.length > 0) {
        return this.activeStatus('window', 'medium', windowMatches);
      }
    } catch (error) {
      this.logger.warn('[ScreenShareDetector] Window detection failed:', error);
    }

    return {
      active: false,
      confidence: 'low',
      source: 'heuristic',
      timestamp: this.now(),
      matches: [],
    };
  }

  async detectByProcess(): Promise<string[]> {
    const stdout = await this.readProcessList();
    if (!stdout.trim()) {
      return [];
    }

    return this.signatures.flatMap((signature) => {
      if (signature.processDetection === 'window-only') {
        return [];
      }

      const matches = findCaseInsensitiveMatches(stdout, signature.processNames);
      if (matches.length === 0) {
        return [];
      }

      return matches.map((match) => `${signature.name}:${match}`);
    });
  }

  async detectByWindow(): Promise<string[]> {
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

      return matches.map((match) => `${signature.name}:${match}`);
    });
  }

  private activeStatus(
    source: ScreenShareStatus['source'],
    confidence: ScreenShareStatus['confidence'],
    matches: string[],
  ): ScreenShareStatus {
    return {
      active: true,
      confidence,
      source,
      timestamp: this.now(),
      matches,
    };
  }

  private async resolveOptionalProbe(
    probe?: () => Promise<boolean | null | undefined> | boolean | null | undefined,
  ): Promise<boolean> {
    if (!probe) {
      return false;
    }

    return Boolean(await probe());
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
}
