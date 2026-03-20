import type { AppState } from '../main';
import type { SafeHandle } from './registerTypes';

type RegisterIntelligenceHandlersDeps = {
  appState: AppState;
  safeHandle: SafeHandle;
};

export function registerIntelligenceHandlers({ appState, safeHandle }: RegisterIntelligenceHandlersDeps): void {
  safeHandle('generate-assist', async () => {
    const intelligenceManager = appState.getIntelligenceManager();
    const insight = await intelligenceManager.runAssistMode();
    return { insight };
  });

  safeHandle('generate-what-to-say', async (_event, question?: string, imagePaths?: string[]) => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const answer = await intelligenceManager.runWhatShouldISay(question, 0.8, imagePaths);
      return { answer, question: question || 'inferred from context' };
    } catch {
      return { question: question || 'unknown' };
    }
  });

  safeHandle('generate-follow-up', async (_event, intent: string, userRequest?: string) => {
    const intelligenceManager = appState.getIntelligenceManager();
    const refined = await intelligenceManager.runFollowUp(intent, userRequest);
    return { refined, intent };
  });

  safeHandle('generate-recap', async () => {
    const intelligenceManager = appState.getIntelligenceManager();
    const summary = await intelligenceManager.runRecap();
    return { summary };
  });

  safeHandle('generate-follow-up-questions', async () => {
    const intelligenceManager = appState.getIntelligenceManager();
    const questions = await intelligenceManager.runFollowUpQuestions();
    return { questions };
  });

  safeHandle('submit-manual-question', async (_event, question: string) => {
    const intelligenceManager = appState.getIntelligenceManager();
    const answer = await intelligenceManager.runManualAnswer(question);
    return { answer, question };
  });

  safeHandle('get-intelligence-context', async () => {
    const intelligenceManager = appState.getIntelligenceManager();
    return {
      context: intelligenceManager.getFormattedContext(),
      lastAssistantMessage: intelligenceManager.getLastAssistantMessage(),
      activeMode: intelligenceManager.getActiveMode(),
    };
  });

  safeHandle('reset-intelligence', async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      intelligenceManager.reset();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
