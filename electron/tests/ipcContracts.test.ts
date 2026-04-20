import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown;

function installIpcHandlersTestHarness(options?: {
  restartOllamaError?: string;
  serviceAccountResult?: { canceled: boolean; filePaths: string[] };
}) {
  const originalLoad = (Module as any)._load;
  const handlers = new Map<string, Handler>();
  const sentEvents: Array<{ channel: string; payload: unknown }> = [];
  const browserEvents: Array<{ channel: string; payload: unknown }> = [];
  let fastResponseConfig = { enabled: true, provider: 'cerebras', model: 'gpt-oss-120b' };

  const llmHelper = {
    generateSuggestion: async (context: string, lastQuestion: string) => `${context} -> ${lastQuestion}`,
    analyzeImageFiles: async (paths: string[]) => [{ summary: `analyzed:${paths[0]}` }],
    chatWithGemini: async (message: string) => `answer:${message}`,
    getCurrentProvider: () => 'gemini',
    getCurrentModel: () => 'gemini-3.1-flash-lite-preview',
    isUsingOllama: () => false,
    setApiKey: (_key: string) => {},
    setGroqApiKey: (_key: string) => {},
    setCerebrasApiKey: (_key: string) => {},
    setOpenaiApiKey: (_key: string) => {},
    setClaudeApiKey: (_key: string) => {},
    switchToCustom: async (_provider: unknown) => {},
    switchToCurl: async (_provider: unknown) => {},
    getOllamaModels: async () => ['llama3.2'],
    forceRestartOllama: async () => {
      if (options?.restartOllamaError) {
        throw new Error(options.restartOllamaError);
      }
      return true;
    },
    getFastResponseConfig: () => fastResponseConfig,
    setFastResponseConfig: (config: typeof fastResponseConfig) => {
      fastResponseConfig = config;
    },
  };

  const credentialsManager = {
    setGoogleServiceAccountPath: (_path: string) => {},
    setGeminiApiKey: (_key: string) => {},
    setGroqApiKey: (_key: string) => {},
    setSttProvider: (_provider: string) => {},
    setGroqSttModel: (_model: string) => {},
    setOpenaiApiKey: (_key: string) => {},
    setClaudeApiKey: (_key: string) => {},
    setAzureRegion: (_region: string) => {},
    getCurlProviders: () => [{ id: 'curl-1', name: 'Curl', curlCommand: 'curl', responsePath: 'data.text' }],
    getCustomProviders: () => [{ id: 'custom-1', name: 'Custom', curlCommand: 'curl', responsePath: 'data.text' }],
    getAllCredentials: () => ({
      geminiApiKey: 'gemini-key',
      groqApiKey: '',
      cerebrasApiKey: 'cerebras-key',
      openaiApiKey: '',
      claudeApiKey: '',
      googleServiceAccountPath: '/tmp/service.json',
      sttProvider: 'google',
      groqSttModel: 'whisper-large-v3-turbo',
      groqSttApiKey: '',
      openAiSttApiKey: '',
      deepgramApiKey: '',
      elevenLabsApiKey: '',
      azureApiKey: '',
      azureRegion: 'eastus',
      ibmWatsonApiKey: '',
      ibmWatsonRegion: 'us-south',
      sonioxApiKey: '',
      googleSearchApiKey: '',
      googleSearchCseId: '',
      fastResponseConfig,
    }),
    getSttProvider: () => 'google',
    getFastResponseConfig: () => fastResponseConfig,
    setFastResponseConfig: (config: typeof fastResponseConfig) => {
      fastResponseConfig = config;
    },
    getCerebrasApiKey: () => 'cerebras-key',
    setCerebrasApiKey: (_key: string) => {},
  };

  const electronMock = {
    app: {
      getPath: (name: string) => (name === 'userData' ? '/tmp/user-data' : '/tmp'),
      quit: () => {
        sentEvents.push({ channel: 'app:quit', payload: null });
      },
    },
    ipcMain: {
      removeHandler: (channel: string) => {
        handlers.delete(channel);
      },
      handle: (channel: string, listener: Handler) => {
        handlers.set(channel, listener);
      },
    },
    shell: {},
    dialog: {
      showOpenDialog: async () => options?.serviceAccountResult ?? { canceled: true, filePaths: [] },
    },
    desktopCapturer: {},
    systemPreferences: {},
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => browserEvents.push({ channel, payload }) } }],
    },
    screen: {},
  };

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return electronMock;
    }

    if (request === './IntelligenceManager') {
      return { GEMINI_FLASH_MODEL: 'gemini-3.1-flash-lite-preview' };
    }

    if (request === './db/DatabaseManager') {
      return { DatabaseManager: { getInstance: () => ({ deleteMeeting: async () => true }) } };
    }

    if (
      request === './ipc/registerMeetingHandlers' ||
      request === './ipc/registerSettingsHandlers' ||
      request === './ipc/registerCalendarHandlers' ||
      request === './ipc/registerRagHandlers' ||
      request === './ipc/registerEmailHandlers' ||
      request === './ipc/registerProfileHandlers' ||
      request === './ipc/registerIntelligenceHandlers'
    ) {
      return {
        registerMeetingHandlers: () => {},
        registerSettingsHandlers: () => {},
        registerCalendarHandlers: () => {},
        registerRagHandlers: () => {},
        registerEmailHandlers: () => {},
        registerProfileHandlers: () => {},
        registerIntelligenceHandlers: () => {},
      };
    }

    if (request === './services/CredentialsManager') {
      return { CredentialsManager: { getInstance: () => credentialsManager } };
    }

    if (request === './services/OllamaManager') {
      return { OllamaManager: { getInstance: () => ({ init: async () => {} }) } };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  const appState = {
    getMainWindow: () => ({ webContents: { send: (channel: string, payload: unknown) => sentEvents.push({ channel, payload }) } }),
    settingsWindowHelper: { getSettingsWindow: (): null => null, setWindowDimensions: (): void => {}, hideWindow: (): void => {} },
    getWindowHelper: () => ({ getOverlayWindow: (): null => null, getLauncherWindow: (): null => null, getLauncherContentWindow: (): null => null, setOverlayDimensions: (): void => {} }),
    takeScreenshot: async () => '/tmp/user-data/screenshot.png',
    getImagePreview: async (filePath: string) => `preview:${filePath}`,
    takeSelectiveScreenshot: async () => '/tmp/user-data/selective.png',
    getView: () => 'queue',
    getScreenshotQueue: () => ['/tmp/user-data/one.png'],
    getExtraScreenshotQueue: () => ['/tmp/user-data/two.png'],
    toggleMainWindow: () => {},
showMainWindow: () => {},
      hideMainWindow: () => {},
      clearQueues: () => {},
      processingHelper: { getLLMHelper: () => llmHelper },
      finalizeMicSTT: () => {},
      moveWindowLeft: () => {},
    moveWindowRight: () => {},
    moveWindowUp: () => {},
    moveWindowDown: () => {},
    centerAndShowWindow: () => {},
    modelSelectorWindowHelper: { hideWindow: () => {} },
    getNativeAudioStatus: () => ({ connected: true }),
    updateGoogleCredentials: (_path: string) => {},
    getIntelligenceManager: () => ({
      addTranscript: () => {},
      addAssistantMessage: () => {},
      getLastAssistantMessage: (): string | null => null,
      getFormattedContext: () => '',
      logUsage: () => {},
      initializeLLMs: () => {},
    }),
    getThemeManager: () => ({ getMode: () => 'system', getResolvedTheme: () => 'light', setMode: (_mode: string) => {} }),
  };

  return {
    handlers,
    sentEvents,
    browserEvents,
    appState,
    restore: () => {
      (Module as any)._load = originalLoad;
    },
  };
}

async function initializeHandlers(harness: ReturnType<typeof installIpcHandlersTestHarness>) {
  const modulePath = require.resolve('../ipcHandlers');
  delete require.cache[modulePath];
  const { initializeIpcHandlers } = await import('../ipcHandlers');
  initializeIpcHandlers(harness.appState as any);
}

async function loadPreloadModule(invokeImpl: (channel: string, ...args: unknown[]) => Promise<unknown>) {
  const originalLoad = (Module as any)._load;
  let exposedApi: any;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        contextBridge: {
          exposeInMainWorld: (_name: string, api: any) => {
            exposedApi = api;
          },
        },
        ipcRenderer: {
          invoke: invokeImpl,
          on: () => {},
          removeListener: () => {},
        },
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve('../preload');
  delete require.cache[modulePath];
  await import('../preload');

  return {
    exposedApi,
    restore: () => {
      (Module as any)._load = originalLoad;
    },
  };
}

function createHandlerRegistry() {
  const handlers = new Map<string, Handler>();

  return {
    handlers,
    safeHandle: (channel: string, listener: Handler) => {
      handlers.set(channel, listener);
    },
    safeHandleValidated: <T extends unknown[]>(channel: string, parser: (args: unknown[]) => T, listener: (event: unknown, ...args: T) => Promise<unknown> | unknown) => {
      handlers.set(channel, (event, ...args) => listener(event, ...parser(args)));
    },
  };
}

async function withPatchedModules<T>(stubs: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request in stubs) {
      return stubs[request];
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return await run();
  } finally {
    (Module as any)._load = originalLoad;
  }
}

test('root IPC handlers validate inputs and return normalized contracts', async () => {
  const harness = installIpcHandlersTestHarness();
  await initializeHandlers(harness);

  assert.throws(() => harness.handlers.get('generate-suggestion')?.({}, '   ', 'question'), /Invalid IPC payload/);
  assert.throws(() => harness.handlers.get('set-overlay-opacity')?.({}, Number.NaN), /Invalid IPC payload/);

  assert.deepEqual(await harness.handlers.get('take-screenshot')?.({}), {
    success: true,
    data: {
      path: '/tmp/user-data/screenshot.png',
      preview: 'preview:/tmp/user-data/screenshot.png',
    },
  });

  assert.deepEqual(await harness.handlers.get('generate-suggestion')?.({}, 'context', 'question'), {
    success: true,
    data: { suggestion: 'context -> question' },
  });

  assert.deepEqual(await harness.handlers.get('get-current-llm-config')?.({}), {
    success: true,
    data: {
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite-preview',
      isOllama: false,
    },
  });

  assert.deepEqual(await harness.handlers.get('set-overlay-opacity')?.({}, 1.4), {
    success: true,
    data: { opacity: 1 },
  });
  assert.deepEqual(harness.browserEvents, [{ channel: 'overlay-opacity-changed', payload: 1 }]);

  harness.restore();
});

test('root IPC handlers normalize cancellation and failures into success/data/error shapes', async () => {
  const harness = installIpcHandlersTestHarness({ restartOllamaError: 'restart failed' });
  await initializeHandlers(harness);

  assert.deepEqual(await harness.handlers.get('select-service-account')?.({}), {
    success: true,
    data: { cancelled: true },
  });

  assert.deepEqual(await harness.handlers.get('restart-ollama')?.({}), {
    success: false,
    error: {
      code: 'OLLAMA_RESTART_FAILED',
      message: 'restart failed',
    },
  });

  harness.restore();
});

test('root screenshot handlers prefer ScreenshotFacade when available', async () => {
  const harness = installIpcHandlersTestHarness();
  const calls: string[] = [];

  Object.assign(harness.appState, {
    getScreenshotFacade: () => ({
      deleteScreenshot: async (path: string) => {
        calls.push(`delete:${path}`);
        return { success: true };
      },
      takeScreenshot: async () => {
        calls.push('take');
        return '/tmp/user-data/facade.png';
      },
      takeSelectiveScreenshot: async () => {
        calls.push('takeSelective');
        return '/tmp/user-data/facade-selective.png';
      },
      getImagePreview: async (path: string) => {
        calls.push(`preview:${path}`);
        return `facade-preview:${path}`;
      },
      getView: () => {
        calls.push('view');
        return 'solutions';
      },
      getScreenshotQueue: () => {
        throw new Error('legacy screenshot queue path should not be used');
      },
      getExtraScreenshotQueue: () => {
        calls.push('extraQueue');
        return ['/tmp/user-data/extra.png'];
      },
      clearQueues: () => {
        calls.push('clear');
      },
    }),
    deleteScreenshot: async () => {
      throw new Error('legacy delete path should not be used');
    },
    takeScreenshot: async () => {
      throw new Error('legacy take path should not be used');
    },
    takeSelectiveScreenshot: async () => {
      throw new Error('legacy selective path should not be used');
    },
    getImagePreview: async () => {
      throw new Error('legacy preview path should not be used');
    },
    getView: () => {
      throw new Error('legacy view path should not be used');
    },
    getExtraScreenshotQueue: () => {
      throw new Error('legacy extra queue path should not be used');
    },
    clearQueues: () => {
      throw new Error('legacy clear path should not be used');
    },
  });

  await initializeHandlers(harness);

  assert.deepEqual(await harness.handlers.get('delete-screenshot')?.({}, '/tmp/user-data/facade.png'), {
    success: true,
  });
  assert.deepEqual(await harness.handlers.get('take-screenshot')?.({}), {
    success: true,
    data: {
      path: '/tmp/user-data/facade.png',
      preview: 'facade-preview:/tmp/user-data/facade.png',
    },
  });
  assert.deepEqual(await harness.handlers.get('take-selective-screenshot')?.({}), {
    success: true,
    data: {
      path: '/tmp/user-data/facade-selective.png',
      preview: 'facade-preview:/tmp/user-data/facade-selective.png',
    },
  });
  assert.deepEqual(await harness.handlers.get('get-screenshots')?.({}), {
    success: true,
    data: [{
      path: '/tmp/user-data/extra.png',
      preview: 'facade-preview:/tmp/user-data/extra.png',
    }],
  });
  assert.deepEqual(await harness.handlers.get('reset-queues')?.({}), { success: true });

  assert.deepEqual(calls, [
    'delete:/tmp/user-data/facade.png',
    'take',
    'preview:/tmp/user-data/facade.png',
    'takeSelective',
    'preview:/tmp/user-data/facade-selective.png',
    'view',
    'extraQueue',
    'preview:/tmp/user-data/extra.png',
    'clear',
  ]);

  harness.restore();
});

test('root STT handlers prefer SttSupervisor when supervisor runtime is enabled', async () => {
  const harness = installIpcHandlersTestHarness({
    serviceAccountResult: { canceled: false, filePaths: ['/tmp/service.json'] },
  });
  const calls: string[] = [];

  Object.assign(harness.appState, {
    getCoordinator: () => ({
      shouldManageLifecycle: () => true,
      getSupervisor: (name: string) => {
        assert.equal(name, 'stt');
        return {
          finalizeMicrophone: async () => {
            calls.push('finalize');
          },
          reconfigureProvider: async () => {
            calls.push('reconfigure');
          },
          updateGoogleCredentials: async (filePath: string) => {
            calls.push(`credentials:${filePath}`);
          },
        };
      },
    }),
    finalizeMicSTT: () => {
      throw new Error('legacy finalize path should not be used');
    },
    reconfigureSttProvider: async () => {
      throw new Error('legacy reconfigure path should not be used');
    },
    updateGoogleCredentials: () => {
      throw new Error('legacy credential path should not be used');
    },
  });

  await initializeHandlers(harness);

  assert.deepEqual(await harness.handlers.get('finalize-mic-stt')?.({}), {
    success: true,
    data: null,
  });
  assert.deepEqual(await harness.handlers.get('set-stt-provider')?.({}, 'deepgram'), { success: true });
  assert.deepEqual(await harness.handlers.get('set-groq-stt-model')?.({}, 'whisper-large-v3'), { success: true });
  assert.deepEqual(await harness.handlers.get('set-azure-region')?.({}, 'westus'), { success: true });
  assert.deepEqual(await harness.handlers.get('select-service-account')?.({}), {
    success: true,
    data: { path: '/tmp/service.json' },
  });

  assert.deepEqual(calls, [
    'finalize',
    'reconfigure',
    'reconfigure',
    'reconfigure',
    'credentials:/tmp/service.json',
  ]);

  harness.restore();
});

test('root inference sync handlers prefer InferenceSupervisor when supervisor runtime is enabled', async () => {
  const harness = installIpcHandlersTestHarness();
  const calls: string[] = [];

  Object.assign(harness.appState, {
    getCoordinator: () => ({
      shouldManageLifecycle: () => true,
      getSupervisor: (name: string) => {
        assert.equal(name, 'inference');
        return {
          getLLMHelper: () => ({
            ...harness.appState.processingHelper.getLLMHelper(),
            setApiKey: (key: string) => {
              calls.push(`setApiKey:${key}`);
            },
            switchToCurl: async (provider: { id: string }) => {
              calls.push(`switchToCurl:${provider.id}`);
            },
            chatWithGemini: async (message: string) => {
              calls.push(`chat:${message}`);
              return `answer:${message}`;
            },
          }),
          initializeLLMs: async () => {
            calls.push('initialize');
          },
          getIntelligenceManager: () => ({
            addTranscript: (entry: { text: string }) => {
              calls.push(`transcript:${entry.text}`);
            },
            addAssistantMessage: (message: string) => {
              calls.push(`assistant:${message}`);
            },
            getLastAssistantMessage: () => 'answer:hello',
            getFormattedContext: () => '',
            logUsage: (type: string, input: string, output: string) => {
              calls.push(`usage:${type}:${input}:${output}`);
            },
            initializeLLMs: () => {
              calls.push('legacy-initialize-should-not-run');
            },
          }),
        };
      },
    }),
    getIntelligenceManager: () => {
      throw new Error('legacy intelligence manager path should not be used');
    },
  });

  await initializeHandlers(harness);

  assert.deepEqual(await harness.handlers.get('set-gemini-api-key')?.({}, 'key-123'), { success: true });
  assert.deepEqual(await harness.handlers.get('switch-to-curl-provider')?.({}, 'curl-1'), { success: true });
  assert.equal(
    await harness.handlers.get('gemini-chat')?.(
      {},
      'hello',
      [],
      undefined,
      { requestId: '00000000-0000-0000-0000-000000000001' },
    ),
    'answer:hello',
  );

  assert.deepEqual(calls, [
    'setApiKey:key-123',
    'initialize',
    'switchToCurl:curl-1',
    'initialize',
    'chat:hello',
    'transcript:hello',
    'assistant:answer:hello',
    'usage:chat:hello:answer:hello',
  ]);

  harness.restore();
});

test('root theme handlers prefer SettingsFacade when available', async () => {
  const harness = installIpcHandlersTestHarness();
  const calls: string[] = [];

  Object.assign(harness.appState, {
    getSettingsFacade: () => ({
      getThemeMode: () => {
        calls.push('getThemeMode');
        return 'dark';
      },
      getResolvedTheme: () => {
        calls.push('getResolvedTheme');
        return 'dark';
      },
      setThemeMode: (mode: string) => {
        calls.push(`setThemeMode:${mode}`);
      },
    }),
    getThemeManager: () => {
      throw new Error('legacy theme manager path should not be used');
    },
  });

  await initializeHandlers(harness);

  assert.deepEqual(await harness.handlers.get('theme:get-mode')?.({}), {
    success: true,
    data: { mode: 'dark', resolved: 'dark' },
  });
  assert.deepEqual(await harness.handlers.get('theme:set-mode')?.({}, 'light'), { success: true });
  assert.deepEqual(calls, ['getThemeMode', 'getResolvedTheme', 'setThemeMode:light']);

  harness.restore();
});

test('root IPC handlers validate high-risk LLM and STT payloads before dispatch', async () => {
  const harness = installIpcHandlersTestHarness();

  await initializeHandlers(harness);

  await assert.rejects(async () => harness.handlers.get('switch-to-ollama')?.({}, { model: 'llama3' }), /Invalid IPC payload/);
  await assert.rejects(async () => harness.handlers.get('switch-to-gemini')?.({}, { apiKey: 'key-123' }), /Invalid IPC payload/);
  await assert.rejects(async () => harness.handlers.get('test-llm-connection')?.({}, 'not-a-provider', 'key-123'), /Invalid IPC payload/);
  await assert.rejects(async () => harness.handlers.get('set-gemini-api-key')?.({}, { apiKey: 'key-123' }), /Invalid IPC payload/);
  await assert.rejects(async () => harness.handlers.get('set-openai-api-key')?.({}, 'x'.repeat(5000)), /Invalid IPC payload/);
  await assert.rejects(async () => harness.handlers.get('set-openai-stt-api-key')?.({}, { apiKey: 'key-123' }), /Invalid IPC payload/);
  await assert.rejects(async () => harness.handlers.get('set-deepgram-api-key')?.({}, { apiKey: 'key-123' }), /Invalid IPC payload/);
  await assert.rejects(async () => harness.handlers.get('set-elevenlabs-api-key')?.({}, { apiKey: 'key-123' }), /Invalid IPC payload/);
  await assert.rejects(async () => harness.handlers.get('set-soniox-api-key')?.({}, { apiKey: 'key-123' }), /Invalid IPC payload/);

  harness.restore();
});

test('root model selector handlers prefer WindowFacade when available', async () => {
  const harness = installIpcHandlersTestHarness();
  const calls: string[] = [];

  Object.assign(harness.appState, {
    getWindowFacade: () => ({
      showModelSelectorWindow: (x: number, y: number) => {
        calls.push(`show:${x},${y}`);
      },
      hideModelSelectorWindow: () => {
        calls.push('hide');
      },
      toggleModelSelectorWindow: (x: number, y: number) => {
        calls.push(`toggle:${x},${y}`);
      },
    }),
    modelSelectorWindowHelper: {
      showWindow: () => {
        throw new Error('legacy model selector show path should not be used');
      },
      hideWindow: () => {
        throw new Error('legacy model selector hide path should not be used');
      },
      toggleWindow: () => {
        throw new Error('legacy model selector toggle path should not be used');
      },
    },
  });

  await initializeHandlers(harness);

  assert.equal(await harness.handlers.get('show-model-selector')?.({}, { x: 10, y: 20 }), undefined);
  assert.deepEqual(await harness.handlers.get('hide-model-selector')?.({}), {
    success: true,
    data: null,
  });
  assert.equal(await harness.handlers.get('toggle-model-selector')?.({}, { x: 30, y: 40 }), undefined);
  assert.deepEqual(calls, ['show:10,20', 'hide', 'toggle:30,40']);

  harness.restore();
});

test('root native audio status handler prefers AudioFacade when available', async () => {
  const harness = installIpcHandlersTestHarness();

  Object.assign(harness.appState, {
    getAudioFacade: () => ({
      getNativeAudioStatus: () => ({ connected: true, backend: 'facade' }),
    }),
    getNativeAudioStatus: () => {
      throw new Error('legacy native audio path should not be used');
    },
  });

  await initializeHandlers(harness);

  assert.deepEqual(await harness.handlers.get('native-audio-status')?.({}), {
    success: true,
    data: { connected: true, backend: 'facade' },
  });

  harness.restore();
});

test('fast response and stored credential IPC contracts include Cerebras-aware state', async () => {
  const harness = installIpcHandlersTestHarness();
  await initializeHandlers(harness);

  assert.deepEqual(await harness.handlers.get('get-stored-credentials')?.({}), {
    success: true,
    data: {
      hasGeminiKey: true,
      hasGroqKey: false,
      hasCerebrasKey: true,
      hasOpenaiKey: false,
      hasClaudeKey: false,
      googleServiceAccountPath: '/tmp/service.json',
      sttProvider: 'google',
      groqSttModel: 'whisper-large-v3-turbo',
      hasSttGroqKey: false,
      hasSttOpenaiKey: false,
      hasDeepgramKey: false,
      hasElevenLabsKey: false,
      hasAzureKey: false,
      azureRegion: 'eastus',
      hasIbmWatsonKey: false,
      ibmWatsonRegion: 'us-south',
      hasSonioxKey: false,
      hasGoogleSearchKey: false,
      hasGoogleSearchCseId: false,
      geminiPreferredModel: undefined,
      groqPreferredModel: undefined,
      cerebrasPreferredModel: undefined,
      openaiPreferredModel: undefined,
      claudePreferredModel: undefined,
      fastResponseConfig: { enabled: true, provider: 'cerebras', model: 'gpt-oss-120b' },
    },
  });

  assert.deepEqual(await harness.handlers.get('get-fast-response-config')?.({}), {
    success: true,
    data: { enabled: true, provider: 'cerebras', model: 'gpt-oss-120b' },
  });

  assert.deepEqual(
    await harness.handlers.get('set-fast-response-config')?.({}, { enabled: false, provider: 'groq', model: 'llama-3.3-70b-versatile' }),
    { success: true },
  );

  assert.deepEqual(harness.browserEvents.at(-1), {
    channel: 'fast-response-config-changed',
    payload: { enabled: false, provider: 'groq', model: 'llama-3.3-70b-versatile' },
  });

  harness.restore();
});

test('preload unwraps normalized root IPC contracts into typed renderer helpers', async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const { exposedApi, restore } = await loadPreloadModule(async (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });

    if (channel === 'take-screenshot') {
      return { success: true, data: { path: '/tmp/user-data/screenshot.png', preview: 'preview' } };
    }

    if (channel === 'get-current-llm-config') {
      return {
        success: true,
        data: { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview', isOllama: false },
      };
    }

    if (channel === 'set-overlay-opacity') {
      return { success: true, data: { opacity: 0.5 } };
    }

    throw new Error(`Unexpected channel: ${channel}`);
  });

  assert.deepEqual(await exposedApi.takeScreenshot(), { path: '/tmp/user-data/screenshot.png', preview: 'preview' });
  assert.deepEqual(await exposedApi.getCurrentLlmConfig(), {
    provider: 'gemini',
    model: 'gemini-3.1-flash-lite-preview',
    isOllama: false,
  });
  await assert.doesNotReject(() => exposedApi.setOverlayOpacity(0.5));

  assert.deepEqual(calls, [
    { channel: 'take-screenshot', args: [] },
    { channel: 'get-current-llm-config', args: [] },
    { channel: 'set-overlay-opacity', args: [0.5] },
  ]);

  restore();
});

test('preload exposes fast response config helpers and Cerebras key setter', async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const { exposedApi, restore } = await loadPreloadModule(async (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });

    if (channel === 'get-fast-response-config') {
      return { success: true, data: { enabled: true, provider: 'cerebras', model: 'gpt-oss-120b' } };
    }

    if (channel === 'set-fast-response-config' || channel === 'set-cerebras-api-key') {
      return { success: true };
    }

    throw new Error(`Unexpected channel: ${channel}`);
  });

  assert.deepEqual(await exposedApi.getFastResponseConfig(), { enabled: true, provider: 'cerebras', model: 'gpt-oss-120b' });
  assert.deepEqual(await exposedApi.setFastResponseConfig({ enabled: false, provider: 'groq', model: 'llama-3.3-70b-versatile' }), { success: true });
  assert.deepEqual(await exposedApi.setCerebrasApiKey('csk_test'), { success: true });

  assert.deepEqual(calls, [
    { channel: 'get-fast-response-config', args: [] },
    { channel: 'set-fast-response-config', args: [{ enabled: false, provider: 'groq', model: 'llama-3.3-70b-versatile' }] },
    { channel: 'set-cerebras-api-key', args: ['csk_test'] },
  ]);

  restore();
});

test('settings handlers validate inputs and normalize success contracts', async () => {
  await withPatchedModules({
    electron: {
      app: {
        getPath: () => '/mock/exe',
        setLoginItemSettings: () => {},
        getLoginItemSettings: () => ({ openAtLogin: true }),
      },
    },
    '../services/CredentialsManager': {
      CredentialsManager: {
        getInstance: () => ({
          setAiResponseLanguage: () => {},
          getSttLanguage: () => 'en-US',
          getAiResponseLanguage: () => 'en',
        }),
      },
    },
  }, async () => {
    const modulePath = require.resolve('../ipc/registerSettingsHandlers');
    delete require.cache[modulePath];
    const { registerSettingsHandlers } = await import('../ipc/registerSettingsHandlers');
    const registry = createHandlerRegistry();
    const appState = {
      processingHelper: { getLLMHelper: () => ({ setAiResponseLanguage: () => {} }) },
      settingsWindowHelper: { toggleWindow: () => {}, closeWindow: () => {} },
      setUndetectable: () => {},
      setUndetectableAsync: async () => {},
      getUndetectable: () => true,
      setDisguise: () => {},
      getDisguise: () => 'activity',
      setConsciousModeEnabled: () => true,
      getConsciousModeEnabled: () => false,
    };

    registerSettingsHandlers({ appState: appState as any, ...registry } as any);

    assert.throws(() => registry.handlers.get('set-disguise')?.({}, 'spaceship'), /Invalid IPC payload/);
    assert.deepEqual(await registry.handlers.get('get-undetectable')?.({}), {
      success: true,
      data: { enabled: true },
    });
    assert.deepEqual(await registry.handlers.get('set-undetectable')?.({}, false), {
      success: true,
      data: { enabled: false },
    });
    assert.deepEqual(await registry.handlers.get('set-open-at-login')?.({}, true), {
      success: true,
      data: { enabled: true },
    });
  });
});

test('settings window handlers prefer WindowFacade when available', async () => {
  await withPatchedModules({
    electron: {
      app: {
        getPath: () => '/mock/exe',
        setLoginItemSettings: () => {},
        getLoginItemSettings: () => ({ openAtLogin: false }),
      },
    },
    '../services/CredentialsManager': {
      CredentialsManager: {
        getInstance: () => ({
          setAiResponseLanguage: () => {},
          getSttLanguage: () => 'en-US',
          getAiResponseLanguage: () => 'en',
        }),
      },
    },
  }, async () => {
    const modulePath = require.resolve('../ipc/registerSettingsHandlers');
    delete require.cache[modulePath];
    const { registerSettingsHandlers } = await import('../ipc/registerSettingsHandlers');
    const registry = createHandlerRegistry();
    const calls: string[] = [];
    const appState = {
      getWindowFacade: () => ({
        toggleSettingsWindow: (x?: number, y?: number) => {
          calls.push(`toggleSettings:${x ?? 'none'},${y ?? 'none'}`);
        },
        closeSettingsWindow: () => {
          calls.push('closeSettings');
        },
      }),
      processingHelper: { getLLMHelper: () => ({ setAiResponseLanguage: () => {} }) },
      settingsWindowHelper: {
        toggleWindow: () => {
          throw new Error('legacy settings window path should not be used');
        },
        closeWindow: () => {
          throw new Error('legacy settings window path should not be used');
        },
      },
      setUndetectable: () => {},
      getUndetectable: () => false,
      setDisguise: () => {},
      getDisguise: () => 'activity',
      setConsciousModeEnabled: () => true,
      getConsciousModeEnabled: () => false,
      setAccelerationModeEnabled: () => true,
      getAccelerationModeEnabled: () => false,
    };

    registerSettingsHandlers({ appState: appState as any, ...registry } as any);

    assert.deepEqual(await registry.handlers.get('toggle-settings-window')?.({}, { x: 10, y: 20 }), {
      success: true,
      data: null,
    });
    assert.deepEqual(await registry.handlers.get('close-settings-window')?.({}), {
      success: true,
      data: null,
    });
    assert.deepEqual(calls, ['toggleSettings:10,20', 'closeSettings']);
  });
});

test('settings state handlers prefer SettingsFacade when available', async () => {
  await withPatchedModules({
    electron: {
      app: {
        getPath: () => '/mock/exe',
        setLoginItemSettings: () => {},
        getLoginItemSettings: () => ({ openAtLogin: false }),
      },
    },
    '../services/CredentialsManager': {
      CredentialsManager: {
        getInstance: () => ({
          setAiResponseLanguage: () => {},
          getSttLanguage: () => 'en-US',
          getAiResponseLanguage: () => 'en',
        }),
      },
    },
  }, async () => {
    const modulePath = require.resolve('../ipc/registerSettingsHandlers');
    delete require.cache[modulePath];
    const { registerSettingsHandlers } = await import('../ipc/registerSettingsHandlers');
    const registry = createHandlerRegistry();
    const calls: string[] = [];
    const appState = {
      getSettingsFacade: () => ({
        setConsciousModeEnabled: (enabled: boolean) => {
          calls.push(`setConscious:${enabled}`);
          return true;
        },
        getConsciousModeEnabled: () => {
          calls.push('getConscious');
          return true;
        },
        setAccelerationModeEnabled: (enabled: boolean) => {
          calls.push(`setAcceleration:${enabled}`);
          return true;
        },
        getAccelerationModeEnabled: () => {
          calls.push('getAcceleration');
          return false;
        },
        setDisguise: (mode: string) => {
          calls.push(`setDisguise:${mode}`);
        },
        getDisguise: () => {
          calls.push('getDisguise');
          return 'settings';
        },
        getUndetectable: () => {
          calls.push('getUndetectable');
          return false;
        },
      }),
      processingHelper: { getLLMHelper: () => ({ setAiResponseLanguage: () => {} }) },
      settingsWindowHelper: { toggleWindow: () => {}, closeWindow: () => {} },
      setUndetectable: () => {},
      setUndetectableAsync: async () => {},
      getUndetectable: () => {
        throw new Error('legacy undetectable path should not be used');
      },
      setDisguise: () => {
        throw new Error('legacy disguise path should not be used');
      },
      getDisguise: () => {
        throw new Error('legacy disguise path should not be used');
      },
      setConsciousModeEnabled: () => {
        throw new Error('legacy conscious path should not be used');
      },
      getConsciousModeEnabled: () => {
        throw new Error('legacy conscious path should not be used');
      },
      setAccelerationModeEnabled: () => {
        throw new Error('legacy acceleration path should not be used');
      },
      getAccelerationModeEnabled: () => {
        throw new Error('legacy acceleration path should not be used');
      },
    };

    registerSettingsHandlers({ appState: appState as any, ...registry } as any);

    assert.deepEqual(await registry.handlers.get('set-conscious-mode')?.({}, true), {
      success: true,
      data: { enabled: true },
    });
    assert.deepEqual(await registry.handlers.get('get-conscious-mode')?.({}), {
      success: true,
      data: { enabled: true },
    });
    assert.deepEqual(await registry.handlers.get('set-acceleration-mode')?.({}, false), {
      success: true,
      data: { enabled: false },
    });
    assert.deepEqual(await registry.handlers.get('get-acceleration-mode')?.({}), {
      success: true,
      data: { enabled: false },
    });
    assert.deepEqual(await registry.handlers.get('set-disguise')?.({}, 'terminal'), {
      success: true,
      data: { mode: 'terminal' },
    });
    assert.deepEqual(await registry.handlers.get('get-disguise')?.({}), {
      success: true,
      data: { mode: 'settings' },
    });
    assert.deepEqual(await registry.handlers.get('get-undetectable')?.({}), {
      success: true,
      data: { enabled: false },
    });

    assert.deepEqual(calls, [
      'setConscious:true',
      'getConscious',
      'setAcceleration:false',
      'getAcceleration',
      'setDisguise:terminal',
      'getDisguise',
      'getUndetectable',
    ]);
  });
});

test('meeting handlers route lifecycle through AppState meeting APIs', async () => {
  const modulePath = require.resolve('../ipc/registerMeetingHandlers');
  delete require.cache[modulePath];
  const { registerMeetingHandlers } = await import('../ipc/registerMeetingHandlers');

  const registry = createHandlerRegistry();
  const calls: Array<{ type: string; payload?: unknown }> = [];
  const appState = {
    startMeeting: async (metadata?: unknown) => {
      calls.push({ type: 'startMeeting', payload: metadata });
    },
    endMeeting: async () => {
      calls.push({ type: 'endMeeting' });
    },
    startAudioTest: () => {},
    stopAudioTest: () => {},
    setRecognitionLanguage: () => {},
    getRAGManager: (): null => null,
  };

  registerMeetingHandlers({ appState: appState as any, ...registry } as any);

  const metadata = { audio: { inputDeviceId: 'mic-1', outputDeviceId: 'speaker-1' } };
  assert.deepEqual(await registry.handlers.get('start-meeting')?.({}, metadata), {
    success: true,
  });
  assert.deepEqual(await registry.handlers.get('end-meeting')?.({}), {
    success: true,
  });

  assert.deepEqual(calls, [
    { type: 'startMeeting', payload: metadata },
    { type: 'endMeeting' },
  ]);
});

test('meeting handlers prefer audio, stt, and inference supervisors for auxiliary flows', async () => {
  const calls: string[] = [];
  await withPatchedModules({
    '../db/DatabaseManager': {
      DatabaseManager: {
        getInstance: () => ({
          seedDemoMeeting: () => {
            calls.push('seedDemo');
          },
          getRecentMeetings: async (): Promise<never[]> => [],
          getMeetingDetails: async (): Promise<null> => null,
          updateMeetingTitle: async (): Promise<boolean> => true,
          updateMeetingSummary: async (): Promise<boolean> => true,
          clearAllData: () => true,
        }),
      },
    },
  }, async () => {
    const modulePath = require.resolve('../ipc/registerMeetingHandlers');
    delete require.cache[modulePath];
    const { registerMeetingHandlers } = await import('../ipc/registerMeetingHandlers');

    const registry = createHandlerRegistry();
    const appState = {
      getCoordinator: () => ({
        shouldManageLifecycle: () => true,
        getSupervisor: (name: string) => {
          if (name === 'audio') {
            return {
              startAudioTest: async (deviceId?: string) => {
                calls.push(`startAudioTest:${deviceId ?? 'default'}`);
              },
              stopAudioTest: async () => {
                calls.push('stopAudioTest');
              },
            };
          }

          if (name === 'stt') {
            return {
              setRecognitionLanguage: async (language: string) => {
                calls.push(`recognition:${language}`);
              },
            };
          }

          if (name === 'inference') {
            return {
              getRAGManager: () => ({
                isReady: () => true,
                reprocessMeeting: async (meetingId: string) => {
                  calls.push(`reprocess:${meetingId}`);
                },
              }),
            };
          }

          throw new Error(`Unexpected supervisor: ${name}`);
        },
      }),
      startAudioTest: () => {
        throw new Error('legacy audio path should not be used');
      },
      stopAudioTest: () => {
        throw new Error('legacy audio path should not be used');
      },
      setRecognitionLanguage: () => {
        throw new Error('legacy stt path should not be used');
      },
      getRAGManager: () => {
        throw new Error('legacy rag path should not be used');
      },
    };

    registerMeetingHandlers({ appState: appState as any, ...registry } as any);

    assert.deepEqual(await registry.handlers.get('start-audio-test')?.({}, 'mic-1'), { success: true });
    assert.deepEqual(await registry.handlers.get('stop-audio-test')?.({}), { success: true });
    assert.deepEqual(await registry.handlers.get('set-recognition-language')?.({}, 'en-US'), { success: true });
    assert.deepEqual(await registry.handlers.get('seed-demo')?.({}), { success: true });
    await assert.rejects(async () => registry.handlers.get('start-audio-test')?.({}, '   '), /Invalid IPC payload/);
    await assert.rejects(async () => registry.handlers.get('get-meeting-details')?.({}, ''), /Invalid IPC payload/);
    await assert.rejects(async () => registry.handlers.get('open-external')?.({}, 'file:///tmp/unsafe'), /Invalid IPC payload/);

    assert.deepEqual(calls, [
      'startAudioTest:mic-1',
      'stopAudioTest',
      'recognition:en-US',
      'seedDemo',
      'reprocess:demo-meeting',
    ]);
  });
});

test('settings handlers route stealth toggles through AppState', async () => {
  await withPatchedModules({
    electron: {
      app: {
        getPath: () => '/mock/exe',
        setLoginItemSettings: () => {},
        getLoginItemSettings: () => ({ openAtLogin: false }),
      },
    },
    '../services/CredentialsManager': {
      CredentialsManager: {
        getInstance: () => ({
          setAiResponseLanguage: () => {},
          getSttLanguage: () => 'en-US',
          getAiResponseLanguage: () => 'en',
        }),
      },
    },
  }, async () => {
    const modulePath = require.resolve('../ipc/registerSettingsHandlers');
    delete require.cache[modulePath];
    const { registerSettingsHandlers } = await import('../ipc/registerSettingsHandlers');
    const registry = createHandlerRegistry();
    const calls: string[] = [];
    const appState = {
      processingHelper: { getLLMHelper: () => ({ setAiResponseLanguage: () => {} }) },
      settingsWindowHelper: { toggleWindow: () => {}, closeWindow: () => {} },
      setUndetectable: () => {
        calls.push('legacy:setUndetectable');
      },
      setUndetectableAsync: async (enabled: boolean) => {
        calls.push(`setUndetectableAsync:${enabled}`);
      },
      getUndetectable: () => true,
      setDisguise: () => {},
      getDisguise: () => 'activity',
      setConsciousModeEnabled: () => true,
      getConsciousModeEnabled: () => false,
      setAccelerationModeEnabled: () => true,
      getAccelerationModeEnabled: () => false,
    };

    registerSettingsHandlers({ appState: appState as any, ...registry } as any);

    assert.deepEqual(await registry.handlers.get('set-undetectable')?.({}, true), {
      success: true,
      data: { enabled: true },
    });
    assert.deepEqual(calls, ['setUndetectableAsync:true']);
  });
});

test('settings handlers prefer InferenceSupervisor LLM helper when supervisor runtime is enabled', async () => {
  await withPatchedModules({
    electron: {
      app: {
        getPath: () => '/mock/exe',
        setLoginItemSettings: () => {},
        getLoginItemSettings: () => ({ openAtLogin: false }),
      },
    },
    '../services/CredentialsManager': {
      CredentialsManager: {
        getInstance: () => ({
          setAiResponseLanguage: () => {},
          getSttLanguage: () => 'en-US',
          getAiResponseLanguage: () => 'en',
        }),
      },
    },
  }, async () => {
    const modulePath = require.resolve('../ipc/registerSettingsHandlers');
    delete require.cache[modulePath];
    const { registerSettingsHandlers } = await import('../ipc/registerSettingsHandlers');
    const registry = createHandlerRegistry();
    const calls: string[] = [];
    const appState = {
      getCoordinator: () => ({
        shouldManageLifecycle: () => true,
        getSupervisor: (name: string) => {
          assert.equal(name, 'inference');
          return {
            getLLMHelper: () => ({
              setAiResponseLanguage: (language: string) => {
                calls.push(`supervisor:${language}`);
              },
            }),
          };
        },
      }),
      processingHelper: {
        getLLMHelper: () => ({
          setAiResponseLanguage: (language: string) => {
            calls.push(`legacy:${language}`);
          },
        }),
      },
      settingsWindowHelper: { toggleWindow: () => {}, closeWindow: () => {} },
      setUndetectable: () => {},
      getUndetectable: () => true,
      setDisguise: () => {},
      getDisguise: () => 'activity',
      setConsciousModeEnabled: () => true,
      getConsciousModeEnabled: () => false,
      setAccelerationModeEnabled: () => true,
      getAccelerationModeEnabled: () => false,
    };

    registerSettingsHandlers({ appState: appState as any, ...registry } as any);

    assert.deepEqual(await registry.handlers.get('set-ai-response-language')?.({}, 'fr'), {
      success: true,
      data: { language: 'fr' },
    });
    assert.deepEqual(calls, ['supervisor:fr']);
  });
});

test('email handlers prefer InferenceSupervisor LLM helper when supervisor runtime is enabled', async () => {
  await withPatchedModules({
    electron: { shell: { openExternal: async () => {} } },
    '../llm/prompts': {
      FOLLOWUP_EMAIL_PROMPT: 'FOLLOWUP',
      GROQ_FOLLOWUP_EMAIL_PROMPT: 'GROQ FOLLOWUP',
    },
    '../utils/emailUtils': {
      buildFollowUpEmailPromptInput: () => 'Meeting summary',
      extractEmailsFromTranscript: (): string[] => [],
      buildMailtoLink: () => 'mailto:test@example.com',
    },
  }, async () => {
    const modulePath = require.resolve('../ipc/registerEmailHandlers');
    delete require.cache[modulePath];
    const { registerEmailHandlers } = await import('../ipc/registerEmailHandlers');
    const registry = createHandlerRegistry();
    const calls: string[] = [];
    const appState = {
      getCoordinator: () => ({
        shouldManageLifecycle: () => true,
        getSupervisor: (name: string) => {
          assert.equal(name, 'inference');
          return {
            getLLMHelper: () => ({
              chatWithGemini: async () => {
                calls.push('supervisor');
                return 'supervisor response';
              },
            }),
          };
        },
      }),
      processingHelper: {
        getLLMHelper: () => ({
          chatWithGemini: async () => {
            calls.push('legacy');
            return 'legacy response';
          },
        }),
      },
    };

    registerEmailHandlers({ appState: appState as any, ...registry } as any);

    assert.equal(await registry.handlers.get('generate-followup-email')?.({}, {
      meeting_type: 'meeting',
      title: 'Roadmap Review',
    }), 'supervisor response');
    assert.deepEqual(calls, ['supervisor']);
  });
});

test('intelligence handlers prefer InferenceSupervisor when supervisor runtime is enabled', async () => {
  const modulePath = require.resolve('../ipc/registerIntelligenceHandlers');
  delete require.cache[modulePath];
  const { registerIntelligenceHandlers } = await import('../ipc/registerIntelligenceHandlers');

  const registry = createHandlerRegistry();
  const calls: string[] = [];
  const appState = {
    getCoordinator: () => ({
      shouldManageLifecycle: () => true,
      getSupervisor: (name: string) => {
        assert.equal(name, 'inference');
        return {
          runAssistMode: async () => {
            calls.push('assist');
            return 'insight';
          },
          runWhatShouldISay: async (question?: string, confidence?: number, imagePaths?: string[]) => {
            calls.push(`what:${question ?? 'none'}:${confidence}:${imagePaths?.length ?? 0}`);
            return 'answer';
          },
          runFollowUp: async (intent: string, userRequest?: string) => {
            calls.push(`follow:${intent}:${userRequest ?? ''}`);
            return 'refined';
          },
          runRecap: async () => {
            calls.push('recap');
            return 'summary';
          },
          runFollowUpQuestions: async () => {
            calls.push('questions');
            return ['q1'];
          },
          runManualAnswer: async (question: string) => {
            calls.push(`manual:${question}`);
            return 'manual answer';
          },
          getFormattedContext: () => {
            calls.push('context');
            return 'formatted context';
          },
          getLastAssistantMessage: () => {
            calls.push('lastAssistant');
            return 'last assistant';
          },
          getActiveMode: () => {
            calls.push('activeMode');
            return 'idle';
          },
          reset: async () => {
            calls.push('reset');
          },
        };
      },
    }),
    getIntelligenceManager: () => {
      throw new Error('legacy intelligence path should not be used');
    },
  };

  registerIntelligenceHandlers({ appState: appState as any, ...registry } as any);

  assert.deepEqual(await registry.handlers.get('generate-assist')?.({}), { insight: 'insight' });
  assert.deepEqual(await registry.handlers.get('generate-what-to-say')?.({}, 'question', ['img-1']), {
    answer: 'answer',
    question: 'question',
    status: 'completed',
  });
  assert.deepEqual(await registry.handlers.get('generate-follow-up')?.({}, 'tradeoff', 'more detail'), {
    refined: 'refined',
    intent: 'tradeoff',
  });
  assert.deepEqual(await registry.handlers.get('generate-recap')?.({}), { summary: 'summary' });
  assert.deepEqual(await registry.handlers.get('generate-follow-up-questions')?.({}), { questions: ['q1'] });
  assert.deepEqual(await registry.handlers.get('submit-manual-question')?.({}, 'manual question'), {
    answer: 'manual answer',
    question: 'manual question',
  });
  assert.deepEqual(await registry.handlers.get('get-intelligence-context')?.({}), {
    context: 'formatted context',
    lastAssistantMessage: 'last assistant',
    activeMode: 'idle',
  });
  assert.deepEqual(await registry.handlers.get('reset-intelligence')?.({}), { success: true });

  assert.deepEqual(calls, [
    'assist',
    'what:question:0.8:1',
    'follow:tradeoff:more detail',
    'recap',
    'questions',
    'manual:manual question',
    'context',
    'lastAssistant',
    'activeMode',
    'reset',
  ]);
});

test('intelligence handlers return canceled status when what-to-say yields no answer', async () => {
  const modulePath = require.resolve('../ipc/registerIntelligenceHandlers');
  delete require.cache[modulePath];
  const { registerIntelligenceHandlers } = await import('../ipc/registerIntelligenceHandlers');

  const registry = createHandlerRegistry();
  const appState = {
    getCoordinator: () => ({
      shouldManageLifecycle: () => true,
      getSupervisor: () => ({
        runWhatShouldISay: async (): Promise<string | null> => null,
      }),
    }),
    getIntelligenceManager: () => ({
      runWhatShouldISay: async () => 'legacy answer',
    }),
  };

  registerIntelligenceHandlers({ appState: appState as any, ...registry } as any);

  assert.deepEqual(await registry.handlers.get('generate-what-to-say')?.({}, undefined, []), {
    answer: null,
    question: 'inferred from context',
    status: 'canceled',
    error: 'Request canceled before completion.',
  });
});

test('intelligence handlers return error status when what-to-say throws', async () => {
  const modulePath = require.resolve('../ipc/registerIntelligenceHandlers');
  delete require.cache[modulePath];
  const { registerIntelligenceHandlers } = await import('../ipc/registerIntelligenceHandlers');

  const registry = createHandlerRegistry();
  const appState = {
    getCoordinator: () => ({
      shouldManageLifecycle: () => true,
      getSupervisor: () => ({
        runWhatShouldISay: async (): Promise<string | null> => {
          throw new Error('provider timed out');
        },
      }),
    }),
    getIntelligenceManager: () => ({
      runWhatShouldISay: async () => 'legacy answer',
    }),
  };

  registerIntelligenceHandlers({ appState: appState as any, ...registry } as any);

  assert.deepEqual(await registry.handlers.get('generate-what-to-say')?.({}, 'why now?', ['img-1']), {
    answer: null,
    question: 'why now?',
    status: 'error',
    error: 'provider timed out',
  });
});

test('screenshot capture output flows into a completed screenshot-backed what-to-say request', async () => {
  const harness = installIpcHandlersTestHarness();
  await initializeHandlers(harness);

  const screenshotResult = await harness.handlers.get('take-screenshot')?.({}) as {
    success: true;
    data: { path: string; preview: string };
  };

  const modulePath = require.resolve('../ipc/registerIntelligenceHandlers');
  delete require.cache[modulePath];
  const { registerIntelligenceHandlers } = await import('../ipc/registerIntelligenceHandlers');

  const registry = createHandlerRegistry();
  let receivedQuestion: string | undefined;
  let receivedConfidence: number | undefined;
  let receivedImagePaths: string[] | undefined;

  (harness.appState as any).getCoordinator = () => ({
    shouldManageLifecycle: () => true,
    getSupervisor: () => ({
      runWhatShouldISay: async (question?: string, confidence?: number, imagePaths?: string[]) => {
        receivedQuestion = question;
        receivedConfidence = confidence;
        receivedImagePaths = imagePaths;
        return 'answer from screenshot';
      },
    }),
  });

  registerIntelligenceHandlers({ appState: harness.appState as any, ...registry } as any);

  assert.deepEqual(await registry.handlers.get('generate-what-to-say')?.({}, undefined, [screenshotResult.data.path]), {
    answer: 'answer from screenshot',
    question: 'inferred from context',
    status: 'completed',
  });
  assert.equal(receivedQuestion, undefined);
  assert.equal(receivedConfidence, 0.8);
  assert.deepEqual(receivedImagePaths, [screenshotResult.data.path]);

  harness.restore();
});

test('intelligence handlers normalize reset failures when supervisor reset rejects', async () => {
  const modulePath = require.resolve('../ipc/registerIntelligenceHandlers');
  delete require.cache[modulePath];
  const { registerIntelligenceHandlers } = await import('../ipc/registerIntelligenceHandlers');

  const registry = createHandlerRegistry();
  const appState = {
    getCoordinator: () => ({
      shouldManageLifecycle: () => true,
      getSupervisor: () => ({
        reset: async () => {
          throw new Error('reset failed');
        },
      }),
    }),
    getIntelligenceManager: () => ({
      reset: async () => {
        throw new Error('legacy reset should not be used');
      },
    }),
  };

  registerIntelligenceHandlers({ appState: appState as any, ...registry } as any);

  assert.deepEqual(await registry.handlers.get('reset-intelligence')?.({}), {
    success: false,
    error: 'reset failed',
  });
});

test('window handlers preserve window control and resize contracts', async () => {
  const registry = createHandlerRegistry();
  const calls: string[] = [];
  const dimensionCalls: Array<{ target: 'settings' | 'overlay'; width: number; height: number }> = [];
  const clickthroughCalls: boolean[] = [];
  const settingsWindow = { isDestroyed: () => false, webContents: { id: 101 } };
  const overlayWindow = { isDestroyed: () => false, webContents: { id: 202 } };

  const appState = {
    settingsWindowHelper: {
      getSettingsWindow: () => settingsWindow,
      setWindowDimensions: (_window: unknown, width: number, height: number) => {
        dimensionCalls.push({ target: 'settings', width, height });
      },
    },
    getWindowHelper: (): {
      getOverlayWindow: () => typeof overlayWindow;
      getLauncherWindow: () => null;
      getLauncherContentWindow: () => null;
      setOverlayDimensions: (width: number, height: number) => void;
      setOverlayClickthrough: (enabled: boolean) => void;
      setWindowMode: (mode: string) => void;
    } => ({
      getOverlayWindow: () => overlayWindow,
      getLauncherWindow: () => null,
      getLauncherContentWindow: () => null,
      setOverlayDimensions: (width: number, height: number) => {
        dimensionCalls.push({ target: 'overlay', width, height });
      },
      setOverlayClickthrough: (enabled: boolean) => {
        clickthroughCalls.push(enabled);
      },
      setWindowMode: (mode: string) => {
        calls.push(`mode:${mode}`);
      },
    }),
    toggleMainWindow: () => calls.push('toggle'),
    showMainWindow: () => calls.push('show'),
    hideMainWindow: () => calls.push('hide'),
    moveWindowLeft: () => calls.push('left'),
    moveWindowRight: () => calls.push('right'),
    moveWindowUp: () => calls.push('up'),
    moveWindowDown: () => calls.push('down'),
    centerAndShowWindow: () => calls.push('center'),
  };

  const modulePath = require.resolve('../ipc/registerWindowHandlers');
  delete require.cache[modulePath];
  const { registerWindowHandlers } = await import('../ipc/registerWindowHandlers');

  registerWindowHandlers({ appState: appState as any, ...registry } as any);

  assert.deepEqual(await registry.handlers.get('set-window-mode')?.({}, 'overlay'), {
    success: true,
  });
  assert.deepEqual(await registry.handlers.get('set-overlay-clickthrough')?.({}, true), {
    success: true,
    data: { enabled: true },
  });
  assert.deepEqual(await registry.handlers.get('set-overlay-clickthrough')?.({}, false), {
    success: true,
    data: { enabled: false },
  });
  assert.deepEqual(await registry.handlers.get('toggle-window')?.({}), {
    success: true,
    data: null,
  });
  assert.deepEqual(await registry.handlers.get('show-window')?.({}), {
    success: true,
    data: null,
  });
  assert.deepEqual(await registry.handlers.get('hide-window')?.({}), {
    success: true,
    data: null,
  });
  assert.deepEqual(await registry.handlers.get('move-window-right')?.({}), {
    success: true,
    data: null,
  });
  assert.deepEqual(await registry.handlers.get('center-and-show-window')?.({}), {
    success: true,
    data: null,
  });

  await registry.handlers.get('update-content-dimensions')?.({ sender: { id: 101 } }, { width: 640, height: 480 });
  await registry.handlers.get('update-content-dimensions')?.({ sender: { id: 202 } }, { width: 720, height: 360 });

  assert.deepEqual(calls, ['mode:overlay', 'toggle', 'show', 'hide', 'right', 'center']);
  assert.deepEqual(clickthroughCalls, [true, false]);
  assert.deepEqual(dimensionCalls, [
    { target: 'settings', width: 640, height: 480 },
    { target: 'overlay', width: 720, height: 360 },
  ]);

  assert.throws(() => registry.handlers.get('set-overlay-clickthrough')?.({}, 'yes'), /Invalid IPC payload/);
});

test('window handlers prefer WindowFacade when available', async () => {
  const registry = createHandlerRegistry();
  const calls: string[] = [];
  const appState = {
    getWindowFacade: () => ({
      updateContentDimensions: (senderId: number, width: number, height: number) => {
        calls.push(`dimensions:${senderId}:${width}x${height}`);
      },
      setWindowMode: (mode: string) => {
        calls.push(`mode:${mode}`);
      },
      setOverlayClickthrough: (enabled: boolean) => {
        calls.push(`clickthrough:${enabled}`);
      },
      toggleMainWindow: () => {
        calls.push('toggle');
      },
      showMainWindow: () => {
        calls.push('show');
      },
      hideMainWindow: () => {
        calls.push('hide');
      },
      moveWindowLeft: () => {
        calls.push('left');
      },
      moveWindowRight: () => {
        calls.push('right');
      },
      moveWindowUp: () => {
        calls.push('up');
      },
      moveWindowDown: () => {
        calls.push('down');
      },
      centerAndShowWindow: () => {
        calls.push('center');
      },
    }),
    settingsWindowHelper: {
      getSettingsWindow: () => {
        throw new Error('legacy settings path should not be used');
      },
      setWindowDimensions: () => {
        throw new Error('legacy settings path should not be used');
      },
    },
    getWindowHelper: () => {
      throw new Error('legacy window helper path should not be used');
    },
    toggleMainWindow: () => {
      throw new Error('legacy toggle path should not be used');
    },
    showMainWindow: () => {
      throw new Error('legacy show path should not be used');
    },
    hideMainWindow: () => {
      throw new Error('legacy hide path should not be used');
    },
    moveWindowLeft: () => {
      throw new Error('legacy left path should not be used');
    },
    moveWindowRight: () => {
      throw new Error('legacy right path should not be used');
    },
    moveWindowUp: () => {
      throw new Error('legacy up path should not be used');
    },
    moveWindowDown: () => {
      throw new Error('legacy down path should not be used');
    },
    centerAndShowWindow: () => {
      throw new Error('legacy center path should not be used');
    },
  };

  const modulePath = require.resolve('../ipc/registerWindowHandlers');
  delete require.cache[modulePath];
  const { registerWindowHandlers } = await import('../ipc/registerWindowHandlers');
  registerWindowHandlers({ appState: appState as any, ...registry } as any);

  await registry.handlers.get('update-content-dimensions')?.({ sender: { id: 202 } }, { width: 720, height: 360 });
  assert.deepEqual(await registry.handlers.get('set-window-mode')?.({}, 'launcher'), { success: true });
  assert.deepEqual(await registry.handlers.get('set-overlay-clickthrough')?.({}, true), {
    success: true,
    data: { enabled: true },
  });
  assert.deepEqual(await registry.handlers.get('toggle-window')?.({}), { success: true, data: null });
  assert.deepEqual(await registry.handlers.get('show-window')?.({}), { success: true, data: null });
  assert.deepEqual(await registry.handlers.get('hide-window')?.({}), { success: true, data: null });
  assert.deepEqual(await registry.handlers.get('move-window-left')?.({}), { success: true, data: null });
  assert.deepEqual(await registry.handlers.get('move-window-right')?.({}), { success: true, data: null });
  assert.deepEqual(await registry.handlers.get('move-window-up')?.({}), { success: true, data: null });
  assert.deepEqual(await registry.handlers.get('move-window-down')?.({}), { success: true, data: null });
  assert.deepEqual(await registry.handlers.get('center-and-show-window')?.({}), { success: true, data: null });

  assert.deepEqual(calls, [
    'dimensions:202:720x360',
    'mode:launcher',
    'clickthrough:true',
    'toggle',
    'show',
    'hide',
    'left',
    'right',
    'up',
    'down',
    'center',
  ]);
});

test('profile handlers validate inputs and normalize errors', async () => {
  await withPatchedModules({
    electron: {
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
      },
    },
    '../services/CredentialsManager': {
      CredentialsManager: {
        getInstance: () => ({ getGoogleSearchApiKey: () => '', getGoogleSearchCseId: () => '' }),
      },
    },
    '../../premium/electron/knowledge/types': {
      DocType: { RESUME: 'resume', JD: 'jd' },
    },
  }, async () => {
    const modulePath = require.resolve('../ipc/registerProfileHandlers');
    delete require.cache[modulePath];
    const { registerProfileHandlers } = await import('../ipc/registerProfileHandlers');
    const registry = createHandlerRegistry();
    const appState = {
      getKnowledgeOrchestrator: (): null => null,
    };

    registerProfileHandlers({ appState: appState as any, ...registry } as any);

    assert.throws(() => registry.handlers.get('profile:upload-resume')?.({}, '   '), /Invalid IPC payload/);
    assert.deepEqual(await registry.handlers.get('profile:upload-resume')?.({}, '/tmp/resume.pdf'), {
      success: false,
      error: {
        code: 'PROFILE_ENGINE_UNAVAILABLE',
        message: 'Knowledge engine not initialized. Please ensure API keys are configured.',
      },
    });
    assert.deepEqual(await registry.handlers.get('profile:select-file')?.({}), {
      success: true,
      data: { cancelled: true },
    });
  });
});

test('rag handlers validate inputs and preload unwraps normalized rag and profile contracts', async () => {
  const modulePath = require.resolve('../ipc/registerRagHandlers');
  delete require.cache[modulePath];
  const { registerRagHandlers } = await import('../ipc/registerRagHandlers');
  const registry = createHandlerRegistry();
  const appState = {
    getRAGManager: (): null => null,
  };

  registerRagHandlers({ appState: appState as any, ...registry } as any);

  assert.throws(() => registry.handlers.get('rag:query-meeting')?.({ sender: { send: () => {} } }, { meetingId: '', query: 'hello' }), /Invalid IPC payload/);
  assert.deepEqual(await registry.handlers.get('rag:query-meeting')?.({ sender: { send: () => {} } }, { meetingId: 'meeting-1', query: 'hello' }), {
    success: true,
    data: { fallback: true },
  });

  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const { exposedApi, restore } = await loadPreloadModule(async (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });

    if (channel === 'get-undetectable') {
      return { success: true, data: { enabled: true } };
    }

    if (channel === 'profile:get-status') {
      return { success: true, data: { hasProfile: true, profileMode: false, name: 'Ada' } };
    }

    if (channel === 'profile:upload-resume') {
      return { success: false, error: { code: 'PROFILE_UPLOAD_FAILED', message: 'bad file' } };
    }

    if (channel === 'rag:query-live') {
      return { success: false, error: { code: 'RAG_QUERY_FAILED', message: 'stream failed' } };
    }

    throw new Error(`Unexpected channel: ${channel}`);
  });

  assert.equal(await exposedApi.getUndetectable(), true);
  assert.deepEqual(await exposedApi.profileGetStatus(), { hasProfile: true, profileMode: false, name: 'Ada' });
  assert.deepEqual(await exposedApi.profileUploadResume('/tmp/resume.pdf'), { success: false, error: 'bad file' });
  assert.deepEqual(await exposedApi.ragQueryLive('hello'), { success: false, error: 'stream failed' });
  assert.deepEqual(calls, [
    { channel: 'get-undetectable', args: [] },
    { channel: 'profile:get-status', args: [] },
    { channel: 'profile:upload-resume', args: ['/tmp/resume.pdf'] },
    { channel: 'rag:query-live', args: [{ query: 'hello' }] },
  ]);

  restore();
});

test('rag handlers prefer InferenceSupervisor RAG manager when supervisor runtime is enabled', async () => {
  const modulePath = require.resolve('../ipc/registerRagHandlers');
  delete require.cache[modulePath];
  const { registerRagHandlers } = await import('../ipc/registerRagHandlers');
  const registry = createHandlerRegistry();
  const senderEvents: Array<{ channel: string; payload: unknown }> = [];
  const calls: string[] = [];
  const appState = {
    getCoordinator: () => ({
      shouldManageLifecycle: () => true,
      getSupervisor: (name: string) => {
        assert.equal(name, 'inference');
        return {
          getRAGManager: () => ({
            isReady: () => true,
            isMeetingProcessed: (meetingId: string) => {
              calls.push(`processed:${meetingId}`);
              return true;
            },
            isLiveIndexingActive: () => false,
            async *queryMeeting(meetingId: string, query: string) {
              calls.push(`queryMeeting:${meetingId}:${query}`);
              yield 'chunk-1';
            },
            getQueueStatus: () => {
              calls.push('queueStatus');
              return { pending: 1, processing: 0, completed: 2, failed: 0 };
            },
          }),
        };
      },
    }),
    getRAGManager: () => {
      throw new Error('legacy rag path should not be used');
    },
  };

  registerRagHandlers({ appState: appState as any, ...registry } as any);

  assert.deepEqual(await registry.handlers.get('rag:query-meeting')?.({
    sender: {
      send: (channel: string, payload: unknown) => {
        senderEvents.push({ channel, payload });
      },
    },
  }, { meetingId: 'meeting-1', query: 'hello' }), {
    success: true,
    data: { success: true },
  });
  assert.deepEqual(await registry.handlers.get('rag:get-queue-status')?.({}), {
    success: true,
    data: { pending: 1, processing: 0, completed: 2, failed: 0 },
  });

  assert.deepEqual(senderEvents, [
    { channel: 'rag:stream-chunk', payload: { meetingId: 'meeting-1', chunk: 'chunk-1' } },
    { channel: 'rag:stream-complete', payload: { meetingId: 'meeting-1' } },
  ]);
  assert.deepEqual(calls, ['processed:meeting-1', 'queryMeeting:meeting-1:hello', 'queueStatus']);
});

test('profile handlers prefer InferenceSupervisor knowledge orchestrator when supervisor runtime is enabled', async () => {
  await withPatchedModules({
    electron: {
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/profile.pdf'] }),
      },
    },
    '../services/CredentialsManager': {
      CredentialsManager: {
        getInstance: () => ({
          getGoogleSearchApiKey: () => 'google-key',
          getGoogleSearchCseId: () => 'cse-id',
          setGoogleSearchApiKey: () => {},
          setGoogleSearchCseId: () => {},
        }),
      },
    },
    '../../premium/electron/knowledge/types': {
      DocType: {
        RESUME: 'resume',
        JD: 'jd',
      },
    },
    '../../premium/electron/knowledge/GoogleCustomSearchProvider': {
      GoogleCustomSearchProvider: class GoogleCustomSearchProvider {
        constructor(public readonly apiKey: string, public readonly cseId: string) {}
      },
    },
  }, async () => {
    const modulePath = require.resolve('../ipc/registerProfileHandlers');
    delete require.cache[modulePath];
    const { registerProfileHandlers } = await import('../ipc/registerProfileHandlers');
    const registry = createHandlerRegistry();
    const calls: string[] = [];
    const orchestrator = {
      ingestDocument: async (filePath: string, docType: string) => {
        calls.push(`ingest:${docType}:${filePath}`);
        return { ok: true, docType };
      },
      getStatus: () => {
        calls.push('status');
        return {
          hasResume: true,
          activeMode: true,
          resumeSummary: { name: 'Ada', role: 'Engineer', totalExperienceYears: 8 },
        };
      },
      setKnowledgeMode: (enabled: boolean) => {
        calls.push(`mode:${enabled}`);
      },
      deleteDocumentsByType: (docType: string) => {
        calls.push(`delete:${docType}`);
      },
      getProfileData: () => {
        calls.push('profileData');
        return {
          activeJD: {
            company: 'Acme',
            title: 'Platform Engineer',
            location: 'Remote',
            level: 'Senior',
            technologies: ['TypeScript'],
            requirements: ['Systems design'],
            keywords: ['platform'],
            compensation_hint: '$200k',
            min_years_experience: 5,
          },
        };
      },
      getCompanyResearchEngine: () => ({
        setSearchProvider: (_provider: unknown) => {
          calls.push('setSearchProvider');
        },
        researchCompany: async (companyName: string) => {
          calls.push(`research:${companyName}`);
          return { companyName, summary: 'researched' };
        },
        getCachedDossier: (companyName: string) => {
          calls.push(`cached:${companyName}`);
          return { companyName, summary: 'cached dossier' };
        },
      }),
    };
    const appState = {
      getCoordinator: () => ({
        shouldManageLifecycle: () => true,
        getSupervisor: (name: string) => {
          assert.equal(name, 'inference');
          return {
            getKnowledgeOrchestrator: () => orchestrator,
          };
        },
      }),
      getKnowledgeOrchestrator: () => {
        throw new Error('legacy knowledge path should not be used');
      },
    };

    registerProfileHandlers({ appState: appState as any, ...registry } as any);

    assert.deepEqual(await registry.handlers.get('profile:upload-resume')?.({}, '/tmp/resume.pdf'), {
      success: true,
      data: { ok: true, docType: 'resume' },
    });
    assert.deepEqual(await registry.handlers.get('profile:get-status')?.({}), {
      success: true,
      data: { hasProfile: true, profileMode: true, name: 'Ada', role: 'Engineer', totalExperienceYears: 8 },
    });
    assert.deepEqual(await registry.handlers.get('profile:set-mode')?.({}, false), {
      success: true,
      data: { success: true },
    });
    assert.deepEqual(await registry.handlers.get('profile:delete')?.({}), {
      success: true,
      data: { success: true },
    });
    assert.deepEqual(await registry.handlers.get('profile:get-profile')?.({}), {
      success: true,
      data: {
        activeJD: {
          company: 'Acme',
          title: 'Platform Engineer',
          location: 'Remote',
          level: 'Senior',
          technologies: ['TypeScript'],
          requirements: ['Systems design'],
          keywords: ['platform'],
          compensation_hint: '$200k',
          min_years_experience: 5,
        },
      },
    });
    assert.deepEqual(await registry.handlers.get('profile:upload-jd')?.({}, '/tmp/jd.pdf'), {
      success: true,
      data: { ok: true, docType: 'jd' },
    });
    assert.deepEqual(await registry.handlers.get('profile:delete-jd')?.({}), {
      success: true,
      data: { success: true },
    });
    assert.deepEqual(await registry.handlers.get('profile:research-company')?.({}, 'Acme'), {
      success: true,
      data: { success: true, dossier: { companyName: 'Acme', summary: 'researched' } },
    });
    assert.deepEqual(await registry.handlers.get('profile:generate-negotiation')?.({}), {
      success: true,
      data: {
        success: true,
        dossier: { companyName: 'Acme', summary: 'cached dossier' },
        profileData: {
          activeJD: {
            company: 'Acme',
            title: 'Platform Engineer',
            location: 'Remote',
            level: 'Senior',
            technologies: ['TypeScript'],
            requirements: ['Systems design'],
            keywords: ['platform'],
            compensation_hint: '$200k',
            min_years_experience: 5,
          },
        },
      },
    });

    assert.deepEqual(calls, [
      'ingest:resume:/tmp/resume.pdf',
      'status',
      'mode:false',
      'delete:resume',
      'profileData',
      'ingest:jd:/tmp/jd.pdf',
      'delete:jd',
      'setSearchProvider',
      'profileData',
      'research:Acme',
      'profileData',
      'status',
      'cached:Acme',
    ]);
  });
});
