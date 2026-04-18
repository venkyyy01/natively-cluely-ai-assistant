import type { IntentResult } from '../IntentClassifier';
import {
  getIntentProviderErrorCode,
  type IntentClassificationInput,
  type IntentInferenceProvider,
  type IntentProviderErrorType,
} from './IntentInferenceProvider';

export interface CoordinatedIntentResult extends IntentResult {
  provider: string;
  retryCount: number;
  fallbackReason?: 'primary_unavailable' | 'primary_retries_exhausted' | 'primary_failed';
}

export interface IntentClassificationCoordinatorOptions {
  maxPrimaryRetries?: number;
  baseBackoffMs?: number;
  jitterMs?: number;
  delayFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
}

const DEFAULT_MAX_PRIMARY_RETRIES = 2;
const DEFAULT_BASE_BACKOFF_MS = 100;
const DEFAULT_JITTER_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(code: IntentProviderErrorType): boolean {
  return code === 'rate_limited' || code === 'timeout' || code === 'refusal' || code === 'unknown';
}

export class IntentClassificationCoordinator {
  private readonly maxPrimaryRetries: number;
  private readonly baseBackoffMs: number;
  private readonly jitterMs: number;
  private readonly delayFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;

  constructor(
    private readonly primary: IntentInferenceProvider,
    private readonly fallback: IntentInferenceProvider,
    options: IntentClassificationCoordinatorOptions = {},
  ) {
    this.maxPrimaryRetries = options.maxPrimaryRetries ?? DEFAULT_MAX_PRIMARY_RETRIES;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
    this.delayFn = options.delayFn ?? sleep;
    this.randomFn = options.randomFn ?? Math.random;
  }

  async classify(input: IntentClassificationInput): Promise<CoordinatedIntentResult> {
    const primaryAvailable = await this.primary.isAvailable();
    if (primaryAvailable) {
      let retries = 0;
      while (true) {
        try {
          const result = await this.primary.classify(input);
          return {
            ...result,
            provider: this.primary.name,
            retryCount: retries,
          };
        } catch (error) {
          const code = getIntentProviderErrorCode(error);
          const retryable = isRetryableError(code);
          if (!retryable || retries >= this.maxPrimaryRetries) {
            const fallbackResult = await this.fallback.classify(input);
            return {
              ...fallbackResult,
              provider: this.fallback.name,
              retryCount: retries,
              fallbackReason: retryable
                ? 'primary_retries_exhausted'
                : code === 'unavailable'
                  ? 'primary_unavailable'
                  : 'primary_failed',
            };
          }

          retries += 1;
          const base = this.baseBackoffMs * Math.pow(2, retries);
          const jitter = this.jitterMs > 0 ? Math.floor(this.randomFn() * this.jitterMs) : 0;
          await this.delayFn(base + jitter);
        }
      }
    }

    const fallbackResult = await this.fallback.classify(input);
    return {
      ...fallbackResult,
      provider: this.fallback.name,
      retryCount: 0,
      fallbackReason: 'primary_unavailable',
    };
  }
}
