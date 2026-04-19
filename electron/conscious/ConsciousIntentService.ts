import type { IntentResult } from '../llm/IntentClassifier';
import type { CoordinatedIntentResult } from '../llm/providers/IntentClassificationCoordinator';

const STRONG_CONSCIOUS_INTENTS = new Set<IntentResult['intent']>([
  'behavioral',
  'coding',
  'deep_dive',
]);

const STRONG_CONSCIOUS_INTENT_CONFIDENCE = 0.84;
const MIN_RELIABLE_CONSCIOUS_INTENT_CONFIDENCE = 0.72;

export function isStrongConsciousIntent(intentResult?: IntentResult | null): boolean {
  return Boolean(
    intentResult
    && STRONG_CONSCIOUS_INTENTS.has(intentResult.intent)
    && intentResult.confidence >= STRONG_CONSCIOUS_INTENT_CONFIDENCE,
  );
}

export function isUncertainConsciousIntent(intentResult?: IntentResult | null): boolean {
  if (!intentResult) {
    return true;
  }

  if (intentResult.intent === 'general') {
    return true;
  }

  return intentResult.confidence < MIN_RELIABLE_CONSCIOUS_INTENT_CONFIDENCE;
}

export interface ResolvedIntentResult extends IntentResult {
  reason?: string;
}

export interface ConsciousIntentResolution {
  intentResult: ResolvedIntentResult;
  totalContextAssemblyMs: number;
  timedOut: boolean;
}

export class ConsciousIntentService {
  async resolve(input: {
    lastInterviewerTurn: string | null;
    preparedTranscript: string;
    assistantResponseCount: number;
    startedAt: number;
    hardBudgetMs: number;
    isLikelyGeneralIntent: boolean;
    classifyIntent: (
      lastInterviewerTurn: string | null,
      preparedTranscript: string,
      assistantResponseCount: number,
    ) => Promise<IntentResult>;
    prefetchedIntent?: CoordinatedIntentResult | null;
  }): Promise<ConsciousIntentResolution> {
    if (input.prefetchedIntent) {
      return {
        intentResult: input.prefetchedIntent,
        totalContextAssemblyMs: Date.now() - input.startedAt,
        timedOut: false,
      };
    }

    let intentResult: ResolvedIntentResult = {
      intent: 'general',
      confidence: 0,
      answerShape: '',
      reason: 'context_assembly_timeout',
    };
    let timedOut = false;

    const contextAssemblyElapsed = Date.now() - input.startedAt;
    if (contextAssemblyElapsed < input.hardBudgetMs) {
      try {
        if (!input.isLikelyGeneralIntent) {
          intentResult = await Promise.race([
            input.classifyIntent(
              input.lastInterviewerTurn,
              input.preparedTranscript,
              input.assistantResponseCount,
            ),
            new Promise<ResolvedIntentResult>((_, reject) => {
              setTimeout(
                () => reject(new Error('intent classification timeout')),
                Math.max(30, input.hardBudgetMs - contextAssemblyElapsed),
              );
            }),
          ]);
        }
      } catch {
        timedOut = true;
        intentResult = {
          intent: 'general',
          confidence: 0,
          answerShape: '',
          reason: 'context_timeout',
        };
      }
    } else {
      timedOut = true;
    }

    return {
      intentResult,
      totalContextAssemblyMs: Date.now() - input.startedAt,
      timedOut,
    };
  }
}
