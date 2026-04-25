// electron/llm/providers/SetFitIntentProvider.ts
// SetFit-based few-shot intent classifier.
// Replaces the generic SLM (Xenova/nli-deberta-v3-small) as the primary
// fast classifier in the intent routing pipeline.
//
// Architecture:
//   SetFit (this) → 10-30ms, few-shot trained on interview intents
//   Foundation Model → 2-3s, fallback for ambiguous/complex cases
//
// SetFit models are sentence-transformer based classifiers fine-tuned on
// a small number of labeled examples per class. They typically outperform
// zero-shot SLMs on domain-specific tasks.

import type { ConversationIntent, IntentResult } from '../IntentClassifier';
import { getAnswerShapeGuidance, SLM_LABEL_MAP } from '../IntentClassifier';
import { isElectronAppPackaged, resolveBundledModelsPath } from '../../utils/modelPaths';
import { loadTransformers } from '../../utils/transformersLoader';
import {
  createIntentProviderError,
  type IntentClassificationInput,
  type IntentInferenceProvider,
} from './IntentInferenceProvider';
import { traceLogger } from '../../tracing';

export interface SetFitIntentProviderOptions {
  /** Model ID or local path. Defaults to bundled SetFit model if available. */
  modelName?: string;
  /** Minimum confidence to accept a classification. Below this, the provider
   *  will throw 'invalid_response' so the coordinator falls back to foundation. */
  minConfidence?: number;
  /** Timeout for a single inference call. */
  inferenceTimeoutMs?: number;
  /** Whether to use quantized model (faster, slightly less accurate). */
  quantized?: boolean;
}

const DEFAULT_MIN_CONFIDENCE = 0.65;
const DEFAULT_INFERENCE_TIMEOUT_MS = 80;
const SETFIT_MODEL_PATH = 'setfit-intent-v1';

export class SetFitIntentProvider implements IntentInferenceProvider {
  readonly name = 'setfit';

  private pipe: any = null;
  private loadingPromise: Promise<void> | null = null;
  private loadFailed = false;
  private modelName: string;
  private minConfidence: number;
  private inferenceTimeoutMs: number;
  private quantized: boolean;

  constructor(options: SetFitIntentProviderOptions = {}) {
    this.modelName = options.modelName ?? SETFIT_MODEL_PATH;
    this.minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.inferenceTimeoutMs = options.inferenceTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS;
    this.quantized = options.quantized ?? true;
  }

  async isAvailable(): Promise<boolean> {
    // If already loaded successfully, we're available
    if (this.pipe) {
      return true;
    }
    // If load already failed, don't retry in this session
    if (this.loadFailed) {
      return false;
    }
    // Try to warm up / check if model exists
    try {
      await this.ensureLoaded();
      return this.pipe !== null;
    } catch {
      return false;
    }
  }

  async classify(input: IntentClassificationInput): Promise<IntentResult> {
    await this.ensureLoaded();
    if (!this.pipe) {
      throw createIntentProviderError('model_not_ready', 'SetFit model not loaded');
    }

    const question = input.lastInterviewerTurn?.trim();
    if (!question) {
      throw createIntentProviderError('invalid_response', 'Empty question for SetFit classification');
    }

    const traceId = input.traceId;
    const modelStartTime = Date.now();
    const spanId = traceId ? `setfit-${modelStartTime}` : undefined;

    try {
      // Run inference with timeout
      const result = await this.runInferenceWithTimeout(question);
      const modelLatencyMs = Date.now() - modelStartTime;

      const top = Array.isArray(result) ? result[0] : result;
      if (!top || typeof top.label !== 'string' || typeof top.score !== 'number') {
        throw createIntentProviderError('invalid_response', 'SetFit returned malformed output');
      }

      const resolvedIntent = SLM_LABEL_MAP[top.label] || 'general';
      const confidence = top.score;

      // NAT-XXX: Trace SetFit invocation
      if (traceId) {
        traceLogger.logModelInvocation(traceId, spanId, {
          modelName: this.name,
          modelVersion: this.modelName,
          latencyMs: modelLatencyMs,
          inputTokens: question.length / 4,
        });
      }

      // If confidence is below threshold, treat as uncertain and let coordinator
      // fall back to foundation model
      if (confidence < this.minConfidence) {
        console.log(
          `[SetFitIntentProvider] Low confidence ${(confidence * 100).toFixed(1)}% ` +
          `for "${resolvedIntent}" — delegating to foundation model`
        );
        throw createIntentProviderError(
          'invalid_response',
          `SetFit confidence ${confidence.toFixed(3)} below threshold ${this.minConfidence}`
        );
      }

      console.log(
        `[SetFitIntentProvider] Classified as "${resolvedIntent}" ` +
        `(${confidence.toFixed(3)}) in ${modelLatencyMs}ms: "${question.substring(0, 60)}..."`
      );

      return {
        intent: resolvedIntent,
        confidence,
        answerShape: getAnswerShapeGuidance(resolvedIntent),
        latencyMs: modelLatencyMs,
      };
    } catch (error) {
      // NAT-XXX: Log SetFit error
      if (traceId) {
        traceLogger.logModelInvocation(traceId, spanId, {
          modelName: this.name,
          modelVersion: this.modelName,
          latencyMs: Date.now() - modelStartTime,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private async runInferenceWithTimeout(text: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(createIntentProviderError('timeout', `SetFit inference timed out after ${this.inferenceTimeoutMs}ms`));
      }, this.inferenceTimeoutMs);

      this.pipe(text, { top_k: 3 })
        .then((result: unknown) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.pipe) return;
    if (this.loadFailed) return;

    if (this.loadingPromise) {
      await this.loadingPromise;
      return;
    }

    this.loadingPromise = (async (): Promise<void> => {
      try {
        const { pipeline, env } = await loadTransformers();

        env.allowRemoteModels = false;
        env.localModelPath = resolveBundledModelsPath();

        // Try the SetFit model first, fall back to the generic SLM if not found
        const modelsToTry = [this.modelName, 'Xenova/nli-deberta-v3-small'];
        let lastError: unknown;

        for (const model of modelsToTry) {
          try {
            console.log(`[SetFitIntentProvider] Loading model: ${model}...`);
            this.pipe = await pipeline(
              'text-classification',
              model,
              {
                local_files_only: isElectronAppPackaged(),
                quantized: this.quantized,
              }
            );
            console.log(`[SetFitIntentProvider] Model loaded successfully: ${model}`);
            return;
          } catch (e) {
            lastError = e;
            console.warn(`[SetFitIntentProvider] Failed to load ${model}:`, e);
          }
        }

        // All models failed
        throw lastError;
      } catch (e) {
        console.warn('[SetFitIntentProvider] All model loading attempts failed:', e);
        this.loadFailed = true;
        this.pipe = null;
      }
    })();

    try {
      await this.loadingPromise;
    } catch {
      this.loadingPromise = null;
    }
  }

  warmup(): void {
    this.ensureLoaded().catch(() => {});
  }
}
