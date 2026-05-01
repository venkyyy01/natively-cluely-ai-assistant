import type { ConsciousModeStructuredResponse, ReasoningThread } from '../ConsciousMode';
import type { AnswerHypothesis } from './AnswerHypothesisStore';

export type QuestionReactionKind =
  | 'fresh_question'
  | 'challenge'
  | 'tradeoff_probe'
  | 'metric_probe'
  | 'example_request'
  | 'clarification'
  | 'repeat_request'
  | 'deep_dive'
  | 'topic_shift'
  | 'generic_follow_up';

export interface QuestionReaction {
  kind: QuestionReactionKind;
  confidence: number;
  cues: string[];
  targetFacets: string[];
  shouldContinueThread: boolean;
}

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasGenericFollowUpCue(text: string): boolean {
  return includesAny(text, [
    /^(and|but|so)\b/i,
    /\b(this|that|it|those|these|them|there|then)\b/i,
    /\b(still|also|instead|too)\b/i,
    /\b(approach|design|system|choice|tradeoff|part|layer|path|flow)\b/i,
  ]);
}

function collectTargets(response?: ConsciousModeStructuredResponse | null): string[] {
  if (!response) {
    return [];
  }

  const targets: string[] = [];
  if (response.tradeoffs.length > 0) targets.push('tradeoffs');
  if (response.implementationPlan.length > 0) targets.push('implementationPlan');
  if (response.edgeCases.length > 0) targets.push('edgeCases');
  if (response.scaleConsiderations.length > 0) targets.push('scaleConsiderations');
  if (response.pushbackResponses.length > 0) targets.push('pushbackResponses');
  if (response.codeTransition) targets.push('codeTransition');
  return targets;
}

export class QuestionReactionClassifier {
  classify(input: {
    question: string;
    activeThread: ReasoningThread | null;
    latestResponse?: ConsciousModeStructuredResponse | null;
    latestHypothesis?: AnswerHypothesis | null;
  }): QuestionReaction {
    const normalized = input.question.trim();
    const lower = normalized.toLowerCase();
    const hasThread = !!input.activeThread;
    const targetFacets = collectTargets(input.latestResponse);
    const cues: string[] = [];

    if (!hasThread) {
      return {
        kind: 'fresh_question',
        confidence: 0.45,
        cues: normalized ? ['no_active_thread'] : [],
        targetFacets,
        shouldContinueThread: false,
      };
    }

    if (includesAny(lower, [/(switch gears|different topic|move on to|new topic|something else|let(?:'s| us) talk about)/i])) {
      return {
        kind: 'topic_shift',
        confidence: 0.94,
        cues: ['explicit_topic_shift'],
        targetFacets,
        shouldContinueThread: false,
      };
    }

    if (includesAny(lower, [/(repeat that|say that again|can you repeat)/i])) {
      return {
        kind: 'repeat_request',
        confidence: 0.96,
        cues: ['repeat_request'],
        targetFacets,
        shouldContinueThread: false,
      };
    }

    if (includesAny(lower, [/(tradeoff|pros and cons|downside|upside)/i])) {
      cues.push('tradeoff_language');
      return {
        kind: 'tradeoff_probe',
        confidence: 0.91,
        cues,
        targetFacets: targetFacets.includes('tradeoffs') ? ['tradeoffs'] : targetFacets,
        shouldContinueThread: true,
      };
    }

    if (includesAny(lower, [/(metric|measure|latency|throughput|success|kpi|watch first|monitor)/i])) {
      cues.push('metric_language');
      return {
        kind: 'metric_probe',
        confidence: 0.9,
        cues,
        targetFacets: targetFacets.includes('scaleConsiderations') ? ['scaleConsiderations'] : targetFacets,
        shouldContinueThread: true,
      };
    }

    if (includesAny(lower, [/(for example|give me an example|example|walk me through a specific)/i])) {
      cues.push('example_language');
      return {
        kind: 'example_request',
        confidence: 0.88,
        cues,
        targetFacets,
        shouldContinueThread: true,
      };
    }

    if (includesAny(lower, [/(why|why not|why this|why that|why .* over .*|defend|justify)/i])) {
      cues.push('challenge_language');
      return {
        kind: 'challenge',
        confidence: 0.84,
        cues,
        targetFacets: targetFacets.includes('pushbackResponses') ? ['pushbackResponses'] : targetFacets,
        shouldContinueThread: true,
      };
    }

    if (includesAny(lower, [/(what if|how would that change|and then|what happens|how would you handle|edge case)/i])) {
      cues.push('deep_dive_language');
      return {
        kind: 'deep_dive',
        confidence: 0.82,
        cues,
        targetFacets: targetFacets.includes('edgeCases') ? ['edgeCases'] : targetFacets,
        shouldContinueThread: true,
      };
    }

    if (includesAny(lower, [/(what do you mean|clarify|can you explain|can you unpack|how so)/i])) {
      cues.push('clarification_language');
      return {
        kind: 'clarification',
        confidence: 0.8,
        cues,
        targetFacets,
        shouldContinueThread: true,
      };
    }

    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    const shouldContinueThread = wordCount >= 3 && hasGenericFollowUpCue(lower);

    return {
      kind: 'generic_follow_up',
      confidence: shouldContinueThread ? 0.62 : 0.4,
      cues: shouldContinueThread ? ['active_thread_follow_up'] : [],
      targetFacets,
      shouldContinueThread,
    };
  }
}
