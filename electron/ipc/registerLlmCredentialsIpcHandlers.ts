import { ipcSchemas, parseIpcInput } from '../ipcValidation';
import type { HandlerContext } from './handlerContext';

export type LlmCredentialsIpcDeps = Pick<
  HandlerContext,
  'safeHandle' | 'safeHandleValidated' | 'ok' | 'fail' | 'getInferenceLlmHelper' | 'initializeInferenceLLMs'
>;

export function registerLlmCredentialsIpcHandlers(deps: LlmCredentialsIpcDeps): void {
  const { safeHandle, safeHandleValidated, ok, fail, getInferenceLlmHelper, initializeInferenceLLMs } = deps;

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
        const { OllamaManager } = require('../services/OllamaManager');
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
          const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
        return ok(CredentialsManager.getInstance().getCurlProviders());
      } catch (error: any) {
        console.error("Error getting curl providers:", error);
        return fail('CURL_PROVIDERS_READ_FAILED', error, 'Failed to get curl providers');
      }
    });
  
    safeHandleValidated("save-curl-provider", (args) => [parseIpcInput(ipcSchemas.customProvider, args[0], 'save-curl-provider')] as const, async (_, provider) => {
      try {
        const { CredentialsManager } = require('../services/CredentialsManager');
        CredentialsManager.getInstance().saveCurlProvider(provider);
        return { success: true };
      } catch (error: any) {
        console.error("Error saving curl provider:", error);
        return fail('IPC_ERROR', error, 'Operation failed');
      }
    });
  
    safeHandleValidated("delete-curl-provider", (args) => [parseIpcInput(ipcSchemas.providerId, args[0], 'delete-curl-provider')] as const, async (_, id) => {
      try {
        const { CredentialsManager } = require('../services/CredentialsManager');
        CredentialsManager.getInstance().deleteCurlProvider(id);
        return { success: true };
      } catch (error: any) {
        console.error("Error deleting curl provider:", error);
        return fail('IPC_ERROR', error, 'Operation failed');
      }
    });
  
    safeHandleValidated("switch-to-curl-provider", (args) => [parseIpcInput(ipcSchemas.providerId, args[0], 'switch-to-curl-provider')] as const, async (_, providerId) => {
      try {
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
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
}
