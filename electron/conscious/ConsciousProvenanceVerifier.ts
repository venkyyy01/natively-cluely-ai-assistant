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

    const unsupportedTech = this.findUnsupportedTerms(
      extractKnownTechnologies(responseText),
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
