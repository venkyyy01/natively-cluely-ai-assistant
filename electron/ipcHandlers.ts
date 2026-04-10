// ipcHandlers.ts

import { app, ipcMain, shell, dialog, desktopCapturer, systemPreferences, BrowserWindow, screen } from "electron"
import { AppState } from "./main"
import { GEMINI_FLASH_MODEL } from "./IntelligenceManager"
import { DatabaseManager } from "./db/DatabaseManager"; // Import Database Manager
import * as path from "path";
import * as fs from "fs";
import { ipcSchemas, parseIpcInput } from "./ipcValidation";
import { registerMeetingHandlers } from "./ipc/registerMeetingHandlers";
import { registerSettingsHandlers } from "./ipc/registerSettingsHandlers";
import { registerCalendarHandlers } from "./ipc/registerCalendarHandlers";
import { registerRagHandlers } from "./ipc/registerRagHandlers";
import { registerEmailHandlers } from "./ipc/registerEmailHandlers";
import { registerProfileHandlers } from "./ipc/registerProfileHandlers";
import { registerIntelligenceHandlers } from "./ipc/registerIntelligenceHandlers";
import { registerWindowHandlers } from "./ipc/registerWindowHandlers";

type ScreenshotFacadeLike = {
  deleteScreenshot?: (path: string) => Promise<{ success: boolean; error?: string }>;
  takeScreenshot?: () => Promise<string>;
  takeSelectiveScreenshot?: () => Promise<string>;
  getImagePreview?: (filepath: string) => Promise<string>;
  getView?: () => 'queue' | 'solutions';
  getScreenshotQueue?: () => string[];
  getExtraScreenshotQueue?: () => string[];
  clearQueues?: () => void;
};

type RuntimeCoordinatorLike = {
  getSupervisor?: (name: string) => unknown;
};

type SttSupervisorLike = {
  reconfigureProvider?: () => Promise<void> | void;
  updateGoogleCredentials?: (keyPath: string) => Promise<void> | void;
  finalizeMicrophone?: () => Promise<void> | void;
};

type IntelligenceManagerLike = {
  addTranscript: (entry: { text: string; speaker: string; timestamp: number; final: boolean }, skipRefinementCheck?: boolean) => void;
  addAssistantMessage: (message: string) => void;
  getLastAssistantMessage: () => string | null;
  getFormattedContext: (lastSeconds?: number) => string;
  logUsage: (type: string, input: string, output: string) => void;
  initializeLLMs: () => void | Promise<void>;
};

type InferenceSupervisorLike = {
  getLLMHelper?: () => unknown;
  getIntelligenceManager?: () => unknown;
  initializeLLMs?: () => Promise<void> | void;
};

type WindowFacadeLike = {
  showModelSelectorWindow?: (x: number, y: number) => void;
  hideModelSelectorWindow?: () => void;
  toggleModelSelectorWindow?: (x: number, y: number) => void;
};

type SettingsFacadeLike = {
  getThemeMode?: () => string;
  getResolvedTheme?: () => string;
  setThemeMode?: (mode: string) => void;
};

type AudioFacadeLike = {
  getNativeAudioStatus?: () => unknown;
};

export function initializeIpcHandlers(appState: AppState): void {
  const safeHandle = (channel: string, listener: (event: any, ...args: any[]) => Promise<any> | any) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, listener);
  };

  const safeHandleValidated = <T extends unknown[]>(
    channel: string,
    parser: (args: unknown[]) => T,
    listener: (event: any, ...args: T) => Promise<any> | any,
  ) => {
    safeHandle(channel, (event, ...args) => listener(event, ...parser(args)));
  };

  const ok = <T>(data: T) => ({ success: true as const, data });
  const fail = (code: string, error: unknown, fallbackMessage: string) => ({
    success: false as const,
    error: {
  code,
    message: error instanceof Error ? error.message : fallbackMessage,
  },
});

  const getInferenceLlmHelper = () => {
    try {
      const coordinator = (appState as { getCoordinator?: () => unknown }).getCoordinator?.() as
        | { getSupervisor?: (name: string) => unknown }
        | undefined;
      const supervisor = coordinator?.getSupervisor?.('inference') as
        | { getLLMHelper?: () => unknown }
        | undefined;
      const llmHelper = supervisor?.getLLMHelper?.();
      if (llmHelper) {
        return llmHelper as ReturnType<typeof appState.processingHelper.getLLMHelper>;
      }
    } catch {
      // Fall back to the direct AppState path if supervisor lookup fails.
    }

    return appState.processingHelper.getLLMHelper();
  };

  const getRuntimeCoordinator = (): RuntimeCoordinatorLike | null => {
    try {
      const coordinator = (appState as { getCoordinator?: () => unknown }).getCoordinator?.() as RuntimeCoordinatorLike | undefined;
      if (typeof coordinator?.getSupervisor !== 'function') {
        return null;
      }

      return coordinator;
    } catch {
      return null;
    }
  };

  const getSttSupervisor = (): SttSupervisorLike | null => {
    const coordinator = getRuntimeCoordinator();
    return (coordinator?.getSupervisor?.('stt') as SttSupervisorLike | undefined) ?? null;
  };

  const getInferenceSupervisor = (): InferenceSupervisorLike | null => {
    const coordinator = getRuntimeCoordinator();
    return (coordinator?.getSupervisor?.('inference') as InferenceSupervisorLike | undefined) ?? null;
  };

  const getWindowFacade = (): WindowFacadeLike | null => {
    if ('getWindowFacade' in appState && typeof appState.getWindowFacade === 'function') {
      return appState.getWindowFacade() as WindowFacadeLike;
    }

    return null;
  };

  const getSettingsFacade = (): SettingsFacadeLike | null => {
    if ('getSettingsFacade' in appState && typeof appState.getSettingsFacade === 'function') {
      return appState.getSettingsFacade() as SettingsFacadeLike;
    }

    return null;
  };

  const getAudioFacade = (): AudioFacadeLike | null => {
    if ('getAudioFacade' in appState && typeof appState.getAudioFacade === 'function') {
      return appState.getAudioFacade() as AudioFacadeLike;
    }

    return null;
  };

  const getIntelligenceManager = (): IntelligenceManagerLike => {
    const supervisor = getInferenceSupervisor();
    const intelligenceManager = supervisor?.getIntelligenceManager?.();
    if (intelligenceManager) {
      return intelligenceManager as IntelligenceManagerLike;
    }

    return appState.getIntelligenceManager() as IntelligenceManagerLike;
  };

  const initializeInferenceLLMs = async (): Promise<void> => {
    const supervisor = getInferenceSupervisor();
    if (supervisor?.initializeLLMs) {
      await supervisor.initializeLLMs();
      return;
    }

    await appState.getIntelligenceManager().initializeLLMs();
  };

  const getScreenshotFacade = (): ScreenshotFacadeLike | null => {
    if ('getScreenshotFacade' in appState && typeof appState.getScreenshotFacade === 'function') {
      return appState.getScreenshotFacade() as ScreenshotFacadeLike;
    }

    return null;
  };

safeHandleValidated("renderer:log-error", (args) => [parseIpcInput(ipcSchemas.rendererLogPayload, args[0], 'renderer:log-error')] as const, async (_, payload) => {
    try {
      console.error('[RendererError]', JSON.stringify(payload));
      return { success: true };
    } catch (err: any) {
      console.error('[RendererError] Failed to log payload:', err);
      return { success: false, error: err?.message || 'Failed to log renderer error' };
    }
  });

  safeHandle("license:activate", async (event, key: string) => {
    return { success: true };
  });
  safeHandle("license:check-premium", async () => {
    return true;
  });
  safeHandle("license:deactivate", async () => {
    return { success: true };
  });
  safeHandle("license:get-hardware-id", async () => {
    return 'open-build';
  });

  registerSettingsHandlers({ appState, safeHandle, safeHandleValidated });
  registerCalendarHandlers({ appState, safeHandle });
  registerEmailHandlers({ appState, safeHandleValidated });
  registerRagHandlers({ appState, safeHandle, safeHandleValidated });
  registerProfileHandlers({ appState, safeHandle, safeHandleValidated });
  registerIntelligenceHandlers({ appState, safeHandle });
  registerWindowHandlers({ appState, safeHandle, safeHandleValidated });


  safeHandleValidated("delete-screenshot", (args) => [parseIpcInput(ipcSchemas.absoluteUserDataPath, args[0], 'delete-screenshot')] as const, async (event, filePath) => {
    // Guard: only allow deletion of files within the app's own userData directory
    const userDataDir = app.getPath('userData');
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(userDataDir + path.sep)) {
      console.warn('[IPC] delete-screenshot: path outside userData rejected:', filePath);
      return { success: false, error: 'Path not allowed' };
    }
    const screenshotFacade = getScreenshotFacade();
    if (screenshotFacade?.deleteScreenshot) {
      return screenshotFacade.deleteScreenshot(resolved);
    }
    return appState.deleteScreenshot(resolved);
  })

  safeHandle("take-screenshot", async () => {
    try {
      const screenshotFacade = getScreenshotFacade();
      const screenshotPath = screenshotFacade?.takeScreenshot
        ? await screenshotFacade.takeScreenshot()
        : await appState.takeScreenshot();
      const preview = screenshotFacade?.getImagePreview
        ? await screenshotFacade.getImagePreview(screenshotPath)
        : await appState.getImagePreview(screenshotPath);
      return ok({ path: screenshotPath, preview })
    } catch (error) {
      return fail('SCREENSHOT_CAPTURE_FAILED', error, 'Failed to take screenshot')
    }
  })

  safeHandle("take-selective-screenshot", async () => {
    try {
      const screenshotFacade = getScreenshotFacade();
      const screenshotPath = screenshotFacade?.takeSelectiveScreenshot
        ? await screenshotFacade.takeSelectiveScreenshot()
        : await appState.takeSelectiveScreenshot();
      const preview = screenshotFacade?.getImagePreview
        ? await screenshotFacade.getImagePreview(screenshotPath)
        : await appState.getImagePreview(screenshotPath);
      return ok({ path: screenshotPath, preview })
    } catch (error: any) {
      if (error?.message === "Selection cancelled") {
        return ok({ cancelled: true })
      }
      return fail('SELECTIVE_SCREENSHOT_FAILED', error, 'Failed to take selective screenshot')
    }
  })

  safeHandle("get-screenshots", async () => {
    // console.log({ view: appState.getView() })
    try {
      const screenshotFacade = getScreenshotFacade();
      const view = screenshotFacade?.getView ? screenshotFacade.getView() : appState.getView();
      const getPreview = screenshotFacade?.getImagePreview
        ? (filePath: string) => screenshotFacade.getImagePreview!(filePath)
        : (filePath: string) => appState.getImagePreview(filePath);
      let previews: Array<{ path: string; preview: string }> = []
      if (view === "queue") {
        const screenshotQueue = screenshotFacade?.getScreenshotQueue
          ? screenshotFacade.getScreenshotQueue()
          : appState.getScreenshotQueue();
        previews = await Promise.all(
          screenshotQueue.map(async (path) => ({
            path,
            preview: await getPreview(path)
          }))
        )
      } else {
        const extraScreenshotQueue = screenshotFacade?.getExtraScreenshotQueue
          ? screenshotFacade.getExtraScreenshotQueue()
          : appState.getExtraScreenshotQueue();
        previews = await Promise.all(
          extraScreenshotQueue.map(async (path) => ({
            path,
            preview: await getPreview(path)
          }))
        )
      }
      // previews.forEach((preview: any) => console.log(preview.path))
      return ok(previews)
    } catch (error) {
      return fail('SCREENSHOT_LIST_FAILED', error, 'Failed to load screenshots')
    }
  })

  safeHandle("reset-queues", async () => {
    try {
      const screenshotFacade = getScreenshotFacade();
      if (screenshotFacade?.clearQueues) {
        screenshotFacade.clearQueues();
      } else {
        appState.clearQueues()
      }
      // console.log("Screenshot queues have been cleared.")
      return { success: true }
    } catch (error: any) {
      // console.error("Error resetting queues:", error)
      return { success: false, error: error.message }
    }
  })

  // Donation IPC Handlers
  safeHandle("get-donation-status", async () => {
    const { DonationManager } = require('./DonationManager');
    const manager = DonationManager.getInstance();
    return {
      shouldShow: manager.shouldShowToaster(),
      hasDonated: manager.getDonationState().hasDonated,
      lifetimeShows: manager.getDonationState().lifetimeShows
    };
  });

  safeHandle("mark-donation-toast-shown", async () => {
    const { DonationManager } = require('./DonationManager');
    DonationManager.getInstance().markAsShown();
    return { success: true };
  });

  safeHandle("set-donation-complete", async () => {
    const { DonationManager } = require('./DonationManager');
    DonationManager.getInstance().setHasDonated(true);
    return { success: true };
  });


  // Generate suggestion from transcript - Natively-style text-only reasoning
  safeHandleValidated("generate-suggestion", (args) => parseIpcInput(ipcSchemas.generateSuggestionArgs, args, 'generate-suggestion'), async (_event, context, lastQuestion) => {
    try {
      const suggestion = await getInferenceLlmHelper().generateSuggestion(context, lastQuestion)
      return ok({ suggestion })
    } catch (error: any) {
      return fail('SUGGESTION_GENERATION_FAILED', error, 'Failed to generate suggestion')
    }
  })

  safeHandle("finalize-mic-stt", async () => {
    const sttSupervisor = getSttSupervisor();
    if (sttSupervisor?.finalizeMicrophone) {
      await sttSupervisor.finalizeMicrophone();
    } else {
      appState.finalizeMicSTT();
    }
    return ok(null);
  });

  // IPC handler for analyzing image from file path
  safeHandleValidated("analyze-image-file", (args) => [parseIpcInput(ipcSchemas.absoluteUserDataPath, args[0], 'analyze-image-file')] as const, async (_event, filePath) => {
    // Guard: only allow reading files within the app's own userData directory
    const userDataDir = app.getPath('userData');
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(userDataDir + path.sep)) {
      console.warn('[IPC] analyze-image-file: path outside userData rejected:', filePath);
      return fail('PATH_NOT_ALLOWED', new Error('Path not allowed'), 'Path not allowed');
    }
    try {
      const result = await getInferenceLlmHelper().analyzeImageFiles([resolved])
      return ok(result)
    } catch (error: any) {
      return fail('IMAGE_ANALYSIS_FAILED', error, 'Failed to analyze image file')
    }
  })

  safeHandleValidated("gemini-chat", (args) => parseIpcInput(ipcSchemas.geminiChatArgs, args, 'gemini-chat'), async (event, message, imagePaths, context, options) => {
    try {
      const result = await getInferenceLlmHelper().chatWithGemini(message, imagePaths, context, options?.skipSystemPrompt);

      console.log(`[IPC] gemini - chat response: `, result ? result.substring(0, 50) : "(empty)");

      // Don't process empty responses
      if (!result || result.trim().length === 0) {
        console.warn("[IPC] Empty response from LLM, not updating IntelligenceManager");
        return "I apologize, but I couldn't generate a response. Please try again.";
      }

      // Sync with IntelligenceManager so Follow-Up/Recap work
      const intelligenceManager = getIntelligenceManager();

      // 1. Add user question to context (as 'user')
      // CRITICAL: Skip refinement check to prevent auto-triggering follow-up logic
      // The user's manual question is a NEW input, not a refinement of previous answer.
      intelligenceManager.addTranscript({
        text: message,
        speaker: 'user',
        timestamp: Date.now(),
        final: true
      }, true);

      // 2. Add assistant response and set as last message
      console.log(`[IPC] Updating IntelligenceManager with assistant message...`);
      intelligenceManager.addAssistantMessage(result);
      console.log(`[IPC] Updated IntelligenceManager.Last message: `, intelligenceManager.getLastAssistantMessage()?.substring(0, 50));

      // Log Usage
      intelligenceManager.logUsage('chat', message, result);

      return result;
    } catch (error: any) {
      // console.error("Error in gemini-chat handler:", error);
      throw error;
    }
  });

  // Streaming IPC Handler
  safeHandleValidated("gemini-chat-stream", (args) => parseIpcInput(ipcSchemas.geminiChatArgs, args, 'gemini-chat-stream'), async (event, message, imagePaths, context, options) => {
    try {
      console.log("[IPC] gemini-chat-stream started using LLMHelper.streamChat");
      const llmHelper = getInferenceLlmHelper();

      // Update IntelligenceManager with USER message immediately
      const intelligenceManager = getIntelligenceManager();
      intelligenceManager.addTranscript({
        text: message,
        speaker: 'user',
        timestamp: Date.now(),
        final: true
      }, true);

      let fullResponse = "";

      // Context Injection for "Answer" button (100s rolling window)
      if (!context) {
        // User requested 100 seconds of context for the answer button
        // Logic: If no explicit context provided (like from manual override), auto-inject from IntelligenceManager
        try {
          const autoContext = intelligenceManager.getFormattedContext(100);
          if (autoContext && autoContext.trim().length > 0) {
            context = autoContext;
            console.log(`[IPC] Auto - injected 100s context for gemini - chat - stream(${context.length} chars)`);
          }
        } catch (ctxErr) {
          console.warn("[IPC] Failed to auto-inject context:", ctxErr);
        }
      }

      try {
        // USE streamChat which handles routing
        const stream = llmHelper.streamChat(message, imagePaths, context, options?.skipSystemPrompt ? "" : undefined);

        for await (const token of stream) {
          event.sender.send("gemini-stream-token", token);
          fullResponse += token;
        }

        event.sender.send("gemini-stream-done");

        // Update IntelligenceManager with ASSISTANT message after completion
        if (fullResponse.trim().length > 0) {
          intelligenceManager.addAssistantMessage(fullResponse);
          // Log Usage for streaming chat
          intelligenceManager.logUsage('chat', message, fullResponse);
        }

      } catch (streamError: any) {
        console.error("[IPC] Streaming error:", streamError);
        event.sender.send("gemini-stream-error", streamError.message || "Unknown streaming error");
      }

      return null; // Return null as data is sent via events

    } catch (error: any) {
      console.error("[IPC] Error in gemini-chat-stream setup:", error);
      throw error;
    }
  });



safeHandle("quit-app", () => {
  app.quit()
  return ok(null)
})

safeHandleValidated("delete-meeting", (args) => [parseIpcInput(ipcSchemas.providerId, args[0], 'delete-meeting')] as const, async (_, id) => {
  return DatabaseManager.getInstance().deleteMeeting(id);
});

// LLM Model Management Handlers
  safeHandle("get-current-llm-config", async () => {
    try {
      const llmHelper = getInferenceLlmHelper();
      return ok({
        provider: llmHelper.getCurrentProvider(),
        model: llmHelper.getCurrentModel(),
        isOllama: llmHelper.isUsingOllama()
      });
    } catch (error: any) {
      return fail('LLM_CONFIG_READ_FAILED', error, 'Failed to read current LLM config');
    }
  });

  safeHandle("get-available-ollama-models", async () => {
    try {
      const llmHelper = getInferenceLlmHelper();
      const models = await llmHelper.getOllamaModels();
      return ok(models);
    } catch (error: any) {
      return fail('OLLAMA_MODELS_READ_FAILED', error, 'Failed to get Ollama models');
    }
  });

  safeHandleValidated("switch-to-ollama", (args) => parseIpcInput(ipcSchemas.ollamaSwitchArgs, args, 'switch-to-ollama'), async (_, model, url) => {
    try {
      const llmHelper = getInferenceLlmHelper();
      await llmHelper.switchToOllama(model, url);
      return { success: true };
    } catch (error: any) {
      // console.error("Error switching to Ollama:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandle("force-restart-ollama", async () => {
    try {
      const llmHelper = getInferenceLlmHelper();
      const restarted = await llmHelper.forceRestartOllama();
      return ok({ restarted });
    } catch (error: any) {
      console.error("Error force restarting Ollama:", error);
      return fail('OLLAMA_FORCE_RESTART_FAILED', error, 'Failed to force restart Ollama');
    }
  });

  safeHandle('restart-ollama', async () => {
    try {
      // First try to kill it if it's running
      await getInferenceLlmHelper().forceRestartOllama();
      
      // The forceRestartOllama now calls OllamaManager.getInstance().init() internally
      // so we don't need to do it again here.
      
      return ok({ restarted: true });
    } catch (error: any) {
      console.error("[IPC restart-ollama] Failed to restart:", error);
      return fail('OLLAMA_RESTART_FAILED', error, 'Failed to restart Ollama');
    }
  });

  safeHandle("ensure-ollama-running", async () => {
    try {
      const { OllamaManager } = require('./services/OllamaManager');
      await OllamaManager.getInstance().init();
      return ok({ running: true });
    } catch (error: any) {
      return fail('OLLAMA_INIT_FAILED', error, 'Failed to ensure Ollama is running');
    }
  });

  safeHandleValidated("switch-to-gemini", (args) => parseIpcInput(ipcSchemas.providerSwitchGeminiArgs, args, 'switch-to-gemini'), async (_, apiKey, modelId) => {
    try {
      const llmHelper = getInferenceLlmHelper();
      await llmHelper.switchToGemini(apiKey, modelId);

      // Persist API key if provided
      if (apiKey) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        CredentialsManager.getInstance().setGeminiApiKey(apiKey);
      }

      return { success: true };
    } catch (error: any) {
      // console.error("Error switching to Gemini:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  // Dedicated API key setters (for Settings UI Save buttons)
  safeHandleValidated("set-gemini-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-gemini-api-key')] as const, async (_, apiKey) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGeminiApiKey(apiKey);

      // Also update the LLMHelper immediately
      const llmHelper = getInferenceLlmHelper();
      llmHelper.setApiKey(apiKey);

      // Re-init IntelligenceManager
      await initializeInferenceLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error saving Gemini API key:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-groq-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-groq-api-key')] as const, async (_, apiKey) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGroqApiKey(apiKey);

      // Also update the LLMHelper immediately
      const llmHelper = getInferenceLlmHelper();
      llmHelper.setGroqApiKey(apiKey);

      // Re-init IntelligenceManager
      await initializeInferenceLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error saving Groq API key:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-cerebras-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-cerebras-api-key')] as const, async (_, apiKey) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setCerebrasApiKey(apiKey);

      const llmHelper = getInferenceLlmHelper();
      llmHelper.setCerebrasApiKey(apiKey);

      await initializeInferenceLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error saving Cerebras API key:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-openai-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-openai-api-key')] as const, async (_, apiKey) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setOpenaiApiKey(apiKey);

      // Also update the LLMHelper immediately
      const llmHelper = getInferenceLlmHelper();
      llmHelper.setOpenaiApiKey(apiKey);

      // Re-init IntelligenceManager
      await initializeInferenceLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error saving OpenAI API key:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-claude-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-claude-api-key')] as const, async (_, apiKey) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setClaudeApiKey(apiKey);

      // Also update the LLMHelper immediately
      const llmHelper = getInferenceLlmHelper();
      llmHelper.setClaudeApiKey(apiKey);

      // Re-init IntelligenceManager
      await initializeInferenceLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error saving Claude API key:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  // Custom Provider Handlers
  safeHandle("get-custom-providers", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      // Merge new Curl Providers with legacy Custom Providers
      // New ones take precedence if IDs conflict (though unlikely as UUIDs)
      const curlProviders = cm.getCurlProviders();
      const legacyProviders = cm.getCustomProviders() || [];
      return ok([...curlProviders, ...legacyProviders]);
    } catch (error: any) {
      console.error("Error getting custom providers:", error);
      return fail('CUSTOM_PROVIDERS_READ_FAILED', error, 'Failed to get custom providers');
    }
  });

  safeHandleValidated("save-custom-provider", (args) => [parseIpcInput(ipcSchemas.customProvider, args[0], 'save-custom-provider')] as const, async (_, provider) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      // Save as CurlProvider (supports responsePath)
      CredentialsManager.getInstance().saveCurlProvider(provider);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving custom provider:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("delete-custom-provider", (args) => [parseIpcInput(ipcSchemas.providerId, args[0], 'delete-custom-provider')] as const, async (_, id) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      // Try deleting from both storages to be safe
      CredentialsManager.getInstance().deleteCurlProvider(id);
      CredentialsManager.getInstance().deleteCustomProvider(id);
      return { success: true };
    } catch (error: any) {
      console.error("Error deleting custom provider:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("switch-to-custom-provider", (args) => [parseIpcInput(ipcSchemas.providerId, args[0], 'switch-to-custom-provider')] as const, async (_, providerId) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const provider = CredentialsManager.getInstance().getCustomProviders().find((p: any) => p.id === providerId);

      if (!provider) {
        throw new Error("Provider not found");
      }

      const llmHelper = getInferenceLlmHelper();
      await llmHelper.switchToCustom(provider);

      // Re-init IntelligenceManager (optional, but good for consistency)
      await initializeInferenceLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error switching to custom provider:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  // cURL Provider Handlers
  safeHandle("get-curl-providers", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      return ok(CredentialsManager.getInstance().getCurlProviders());
    } catch (error: any) {
      console.error("Error getting curl providers:", error);
      return fail('CURL_PROVIDERS_READ_FAILED', error, 'Failed to get curl providers');
    }
  });

  safeHandleValidated("save-curl-provider", (args) => [parseIpcInput(ipcSchemas.customProvider, args[0], 'save-curl-provider')] as const, async (_, provider) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().saveCurlProvider(provider);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving curl provider:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("delete-curl-provider", (args) => [parseIpcInput(ipcSchemas.providerId, args[0], 'delete-curl-provider')] as const, async (_, id) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().deleteCurlProvider(id);
      return { success: true };
    } catch (error: any) {
      console.error("Error deleting curl provider:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("switch-to-curl-provider", (args) => [parseIpcInput(ipcSchemas.providerId, args[0], 'switch-to-curl-provider')] as const, async (_, providerId) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const provider = CredentialsManager.getInstance().getCurlProviders().find((p: any) => p.id === providerId);

      if (!provider) {
        throw new Error("Provider not found");
      }

      const llmHelper = getInferenceLlmHelper();
      await llmHelper.switchToCurl(provider);

      // Re-init IntelligenceManager (optional, but good for consistency)
      await initializeInferenceLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error switching to curl provider:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  // Get stored API keys (masked for UI display)
  safeHandle("get-stored-credentials", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      const creds = cm.getAllCredentials();

      // Return masked versions for security (just indicate if set)
      const hasKey = (key?: string) => !!(key && key.trim().length > 0);

      return ok({
        hasGeminiKey: hasKey(creds.geminiApiKey),
        hasGroqKey: hasKey(creds.groqApiKey),
        hasCerebrasKey: hasKey(creds.cerebrasApiKey),
        hasOpenaiKey: hasKey(creds.openaiApiKey),
        hasClaudeKey: hasKey(creds.claudeApiKey),
        googleServiceAccountPath: creds.googleServiceAccountPath || null,
        sttProvider: creds.sttProvider || 'google',
        groqSttModel: creds.groqSttModel || 'whisper-large-v3-turbo',
        hasSttGroqKey: hasKey(creds.groqSttApiKey),
        hasSttOpenaiKey: hasKey(creds.openAiSttApiKey),
        hasDeepgramKey: hasKey(creds.deepgramApiKey),
        hasElevenLabsKey: hasKey(creds.elevenLabsApiKey),
        hasAzureKey: hasKey(creds.azureApiKey),
        azureRegion: creds.azureRegion || 'eastus',
        hasIbmWatsonKey: hasKey(creds.ibmWatsonApiKey),
        ibmWatsonRegion: creds.ibmWatsonRegion || 'us-south',
        hasSonioxKey: hasKey(creds.sonioxApiKey),
        hasGoogleSearchKey: hasKey(creds.googleSearchApiKey),
        hasGoogleSearchCseId: hasKey(creds.googleSearchCseId),
        // Dynamic Model Discovery - preferred models
        geminiPreferredModel: creds.geminiPreferredModel || undefined,
        groqPreferredModel: creds.groqPreferredModel || undefined,
        cerebrasPreferredModel: creds.cerebrasPreferredModel || undefined,
        openaiPreferredModel: creds.openaiPreferredModel || undefined,
        claudePreferredModel: creds.claudePreferredModel || undefined,
        fastResponseConfig: cm.getFastResponseConfig(),
      });
    } catch (error: any) {
      return fail('CREDENTIALS_READ_FAILED', error, 'Failed to get stored credentials');
    }
  });

  // ==========================================
  // Dynamic Model Discovery Handlers
  // ==========================================

  safeHandleValidated("fetch-provider-models", (args) => parseIpcInput(ipcSchemas.providerModelFetchArgs, args, 'fetch-provider-models'), async (_, provider, apiKey) => {
    try {
      // Fall back to stored key if no key was explicitly provided
      let key = apiKey?.trim();
      if (!key) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        const cm = CredentialsManager.getInstance();
        if (provider === 'gemini') key = cm.getGeminiApiKey();
        else if (provider === 'groq') key = cm.getGroqApiKey();
        else if (provider === 'cerebras') key = cm.getCerebrasApiKey();
        else if (provider === 'openai') key = cm.getOpenaiApiKey();
        else if (provider === 'claude') key = cm.getClaudeApiKey();
      }

      if (!key) {
        return { success: false, error: 'No API key available. Please save a key first.' };
      }

      const { fetchProviderModels } = require('./utils/modelFetcher');
      const models = await fetchProviderModels(provider, key);
      return { success: true, models };
    } catch (error: any) {
      console.error(`[IPC] Failed to fetch ${provider} models:`, error);
      const msg = error?.response?.data?.error?.message || error.message || 'Failed to fetch models';
      return { success: false, error: msg };
    }
  });

  safeHandleValidated("set-provider-preferred-model", (args) => parseIpcInput(ipcSchemas.providerPreferredModel, args, 'set-provider-preferred-model'), async (_, provider, modelId) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setPreferredModel(provider, modelId);
      return { success: true };
    } catch (error: any) {
      console.error(`[IPC] Failed to set preferred model for ${provider}:`, error);
      return { success: false, error: error?.message || 'Failed to set preferred model' };
    }
  });

  // ==========================================
  // STT Provider Management Handlers
  // ==========================================

  safeHandleValidated("set-stt-provider", (args) => [parseIpcInput(ipcSchemas.sttProvider, args[0], 'set-stt-provider')] as const, async (_, provider) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setSttProvider(provider);

      // Reconfigure the audio pipeline to use the new STT provider
      const sttSupervisor = getSttSupervisor();
      if (sttSupervisor?.reconfigureProvider) {
        await sttSupervisor.reconfigureProvider();
      } else {
        await appState.reconfigureSttProvider();
      }

      return { success: true };
    } catch (error: any) {
      console.error("Error setting STT provider:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandle("get-stt-provider", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      return ok(CredentialsManager.getInstance().getSttProvider());
    } catch (error: any) {
      return fail('STT_PROVIDER_READ_FAILED', error, 'Failed to get STT provider');
    }
  });

  safeHandleValidated("set-groq-stt-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-groq-stt-api-key')] as const, async (_, apiKey) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGroqSttApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving Groq STT API key:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-openai-stt-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-openai-stt-api-key')] as const, async (_, apiKey) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setOpenAiSttApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving OpenAI STT API key:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-deepgram-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-deepgram-api-key')] as const, async (_, apiKey) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setDeepgramApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving Deepgram API key:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-groq-stt-model", (args) => [parseIpcInput(ipcSchemas.modelId, args[0], 'set-groq-stt-model')] as const, async (_, model) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGroqSttModel(model);

      // Reconfigure the audio pipeline to use the new model
      const sttSupervisor = getSttSupervisor();
      if (sttSupervisor?.reconfigureProvider) {
        await sttSupervisor.reconfigureProvider();
      } else {
        await appState.reconfigureSttProvider();
      }

      return { success: true };
    } catch (error: any) {
      console.error("Error setting Groq STT model:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-elevenlabs-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-elevenlabs-api-key')] as const, async (_, apiKey) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setElevenLabsApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving ElevenLabs API key:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-azure-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-azure-api-key')] as const, async (_, apiKey) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setAzureApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving Azure API key:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-azure-region", (args) => [parseIpcInput(ipcSchemas.azureRegion, args[0], 'set-azure-region')] as const, async (_, region) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setAzureRegion(region);

      // Reconfigure the pipeline since region changes the endpoint URL
      const sttSupervisor = getSttSupervisor();
      if (sttSupervisor?.reconfigureProvider) {
        await sttSupervisor.reconfigureProvider();
      } else {
        await appState.reconfigureSttProvider();
      }

      return { success: true };
    } catch (error: any) {
      console.error("Error setting Azure region:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-ibmwatson-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-ibmwatson-api-key')] as const, async (_, apiKey) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setIbmWatsonApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving IBM Watson API key:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-soniox-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-soniox-api-key')] as const, async (_, apiKey) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setSonioxApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving Soniox API key:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  // Helper to sanitize error messages (remove API key references)
  const sanitizeErrorMessage = (msg: string): string => {
    // Remove patterns like ": sk-***...***" or ": sdasdada***...dwwC"
    return msg.replace(/:\s*[a-zA-Z0-9*]+\*+[a-zA-Z0-9*]+\.?$/g, '').trim();
  };

  safeHandleValidated("test-stt-connection", (args) => parseIpcInput(ipcSchemas.sttConnectionArgs, args, 'test-stt-connection'), async (_, provider, apiKey, region) => {
    console.log(`[IPC] Received test - stt - connection request for provider: ${provider} `);
    try {
      if (provider === 'deepgram') {
        const WebSocket = require('ws');
        return await new Promise<{ success: boolean; error?: string }>((resolve) => {
          const url = 'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1';
          const ws = new WebSocket(url, {
            headers: { Authorization: `Token ${apiKey} ` },
          });

          const cleanupAndResolve = (result: { success: boolean; error?: string }) => {
            clearTimeout(timeout);
            try { ws.close(); } catch { }
            resolve(result);
          };

          const timeout = setTimeout(() => {
            cleanupAndResolve({ success: false, error: 'Connection timed out' });
          }, 15000);

          ws.on('open', () => {
            try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { }
            cleanupAndResolve({ success: true });
          });

          ws.on('error', (err: any) => {
            cleanupAndResolve({ success: false, error: err.message || 'Connection failed' });
          });
        });
      }

      if (provider === 'soniox') {
        const WebSocket = require('ws');
        return await new Promise<{ success: boolean; error?: string }>((resolve) => {
          const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');

          const cleanupAndResolve = (result: { success: boolean; error?: string }) => {
            clearTimeout(timeout);
            try { ws.close(); } catch { }
            resolve(result);
          };

          const timeout = setTimeout(() => {
            cleanupAndResolve({ success: false, error: 'Connection timed out' });
          }, 15000);

          ws.on('open', () => {
            ws.send(JSON.stringify({
              api_key: apiKey,
              model: 'stt-rt-v4',
              audio_format: 'pcm_s16le',
              sample_rate: 16000,
              num_channels: 1,
            }));
          });

          ws.on('message', (msg: any) => {
            try {
              const res = JSON.parse(msg.toString());
              if (res.error_code) {
                cleanupAndResolve({ success: false, error: `${res.error_code}: ${res.error_message}` });
              } else {
                cleanupAndResolve({ success: true });
              }
            } catch {
              cleanupAndResolve({ success: true });
            }
          });

          ws.on('error', (err: any) => {
            cleanupAndResolve({ success: false, error: err.message || 'Connection failed' });
          });
        });
      }

      const axios = require('axios');
      const FormData = require('form-data');

      // Generate a tiny silent WAV (0.5s of silence at 16kHz mono 16-bit)
      const numSamples = 8000;
      const pcmData = Buffer.alloc(numSamples * 2);
      const wavHeader = Buffer.alloc(44);
      wavHeader.write('RIFF', 0);
      wavHeader.writeUInt32LE(36 + pcmData.length, 4);
      wavHeader.write('WAVE', 8);
      wavHeader.write('fmt ', 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);
      wavHeader.writeUInt16LE(1, 22);
      wavHeader.writeUInt32LE(16000, 24);
      wavHeader.writeUInt32LE(32000, 28);
      wavHeader.writeUInt16LE(2, 32);
      wavHeader.writeUInt16LE(16, 34);
      wavHeader.write('data', 36);
      wavHeader.writeUInt32LE(pcmData.length, 40);
      const testWav = Buffer.concat([wavHeader, pcmData]);

      if (provider === 'elevenlabs') {
        // ElevenLabs: Use /v1/voices to validate the API key (minimal scope required).
        // Scoped keys may lack speech_to_text or user_read but still be usable once permissions are added.
        try {
          await axios.get('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': apiKey },
            timeout: 10000,
          });
        } catch (elErr: any) {
          const elStatus = elErr?.response?.data?.detail?.status;
          // If the error is "invalid_api_key", the key itself is wrong — fail.
          // Any other error (missing permission, etc.) means the key IS valid, just possibly scoped.
          if (elStatus === 'invalid_api_key') {
            throw elErr;
          }
          // Key is valid but scoped — pass with a warning
          console.log('[IPC] ElevenLabs key is valid but may have restricted scopes. Saving key.');
        }
      } else if (provider === 'azure') {
        // Azure: raw binary with subscription key
        const azureRegion = region || 'eastus';
        await axios.post(
          `https://${azureRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`,
          testWav,
          {
            headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'Content-Type': 'audio/wav' },
            timeout: 15000,
          }
        );
      } else if (provider === 'ibmwatson') {
        // IBM Watson: raw binary with Basic auth
        const ibmRegion = region || 'us-south';
        await axios.post(
          `https://api.${ibmRegion}.speech-to-text.watson.cloud.ibm.com/v1/recognize`,
          testWav,
          {
            headers: {
              Authorization: `Basic ${Buffer.from(`apikey:${apiKey}`).toString('base64')}`,
              'Content-Type': 'audio/wav',
            },
            timeout: 15000,
          }
        );
      } else {
        // Groq / OpenAI: multipart FormData
        const endpoint = provider === 'groq'
          ? 'https://api.groq.com/openai/v1/audio/transcriptions'
          : 'https://api.openai.com/v1/audio/transcriptions';
        const model = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';

        const form = new FormData();
        form.append('file', testWav, { filename: 'test.wav', contentType: 'audio/wav' });
        form.append('model', model);

        await axios.post(endpoint, form, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...form.getHeaders(),
          },
          timeout: 15000,
        });
      }

      return { success: true };
    } catch (error: any) {
      const respData = error?.response?.data;
      const rawMsg = respData?.error?.message || respData?.detail?.message || respData?.message || error.message || 'Connection failed';
      const msg = sanitizeErrorMessage(rawMsg);
      console.error("STT connection test failed:", msg);
      return { success: false, error: msg };
    }
  });

  safeHandleValidated("test-llm-connection", (args) => parseIpcInput(ipcSchemas.llmConnectionArgs, args, 'test-llm-connection'), async (_, provider, apiKey) => {
    console.log(`[IPC] Received test-llm-connection request for provider: ${provider}`);
    try {
      if (!apiKey || !apiKey.trim()) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        const creds = CredentialsManager.getInstance();
        if (provider === 'gemini') apiKey = creds.getGeminiApiKey();
        else if (provider === 'groq') apiKey = creds.getGroqApiKey();
        else if (provider === 'cerebras') apiKey = creds.getCerebrasApiKey();
        else if (provider === 'openai') apiKey = creds.getOpenaiApiKey();
        else if (provider === 'claude') apiKey = creds.getClaudeApiKey();
      }

      if (!apiKey || !apiKey.trim()) {
        return { success: false, error: 'No API key provided' };
      }

      const axios = require('axios');
      let response;

      if (provider === 'gemini') {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent`;
        response = await axios.post(url, {
          contents: [{ parts: [{ text: "Hello" }] }]
        }, {
          headers: { 'x-goog-api-key': apiKey },
          timeout: 15000
        });
      } else if (provider === 'groq') {
        response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: "Hello" }]
        }, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 15000
        });
      } else if (provider === 'cerebras') {
        response = await axios.post('https://api.cerebras.ai/v1/chat/completions', {
          model: 'gpt-oss-120b',
          messages: [{ role: 'user', content: 'Hello' }],
          max_completion_tokens: 16,
        }, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 15000,
        });
      } else if (provider === 'openai') {
        response = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: "gpt-5.3-chat-latest",
          messages: [{ role: "user", content: "Hello" }]
        }, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 15000
        });
      } else if (provider === 'claude') {
        response = await axios.post('https://api.anthropic.com/v1/messages', {
          model: "claude-sonnet-4-6",
          max_tokens: 10,
          messages: [{ role: "user", content: "Hello" }]
        }, {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          timeout: 15000
        });
      }

      if (response && (response.status === 200 || response.status === 201)) {
        return { success: true };
      } else {
        return { success: false, error: 'Request failed with status ' + response?.status };
      }

    } catch (error: any) {
      console.error("LLM connection test failed:", error);
      const rawMsg = error?.response?.data?.error?.message || error?.response?.data?.message || (error.response?.data?.error?.type ? `${error.response.data.error.type}: ${error.response.data.error.message}` : error.message) || 'Connection failed';
      const msg = sanitizeErrorMessage(rawMsg);
      return { success: false, error: msg };
    }
  });

  safeHandle("get-fast-response-config", () => {
    try {
      const llmHelper = getInferenceLlmHelper();
      return ok(llmHelper.getFastResponseConfig());
    } catch (error: any) {
      return fail('FAST_RESPONSE_CONFIG_READ_FAILED', error, 'Failed to get Fast Response config');
    }
  });

  safeHandleValidated("set-fast-response-config", (args) => [parseIpcInput(ipcSchemas.fastResponseConfig, args[0], 'set-fast-response-config')] as const, (_, config) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const llmHelper = getInferenceLlmHelper();
      llmHelper.setFastResponseConfig(config as any);
      CredentialsManager.getInstance().setFastResponseConfig(config as any);

      BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('fast-response-config-changed', llmHelper.getFastResponseConfig());
      });

      return { success: true };
    } catch (error: any) {
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  safeHandleValidated("set-model", (args) => [parseIpcInput(ipcSchemas.modelId, args[0], 'set-model')] as const, async (_, modelId) => {
    try {
      const llmHelper = getInferenceLlmHelper();
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();

      // Get all providers (Curl + Custom)
      const curlProviders = cm.getCurlProviders();
      const legacyProviders = cm.getCustomProviders() || [];
      const allProviders = [...curlProviders, ...legacyProviders];

      llmHelper.setModel(modelId, allProviders);

      // Close the selector window if open
      const windowFacade = getWindowFacade();
      if (windowFacade?.hideModelSelectorWindow) {
        windowFacade.hideModelSelectorWindow();
      } else {
        appState.modelSelectorWindowHelper.hideWindow();
      }

      // Broadcast to all windows so NativelyInterface can update its selector (session-only update)
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('model-changed', modelId);
        }
      });

      return { success: true };
    } catch (error: any) {
      console.error("Error setting model:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  // Persist default model (from Settings) + update runtime + broadcast to all windows
  safeHandleValidated("set-default-model", (args) => [parseIpcInput(ipcSchemas.modelId, args[0], 'set-default-model')] as const, async (_, modelId) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      cm.setDefaultModel(modelId);

      // Also update the runtime model
      const llmHelper = getInferenceLlmHelper();
      const curlProviders = cm.getCurlProviders();
      const legacyProviders = cm.getCustomProviders() || [];
      const allProviders = [...curlProviders, ...legacyProviders];
      llmHelper.setModel(modelId, allProviders);

      // Close the selector window if open
      const windowFacade = getWindowFacade();
      if (windowFacade?.hideModelSelectorWindow) {
        windowFacade.hideModelSelectorWindow();
      } else {
        appState.modelSelectorWindowHelper.hideWindow();
      }

      // Broadcast to all windows so NativelyInterface can update its selector
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('model-changed', modelId);
        }
      });

      return { success: true };
    } catch (error: any) {
      console.error("Error setting default model:", error);
      return fail('IPC_ERROR', error, 'Operation failed');
    }
  });

  // Read the persisted default model
  safeHandle("get-default-model", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      return ok({ model: cm.getDefaultModel() });
    } catch (error: any) {
      console.error("Error getting default model:", error);
      return fail('DEFAULT_MODEL_READ_FAILED', error, 'Failed to get default model');
    }
  });

  // --- Model Selector Window IPC ---

  safeHandleValidated("show-model-selector", (args) => [parseIpcInput(ipcSchemas.modelSelectorCoords, args[0], 'show-model-selector')] as const, (_, coords) => {
    const windowFacade = getWindowFacade();
    if (windowFacade?.showModelSelectorWindow) {
      windowFacade.showModelSelectorWindow(coords.x, coords.y);
    } else {
      appState.modelSelectorWindowHelper.showWindow(coords.x, coords.y);
    }
  });

  safeHandle("hide-model-selector", () => {
    const windowFacade = getWindowFacade();
    if (windowFacade?.hideModelSelectorWindow) {
      windowFacade.hideModelSelectorWindow();
    } else {
      appState.modelSelectorWindowHelper.hideWindow();
    }
    return ok(null);
  });

  safeHandleValidated("toggle-model-selector", (args) => [parseIpcInput(ipcSchemas.modelSelectorCoords, args[0], 'toggle-model-selector')] as const, (_, coords) => {
    const windowFacade = getWindowFacade();
    if (windowFacade?.toggleModelSelectorWindow) {
      windowFacade.toggleModelSelectorWindow(coords.x, coords.y);
    } else {
      appState.modelSelectorWindowHelper.toggleWindow(coords.x, coords.y);
    }
  });



  // Native Audio Service Handlers
  safeHandle("native-audio-status", async () => {
    try {
      const audioFacade = getAudioFacade();
      return ok(audioFacade?.getNativeAudioStatus ? audioFacade.getNativeAudioStatus() : appState.getNativeAudioStatus());
    } catch (error) {
      return fail('NATIVE_AUDIO_STATUS_FAILED', error, 'Failed to get native audio status');
    }
  });
  registerMeetingHandlers({ appState, safeHandle, safeHandleValidated });

  


  // Service Account Selection
  safeHandle("select-service-account", async () => {
    try {
      const result: any = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });

      if (result.canceled || result.filePaths.length === 0) {
        return ok({ cancelled: true });
      }

      const filePath = result.filePaths[0];

      // Update backend state immediately
      const sttSupervisor = getSttSupervisor();
      if (sttSupervisor?.updateGoogleCredentials) {
        await sttSupervisor.updateGoogleCredentials(filePath);
      } else {
        appState.updateGoogleCredentials(filePath);
      }

      // Persist the path for future sessions
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGoogleServiceAccountPath(filePath);

      return ok({ path: filePath });
    } catch (error: any) {
      console.error("Error selecting service account:", error);
      return fail('SERVICE_ACCOUNT_SELECTION_FAILED', error, 'Failed to select service account');
    }
  });

  // ==========================================
  // Theme System Handlers
  // ==========================================

  safeHandle("theme:get-mode", () => {
    try {
      const settingsFacade = getSettingsFacade();
      const mode = settingsFacade?.getThemeMode ? settingsFacade.getThemeMode() : appState.getThemeManager().getMode();
      const resolved = settingsFacade?.getResolvedTheme ? settingsFacade.getResolvedTheme() : appState.getThemeManager().getResolvedTheme();
      return ok({
        mode,
        resolved,
      });
    } catch (error) {
      return fail('THEME_MODE_READ_FAILED', error, 'Failed to get theme mode');
    }
  });

  safeHandleValidated("theme:set-mode", (args) => [parseIpcInput(ipcSchemas.themeMode, args[0], 'theme:set-mode')] as const, (_, mode) => {
    const settingsFacade = getSettingsFacade();
    if (settingsFacade?.setThemeMode) {
      settingsFacade.setThemeMode(mode);
    } else {
      appState.getThemeManager().setMode(mode);
    }
    return { success: true };
  });

  registerCalendarHandlers({ appState, safeHandle });

  registerRagHandlers({ appState, safeHandle, safeHandleValidated });

  

  // ==========================================
  // Overlay Opacity (Stealth Mode)
  // ==========================================

  safeHandleValidated("set-overlay-opacity", (args) => [parseIpcInput(ipcSchemas.overlayOpacity, args[0], 'set-overlay-opacity')] as const, async (_, opacity) => {
    // Clamp to valid range
    const clamped = Math.min(1.0, Math.max(0.15, opacity));
    // Broadcast to all renderer windows so the overlay picks it up in real-time
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('overlay-opacity-changed', clamped);
      }
    });
    return ok({ opacity: clamped });
  });
}
