import type { SupervisorBus } from './SupervisorBus';
import type { ISupervisor, SupervisorState } from './types';

export interface AudioSupervisorDelegates {
  startCapture: () => Promise<void> | void;
  stopCapture: () => Promise<void> | void;
  onChunk?: (chunk: Buffer) => Promise<void> | void;
  onSpeechEnded?: () => Promise<void> | void;
  onError?: (error: Error) => Promise<void> | void;
}

interface AudioSupervisorOptions {
  bus: SupervisorBus;
  delegates: AudioSupervisorDelegates;
  logger?: Pick<Console, 'warn'>;
}

export class AudioSupervisor implements ISupervisor {
  public readonly name = 'audio' as const;

  private state: SupervisorState = 'idle';
  private readonly bus: SupervisorBus;
  private readonly delegates: AudioSupervisorDelegates;
  private readonly logger: Pick<Console, 'warn'>;

  constructor(options: AudioSupervisorOptions) {
    this.bus = options.bus;
    this.delegates = options.delegates;
    this.logger = options.logger ?? console;
  }

  getState(): SupervisorState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      return;
    }

    this.state = 'starting';
    try {
      await this.delegates.startCapture();
      this.state = 'running';
      await this.bus.emit({ type: 'audio:capture-started' });
    } catch (error) {
      this.state = 'faulted';
      await this.reportError(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'idle') {
      return;
    }

    this.state = 'stopping';
    try {
      await this.delegates.stopCapture();
    } finally {
      this.state = 'idle';
      await this.bus.emit({ type: 'audio:capture-stopped' });
    }
  }

  async handleChunk(chunk: Buffer): Promise<void> {
    if (this.state !== 'running') {
      return;
    }

    await this.delegates.onChunk?.(chunk);
  }

  async handleSpeechEnded(): Promise<void> {
    if (this.state !== 'running') {
      return;
    }

    await this.delegates.onSpeechEnded?.();
  }

  async reportGap(durationMs: number): Promise<void> {
    if (durationMs <= 0) {
      return;
    }

    await this.bus.emit({ type: 'audio:gap-detected', durationMs });
  }

  async reportError(error: unknown): Promise<void> {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.logger.warn('[AudioSupervisor] capture error:', normalizedError);
    await this.delegates.onError?.(normalizedError);
  }
}

