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

function extractNumbers(text: string): string[] {
  return Array.from(new Set((text.match(/\b\d+(?:\.\d+)?(?:ms|s|x|%|k|m|b)?\b/gi) || []).map((match) => match.toLowerCase())));
}

function extractKnownTechnologies(text: string): string[] {
  const lower = text.toLowerCase();
  return KNOWN_TECH_TERMS.filter((term) => lower.includes(term));
}

export class ConsciousProvenanceVerifier {
  verify(input: {
    response: ConsciousModeStructuredResponse;
    semanticContextBlock?: string;
    evidenceContextBlock?: string;
    question?: string;
    hypothesis?: AnswerHypothesis | null;
  }): ConsciousProvenanceVerdict {
    const semanticContext = (input.semanticContextBlock || '').trim();
    const evidenceContext = (input.evidenceContextBlock || '').trim();
    const hasStrictGroundingContext = Boolean(semanticContext || evidenceContext);
    if (!hasStrictGroundingContext) {
      return { ok: true };
    }

    const groundingContext = [
      semanticContext,
      evidenceContext,
      input.question || '',
    ].join(' ').toLowerCase();

    if (!groundingContext.trim()) {
      return { ok: true };
    }

    const responseText = summaryText(input.response);

    const unsupportedTech = extractKnownTechnologies(responseText).filter(
      (term) => !groundingContext.includes(term)
    );
    if (unsupportedTech.length > 0) {
      return { ok: false, reason: 'unsupported_technology_claim' };
    }

    const unsupportedNumbers = extractNumbers(responseText).filter(
      (value) => !groundingContext.includes(value)
    );
    if (unsupportedNumbers.length > 0) {
      return { ok: false, reason: 'unsupported_metric_claim' };
    }

    return { ok: true };
  }
}
