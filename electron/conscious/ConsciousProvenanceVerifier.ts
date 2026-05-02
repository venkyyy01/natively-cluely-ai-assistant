import type { ConsciousModeStructuredResponse } from '../ConsciousMode';
import type { AnswerHypothesis } from './AnswerHypothesisStore';
import { SemanticEntailmentVerifier } from './SemanticEntailmentVerifier';
import { isVerifierOptimizationActive } from '../config/optimizations';
import { TranscriptIndex, type SearchResult } from './TranscriptIndex';

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
    response.behavioralAnswer?.question,
    response.behavioralAnswer?.headline,
    response.behavioralAnswer?.situation,
    response.behavioralAnswer?.task,
    response.behavioralAnswer?.action,
    response.behavioralAnswer?.result,
    ...(response.behavioralAnswer?.whyThisAnswerWorks || []),
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
  const lowercaseAfterTechVerbPattern = /\b(?:use|using|used|with|via|on|into|through|choose|choosing|pick|picking|migrate to|integrate with)\s+([a-z][a-z0-9.+#-]{2,})\b/g;

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

  for (const match of text.matchAll(lowercaseAfterTechVerbPattern)) {
    const term = match[1];
    const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 48);
    if (TECH_NOUN_PATTERN.test(after)) {
      addTechnologyCandidate(candidates, term);
    }
  }

  return Array.from(candidates);
}

function extractGroundingTechnologyVocabulary(...contexts: string[]): string[] {
  const candidates = new Set<string>();
  const combined = contexts.filter(Boolean).join(' ');
  const technologyListPattern = /\b(?:technologies|technology|stack|tooling|providers?)\s*:\s*([^\n]+)/gi;
  const beforeTechNounPattern = /\b([a-z][a-z0-9.+#-]{2,})\s+(?:database|db|queue|cache|broker|stream|topic|cluster|index|vector|service|api|sdk|framework|library|runtime|warehouse|search|engine|store|model|provider|platform|orchestrator)s?\b/gi;
  const afterTechVerbPattern = /\b(?:using|used|with|via|on|through|choose|choosing|pick|picking|integrate with|migrate to)\s+([a-z][a-z0-9.+#-]{2,})\b/gi;

  for (const term of KNOWN_TECH_TERMS) {
    if (combined.includes(term)) {
      candidates.add(term);
    }
  }

  for (const match of combined.matchAll(technologyListPattern)) {
    const rawList = match[1] || '';
    for (const token of rawList.split(/[;,/]|\band\b/g)) {
      addTechnologyCandidate(candidates, token);
    }
  }

  for (const match of combined.matchAll(beforeTechNounPattern)) {
    addTechnologyCandidate(candidates, match[1]);
  }

  for (const match of combined.matchAll(afterTechVerbPattern)) {
    addTechnologyCandidate(candidates, match[1]);
  }

  return Array.from(candidates);
}

function extractTechnologyClaims(text: string, dynamicVocabulary: string[] = []): string[] {
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

  for (const term of dynamicVocabulary) {
    if (lower.includes(term)) {
      terms.add(term);
    }
  }

  return Array.from(terms);
}

function extractNumbers(text: string): string[] {
  return Array.from(new Set((text.match(/\b\d+(?:\.\d+)?(?:ms|s|x|%|k|m|b)?\b/gi) || []).map((match) => match.toLowerCase())));
}

export class ConsciousProvenanceVerifier {
  private semanticEntailmentVerifier = new SemanticEntailmentVerifier();

  private normalizeGroundingContext(input: {
    semanticContextBlock?: string;
    evidenceContextBlock?: string;
  }): { strict: string } {
    const semanticContext = (input.semanticContextBlock || '').trim().toLowerCase();
    const evidenceContext = (input.evidenceContextBlock || '').trim().toLowerCase();

    // NAT-004 / audit A-9: question text is intentionally NOT included in the
    // grounding context. Echoing the user's question is not evidence that the
    // claim is true; using it as grounding lets the model "supply" its own
    // grounding by parroting the question back.
    const strict = [semanticContext, evidenceContext].filter(Boolean).join(' ');

    return { strict };
  }

  private async findUnsupportedTerms(terms: string[], strictContext: string): Promise<string[]> {
    const unsupported: string[] = [];
    const useSemantic = isVerifierOptimizationActive('useSemanticEntailment');

    for (const term of terms) {
      // Token-based check (fast path)
      if (strictContext.includes(term)) {
        continue;
      }

      // Semantic check if flag is enabled
      if (useSemantic) {
        try {
          const isSemanticallySupported = await this.semanticEntailmentVerifier.verifyTermSemantically(term, strictContext);
          if (isSemanticallySupported) {
            continue; // Term is semantically supported
          }
        } catch (error) {
          console.warn('[ConsciousProvenanceVerifier] Semantic entailment check failed, falling back to unsupported:', error);
          // Fall through to mark as unsupported
        }
      }

      unsupported.push(term);
    }
    return unsupported;
  }

  /**
   * NAT-004 / audit A-4: a response that names a specific technology or quotes
   * a metric must be backed by strict grounding. Used to decide whether an
   * empty-grounding response is "harmless to wave through" or a real fail.
   */
  private responseHasTechnologyOrMetricClaim(response: ConsciousModeStructuredResponse): boolean {
    const lowered = summaryText(response);
    const original = summaryText(response, false);

    if (extractTechnologyClaims(original).length > 0) {
      return true;
    }
    if (extractNumbers(lowered).length > 0) {
      return true;
    }
    return false;
  }

  async verify(input: {
    response: ConsciousModeStructuredResponse;
    semanticContextBlock?: string;
    evidenceContextBlock?: string;
    question?: string;
    hypothesis?: AnswerHypothesis | null;
    transcriptIndex?: TranscriptIndex | null;
  }): Promise<ConsciousProvenanceVerdict> {
    // Expand grounding context with RAG if flag is enabled
    let expandedSemanticContext = input.semanticContextBlock || '';
    const useRAG = isVerifierOptimizationActive('useRAGVerification');
    if (useRAG && input.transcriptIndex) {
      const responseText = summaryText(input.response);
      const ragResults = input.transcriptIndex.search(responseText);
      if (ragResults.length > 0) {
        const ragContext = ragResults.map(r => r.segment.text).join(' ');
        expandedSemanticContext = [expandedSemanticContext, ragContext].filter(Boolean).join(' ');
        console.log(`[ConsciousProvenanceVerifier] RAG expanded grounding with ${ragResults.length} segments`);
      }
    }

    const grounding = this.normalizeGroundingContext({ 
      semanticContextBlock: expandedSemanticContext,
      evidenceContextBlock: input.evidenceContextBlock 
    });
    const hasStrictGroundingContext = Boolean(grounding.strict);

    if (!hasStrictGroundingContext) {
      // When no profile/semantic data is loaded, we cannot verify technology
      // or metric claims. Rather than failing closed (which trips the circuit
      // breaker and kills conscious mode entirely), pass through with a note
      // that provenance was unverifiable. The deterministic verifier and LLM
      // judge still provide quality gates.
      if (this.responseHasTechnologyOrMetricClaim(input.response)) {
        console.log('[ConsciousProvenanceVerifier] No grounding context available; passing through technology/metric claims (unverifiable, not rejected)');
      }
      return { ok: true };
    }

    const responseText = summaryText(input.response);
    const originalResponseText = summaryText(input.response, false);
    const dynamicGroundingVocabulary = extractGroundingTechnologyVocabulary(grounding.strict);

    const unsupportedTech = await this.findUnsupportedTerms(
      extractTechnologyClaims(originalResponseText, dynamicGroundingVocabulary),
      grounding.strict,
    );
    if (unsupportedTech.length > 0) {
      return { ok: false, reason: 'unsupported_technology_claim' };
    }

    const unsupportedNumbers = await this.findUnsupportedTerms(
      extractNumbers(responseText),
      grounding.strict,
    );
    if (unsupportedNumbers.length > 0) {
      return { ok: false, reason: 'unsupported_metric_claim' };
    }

    return { ok: true };
  }
}
