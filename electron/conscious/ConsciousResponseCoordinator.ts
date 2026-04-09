import type { AnswerLatencyTracker, AnswerRoute } from '../latency/AnswerLatencyTracker';

type IntelligenceModeSetter = (mode: 'idle' | 'reasoning_first') => void;
type EventEmitterLike = {
  emit(event: 'suggested_answer_token', answer: string, question: string, confidence: number): boolean;
  emit(event: 'suggested_answer', answer: string, question: string, confidence: number): boolean;
};

interface ConsciousSessionLike {
  addAssistantMessage(answer: string): void;
  pushUsage(entry: {
    type: 'assist';
    timestamp: number;
    question: string;
    answer: string;
  }): void;
}

export class ConsciousResponseCoordinator {
  constructor(
    private readonly session: ConsciousSessionLike,
    private readonly latencyTracker: AnswerLatencyTracker,
    private readonly emitter: EventEmitterLike,
    private readonly setMode: IntelligenceModeSetter,
  ) {}

  completeStructuredAnswer(input: {
    requestId: string;
    questionLabel: string;
    confidence: number;
    fullAnswer: string;
  }): string {
    this.setMode('reasoning_first');
    this.emitter.emit('suggested_answer_token', input.fullAnswer, input.questionLabel, input.confidence);
    this.latencyTracker.markFirstVisibleAnswer(input.requestId);
    this.session.addAssistantMessage(input.fullAnswer);
    this.session.pushUsage({
      type: 'assist',
      timestamp: Date.now(),
      question: input.questionLabel,
      answer: input.fullAnswer,
    });
    this.emitter.emit('suggested_answer', input.fullAnswer, input.questionLabel, input.confidence);
    const latencySnapshot = this.latencyTracker.complete(input.requestId);
    console.log('[IntelligenceEngine] Answer latency snapshot:', latencySnapshot);
    this.setMode('idle');
    return input.fullAnswer;
  }

  markFallbackToRoute(input: {
    requestId: string;
    route: AnswerRoute;
    profileEnrichmentState?: 'attempted' | 'completed' | 'failed' | 'timed_out';
    profileFallbackReason?: 'profile_timeout' | 'profile_error' | 'profile_no_context';
  }): AnswerRoute {
    this.latencyTracker.markFallbackOccurred(input.requestId);
    this.latencyTracker.markDegradedToRoute(input.requestId, input.route, {
      profileEnrichmentState: input.profileEnrichmentState,
      profileFallbackReason: input.profileFallbackReason,
    });
    return input.route;
  }
}
