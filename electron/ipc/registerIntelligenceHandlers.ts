import type { AppState } from '../main';
import type { SafeHandle } from './registerTypes';

type RegisterIntelligenceHandlersDeps = {
  appState: AppState;
  safeHandle: SafeHandle;
};

type RuntimeCoordinatorLike = {
  getSupervisor?: (name: string) => unknown;
};

type InferenceSupervisorLike = {
  runAssistMode?: () => Promise<string | null>;
  runWhatShouldISay?: (question?: string, confidence?: number, imagePaths?: string[]) => Promise<string | null>;
  runFollowUp?: (intent: string, userRequest?: string) => Promise<string | null>;
  runRecap?: () => Promise<string | null>;
  runFollowUpQuestions?: () => Promise<string[] | string | null>;
  runManualAnswer?: (question: string) => Promise<string | null>;
  getFormattedContext?: (lastSeconds?: number) => string;
  getLastAssistantMessage?: () => string | null;
  getActiveMode?: () => unknown;
  reset?: () => Promise<void>;
};

function getInferenceSupervisor(appState: AppState): InferenceSupervisorLike | null {
  if (!('getCoordinator' in appState) || typeof appState.getCoordinator !== 'function') {
    return null;
  }

  const coordinator = appState.getCoordinator() as RuntimeCoordinatorLike;
  if (typeof coordinator.getSupervisor !== 'function') {
    return null;
  }

  return coordinator.getSupervisor('inference') as InferenceSupervisorLike;
}

function getIntelligenceFacade(appState: AppState): InferenceSupervisorLike {
  const supervisor = getInferenceSupervisor(appState);
  if (supervisor) {
    return supervisor;
  }

  return appState.getIntelligenceManager();
}

export function registerIntelligenceHandlers({ appState, safeHandle }: RegisterIntelligenceHandlersDeps): void {
  safeHandle('generate-assist', async () => {
    const insight = await getIntelligenceFacade(appState).runAssistMode?.();
    return { insight };
  });

  safeHandle('generate-what-to-say', async (_event, question?: string, imagePaths?: string[]) => {
    const resolvedQuestion = question || 'inferred from context';

    try {
      const answer = await getIntelligenceFacade(appState).runWhatShouldISay?.(question, 0.8, imagePaths);
      if (!answer) {
        return {
          answer: null,
          question: resolvedQuestion,
          status: 'canceled' as const,
          error: 'Request canceled before completion.',
        };
      }

      return {
        answer,
        question: resolvedQuestion,
        status: 'completed' as const,
      };
    } catch (error) {
      return {
        answer: null,
        question: resolvedQuestion,
        status: 'error' as const,
        error: error instanceof Error ? error.message : 'Failed to generate response.',
      };
    }
  });

  safeHandle('generate-follow-up', async (_event, intent: string, userRequest?: string) => {
    const refined = await getIntelligenceFacade(appState).runFollowUp?.(intent, userRequest);
    return { refined, intent };
  });

  safeHandle('generate-recap', async () => {
    const summary = await getIntelligenceFacade(appState).runRecap?.();
    return { summary };
  });

  safeHandle('generate-follow-up-questions', async () => {
    const questions = await getIntelligenceFacade(appState).runFollowUpQuestions?.();
    return { questions };
  });

  safeHandle('submit-manual-question', async (_event, question: string) => {
    const answer = await getIntelligenceFacade(appState).runManualAnswer?.(question);
    return { answer, question };
  });

  safeHandle('get-intelligence-context', async () => {
    const intelligence = getIntelligenceFacade(appState);
    return {
      context: intelligence.getFormattedContext?.(),
      lastAssistantMessage: intelligence.getLastAssistantMessage?.(),
      activeMode: intelligence.getActiveMode?.(),
    };
  });

  safeHandle('reset-intelligence', async () => {
    try {
      await getIntelligenceFacade(appState).reset?.();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
