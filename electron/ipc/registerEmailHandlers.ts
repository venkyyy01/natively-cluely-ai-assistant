import { shell } from 'electron';
import type { AppState } from '../main';
import { ipcSchemas, parseIpcInput } from '../ipcValidation';
import type { SafeHandleValidated } from './registerTypes';

type RegisterEmailHandlersDeps = {
  appState: AppState;
  safeHandleValidated: SafeHandleValidated;
};

type RuntimeCoordinatorLike = {
  getSupervisor?: (name: string) => unknown;
};

type InferenceSupervisorLike = {
  getLLMHelper?: () => {
    chatWithGemini: (
      message: string,
      imagePaths?: string[],
      context?: string,
      skipSystemPrompt?: boolean,
      groqPrompt?: string,
    ) => Promise<string>;
  } | null;
};

function getInferenceLlmHelper(appState: AppState): {
  chatWithGemini: (
    message: string,
    imagePaths?: string[],
    context?: string,
    skipSystemPrompt?: boolean,
    groqPrompt?: string,
  ) => Promise<string>;
} {
  if (typeof appState.isStealthContainmentActive === 'function' && appState.isStealthContainmentActive()) {
    throw new Error('CONTAINMENT_ACTIVE');
  }

  const coordinator = ('getCoordinator' in appState && typeof appState.getCoordinator === 'function')
    ? (appState.getCoordinator() as RuntimeCoordinatorLike)
    : null;

  if (typeof coordinator?.getSupervisor === 'function') {
    const supervisor = coordinator.getSupervisor('inference') as InferenceSupervisorLike;
    const llmHelper = supervisor?.getLLMHelper?.();
    if (llmHelper) {
      return llmHelper;
    }
  }

  return appState.processingHelper.getLLMHelper();
}

export function registerEmailHandlers({ appState, safeHandleValidated }: RegisterEmailHandlersDeps): void {
  safeHandleValidated('generate-followup-email', (args) => [parseIpcInput(ipcSchemas.followUpEmailInput, args[0], 'generate-followup-email')] as const, async (_event, input) => {
    const { FOLLOWUP_EMAIL_PROMPT, GROQ_FOLLOWUP_EMAIL_PROMPT } = require('../llm/prompts');
    const { buildFollowUpEmailPromptInput } = require('../utils/emailUtils');
    const llmHelper = getInferenceLlmHelper(appState);
    const contextString = buildFollowUpEmailPromptInput(input);
    const geminiPrompt = `${FOLLOWUP_EMAIL_PROMPT}\n\nMEETING DETAILS:\n${contextString}`;
    const groqPrompt = `${GROQ_FOLLOWUP_EMAIL_PROMPT}\n\nMEETING DETAILS:\n${contextString}`;
    return llmHelper.chatWithGemini(geminiPrompt, undefined, undefined, true, groqPrompt);
  });

  safeHandleValidated('extract-emails-from-transcript', (args) => [parseIpcInput(ipcSchemas.transcriptEntries, args[0], 'extract-emails-from-transcript')] as const, async (_event, transcript) => {
    const { extractEmailsFromTranscript } = require('../utils/emailUtils');
    return extractEmailsFromTranscript(transcript);
  });

  safeHandleValidated('open-mailto', (args) => [parseIpcInput(ipcSchemas.openMailtoInput, args[0], 'open-mailto')] as const, async (_event, { to, subject, body }) => {
    try {
      const { buildMailtoLink } = require('../utils/emailUtils');
      const mailtoUrl = buildMailtoLink(to, subject, body);
      await shell.openExternal(mailtoUrl);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
