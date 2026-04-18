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
  fallbackReason?: 'primary_unavailable' | 'primary_retries_exhausted' | 'primary_failed' | 'primary_low_confidence' | 'primary_contradiction';
}

export interface IntentClassificationCoordinatorOptions {
  maxPrimaryRetries?: number;
  baseBackoffMs?: number;
  jitterMs?: number;
  minimumPrimaryConfidence?: number;
  contradictionDeltaConfidence?: number;
  delayFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
}

const DEFAULT_MAX_PRIMARY_RETRIES = 2;
const DEFAULT_BASE_BACKOFF_MS = 100;
const DEFAULT_JITTER_MS = 50;
const DEFAULT_MINIMUM_PRIMARY_CONFIDENCE = 0.82;
const DEFAULT_CONTRADICTION_DELTA_CONFIDENCE = 0.18;

const FOLLOW_UP_CUES = [
  'what happened next',
  'then what',
  'after that',
  'next',
];

const SUMMARY_PROBE_CUES = [
  'so you are saying',
  "so you're saying",
  'let me make sure',
  'to summarize',
  'so to summarize',
  'if i understand correctly',
  'correct me if i am wrong',
  'correct me if i\'m wrong',
];

const EXAMPLE_REQUEST_CUES = [
  'concrete example',
  'specific example',
  'for example',
  'for instance',
  'specific instance',
];

const CLARIFICATION_CUES = [
  'clarify',
  'what do you mean',
  'can you explain',
  'can you unpack',
  'unpack',
  'how so',
];

const BEHAVIORAL_CUES = [
  'tell me about a time',
  'describe a time',
  'describe a situation',
  'walk me through a failure',
  'stakeholder',
  'leadership',
  'influence',
  'conflict with',
  'disagreed',
];

const CODING_CUES = [
  'implement',
  'write code',
  'debug',
  'algorithm',
  'lru',
  'typescript',
  'javascript',
  'api payload',
  'handler code',
  'function',
  'refactor',
  'snippet',
];

const DEEP_DIVE_CUES = [
  'tradeoff',
  'trade-off',
  'why would you choose',
  'why choose',
  'why not',
  'compare',
  'consistency',
  'availability',
  'latency',
  'freshness',
  'throughput',
];

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
  private readonly minimumPrimaryConfidence: number;
  private readonly contradictionDeltaConfidence: number;
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
    this.minimumPrimaryConfidence = options.minimumPrimaryConfidence ?? DEFAULT_MINIMUM_PRIMARY_CONFIDENCE;
    this.contradictionDeltaConfidence = options.contradictionDeltaConfidence ?? DEFAULT_CONTRADICTION_DELTA_CONFIDENCE;
    this.delayFn = options.delayFn ?? sleep;
    this.randomFn = options.randomFn ?? Math.random;
  }

  private normalizeText(value: string | null): string {
    return (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private includesAnyCue(text: string, cues: readonly string[]): boolean {
    return cues.some((cue) => text.includes(cue));
  }

  private inferLikelyIntentFromQuestion(input: IntentClassificationInput): IntentResult['intent'] | null {
    const questionText = this.normalizeText(input.lastInterviewerTurn);
    if (!questionText) {
      return null;
    }

    if (this.includesAnyCue(questionText, CODING_CUES)) {
      return 'coding';
    }

    if (this.includesAnyCue(questionText, SUMMARY_PROBE_CUES)) {
      return 'summary_probe';
    }

    if (this.includesAnyCue(questionText, FOLLOW_UP_CUES)) {
      return 'follow_up';
    }

    if (this.includesAnyCue(questionText, CLARIFICATION_CUES)) {
      return 'clarification';
    }

    const codingAndExample = this.includesAnyCue(questionText, EXAMPLE_REQUEST_CUES) && this.includesAnyCue(questionText, CODING_CUES);
    if (codingAndExample) {
      return 'coding';
    }

    if (this.includesAnyCue(questionText, EXAMPLE_REQUEST_CUES)) {
      return 'example_request';
    }

    if (this.includesAnyCue(questionText, DEEP_DIVE_CUES)) {
      return 'deep_dive';
    }

    if (this.includesAnyCue(questionText, BEHAVIORAL_CUES)) {
      return 'behavioral';
    }

    return null;
  }

  private hasStrongCueForLikelyIntent(
    input: IntentClassificationInput,
    likelyIntent: IntentResult['intent'],
  ): boolean {
    const questionText = this.normalizeText(input.lastInterviewerTurn);
    if (!questionText) {
      return false;
    }

    switch (likelyIntent) {
      case 'follow_up':
        return this.includesAnyCue(questionText, FOLLOW_UP_CUES);
      case 'summary_probe':
        return this.includesAnyCue(questionText, SUMMARY_PROBE_CUES);
      case 'clarification':
        return this.includesAnyCue(questionText, CLARIFICATION_CUES);
      case 'example_request':
        return this.includesAnyCue(questionText, EXAMPLE_REQUEST_CUES);
      case 'deep_dive':
        return this.includesAnyCue(questionText, DEEP_DIVE_CUES);
      case 'coding':
        return this.includesAnyCue(questionText, CODING_CUES);
      case 'behavioral':
        return this.includesAnyCue(questionText, [
          'tell me about a time',
          'describe a time',
          'describe a situation',
          'walk me through a failure',
        ]);
      default:
        return false;
    }
  }

  private isLowConfidence(result: IntentResult): boolean {
    return result.confidence < this.minimumPrimaryConfidence;
  }

  private isContradiction(
    likelyIntent: IntentResult['intent'],
    strongLikelyCue: boolean,
    primary: IntentResult,
    fallback: IntentResult,
  ): boolean {
    const primaryMatchesLikely = primary.intent === likelyIntent;
    const fallbackMatchesLikely = fallback.intent === likelyIntent;
    const confidenceGap = fallback.confidence - primary.confidence;

    return !primaryMatchesLikely
      && fallbackMatchesLikely
      && (strongLikelyCue || confidenceGap >= this.contradictionDeltaConfidence);
  }

  private createFallbackResult(
    result: IntentResult,
    retryCount: number,
    reason: CoordinatedIntentResult['fallbackReason'],
  ): CoordinatedIntentResult {
    return {
      ...result,
      provider: this.fallback.name,
      retryCount,
      fallbackReason: reason,
    };
  }

  private resolveLowConfidenceDecision(
    input: IntentClassificationInput,
    primary: IntentResult,
    fallback: IntentResult,
    retryCount: number,
  ): CoordinatedIntentResult {
    const likelyIntent = this.inferLikelyIntentFromQuestion(input);
    if (likelyIntent) {
      const strongLikelyCue = this.hasStrongCueForLikelyIntent(input, likelyIntent);
      const primaryMatchesLikely = primary.intent === likelyIntent;
      const fallbackMatchesLikely = fallback.intent === likelyIntent;

      const primaryGeneralFallback = likelyIntent === 'general'
        && primary.intent !== 'general'
        && fallback.intent === 'general';
      if (primaryGeneralFallback) {
        return {
          ...primary,
          provider: this.primary.name,
          retryCount,
        };
      }

      if (primaryMatchesLikely && !fallbackMatchesLikely) {
        return {
          ...primary,
          provider: this.primary.name,
          retryCount,
        };
      }

      if (fallbackMatchesLikely && !primaryMatchesLikely) {
        if (strongLikelyCue || (fallback.confidence - primary.confidence) >= this.contradictionDeltaConfidence) {
          return this.createFallbackResult(fallback, retryCount, 'primary_contradiction');
        }
      }
    }

    return this.createFallbackResult(fallback, retryCount, 'primary_low_confidence');
  }

  private async classifyWithFallback(input: IntentClassificationInput): Promise<IntentResult> {
    return this.fallback.classify(input);
  }

  async classify(input: IntentClassificationInput): Promise<CoordinatedIntentResult> {
    const primaryAvailable = await this.primary.isAvailable();
    if (primaryAvailable) {
      let retries = 0;
      while (true) {
        try {
          const result = await this.primary.classify(input);
          if (this.isLowConfidence(result)) {
            const fallbackResult = await this.classifyWithFallback(input);
            return this.resolveLowConfidenceDecision(input, result, fallbackResult, retries);
          }

          const likelyIntent = this.inferLikelyIntentFromQuestion(input);
          if (likelyIntent && result.intent !== likelyIntent) {
            const strongLikelyCue = this.hasStrongCueForLikelyIntent(input, likelyIntent);
            const fallbackResult = await this.classifyWithFallback(input);
            if (this.isContradiction(likelyIntent, strongLikelyCue, result, fallbackResult)) {
              return this.createFallbackResult(fallbackResult, retries, 'primary_contradiction');
            }
          }

          return {
            ...result,
            provider: this.primary.name,
            retryCount: retries,
          };
        } catch (error) {
          const code = getIntentProviderErrorCode(error);
          const retryable = isRetryableError(code);
          if (!retryable || retries >= this.maxPrimaryRetries) {
            const fallbackResult = await this.classifyWithFallback(input);
            return this.createFallbackResult(
              fallbackResult,
              retries,
              retryable
                ? 'primary_retries_exhausted'
                : code === 'unavailable'
                  ? 'primary_unavailable'
                  : 'primary_failed',
            );
          }

          retries += 1;
          const base = this.baseBackoffMs * Math.pow(2, retries);
          const jitter = this.jitterMs > 0 ? Math.floor(this.randomFn() * this.jitterMs) : 0;
          await this.delayFn(base + jitter);
        }
      }
    }

    const fallbackResult = await this.classifyWithFallback(input);
    return this.createFallbackResult(fallbackResult, 0, 'primary_unavailable');
  }
}
