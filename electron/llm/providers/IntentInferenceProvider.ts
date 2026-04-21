import type { IntentResult } from '../IntentClassifier';

export type IntentProviderErrorType =
  | 'unavailable'
  | 'model_not_ready'
  | 'unsupported_locale'
  | 'rate_limited'
  | 'refusal'
  | 'timeout'
  | 'invalid_response'
  | 'unknown';

export interface IntentClassificationInput {
  lastInterviewerTurn: string | null;
  preparedTranscript: string;
  assistantResponseCount: number;
  transcriptRevision?: number;
  /** NAT-XXX: Optional trace ID for correlation with STT/transcript events */
  traceId?: string;
}

export interface IntentProviderError extends Error {
  code: IntentProviderErrorType;
}

export interface IntentInferenceProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  classify(input: IntentClassificationInput): Promise<IntentResult>;
}

export function createIntentProviderError(code: IntentProviderErrorType, message: string): IntentProviderError {
  const error = new Error(message) as IntentProviderError;
  error.name = 'IntentProviderError';
  error.code = code;
  return error;
}

export function getIntentProviderErrorCode(error: unknown): IntentProviderErrorType {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === 'unavailable'
      || code === 'model_not_ready'
      || code === 'unsupported_locale'
      || code === 'rate_limited'
      || code === 'refusal'
      || code === 'timeout'
      || code === 'invalid_response'
      || code === 'unknown'
    ) {
      return code;
    }
  }

  return 'unknown';
}
