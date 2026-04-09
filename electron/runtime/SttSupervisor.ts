import type { SupervisorBus } from './SupervisorBus';
import type { ISupervisor, SupervisorState } from './types';

export type SttSpeaker = 'interviewer' | 'user';

export interface SttSupervisorDelegates {
  startSpeaker: (speaker: SttSpeaker) => Promise<void> | void;
  stopSpeaker: (speaker: SttSpeaker) => Promise<void> | void;
  setRecognitionLanguage?: (language: string) => Promise<void> | void;
  reconnectSpeaker?: (speaker: SttSpeaker) => Promise<void> | void;
  onError?: (speaker: SttSpeaker, error: Error) => Promise<void> | void;
}

interface SttSupervisorOptions {
  bus: SupervisorBus;
  delegates: SttSupervisorDelegates;
  logger?: Pick<Console, 'warn'>;
}

export class SttSupervisor implements ISupervisor {
  public readonly name = 'stt' as const;

  private state: SupervisorState = 'idle';
  private readonly bus: SupervisorBus;
  private readonly delegates: SttSupervisorDelegates;
  private readonly logger: Pick<Console, 'warn'>;

  constructor(options: SttSupervisorOptions) {
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
      await this.delegates.startSpeaker('interviewer');
      await this.delegates.startSpeaker('user');
      this.state = 'running';
    } catch (error) {
      this.state = 'faulted';
      await this.reportError('interviewer', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'idle') {
      return;
    }

    this.state = 'stopping';
    try {
      await this.delegates.stopSpeaker('interviewer');
      await this.delegates.stopSpeaker('user');
    } finally {
      this.state = 'idle';
    }
  }

  async handleTranscript(speaker: SttSpeaker, text: string, final: boolean): Promise<void> {
    await this.bus.emit({
      type: 'stt:transcript',
      speaker,
      text,
      final,
    });
  }

  async reportProviderExhausted(speaker: SttSpeaker): Promise<void> {
    await this.bus.emit({ type: 'stt:provider-exhausted', speaker });
  }

  async reconnectSpeaker(speaker: SttSpeaker): Promise<void> {
    try {
      await this.delegates.reconnectSpeaker?.(speaker);
    } catch (error) {
      await this.reportError(speaker, error);
      throw error;
    }
  }

  async reportError(speaker: SttSpeaker, error: unknown): Promise<void> {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.logger.warn(`[SttSupervisor] ${speaker} error:`, normalizedError);
    await this.delegates.onError?.(speaker, normalizedError);
  }

  async setRecognitionLanguage(language: string): Promise<void> {
    await this.delegates.setRecognitionLanguage?.(language);
  }
}
