import type { ConsciousModeStructuredResponse } from '../ConsciousMode';
import type { QuestionReaction } from './QuestionReactionClassifier';

export interface AnswerHypothesis {
  sourceQuestion: string;
  latestSuggestedAnswer: string;
  likelyThemes: string[];
  confidence: number;
  evidence: Array<'suggested' | 'inferred'>;
  reactionKind?: QuestionReaction['kind'];
  targetFacets: string[];
  updatedAt: number;
}

export interface PersistedAnswerHypothesisState {
  latestHypothesis: AnswerHypothesis | null;
  latestReaction: QuestionReaction | null;
}

function mergeUnique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function extractThemes(response: ConsciousModeStructuredResponse): string[] {
  return mergeUnique([
    response.openingReasoning,
    ...response.implementationPlan,
    ...response.tradeoffs,
    ...response.edgeCases,
    ...response.scaleConsiderations,
    ...response.pushbackResponses,
    response.codeTransition,
  ]).slice(0, 8);
}

function summarizeResponse(response: ConsciousModeStructuredResponse): string {
  const parts = [
    response.openingReasoning,
    response.implementationPlan[0],
    response.tradeoffs[0],
    response.scaleConsiderations[0],
    response.pushbackResponses[0],
  ].filter(Boolean);

  return parts.join(' ');
}

export class AnswerHypothesisStore {
  private latestHypothesis: AnswerHypothesis | null = null;
  private latestReaction: QuestionReaction | null = null;

  recordStructuredSuggestion(question: string, response: ConsciousModeStructuredResponse, threadAction: 'start' | 'continue' | 'reset'): void {
    const likelyThemes = extractThemes(response);
    const latestSuggestedAnswer = summarizeResponse(response);
    const baseConfidence = threadAction === 'continue' ? 0.74 : 0.62;

    if (threadAction === 'continue' && this.latestHypothesis) {
      this.latestHypothesis = {
        ...this.latestHypothesis,
        sourceQuestion: question,
        latestSuggestedAnswer: latestSuggestedAnswer || this.latestHypothesis.latestSuggestedAnswer,
        likelyThemes: mergeUnique([...this.latestHypothesis.likelyThemes, ...likelyThemes]).slice(0, 10),
        confidence: Math.min(0.9, Math.max(this.latestHypothesis.confidence, baseConfidence)),
        evidence: mergeUnique([...this.latestHypothesis.evidence, 'suggested']) as Array<'suggested' | 'inferred'>,
        updatedAt: Date.now(),
      };
      return;
    }

    this.latestHypothesis = {
      sourceQuestion: question,
      latestSuggestedAnswer,
      likelyThemes,
      confidence: baseConfidence,
      evidence: ['suggested'],
      targetFacets: [],
      updatedAt: Date.now(),
    };
  }

  noteObservedReaction(question: string, reaction: QuestionReaction): void {
    this.latestReaction = reaction;
    if (!this.latestHypothesis || !reaction.shouldContinueThread) {
      return;
    }

    const inferredConfidence = Math.min(0.96, this.latestHypothesis.confidence + (reaction.confidence * 0.12));
    this.latestHypothesis = {
      ...this.latestHypothesis,
      sourceQuestion: question,
      confidence: inferredConfidence,
      evidence: mergeUnique([...this.latestHypothesis.evidence, 'inferred']) as Array<'suggested' | 'inferred'>,
      reactionKind: reaction.kind,
      targetFacets: mergeUnique([...this.latestHypothesis.targetFacets, ...reaction.targetFacets]),
      updatedAt: Date.now(),
    };
  }

  getLatestHypothesis(): AnswerHypothesis | null {
    return this.latestHypothesis;
  }

  getLatestReaction(): QuestionReaction | null {
    return this.latestReaction;
  }

  buildContextBlock(): string {
    if (!this.latestHypothesis) {
      return '';
    }

    const lines = [
      '<conscious_evidence>',
      'The interviewer side is confirmed. The user answer state below is inferred from prior suggestions and reactions.',
      `LIKELY_USER_ANSWER_CONFIDENCE: ${this.latestHypothesis.confidence.toFixed(2)}`,
      `LATEST_SUGGESTED_ANSWER: ${this.latestHypothesis.latestSuggestedAnswer || 'n/a'}`,
      `LIKELY_THEMES: ${this.latestHypothesis.likelyThemes.join(' | ') || 'n/a'}`,
      `EVIDENCE: ${this.latestHypothesis.evidence.join(', ')}`,
    ];

    if (this.latestHypothesis.reactionKind) {
      lines.push(`INTERVIEWER_REACTION: ${this.latestHypothesis.reactionKind}`);
    }
    if (this.latestHypothesis.targetFacets.length > 0) {
      lines.push(`REACTION_TARGETS: ${this.latestHypothesis.targetFacets.join(', ')}`);
    }

    lines.push('</conscious_evidence>');
    return lines.join('\n');
  }

  reset(): void {
    this.latestHypothesis = null;
    this.latestReaction = null;
  }

  getPersistenceSnapshot(): PersistedAnswerHypothesisState {
    return {
      latestHypothesis: this.latestHypothesis,
      latestReaction: this.latestReaction,
    };
  }

  restorePersistenceSnapshot(snapshot: PersistedAnswerHypothesisState | null | undefined): void {
    this.latestHypothesis = snapshot?.latestHypothesis ?? null;
    this.latestReaction = snapshot?.latestReaction ?? null;
  }
}
