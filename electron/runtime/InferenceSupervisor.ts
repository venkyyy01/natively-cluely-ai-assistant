import { SupervisorBus } from './SupervisorBus';
import type { ISupervisor, SupervisorState } from './types';

export interface InferenceSupervisorDelegate {
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
  onStealthFault?: (reason: string) => Promise<void> | void;
  onDraftReady?: (requestId: string) => Promise<void> | void;
  onAnswerCommitted?: (requestId: string) => Promise<void> | void;
  getLLMHelper?: () => unknown;
  runAssistMode?: () => Promise<string | null> | string | null;
  runWhatShouldISay?: (question?: string, confidence?: number, imagePaths?: string[]) => Promise<string | null> | string | null;
  runFollowUp?: (intent: string, userRequest?: string) => Promise<string | null> | string | null;
  runRecap?: () => Promise<string | null> | string | null;
  runFollowUpQuestions?: () => Promise<string[] | string | null> | string[] | string | null;
  runManualAnswer?: (question: string) => Promise<string | null> | string | null;
  getFormattedContext?: (lastSeconds?: number) => string;
  getLastAssistantMessage?: () => string | null;
  getActiveMode?: () => unknown;
  reset?: () => Promise<void> | void;
  getRAGManager?: () => unknown;
  getKnowledgeOrchestrator?: () => unknown;
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
    this.bus.subscribe('stealth:fault', async (event) => {
      await this.handleStealthFault(event.reason);
    });
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

  private async handleStealthFault(reason: string): Promise<void> {
    if (this.state !== 'running') {
      return;
    }

    await this.delegate.onStealthFault?.(reason);
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

  async runAssistMode(): Promise<string | null> {
    if (!this.delegate.runAssistMode) {
      throw new Error('Inference supervisor delegate does not expose assist mode');
    }

    return await this.delegate.runAssistMode();
  }

  async runWhatShouldISay(question?: string, confidence?: number, imagePaths?: string[]): Promise<string | null> {
    if (!this.delegate.runWhatShouldISay) {
      throw new Error('Inference supervisor delegate does not expose what-to-say mode');
    }

    return await this.delegate.runWhatShouldISay(question, confidence, imagePaths);
  }

  async runFollowUp(intent: string, userRequest?: string): Promise<string | null> {
    if (!this.delegate.runFollowUp) {
      throw new Error('Inference supervisor delegate does not expose follow-up mode');
    }

    return await this.delegate.runFollowUp(intent, userRequest);
  }

  async runRecap(): Promise<string | null> {
    if (!this.delegate.runRecap) {
      throw new Error('Inference supervisor delegate does not expose recap mode');
    }

    return await this.delegate.runRecap();
  }

  async runFollowUpQuestions(): Promise<string[] | string | null> {
    if (!this.delegate.runFollowUpQuestions) {
      throw new Error('Inference supervisor delegate does not expose follow-up questions mode');
    }

    return await this.delegate.runFollowUpQuestions();
  }

  async runManualAnswer(question: string): Promise<string | null> {
    if (!this.delegate.runManualAnswer) {
      throw new Error('Inference supervisor delegate does not expose manual answer mode');
    }

    return await this.delegate.runManualAnswer(question);
  }

  getFormattedContext(lastSeconds?: number): string {
    if (!this.delegate.getFormattedContext) {
      throw new Error('Inference supervisor delegate does not expose formatted context');
    }

    return this.delegate.getFormattedContext(lastSeconds);
  }

  getLastAssistantMessage(): string | null {
    if (!this.delegate.getLastAssistantMessage) {
      throw new Error('Inference supervisor delegate does not expose the last assistant message');
    }

    return this.delegate.getLastAssistantMessage();
  }

  getActiveMode<T = unknown>(): T {
    if (!this.delegate.getActiveMode) {
      throw new Error('Inference supervisor delegate does not expose the active mode');
    }

    return this.delegate.getActiveMode() as T;
  }

  async reset(): Promise<void> {
    if (!this.delegate.reset) {
      throw new Error('Inference supervisor delegate does not expose reset');
    }

    await this.delegate.reset();
  }

  getRAGManager<T = unknown>(): T {
    if (!this.delegate.getRAGManager) {
      throw new Error('Inference supervisor delegate does not expose a RAG manager');
    }

    return this.delegate.getRAGManager() as T;
  }

  getKnowledgeOrchestrator<T = unknown>(): T {
    if (!this.delegate.getKnowledgeOrchestrator) {
      throw new Error('Inference supervisor delegate does not expose a knowledge orchestrator');
    }

    return this.delegate.getKnowledgeOrchestrator() as T;
  }
}
