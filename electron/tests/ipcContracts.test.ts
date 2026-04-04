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
    getCurrentProvider: () => 'gemini',
    getCurrentModel: () => 'gemini-3.1-flash-lite-preview',
    isUsingOllama: () => false,
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
    assert.deepEqual(await registry.handlers.get('set-open-at-login')?.({}, true), {
      success: true,
      data: { enabled: true },
    });
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
