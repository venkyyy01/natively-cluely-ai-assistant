import type { ConsciousModeStructuredResponse, ReasoningThread } from '../ConsciousMode';
import type { AnswerHypothesis } from './AnswerHypothesisStore';
import type { QuestionReaction } from './QuestionReactionClassifier';

interface ConsciousRetrievalSession {
  getFormattedContext(lastSeconds: number): string;
  getConsciousEvidenceContext(): string;
  getConsciousLongMemoryContext(question: string): string;
  getActiveReasoningThread(): ReasoningThread | null;
  getLatestConsciousResponse(): ConsciousModeStructuredResponse | null;
  getLatestQuestionReaction(): QuestionReaction | null;
  getLatestAnswerHypothesis(): AnswerHypothesis | null;
}

export interface ConsciousRetrievalPack {
  stateBlock: string;
  combinedContext: string;
}

export class ConsciousRetrievalOrchestrator {
  constructor(private readonly session: ConsciousRetrievalSession) {}

  buildStateBlock(question: string): string {
    const thread = this.session.getActiveReasoningThread();
    const response = this.session.getLatestConsciousResponse();
    const reaction = this.session.getLatestQuestionReaction();
    const hypothesis = this.session.getLatestAnswerHypothesis();

    const lines = [
      '<conscious_state>',
      `CURRENT_INTERVIEWER_QUESTION: ${question || 'n/a'}`,
    ];

    if (thread) {
      lines.push(`ACTIVE_THREAD_ROOT: ${thread.rootQuestion}`);
      lines.push(`ACTIVE_THREAD_LAST_QUESTION: ${thread.lastQuestion}`);
      lines.push(`ACTIVE_THREAD_FOLLOW_UP_COUNT: ${thread.followUpCount}`);
    }

    if (reaction) {
      lines.push(`LATEST_INTERVIEWER_REACTION: ${reaction.kind}`);
      lines.push(`REACTION_CONFIDENCE: ${reaction.confidence.toFixed(2)}`);
      if (reaction.targetFacets.length > 0) {
        lines.push(`REACTION_TARGETS: ${reaction.targetFacets.join(', ')}`);
      }
    }

    if (hypothesis) {
      lines.push(`LIKELY_USER_ANSWER_CONFIDENCE: ${hypothesis.confidence.toFixed(2)}`);
      lines.push(`LIKELY_USER_THEMES: ${hypothesis.likelyThemes.join(' | ') || 'n/a'}`);
      lines.push(`LIKELY_USER_ANSWER_SUMMARY: ${hypothesis.latestSuggestedAnswer || 'n/a'}`);
    }

    if (response) {
      if (response.tradeoffs.length > 0) {
        lines.push(`KNOWN_TRADEOFFS: ${response.tradeoffs.join(' | ')}`);
      }
      if (response.scaleConsiderations.length > 0) {
        lines.push(`KNOWN_SCALE_CONSIDERATIONS: ${response.scaleConsiderations.join(' | ')}`);
      }
      if (response.pushbackResponses.length > 0) {
        lines.push(`KNOWN_PUSHBACKS: ${response.pushbackResponses.join(' | ')}`);
      }
    }

    lines.push('</conscious_state>');
    return lines.join('\n');
  }

  buildPack(input: { question: string; lastSeconds?: number }): ConsciousRetrievalPack {
    const stateBlock = this.buildStateBlock(input.question);
    const longMemoryBlock = this.session.getConsciousLongMemoryContext(input.question);
    const formattedContext = this.session.getFormattedContext(input.lastSeconds ?? 180);
    const evidenceBlock = this.session.getConsciousEvidenceContext();
    return {
      stateBlock,
      combinedContext: [stateBlock, longMemoryBlock, evidenceBlock, formattedContext].filter(Boolean).join('\n\n'),
    };
  }
}
