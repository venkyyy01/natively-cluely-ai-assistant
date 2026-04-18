import type { ConsciousModeQuestionRoute, ConsciousModeStructuredResponse } from '../ConsciousMode';
import type { AnswerHypothesis } from './AnswerHypothesisStore';
import type { QuestionReaction } from './QuestionReactionClassifier';

export interface ConsciousVerificationResult {
  ok: boolean;
  reason?: string;
}

export interface ConsciousVerifierJudgeInput {
  response: ConsciousModeStructuredResponse;
  route: ConsciousModeQuestionRoute;
  reaction?: QuestionReaction | null;
  hypothesis?: AnswerHypothesis | null;
  question: string;
}

export interface ConsciousVerifierJudge {
  judge(input: ConsciousVerifierJudgeInput): Promise<ConsciousVerificationResult | null>;
}

export interface ConsciousVerifierOptions {
  requireJudge?: boolean;
}

function hasSubstance(response: ConsciousModeStructuredResponse): boolean {
  return Boolean(
    response.openingReasoning.trim() ||
    response.implementationPlan.length ||
    response.tradeoffs.length ||
    response.edgeCases.length ||
    response.scaleConsiderations.length ||
    response.pushbackResponses.length ||
    response.codeTransition.trim() ||
    response.behavioralAnswer?.headline ||
    response.behavioralAnswer?.action ||
    response.behavioralAnswer?.result
  );
}

function isBehavioralQuestion(question: string): boolean {
  return /(tell me about a time|describe a time|describe a situation|share an experience|give me an example|walk me through|talk about|how do you manage|what is your .*style|how do you make .*decision|how do you influence|how do you prioritize|leadership|conflict|disagreed|disagreement|feedback|failure|mistake|mentor|stakeholder|culture|values)/i.test(question);
}

function wordCount(value: string | null | undefined): number {
  return (value || '').trim().split(/\s+/).filter(Boolean).length;
}

function hasBehavioralImpactCue(text: string): boolean {
  return /(\b\d+(?:\.\d+)?(?:ms|s|x|%|k|m|b)?\b|improv|reduc|increas|decreas|saved|faster|slower|stabil|unblock|delivered|shipped|adopt|retention|latency|throughput|quality|incident|customer|user|team|process|runbook|checklist|learned|next time|would do differently)/i.test(text);
}

function hasCompleteBehavioralStar(response: ConsciousModeStructuredResponse): boolean {
  const behavioral = response.behavioralAnswer;
  return Boolean(
    behavioral?.question
    && behavioral.headline
    && behavioral.situation
    && behavioral.task
    && behavioral.action
    && behavioral.result
    && behavioral.whyThisAnswerWorks.length >= 3
    && behavioral.whyThisAnswerWorks.length <= 5
  );
}

function hasStrongBehavioralDepth(response: ConsciousModeStructuredResponse): boolean {
  const behavioral = response.behavioralAnswer;
  if (!behavioral) {
    return false;
  }

  const actionWords = wordCount(behavioral.action);
  const situationWords = wordCount(behavioral.situation);
  const taskWords = wordCount(behavioral.task);
  const resultWords = wordCount(behavioral.result);

  return actionWords >= 18
    && actionWords > situationWords
    && actionWords > taskWords
    && resultWords >= 8
    && hasBehavioralImpactCue(behavioral.result);
}

function summaryText(response: ConsciousModeStructuredResponse): string {
  return [
    response.openingReasoning,
    ...response.implementationPlan,
    ...response.tradeoffs,
    ...response.edgeCases,
    ...response.scaleConsiderations,
    ...response.pushbackResponses,
    response.behavioralAnswer?.question,
    response.behavioralAnswer?.headline,
    response.behavioralAnswer?.situation,
    response.behavioralAnswer?.task,
    response.behavioralAnswer?.action,
    response.behavioralAnswer?.result,
    ...(response.behavioralAnswer?.whyThisAnswerWorks || []),
    response.codeTransition,
  ].join(' ').toLowerCase();
}

export class ConsciousVerifier {
  constructor(
    private readonly judge: ConsciousVerifierJudge | null = null,
    private readonly options: ConsciousVerifierOptions = {},
  ) {}

  async verify(input: ConsciousVerifierJudgeInput): Promise<ConsciousVerificationResult> {
    const ruleVerdict = this.verifyRules(input);
    if (!ruleVerdict.ok) {
      return ruleVerdict;
    }

    if (!this.judge) {
      return this.options.requireJudge
        ? { ok: false, reason: 'judge_unavailable' }
        : ruleVerdict;
    }

    try {
      const judgeVerdict = await this.judge.judge(input);
      if (!judgeVerdict) {
        return this.options.requireJudge
          ? { ok: false, reason: 'judge_unavailable' }
          : ruleVerdict;
      }

      return judgeVerdict.ok ? ruleVerdict : judgeVerdict;
    } catch {
      return this.options.requireJudge
        ? { ok: false, reason: 'judge_execution_failed' }
        : ruleVerdict;
    }
  }

  private verifyRules(input: ConsciousVerifierJudgeInput): ConsciousVerificationResult {
    return this.verifyRuleSet(input);
  }

  private verifyRuleSet(input: ConsciousVerifierJudgeInput): ConsciousVerificationResult {
    if (!hasSubstance(input.response)) {
      return { ok: false, reason: 'empty_structured_response' };
    }

    const reaction = input.reaction;
    const hypothesis = input.hypothesis;
    const responseText = summaryText(input.response);

    if (isBehavioralQuestion(input.question) && !hasCompleteBehavioralStar(input.response)) {
      return { ok: false, reason: 'missing_behavioral_star_structure' };
    }

    if (isBehavioralQuestion(input.question) && !hasStrongBehavioralDepth(input.response)) {
      return { ok: false, reason: 'weak_behavioral_depth' };
    }

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
