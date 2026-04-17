import type { AppState } from '../main';
import { ipcSchemas, parseIpcInput } from '../ipcValidation';
import type { SafeHandle, SafeHandleValidated } from './registerTypes';

type RegisterIntelligenceHandlersDeps = {
  appState: AppState;
  safeHandle: SafeHandle;
  safeHandleValidated: SafeHandleValidated;
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

export function registerIntelligenceHandlers({ appState, safeHandle, safeHandleValidated }: RegisterIntelligenceHandlersDeps): void {
  safeHandle('generate-assist', async () => {
    const insight = await getIntelligenceFacade(appState).runAssistMode?.();
    return { insight };
  });

  safeHandleValidated('generate-what-to-say', (args) => {
    const question = typeof args[0] === 'undefined'
      ? undefined
      : parseIpcInput(ipcSchemas.intelligenceQuestion, args[0], 'generate-what-to-say');
    const imagePaths = typeof args[1] === 'undefined'
      ? undefined
      : parseIpcInput(ipcSchemas.intelligenceImagePaths, args[1], 'generate-what-to-say');
    return [question, imagePaths] as const;
  }, async (_event, question?: string, imagePaths?: string[]) => {
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

  safeHandleValidated('generate-follow-up', (args) => {
    const intent = parseIpcInput(ipcSchemas.intelligenceFollowUpIntent, args[0], 'generate-follow-up');
    const userRequest = typeof args[1] === 'undefined'
      ? undefined
      : parseIpcInput(ipcSchemas.intelligenceFollowUpUserRequest, args[1], 'generate-follow-up');
    return [intent, userRequest] as const;
  }, async (_event, intent: string, userRequest?: string) => {
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

  safeHandleValidated('submit-manual-question', (args) => [parseIpcInput(ipcSchemas.intelligenceManualQuestion, args[0], 'submit-manual-question')] as const, async (_event, question: string) => {
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
