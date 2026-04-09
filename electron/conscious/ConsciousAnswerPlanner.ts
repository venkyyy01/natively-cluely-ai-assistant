import type { AnswerHypothesis } from './AnswerHypothesisStore';
import type { QuestionReaction } from './QuestionReactionClassifier';

export type ConsciousAnswerShape =
  | 'direct_answer'
  | 'tradeoff_defense'
  | 'metric_backed_answer'
  | 'example_answer'
  | 'clarification_answer'
  | 'depth_extension'
  | 'pushback_defense';

export interface ConsciousAnswerPlan {
  answerShape: ConsciousAnswerShape;
  focalFacets: string[];
  maxWords: number;
  confidence: number;
  rationale: string;
}

export class ConsciousAnswerPlanner {
  plan(input: {
    question: string;
    reaction?: QuestionReaction | null;
    hypothesis?: AnswerHypothesis | null;
  }): ConsciousAnswerPlan {
    const reaction = input.reaction;
    const focalFacets = reaction?.targetFacets?.length ? reaction.targetFacets : input.hypothesis?.targetFacets || [];

    switch (reaction?.kind) {
      case 'tradeoff_probe':
        return {
          answerShape: 'tradeoff_defense',
          focalFacets,
          maxWords: 110,
          confidence: 0.92,
          rationale: 'Interviewer is explicitly probing tradeoffs; answer should defend one chosen approach with tradeoff clarity.',
        };
      case 'metric_probe':
        return {
          answerShape: 'metric_backed_answer',
          focalFacets: focalFacets.length ? focalFacets : ['metrics', 'scaleConsiderations'],
          maxWords: 110,
          confidence: 0.92,
          rationale: 'Interviewer is asking how success or risk would be measured.',
        };
      case 'example_request':
        return {
          answerShape: 'example_answer',
          focalFacets,
          maxWords: 120,
          confidence: 0.9,
          rationale: 'Interviewer asked for a concrete example, so the answer should anchor on one scenario.',
        };
      case 'clarification':
        return {
          answerShape: 'clarification_answer',
          focalFacets,
          maxWords: 90,
          confidence: 0.86,
          rationale: 'Interviewer wants the previous idea unpacked, not a fresh broad answer.',
        };
      case 'challenge':
        return {
          answerShape: 'pushback_defense',
          focalFacets: focalFacets.length ? focalFacets : ['pushbackResponses'],
          maxWords: 110,
          confidence: 0.88,
          rationale: 'Interviewer is challenging the choice and needs a direct defense.',
        };
      case 'deep_dive':
        return {
          answerShape: 'depth_extension',
          focalFacets: focalFacets.length ? focalFacets : ['implementationPlan', 'edgeCases'],
          maxWords: 120,
          confidence: 0.86,
          rationale: 'Interviewer is digging deeper into the same thread.',
        };
      default:
        return {
          answerShape: 'direct_answer',
          focalFacets,
          maxWords: 95,
          confidence: input.hypothesis?.confidence ?? 0.6,
          rationale: 'No strong reaction signal; answer directly and keep it focused.',
        };
    }
  }

  buildContextBlock(plan: ConsciousAnswerPlan): string {
    return [
      '<conscious_answer_plan>',
      `ANSWER_SHAPE: ${plan.answerShape}`,
      `FOCAL_FACETS: ${plan.focalFacets.join(', ') || 'none'}`,
      `MAX_WORDS: ${plan.maxWords}`,
      `PLAN_CONFIDENCE: ${plan.confidence.toFixed(2)}`,
      `RATIONALE: ${plan.rationale}`,
      '</conscious_answer_plan>',
    ].join('\n');
  }
}
