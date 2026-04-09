import { SupervisorBus } from './SupervisorBus';
import type { ISupervisor, SupervisorState } from './types';

export interface InferenceSupervisorDelegate {
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
  onDraftReady?: (requestId: string) => Promise<void> | void;
  onAnswerCommitted?: (requestId: string) => Promise<void> | void;
  getLLMHelper?: () => unknown;
}

interface InferenceSupervisorOptions {
  delegate: InferenceSupervisorDelegate;
  bus?: SupervisorBus;
}

export class InferenceSupervisor implements ISupervisor {
  readonly name = 'inference' as const;
  private state: SupervisorState = 'idle';
  private readonly delegate: InferenceSupervisorDelegate;
  private readonly bus: SupervisorBus;

  constructor(options: InferenceSupervisorOptions) {
    this.delegate = options.delegate;
    this.bus = options.bus ?? new SupervisorBus();
  }

  getState(): SupervisorState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start inference supervisor while ${this.state}`);
    }

    this.state = 'starting';
    try {
      await this.delegate.start?.();
      this.state = 'running';
    } catch (error) {
      this.state = 'faulted';
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'idle') {
      return;
    }

    this.state = 'stopping';
    try {
      await this.delegate.stop?.();
    } finally {
      this.state = 'idle';
    }
  }

  async publishDraftReady(requestId: string): Promise<void> {
    await this.delegate.onDraftReady?.(requestId);
    await this.bus.emit({ type: 'inference:draft-ready', requestId });
  }

  async commitAnswer(requestId: string): Promise<void> {
    await this.delegate.onAnswerCommitted?.(requestId);
    await this.bus.emit({ type: 'inference:answer-committed', requestId });
  }

  getLLMHelper<T = unknown>(): T {
    if (!this.delegate.getLLMHelper) {
      throw new Error('Inference supervisor delegate does not expose an LLM helper');
    }

    return this.delegate.getLLMHelper() as T;
  }
}
