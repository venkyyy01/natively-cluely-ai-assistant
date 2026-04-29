import { isBehavioralQuestionText } from '../ConsciousMode';
import type { ConsciousModeQuestionRoute, ConsciousModeStructuredResponse } from '../ConsciousMode';
import type { AnswerHypothesis } from './AnswerHypothesisStore';
import type { QuestionReaction } from './QuestionReactionClassifier';
import { isVerifierOptimizationActive } from '../config/optimizations';
import techAllowlist from './data/techAllowlist.json';
import { StarScorer } from './StarScorer';
import { BayesianVerifierAggregator, type VerifierResult } from './BayesianVerifierAggregator';

export interface ConsciousVerificationResult {
  ok: boolean;
  reason?: string;
  deterministic?: 'pass' | 'fail' | 'skipped';
  judge?: 'pass' | 'fail' | 'skipped';
  posterior?: number; // Bayesian aggregated confidence
  decision?: 'accept' | 'reject' | 'reroute'; // Bayesian decision
}

export interface ConsciousVerifierJudgeInput {
  response: ConsciousModeStructuredResponse;
  route: ConsciousModeQuestionRoute;
  reaction?: QuestionReaction | null;
  hypothesis?: AnswerHypothesis | null;
  evidence?: Array<'suggested' | 'inferred'>;
  question: string;
  skipJudge?: boolean;
  provenanceResult?: { ok: boolean; confidence?: number } | null; // Optional provenance verification result
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

  // Use probabilistic scorer if flag is enabled
  const useProbabilistic = isVerifierOptimizationActive('useProbabilisticStar');
  if (useProbabilistic) {
    const scorer = new StarScorer();
    const score = scorer.score(response);
    return scorer.isAcceptable(score);
  }

  // Original hard floor rules (fallback or when flag is disabled)
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function groundingHasToken(groundingText: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(groundingText);
}

function hasUnsupportedNumericClaim(responseText: string, groundingText: string): boolean {
  const useTighterRegex = isVerifierOptimizationActive('useTighterNumericClaimRegex');

  // Tighter regex: requires unit suffix to avoid false positives on years, counts, team sizes
  const NUMERIC_WITH_UNIT_RE = useTighterRegex
    ? /\b\d+(?:\.\d+)?(?:ms|sec|min|hr|hours|hrs|x|%|kb|mb|gb|tb|qps|rps|rpm)\b/gi
    : /\b\d+(?:\.\d+)?(?:ms|s|m|h|x|%|k|m|b)?\b/g;

  const numericClaims = responseText.match(NUMERIC_WITH_UNIT_RE) || [];
  if (numericClaims.length === 0) {
    return false;
  }
  const useWordBoundary = isVerifierOptimizationActive('useConsciousVerifierWordBoundary');
  return numericClaims.some((claim) => {
    if (useWordBoundary) {
      return !groundingHasToken(groundingText, claim);
    }
    return !groundingText.includes(claim);
  });
}

function hasUnsupportedTechnologyClaim(responseText: string, groundingText: string): boolean {
  const useExpandedAllowlist = isVerifierOptimizationActive('useExpandedTechAllowlist');

  // Build the tech token regex from the allowlist
  // Sort by length descending to match longer tokens first (e.g., postgresql before postgres)
  const tokens = useExpandedAllowlist
    ? [...techAllowlist.tokens].sort((a, b) => b.length - a.length)
    : [
        'kafka',
        'redis',
        'postgres',
        'postgresql',
        'mysql',
        'mongodb',
        'dynamodb',
        'snowflake',
        'bigquery',
        'clickhouse',
        'elasticsearch',
        'opensearch',
        'weaviate',
        'pinecone',
        'qdrant',
        'rabbitmq',
        'grpc',
        'kubernetes',
        'docker',
        'terraform',
        'spark',
        'airflow',
        'node',
        'nodejs',
        'typescript',
        'python',
        'java',
        'golang',
        'aws',
        'gcp',
        'azure',
      ];

  const escapedTokens = tokens.map(escapeRegExp);
  const TECH_TOKEN_RE = new RegExp(`\\b(${escapedTokens.join('|')})\\b`, 'gi');

  const techClaims = responseText.match(TECH_TOKEN_RE) || [];
  if (techClaims.length === 0) {
    return false;
  }
  const useWordBoundary = isVerifierOptimizationActive('useConsciousVerifierWordBoundary');
  return techClaims.some((token) => {
    if (useWordBoundary) {
      return !groundingHasToken(groundingText, token);
    }
    return !groundingText.includes(token);
  });
}

export class ConsciousVerifier {
  constructor(
    private readonly judge: ConsciousVerifierJudge | null = null,
    private readonly options: ConsciousVerifierOptions = {},
  ) {}

  async verify(input: ConsciousVerifierJudgeInput): Promise<ConsciousVerificationResult> {
    const ruleVerdict = this.verifyRules(input);
    
    // Use Bayesian aggregation if flag is enabled and we have all verifier results
    const useBayesian = isVerifierOptimizationActive('useBayesianAggregation');
    if (useBayesian && input.provenanceResult !== undefined) {
      return this.verifyWithBayesianAggregation(input, ruleVerdict);
    }
    
    // Original hard AND chain (fallback or when flag is disabled)
    if (!ruleVerdict.ok) {
      return ruleVerdict;
    }

    // Skip judge when explicitly requested (degraded mode / circuit breaker open)
    if (input.skipJudge) {
      return { ...ruleVerdict, judge: 'skipped' };
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

  private async verifyWithBayesianAggregation(
    input: ConsciousVerifierJudgeInput,
    ruleVerdict: ConsciousVerificationResult
  ): Promise<ConsciousVerificationResult> {
    const aggregator = new BayesianVerifierAggregator();
    const results: VerifierResult[] = [];

    // Add deterministic rules result
    results.push(BayesianVerifierAggregator.deterministicResult(
      ruleVerdict.ok,
      ruleVerdict.ok ? 0.8 : 0.2
    ));

    // Add provenance result if available
    if (input.provenanceResult) {
      results.push(BayesianVerifierAggregator.provenanceResult(
        input.provenanceResult.ok,
        input.provenanceResult.confidence ?? 0.5
      ));
    }

    // Add judge result if available
    if (!input.skipJudge && this.judge) {
      try {
        const judgeVerdict = await this.judge.judge(input);
        if (judgeVerdict) {
          results.push(BayesianVerifierAggregator.judgeResult(
            judgeVerdict.ok,
            judgeVerdict.ok ? 0.8 : 0.2
          ));
        }
      } catch {
        // Judge failed, skip it
      }
    }

    // Aggregate results
    const aggregation = aggregator.aggregate(results);

    // Map Bayesian decision to ConsciousVerificationResult
    let ok: boolean;
    let reason: string | undefined;

    if (aggregation.decision === 'accept') {
      ok = true;
    } else if (aggregation.decision === 'reject') {
      ok = false;
      reason = 'bayesian_reject';
    } else {
      // reroute - treat as ok but with a note
      ok = true;
      reason = 'bayesian_reroute';
    }

    return {
      ok,
      reason,
      deterministic: ruleVerdict.ok ? 'pass' : 'fail',
      judge: results.find(r => r.name === 'judge')?.passed ? 'pass' : 'skipped',
      posterior: aggregation.posterior,
      decision: aggregation.decision,
    };
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
