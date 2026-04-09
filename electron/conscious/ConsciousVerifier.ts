import type { ConsciousModeQuestionRoute, ConsciousModeStructuredResponse } from '../ConsciousMode';
import type { AnswerHypothesis } from './AnswerHypothesisStore';
import type { QuestionReaction } from './QuestionReactionClassifier';

export interface ConsciousVerificationResult {
  ok: boolean;
  reason?: string;
}

function hasSubstance(response: ConsciousModeStructuredResponse): boolean {
  return Boolean(
    response.openingReasoning.trim() ||
    response.implementationPlan.length ||
    response.tradeoffs.length ||
    response.edgeCases.length ||
    response.scaleConsiderations.length ||
    response.pushbackResponses.length ||
    response.codeTransition.trim()
  );
}

function summaryText(response: ConsciousModeStructuredResponse): string {
  return [
    response.openingReasoning,
    ...response.implementationPlan,
    ...response.tradeoffs,
    ...response.edgeCases,
    ...response.scaleConsiderations,
    ...response.pushbackResponses,
    response.codeTransition,
  ].join(' ').toLowerCase();
}

export class ConsciousVerifier {
  verify(input: {
    response: ConsciousModeStructuredResponse;
    route: ConsciousModeQuestionRoute;
    reaction?: QuestionReaction | null;
    hypothesis?: AnswerHypothesis | null;
    question: string;
  }): ConsciousVerificationResult {
    if (!hasSubstance(input.response)) {
      return { ok: false, reason: 'empty_structured_response' };
    }

    const reaction = input.reaction;
    const hypothesis = input.hypothesis;
    const responseText = summaryText(input.response);

    if (reaction?.kind === 'tradeoff_probe' && input.response.tradeoffs.length === 0 && input.response.pushbackResponses.length === 0) {
      return { ok: false, reason: 'missing_tradeoff_content' };
    }

    if (reaction?.kind === 'metric_probe' && input.response.scaleConsiderations.length === 0 && !/metric|latency|throughput|monitor|measure|slo|sla/.test(responseText)) {
      return { ok: false, reason: 'missing_metric_content' };
    }

    if (reaction?.kind === 'challenge' && input.response.pushbackResponses.length === 0 && input.response.tradeoffs.length === 0) {
      return { ok: false, reason: 'missing_defense_content' };
    }

    if (reaction?.kind === 'deep_dive' && input.response.edgeCases.length === 0 && input.response.scaleConsiderations.length === 0 && input.response.implementationPlan.length === 0) {
      return { ok: false, reason: 'missing_depth_content' };
    }

    if (reaction?.kind === 'example_request' && input.response.implementationPlan.length === 0 && !/example|for instance|for example/.test(responseText)) {
      return { ok: false, reason: 'missing_example_content' };
    }

    if (
      input.route.threadAction === 'continue' &&
      hypothesis?.latestSuggestedAnswer &&
      responseText.trim() === hypothesis.latestSuggestedAnswer.trim().toLowerCase()
    ) {
      return { ok: false, reason: 'duplicate_follow_up_response' };
    }

    return { ok: true };
  }
}
