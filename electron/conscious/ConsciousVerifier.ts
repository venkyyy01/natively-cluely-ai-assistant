import { isBehavioralQuestionText } from '../ConsciousMode';
import type { ConsciousModeQuestionRoute, ConsciousModeStructuredResponse } from '../ConsciousMode';
import type { AnswerHypothesis } from './AnswerHypothesisStore';
import type { QuestionReaction } from './QuestionReactionClassifier';

export interface ConsciousVerificationResult {
  ok: boolean;
  reason?: string;
  deterministic?: 'pass' | 'fail' | 'skipped';
  judge?: 'pass' | 'fail' | 'skipped';
}

export interface ConsciousVerifierJudgeInput {
  response: ConsciousModeStructuredResponse;
  route: ConsciousModeQuestionRoute;
  reaction?: QuestionReaction | null;
  hypothesis?: AnswerHypothesis | null;
  evidence?: Array<'suggested' | 'inferred'>;
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
  return isBehavioralQuestionText(question);
}

function wordCount(value: string | null | undefined): number {
  return (value || '').trim().split(/\s+/).filter(Boolean).length;
}

function hasBehavioralImpactCue(text: string): boolean {
  return /(\b\d+(?:\.\d+)?(?:ms|s|x|%|k|m|b)?\b|improv|reduc|increas|decreas|saved|faster|slower|stabil|unblock|delivered|shipped|adopt|retention|latency|throughput|quality|incident|customer|user|team|process|runbook|checklist|learned|next time|would do differently)/i.test(text);
}

const BEHAVIORAL_DEPTH_RULES = {
  minActionWords: 12,
  minResultWords: 6,
  minActionAdvantageWords: 2,
} as const;

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

  // Calibrated against the conscious harness fixtures: reject shallow STAR answers,
  // but allow concise stories when the action still carries clearly more detail than
  // the setup and the result has a concrete impact cue.
  return actionWords >= BEHAVIORAL_DEPTH_RULES.minActionWords
    && actionWords >= situationWords + BEHAVIORAL_DEPTH_RULES.minActionAdvantageWords
    && actionWords >= taskWords + BEHAVIORAL_DEPTH_RULES.minActionAdvantageWords
    && resultWords >= BEHAVIORAL_DEPTH_RULES.minResultWords
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

function isInferredDominantEvidence(evidence: Array<'suggested' | 'inferred'> | null | undefined): boolean {
  if (!evidence || evidence.length === 0) {
    return false;
  }
  let inferred = 0;
  let suggested = 0;
  for (const marker of evidence) {
    if (marker === 'inferred') inferred += 1;
    if (marker === 'suggested') suggested += 1;
  }
  return inferred > 0 && inferred >= suggested;
}

function gatherStrictGroundingText(input: ConsciousVerifierJudgeInput): string {
  const hypothesis = input.hypothesis;
  return [
    input.question,
    hypothesis?.sourceQuestion,
    hypothesis?.latestSuggestedAnswer,
    ...(hypothesis?.likelyThemes || []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function hasUnsupportedNumericClaim(responseText: string, groundingText: string): boolean {
  const numericClaims = responseText.match(/\b\d+(?:\.\d+)?(?:ms|s|m|h|x|%|k|m|b)?\b/g) || [];
  if (numericClaims.length === 0) {
    return false;
  }
  return numericClaims.some((claim) => !groundingText.includes(claim));
}

function hasUnsupportedTechnologyClaim(responseText: string, groundingText: string): boolean {
  // Conservative allowlist of common technology tokens that frequently
  // indicate fabricated specificity in inferred-only follow-ups.
  const TECH_TOKEN_RE =
    /\b(kafka|redis|postgres(?:ql)?|mysql|mongodb|dynamodb|snowflake|bigquery|clickhouse|elasticsearch|opensearch|weaviate|pinecone|qdrant|rabbitmq|grpc|kubernetes|docker|terraform|spark|airflow|node(?:\.js)?|typescript|python|java|golang|aws|gcp|azure)\b/g;
  const techClaims = responseText.match(TECH_TOKEN_RE) || [];
  if (techClaims.length === 0) {
    return false;
  }
  return techClaims.some((token) => !groundingText.includes(token));
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
        ? { ok: false, reason: 'judge_unavailable', deterministic: 'pass', judge: 'fail' }
        : { ...ruleVerdict, judge: 'skipped' };
    }

    try {
      const judgeVerdict = await this.judge.judge(input);
      if (!judgeVerdict) {
        return this.options.requireJudge
          ? { ok: false, reason: 'judge_unavailable', deterministic: 'pass', judge: 'fail' }
          : { ...ruleVerdict, judge: 'skipped', reason: ruleVerdict.reason ?? 'judge_unavailable' };
      }

      return judgeVerdict.ok
        ? { ...ruleVerdict, judge: 'pass' }
        : {
            ok: false,
            reason: judgeVerdict.reason,
            deterministic: 'pass',
            judge: 'fail',
          };
    } catch {
      return this.options.requireJudge
        ? { ok: false, reason: 'judge_execution_failed', deterministic: 'pass', judge: 'fail' }
        : { ...ruleVerdict, judge: 'skipped', reason: ruleVerdict.reason ?? 'judge_execution_failed' };
    }
  }

  private verifyRules(input: ConsciousVerifierJudgeInput): ConsciousVerificationResult {
    return this.verifyRuleSet(input);
  }

  private verifyRuleSet(input: ConsciousVerifierJudgeInput): ConsciousVerificationResult {
    if (!hasSubstance(input.response)) {
      return { ok: false, reason: 'empty_structured_response', deterministic: 'fail', judge: 'skipped' };
    }

    const reaction = input.reaction;
    const hypothesis = input.hypothesis;
    const responseText = summaryText(input.response);
    const evidence = input.evidence ?? hypothesis?.evidence;

    if (isBehavioralQuestion(input.question) && !hasCompleteBehavioralStar(input.response)) {
      return { ok: false, reason: 'missing_behavioral_star_structure', deterministic: 'fail', judge: 'skipped' };
    }

    if (isBehavioralQuestion(input.question) && !hasStrongBehavioralDepth(input.response)) {
      return { ok: false, reason: 'weak_behavioral_depth', deterministic: 'fail', judge: 'skipped' };
    }

    if (reaction?.kind === 'tradeoff_probe' && input.response.tradeoffs.length === 0 && input.response.pushbackResponses.length === 0) {
      return { ok: false, reason: 'missing_tradeoff_content', deterministic: 'fail', judge: 'skipped' };
    }

    if (reaction?.kind === 'metric_probe' && input.response.scaleConsiderations.length === 0 && !/metric|latency|throughput|monitor|measure|slo|sla/.test(responseText)) {
      return { ok: false, reason: 'missing_metric_content', deterministic: 'fail', judge: 'skipped' };
    }

    if (reaction?.kind === 'challenge' && input.response.pushbackResponses.length === 0 && input.response.tradeoffs.length === 0) {
      return { ok: false, reason: 'missing_defense_content', deterministic: 'fail', judge: 'skipped' };
    }

    if (reaction?.kind === 'deep_dive' && input.response.edgeCases.length === 0 && input.response.scaleConsiderations.length === 0 && input.response.implementationPlan.length === 0) {
      return { ok: false, reason: 'missing_depth_content', deterministic: 'fail', judge: 'skipped' };
    }

    if (reaction?.kind === 'example_request' && input.response.implementationPlan.length === 0 && !/example|for instance|for example/.test(responseText)) {
      return { ok: false, reason: 'missing_example_content', deterministic: 'fail', judge: 'skipped' };
    }

    if (
      input.route.threadAction === 'continue' &&
      hypothesis?.latestSuggestedAnswer &&
      responseText.trim() === hypothesis.latestSuggestedAnswer.trim().toLowerCase()
    ) {
      return { ok: false, reason: 'duplicate_follow_up_response', deterministic: 'fail', judge: 'skipped' };
    }

    // NAT-050: when the answer-state signal is inferred-dominant, reject
    // unsupported numeric/technology specificity that isn't grounded by the
    // strict verifier context (question + prior suggested answer + themes).
    // This is intentionally stricter than normal continuation checks because
    // inferred-only states are the highest-risk path for confident hallucination.
    if (isInferredDominantEvidence(evidence)) {
      const groundingText = gatherStrictGroundingText(input);
      if (hasUnsupportedNumericClaim(responseText, groundingText)) {
        return { ok: false, reason: 'unsupported_numeric_claim_in_inferred_state', deterministic: 'fail', judge: 'skipped' };
      }
      if (hasUnsupportedTechnologyClaim(responseText, groundingText)) {
        return { ok: false, reason: 'unsupported_technology_claim_in_inferred_state', deterministic: 'fail', judge: 'skipped' };
      }
    }

    return { ok: true, deterministic: 'pass', judge: 'skipped' };
  }
}
