import type { IntentResult } from '../IntentClassifier';
import { classifyIntent } from '../IntentClassifier';
import type { IntentClassificationInput, IntentInferenceProvider } from './IntentInferenceProvider';

export class LegacyIntentProvider implements IntentInferenceProvider {
  readonly name = 'legacy';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async classify(input: IntentClassificationInput): Promise<IntentResult> {
    return classifyIntent(
      input.lastInterviewerTurn,
      input.preparedTranscript,
      input.assistantResponseCount,
    );
  }
}
