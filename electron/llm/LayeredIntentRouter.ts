// electron/llm/LayeredIntentRouter.ts
// Cascading intent router: tries multiple classification layers in order,
// falling back to the next if the current one fails or returns uncertain.
//
// Layer order:
//   0. Prefetched intent (if available and reliable)
//   1. Fine-tuned SLM (Xenova/nli-deberta-v3-small, ~15-40ms)
//   2. Intent Classification Coordinator (foundation model, ~2-3s)
//   3. Semantic Embedding Router (pattern matching via embeddings, ~1-5ms)
//   4. Regex pattern matching (~0-1ms)
//   5. Context heuristic (~0ms)
//
// All layers are async. Timeouts are applied per-layer to ensure the router
// returns within a bounded budget.

import type { ConversationIntent, IntentResult } from './IntentClassifier';
import {
  classifyIntent,
  detectIntentByPattern,
  detectIntentByContext,
  getAnswerShapeGuidance,
} from './IntentClassifier';
import { SemanticEmbeddingRouter } from './SemanticEmbeddingRouter';
import { getIntentConfidenceService } from './IntentConfidenceService';
import { PIPELINE_INTENT_THRESHOLDS } from './intentConfidenceCalibration';
import type { IntentClassificationCoordinator } from './providers/IntentClassificationCoordinator';
import type { IntentClassificationInput } from './providers/IntentInferenceProvider';

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
  /** Which layer produced the result: 0=prefetch, 1=slm, 2=coordinator, 3=embedding, 4=regex, 5=context */
  layer: number;
  /** Human-readable layer name */
  layerName: string;
  /** Total latency in ms */
  latencyMs: number;
  /** Whether the intent is reliable enough for conscious routing */
  isReliable: boolean;
}

interface LayerConfig {
  name: string;
  layer: number;
  timeoutMs: number;
}

const LAYER_CONFIGS: Record<number, LayerConfig> = {
  0: { name: 'prefetch', layer: 0, timeoutMs: 0 },      // Instant - already computed
  1: { name: 'slm', layer: 1, timeoutMs: 80 },          // Fine-tuned SLM
  2: { name: 'coordinator', layer: 2, timeoutMs: 500 }, // Foundation model (generous but bounded)
  3: { name: 'embedding', layer: 3, timeoutMs: 20 },    // Semantic router
  4: { name: 'regex', layer: 4, timeoutMs: 10 },        // Regex patterns
  5: { name: 'context', layer: 5, timeoutMs: 0 },       // Context heuristic (instant)
};

const RELIABLE_INTENTS = new Set<ConversationIntent>(['behavioral', 'coding', 'deep_dive', 'clarification', 'follow_up', 'example_request', 'summary_probe']);

export function isReliableIntent(result: IntentResult): boolean {
  if (!result || result.intent === 'general') {
    return false;
  }
  if (!RELIABLE_INTENTS.has(result.intent)) {
    return false;
  }
  const cal = getIntentConfidenceService().getCalibration(result.intent);
  return result.confidence >= cal.minReliableConfidence;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | null> {
  if (timeoutMs <= 0) {
    return promise.catch((error: unknown): null => {
      console.warn(`[LayeredIntentRouter] ${label} failed:`, error);
      return null;
    });
  }

  return Promise.race([
    promise.catch((error: unknown): null => {
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
  private slmWarm = false;

  private constructor() {
    this.semanticRouter = SemanticEmbeddingRouter.getInstance();
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
    // Pre-warm the SLM by triggering a no-op classify
    // The FineTunedClassifier handles its own warmup internally
    import('./IntentClassifier').then(({ warmupIntentClassifier }) => {
      warmupIntentClassifier();
    }).catch(() => {});
  }

  /**
   * Route a question through the cascading intent classification layers.
   * Returns the best available intent result with metadata about which layer
   * produced it and whether it's reliable enough for conscious routing.
   */
  async route(input: LayeredRouterInput): Promise<LayeredRouterDecision> {
    const startTime = Date.now();

    // Layer 0: Prefetched intent (already computed by IntentClassificationCoordinator)
    if (input.prefetchedIntent) {
      const result = input.prefetchedIntent;
      const reliable = isReliableIntent(result);
      if (reliable) {
        console.log(
          `[LayeredIntentRouter] Layer 0 (prefetch) → ${result.intent} ` +
          `confidence=${(result.confidence * 100).toFixed(1)}% reliable=true ` +
          `input="${input.question.substring(0, 60)}..."`
        );
        return {
          intentResult: result,
          layer: 0,
          layerName: 'prefetch',
          latencyMs: Date.now() - startTime,
          isReliable: true,
        };
      }
      console.log(
        `[LayeredIntentRouter] Layer 0 (prefetch) → ${result.intent} ` +
        `confidence=${(result.confidence * 100).toFixed(1)}% reliable=false, continuing...`
      );
    }

    // Layer 1: Fine-tuned SLM (fast, ~15-40ms)
    const slmResult = await withTimeout(
      classifyIntent(input.question, input.transcript, input.assistantResponseCount),
      LAYER_CONFIGS[1].timeoutMs,
      'slm'
    );
    if (slmResult && isReliableIntent(slmResult)) {
      console.log(
        `[LayeredIntentRouter] Layer 1 (slm) → ${slmResult.intent} ` +
        `confidence=${(slmResult.confidence * 100).toFixed(1)}% ` +
        `input="${input.question.substring(0, 60)}..."`
      );
      return {
        intentResult: slmResult,
        layer: 1,
        layerName: 'slm',
        latencyMs: Date.now() - startTime,
        isReliable: true,
      };
    }

    // Layer 2: Intent Classification Coordinator (foundation model, ~2-3s but with 500ms timeout)
    if (input.coordinator) {
      const coordinatorInput: IntentClassificationInput = {
        lastInterviewerTurn: input.question,
        preparedTranscript: input.transcript,
        assistantResponseCount: input.assistantResponseCount,
        transcriptRevision: input.transcriptRevision,
      };
      const coordinatorResult = await withTimeout(
        input.coordinator.classify(coordinatorInput),
        LAYER_CONFIGS[2].timeoutMs,
        'coordinator'
      );
      if (coordinatorResult && isReliableIntent(coordinatorResult)) {
        console.log(
          `[LayeredIntentRouter] Layer 2 (coordinator) → ${coordinatorResult.intent} ` +
          `confidence=${(coordinatorResult.confidence * 100).toFixed(1)}% ` +
          `provider=${(coordinatorResult as any).provider ?? 'unknown'} ` +
          `input="${input.question.substring(0, 60)}..."`
        );
        return {
          intentResult: coordinatorResult,
          layer: 2,
          layerName: 'coordinator',
          latencyMs: Date.now() - startTime,
          isReliable: true,
        };
      }
    }

    // Layer 3: Semantic Embedding Router (pattern matching via embeddings, ~1-5ms)
    const embeddingResult = await withTimeout(
      this.semanticRouter.classify(input.question),
      LAYER_CONFIGS[3].timeoutMs,
      'embedding'
    );
    if (embeddingResult && isReliableIntent(embeddingResult)) {
      console.log(
        `[LayeredIntentRouter] Layer 3 (embedding) → ${embeddingResult.intent} ` +
        `confidence=${(embeddingResult.confidence * 100).toFixed(1)}% ` +
        `input="${input.question.substring(0, 60)}..."`
      );
      return {
        intentResult: embeddingResult,
        layer: 3,
        layerName: 'embedding',
        latencyMs: Date.now() - startTime,
        isReliable: true,
      };
    }

    // Layer 4: Regex pattern matching (~0-1ms)
    const regexResult = detectIntentByPattern(input.question);
    if (regexResult && isReliableIntent(regexResult)) {
      console.log(
        `[LayeredIntentRouter] Layer 4 (regex) → ${regexResult.intent} ` +
        `confidence=${(regexResult.confidence * 100).toFixed(1)}% ` +
        `input="${input.question.substring(0, 60)}..."`
      );
      return {
        intentResult: regexResult,
        layer: 4,
        layerName: 'regex',
        latencyMs: Date.now() - startTime,
        isReliable: true,
      };
    }

    // Layer 5: Context heuristic (~0ms, always returns something)
    const contextResult = detectIntentByContext(input.transcript, input.assistantResponseCount);
    const reliable = isReliableIntent(contextResult);
    console.log(
      `[LayeredIntentRouter] Layer 5 (context) → ${contextResult.intent} ` +
      `confidence=${(contextResult.confidence * 100).toFixed(1)}% ` +
      `reliable=${reliable} ` +
      `input="${input.question.substring(0, 60)}..."`
    );
    return {
      intentResult: contextResult,
      layer: 5,
      layerName: 'context',
      latencyMs: Date.now() - startTime,
      isReliable: reliable,
    };
  }

  /**
   * Quick route that only uses fast layers (prefetch, SLM, embedding, regex).
   * Suitable for paths with tight latency budgets.
   */
  async routeFast(input: LayeredRouterInput): Promise<LayeredRouterDecision> {
    const startTime = Date.now();

    // Layer 0: Prefetched intent
    if (input.prefetchedIntent && isReliableIntent(input.prefetchedIntent)) {
      return {
        intentResult: input.prefetchedIntent,
        layer: 0,
        layerName: 'prefetch',
        latencyMs: Date.now() - startTime,
        isReliable: true,
      };
    }

    // Layer 1: SLM
    const slmResult = await withTimeout(
      classifyIntent(input.question, input.transcript, input.assistantResponseCount),
      80,
      'slm'
    );
    if (slmResult && isReliableIntent(slmResult)) {
      return {
        intentResult: slmResult,
        layer: 1,
        layerName: 'slm',
        latencyMs: Date.now() - startTime,
        isReliable: true,
      };
    }

    // Layer 3: Embedding
    const embeddingResult = await withTimeout(
      this.semanticRouter.classify(input.question),
      20,
      'embedding'
    );
    if (embeddingResult && isReliableIntent(embeddingResult)) {
      return {
        intentResult: embeddingResult,
        layer: 3,
        layerName: 'embedding',
        latencyMs: Date.now() - startTime,
        isReliable: true,
      };
    }

    // Layer 4: Regex
    const regexResult = detectIntentByPattern(input.question);
    if (regexResult && isReliableIntent(regexResult)) {
      return {
        intentResult: regexResult,
        layer: 4,
        layerName: 'regex',
        latencyMs: Date.now() - startTime,
        isReliable: true,
      };
    }

    // Layer 5: Context
    const contextResult = detectIntentByContext(input.transcript, input.assistantResponseCount);
    return {
      intentResult: contextResult,
      layer: 5,
      layerName: 'context',
      latencyMs: Date.now() - startTime,
      isReliable: isReliableIntent(contextResult),
    };
  }
}

/**
 * Convenience function for one-off routing.
 */
export async function routeIntent(input: LayeredRouterInput): Promise<LayeredRouterDecision> {
  return LayeredIntentRouter.getInstance().route(input);
}
