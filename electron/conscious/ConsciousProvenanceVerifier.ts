import type { ConsciousModeStructuredResponse } from '../ConsciousMode';
import type { AnswerHypothesis } from './AnswerHypothesisStore';

export interface ConsciousProvenanceVerdict {
  ok: boolean;
  reason?: string;
}

const KNOWN_TECH_TERMS = [
  'redis',
  'kafka',
  'clickhouse',
  'cassandra',
  'postgres',
  'postgresql',
  'mysql',
  'mongodb',
  'dynamodb',
  'elasticsearch',
  'snowflake',
  'spark',
  'airflow',
  'kubernetes',
  'docker',
  'grpc',
  'graphql',
  's3',
  'lambda',
  'bigquery',
];

const TECH_CANDIDATE_STOPWORDS = new Set([
  'api',
  'apis',
  'sdk',
  'db',
  'sql',
  'ai',
  'ml',
  'ui',
  'ux',
  'id',
  'p99',
  'p95',
  'i',
  'we',
  'you',
  'the',
  'this',
  'that',
  'use',
  'using',
  'start',
  'store',
  'add',
  'keep',
  'watch',
  'current',
  'existing',
]);

const TECH_NOUN_PATTERN = /(?:database|db|queue|cache|broker|stream|topic|cluster|index|vector|service|api|sdk|framework|library|runtime|warehouse|search|engine|store|model|provider|platform|orchestrator)s?/i;

function summaryText(response: ConsciousModeStructuredResponse, lowercase: boolean = true): string {
  const text = [
    response.openingReasoning,
    ...response.implementationPlan,
    ...response.tradeoffs,
    ...response.edgeCases,
    ...response.scaleConsiderations,
    ...response.pushbackResponses,
    response.codeTransition,
  ].join(' ');

  return lowercase ? text.toLowerCase() : text;
}

function normalizeCandidateTerm(term: string): string {
  return term
    .replace(/^[^A-Za-z0-9.+#-]+|[^A-Za-z0-9.+#-]+$/g, '')
    .toLowerCase();
}

function addTechnologyCandidate(candidates: Set<string>, term: string): void {
  const normalized = normalizeCandidateTerm(term);
  if (
    normalized.length < 2 ||
    TECH_CANDIDATE_STOPWORDS.has(normalized) ||
    /^\d+$/.test(normalized)
  ) {
    return;
  }

  candidates.add(normalized);
}

function extractDynamicTechnologyCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const acronymPattern = /\b[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]+)?\b/g;
  const camelCasePattern = /\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/g;
  const techSuffixPattern = /\b[A-Z][A-Za-z0-9.+#-]*(?:DB|SQL|JS|API|SDK|QL|ML|AI)\b/g;
  const beforeTechNounPattern = /\b([A-Z][A-Za-z0-9.+#-]{2,})\s+(?:database|db|queue|cache|broker|stream|topic|cluster|index|vector|service|api|sdk|framework|library|runtime|warehouse|search|engine|store|model|provider|platform)\b/g;
  const afterTechVerbPattern = /\b(?:use|using|used|with|via|on|into|through|choose|choosing|pick|picking|migrate to|integrate with)\s+([A-Z][A-Za-z0-9.+#-]{2,})\b/g;

  for (const pattern of [acronymPattern, camelCasePattern, techSuffixPattern]) {
    for (const match of text.matchAll(pattern)) {
      addTechnologyCandidate(candidates, match[0]);
    }
  }

  for (const match of text.matchAll(beforeTechNounPattern)) {
    addTechnologyCandidate(candidates, match[1]);
  }

  for (const match of text.matchAll(afterTechVerbPattern)) {
    const term = match[1];
    const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 48);
    if (TECH_NOUN_PATTERN.test(after) || /^[A-Z0-9-]+$/.test(term) || /[A-Z].*[A-Z]/.test(term)) {
      addTechnologyCandidate(candidates, term);
    }
  }

  return Array.from(candidates);
}

function extractTechnologyClaims(text: string): string[] {
  const lower = text.toLowerCase();
  const terms = new Set<string>();
  for (const term of KNOWN_TECH_TERMS) {
    if (lower.includes(term)) {
      terms.add(term);
    }
  }

  for (const term of extractDynamicTechnologyCandidates(text)) {
    terms.add(term);
  }

  return Array.from(terms);
}

function extractNumbers(text: string): string[] {
  return Array.from(new Set((text.match(/\b\d+(?:\.\d+)?(?:ms|s|x|%|k|m|b)?\b/gi) || []).map((match) => match.toLowerCase())));
}

export class ConsciousProvenanceVerifier {
  private normalizeGroundingContext(input: {
    semanticContextBlock?: string;
    evidenceContextBlock?: string;
    question?: string;
  }): { strict: string; relaxed: string } {
    const semanticContext = (input.semanticContextBlock || '').trim().toLowerCase();
    const evidenceContext = (input.evidenceContextBlock || '').trim().toLowerCase();
    const questionContext = (input.question || '').trim().toLowerCase();

    const strict = [semanticContext, evidenceContext].filter(Boolean).join(' ');
    const relaxed = [strict, questionContext].filter(Boolean).join(' ');

    return { strict, relaxed };
  }

  private findUnsupportedTerms(terms: string[], strictContext: string, relaxedContext: string): string[] {
    const unsupported: string[] = [];
    for (const term of terms) {
      if (strictContext.includes(term) || relaxedContext.includes(term)) {
        continue;
      }
      unsupported.push(term);
    }
    return unsupported;
  }

  verify(input: {
    response: ConsciousModeStructuredResponse;
    semanticContextBlock?: string;
    evidenceContextBlock?: string;
    question?: string;
    hypothesis?: AnswerHypothesis | null;
  }): ConsciousProvenanceVerdict {
    const grounding = this.normalizeGroundingContext(input);
    const hasStrictGroundingContext = Boolean(grounding.strict);
    if (!hasStrictGroundingContext) {
      return { ok: true };
    }

    if (!grounding.relaxed.trim()) {
      return { ok: true };
    }

    const responseText = summaryText(input.response);
    const originalResponseText = summaryText(input.response, false);

    const unsupportedTech = this.findUnsupportedTerms(
      extractTechnologyClaims(originalResponseText),
      grounding.strict,
      grounding.relaxed,
    );
    if (unsupportedTech.length > 0) {
      return { ok: false, reason: 'unsupported_technology_claim' };
    }

    const unsupportedNumbers = this.findUnsupportedTerms(
      extractNumbers(responseText),
      grounding.strict,
      grounding.relaxed,
    );
    if (unsupportedNumbers.length > 0) {
      return { ok: false, reason: 'unsupported_metric_claim' };
    }

    return { ok: true };
  }
}
