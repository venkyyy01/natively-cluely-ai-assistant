import { contextBridge, ipcRenderer } from "electron"
import type { CustomProviderPayload, FastResponseConfig, FollowUpEmailInput, GeminiChatOptions, OverlayBounds, TranscriptTextEntry } from "../shared/ipc"

type IpcErrorContract = { code: string; message: string }
type IpcResult<T> = { success: true; data: T } | { success: false; error: IpcErrorContract }
type StatusResult = { success: boolean; error?: string }

const isIpcResult = <T>(value: unknown): value is IpcResult<T> => {
  return Boolean(value) && typeof value === 'object' && 'success' in (value as Record<string, unknown>)
}

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : 'IPC request failed'
}

const invokeAndUnwrap = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const result = await ipcRenderer.invoke(channel, ...args)
  if (!isIpcResult<T>(result)) {
    return result as T
  }

  if (result.success) {
    return result.data
  }

  throw new Error((result as { success: false; error: IpcErrorContract }).error.message)
}

const invokeVoid = async (channel: string, ...args: unknown[]): Promise<void> => {
  await invokeAndUnwrap<unknown>(channel, ...args)
}

const invokeStatus = async (channel: string, ...args: unknown[]): Promise<StatusResult> => {
  try {
    await invokeVoid(channel, ...args)
    return { success: true }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) }
  }
}

// Types for the exposed Electron API
interface ElectronAPI {
  updateContentDimensions: (dimensions: {
    width: number
    height: number
  }) => Promise<void>
  setOverlayBounds: (bounds: OverlayBounds) => Promise<{ success: boolean }>
  getRecognitionLanguages: () => Promise<Record<string, any>>
  getScreenshots: () => Promise<Array<{ path: string; preview: string }>>
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  onScreenshotTaken: (
    callback: (data: { path: string; preview: string }) => void
  ) => () => void
  onScreenshotAttached: (
    callback: (data: { path: string; preview: string }) => void
  ) => () => void
  onSolutionsReady: (callback: (solutions: string) => void) => () => void
  onResetView: (callback: () => void) => () => void
  onSolutionStart: (callback: () => void) => () => void
  onDebugStart: (callback: () => void) => () => void
  onDebugSuccess: (callback: (data: any) => void) => () => void
  onSolutionError: (callback: (error: string) => void) => () => void
  onProcessingNoScreenshots: (callback: () => void) => () => void
  onProblemExtracted: (callback: (data: any) => void) => () => void
  onSolutionSuccess: (callback: (data: any) => void) => () => void

  onUnauthorized: (callback: () => void) => () => void
  onDebugError: (callback: (error: string) => void) => () => void
  takeScreenshot: () => Promise<{ path: string; preview: string }>
  takeSelectiveScreenshot: () => Promise<{ path?: string; preview?: string; cancelled?: boolean }>
  moveWindowLeft: () => Promise<void>
  moveWindowRight: () => Promise<void>
  moveWindowUp: () => Promise<void>
  moveWindowDown: () => Promise<void>

  analyzeImageFile: (path: string) => Promise<unknown>
  quitApp: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  setUndetectable: (state: boolean) => Promise<StatusResult>
  getUndetectable: () => Promise<boolean>
  setConsciousMode: (enabled: boolean) => Promise<{ success: true; data: { enabled: boolean } } | { success: false; error: { code: string; message: string } }>
  getConsciousMode: () => Promise<{ success: true; data: { enabled: boolean } } | { success: false; error: { code: string; message: string } }>
  onConsciousModeChanged: (callback: (enabled: boolean) => void) => () => void
  setAccelerationMode: (enabled: boolean) => Promise<{ success: true; data: { enabled: boolean } } | { success: false; error: { code: string; message: string } }>
  getAccelerationMode: () => Promise<{ success: true; data: { enabled: boolean } } | { success: false; error: { code: string; message: string } }>
  onAccelerationModeChanged: (callback: (enabled: boolean) => void) => () => void
  setOpenAtLogin: (open: boolean) => Promise<StatusResult>
  getOpenAtLogin: () => Promise<boolean>
  closeSettingsWindow: () => Promise<void>
  setDisguise: (mode: 'terminal' | 'settings' | 'activity' | 'none') => Promise<StatusResult>
  getDisguise: () => Promise<'none' | 'terminal' | 'settings' | 'activity'>
  onDisguiseChanged: (callback: (mode: 'terminal' | 'settings' | 'activity' | 'none') => void) => () => void

  // LLM Model Management
  getCurrentLlmConfig: () => Promise<{ provider: "ollama" | "gemini"; model: string; isOllama: boolean }>
  getAvailableOllamaModels: () => Promise<string[]>
  switchToOllama: (model?: string, url?: string) => Promise<{ success: boolean; error?: string }>
  switchToGemini: (apiKey?: string, modelId?: string) => Promise<{ success: boolean; error?: string }>
  testLlmConnection: (provider: 'gemini' | 'groq' | 'openai' | 'claude' | 'cerebras', apiKey?: string) => Promise<{ success: boolean; error?: string }>
  selectServiceAccount: () => Promise<{ success: boolean; path?: string; cancelled?: boolean; error?: string }>

  // API Key Management
  setGeminiApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setGroqApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setCerebrasApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setOpenaiApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setClaudeApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  getStoredCredentials: () => Promise<{ hasGeminiKey: boolean; hasGroqKey: boolean; hasCerebrasKey: boolean; hasOpenaiKey: boolean; hasClaudeKey: boolean; googleServiceAccountPath: string | null; sttProvider: string; hasSttGroqKey: boolean; hasSttOpenaiKey: boolean; hasDeepgramKey: boolean; hasElevenLabsKey: boolean; hasAzureKey: boolean; azureRegion: string; hasIbmWatsonKey: boolean; ibmWatsonRegion: string; hasSonioxKey: boolean; hasGoogleSearchKey?: boolean; hasGoogleSearchCseId?: boolean; groqSttModel?: string; geminiPreferredModel?: string; groqPreferredModel?: string; cerebrasPreferredModel?: string; openaiPreferredModel?: string; claudePreferredModel?: string; fastResponseConfig?: FastResponseConfig }>

  // STT Provider Management
  setSttProvider: (provider: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox') => Promise<{ success: boolean; error?: string }>
  getSttProvider: () => Promise<string>
  setGroqSttApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setOpenAiSttApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setDeepgramApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setElevenLabsApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setAzureApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setAzureRegion: (region: string) => Promise<{ success: boolean; error?: string }>
  setIbmWatsonApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setGroqSttModel: (model: string) => Promise<{ success: boolean; error?: string }>
  setSonioxApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  testSttConnection: (provider: 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox', apiKey: string, region?: string) => Promise<{ success: boolean; error?: string }>

  // Native Audio Service Events
  onNativeAudioTranscript: (callback: (transcript: { speaker: string; text: string; final: boolean }) => void) => () => void
  onNativeAudioSuggestion: (callback: (suggestion: { context: string; lastQuestion: string; confidence: number }) => void) => () => void
  onNativeAudioConnected: (callback: () => void) => () => void
  onNativeAudioDisconnected: (callback: () => void) => () => void
  onSuggestionGenerated: (callback: (data: { question: string; suggestion: string; confidence: number }) => void) => () => void
  onSuggestionProcessingStart: (callback: () => void) => () => void
  onSuggestionError: (callback: (error: { error: string }) => void) => () => void
  onMeetingAudioError: (callback: (message: string) => void) => () => void
  generateSuggestion: (context: string, lastQuestion: string) => Promise<{ suggestion: string }>
  getNativeAudioStatus: () => Promise<{ connected: boolean }>
  getInputDevices: () => Promise<Array<{ id: string; name: string }>>
  getOutputDevices: () => Promise<Array<{ id: string; name: string }>>
  setRecognitionLanguage: (key: string) => Promise<{ success: boolean; error?: string }>
  getAiResponseLanguages: () => Promise<Array<{ label: string; code: string }>>
  setAiResponseLanguage: (language: string) => Promise<StatusResult>
  getSttLanguage: () => Promise<string>
  getAiResponseLanguage: () => Promise<string>

  // Intelligence Mode IPC
  generateAssist: () => Promise<{ insight: string | null }>
  generateWhatToSay: (question?: string, imagePaths?: string[]) => Promise<{ answer: string | null; question?: string; error?: string }>
  generateFollowUp: (intent: string, userRequest?: string) => Promise<{ refined: string | null; intent: string }>
  generateRecap: () => Promise<{ summary: string | null }>
  submitManualQuestion: (question: string) => Promise<{ answer: string | null; question: string }>
  getIntelligenceContext: () => Promise<{ context: string; lastAssistantMessage: string | null; activeMode: string }>
  resetIntelligence: () => Promise<{ success: boolean; error?: string }>

  // Meeting Lifecycle
  startMeeting: (metadata?: any) => Promise<{ success: boolean; error?: string }>
  endMeeting: () => Promise<{ success: boolean; error?: string }>
  finalizeMicSTT: () => Promise<void>
  getRecentMeetings: () => Promise<Array<{ id: string; title: string; date: string; duration: string; summary: string }>>
  getMeetingDetails: (id: string) => Promise<any>
  updateMeetingTitle: (id: string, title: string) => Promise<boolean>
  updateMeetingSummary: (id: string, updates: { overview?: string, actionItems?: string[], keyPoints?: string[], actionItemsTitle?: string, keyPointsTitle?: string }) => Promise<boolean>
  onMeetingsUpdated: (callback: () => void) => () => void

  // Intelligence Mode Events
  onIntelligenceAssistUpdate: (callback: (data: { insight: string }) => void) => () => void
  onIntelligenceSuggestedAnswer: (callback: (data: { answer: string; question: string; confidence: number }) => void) => () => void
  onIntelligenceRefinedAnswer: (callback: (data: { answer: string; intent: string }) => void) => () => void
  onIntelligenceRecap: (callback: (data: { summary: string }) => void) => () => void
  onIntelligenceManualStarted: (callback: () => void) => () => void
  onIntelligenceManualResult: (callback: (data: { answer: string; question: string }) => void) => () => void
  onIntelligenceModeChanged: (callback: (data: { mode: string }) => void) => () => void
  onIntelligenceError: (callback: (data: { error: string; mode: string }) => void) => () => void

  // Model Management
  getDefaultModel: () => Promise<{ model: string }>
  setModel: (modelId: string) => Promise<{ success: boolean; error?: string }>
  setDefaultModel: (modelId: string) => Promise<{ success: boolean; error?: string }>
  toggleModelSelector: (coords: { x: number; y: number }) => Promise<void>
  forceRestartOllama: () => Promise<void>

  // Settings Window
  toggleSettingsWindow: (coords?: { x: number; y: number }) => Promise<void>

  // Fast Response Mode
  getFastResponseConfig: () => Promise<FastResponseConfig>
  setFastResponseConfig: (config: FastResponseConfig) => Promise<{ success: boolean; error?: string }>

  // Demo
  seedDemo: () => Promise<{ success: boolean }>

  // Custom Providers
  saveCustomProvider: (provider: CustomProviderPayload) => Promise<{ success: boolean; id?: string; error?: string }>
  getCustomProviders: () => Promise<CustomProviderPayload[]>
  deleteCustomProvider: (id: string) => Promise<{ success: boolean; error?: string }>

  // Follow-up Email
  generateFollowupEmail: (input: FollowUpEmailInput) => Promise<string>
  extractEmailsFromTranscript: (transcript: TranscriptTextEntry[]) => Promise<string[]>
  getCalendarAttendees: (eventId: string) => Promise<Array<{ email: string; name: string }>>
  openMailto: (params: { to: string; subject: string; body: string }) => Promise<{ success: boolean; error?: string }>

  // Audio Test
  startAudioTest: (deviceId?: string) => Promise<{ success: boolean }>
  stopAudioTest: () => Promise<{ success: boolean }>
  onAudioTestLevel: (callback: (level: number) => void) => () => void

  // Database
  flushDatabase: () => Promise<{ success: boolean }>
  showWindow: () => Promise<void>
  hideWindow: () => Promise<void>
  onToggleExpand: (callback: () => void) => () => void
  toggleAdvancedSettings: () => Promise<void>

  // Streaming listeners
  streamGeminiChat: (message: string, imagePaths?: string[], context?: string, options?: GeminiChatOptions) => Promise<void>
  onGeminiStreamToken: (callback: (token: string) => void) => () => void
  onGeminiStreamDone: (callback: () => void) => () => void
  onGeminiStreamError: (callback: (error: string) => void) => () => void


  onUndetectableChanged: (callback: (state: boolean) => void) => () => void
  onFastResponseConfigChanged: (callback: (config: FastResponseConfig) => void) => () => void
  onModelChanged: (callback: (modelId: string) => void) => () => void
  onModelFallback: (callback: (event: { provider: 'gemini' | 'groq' | 'openai' | 'claude'; previousModel: string; fallbackModel: string; reason: string }) => void) => () => void

  // Ollama
  onOllamaPullProgress: (callback: (data: { status: string; percent: number }) => void) => () => void
  onOllamaPullComplete: (callback: () => void) => () => void

  // Theme API
  getThemeMode: () => Promise<{ mode: 'system' | 'light' | 'dark', resolved: 'light' | 'dark' }>
  setThemeMode: (mode: 'system' | 'light' | 'dark') => Promise<void>
  onThemeChanged: (callback: (data: { mode: 'system' | 'light' | 'dark', resolved: 'light' | 'dark' }) => void) => () => void

  // Calendar
  calendarConnect: () => Promise<{ success: boolean; error?: string }>
  calendarDisconnect: () => Promise<{ success: boolean; error?: string }>
  getCalendarStatus: () => Promise<{ connected: boolean; email?: string }>
  getUpcomingEvents: () => Promise<Array<{ id: string; title: string; startTime: string; endTime: string; link?: string; source: 'google' }>>
  calendarRefresh: () => Promise<{ success: boolean; error?: string }>

// RAG (Retrieval-Augmented Generation) API
  ragQueryMeeting: (meetingId: string, query: string) => Promise<{ success?: boolean; fallback?: boolean; error?: string }>
  ragQueryLive: (query: string) => Promise<{ success?: boolean; fallback?: boolean; error?: string }>
  ragQueryGlobal: (query: string) => Promise<{ success?: boolean; fallback?: boolean; error?: string }>
  ragCancelQuery: (options: { meetingId?: string; global?: boolean }) => Promise<StatusResult>
  ragIsMeetingProcessed: (meetingId: string) => Promise<boolean>
  ragGetQueueStatus: () => Promise<{ pending: number; processing: number; completed: number; failed: number }>
  ragRetryEmbeddings: () => Promise<StatusResult>
  onRAGStreamChunk: (callback: (data: { meetingId?: string; global?: boolean; chunk: string }) => void) => () => void
  onRAGStreamComplete: (callback: (data: { meetingId?: string; global?: boolean }) => void) => () => void
  onRAGStreamError: (callback: (data: { meetingId?: string; global?: boolean; error: string }) => void) => () => void

  // Keybind Management
  getKeybinds: () => Promise<Array<{ id: string; label: string; accelerator: string; isGlobal: boolean; defaultAccelerator: string }>>
  setKeybind: (id: string, accelerator: string) => Promise<boolean>
  resetKeybinds: () => Promise<Array<{ id: string; label: string; accelerator: string; isGlobal: boolean; defaultAccelerator: string }>>
  onKeybindsUpdate: (callback: (keybinds: Array<any>) => void) => () => void

  // Donation API
  getDonationStatus: () => Promise<{ shouldShow: boolean; hasDonated: boolean; lifetimeShows: number }>;
  markDonationToastShown: () => Promise<{ success: boolean }>;
  setDonationComplete: () => Promise<{ success: boolean }>;

  // Profile Engine API
  profileUploadResume: (filePath: string) => Promise<StatusResult>;
  profileGetStatus: () => Promise<{ hasProfile: boolean; profileMode: boolean; name?: string; role?: string; totalExperienceYears?: number }>;
  profileSetMode: (enabled: boolean) => Promise<StatusResult>;
  profileDelete: () => Promise<StatusResult>;
  profileGetProfile: () => Promise<any>;
  profileSelectFile: () => Promise<{ success?: boolean; cancelled?: boolean; filePath?: string; error?: string }>;

  // JD & Research API
  profileUploadJD: (filePath: string) => Promise<StatusResult>;
  profileDeleteJD: () => Promise<StatusResult>;
  profileResearchCompany: (companyName: string) => Promise<{ success: boolean; dossier?: any; error?: string }>;
  profileGenerateNegotiation: () => Promise<{ success: boolean; dossier?: any; profileData?: any; error?: string }>;

  // Google Search API
  setGoogleSearchApiKey: (apiKey: string) => Promise<StatusResult>;
  setGoogleSearchCseId: (cseId: string) => Promise<StatusResult>;

  // Overlay Opacity (Stealth Mode)
  setOverlayOpacity: (opacity: number) => Promise<void>;
  setOverlayClickthrough: (enabled: boolean) => Promise<void>;
  onOverlayClickthroughChanged: (callback: (enabled: boolean) => void) => () => void;
  onGlobalShortcutAction: (callback: (actionId: string) => void) => () => void;
  onOverlayOpacityChanged: (callback: (opacity: number) => void) => () => void;

  // Diagnostics
  logErrorToMain: (payload: any) => Promise<{ success: boolean; error?: string }>;
}

export const PROCESSING_EVENTS = {
  //global states
  UNAUTHORIZED: "procesing-unauthorized",
  NO_SCREENSHOTS: "processing-no-screenshots",

  //states for generating the initial solution
  INITIAL_START: "initial-start",
  PROBLEM_EXTRACTED: "problem-extracted",
  SOLUTION_SUCCESS: "solution-success",
  INITIAL_SOLUTION_ERROR: "solution-error",

  //states for processing the debugging
  DEBUG_START: "debug-start",
  DEBUG_SUCCESS: "debug-success",
  DEBUG_ERROR: "debug-error"
} as const

// Expose the Electron API to the renderer process
contextBridge.exposeInMainWorld("electronAPI", {
  updateContentDimensions: (dimensions: { width: number; height: number }) => {
    const width = Math.ceil(Number(dimensions?.width));
    const height = Math.ceil(Number(dimensions?.height));

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return Promise.resolve();
    }

    return ipcRenderer.invoke("update-content-dimensions", { width, height });
  },
  setOverlayBounds: (bounds: OverlayBounds) =>
    ipcRenderer.invoke("set-overlay-bounds", bounds),
  getRecognitionLanguages: () => invokeAndUnwrap<Record<string, any>>("get-recognition-languages"),
  takeScreenshot: () => invokeAndUnwrap<{ path: string; preview: string }>("take-screenshot"),
  takeSelectiveScreenshot: () => invokeAndUnwrap<{ path?: string; preview?: string; cancelled?: boolean }>("take-selective-screenshot"),
  getScreenshots: () => invokeAndUnwrap<Array<{ path: string; preview: string }>>("get-screenshots"),
  deleteScreenshot: (path: string) =>
    ipcRenderer.invoke("delete-screenshot", path),

  // Event listeners
  onScreenshotTaken: (
    callback: (data: { path: string; preview: string }) => void
  ) => {
    const subscription = (_: any, data: { path: string; preview: string }) =>
      callback(data)
    ipcRenderer.on("screenshot-taken", subscription)
    return () => {
      ipcRenderer.removeListener("screenshot-taken", subscription)
    }
  },
  onScreenshotAttached: (
    callback: (data: { path: string; preview: string }) => void
  ) => {
    const subscription = (_: any, data: { path: string; preview: string }) =>
      callback(data)
    ipcRenderer.on("screenshot-attached", subscription)
    return () => {
      ipcRenderer.removeListener("screenshot-attached", subscription)
    }
  },
  onSolutionsReady: (callback: (solutions: string) => void) => {
    const subscription = (_: any, solutions: string) => callback(solutions)
    ipcRenderer.on("solutions-ready", subscription)
    return () => {
      ipcRenderer.removeListener("solutions-ready", subscription)
    }
  },
  onResetView: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("reset-view", subscription)
    return () => {
      ipcRenderer.removeListener("reset-view", subscription)
    }
  },
  onSolutionStart: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.INITIAL_START, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.INITIAL_START, subscription)
    }
  },
  onDebugStart: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.DEBUG_START, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.DEBUG_START, subscription)
    }
  },

  onDebugSuccess: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("debug-success", subscription)
    return () => {
      ipcRenderer.removeListener("debug-success", subscription)
    }
  },
  onDebugError: (callback: (error: string) => void) => {
    const subscription = (_: any, error: string) => callback(error)
    ipcRenderer.on(PROCESSING_EVENTS.DEBUG_ERROR, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.DEBUG_ERROR, subscription)
    }
  },
  onSolutionError: (callback: (error: string) => void) => {
    const subscription = (_: any, error: string) => callback(error)
    ipcRenderer.on(PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
        subscription
      )
    }
  },
  onProcessingNoScreenshots: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
    }
  },

  onProblemExtracted: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on(PROCESSING_EVENTS.PROBLEM_EXTRACTED, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.PROBLEM_EXTRACTED,
        subscription
      )
    }
  },
  onSolutionSuccess: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on(PROCESSING_EVENTS.SOLUTION_SUCCESS, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.SOLUTION_SUCCESS,
        subscription
      )
    }
  },
  onUnauthorized: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
    }
  },
  moveWindowLeft: () => invokeVoid("move-window-left"),
  moveWindowRight: () => invokeVoid("move-window-right"),
  moveWindowUp: () => invokeVoid("move-window-up"),
  moveWindowDown: () => invokeVoid("move-window-down"),

  analyzeImageFile: (path: string) => invokeAndUnwrap<unknown>("analyze-image-file", path),
  quitApp: () => invokeVoid("quit-app"),
  toggleWindow: () => invokeVoid("toggle-window"),
  showWindow: () => invokeVoid("show-window"),
  hideWindow: () => invokeVoid("hide-window"),
  toggleAdvancedSettings: () => ipcRenderer.invoke("toggle-advanced-settings"),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  setUndetectable: (state: boolean) => invokeStatus("set-undetectable", state),
  getUndetectable: async () => (await invokeAndUnwrap<{ enabled: boolean }>("get-undetectable")).enabled,
setConsciousMode: (enabled: boolean) => ipcRenderer.invoke('set-conscious-mode', enabled),
getConsciousMode: () => ipcRenderer.invoke('get-conscious-mode'),
onConsciousModeChanged: (callback: (enabled: boolean) => void) => {
  const subscription = (_: any, enabled: boolean) => callback(enabled)
  ipcRenderer.on('conscious-mode-changed', subscription)
  return () => {
    ipcRenderer.removeListener('conscious-mode-changed', subscription)
  }
},
setAccelerationMode: (enabled: boolean) => ipcRenderer.invoke('set-acceleration-mode', enabled),
getAccelerationMode: () => ipcRenderer.invoke('get-acceleration-mode'),
onAccelerationModeChanged: (callback: (enabled: boolean) => void) => {
  const subscription = (_: any, enabled: boolean) => callback(enabled)
  ipcRenderer.on('acceleration-mode-changed', subscription)
  return () => {
    ipcRenderer.removeListener('acceleration-mode-changed', subscription)
  }
},
setOpenAtLogin: (open: boolean) => invokeStatus("set-open-at-login", open),
  getOpenAtLogin: async () => (await invokeAndUnwrap<{ enabled: boolean }>("get-open-at-login")).enabled,
  closeSettingsWindow: () => invokeVoid('close-settings-window'),
  setDisguise: (mode: 'terminal' | 'settings' | 'activity' | 'none') => invokeStatus("set-disguise", mode),
  getDisguise: async () => (await invokeAndUnwrap<{ mode: 'none' | 'terminal' | 'settings' | 'activity' }>("get-disguise")).mode,
  onDisguiseChanged: (callback: (mode: 'terminal' | 'settings' | 'activity' | 'none') => void) => {
    const subscription = (_: any, mode: any) => callback(mode)
    ipcRenderer.on('disguise-changed', subscription)
    return () => {
      ipcRenderer.removeListener('disguise-changed', subscription)
    }
  },

  onSettingsVisibilityChange: (callback: (isVisible: boolean) => void) => {
    const subscription = (_: any, isVisible: boolean) => callback(isVisible)
    ipcRenderer.on("settings-visibility-changed", subscription)
    return () => {
      ipcRenderer.removeListener("settings-visibility-changed", subscription)
    }
  },

  onToggleExpand: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("toggle-expand", subscription)
    return () => {
      ipcRenderer.removeListener("toggle-expand", subscription)
    }
  },

  // LLM Model Management
  getCurrentLlmConfig: () => invokeAndUnwrap<{ provider: "ollama" | "gemini"; model: string; isOllama: boolean }>("get-current-llm-config"),
  getAvailableOllamaModels: () => invokeAndUnwrap<string[]>("get-available-ollama-models"),
  switchToOllama: (model?: string, url?: string) => ipcRenderer.invoke("switch-to-ollama", model, url),
  switchToGemini: (apiKey?: string, modelId?: string) => ipcRenderer.invoke("switch-to-gemini", apiKey, modelId),
  testLlmConnection: (provider: 'gemini' | 'groq' | 'openai' | 'claude' | 'cerebras', apiKey: string) => ipcRenderer.invoke("test-llm-connection", provider, apiKey),
  selectServiceAccount: async () => {
    try {
      const data = await invokeAndUnwrap<{ path?: string; cancelled?: boolean }>("select-service-account")
      return { success: true, ...data }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  },

  // API Key Management
  setGeminiApiKey: (apiKey: string) => ipcRenderer.invoke("set-gemini-api-key", apiKey),
  setGroqApiKey: (apiKey: string) => ipcRenderer.invoke("set-groq-api-key", apiKey),
  setCerebrasApiKey: (apiKey: string) => ipcRenderer.invoke("set-cerebras-api-key", apiKey),
  setOpenaiApiKey: (apiKey: string) => ipcRenderer.invoke("set-openai-api-key", apiKey),
  setClaudeApiKey: (apiKey: string) => ipcRenderer.invoke("set-claude-api-key", apiKey),
  getStoredCredentials: () => invokeAndUnwrap("get-stored-credentials"),

  // STT Provider Management
  setSttProvider: (provider: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox') => ipcRenderer.invoke("set-stt-provider", provider),
  getSttProvider: () => invokeAndUnwrap<string>("get-stt-provider"),
  setGroqSttApiKey: (apiKey: string) => ipcRenderer.invoke("set-groq-stt-api-key", apiKey),
  setOpenAiSttApiKey: (apiKey: string) => ipcRenderer.invoke("set-openai-stt-api-key", apiKey),
  setDeepgramApiKey: (apiKey: string) => ipcRenderer.invoke("set-deepgram-api-key", apiKey),
  setElevenLabsApiKey: (apiKey: string) => ipcRenderer.invoke("set-elevenlabs-api-key", apiKey),
  setAzureApiKey: (apiKey: string) => ipcRenderer.invoke("set-azure-api-key", apiKey),
  setAzureRegion: (region: string) => ipcRenderer.invoke("set-azure-region", region),
  setIbmWatsonApiKey: (apiKey: string) => ipcRenderer.invoke("set-ibmwatson-api-key", apiKey),
  setGroqSttModel: (model: string) => ipcRenderer.invoke("set-groq-stt-model", model),
  setSonioxApiKey: (apiKey: string) => ipcRenderer.invoke("set-soniox-api-key", apiKey),
  testSttConnection: (provider: 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox', apiKey: string, region?: string) => ipcRenderer.invoke("test-stt-connection", provider, apiKey, region),

  // Native Audio Service Events
  onNativeAudioTranscript: (callback: (transcript: { speaker: string; text: string; final: boolean }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("native-audio-transcript", subscription)
    return () => {
      ipcRenderer.removeListener("native-audio-transcript", subscription)
    }
  },
  onNativeAudioSuggestion: (callback: (suggestion: { context: string; lastQuestion: string; confidence: number }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("native-audio-suggestion", subscription)
    return () => {
      ipcRenderer.removeListener("native-audio-suggestion", subscription)
    }
  },
  onNativeAudioConnected: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("native-audio-connected", subscription)
    return () => {
      ipcRenderer.removeListener("native-audio-connected", subscription)
    }
  },
  onNativeAudioDisconnected: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("native-audio-disconnected", subscription)
    return () => {
      ipcRenderer.removeListener("native-audio-disconnected", subscription)
    }
  },
  onSuggestionGenerated: (callback: (data: { question: string; suggestion: string; confidence: number }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("suggestion-generated", subscription)
    return () => {
      ipcRenderer.removeListener("suggestion-generated", subscription)
    }
  },
  onSuggestionProcessingStart: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("suggestion-processing-start", subscription)
    return () => {
      ipcRenderer.removeListener("suggestion-processing-start", subscription)
    }
  },
  onSuggestionError: (callback: (error: { error: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("suggestion-error", subscription)
    return () => {
      ipcRenderer.removeListener("suggestion-error", subscription)
    }
  },
  onMeetingAudioError: (callback: (message: string) => void) => {
    const subscription = (_: any, data: string) => callback(data)
    ipcRenderer.on("meeting-audio-error", subscription)
    return () => {
      ipcRenderer.removeListener("meeting-audio-error", subscription)
    }
  },
  generateSuggestion: (context: string, lastQuestion: string) =>
    invokeAndUnwrap<{ suggestion: string }>("generate-suggestion", context, lastQuestion),

  getNativeAudioStatus: () => invokeAndUnwrap<{ connected: boolean }>("native-audio-status"),
  getInputDevices: () => ipcRenderer.invoke("get-input-devices"),
  getOutputDevices: () => ipcRenderer.invoke("get-output-devices"),
  setRecognitionLanguage: (key: string) => ipcRenderer.invoke("set-recognition-language", key),
  getAiResponseLanguages: () => invokeAndUnwrap<Array<{ label: string; code: string }>>("get-ai-response-languages"),
  setAiResponseLanguage: (language: string) => invokeStatus("set-ai-response-language", language),
  getSttLanguage: async () => (await invokeAndUnwrap<{ language: string }>("get-stt-language")).language,
  getAiResponseLanguage: async () => (await invokeAndUnwrap<{ language: string }>("get-ai-response-language")).language,

  // Intelligence Mode IPC
  generateAssist: () => ipcRenderer.invoke("generate-assist"),
  generateWhatToSay: (question?: string, imagePaths?: string[]) => ipcRenderer.invoke("generate-what-to-say", question, imagePaths),
  generateFollowUp: (intent: string, userRequest?: string) => ipcRenderer.invoke("generate-follow-up", intent, userRequest),
  generateFollowUpQuestions: () => ipcRenderer.invoke("generate-follow-up-questions"),
  generateRecap: () => ipcRenderer.invoke("generate-recap"),
  submitManualQuestion: (question: string) => ipcRenderer.invoke("submit-manual-question", question),
  getIntelligenceContext: () => ipcRenderer.invoke("get-intelligence-context"),
  resetIntelligence: () => ipcRenderer.invoke("reset-intelligence"),

  // Meeting Lifecycle
  startMeeting: (metadata?: any) => ipcRenderer.invoke("start-meeting", metadata),
  endMeeting: () => ipcRenderer.invoke("end-meeting"),
  finalizeMicSTT: () => invokeVoid("finalize-mic-stt"),
  getRecentMeetings: () => ipcRenderer.invoke("get-recent-meetings"),
  getMeetingDetails: (id: string) => ipcRenderer.invoke("get-meeting-details", id),
  updateMeetingTitle: (id: string, title: string) => ipcRenderer.invoke("update-meeting-title", { id, title }),
  updateMeetingSummary: (id: string, updates: any) => ipcRenderer.invoke("update-meeting-summary", { id, updates }),
  deleteMeeting: (id: string) => ipcRenderer.invoke("delete-meeting", id),

  onMeetingsUpdated: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("meetings-updated", subscription)
    return () => {
      ipcRenderer.removeListener("meetings-updated", subscription)
    }
  },

  // Window Mode
  setWindowMode: (mode: 'launcher' | 'overlay') => ipcRenderer.invoke("set-window-mode", mode),
  setOverlayClickthrough: (enabled: boolean) => invokeVoid('set-overlay-clickthrough', enabled),
  onOverlayClickthroughChanged: (callback: (enabled: boolean) => void) => {
    const subscription = (_: any, enabled: boolean) => callback(enabled)
    ipcRenderer.on('overlay-clickthrough-changed', subscription)
    return () => {
      ipcRenderer.removeListener('overlay-clickthrough-changed', subscription)
    }
  },

  onGlobalShortcutAction: (callback: (actionId: string) => void) => {
    const subscription = (_: any, actionId: string) => callback(actionId)
    ipcRenderer.on('global-shortcut-action', subscription)
    return () => {
      ipcRenderer.removeListener('global-shortcut-action', subscription)
    }
  },

  // Intelligence Mode Events
  onIntelligenceAssistUpdate: (callback: (data: { insight: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-assist-update", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-assist-update", subscription)
    }
  },
  onIntelligenceSuggestedAnswerToken: (callback: (data: { token: string; question: string; confidence: number }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-suggested-answer-token", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-suggested-answer-token", subscription)
    }
  },
  onIntelligenceSuggestedAnswer: (callback: (data: { answer: string; question: string; confidence: number }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-suggested-answer", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-suggested-answer", subscription)
    }
  },
  onIntelligenceRefinedAnswerToken: (callback: (data: { token: string; intent: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-refined-answer-token", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-refined-answer-token", subscription)
    }
  },
  onIntelligenceRefinedAnswer: (callback: (data: { answer: string; intent: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-refined-answer", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-refined-answer", subscription)
    }
  },
  onIntelligenceRecapToken: (callback: (data: { token: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-recap-token", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-recap-token", subscription)
    }
  },
  onIntelligenceRecap: (callback: (data: { summary: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-recap", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-recap", subscription)
    }
  },
  onIntelligenceFollowUpQuestionsToken: (callback: (data: { token: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-follow-up-questions-token", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-follow-up-questions-token", subscription)
    }
  },
  onIntelligenceFollowUpQuestionsUpdate: (callback: (data: { questions: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-follow-up-questions-update", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-follow-up-questions-update", subscription)
    }
  },
  onIntelligenceManualStarted: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("intelligence-manual-started", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-manual-started", subscription)
    }
  },
  onIntelligenceManualResult: (callback: (data: { answer: string; question: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-manual-result", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-manual-result", subscription)
    }
  },
  onIntelligenceModeChanged: (callback: (data: { mode: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-mode-changed", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-mode-changed", subscription)
    }
  },
  onIntelligenceError: (callback: (data: { error: string; mode: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-error", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-error", subscription)
    }
  },
  onSessionReset: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("session-reset", subscription)
    return () => {
      ipcRenderer.removeListener("session-reset", subscription)
    }
  },


  // Streaming Chat
  streamGeminiChat: (message: string, imagePaths?: string[], context?: string, options?: GeminiChatOptions) => ipcRenderer.invoke("gemini-chat-stream", message, imagePaths, context, options),

  onGeminiStreamToken: (callback: (token: string) => void) => {
    const subscription = (_: any, token: string) => callback(token)
    ipcRenderer.on("gemini-stream-token", subscription)
    return () => {
      ipcRenderer.removeListener("gemini-stream-token", subscription)
    }
  },

  onGeminiStreamDone: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("gemini-stream-done", subscription)
    return () => {
      ipcRenderer.removeListener("gemini-stream-done", subscription)
    }
  },

  onGeminiStreamError: (callback: (error: string) => void) => {
    const subscription = (_: any, error: string) => callback(error)
    ipcRenderer.on("gemini-stream-error", subscription)
    return () => {
      ipcRenderer.removeListener("gemini-stream-error", subscription)
    }
  },

  // Model Management
  getDefaultModel: () => invokeAndUnwrap<{ model: string }>('get-default-model'),
  setModel: (modelId: string) => ipcRenderer.invoke('set-model', modelId),
  setDefaultModel: (modelId: string) => ipcRenderer.invoke('set-default-model', modelId),
  toggleModelSelector: (coords: { x: number; y: number }) => ipcRenderer.invoke('toggle-model-selector', coords),
  forceRestartOllama: () => invokeVoid('force-restart-ollama'),

  // Settings Window
  toggleSettingsWindow: (coords?: { x: number; y: number }) => invokeVoid('toggle-settings-window', coords),

  // Fast Response Mode
  getFastResponseConfig: () => invokeAndUnwrap<FastResponseConfig>('get-fast-response-config'),
  setFastResponseConfig: (config: FastResponseConfig) => ipcRenderer.invoke('set-fast-response-config', config),

  // Demo
  seedDemo: () => ipcRenderer.invoke('seed-demo'),

  // Custom Providers
  saveCustomProvider: (provider: CustomProviderPayload) => ipcRenderer.invoke('save-custom-provider', provider),
  getCustomProviders: () => invokeAndUnwrap<CustomProviderPayload[]>('get-custom-providers'),
  deleteCustomProvider: (id: string) => ipcRenderer.invoke('delete-custom-provider', id),

  // Follow-up Email
  generateFollowupEmail: (input: FollowUpEmailInput) => ipcRenderer.invoke('generate-followup-email', input),
  extractEmailsFromTranscript: (transcript: TranscriptTextEntry[]) => ipcRenderer.invoke('extract-emails-from-transcript', transcript),
  getCalendarAttendees: (eventId: string) => ipcRenderer.invoke('get-calendar-attendees', eventId),
  openMailto: (params: { to: string; subject: string; body: string }) => ipcRenderer.invoke('open-mailto', params),

  // Audio Test
  startAudioTest: (deviceId?: string) => ipcRenderer.invoke('start-audio-test', deviceId),
  stopAudioTest: () => ipcRenderer.invoke('stop-audio-test'),
  onAudioTestLevel: (callback: (level: number) => void) => {
    const subscription = (_: any, level: number) => callback(level)
    ipcRenderer.on('audio-test-level', subscription)
    return () => {
      ipcRenderer.removeListener('audio-test-level', subscription)
    }
  },

  // Database
  flushDatabase: () => ipcRenderer.invoke('flush-database'),



  onUndetectableChanged: (callback: (state: boolean) => void) => {
    const subscription = (_: any, state: boolean) => callback(state)
    ipcRenderer.on('undetectable-changed', subscription)
    return () => {
      ipcRenderer.removeListener('undetectable-changed', subscription)
    }
  },

  onFastResponseConfigChanged: (callback: (config: FastResponseConfig) => void) => {
    const subscription = (_: any, config: FastResponseConfig) => callback(config)
    ipcRenderer.on('fast-response-config-changed', subscription)
    return () => {
      ipcRenderer.removeListener('fast-response-config-changed', subscription)
    }
  },

  onModelChanged: (callback: (modelId: string) => void) => {
    const subscription = (_: any, modelId: string) => callback(modelId)
    ipcRenderer.on('model-changed', subscription)
    return () => {
      ipcRenderer.removeListener('model-changed', subscription)
    }
  },

  onModelFallback: (callback: (event: { provider: 'gemini' | 'groq' | 'openai' | 'claude'; previousModel: string; fallbackModel: string; reason: string }) => void) => {
    const subscription = (_: any, event: { provider: 'gemini' | 'groq' | 'openai' | 'claude'; previousModel: string; fallbackModel: string; reason: string }) => callback(event)
    ipcRenderer.on('model-fallback', subscription)
    return () => {
      ipcRenderer.removeListener('model-fallback', subscription)
    }
  },

  onOllamaPullProgress: (callback: (data: { status: string; percent: number }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on('ollama:pull-progress', subscription)
    return () => {
      ipcRenderer.removeListener('ollama:pull-progress', subscription)
    }
  },

  onOllamaPullComplete: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on('ollama:pull-complete', subscription)
    return () => {
      ipcRenderer.removeListener('ollama:pull-complete', subscription)
    }
  },

  // Theme API
  getThemeMode: () => invokeAndUnwrap<{ mode: 'system' | 'light' | 'dark', resolved: 'light' | 'dark' }>('theme:get-mode'),
  setThemeMode: (mode: 'system' | 'light' | 'dark') => ipcRenderer.invoke('theme:set-mode', mode),
  onThemeChanged: (callback: (data: { mode: 'system' | 'light' | 'dark', resolved: 'light' | 'dark' }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on('theme:changed', subscription)
    return () => {
      ipcRenderer.removeListener('theme:changed', subscription)
    }
  },

  // Calendar API
  calendarConnect: () => ipcRenderer.invoke('calendar-connect'),
  calendarDisconnect: () => ipcRenderer.invoke('calendar-disconnect'),
  getCalendarStatus: () => ipcRenderer.invoke('get-calendar-status'),
  getUpcomingEvents: () => ipcRenderer.invoke('get-upcoming-events'),
  calendarRefresh: () => ipcRenderer.invoke('calendar-refresh'),

// RAG API
  ragQueryMeeting: async (meetingId: string, query: string) => {
    try {
      return await invokeAndUnwrap<{ success?: boolean; fallback?: boolean }>('rag:query-meeting', { meetingId, query })
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  },
  ragQueryLive: async (query: string) => {
    try {
      return await invokeAndUnwrap<{ success?: boolean; fallback?: boolean }>('rag:query-live', { query })
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  },
  ragQueryGlobal: async (query: string) => {
    try {
      return await invokeAndUnwrap<{ success?: boolean; fallback?: boolean }>('rag:query-global', { query })
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  },
  ragCancelQuery: (options: { meetingId?: string; global?: boolean }) => invokeStatus('rag:cancel-query', options),
  ragIsMeetingProcessed: (meetingId: string) => invokeAndUnwrap<boolean>('rag:is-meeting-processed', meetingId),
  ragGetQueueStatus: () => invokeAndUnwrap<{ pending: number; processing: number; completed: number; failed: number }>('rag:get-queue-status'),
  ragRetryEmbeddings: () => invokeStatus('rag:retry-embeddings'),

  onIncompatibleProviderWarning: (callback: (data: { count: number, oldProvider: string, newProvider: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on('embedding:incompatible-provider-warning', subscription)
    return () => {
      ipcRenderer.removeListener('embedding:incompatible-provider-warning', subscription)
    }
  },
  reindexIncompatibleMeetings: () => invokeVoid('rag:reindex-incompatible-meetings'),

  onRAGStreamChunk: (callback: (data: { meetingId?: string; global?: boolean; chunk: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on('rag:stream-chunk', subscription)
    return () => {
      ipcRenderer.removeListener('rag:stream-chunk', subscription)
    }
  },
  onRAGStreamComplete: (callback: (data: { meetingId?: string; global?: boolean }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on('rag:stream-complete', subscription)
    return () => {
      ipcRenderer.removeListener('rag:stream-complete', subscription)
    }
  },
  onRAGStreamError: (callback: (data: { meetingId?: string; global?: boolean; error: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on('rag:stream-error', subscription)
    return () => {
      ipcRenderer.removeListener('rag:stream-error', subscription)
    }
  },

  // Keybind Management
  getKeybinds: () => ipcRenderer.invoke('keybinds:get-all'),
  setKeybind: (id: string, accelerator: string) => ipcRenderer.invoke('keybinds:set', id, accelerator),
  resetKeybinds: () => ipcRenderer.invoke('keybinds:reset'),
  onKeybindsUpdate: (callback: (keybinds: Array<any>) => void) => {
    const subscription = (_: any, keybinds: any) => callback(keybinds)
    ipcRenderer.on('keybinds:update', subscription)
    return () => {
      ipcRenderer.removeListener('keybinds:update', subscription)
    }
  },

  // Donation API
  getDonationStatus: () => ipcRenderer.invoke("get-donation-status"),
  markDonationToastShown: () => ipcRenderer.invoke("mark-donation-toast-shown"),
  setDonationComplete: () => ipcRenderer.invoke('set-donation-complete'),

  // Profile Engine API
  profileUploadResume: (filePath: string) => invokeStatus('profile:upload-resume', filePath),
  profileGetStatus: () => invokeAndUnwrap<{ hasProfile: boolean; profileMode: boolean; name?: string; role?: string; totalExperienceYears?: number }>('profile:get-status'),
  profileSetMode: (enabled: boolean) => invokeStatus('profile:set-mode', enabled),
  profileDelete: () => invokeStatus('profile:delete'),
  profileGetProfile: () => invokeAndUnwrap<any>('profile:get-profile'),
  profileSelectFile: async () => {
    try {
      const data = await invokeAndUnwrap<{ cancelled?: boolean; filePath?: string }>('profile:select-file')
      if (data.cancelled) {
        return { cancelled: true }
      }
      return { success: true, ...data }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  },

  // JD & Research API
  profileUploadJD: (filePath: string) => invokeStatus('profile:upload-jd', filePath),
  profileDeleteJD: () => invokeStatus('profile:delete-jd'),
  profileResearchCompany: async (companyName: string) => {
    try {
      return await invokeAndUnwrap<{ success: boolean; dossier?: any }>('profile:research-company', companyName)
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  },
  profileGenerateNegotiation: async () => {
    try {
      return await invokeAndUnwrap<{ success: boolean; dossier?: any; profileData?: any }>('profile:generate-negotiation')
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  },

  // Google Search API
  setGoogleSearchApiKey: (apiKey: string) => invokeStatus('set-google-search-api-key', apiKey),
  setGoogleSearchCseId: (cseId: string) => invokeStatus('set-google-search-cse-id', cseId),

  // Dynamic Model Discovery
  fetchProviderModels: (provider: 'gemini' | 'groq' | 'openai' | 'claude' | 'cerebras', apiKey: string) => ipcRenderer.invoke('fetch-provider-models', provider, apiKey),
  setProviderPreferredModel: (provider: 'gemini' | 'groq' | 'openai' | 'claude' | 'cerebras', modelId: string) => ipcRenderer.invoke('set-provider-preferred-model', provider, modelId),

  // License Management
  licenseActivate: (key: string) => ipcRenderer.invoke('license:activate', key),
  licenseCheckPremium: () => ipcRenderer.invoke('license:check-premium'),
  licenseDeactivate: () => ipcRenderer.invoke('license:deactivate'),
  licenseGetHardwareId: () => ipcRenderer.invoke('license:get-hardware-id'),

  // Overlay Opacity (Stealth Mode)
  setOverlayOpacity: (opacity: number) => invokeVoid('set-overlay-opacity', opacity),
  onOverlayOpacityChanged: (callback: (opacity: number) => void) => {
    const subscription = (_: any, opacity: number) => callback(opacity)
    ipcRenderer.on('overlay-opacity-changed', subscription)
    return () => {
      ipcRenderer.removeListener('overlay-opacity-changed', subscription)
    }
  },

  // Diagnostics
  logErrorToMain: (payload: any) => ipcRenderer.invoke('renderer:log-error', payload),
} as ElectronAPI)
