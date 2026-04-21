import type { AppState } from '../main';
import { ipcSchemas, parseIpcInput } from '../ipcValidation';
import type { HandlerContext } from './handlerContext';

export type ProviderSttTestIpcDeps = Pick<
  HandlerContext,
  'safeHandle' | 'safeHandleValidated' | 'ok' | 'fail' | 'getInferenceLlmHelper' | 'getSttSupervisor'
> & { appState: AppState };

export function registerProviderSttAndTestIpcHandlers(deps: ProviderSttTestIpcDeps): void {
  const { appState, safeHandle, safeHandleValidated, ok, fail, getInferenceLlmHelper, getSttSupervisor } = deps;

    // ==========================================
    // Dynamic Model Discovery Handlers
    // ==========================================
  
    safeHandleValidated("fetch-provider-models", (args) => parseIpcInput(ipcSchemas.providerModelFetchArgs, args, 'fetch-provider-models'), async (_, provider, apiKey) => {
      try {
        // Fall back to stored key if no key was explicitly provided
        let key = apiKey?.trim();
        if (!key) {
          const { CredentialsManager } = require('../services/CredentialsManager');
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
  
        const { fetchProviderModels } = require('../utils/modelFetcher');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
        return ok(CredentialsManager.getInstance().getSttProvider());
      } catch (error: any) {
        return fail('STT_PROVIDER_READ_FAILED', error, 'Failed to get STT provider');
      }
    });
  
    safeHandleValidated("set-groq-stt-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-groq-stt-api-key')] as const, async (_, apiKey) => {
      try {
        const { CredentialsManager } = require('../services/CredentialsManager');
        CredentialsManager.getInstance().setGroqSttApiKey(apiKey);
        return { success: true };
      } catch (error: any) {
        console.error("Error saving Groq STT API key:", error);
        return fail('IPC_ERROR', error, 'Operation failed');
      }
    });
  
    safeHandleValidated("set-openai-stt-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-openai-stt-api-key')] as const, async (_, apiKey) => {
      try {
        const { CredentialsManager } = require('../services/CredentialsManager');
        CredentialsManager.getInstance().setOpenAiSttApiKey(apiKey);
        return { success: true };
      } catch (error: any) {
        console.error("Error saving OpenAI STT API key:", error);
        return fail('IPC_ERROR', error, 'Operation failed');
      }
    });
  
    safeHandleValidated("set-deepgram-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-deepgram-api-key')] as const, async (_, apiKey) => {
      try {
        const { CredentialsManager } = require('../services/CredentialsManager');
        CredentialsManager.getInstance().setDeepgramApiKey(apiKey);
        return { success: true };
      } catch (error: any) {
        console.error("Error saving Deepgram API key:", error);
        return fail('IPC_ERROR', error, 'Operation failed');
      }
    });
  
    safeHandleValidated("set-groq-stt-model", (args) => [parseIpcInput(ipcSchemas.modelId, args[0], 'set-groq-stt-model')] as const, async (_, model) => {
      try {
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
        CredentialsManager.getInstance().setElevenLabsApiKey(apiKey);
        return { success: true };
      } catch (error: any) {
        console.error("Error saving ElevenLabs API key:", error);
        return fail('IPC_ERROR', error, 'Operation failed');
      }
    });
  
    safeHandleValidated("set-azure-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-azure-api-key')] as const, async (_, apiKey) => {
      try {
        const { CredentialsManager } = require('../services/CredentialsManager');
        CredentialsManager.getInstance().setAzureApiKey(apiKey);
        return { success: true };
      } catch (error: any) {
        console.error("Error saving Azure API key:", error);
        return fail('IPC_ERROR', error, 'Operation failed');
      }
    });
  
    safeHandleValidated("set-azure-region", (args) => [parseIpcInput(ipcSchemas.azureRegion, args[0], 'set-azure-region')] as const, async (_, region) => {
      try {
        const { CredentialsManager } = require('../services/CredentialsManager');
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
        const { CredentialsManager } = require('../services/CredentialsManager');
        CredentialsManager.getInstance().setIbmWatsonApiKey(apiKey);
        return { success: true };
      } catch (error: any) {
        console.error("Error saving IBM Watson API key:", error);
        return fail('IPC_ERROR', error, 'Operation failed');
      }
    });
  
    safeHandleValidated("set-soniox-api-key", (args) => [parseIpcInput(ipcSchemas.apiKey, args[0], 'set-soniox-api-key')] as const, async (_, apiKey) => {
      try {
        const { CredentialsManager } = require('../services/CredentialsManager');
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
          const { CredentialsManager } = require('../services/CredentialsManager');
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
}
