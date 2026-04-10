import type { SupervisorBus } from './SupervisorBus';
import type { ISupervisor, SupervisorState } from './types';
import type { ProviderHealthSnapshot } from '../STTReconnector';
import type { WarmStandbyManager } from './WarmStandbyManager';

export type SttSpeaker = 'interviewer' | 'user';

export interface SttSupervisorDelegates {
  startSpeaker: (speaker: SttSpeaker) => Promise<void> | void;
  startSpeakerFromWarmStandby?: (speaker: SttSpeaker, resource: unknown) => Promise<void> | void;
  stopSpeaker: (speaker: SttSpeaker) => Promise<void> | void;
  onStealthFault?: (reason: string) => Promise<void> | void;
  setRecognitionLanguage?: (language: string) => Promise<void> | void;
  reconnectSpeaker?: (speaker: SttSpeaker) => Promise<void> | void;
  reconfigureProvider?: () => Promise<void> | void;
  updateGoogleCredentials?: (keyPath: string) => Promise<void> | void;
  finalizeMicrophone?: () => Promise<void> | void;
  onError?: (speaker: SttSpeaker, error: Error) => Promise<void> | void;
  getProviderHealth?: (speaker: SttSpeaker) => ProviderHealthSnapshot;
  resetProviderHealth?: (speaker: SttSpeaker) => void;
}

interface SttSupervisorOptions {
  bus: SupervisorBus;
  delegates: SttSupervisorDelegates;
  logger?: Pick<Console, 'warn'>;
  warmStandby?: Pick<
    WarmStandbyManager<unknown, unknown, unknown>,
    'getSttResource' | 'isSttResourceHealthy' | 'invalidateSttResource'
  >;
}

export class SttSupervisor implements ISupervisor {
  public readonly name = 'stt' as const;

  private state: SupervisorState = 'idle';
  private readonly bus: SupervisorBus;
  private readonly delegates: SttSupervisorDelegates;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly warmStandby?: Pick<
    WarmStandbyManager<unknown, unknown, unknown>,
    'getSttResource' | 'isSttResourceHealthy' | 'invalidateSttResource'
  >;

  constructor(options: SttSupervisorOptions) {
    this.bus = options.bus;
    this.delegates = options.delegates;
    this.logger = options.logger ?? console;
    this.warmStandby = options.warmStandby;
    this.bus.subscribe('stealth:fault', async (event) => {
      await this.handleStealthFault(event.reason);
    });
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
      await this.startSpeakerWithWarmStandbyFallback('interviewer');
      await this.startSpeakerWithWarmStandbyFallback('user');
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
      const health = this.getProviderHealth(speaker);
      if (health.state === 'down' && health.cooldownRemainingMs > 0) {
        await this.reportProviderExhausted(speaker);
        return;
      }

      await this.delegates.reconnectSpeaker?.(speaker);
      this.delegates.resetProviderHealth?.(speaker);
    } catch (error) {
      const health = this.getProviderHealth(speaker);
      if (health.state === 'down' && health.cooldownRemainingMs > 0) {
        await this.reportProviderExhausted(speaker);
      }
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

  async reconfigureProvider(): Promise<void> {
    await this.delegates.reconfigureProvider?.();
  }

  async updateGoogleCredentials(keyPath: string): Promise<void> {
    await this.delegates.updateGoogleCredentials?.(keyPath);
  }

  async finalizeMicrophone(): Promise<void> {
    await this.delegates.finalizeMicrophone?.();
  }

  getProviderHealth(speaker: SttSpeaker): ProviderHealthSnapshot {
    return this.delegates.getProviderHealth?.(speaker) ?? {
      state: 'healthy',
      retryCount: 0,
      recentErrorCount: 0,
      cooldownRemainingMs: 0,
    };
  }

  private async startSpeakerWithWarmStandbyFallback(speaker: SttSpeaker): Promise<void> {
    const warmResource = this.warmStandby?.getSttResource();
    const canUseWarmStandby = warmResource !== null && warmResource !== undefined && this.delegates.startSpeakerFromWarmStandby;
    if (!canUseWarmStandby) {
      await this.delegates.startSpeaker(speaker);
      return;
    }

    const healthy = await this.warmStandby?.isSttResourceHealthy();
    if (!healthy) {
      await this.warmStandby?.invalidateSttResource();
      await this.delegates.startSpeaker(speaker);
      return;
    }

    try {
      await this.delegates.startSpeakerFromWarmStandby?.(speaker, warmResource);
    } catch (error) {
      await this.warmStandby?.invalidateSttResource();
      this.logger.warn(`[SttSupervisor] Warm STT activation failed for ${speaker}, falling back to cold start:`, error);
      await this.delegates.startSpeaker(speaker);
    }
  }

  private async handleStealthFault(reason: string): Promise<void> {
    if (this.state !== 'running') {
      return;
    }

    await this.delegates.onStealthFault?.(reason);
  }
}
