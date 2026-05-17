/**
 * ResponseSalvager
 *
 * NAT-CM-AUDIT: when the provenance verifier rejects a structured response
 * because of an `unsupported_technology_claim` or `unsupported_metric_claim`,
 * the orchestrator currently throws the entire response away and falls back
 * to standard mode. That's wasteful — most of the answer is fine, only
 * specific tokens are unsupported. The salvager removes the offending
 * tokens (and surrounding sentence if removal would leave a syntactic
 * fragment), so the orchestrator can re-verify a cleaner version.
 *
 * The salvager is intentionally conservative:
 *   - It only scrubs tokens, never rewrites prose.
 *   - It removes a whole sentence if scrubbing leaves a fragment that no
 *     longer makes grammatical sense.
 *   - It never adds new content. If salvaging empties a field, that field
 *     is left empty and the verifier will catch it.
 *
 * Unsupported terms are derived from the original verifier rejection by
 * the caller. Callers should pass a small list (typically 1–3 tokens).
 */

import type {
  ConsciousModeStructuredResponse,
  ConsciousCodingApproach,
  ConsciousCodingInterviewAnswer,
  ConsciousBehavioralAnswer,
} from '../ConsciousMode';

export interface SalvageInput {
  response: ConsciousModeStructuredResponse;
  /** Tokens (lowercased, word-boundary safe) that must be removed. */
  unsupportedTokens: string[];
}

export interface SalvageResult {
  response: ConsciousModeStructuredResponse;
  /** Tokens that were actually removed. */
  removed: string[];
  /** Number of fields that ended up empty after scrubbing. */
  emptiedFields: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Drop the sentence containing any of the tokens. We keep the rest.
 * If the input has no obvious sentence boundary, we return an empty string
 * because partial fragments are worse than silence.
 */
function scrubSentence(text: string, tokens: string[]): string {
  if (!text) return text;
  const lower = text.toLowerCase();
  const tokenHits = tokens.some((t) => new RegExp(`\\b${escapeRegex(t.toLowerCase())}\\b`).test(lower));
  if (!tokenHits) return text;

  // Split on sentence boundaries while preserving them.
  const sentences = text.match(/[^.!?]+[.!?]?/g) || [text];
  const cleaned = sentences
    .filter((s) => {
      const sl = s.toLowerCase();
      return !tokens.some((t) => new RegExp(`\\b${escapeRegex(t.toLowerCase())}\\b`).test(sl));
    })
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return cleaned.join(' ').trim();
}

function scrubList(values: string[], tokens: string[]): string[] {
  if (!values || values.length === 0) return values;
  return values
    .map((v) => scrubSentence(v, tokens))
    .filter((v) => v.length > 0);
}

function scrubApproach(approach: ConsciousCodingApproach, tokens: string[]): ConsciousCodingApproach {
  return {
    ...approach,
    intuition: scrubSentence(approach.intuition || '', tokens),
    whyItWorks: scrubSentence(approach.whyItWorks || '', tokens),
    whyBruteForceInsufficient: scrubSentence(approach.whyBruteForceInsufficient || '', tokens),
    optimizationInsight: scrubSentence(approach.optimizationInsight || '', tokens),
    dataStructureChoice: scrubSentence(approach.dataStructureChoice || '', tokens),
    // We deliberately do NOT scrub `code` — code identifiers may legitimately
    // share names with rejected tokens, and partial code is worse than
    // letting the deterministic verifier catch it.
    code: approach.code,
    timeComplexity: scrubSentence(approach.timeComplexity, tokens),
    timeComplexityReasoning: scrubSentence(approach.timeComplexityReasoning, tokens),
    spaceComplexity: scrubSentence(approach.spaceComplexity, tokens),
    spaceComplexityReasoning: scrubSentence(approach.spaceComplexityReasoning, tokens),
  };
}

function scrubCodingAnswer(coding: ConsciousCodingInterviewAnswer, tokens: string[]): ConsciousCodingInterviewAnswer {
  return {
    language: coding.language,
    problemUnderstanding: {
      task: scrubSentence(coding.problemUnderstanding.task, tokens),
      inputsOutputsConstraints: scrubSentence(coding.problemUnderstanding.inputsOutputsConstraints, tokens),
      trickyCases: scrubList(coding.problemUnderstanding.trickyCases, tokens),
      hiddenAssumptions: scrubList(coding.problemUnderstanding.hiddenAssumptions, tokens),
      interviewerEvaluation: scrubSentence(coding.problemUnderstanding.interviewerEvaluation, tokens),
    },
    bruteForceApproach: scrubApproach(coding.bruteForceApproach, tokens),
    optimizedApproach: scrubApproach(coding.optimizedApproach, tokens),
    tradeoffsAndInterviewReasoning: {
      whyPreferred: scrubSentence(coding.tradeoffsAndInterviewReasoning.whyPreferred, tokens),
      alternatives: scrubList(coding.tradeoffsAndInterviewReasoning.alternatives, tokens),
      dataStructureRationale: scrubSentence(coding.tradeoffsAndInterviewReasoning.dataStructureRationale, tokens),
      commonFollowUps: scrubList(coding.tradeoffsAndInterviewReasoning.commonFollowUps, tokens),
    },
  };
}

function scrubBehavioral(behavioral: ConsciousBehavioralAnswer, tokens: string[]): ConsciousBehavioralAnswer {
  return {
    question: behavioral.question,
    headline: scrubSentence(behavioral.headline, tokens),
    situation: scrubSentence(behavioral.situation, tokens),
    task: scrubSentence(behavioral.task, tokens),
    action: scrubSentence(behavioral.action, tokens),
    result: scrubSentence(behavioral.result, tokens),
    whyThisAnswerWorks: scrubList(behavioral.whyThisAnswerWorks, tokens),
  };
}

/**
 * Salvage a structured response by stripping unsupported tokens.
 * Returns the cleaned response plus a list of tokens that were actually
 * removed (some may not appear if the verifier was over-eager).
 */
export function salvageResponse(input: SalvageInput): SalvageResult {
  const tokens = (input.unsupportedTokens || [])
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) {
    return { response: input.response, removed: [], emptiedFields: 0 };
  }

  const response = input.response;
  const original = JSON.stringify(response);

  const cleaned: ConsciousModeStructuredResponse = {
    ...response,
    openingReasoning: scrubSentence(response.openingReasoning, tokens),
    implementationPlan: scrubList(response.implementationPlan, tokens),
    tradeoffs: scrubList(response.tradeoffs, tokens),
    edgeCases: scrubList(response.edgeCases, tokens),
    scaleConsiderations: scrubList(response.scaleConsiderations, tokens),
    pushbackResponses: scrubList(response.pushbackResponses, tokens),
    likelyFollowUps: scrubList(response.likelyFollowUps, tokens),
    codeTransition: scrubSentence(response.codeTransition, tokens),
    codingInterviewAnswer: response.codingInterviewAnswer
      ? scrubCodingAnswer(response.codingInterviewAnswer, tokens)
      : null,
    behavioralAnswer: response.behavioralAnswer
      ? scrubBehavioral(response.behavioralAnswer, tokens)
      : null,
  };

  const cleanedString = JSON.stringify(cleaned);
  const removed = tokens.filter((t) => {
    const re = new RegExp(`\\b${escapeRegex(t)}\\b`, 'i');
    return re.test(original) && !re.test(cleanedString);
  });

  let emptiedFields = 0;
  if (response.openingReasoning && !cleaned.openingReasoning) emptiedFields++;
  if (response.implementationPlan.length && !cleaned.implementationPlan.length) emptiedFields++;
  if (response.tradeoffs.length && !cleaned.tradeoffs.length) emptiedFields++;
  if (response.edgeCases.length && !cleaned.edgeCases.length) emptiedFields++;
  if (response.scaleConsiderations.length && !cleaned.scaleConsiderations.length) emptiedFields++;
  if (response.pushbackResponses.length && !cleaned.pushbackResponses.length) emptiedFields++;

  return { response: cleaned, removed, emptiedFields };
}

/**
 * Extract the offending tokens from a verifier rejection reason. The
 * verifier currently encodes only the reason kind, not the tokens, so
 * this helper re-extracts technology-like tokens from the response itself
 * by intersecting it with a list of "known unsupported" tokens.
 *
 * Callers that have access to the strict grounding context can do better
 * — see `ResponseSalvager.deriveUnsupportedTokens` below for the canonical
 * way to compute the list.
 */
export function deriveUnsupportedTokens(input: {
  responseText: string;
  groundingText: string;
  knownTechAllowlist: readonly string[];
}): string[] {
  const responseLower = input.responseText.toLowerCase();
  const groundingLower = input.groundingText.toLowerCase();
  const out: string[] = [];

  // Numeric claims: anything in the response that looks like a metric and
  // doesn't appear verbatim in the grounding.
  const numericPattern = /\b\d+(?:\.\d+)?(?:ms|sec|min|hr|hours|hrs|x|%|kb|mb|gb|tb|qps|rps|rpm)\b/gi;
  for (const match of responseLower.match(numericPattern) || []) {
    if (!new RegExp(`\\b${escapeRegex(match)}\\b`, 'i').test(groundingLower)) {
      out.push(match);
    }
  }

  // Technology terms: anything in the allowlist that's in the response but
  // not in the grounding.
  for (const term of input.knownTechAllowlist) {
    const lower = term.toLowerCase();
    const re = new RegExp(`\\b${escapeRegex(lower)}\\b`, 'i');
    if (re.test(responseLower) && !re.test(groundingLower)) {
      out.push(lower);
    }
  }

  return Array.from(new Set(out));
}
