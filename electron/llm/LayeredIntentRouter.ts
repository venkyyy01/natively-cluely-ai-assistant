// electron/llm/LayeredIntentRouter.ts
// Hybrid parallel ensemble intent router.
//
// Philosophy: leverage ALL classifiers to their fullest potential.
// Fast classifiers run in parallel; foundation model is the judge of last resort.
//
// Architecture:
//   0. PREFETCH (if available, already computed during silence gap)
//   1. FAST PARALLEL ENSEMBLE (all run simultaneously, ~15-100ms total):
//      - SetFit (domain-specific, few-shot, ~10-30ms)
//      - SLM/Xenova (general zero-shot, ~15-40ms)
//      - Semantic Embedding Router (pattern matching, ~1-5ms)
//      - Regex Cue Scoring (heuristic, ~0-1ms)
//   2. ENSEMBLE CONSENSUS:
//      - If multiple classifiers agree with high confidence → return immediately
//      - If single classifier is confident, others miss → return it
//      - If classifiers disagree or all uncertain → foundation model rescue
//   3. FOUNDATION MODEL RESCUE (only when needed, ~500ms timeout):
//      - Called for contradictions, low-confidence ensembles, or novel patterns
//      - Highest accuracy, slowest path
//   4. FALLBACK: Context heuristic (always available, 0ms)
//
// Benefits:
//   - Accuracy: ensemble + foundation rescue catches edge cases
//   - Speed: parallel fast path means no waiting for slow classifiers
//   - Robustness: if one classifier fails, others cover

import type { ConversationIntent, IntentResult } from './IntentClassifier';
import {
  classifyIntent,
  detectIntentByPattern,
  detectIntentByContext,
  getAnswerShapeGuidance,
} from './IntentClassifier';
import { SemanticEmbeddingRouter } from './SemanticEmbeddingRouter';
import { SetFitIntentProvider } from './providers/SetFitIntentProvider';
import { getIntentConfidenceService } from './IntentConfidenceService';
import type { IntentClassificationCoordinator } from './providers/IntentClassificationCoordinator';

export interface LayeredRouterInput {
  question: string;
  transcript: string;
  assistantResponseCount: number;
  prefetchedIntent?: IntentResult | null;
  coordinator?: IntentClassificationCoordinator | null;
  transcriptRevision?: number;
}

export interface LayeredRouterDecision {
  intentResult: IntentResult;
  layer: number;
  layerName: string;
  latencyMs: number;
  isReliable: boolean;
  ensemble: Array<{ provider: string; intent: string; confidence: number; used: boolean }>;
}

const RELIABLE_INTENTS = new Set<ConversationIntent>([
  'behavioral', 'coding', 'deep_dive', 'clarification',
  'follow_up', 'example_request', 'summary_probe'
]);

export function isReliableIntent(result: IntentResult): boolean {
  if (!result || result.intent === 'general') return false;
  if (!RELIABLE_INTENTS.has(result.intent)) return false;
  const cal = getIntentConfidenceService().getCalibration(result.intent);
  return result.confidence >= cal.minReliableConfidence;
}

function getIntentWeight(intent: string): number {
  // Prefer specific technical intents over vague ones
  const weights: Record<string, number> = {
    coding: 1.2,
    deep_dive: 1.15,
    behavioral: 1.1,
    clarification: 0.9,
    follow_up: 0.85,
    example_request: 0.85,
    summary_probe: 0.8,
    general: 0.5,
  };
  return weights[intent] ?? 0.7;
}

interface FastClassifierResult {
  provider: string;
  result: IntentResult | null;
  latencyMs: number;
  error?: string;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T | null> {
  return Promise.race([
    promise.then((v) => v).catch((error: unknown): null => {
      console.warn(`[LayeredIntentRouter] ${label} failed:`, error);
      return null;
    }),
    new Promise<null>((resolve) => {
      setTimeout(() => {
        console.log(`[LayeredIntentRouter] ${label} timed out after ${timeoutMs}ms`);
        resolve(null);
      }, timeoutMs);
    }),
  ]);
}

export class LayeredIntentRouter {
  private static instance: LayeredIntentRouter | null = null;
  private semanticRouter: SemanticEmbeddingRouter;
  private setFitProvider: SetFitIntentProvider;
  private slmWarm = false;

  private constructor() {
    this.semanticRouter = SemanticEmbeddingRouter.getInstance();
    this.setFitProvider = new SetFitIntentProvider();
  }

  static getInstance(): LayeredIntentRouter {
    if (!LayeredIntentRouter.instance) {
      LayeredIntentRouter.instance = new LayeredIntentRouter();
    }
    return LayeredIntentRouter.instance;
  }

  static resetForTesting(): void {
    LayeredIntentRouter.instance = null;
  }

  warmup(): void {
    if (this.slmWarm) return;
    this.slmWarm = true;
    this.setFitProvider.warmup();
    import('./IntentClassifier').then(({ warmupIntentClassifier }) => {
      warmupIntentClassifier();
    }).catch(() => {});
  }

  /**
   * Route a question through the hybrid parallel ensemble.
   * All fast classifiers run simultaneously. Foundation model is only
   * invoked when the ensemble is uncertain or contradictory.
   */
  async route(input: LayeredRouterInput): Promise<LayeredRouterDecision> {
    const startTime = Date.now();

    // Layer 0: Prefetched intent (already computed)
    if (input.prefetchedIntent && isReliableIntent(input.prefetchedIntent)) {
      console.log(
        `[LayeredIntentRouter] Layer 0 (prefetch) → ${input.prefetchedIntent.intent} ` +
        `confidence=${(input.prefetchedIntent.confidence * 100).toFixed(1)}%`
      );
      return {
        intentResult: input.prefetchedIntent,
        layer: 0,
        layerName: 'prefetch',
        latencyMs: Date.now() - startTime,
        isReliable: true,
        ensemble: [{
          provider: 'prefetch',
          intent: input.prefetchedIntent.intent,
          confidence: input.prefetchedIntent.confidence,
          used: true,
        }],
      };
    }

    // Layer 1: FAST PARALLEL ENSEMBLE
    // Run SetFit, SLM, Regex, and Embedding simultaneously
    const [setFitResult, slmResult, regexResult, embeddingResult] = await Promise.all([
      // SetFit: domain-specific few-shot classifier
      this.runSetFit(input.question),
      // SLM: general zero-shot classifier
      this.runSLM(input.question, input.transcript, input.assistantResponseCount),
      // Regex: fast pattern matching
      this.runRegex(input.question),
      // Embedding: semantic similarity against intent patterns
      this.runEmbedding(input.question),
    ]);

    const fastResults: FastClassifierResult[] = [
      setFitResult,
      slmResult,
      regexResult,
      embeddingResult,
    ];

    // Build ensemble decision
    const ensembleDecision = this.resolveEnsemble(fastResults);

    console.log(
      `[LayeredIntentRouter] Ensemble results: ` +
      fastResults
        .filter((r) => r.result !== null)
        .map((r) => `${r.provider}=${r.result!.intent}(${(r.result!.confidence * 100).toFixed(0)}%)`)
        .join(', ') +
      ` | decision=${ensembleDecision?.intent ?? 'uncertain'}`
    );

    // If ensemble is confident and reliable, return immediately
    if (ensembleDecision && isReliableIntent(ensembleDecision)) {
      const ensembleMeta = fastResults.map((r) => ({
        provider: r.provider,
        intent: r.result?.intent ?? 'miss',
        confidence: r.result?.confidence ?? 0,
        used: r.result !== null && r.result.intent === ensembleDecision.intent,
      }));

      return {
        intentResult: ensembleDecision,
        layer: 1,
        layerName: 'ensemble',
        latencyMs: Date.now() - startTime,
        isReliable: true,
        ensemble: ensembleMeta,
      };
    }

    // Layer 2: FOUNDATION MODEL RESCUE
    // Called when:
    // - All fast classifiers missed or returned low confidence
    // - Fast classifiers disagree on intent
    // - Question is novel/complex and needs deep reasoning
    if (input.coordinator) {
      const coordinatorInput = {
        lastInterviewerTurn: input.question,
        preparedTranscript: input.transcript,
        assistantResponseCount: input.assistantResponseCount,
        transcriptRevision: input.transcriptRevision,
      };

      const coordinatorResult = await withTimeout(
        input.coordinator.classify(coordinatorInput),
        500,
        'coordinator'
      );

      if (coordinatorResult && isReliableIntent(coordinatorResult)) {
        console.log(
          `[LayeredIntentRouter] Layer 2 (foundation rescue) → ${coordinatorResult.intent} ` +
          `confidence=${(coordinatorResult.confidence * 100).toFixed(1)}% ` +
          `provider=${(coordinatorResult as any).provider ?? 'unknown'}`
        );
        return {
          intentResult: coordinatorResult,
          layer: 2,
          layerName: 'foundation_rescue',
          latencyMs: Date.now() - startTime,
          isReliable: true,
          ensemble: [
            ...fastResults.map((r) => ({
              provider: r.provider,
              intent: r.result?.intent ?? 'miss',
              confidence: r.result?.confidence ?? 0,
              used: false,
            })),
            {
              provider: 'foundation',
              intent: coordinatorResult.intent,
              confidence: coordinatorResult.confidence,
              used: true,
            },
          ],
        };
      }
    }

    // Layer 3: FALLBACK — use best available fast result even if not "reliable"
    // or fall back to context heuristic
    const bestFastResult = this.pickBestFastResult(fastResults);
    if (bestFastResult) {
      const reliable = isReliableIntent(bestFastResult);
      return {
        intentResult: bestFastResult,
        layer: 3,
        layerName: 'fast_fallback',
        latencyMs: Date.now() - startTime,
        isReliable: reliable,
        ensemble: fastResults.map((r) => ({
          provider: r.provider,
          intent: r.result?.intent ?? 'miss',
          confidence: r.result?.confidence ?? 0,
          used: r.result === bestFastResult,
        })),
      };
    }

    // Ultimate fallback: context heuristic
    const contextResult = detectIntentByContext(input.transcript, input.assistantResponseCount);
    return {
      intentResult: contextResult,
      layer: 4,
      layerName: 'context',
      latencyMs: Date.now() - startTime,
      isReliable: isReliableIntent(contextResult),
      ensemble: fastResults.map((r) => ({
        provider: r.provider,
        intent: r.result?.intent ?? 'miss',
        confidence: r.result?.confidence ?? 0,
        used: false,
      })),
    };
  }

  /**
   * Fast path: only use parallel ensemble, no foundation model.
   * Used when latency budget is extremely tight.
   */
  async routeFast(input: LayeredRouterInput): Promise<LayeredRouterDecision> {
    const startTime = Date.now();

    // Layer 0: Prefetch
    if (input.prefetchedIntent && isReliableIntent(input.prefetchedIntent)) {
      return {
        intentResult: input.prefetchedIntent,
        layer: 0,
        layerName: 'prefetch',
        latencyMs: Date.now() - startTime,
        isReliable: true,
        ensemble: [{
          provider: 'prefetch',
          intent: input.prefetchedIntent.intent,
          confidence: input.prefetchedIntent.confidence,
          used: true,
        }],
      };
    }

    // Parallel fast ensemble only
    const [setFitResult, slmResult, regexResult, embeddingResult] = await Promise.all([
      this.runSetFit(input.question),
      this.runSLM(input.question, input.transcript, input.assistantResponseCount),
      this.runRegex(input.question),
      this.runEmbedding(input.question),
    ]);

    const fastResults = [setFitResult, slmResult, regexResult, embeddingResult];
    const ensembleDecision = this.resolveEnsemble(fastResults);

    if (ensembleDecision && isReliableIntent(ensembleDecision)) {
      return {
        intentResult: ensembleDecision,
        layer: 1,
        layerName: 'ensemble',
        latencyMs: Date.now() - startTime,
        isReliable: true,
        ensemble: fastResults.map((r) => ({
          provider: r.provider,
          intent: r.result?.intent ?? 'miss',
          confidence: r.result?.confidence ?? 0,
          used: r.result !== null && r.result.intent === ensembleDecision.intent,
        })),
      };
    }

    const bestFast = this.pickBestFastResult(fastResults);
    if (bestFast) {
      return {
        intentResult: bestFast,
        layer: 1,
        layerName: 'ensemble_fallback',
        latencyMs: Date.now() - startTime,
        isReliable: isReliableIntent(bestFast),
        ensemble: fastResults.map((r) => ({
          provider: r.provider,
          intent: r.result?.intent ?? 'miss',
          confidence: r.result?.confidence ?? 0,
          used: r.result === bestFast,
        })),
      };
    }

    const contextResult = detectIntentByContext(input.transcript, input.assistantResponseCount);
    return {
      intentResult: contextResult,
      layer: 2,
      layerName: 'context',
      latencyMs: Date.now() - startTime,
      isReliable: isReliableIntent(contextResult),
      ensemble: fastResults.map((r) => ({
        provider: r.provider,
        intent: r.result?.intent ?? 'miss',
        confidence: r.result?.confidence ?? 0,
        used: false,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Individual classifier runners
  // ---------------------------------------------------------------------------

  private async runSetFit(question: string): Promise<FastClassifierResult> {
    const start = Date.now();
    try {
      const available = await this.setFitProvider.isAvailable();
      if (!available) {
        return { provider: 'setfit', result: null, latencyMs: Date.now() - start, error: 'not_available' };
      }
      const result = await withTimeout(
        this.setFitProvider.classify({
          lastInterviewerTurn: question,
          preparedTranscript: '',
          assistantResponseCount: 0,
        }),
        50,
        'setfit'
      );
      return {
        provider: 'setfit',
        result,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        provider: 'setfit',
        result: null,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async runSLM(
    question: string,
    transcript: string,
    assistantResponseCount: number
  ): Promise<FastClassifierResult> {
    const start = Date.now();
    try {
      const result = await withTimeout(
        classifyIntent(question, transcript, assistantResponseCount),
        150,
        'slm'
      );
      return {
        provider: 'slm',
        result,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        provider: 'slm',
        result: null,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private runRegex(question: string): Promise<FastClassifierResult> {
    const start = Date.now();
    try {
      const result = detectIntentByPattern(question);
      return Promise.resolve({
        provider: 'regex',
        result,
        latencyMs: Date.now() - start,
      });
    } catch (error) {
      return Promise.resolve({
        provider: 'regex',
        result: null,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runEmbedding(question: string): Promise<FastClassifierResult> {
    const start = Date.now();
    try {
      const result = await withTimeout(
        this.semanticRouter.classify(question),
        50,
        'embedding'
      );
      return {
        provider: 'embedding',
        result,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        provider: 'embedding',
        result: null,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Ensemble resolution logic
  // ---------------------------------------------------------------------------

  /**
   * Resolve ensemble: pick the best intent from multiple classifier results.
   *
   * Rules (in order):
   * 1. STRONG CONSENSUS: ≥2 classifiers agree with confidence ≥ 0.72 → return that intent
   * 2. HIGH CONFIDENCE SINGLE: 1 classifier ≥ 0.82, no contradiction → return it
   * 3. WEIGHTED BEST: Score each result by (confidence × intent_weight × provider_bonus)
   *    - SetFit and SLM get higher weight than regex/embedding
   *    - Return highest scorer if ≥ 0.65
   * 4. CONTRADICTION: High-confidence disagreement → return null (trigger foundation rescue)
   * 5. UNCERTAIN: All below threshold → return null (trigger foundation rescue)
   */
  private resolveEnsemble(results: FastClassifierResult[]): IntentResult | null {
    const validResults = results
      .filter((r): r is FastClassifierResult & { result: IntentResult } => r.result !== null);

    if (validResults.length === 0) return null;

    // Group by intent
    const byIntent = new Map<string, FastClassifierResult[]>();
    for (const r of validResults) {
      const arr = byIntent.get(r.result.intent) ?? [];
      arr.push(r);
      byIntent.set(r.result.intent, arr);
    }

    // Rule 1: Strong consensus (≥2 classifiers, both ≥ 0.72)
    for (const [intent, classifiers] of byIntent) {
      const strongOnes = classifiers.filter((r) => r.result.confidence >= 0.72);
      if (strongOnes.length >= 2) {
        const avgConfidence = strongOnes.reduce((sum, r) => sum + r.result.confidence, 0) / strongOnes.length;
        return {
          intent: intent as ConversationIntent,
          confidence: Math.min(avgConfidence + 0.05, 0.95), // small consensus bonus
          answerShape: getAnswerShapeGuidance(intent as ConversationIntent),
        };
      }
    }

    // Rule 2: High confidence single (≥ 0.82) with no strong contradiction
    const highConfidence = validResults.filter((r) => r.result.confidence >= 0.82);
    if (highConfidence.length === 1) {
      const winner = highConfidence[0];
      // Check for contradiction: any other classifier ≥ 0.65 with different intent
      const contradiction = validResults.find(
        (r) => r.result.intent !== winner.result.intent && r.result.confidence >= 0.65
      );
      if (!contradiction) {
        return winner.result;
      }
    }

    // Rule 3: Weighted scoring
    // NAT-XXX: Increase SetFit/SLM authority over embedding to prevent
    // false positives from pseudo-embedding similarity on short/vague queries.
    const providerBonus: Record<string, number> = {
      setfit: 1.25,
      slm: 1.15,
      embedding: 0.85,
      regex: 0.9,
    };

    let bestScore = -1;
    let bestResult: IntentResult | null = null;

    for (const r of validResults) {
      const weight = getIntentWeight(r.result.intent);
      const providerMult = providerBonus[r.provider] ?? 1.0;
      const score = r.result.confidence * weight * providerMult;

      if (score > bestScore) {
        bestScore = score;
        bestResult = r.result;
      }
    }

    // Only return if score meets threshold
    // Lower threshold when fewer providers are available (partial ensemble)
    const effectiveThreshold = validResults.length <= 2 ? 0.50 : 0.65;
    if (bestScore >= effectiveThreshold && bestResult) {
      return bestResult;
    }

    // Rule 4/5: Contradiction or too uncertain → trigger foundation rescue
    return null;
  }

  /**
   * Pick the best fast result even if it doesn't meet the ensemble threshold.
   * Used as fallback before context heuristic.
   */
  private pickBestFastResult(results: FastClassifierResult[]): IntentResult | null {
    const validResults = results
      .filter((r): r is FastClassifierResult & { result: IntentResult } => r.result !== null);

    if (validResults.length === 0) return null;

    // Prefer SetFit > SLM > Embedding > Regex
    const providerRank: Record<string, number> = {
      setfit: 0,
      slm: 1,
      embedding: 2,
      regex: 3,
    };

    return validResults.sort((a, b) => {
      const confDiff = b.result.confidence - a.result.confidence;
      if (Math.abs(confDiff) > 0.1) return confDiff;
      return (providerRank[a.provider] ?? 99) - (providerRank[b.provider] ?? 99);
    })[0]?.result ?? null;
  }
}

/**
 * Convenience function for one-off routing.
 */
export async function routeIntent(input: LayeredRouterInput): Promise<LayeredRouterDecision> {
  return LayeredIntentRouter.getInstance().route(input);
}
