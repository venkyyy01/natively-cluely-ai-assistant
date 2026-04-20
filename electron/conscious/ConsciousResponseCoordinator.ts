import type { AnswerLatencyTracker, AnswerRoute } from '../latency/AnswerLatencyTracker';
import type { SuggestedAnswerMetadata } from '../IntelligenceEngine';
import {
  formatConsciousModeResponseChunks,
  type ConsciousModeStructuredResponse,
} from '../ConsciousMode';
import type { ResponseFingerprinter } from './ResponseFingerprint';

type IntelligenceModeSetter = (mode: 'idle' | 'reasoning_first') => void;
type EventEmitterLike = {
  emit(event: 'suggested_answer_token', answer: string, question: string, confidence: number): boolean;
  emit(event: 'suggested_answer', answer: string, question: string, confidence: number, metadata?: SuggestedAnswerMetadata): boolean;
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
  // NAT-048 / open question from sub-agent B: a session-scoped fingerprinter
  // is injected by IntelligenceEngine. When absent (older callers and the
  // existing unit test), the coordinator behaves exactly as before.
  constructor(
    private readonly session: ConsciousSessionLike,
    private readonly latencyTracker: AnswerLatencyTracker,
    private readonly emitter: EventEmitterLike,
    private readonly setMode: IntelligenceModeSetter,
    private readonly fingerprinter?: ResponseFingerprinter,
  ) {}

  completeStructuredAnswer(input: {
    requestId: string;
    questionLabel: string;
    confidence: number;
    fullAnswer: string;
    structuredResponse?: ConsciousModeStructuredResponse;
    metadata?: SuggestedAnswerMetadata;
  }): string {
    // NAT-048: enforce response dedupe at the emit boundary. We check
    // BEFORE switching modes / firing tokens so a suppressed duplicate
    // never leaks a partial UI state. The first answer of a turn won't
    // match anything (recent history is empty), so this only fires when
    // a near-identical answer has been emitted recently in the session.
    if (this.fingerprinter) {
      const dupeCheck = this.fingerprinter.isDuplicate(input.fullAnswer);
      if (dupeCheck.isDupe) {
        // The user already has the prior answer on screen. Re-emitting an
        // identical paragraph is the worst kind of "AI slop" — it makes the
        // assistant look broken and burns the user's attention. Suppress
        // the entire emission cycle: no tokens, no final, no session
        // append, no usage push, no latency completion. The latency
        // tracker stays "in flight" deliberately so its snapshot reflects
        // the suppression rather than recording a phantom completion.
        this.latencyTracker.mark(input.requestId, 'response.duplicate_suppressed');
        console.log(
          '[ConsciousResponseCoordinator] Suppressing duplicate answer; matched prior preview:',
          dupeCheck.matchedPreview,
        );
        // Drop back to idle so the engine doesn't think it's still in a
        // streaming state. Returning the input answer keeps the call-site
        // contract identical (callers use it for logging/telemetry only).
        this.setMode('idle');
        return input.fullAnswer;
      }
    }

    this.setMode('reasoning_first');
    const chunks = input.structuredResponse
      ? formatConsciousModeResponseChunks(input.structuredResponse)
      : [input.fullAnswer];
    chunks.forEach((chunk, index) => {
      this.emitter.emit(
        'suggested_answer_token',
        index === 0 ? chunk : `\n${chunk}`,
        input.questionLabel,
        input.confidence,
      );
      if (index === 0) {
        this.latencyTracker.markFirstVisibleAnswer(input.requestId);
      }
    });
    this.session.addAssistantMessage(input.fullAnswer);
    this.session.pushUsage({
      type: 'assist',
      timestamp: Date.now(),
      question: input.questionLabel,
      answer: input.fullAnswer,
    });
    this.emitter.emit('suggested_answer', input.fullAnswer, input.questionLabel, input.confidence, input.metadata);
    // NAT-048: record the emitted answer AFTER the emit so a downstream
    // exception during emission doesn't leave the fingerprint mistakenly
    // remembered (which would suppress a legitimate retry).
    this.fingerprinter?.record(input.fullAnswer);
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
