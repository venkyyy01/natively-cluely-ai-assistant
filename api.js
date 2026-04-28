"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROCESSING_EVENTS = void 0;
const electron_1 = require("electron");
const types_1 = require("./types");
exports.PROCESSING_EVENTS = {
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
};
// Expose the Electron API to the renderer process
electron_1.contextBridge.exposeInMainWorld("electronAPI", {
    updateContentDimensions: (dimensions) => electron_1.ipcRenderer.invoke("update-content-dimensions", dimensions),
    setOverlayBounds: (bounds) => electron_1.ipcRenderer.invoke("set-overlay-bounds", bounds),
    getRecognitionLanguages: () => (0, types_1.invokeAndUnwrap)("get-recognition-languages"),
    takeScreenshot: () => (0, types_1.invokeAndUnwrap)("take-screenshot"),
    takeSelectiveScreenshot: () => (0, types_1.invokeAndUnwrap)("take-selective-screenshot"),
    getScreenshots: () => (0, types_1.invokeAndUnwrap)("get-screenshots"),
    deleteScreenshot: (path) => electron_1.ipcRenderer.invoke("delete-screenshot", path),
    // Event listeners
    onScreenshotTaken: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("screenshot-taken", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("screenshot-taken", subscription);
        };
    },
    onScreenshotAttached: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("screenshot-attached", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("screenshot-attached", subscription);
        };
    },
    onSolutionsReady: (callback) => {
        const subscription = (_, solutions) => callback(solutions);
        electron_1.ipcRenderer.on("solutions-ready", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("solutions-ready", subscription);
        };
    },
    onResetView: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on("reset-view", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("reset-view", subscription);
        };
    },
    onSolutionStart: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on(exports.PROCESSING_EVENTS.INITIAL_START, subscription);
        return () => {
            electron_1.ipcRenderer.removeListener(exports.PROCESSING_EVENTS.INITIAL_START, subscription);
        };
    },
    onDebugStart: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on(exports.PROCESSING_EVENTS.DEBUG_START, subscription);
        return () => {
            electron_1.ipcRenderer.removeListener(exports.PROCESSING_EVENTS.DEBUG_START, subscription);
        };
    },
    onDebugSuccess: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("debug-success", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("debug-success", subscription);
        };
    },
    onDebugError: (callback) => {
        const subscription = (_, error) => callback(error);
        electron_1.ipcRenderer.on(exports.PROCESSING_EVENTS.DEBUG_ERROR, subscription);
        return () => {
            electron_1.ipcRenderer.removeListener(exports.PROCESSING_EVENTS.DEBUG_ERROR, subscription);
        };
    },
    onSolutionError: (callback) => {
        const subscription = (_, error) => callback(error);
        electron_1.ipcRenderer.on(exports.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, subscription);
        return () => {
            electron_1.ipcRenderer.removeListener(exports.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, subscription);
        };
    },
    onProcessingNoScreenshots: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on(exports.PROCESSING_EVENTS.NO_SCREENSHOTS, subscription);
        return () => {
            electron_1.ipcRenderer.removeListener(exports.PROCESSING_EVENTS.NO_SCREENSHOTS, subscription);
        };
    },
    onProblemExtracted: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on(exports.PROCESSING_EVENTS.PROBLEM_EXTRACTED, subscription);
        return () => {
            electron_1.ipcRenderer.removeListener(exports.PROCESSING_EVENTS.PROBLEM_EXTRACTED, subscription);
        };
    },
    onSolutionSuccess: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on(exports.PROCESSING_EVENTS.SOLUTION_SUCCESS, subscription);
        return () => {
            electron_1.ipcRenderer.removeListener(exports.PROCESSING_EVENTS.SOLUTION_SUCCESS, subscription);
        };
    },
    onUnauthorized: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on(exports.PROCESSING_EVENTS.UNAUTHORIZED, subscription);
        return () => {
            electron_1.ipcRenderer.removeListener(exports.PROCESSING_EVENTS.UNAUTHORIZED, subscription);
        };
    },
    moveWindowLeft: () => (0, types_1.invokeVoid)("move-window-left"),
    moveWindowRight: () => (0, types_1.invokeVoid)("move-window-right"),
    moveWindowUp: () => (0, types_1.invokeVoid)("move-window-up"),
    moveWindowDown: () => (0, types_1.invokeVoid)("move-window-down"),
    analyzeImageFile: (path) => (0, types_1.invokeAndUnwrap)("analyze-image-file", path),
    quitApp: () => (0, types_1.invokeVoid)("quit-app"),
    toggleWindow: () => (0, types_1.invokeVoid)("toggle-window"),
    showWindow: () => (0, types_1.invokeVoid)("show-window"),
    hideWindow: () => (0, types_1.invokeVoid)("hide-window"),
    toggleAdvancedSettings: () => electron_1.ipcRenderer.invoke("toggle-advanced-settings"),
    openExternal: (url) => electron_1.ipcRenderer.invoke("open-external", url),
    setUndetectable: (state) => (0, types_1.invokeStatus)("set-undetectable", state),
    getUndetectable: async () => (await (0, types_1.invokeAndUnwrap)("get-undetectable")).enabled,
    setConsciousMode: (enabled) => electron_1.ipcRenderer.invoke('set-conscious-mode', enabled),
    getConsciousMode: () => electron_1.ipcRenderer.invoke('get-conscious-mode'),
    onConsciousModeChanged: (callback) => {
        const subscription = (_, enabled) => callback(enabled);
        electron_1.ipcRenderer.on('conscious-mode-changed', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('conscious-mode-changed', subscription);
        };
    },
    setAccelerationMode: (enabled) => electron_1.ipcRenderer.invoke('set-acceleration-mode', enabled),
    getAccelerationMode: () => electron_1.ipcRenderer.invoke('get-acceleration-mode'),
    onAccelerationModeChanged: (callback) => {
        const subscription = (_, enabled) => callback(enabled);
        electron_1.ipcRenderer.on('acceleration-mode-changed', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('acceleration-mode-changed', subscription);
        };
    },
    setOpenAtLogin: (open) => (0, types_1.invokeStatus)("set-open-at-login", open),
    getOpenAtLogin: async () => (await (0, types_1.invokeAndUnwrap)("get-open-at-login")).enabled,
    closeSettingsWindow: () => (0, types_1.invokeVoid)('close-settings-window'),
    setDisguise: (mode) => (0, types_1.invokeStatus)("set-disguise", mode),
    getDisguise: async () => (await (0, types_1.invokeAndUnwrap)("get-disguise")).mode,
    onDisguiseChanged: (callback) => {
        const subscription = (_, mode) => callback(mode);
        electron_1.ipcRenderer.on('disguise-changed', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('disguise-changed', subscription);
        };
    },
    onSettingsVisibilityChange: (callback) => {
        const subscription = (_, isVisible) => callback(isVisible);
        electron_1.ipcRenderer.on("settings-visibility-changed", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("settings-visibility-changed", subscription);
        };
    },
    onToggleExpand: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on("toggle-expand", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("toggle-expand", subscription);
        };
    },
    // LLM Model Management
    getCurrentLlmConfig: () => (0, types_1.invokeAndUnwrap)("get-current-llm-config"),
    getAvailableOllamaModels: () => (0, types_1.invokeAndUnwrap)("get-available-ollama-models"),
    switchToOllama: (model, url) => electron_1.ipcRenderer.invoke("switch-to-ollama", model, url),
    switchToGemini: (apiKey, modelId) => electron_1.ipcRenderer.invoke("switch-to-gemini", apiKey, modelId),
    testLlmConnection: (provider, apiKey) => electron_1.ipcRenderer.invoke("test-llm-connection", provider, apiKey),
    selectServiceAccount: async () => {
        try {
            const data = await (0, types_1.invokeAndUnwrap)("select-service-account");
            return { success: true, ...data };
        }
        catch (error) {
            return { success: false, error: (0, types_1.getErrorMessage)(error) };
        }
    },
    // API Key Management
    setGeminiApiKey: (apiKey) => electron_1.ipcRenderer.invoke("set-gemini-api-key", apiKey),
    setGroqApiKey: (apiKey) => electron_1.ipcRenderer.invoke("set-groq-api-key", apiKey),
    setCerebrasApiKey: (apiKey) => electron_1.ipcRenderer.invoke("set-cerebras-api-key", apiKey),
    setOpenaiApiKey: (apiKey) => electron_1.ipcRenderer.invoke("set-openai-api-key", apiKey),
    setClaudeApiKey: (apiKey) => electron_1.ipcRenderer.invoke("set-claude-api-key", apiKey),
    getStoredCredentials: () => (0, types_1.invokeAndUnwrap)("get-stored-credentials"),
    // STT Provider Management
    setSttProvider: (provider) => electron_1.ipcRenderer.invoke("set-stt-provider", provider),
    getSttProvider: () => (0, types_1.invokeAndUnwrap)("get-stt-provider"),
    setGroqSttApiKey: (apiKey) => electron_1.ipcRenderer.invoke("set-groq-stt-api-key", apiKey),
    setOpenAiSttApiKey: (apiKey) => electron_1.ipcRenderer.invoke("set-openai-stt-api-key", apiKey),
    setDeepgramApiKey: (apiKey) => electron_1.ipcRenderer.invoke("set-deepgram-api-key", apiKey),
    setElevenLabsApiKey: (apiKey) => electron_1.ipcRenderer.invoke("set-elevenlabs-api-key", apiKey),
    setAzureApiKey: (apiKey) => electron_1.ipcRenderer.invoke("set-azure-api-key", apiKey),
    setAzureRegion: (region) => electron_1.ipcRenderer.invoke("set-azure-region", region),
    setIbmWatsonApiKey: (apiKey) => electron_1.ipcRenderer.invoke("set-ibmwatson-api-key", apiKey),
    setGroqSttModel: (model) => electron_1.ipcRenderer.invoke("set-groq-stt-model", model),
    setSonioxApiKey: (apiKey) => electron_1.ipcRenderer.invoke("set-soniox-api-key", apiKey),
    testSttConnection: (provider, apiKey, region) => electron_1.ipcRenderer.invoke("test-stt-connection", provider, apiKey, region),
    // Native Audio Service Events
    onNativeAudioTranscript: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("native-audio-transcript", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("native-audio-transcript", subscription);
        };
    },
    onNativeAudioSuggestion: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("native-audio-suggestion", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("native-audio-suggestion", subscription);
        };
    },
    onNativeAudioConnected: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on("native-audio-connected", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("native-audio-connected", subscription);
        };
    },
    onNativeAudioDisconnected: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on("native-audio-disconnected", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("native-audio-disconnected", subscription);
        };
    },
    onSuggestionGenerated: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("suggestion-generated", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("suggestion-generated", subscription);
        };
    },
    onSuggestionProcessingStart: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on("suggestion-processing-start", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("suggestion-processing-start", subscription);
        };
    },
    onSuggestionError: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("suggestion-error", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("suggestion-error", subscription);
        };
    },
    onMeetingAudioError: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("meeting-audio-error", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("meeting-audio-error", subscription);
        };
    },
    generateSuggestion: (context, lastQuestion) => (0, types_1.invokeAndUnwrap)("generate-suggestion", context, lastQuestion),
    getNativeAudioStatus: () => (0, types_1.invokeAndUnwrap)("native-audio-status"),
    getInputDevices: () => electron_1.ipcRenderer.invoke("get-input-devices"),
    getOutputDevices: () => electron_1.ipcRenderer.invoke("get-output-devices"),
    setRecognitionLanguage: (key) => electron_1.ipcRenderer.invoke("set-recognition-language", key),
    getAiResponseLanguages: () => (0, types_1.invokeAndUnwrap)("get-ai-response-languages"),
    setAiResponseLanguage: (language) => (0, types_1.invokeStatus)("set-ai-response-language", language),
    getSttLanguage: async () => (await (0, types_1.invokeAndUnwrap)("get-stt-language")).language,
    getAiResponseLanguage: async () => (await (0, types_1.invokeAndUnwrap)("get-ai-response-language")).language,
    // Intelligence Mode IPC
    generateAssist: () => electron_1.ipcRenderer.invoke("generate-assist"),
    generateWhatToSay: (question, imagePaths) => electron_1.ipcRenderer.invoke("generate-what-to-say", question, imagePaths),
    generateFollowUp: (intent, userRequest) => electron_1.ipcRenderer.invoke("generate-follow-up", intent, userRequest),
    generateFollowUpQuestions: () => electron_1.ipcRenderer.invoke("generate-follow-up-questions"),
    generateRecap: () => electron_1.ipcRenderer.invoke("generate-recap"),
    submitManualQuestion: (question) => electron_1.ipcRenderer.invoke("submit-manual-question", question),
    getIntelligenceContext: () => electron_1.ipcRenderer.invoke("get-intelligence-context"),
    resetIntelligence: () => electron_1.ipcRenderer.invoke("reset-intelligence"),
    // Meeting Lifecycle
    startMeeting: (metadata) => electron_1.ipcRenderer.invoke("start-meeting", metadata),
    endMeeting: () => electron_1.ipcRenderer.invoke("end-meeting"),
    finalizeMicSTT: () => (0, types_1.invokeVoid)("finalize-mic-stt"),
    getRecentMeetings: () => electron_1.ipcRenderer.invoke("get-recent-meetings"),
    getMeetingDetails: (id) => electron_1.ipcRenderer.invoke("get-meeting-details", id),
    updateMeetingTitle: (id, title) => electron_1.ipcRenderer.invoke("update-meeting-title", { id, title }),
    updateMeetingSummary: (id, updates) => electron_1.ipcRenderer.invoke("update-meeting-summary", { id, updates }),
    deleteMeeting: (id) => electron_1.ipcRenderer.invoke("delete-meeting", id),
    onMeetingsUpdated: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on("meetings-updated", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("meetings-updated", subscription);
        };
    },
    // Window Mode
    setWindowMode: (mode) => electron_1.ipcRenderer.invoke("set-window-mode", mode),
    setOverlayClickthrough: (enabled) => (0, types_1.invokeVoid)('set-overlay-clickthrough', enabled),
    onOverlayClickthroughChanged: (callback) => {
        const subscription = (_, enabled) => callback(enabled);
        electron_1.ipcRenderer.on('overlay-clickthrough-changed', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('overlay-clickthrough-changed', subscription);
        };
    },
    onGlobalShortcutAction: (callback) => {
        const subscription = (_, actionId) => callback(actionId);
        electron_1.ipcRenderer.on('global-shortcut-action', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('global-shortcut-action', subscription);
        };
    },
    // Intelligence Mode Events
    onIntelligenceAssistUpdate: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("intelligence-assist-update", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-assist-update", subscription);
        };
    },
    onIntelligenceCooldown: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on('intelligence-cooldown', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('intelligence-cooldown', subscription);
        };
    },
    onIntelligenceSuggestedAnswerToken: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("intelligence-suggested-answer-token", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-suggested-answer-token", subscription);
        };
    },
    onIntelligenceSuggestedAnswer: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("intelligence-suggested-answer", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-suggested-answer", subscription);
        };
    },
    onIntelligenceRefinedAnswerToken: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("intelligence-refined-answer-token", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-refined-answer-token", subscription);
        };
    },
    onIntelligenceRefinedAnswer: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("intelligence-refined-answer", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-refined-answer", subscription);
        };
    },
    onIntelligenceRecapToken: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("intelligence-recap-token", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-recap-token", subscription);
        };
    },
    onIntelligenceRecap: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("intelligence-recap", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-recap", subscription);
        };
    },
    onIntelligenceFollowUpQuestionsToken: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("intelligence-follow-up-questions-token", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-follow-up-questions-token", subscription);
        };
    },
    onIntelligenceFollowUpQuestionsUpdate: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("intelligence-follow-up-questions-update", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-follow-up-questions-update", subscription);
        };
    },
    onIntelligenceManualStarted: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on("intelligence-manual-started", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-manual-started", subscription);
        };
    },
    onIntelligenceManualResult: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("intelligence-manual-result", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-manual-result", subscription);
        };
    },
    onIntelligenceModeChanged: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("intelligence-mode-changed", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-mode-changed", subscription);
        };
    },
    onIntelligenceError: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on("intelligence-error", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("intelligence-error", subscription);
        };
    },
    onSessionReset: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on("session-reset", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("session-reset", subscription);
        };
    },
    onMeetingLifecycleState: (callback) => {
        const subscription = (_, state) => callback(state);
        electron_1.ipcRenderer.on("meeting-lifecycle-state", subscription);
        return () => {
            electron_1.ipcRenderer.removeListener("meeting-lifecycle-state", subscription);
        };
    },
    getMeetingLifecycleState: () => electron_1.ipcRenderer.invoke("get-meeting-lifecycle-state"),
    // Streaming Chat
    streamGeminiChat: (message, imagePaths, context, options) => electron_1.ipcRenderer.invoke("gemini-chat-stream", message, imagePaths, context, options),
    cancelChat: (requestId) => electron_1.ipcRenderer.invoke("gemini-chat-cancel", requestId),
    onGeminiStreamToken: (requestId, callback) => {
        const channel = `gemini-stream-token:${requestId}`;
        const subscription = (_, token) => callback(token);
        electron_1.ipcRenderer.on(channel, subscription);
        return () => {
            electron_1.ipcRenderer.removeListener(channel, subscription);
        };
    },
    onGeminiStreamDone: (requestId, callback) => {
        const channel = `gemini-stream-final:${requestId}`;
        const subscription = () => callback();
        electron_1.ipcRenderer.on(channel, subscription);
        return () => {
            electron_1.ipcRenderer.removeListener(channel, subscription);
        };
    },
    onGeminiStreamError: (requestId, callback) => {
        const channel = `gemini-stream-error:${requestId}`;
        const subscription = (_, error) => callback(error);
        electron_1.ipcRenderer.on(channel, subscription);
        return () => {
            electron_1.ipcRenderer.removeListener(channel, subscription);
        };
    },
    // Model Management
    getDefaultModel: () => (0, types_1.invokeAndUnwrap)('get-default-model'),
    setModel: (modelId) => electron_1.ipcRenderer.invoke('set-model', modelId),
    setDefaultModel: (modelId) => electron_1.ipcRenderer.invoke('set-default-model', modelId),
    toggleModelSelector: (coords) => electron_1.ipcRenderer.invoke('toggle-model-selector', coords),
    forceRestartOllama: () => (0, types_1.invokeVoid)('force-restart-ollama'),
    // Settings Window
    toggleSettingsWindow: (coords) => (0, types_1.invokeVoid)('toggle-settings-window', coords),
    // Fast Response Mode
    getFastResponseConfig: () => (0, types_1.invokeAndUnwrap)('get-fast-response-config'),
    setFastResponseConfig: (config) => electron_1.ipcRenderer.invoke('set-fast-response-config', config),
    // Demo
    seedDemo: () => electron_1.ipcRenderer.invoke('seed-demo'),
    // Custom Providers
    saveCustomProvider: (provider) => electron_1.ipcRenderer.invoke('save-custom-provider', provider),
    getCustomProviders: () => (0, types_1.invokeAndUnwrap)('get-custom-providers'),
    deleteCustomProvider: (id) => electron_1.ipcRenderer.invoke('delete-custom-provider', id),
    // Follow-up Email
    generateFollowupEmail: (input) => electron_1.ipcRenderer.invoke('generate-followup-email', input),
    extractEmailsFromTranscript: (transcript) => electron_1.ipcRenderer.invoke('extract-emails-from-transcript', transcript),
    getCalendarAttendees: (eventId) => electron_1.ipcRenderer.invoke('get-calendar-attendees', eventId),
    openMailto: (params) => electron_1.ipcRenderer.invoke('open-mailto', params),
    // Audio Test
    startAudioTest: (deviceId) => electron_1.ipcRenderer.invoke('start-audio-test', deviceId),
    stopAudioTest: () => electron_1.ipcRenderer.invoke('stop-audio-test'),
    onAudioTestLevel: (callback) => {
        const subscription = (_, level) => callback(level);
        electron_1.ipcRenderer.on('audio-test-level', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('audio-test-level', subscription);
        };
    },
    // Database
    flushDatabase: () => electron_1.ipcRenderer.invoke('flush-database'),
    onUndetectableChanged: (callback) => {
        const subscription = (_, state) => callback(state);
        electron_1.ipcRenderer.on('undetectable-changed', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('undetectable-changed', subscription);
        };
    },
    getPrivacyShieldState: () => (0, types_1.invokeAndUnwrap)('get-privacy-shield-state'),
    onPrivacyShieldChanged: (callback) => {
        const subscription = (_, state) => callback(state);
        electron_1.ipcRenderer.on('privacy-shield-changed', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('privacy-shield-changed', subscription);
        };
    },
    onFastResponseConfigChanged: (callback) => {
        const subscription = (_, config) => callback(config);
        electron_1.ipcRenderer.on('fast-response-config-changed', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('fast-response-config-changed', subscription);
        };
    },
    onModelChanged: (callback) => {
        const subscription = (_, modelId) => callback(modelId);
        electron_1.ipcRenderer.on('model-changed', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('model-changed', subscription);
        };
    },
    onModelFallback: (callback) => {
        const subscription = (_, event) => callback(event);
        electron_1.ipcRenderer.on('model-fallback', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('model-fallback', subscription);
        };
    },
    onOllamaPullProgress: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on('ollama:pull-progress', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('ollama:pull-progress', subscription);
        };
    },
    onOllamaPullComplete: (callback) => {
        const subscription = () => callback();
        electron_1.ipcRenderer.on('ollama:pull-complete', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('ollama:pull-complete', subscription);
        };
    },
    // Theme API
    getThemeMode: () => (0, types_1.invokeAndUnwrap)('theme:get-mode'),
    setThemeMode: (mode) => electron_1.ipcRenderer.invoke('theme:set-mode', mode),
    onThemeChanged: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on('theme:changed', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('theme:changed', subscription);
        };
    },
    // Calendar API
    calendarConnect: () => electron_1.ipcRenderer.invoke('calendar-connect'),
    calendarDisconnect: () => electron_1.ipcRenderer.invoke('calendar-disconnect'),
    getCalendarStatus: () => electron_1.ipcRenderer.invoke('get-calendar-status'),
    getUpcomingEvents: () => electron_1.ipcRenderer.invoke('get-upcoming-events'),
    calendarRefresh: () => electron_1.ipcRenderer.invoke('calendar-refresh'),
    // RAG API
    ragQueryMeeting: async (meetingId, query) => {
        try {
            return await (0, types_1.invokeAndUnwrap)('rag:query-meeting', { meetingId, query });
        }
        catch (error) {
            return { success: false, error: (0, types_1.getErrorMessage)(error) };
        }
    },
    ragQueryLive: async (query) => {
        try {
            return await (0, types_1.invokeAndUnwrap)('rag:query-live', { query });
        }
        catch (error) {
            return { success: false, error: (0, types_1.getErrorMessage)(error) };
        }
    },
    ragQueryGlobal: async (query) => {
        try {
            return await (0, types_1.invokeAndUnwrap)('rag:query-global', { query });
        }
        catch (error) {
            return { success: false, error: (0, types_1.getErrorMessage)(error) };
        }
    },
    ragCancelQuery: (options) => (0, types_1.invokeStatus)('rag:cancel-query', options),
    ragIsMeetingProcessed: (meetingId) => (0, types_1.invokeAndUnwrap)('rag:is-meeting-processed', meetingId),
    ragGetQueueStatus: () => (0, types_1.invokeAndUnwrap)('rag:get-queue-status'),
    ragRetryEmbeddings: () => (0, types_1.invokeStatus)('rag:retry-embeddings'),
    onIncompatibleProviderWarning: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on('embedding:incompatible-provider-warning', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('embedding:incompatible-provider-warning', subscription);
        };
    },
    reindexIncompatibleMeetings: () => (0, types_1.invokeVoid)('rag:reindex-incompatible-meetings'),
    onRAGStreamChunk: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on('rag:stream-chunk', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('rag:stream-chunk', subscription);
        };
    },
    onRAGStreamComplete: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on('rag:stream-complete', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('rag:stream-complete', subscription);
        };
    },
    onRAGStreamError: (callback) => {
        const subscription = (_, data) => callback(data);
        electron_1.ipcRenderer.on('rag:stream-error', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('rag:stream-error', subscription);
        };
    },
    // Keybind Management
    getKeybinds: () => electron_1.ipcRenderer.invoke('keybinds:get-all'),
    setKeybind: (id, accelerator) => electron_1.ipcRenderer.invoke('keybinds:set', id, accelerator),
    resetKeybinds: () => electron_1.ipcRenderer.invoke('keybinds:reset'),
    onKeybindsUpdate: (callback) => {
        const subscription = (_, keybinds) => callback(keybinds);
        electron_1.ipcRenderer.on('keybinds:update', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('keybinds:update', subscription);
        };
    },
    // Donation API
    getDonationStatus: () => electron_1.ipcRenderer.invoke("get-donation-status"),
    markDonationToastShown: () => electron_1.ipcRenderer.invoke("mark-donation-toast-shown"),
    setDonationComplete: () => electron_1.ipcRenderer.invoke('set-donation-complete'),
    // Profile Engine API
    profileUploadResume: (filePath) => (0, types_1.invokeStatus)('profile:upload-resume', filePath),
    profileGetStatus: () => (0, types_1.invokeAndUnwrap)('profile:get-status'),
    profileSetMode: (enabled) => (0, types_1.invokeStatus)('profile:set-mode', enabled),
    profileDelete: () => (0, types_1.invokeStatus)('profile:delete'),
    profileGetProfile: () => (0, types_1.invokeAndUnwrap)('profile:get-profile'),
    profileSelectFile: async () => {
        try {
            const data = await (0, types_1.invokeAndUnwrap)('profile:select-file');
            if (data.cancelled) {
                return { cancelled: true };
            }
            return { success: true, ...data };
        }
        catch (error) {
            return { success: false, error: (0, types_1.getErrorMessage)(error) };
        }
    },
    // JD & Research API
    profileUploadJD: (filePath) => (0, types_1.invokeStatus)('profile:upload-jd', filePath),
    profileDeleteJD: () => (0, types_1.invokeStatus)('profile:delete-jd'),
    profileResearchCompany: async (companyName) => {
        try {
            return await (0, types_1.invokeAndUnwrap)('profile:research-company', companyName);
        }
        catch (error) {
            return { success: false, error: (0, types_1.getErrorMessage)(error) };
        }
    },
    profileGenerateNegotiation: async () => {
        try {
            return await (0, types_1.invokeAndUnwrap)('profile:generate-negotiation');
        }
        catch (error) {
            return { success: false, error: (0, types_1.getErrorMessage)(error) };
        }
    },
    // Google Search API
    setGoogleSearchApiKey: (apiKey) => (0, types_1.invokeStatus)('set-google-search-api-key', apiKey),
    setGoogleSearchCseId: (cseId) => (0, types_1.invokeStatus)('set-google-search-cse-id', cseId),
    // Dynamic Model Discovery
    fetchProviderModels: (provider, apiKey) => electron_1.ipcRenderer.invoke('fetch-provider-models', provider, apiKey),
    setProviderPreferredModel: (provider, modelId) => electron_1.ipcRenderer.invoke('set-provider-preferred-model', provider, modelId),
    // License Management
    licenseActivate: (key) => electron_1.ipcRenderer.invoke('license:activate', key),
    licenseCheckPremium: () => electron_1.ipcRenderer.invoke('license:check-premium'),
    licenseDeactivate: () => electron_1.ipcRenderer.invoke('license:deactivate'),
    licenseGetHardwareId: () => electron_1.ipcRenderer.invoke('license:get-hardware-id'),
    // Overlay Opacity (Stealth Mode)
    setOverlayOpacity: (opacity) => (0, types_1.invokeVoid)('set-overlay-opacity', opacity),
    onOverlayOpacityChanged: (callback) => {
        const subscription = (_, opacity) => callback(opacity);
        electron_1.ipcRenderer.on('overlay-opacity-changed', subscription);
        return () => {
            electron_1.ipcRenderer.removeListener('overlay-opacity-changed', subscription);
        };
    },
    // Diagnostics
    logErrorToMain: (payload) => electron_1.ipcRenderer.invoke('renderer:log-error', payload),
});
//# sourceMappingURL=api.js.map