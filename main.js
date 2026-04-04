"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppState = void 0;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const electron_updater_1 = require("electron-updater");
const optimizations_1 = require("./config/optimizations");
const StealthManager_1 = require("./stealth/StealthManager");
if (!electron_1.app.isPackaged) {
    require('dotenv').config();
}
// Handle stdout/stderr errors at the process level to prevent EIO crashes
// This is critical for Electron apps that may have their terminal detached
process.stdout?.on?.('error', () => { });
process.stderr?.on?.('error', () => { });
process.on('uncaughtException', (err) => {
    logToFile('[CRITICAL] Uncaught Exception: ' + (err.stack || err.message || err));
});
process.on('unhandledRejection', (reason, promise) => {
    logToFile('[CRITICAL] Unhandled Rejection at: ' + promise + ' reason: ' + (reason instanceof Error ? reason.stack : reason));
});
const logFile = path_1.default.join(electron_1.app.getPath('documents'), 'natively_debug.log');
const LOG_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const LOG_ROTATION_COUNT = 3; // Keep 3 rotated files
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const isDev = process.env.NODE_ENV === "development";
/**
 * Rotate log files if they exceed the maximum size.
 * Keeps LOG_ROTATION_COUNT rotated files (e.g., .log.1, .log.2, .log.3)
 */
function rotateLogsIfNeeded() {
    try {
        const fs = require('fs');
        // Check if log file exists and exceeds max size
        if (!fs.existsSync(logFile))
            return;
        const stats = fs.statSync(logFile);
        if (stats.size < LOG_MAX_SIZE_BYTES)
            return;
        // Rotate existing files: .log.3 -> delete, .log.2 -> .log.3, .log.1 -> .log.2, .log -> .log.1
        for (let i = LOG_ROTATION_COUNT; i >= 1; i--) {
            const rotatedPath = `${logFile}.${i}`;
            if (fs.existsSync(rotatedPath)) {
                if (i === LOG_ROTATION_COUNT) {
                    // Delete oldest rotation
                    fs.unlinkSync(rotatedPath);
                }
                else {
                    // Rename to next rotation number
                    fs.renameSync(rotatedPath, `${logFile}.${i + 1}`);
                }
            }
        }
        // Rename current log to .log.1
        fs.renameSync(logFile, `${logFile}.1`);
        originalLog(`[LogRotation] Rotated debug log (size was ${Math.round(stats.size / 1024 / 1024)}MB)`);
    }
    catch (e) {
        // Ignore rotation errors - don't disrupt logging
        originalError('[LogRotation] Failed to rotate logs:', e);
    }
}
function logToFile(msg) {
    // Only log to file in development
    if (!isDev)
        return;
    try {
        // Check and rotate logs if needed before writing
        rotateLogsIfNeeded();
        require('fs').appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n');
    }
    catch (e) {
        // Ignore logging errors
    }
}
console.log = (...args) => {
    const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    logToFile('[LOG] ' + msg);
    try {
        originalLog.apply(console, args);
    }
    catch { }
};
console.warn = (...args) => {
    const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    logToFile('[WARN] ' + msg);
    try {
        originalWarn.apply(console, args);
    }
    catch { }
};
console.error = (...args) => {
    const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    logToFile('[ERROR] ' + msg);
    try {
        originalError.apply(console, args);
    }
    catch { }
};
const ipcHandlers_1 = require("./ipcHandlers");
const WindowHelper_1 = require("./WindowHelper");
const SettingsWindowHelper_1 = require("./SettingsWindowHelper");
const ModelSelectorWindowHelper_1 = require("./ModelSelectorWindowHelper");
const ScreenshotHelper_1 = require("./ScreenshotHelper");
const KeybindManager_1 = require("./services/KeybindManager");
const ProcessingHelper_1 = require("./ProcessingHelper");
const IntelligenceManager_1 = require("./IntelligenceManager");
const SystemAudioCapture_1 = require("./audio/SystemAudioCapture");
const MicrophoneCapture_1 = require("./audio/MicrophoneCapture");
const AudioDevices_1 = require("./audio/AudioDevices");
const GoogleSTT_1 = require("./audio/GoogleSTT");
const RestSTT_1 = require("./audio/RestSTT");
const DeepgramStreamingSTT_1 = require("./audio/DeepgramStreamingSTT");
const SonioxStreamingSTT_1 = require("./audio/SonioxStreamingSTT");
const ElevenLabsStreamingSTT_1 = require("./audio/ElevenLabsStreamingSTT");
const OpenAIStreamingSTT_1 = require("./audio/OpenAIStreamingSTT");
const nativeModule_1 = require("./audio/nativeModule");
const ThemeManager_1 = require("./ThemeManager");
const RAGManager_1 = require("./rag/RAGManager");
const DatabaseManager_1 = require("./db/DatabaseManager");
const llm_1 = require("./llm");
const ConsciousMode_1 = require("./ConsciousMode");
/** Type guard functions for STT provider optional methods */
function hasFinalize(stt) {
    return 'finalize' in stt && typeof stt.finalize === 'function';
}
function hasSetAudioChannelCount(stt) {
    return 'setAudioChannelCount' in stt && typeof stt.setAudioChannelCount === 'function';
}
function hasNotifySpeechEnded(stt) {
    return 'notifySpeechEnded' in stt && typeof stt.notifySpeechEnded === 'function';
}
function hasDestroy(stt) {
    return 'destroy' in stt && typeof stt.destroy === 'function';
}
/** Safe wrapper functions for STT provider optional methods */
function safeFinalize(stt) {
    if (stt && hasFinalize(stt)) {
        try {
            stt.finalize();
        }
        catch (error) {
            console.error('[Main] Error calling finalize on STT provider:', error);
        }
    }
}
function safeSetAudioChannelCount(stt, count) {
    if (stt && hasSetAudioChannelCount(stt)) {
        try {
            stt.setAudioChannelCount(count);
        }
        catch (error) {
            console.error('[Main] Error calling setAudioChannelCount on STT provider:', error);
        }
    }
}
function safeNotifySpeechEnded(stt) {
    if (stt && hasNotifySpeechEnded(stt)) {
        try {
            stt.notifySpeechEnded();
        }
        catch (error) {
            console.error('[Main] Error calling notifySpeechEnded on STT provider:', error);
        }
    }
}
function safeDestroy(stt) {
    if (stt && hasDestroy(stt)) {
        try {
            stt.destroy();
        }
        catch (error) {
            console.error('[Main] Error calling destroy on STT provider:', error);
        }
    }
}
// Premium: Knowledge modules loaded conditionally
let KnowledgeOrchestratorClass = null;
let KnowledgeDatabaseManagerClass = null;
try {
    KnowledgeOrchestratorClass = require('../premium/electron/knowledge/KnowledgeOrchestrator').KnowledgeOrchestrator;
    KnowledgeDatabaseManagerClass = require('../premium/electron/knowledge/KnowledgeDatabaseManager').KnowledgeDatabaseManager;
}
catch {
    console.log('[Main] Knowledge modules not available — profile intelligence disabled.');
}
const SettingsManager_1 = require("./services/SettingsManager");
const ReleaseNotesManager_1 = require("./update/ReleaseNotesManager");
const OllamaManager_1 = require("./services/OllamaManager");
class AppState {
    static instance = null;
    windowHelper;
    settingsWindowHelper;
    modelSelectorWindowHelper;
    screenshotHelper;
    processingHelper;
    intelligenceManager;
    themeManager;
    ragManager = null;
    knowledgeOrchestrator = null;
    tray = null;
    updateAvailable = false;
    disguiseMode = 'none';
    consciousModeEnabled = false;
    // View management
    view = "queue";
    isUndetectable = false;
    problemInfo = null; // Allow null
    hasDebugged = false;
    isMeetingActive = false; // Guard for session state leaks
    meetingLifecycleState = 'idle';
    meetingStartSequence = 0;
    meetingStartMutex = Promise.resolve(); // Prevents race conditions
    nativeAudioConnected = false;
    _disguiseTimers = []; // Track forceUpdate timeouts
    clearDisguiseTimers() {
        for (const timer of this._disguiseTimers) {
            clearTimeout(timer);
        }
        this._disguiseTimers = [];
    }
    trackDisguiseTimer(timer) {
        this._disguiseTimers.push(timer);
    }
    scheduleDisguiseTimer(callback, delayMs) {
        const timer = setTimeout(() => {
            try {
                callback();
            }
            finally {
                this._disguiseTimers = this._disguiseTimers.filter(t => t !== timer);
            }
        }, delayMs);
        this.trackDisguiseTimer(timer);
    }
    _ollamaBootstrapPromise = null;
    // Processing events
    PROCESSING_EVENTS = {
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
    constructor() {
        // 1. Load boot-critical settings first (used by WindowHelpers)
        const settingsManager = SettingsManager_1.SettingsManager.getInstance();
        this.isUndetectable = settingsManager.get('isUndetectable') ?? false;
        this.disguiseMode = settingsManager.get('disguiseMode') ?? 'none';
        this.consciousModeEnabled = settingsManager.get('consciousModeEnabled') ?? false;
        // 1a. Sync acceleration optimization flags from settings
        const accelerationModeEnabled = settingsManager.getAccelerationModeEnabled();
        (0, optimizations_1.syncOptimizationFlagsFromSettings)(accelerationModeEnabled);
        console.log(`[AppState] Initialized with isUndetectable=${this.isUndetectable}, disguiseMode=${this.disguiseMode}, consciousModeEnabled=${this.consciousModeEnabled}, accelerationModeEnabled=${accelerationModeEnabled}`);
        // 2. Initialize Helpers with loaded state
        this.windowHelper = new WindowHelper_1.WindowHelper(this);
        this.settingsWindowHelper = new SettingsWindowHelper_1.SettingsWindowHelper();
        this.modelSelectorWindowHelper = new ModelSelectorWindowHelper_1.ModelSelectorWindowHelper();
        // 3. Initialize other helpers
        this.screenshotHelper = new ScreenshotHelper_1.ScreenshotHelper(this.view);
        this.processingHelper = new ProcessingHelper_1.ProcessingHelper(this);
        // 3a. Apply stealth mode if acceleration enabled (Apple Silicon enhancement)
        const stealthManager = new StealthManager_1.StealthManager({ enabled: this.isUndetectable });
        stealthManager.applyToWindow(this.windowHelper);
        this.windowHelper.setContentProtection(this.isUndetectable);
        this.settingsWindowHelper.setContentProtection(this.isUndetectable);
        this.modelSelectorWindowHelper.setContentProtection(this.isUndetectable);
        // Initialize KeybindManager
        const keybindManager = KeybindManager_1.KeybindManager.getInstance();
        keybindManager.setWindowHelper(this.windowHelper);
        keybindManager.setupIpcHandlers();
        keybindManager.onUpdate(() => {
            this.updateTrayMenu();
        });
        keybindManager.onShortcutTriggered(async (actionId) => {
            console.log(`[Main] Global shortcut triggered: ${actionId}`);
            try {
                if (actionId === 'general:toggle-visibility') {
                    this.toggleMainWindow();
                }
                else if (actionId === 'general:take-screenshot') {
                    const screenshotPath = await this.takeScreenshot();
                    const preview = await this.getImagePreview(screenshotPath);
                    const mainWindow = this.getMainWindow();
                    if (mainWindow) {
                        mainWindow.webContents.send("screenshot-taken", {
                            path: screenshotPath,
                            preview
                        });
                    }
                }
                else if (actionId === 'general:selective-screenshot') {
                    const screenshotPath = await this.takeSelectiveScreenshot();
                    const preview = await this.getImagePreview(screenshotPath);
                    const mainWindow = this.getMainWindow();
                    if (mainWindow) {
                        // preload.ts maps 'screenshot-attached' to onScreenshotAttached
                        mainWindow.webContents.send("screenshot-attached", {
                            path: screenshotPath,
                            preview
                        });
                    }
                }
            }
            catch (e) {
                if (e.message !== "Selection cancelled") {
                    console.error(`[Main] Error handling global shortcut ${actionId}:`, e);
                }
            }
        });
        // Inject WindowHelper into other helpers
        this.settingsWindowHelper.setWindowHelper(this.windowHelper);
        this.modelSelectorWindowHelper.setWindowHelper(this.windowHelper);
        // Initialize IntelligenceManager with LLMHelper
        this.intelligenceManager = new IntelligenceManager_1.IntelligenceManager(this.processingHelper.getLLMHelper());
        this.intelligenceManager.setConsciousModeEnabled(this.consciousModeEnabled);
        // Initialize ThemeManager
        this.themeManager = ThemeManager_1.ThemeManager.getInstance();
        // Initialize RAGManager (requires database to be ready)
        this.initializeRAGManager();
        // Initialize KnowledgeOrchestrator (requires RAGManager for embeddings)
        this.initializeKnowledgeOrchestrator();
        // Check and prep Ollama embedding model
        this.bootstrapOllamaEmbeddings();
        // Initialize AccelerationManager (Apple Silicon enhancement)
        this.initializeAccelerationManager();
        this.setupIntelligenceEvents();
        // Pre-warm the zero-shot intent classifier in background
        (0, llm_1.warmupIntentClassifier)();
        // Setup Ollama IPC
        this.setupOllamaIpcHandlers();
        // --- NEW SYSTEM AUDIO PIPELINE (SOX + NODE GOOGLE STT) ---
        // LAZY INIT: Do not setup pipeline here to prevent launch volume surge.
        // this.setupSystemAudioPipeline()
        // Initialize Auto-Updater
        this.setupAutoUpdater();
    }
    broadcast(channel, ...args) {
        electron_1.BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send(channel, ...args);
            }
        });
    }
    setNativeAudioConnected(connected) {
        if (this.nativeAudioConnected === connected) {
            return;
        }
        this.nativeAudioConnected = connected;
        this.broadcast(connected ? 'native-audio-connected' : 'native-audio-disconnected');
    }
    getNativeAudioStatus() {
        return { connected: this.nativeAudioConnected };
    }
    async ensureMeetingAudioAccess() {
        const nativeLoadError = (0, nativeModule_1.getNativeAudioLoadError)();
        if (nativeLoadError) {
            throw new Error(nativeLoadError.message);
        }
        if (process.platform !== 'darwin') {
            return;
        }
        const micStatus = electron_1.systemPreferences.getMediaAccessStatus('microphone');
        if (micStatus !== 'granted') {
            const granted = micStatus === 'not-determined'
                ? await electron_1.systemPreferences.askForMediaAccess('microphone')
                : false;
            if (!granted) {
                throw new Error('Microphone access is blocked. Enable Natively in System Settings > Privacy & Security > Microphone.');
            }
        }
        const screenStatus = electron_1.systemPreferences.getMediaAccessStatus('screen');
        if (screenStatus !== 'granted') {
            throw new Error('Screen Recording access is blocked. Enable Natively in System Settings > Privacy & Security > Screen Recording to capture system audio.');
        }
    }
    async validateMeetingAudioSetup(metadata) {
        await this.ensureMeetingAudioAccess();
        const inputDeviceId = metadata?.audio?.inputDeviceId;
        const outputDeviceId = metadata?.audio?.outputDeviceId;
        const inputDevices = AudioDevices_1.AudioDevices.getInputDevices();
        if (inputDevices.length === 0) {
            throw new Error('No microphone devices were detected. Rebuild native audio with `npm run build:native:current` and confirm microphone permission is granted.');
        }
        if (inputDeviceId && inputDeviceId !== 'default' && !inputDevices.some((device) => device.id === inputDeviceId)) {
            throw new Error(`Selected microphone is unavailable: ${inputDeviceId}`);
        }
        const outputDevices = AudioDevices_1.AudioDevices.getOutputDevices();
        if (!outputDeviceId || outputDeviceId === 'default' || outputDeviceId === 'sck') {
            return;
        }
        if (outputDevices.length === 0) {
            throw new Error('No system audio output devices were detected. Rebuild native audio with `npm run build:native:current` and confirm Screen Recording permission is granted.');
        }
        if (!outputDevices.some((device) => device.id === outputDeviceId)) {
            throw new Error(`Selected speaker output is unavailable: ${outputDeviceId}`);
        }
    }
    async bootstrapOllamaEmbeddings() {
        this._ollamaBootstrapPromise = (async () => {
            try {
                const { OllamaBootstrap } = require('./rag/OllamaBootstrap');
                const bootstrap = new OllamaBootstrap();
                // Fire and forget — don't await this before showing the window
                const result = await bootstrap.bootstrap('nomic-embed-text', (status, percent) => {
                    // Send progress to renderer via IPC
                    this.broadcast('ollama:pull-progress', { status, percent });
                });
                if (result === 'pulled' || result === 'already_pulled') {
                    this.broadcast('ollama:pull-complete');
                    // Re-resolve the embedding provider given that Ollama might now be available
                    if (this.ragManager) {
                        console.log('[AppState] Ollama model ready, re-evaluating RAG pipeline provider');
                        const { CredentialsManager } = require('./services/CredentialsManager');
                        const cm = CredentialsManager.getInstance();
                        this.ragManager.initializeEmbeddings({
                            openaiKey: cm.getOpenaiApiKey() || process.env.OPENAI_API_KEY || undefined,
                            geminiKey: cm.getGeminiApiKey() || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || undefined,
                            ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434"
                        });
                    }
                }
            }
            catch (err) {
                console.error('[AppState] Failed to bootstrap Ollama:', err);
            }
        })();
    }
    initializeRAGManager() {
        try {
            const db = DatabaseManager_1.DatabaseManager.getInstance();
            const sqliteDb = db.getDb();
            if (sqliteDb) {
                const { CredentialsManager } = require('./services/CredentialsManager');
                const cm = CredentialsManager.getInstance();
                const openaiKey = cm.getOpenaiApiKey() || process.env.OPENAI_API_KEY;
                const geminiKey = cm.getGeminiApiKey() || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
                this.ragManager = new RAGManager_1.RAGManager({
                    db: sqliteDb,
                    dbPath: db.getDbPath(),
                    extPath: db.getExtPath(),
                    openaiKey,
                    geminiKey,
                    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434'
                });
                this.ragManager.setLLMHelper(this.processingHelper.getLLMHelper());
                console.log('[AppState] RAGManager initialized');
            }
        }
        catch (error) {
            console.error('[AppState] Failed to initialize RAGManager:', error);
        }
    }
    async initializeAccelerationManager() {
        try {
            const { AccelerationManager } = await Promise.resolve().then(() => __importStar(require('./services/AccelerationManager')));
            const accelerationManager = new AccelerationManager();
            await accelerationManager.initialize();
            console.log('[AppState] AccelerationManager initialized (Apple Silicon enhancement)');
        }
        catch (error) {
            console.warn('[AppState] AccelerationManager initialization skipped (optional):', error);
        }
    }
    initializeKnowledgeOrchestrator() {
        // Initialize Knowledge Orchestrator
        try {
            const db = DatabaseManager_1.DatabaseManager.getInstance();
            const sqliteDb = db.getDb();
            if (sqliteDb && KnowledgeDatabaseManagerClass && KnowledgeOrchestratorClass) {
                const knowledgeDb = new KnowledgeDatabaseManagerClass(sqliteDb);
                this.knowledgeOrchestrator = new KnowledgeOrchestratorClass(knowledgeDb);
                // Wire up LLM functions
                const llmHelper = this.processingHelper.getLLMHelper();
                // generateContent function for LLM calls
                this.knowledgeOrchestrator.setGenerateContentFn(async (contents) => {
                    return await llmHelper.generateContentStructured(contents[0]?.text || '');
                });
                // Embedding function — lazily delegate to the cascaded EmbeddingPipeline
                // (OpenAI → Gemini → Ollama → Local bundled model).
                // We await waitForReady() so uploads during boot wait for the pipeline
                // instead of immediately throwing 'not ready'.
                const self = this;
                this.knowledgeOrchestrator.setEmbedFn(async (text) => {
                    const pipeline = self.ragManager?.getEmbeddingPipeline();
                    if (!pipeline)
                        throw new Error('RAG pipeline not available');
                    await pipeline.waitForReady();
                    return await pipeline.getEmbedding(text);
                });
                if (typeof this.knowledgeOrchestrator.setEmbedQueryFn === 'function') {
                    this.knowledgeOrchestrator.setEmbedQueryFn(async (text) => {
                        const pipeline = self.ragManager?.getEmbeddingPipeline();
                        if (!pipeline)
                            throw new Error('RAG pipeline not available');
                        await pipeline.waitForReady();
                        return await pipeline.getEmbeddingForQuery(text);
                    });
                }
                // Attach KnowledgeOrchestrator to LLMHelper
                llmHelper.setKnowledgeOrchestrator(this.knowledgeOrchestrator);
                console.log('[AppState] KnowledgeOrchestrator initialized');
            }
        }
        catch (error) {
            console.error('[AppState] Failed to initialize KnowledgeOrchestrator:', error);
        }
    }
    setupAutoUpdater() {
        electron_updater_1.autoUpdater.autoDownload = false;
        electron_updater_1.autoUpdater.autoInstallOnAppQuit = false; // Manual install only via button
        electron_updater_1.autoUpdater.on("checking-for-update", () => {
            console.log("[AutoUpdater] Checking for update...");
            this.broadcast("update-checking");
        });
        electron_updater_1.autoUpdater.on("update-available", async (info) => {
            console.log("[AutoUpdater] Update available:", info.version);
            this.updateAvailable = true;
            // Fetch structured release notes
            const releaseManager = ReleaseNotesManager_1.ReleaseNotesManager.getInstance();
            const notes = await releaseManager.fetchReleaseNotes(info.version);
            // Notify renderer that an update is available with parsed notes if available
            this.broadcast("update-available", {
                ...info,
                parsedNotes: notes
            });
        });
        electron_updater_1.autoUpdater.on("update-not-available", (info) => {
            console.log("[AutoUpdater] Update not available:", info.version);
            this.broadcast("update-not-available", info);
        });
        electron_updater_1.autoUpdater.on("error", (err) => {
            console.error("[AutoUpdater] Error:", err);
            this.broadcast("update-error", err.message);
        });
        electron_updater_1.autoUpdater.on("download-progress", (progressObj) => {
            let log_message = "Download speed: " + progressObj.bytesPerSecond;
            log_message = log_message + " - Downloaded " + progressObj.percent + "%";
            log_message = log_message + " (" + progressObj.transferred + "/" + progressObj.total + ")";
            console.log("[AutoUpdater] " + log_message);
            this.broadcast("download-progress", progressObj);
        });
        electron_updater_1.autoUpdater.on("update-downloaded", (info) => {
            console.log("[AutoUpdater] Update downloaded:", info.version);
            // Notify renderer that update is ready to install
            this.broadcast("update-downloaded", info);
        });
        // Start checking for updates with a 10-second delay
        setTimeout(() => {
            if (process.env.NODE_ENV === "development") {
                console.log("[AutoUpdater] Development mode: Running manual update check...");
                this.checkForUpdatesManual();
            }
            else {
                electron_updater_1.autoUpdater.checkForUpdatesAndNotify().catch(err => {
                    console.error("[AutoUpdater] Failed to check for updates:", err);
                });
            }
        }, 10000);
    }
    async checkForUpdatesManual() {
        try {
            console.log('[AutoUpdater] Checking for updates manually via GitHub API...');
            const releaseManager = ReleaseNotesManager_1.ReleaseNotesManager.getInstance();
            // Fetch latest release
            const notes = await releaseManager.fetchReleaseNotes('latest');
            if (notes) {
                const currentVersion = electron_1.app.getVersion();
                const latestVersionTag = notes.version; // e.g., "v1.2.0" or "1.2.0"
                const latestVersion = latestVersionTag.replace(/^v/, '');
                console.log(`[AutoUpdater] Manual Check: Current=${currentVersion}, Latest=${latestVersion}`);
                if (this.isVersionNewer(currentVersion, latestVersion)) {
                    console.log('[AutoUpdater] Manual Check: New version found!');
                    this.updateAvailable = true;
                    // Mock an info object compatible with electron-updater
                    const info = {
                        version: latestVersion,
                        files: [],
                        path: '',
                        sha512: '',
                        releaseName: notes.summary,
                        releaseNotes: notes.fullBody
                    };
                    // Notify renderer
                    this.broadcast("update-available", {
                        ...info,
                        parsedNotes: notes
                    });
                }
                else {
                    console.log('[AutoUpdater] Manual Check: App is up to date.');
                    this.broadcast("update-not-available", { version: currentVersion });
                }
            }
        }
        catch (err) {
            console.error('[AutoUpdater] Manual update check failed:', err);
        }
    }
    isVersionNewer(current, latest) {
        const c = current.split('.').map(Number);
        const l = latest.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            const cv = c[i] || 0;
            const lv = l[i] || 0;
            if (lv > cv)
                return true;
            if (lv < cv)
                return false;
        }
        return false;
    }
    async quitAndInstallUpdate() {
        console.log('[AutoUpdater] quitAndInstall called - applying update...');
        // On macOS, unsigned apps can't auto-restart via quitAndInstall
        // Workaround: Open the folder containing the downloaded update so user can install manually
        if (process.platform === 'darwin') {
            try {
                // Get the downloaded update file path (e.g., .../Natively-1.0.9-mac.zip)
                const updateFile = electron_updater_1.autoUpdater.downloadedUpdateHelper?.file;
                console.log('[AutoUpdater] Downloaded update file:', updateFile);
                if (updateFile) {
                    const updateDir = path_1.default.dirname(updateFile);
                    // Open the directory containing the update in Finder
                    await electron_1.shell.openPath(updateDir);
                    console.log('[AutoUpdater] Opened update directory:', updateDir);
                    // Quit the app so user can install new version
                    setTimeout(() => electron_1.app.quit(), 1000);
                    return;
                }
            }
            catch (err) {
                console.error('[AutoUpdater] Failed to open update directory:', err);
            }
        }
        // Fallback to standard quitAndInstall (works on Windows/Linux or if signed)
        setImmediate(() => {
            try {
                electron_updater_1.autoUpdater.quitAndInstall(false, true);
            }
            catch (err) {
                console.error('[AutoUpdater] quitAndInstall failed:', err);
                electron_1.app.exit(0);
            }
        });
    }
    async checkForUpdates() {
        await electron_updater_1.autoUpdater.checkForUpdatesAndNotify();
    }
    downloadUpdate() {
        electron_updater_1.autoUpdater.downloadUpdate();
    }
    // New Property for System Audio & Microphone
    systemAudioCapture = null;
    microphoneCapture = null;
    audioTestCapture = null; // For audio settings test
    googleSTT = null; // Interviewer
    googleSTT_User = null; // User
    // Listener references for proper cleanup (prevent memory leaks)
    sttTranscriptListener_Interviewer = null;
    sttErrorListener_Interviewer = null;
    sttTranscriptListener_User = null;
    sttErrorListener_User = null;
    createSTTProvider(speaker) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        const sttProvider = CredentialsManager.getInstance().getSttProvider();
        const sttLanguage = CredentialsManager.getInstance().getSttLanguage();
        let stt;
        if (sttProvider === 'deepgram') {
            const apiKey = CredentialsManager.getInstance().getDeepgramApiKey();
            if (apiKey) {
                console.log(`[Main] Using DeepgramStreamingSTT for ${speaker}`);
                stt = new DeepgramStreamingSTT_1.DeepgramStreamingSTT(apiKey);
            }
            else {
                console.warn(`[Main] No API key for Deepgram STT, falling back to GoogleSTT`);
                stt = new GoogleSTT_1.GoogleSTT();
            }
        }
        else if (sttProvider === 'soniox') {
            const apiKey = CredentialsManager.getInstance().getSonioxApiKey();
            if (apiKey) {
                console.log(`[Main] Using SonioxStreamingSTT for ${speaker}`);
                stt = new SonioxStreamingSTT_1.SonioxStreamingSTT(apiKey);
            }
            else {
                console.warn(`[Main] No API key for Soniox STT, falling back to GoogleSTT`);
                stt = new GoogleSTT_1.GoogleSTT();
            }
        }
        else if (sttProvider === 'elevenlabs') {
            const apiKey = CredentialsManager.getInstance().getElevenLabsApiKey();
            if (apiKey) {
                console.log(`[Main] Using ElevenLabsStreamingSTT for ${speaker}`);
                stt = new ElevenLabsStreamingSTT_1.ElevenLabsStreamingSTT(apiKey);
            }
            else {
                console.warn(`[Main] No API key for ElevenLabs STT, falling back to GoogleSTT`);
                stt = new GoogleSTT_1.GoogleSTT();
            }
        }
        else if (sttProvider === 'openai') {
            // OpenAI: WebSocket Realtime (gpt-4o-transcribe → gpt-4o-mini-transcribe) with whisper-1 REST fallback
            const apiKey = CredentialsManager.getInstance().getOpenAiSttApiKey();
            if (apiKey) {
                console.log(`[Main] Using OpenAIStreamingSTT (WebSocket+REST fallback) for ${speaker}`);
                stt = new OpenAIStreamingSTT_1.OpenAIStreamingSTT(apiKey);
            }
            else {
                console.warn(`[Main] No API key for OpenAI STT, falling back to GoogleSTT`);
                stt = new GoogleSTT_1.GoogleSTT();
            }
        }
        else if (sttProvider === 'groq' || sttProvider === 'azure' || sttProvider === 'ibmwatson') {
            let apiKey;
            let region;
            let modelOverride;
            if (sttProvider === 'groq') {
                apiKey = CredentialsManager.getInstance().getGroqSttApiKey();
                modelOverride = CredentialsManager.getInstance().getGroqSttModel();
            }
            else if (sttProvider === 'azure') {
                apiKey = CredentialsManager.getInstance().getAzureApiKey();
                region = CredentialsManager.getInstance().getAzureRegion();
            }
            else if (sttProvider === 'ibmwatson') {
                apiKey = CredentialsManager.getInstance().getIbmWatsonApiKey();
                region = CredentialsManager.getInstance().getIbmWatsonRegion();
            }
            if (apiKey) {
                console.log(`[Main] Using RestSTT (${sttProvider}) for ${speaker}`);
                stt = new RestSTT_1.RestSTT(sttProvider, apiKey, modelOverride, region);
            }
            else {
                console.warn(`[Main] No API key for ${sttProvider} STT, falling back to GoogleSTT`);
                stt = new GoogleSTT_1.GoogleSTT();
            }
        }
        else {
            stt = new GoogleSTT_1.GoogleSTT();
        }
        stt.setRecognitionLanguage(sttLanguage);
        // Wire Transcript Events - store references for proper cleanup
        const sttEmitter = stt;
        const transcriptHandler = (segment) => {
            if (!this.isMeetingActive) {
                return;
            }
            this.intelligenceManager.handleTranscript({
                speaker: speaker,
                text: segment.text,
                timestamp: Date.now(),
                final: segment.isFinal,
                confidence: segment.confidence
            });
            // Feed final transcript to JIT RAG indexer
            if (segment.isFinal && this.ragManager) {
                this.ragManager.feedLiveTranscript([{
                        speaker: speaker,
                        text: segment.text,
                        timestamp: Date.now()
                    }]);
            }
            const helper = this.getWindowHelper();
            const payload = {
                speaker: speaker,
                text: segment.text,
                timestamp: Date.now(),
                final: segment.isFinal,
                confidence: segment.confidence
            };
            helper.getLauncherWindow()?.webContents.send('native-audio-transcript', payload);
            helper.getOverlayWindow()?.webContents.send('native-audio-transcript', payload);
            void (0, ConsciousMode_1.maybeHandleSuggestionTriggerFromTranscript)({
                speaker,
                text: segment.text,
                final: segment.isFinal,
                confidence: segment.confidence,
                consciousModeEnabled: this.consciousModeEnabled,
                intelligenceManager: this.intelligenceManager,
            }).catch((error) => {
                console.error('[Main] Failed to auto-trigger interview assist:', error);
            });
        };
        const errorHandler = (err) => {
            console.error(`[Main] STT (${speaker}) Error:`, err);
        };
        // Store listener references based on speaker
        if (speaker === 'interviewer') {
            this.sttTranscriptListener_Interviewer = transcriptHandler;
            this.sttErrorListener_Interviewer = errorHandler;
        }
        else {
            this.sttTranscriptListener_User = transcriptHandler;
            this.sttErrorListener_User = errorHandler;
        }
        sttEmitter.on('transcript', transcriptHandler);
        sttEmitter.on('error', errorHandler);
        return stt;
    }
    setupSystemAudioPipeline() {
        // REMOVED EARLY RETURN: if (this.systemAudioCapture && this.microphoneCapture) return; // Already initialized
        try {
            // 1. Initialize Captures if missing
            // If they already exist (e.g. from reconfigureAudio), they are already wired to write to this.googleSTT/User
            if (!this.systemAudioCapture) {
                this.systemAudioCapture = new SystemAudioCapture_1.SystemAudioCapture();
                // Wire Capture -> STT
                this.systemAudioCapture.on('data', (chunk) => {
                    this.googleSTT?.write(chunk);
                });
                this.systemAudioCapture.on('speech_ended', () => {
                    safeNotifySpeechEnded(this.googleSTT);
                });
                this.systemAudioCapture.on('error', (err) => {
                    console.error('[Main] SystemAudioCapture Error:', err);
                    this.setNativeAudioConnected(false);
                    this.broadcast('meeting-audio-error', err.message || 'System audio capture failed');
                });
            }
            if (!this.microphoneCapture) {
                this.microphoneCapture = new MicrophoneCapture_1.MicrophoneCapture();
                this.microphoneCapture.on('data', (chunk) => {
                    this.googleSTT_User?.write(chunk);
                });
                this.microphoneCapture.on('speech_ended', () => {
                    safeNotifySpeechEnded(this.googleSTT_User);
                });
                this.microphoneCapture.on('error', (err) => {
                    console.error('[Main] MicrophoneCapture Error:', err);
                    this.setNativeAudioConnected(false);
                    this.broadcast('meeting-audio-error', err.message || 'Microphone capture failed');
                });
            }
            // 2. Initialize STT Services if missing
            if (!this.googleSTT) {
                this.googleSTT = this.createSTTProvider('interviewer');
            }
            if (!this.googleSTT_User) {
                this.googleSTT_User = this.createSTTProvider('user');
            }
            // --- CRITICAL FIX: SYNC SAMPLE RATES ---
            // Always sync rates, even if just initialized, to ensure consistency
            // 1. Sync System Audio Rate
            const sysRate = this.systemAudioCapture?.getSampleRate() || 48000;
            console.log(`[Main] Configuring Interviewer STT to ${sysRate}Hz`);
            this.googleSTT?.setSampleRate(sysRate);
            safeSetAudioChannelCount(this.googleSTT, 1);
            // 2. Sync Mic Rate
            const micRate = this.microphoneCapture?.getSampleRate() || 48000;
            console.log(`[Main] Configuring User STT to ${micRate}Hz`);
            this.googleSTT_User?.setSampleRate(micRate);
            safeSetAudioChannelCount(this.googleSTT_User, 1);
            console.log('[Main] Full Audio Pipeline (System + Mic) Initialized (Ready)');
        }
        catch (err) {
            console.error('[Main] Failed to setup System Audio Pipeline:', err);
        }
    }
    async reconfigureAudio(inputDeviceId, outputDeviceId) {
        console.log(`[Main] Reconfiguring Audio: Input=${inputDeviceId}, Output=${outputDeviceId}`);
        // 1. System Audio (Output Capture)
        if (this.systemAudioCapture) {
            this.systemAudioCapture.stop();
            this.systemAudioCapture = null;
        }
        try {
            console.log('[Main] Initializing SystemAudioCapture...');
            this.systemAudioCapture = new SystemAudioCapture_1.SystemAudioCapture(outputDeviceId || undefined);
            const rate = this.systemAudioCapture.getSampleRate();
            console.log(`[Main] SystemAudioCapture rate: ${rate}Hz`);
            this.googleSTT?.setSampleRate(rate);
            this.systemAudioCapture.on('data', (chunk) => {
                // console.log('[Main] SysAudio chunk', chunk.length);
                this.googleSTT?.write(chunk);
            });
            this.systemAudioCapture.on('speech_ended', () => {
                safeNotifySpeechEnded(this.googleSTT);
            });
            this.systemAudioCapture.on('error', (err) => {
                console.error('[Main] SystemAudioCapture Error:', err);
                this.setNativeAudioConnected(false);
                this.broadcast('meeting-audio-error', err.message || 'System audio capture failed');
            });
            console.log('[Main] SystemAudioCapture initialized.');
        }
        catch (err) {
            console.warn('[Main] Failed to initialize SystemAudioCapture with preferred ID. Falling back to default.', err);
            try {
                this.systemAudioCapture = new SystemAudioCapture_1.SystemAudioCapture(); // Default
                const rate = this.systemAudioCapture.getSampleRate();
                console.log(`[Main] SystemAudioCapture (Default) rate: ${rate}Hz`);
                this.googleSTT?.setSampleRate(rate);
                this.systemAudioCapture.on('data', (chunk) => {
                    this.googleSTT?.write(chunk);
                });
                this.systemAudioCapture.on('speech_ended', () => {
                    safeNotifySpeechEnded(this.googleSTT);
                });
                this.systemAudioCapture.on('error', (err) => {
                    console.error('[Main] SystemAudioCapture (Default) Error:', err);
                    this.setNativeAudioConnected(false);
                    this.broadcast('meeting-audio-error', err.message || 'System audio capture failed');
                });
            }
            catch (err2) {
                console.error('[Main] Failed to initialize SystemAudioCapture (Default):', err2);
            }
        }
        // 2. Microphone (Input Capture)
        if (this.microphoneCapture) {
            this.microphoneCapture.stop();
            this.microphoneCapture = null;
        }
        try {
            console.log('[Main] Initializing MicrophoneCapture...');
            this.microphoneCapture = new MicrophoneCapture_1.MicrophoneCapture(inputDeviceId || undefined);
            const rate = this.microphoneCapture.getSampleRate();
            console.log(`[Main] MicrophoneCapture rate: ${rate}Hz`);
            this.googleSTT_User?.setSampleRate(rate);
            this.microphoneCapture.on('data', (chunk) => {
                // console.log('[Main] Mic chunk', chunk.length);
                this.googleSTT_User?.write(chunk);
            });
            this.microphoneCapture.on('speech_ended', () => {
                safeNotifySpeechEnded(this.googleSTT_User);
            });
            this.microphoneCapture.on('error', (err) => {
                console.error('[Main] MicrophoneCapture Error:', err);
                this.setNativeAudioConnected(false);
                this.broadcast('meeting-audio-error', err.message || 'Microphone capture failed');
            });
            console.log('[Main] MicrophoneCapture initialized.');
        }
        catch (err) {
            console.warn('[Main] Failed to initialize MicrophoneCapture with preferred ID. Falling back to default.', err);
            try {
                this.microphoneCapture = new MicrophoneCapture_1.MicrophoneCapture(); // Default
                const rate = this.microphoneCapture.getSampleRate();
                console.log(`[Main] MicrophoneCapture (Default) rate: ${rate}Hz`);
                this.googleSTT_User?.setSampleRate(rate);
                this.microphoneCapture.on('data', (chunk) => {
                    this.googleSTT_User?.write(chunk);
                });
                this.microphoneCapture.on('speech_ended', () => {
                    this.googleSTT_User?.notifySpeechEnded?.();
                });
                this.microphoneCapture.on('error', (err) => {
                    console.error('[Main] MicrophoneCapture (Default) Error:', err);
                    this.setNativeAudioConnected(false);
                    this.broadcast('meeting-audio-error', err.message || 'Microphone capture failed');
                });
            }
            catch (err2) {
                console.error('[Main] Failed to initialize MicrophoneCapture (Default):', err2);
            }
        }
    }
    /**
     * Reconfigure STT provider mid-session (called from IPC when user changes provider)
     * Destroys existing STT instances and recreates them with the new provider
     */
    async reconfigureSttProvider() {
        console.log('[Main] Reconfiguring STT Provider...');
        // Stop existing STT instances - remove listeners using stored references first
        if (this.googleSTT) {
            const sttEmitter = this.googleSTT;
            if (this.sttTranscriptListener_Interviewer) {
                sttEmitter.removeListener('transcript', this.sttTranscriptListener_Interviewer);
                this.sttTranscriptListener_Interviewer = null;
            }
            if (this.sttErrorListener_Interviewer) {
                sttEmitter.removeListener('error', this.sttErrorListener_Interviewer);
                this.sttErrorListener_Interviewer = null;
            }
            safeDestroy(this.googleSTT);
            this.googleSTT.stop();
            this.googleSTT.removeAllListeners();
            this.googleSTT = null;
        }
        if (this.googleSTT_User) {
            const sttEmitter = this.googleSTT_User;
            if (this.sttTranscriptListener_User) {
                sttEmitter.removeListener('transcript', this.sttTranscriptListener_User);
                this.sttTranscriptListener_User = null;
            }
            if (this.sttErrorListener_User) {
                sttEmitter.removeListener('error', this.sttErrorListener_User);
                this.sttErrorListener_User = null;
            }
            safeDestroy(this.googleSTT_User);
            this.googleSTT_User.stop();
            this.googleSTT_User.removeAllListeners();
            this.googleSTT_User = null;
        }
        // Reinitialize the pipeline (will pick up the new provider from CredentialsManager)
        this.setupSystemAudioPipeline();
        // Start the new STT instances if a meeting is active
        if (this.isMeetingActive) {
            const interviewerStt = this.googleSTT;
            const userStt = this.googleSTT_User;
            interviewerStt?.start?.();
            userStt?.start?.();
        }
        console.log('[Main] STT Provider reconfigured');
    }
    startAudioTest(deviceId) {
        console.log(`[Main] Starting Audio Test on device: ${deviceId || 'default'}`);
        this.stopAudioTest(); // Stop any existing test
        try {
            this.audioTestCapture = new MicrophoneCapture_1.MicrophoneCapture(deviceId || undefined);
            this.audioTestCapture.start();
            // Send to settings window if open, else main window
            const win = this.settingsWindowHelper.getSettingsWindow() || this.getMainWindow();
            this.audioTestCapture.on('data', (chunk) => {
                // Calculate basic RMS for level meter
                if (!win || win.isDestroyed())
                    return;
                let sum = 0;
                const step = 10;
                const len = chunk.length;
                for (let i = 0; i < len; i += 2 * step) {
                    const val = chunk.readInt16LE(i);
                    sum += val * val;
                }
                const count = len / (2 * step);
                if (count > 0) {
                    const rms = Math.sqrt(sum / count);
                    // Normalize 0-1 (heuristic scaling, max comfortable mic input is around 10000-20000)
                    const level = Math.min(rms / 10000, 1.0);
                    if (win && !win.isDestroyed()) {
                        win.webContents.send('audio-level', level);
                    }
                }
            });
            this.audioTestCapture.on('error', (err) => {
                console.error('[Main] AudioTest Error:', err);
            });
        }
        catch (err) {
            console.error('[Main] Failed to start audio test:', err);
        }
    }
    stopAudioTest() {
        if (this.audioTestCapture) {
            console.log('[Main] Stopping Audio Test');
            this.audioTestCapture.stop();
            this.audioTestCapture = null;
        }
    }
    finalizeMicSTT() {
        // We only want to finalize the user microphone, because the context is Manual Answer
        safeFinalize(this.googleSTT_User);
        console.log('[Main] STT finalized');
    }
    async startMeeting(metadata) {
        console.log('[Main] Starting Meeting...', metadata);
        // Chain this operation after any pending meeting start operations
        return this.meetingStartMutex = this.meetingStartMutex.then(async () => {
            // Critical section: check and update state atomically
            if (this.meetingLifecycleState === 'starting' || this.meetingLifecycleState === 'active') {
                console.warn(`[Main] Ignoring startMeeting while state=${this.meetingLifecycleState}`);
                return;
            }
            this.meetingLifecycleState = 'starting';
            const startSequence = ++this.meetingStartSequence;
            try {
                await this.validateMeetingAudioSetup(metadata);
            }
            catch (error) {
                this.meetingLifecycleState = 'idle';
                throw error;
            }
            this.isMeetingActive = true;
            if (metadata) {
                this.intelligenceManager.setMeetingMetadata(metadata);
            }
            // Emit session reset to clear UI state immediately
            this.getWindowHelper().getOverlayWindow()?.webContents.send('session-reset');
            this.getWindowHelper().getLauncherWindow()?.webContents.send('session-reset');
            // ★ ASYNC AUDIO INIT: Return INSTANTLY so the IPC response goes back
            // to the renderer immediately, allowing the UI to switch to overlay
            // without waiting for SCK/audio initialization (which takes 5-7 seconds).
            // setTimeout(100) ensures setWindowMode IPC is processed first.
            return new Promise((resolve, reject) => {
                setTimeout(async () => {
                    // Check if this is still the current meeting start sequence
                    if (startSequence !== this.meetingStartSequence || this.meetingLifecycleState !== 'starting') {
                        console.warn('[Main] Skipping stale deferred meeting start');
                        resolve(); // Resolve rather than reject as this is expected behavior
                        return;
                    }
                    try {
                        // Check for audio configuration preference
                        if (metadata?.audio) {
                            await this.reconfigureAudio(metadata.audio.inputDeviceId, metadata.audio.outputDeviceId);
                        }
                        // Double-check sequence after async operations
                        if (startSequence !== this.meetingStartSequence || this.meetingLifecycleState !== 'starting') {
                            console.warn('[Main] Meeting start invalidated during async initialization');
                            resolve(); // Resolve rather than reject as this is expected behavior
                            return;
                        }
                        // LAZY INIT: Ensure pipeline is ready (if not reconfigured above)
                        this.setupSystemAudioPipeline();
                        // Start System Audio
                        this.systemAudioCapture?.start();
                        this.googleSTT?.start();
                        // Start Microphone
                        this.microphoneCapture?.start();
                        this.googleSTT_User?.start();
                        // Start JIT RAG live indexing
                        if (this.ragManager) {
                            this.ragManager.startLiveIndexing('live-meeting-current');
                        }
                        this.setNativeAudioConnected(true);
                        this.meetingLifecycleState = 'active';
                        console.log('[Main] Audio pipeline started successfully.');
                        resolve();
                    }
                    catch (err) {
                        console.error('[Main] Error initializing audio pipeline:', err);
                        // Notify UI so user knows microphone/audio failed to start
                        this.setNativeAudioConnected(false);
                        this.broadcast('meeting-audio-error', err.message || 'Audio pipeline failed to start');
                        this.isMeetingActive = false;
                        this.meetingLifecycleState = 'idle';
                        reject(err);
                    }
                }, 0); // Defer to next event loop tick — ensures IPC response reaches renderer before audio init
            });
        });
    }
    async endMeeting() {
        console.log('[Main] Ending Meeting...');
        const endSequence = ++this.meetingStartSequence; // Increment sequence to invalidate any pending starts
        this.meetingLifecycleState = 'stopping';
        this.isMeetingActive = false; // Block new data immediately
        this.setNativeAudioConnected(false);
        // Wait for any pending meeting start operations to complete before proceeding
        // This prevents race conditions between start and end operations
        await this.meetingStartMutex.catch(() => {
            // Ignore errors from the mutex as we're ending the meeting anyway
            console.log('[Main] Ignoring pending meeting start errors during endMeeting');
        });
        // 3. Stop System Audio
        try {
            this.systemAudioCapture?.stop();
        }
        catch (error) {
            console.error('[Main] Failed to stop system audio during endMeeting:', error);
        }
        // Stop interviewer STT with proper listener cleanup
        try {
            if (this.googleSTT) {
                const sttEmitter = this.googleSTT;
                if (this.sttTranscriptListener_Interviewer) {
                    sttEmitter.removeListener('transcript', this.sttTranscriptListener_Interviewer);
                    this.sttTranscriptListener_Interviewer = null;
                }
                if (this.sttErrorListener_Interviewer) {
                    sttEmitter.removeListener('error', this.sttErrorListener_Interviewer);
                    this.sttErrorListener_Interviewer = null;
                }
                this.googleSTT?.stop();
                this.googleSTT?.removeAllListeners();
            }
        }
        catch (error) {
            console.error('[Main] Failed to stop interviewer STT during endMeeting:', error);
        }
        // 4. Stop Microphone
        try {
            this.microphoneCapture?.stop();
        }
        catch (error) {
            console.error('[Main] Failed to stop microphone capture during endMeeting:', error);
        }
        // Stop user STT with proper listener cleanup
        try {
            if (this.googleSTT_User) {
                const sttEmitter = this.googleSTT_User;
                if (this.sttTranscriptListener_User) {
                    sttEmitter.removeListener('transcript', this.sttTranscriptListener_User);
                    this.sttTranscriptListener_User = null;
                }
                if (this.sttErrorListener_User) {
                    sttEmitter.removeListener('error', this.sttErrorListener_User);
                    this.sttErrorListener_User = null;
                }
                this.googleSTT_User?.stop();
                this.googleSTT_User?.removeAllListeners();
            }
        }
        catch (error) {
            console.error('[Main] Failed to stop user STT during endMeeting:', error);
        }
        // 4b. Stop JIT RAG live indexing (flush remaining segments)
        if (this.ragManager) {
            try {
                await this.ragManager.stopLiveIndexing();
            }
            catch (error) {
                console.error('[Main] Failed to stop live indexing during endMeeting:', error);
            }
        }
        // 4. Reset Intelligence Context & Save
        await this.intelligenceManager.stopMeeting();
        // 5. Revert to Default Model (One-Way Sync Revert)
        // This ensures next meeting starts with default, not the temporary one used in this session
        try {
            const { CredentialsManager } = require('./services/CredentialsManager');
            const cm = CredentialsManager.getInstance();
            const defaultModel = cm.getDefaultModel();
            // Re-fetch custom providers to ensure context correctness
            const curlProviders = cm.getCurlProviders();
            const legacyProviders = cm.getCustomProviders();
            const all = [...(curlProviders || []), ...(legacyProviders || [])];
            console.log(`[Main] Reverting model to default: ${defaultModel}`);
            this.processingHelper.getLLMHelper().setModel(defaultModel, all);
            // Broadcast revert to UI
            electron_1.BrowserWindow.getAllWindows().forEach(win => {
                if (!win.isDestroyed())
                    win.webContents.send('model-changed', defaultModel);
            });
        }
        catch (e) {
            console.error("[Main] Failed to revert model:", e);
        }
        // 6. Process meeting for RAG (embeddings)
        await this.processCompletedMeetingForRAG();
        // 7. Clean up JIT RAG provisional chunks (post-meeting RAG replaces them)
        if (this.ragManager) {
            this.ragManager.deleteMeetingData('live-meeting-current');
        }
        this.meetingLifecycleState = 'idle';
    }
    cleanupForQuit() {
        this.meetingStartSequence += 1;
        this.meetingLifecycleState = 'idle';
        this.isMeetingActive = false;
        this.setNativeAudioConnected(false);
        // Clear disguise timers to prevent memory leaks
        this.clearDisguiseTimers();
        try {
            this.systemAudioCapture?.stop();
        }
        catch (error) {
            console.error('[Main] Failed to stop system audio during quit:', error);
        }
        // Stop interviewer STT with proper listener cleanup
        try {
            if (this.googleSTT) {
                const sttEmitter = this.googleSTT;
                if (this.sttTranscriptListener_Interviewer) {
                    sttEmitter.removeListener('transcript', this.sttTranscriptListener_Interviewer);
                    this.sttTranscriptListener_Interviewer = null;
                }
                if (this.sttErrorListener_Interviewer) {
                    sttEmitter.removeListener('error', this.sttErrorListener_Interviewer);
                    this.sttErrorListener_Interviewer = null;
                }
                this.googleSTT?.stop();
                this.googleSTT?.removeAllListeners();
                safeDestroy(this.googleSTT);
            }
        }
        catch (error) {
            console.error('[Main] Failed to stop interviewer STT during quit:', error);
        }
        try {
            this.microphoneCapture?.stop();
        }
        catch (error) {
            console.error('[Main] Failed to stop microphone capture during quit:', error);
        }
        // Stop user STT with proper listener cleanup
        try {
            if (this.googleSTT_User) {
                const sttEmitter = this.googleSTT_User;
                if (this.sttTranscriptListener_User) {
                    sttEmitter.removeListener('transcript', this.sttTranscriptListener_User);
                    this.sttTranscriptListener_User = null;
                }
                if (this.sttErrorListener_User) {
                    sttEmitter.removeListener('error', this.sttErrorListener_User);
                    this.sttErrorListener_User = null;
                }
                this.googleSTT_User?.stop();
                this.googleSTT_User?.removeAllListeners();
                safeDestroy(this.googleSTT_User);
            }
        }
        catch (error) {
            console.error('[Main] Failed to stop user STT during quit:', error);
        }
        try {
            this.audioTestCapture?.stop();
        }
        catch (error) {
            console.error('[Main] Failed to stop audio test capture during quit:', error);
        }
        this.systemAudioCapture = null;
        this.microphoneCapture = null;
        this.audioTestCapture = null;
        this.googleSTT = null;
        this.googleSTT_User = null;
        this.ragManager?.stopLiveIndexing().catch(err => {
            console.error('[Main] Failed to stop live indexing during quit:', err);
        });
        this.intelligenceManager.stopMeeting().catch(err => {
            console.error('[Main] Failed to stop intelligence manager during quit:', err);
        });
    }
    async processCompletedMeetingForRAG() {
        if (!this.ragManager)
            return;
        try {
            // Get the most recent meeting from database
            const meetings = DatabaseManager_1.DatabaseManager.getInstance().getRecentMeetings(1);
            if (meetings.length === 0)
                return;
            const meeting = DatabaseManager_1.DatabaseManager.getInstance().getMeetingDetails(meetings[0].id);
            if (!meeting || !meeting.transcript || meeting.transcript.length === 0)
                return;
            // Convert transcript to RAG format
            const segments = meeting.transcript.map(t => ({
                speaker: t.speaker,
                text: t.text,
                timestamp: t.timestamp
            }));
            // Generate summary from detailedSummary if available
            let summary;
            if (meeting.detailedSummary) {
                summary = [
                    ...(meeting.detailedSummary.keyPoints || []),
                    ...(meeting.detailedSummary.actionItems || []).map(a => `Action: ${a}`)
                ].join('. ');
            }
            const result = await this.ragManager.processMeeting(meeting.id, segments, summary);
            console.log(`[AppState] RAG processed meeting ${meeting.id}: ${result.chunkCount} chunks`);
        }
        catch (error) {
            console.error('[AppState] Failed to process meeting for RAG:', error);
        }
    }
    setupIntelligenceEvents() {
        const mainWindow = this.getMainWindow.bind(this);
        // Forward intelligence events to renderer
        this.intelligenceManager.on('assist_update', (insight) => {
            // Send to both if both exist, though mostly overlay needs it
            const helper = this.getWindowHelper();
            helper.getLauncherWindow()?.webContents.send('intelligence-assist-update', { insight });
            helper.getOverlayWindow()?.webContents.send('intelligence-assist-update', { insight });
        });
        this.intelligenceManager.on('suggested_answer', (answer, question, confidence) => {
            const win = mainWindow();
            if (win) {
                win.webContents.send('intelligence-suggested-answer', { answer, question, confidence });
            }
        });
        this.intelligenceManager.on('suggested_answer_token', (token, question, confidence) => {
            const win = mainWindow();
            if (win) {
                win.webContents.send('intelligence-suggested-answer-token', { token, question, confidence });
            }
        });
        this.intelligenceManager.on('refined_answer_token', (token, intent) => {
            const win = mainWindow();
            if (win) {
                win.webContents.send('intelligence-refined-answer-token', { token, intent });
            }
        });
        this.intelligenceManager.on('refined_answer', (answer, intent) => {
            const win = mainWindow();
            if (win) {
                win.webContents.send('intelligence-refined-answer', { answer, intent });
            }
        });
        this.intelligenceManager.on('recap', (summary) => {
            const win = mainWindow();
            if (win) {
                win.webContents.send('intelligence-recap', { summary });
            }
        });
        this.intelligenceManager.on('recap_token', (token) => {
            const win = mainWindow();
            if (win) {
                win.webContents.send('intelligence-recap-token', { token });
            }
        });
        this.intelligenceManager.on('follow_up_questions_update', (questions) => {
            const win = mainWindow();
            if (win) {
                win.webContents.send('intelligence-follow-up-questions-update', { questions });
            }
        });
        this.intelligenceManager.on('follow_up_questions_token', (token) => {
            const win = mainWindow();
            if (win) {
                win.webContents.send('intelligence-follow-up-questions-token', { token });
            }
        });
        this.intelligenceManager.on('manual_answer_started', () => {
            const win = mainWindow();
            if (win) {
                win.webContents.send('intelligence-manual-started');
            }
        });
        this.intelligenceManager.on('manual_answer_result', (answer, question) => {
            const win = mainWindow();
            if (win) {
                win.webContents.send('intelligence-manual-result', { answer, question });
            }
        });
        this.intelligenceManager.on('mode_changed', (mode) => {
            const win = mainWindow();
            if (win) {
                win.webContents.send('intelligence-mode-changed', { mode });
            }
        });
        this.intelligenceManager.on('error', (error, mode) => {
            console.error(`[IntelligenceManager] Error in ${mode}:`, error);
            const win = mainWindow();
            if (win) {
                win.webContents.send('intelligence-error', { error: error.message, mode });
            }
        });
    }
    updateGoogleCredentials(keyPath) {
        console.log(`[AppState] Updating Google Credentials to: ${keyPath}`);
        // Set global environment variable so new instances pick it up
        process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
        if (this.googleSTT) {
            this.googleSTT.setCredentials(keyPath);
        }
        if (this.googleSTT_User) {
            this.googleSTT_User.setCredentials(keyPath);
        }
    }
    setRecognitionLanguage(key) {
        console.log(`[AppState] Setting recognition language to: ${key}`);
        const { CredentialsManager } = require('./services/CredentialsManager');
        CredentialsManager.getInstance().setSttLanguage(key);
        this.googleSTT?.setRecognitionLanguage(key);
        this.googleSTT_User?.setRecognitionLanguage(key);
        this.processingHelper.getLLMHelper().setSttLanguage(key);
    }
    static getInstance() {
        if (!AppState.instance) {
            AppState.instance = new AppState();
        }
        return AppState.instance;
    }
    // Getters and Setters
    getMainWindow() {
        return this.windowHelper.getMainWindow();
    }
    getWindowHelper() {
        return this.windowHelper;
    }
    getIntelligenceManager() {
        return this.intelligenceManager;
    }
    getThemeManager() {
        return this.themeManager;
    }
    getRAGManager() {
        return this.ragManager;
    }
    getKnowledgeOrchestrator() {
        return this.knowledgeOrchestrator;
    }
    getView() {
        return this.view;
    }
    setView(view) {
        this.view = view;
        this.screenshotHelper.setView(view);
    }
    isVisible() {
        return this.windowHelper.isVisible();
    }
    getScreenshotHelper() {
        return this.screenshotHelper;
    }
    getProblemInfo() {
        return this.problemInfo;
    }
    setProblemInfo(problemInfo) {
        this.problemInfo = problemInfo;
    }
    getScreenshotQueue() {
        return this.screenshotHelper.getScreenshotQueue();
    }
    getExtraScreenshotQueue() {
        return this.screenshotHelper.getExtraScreenshotQueue();
    }
    // Window management methods
    setupOllamaIpcHandlers() {
        electron_1.ipcMain.handle('get-ollama-models', async () => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s timeout for detection
                const response = await fetch('http://localhost:11434/api/tags', {
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (response.ok) {
                    const data = await response.json();
                    // data.models is an array of objects: { name: "llama3:latest", ... }
                    return data.models.map((m) => m.name);
                }
                return [];
            }
            catch (error) {
                // console.warn("Ollama detection failed:", error);
                return [];
            }
        });
    }
    createWindow() {
        this.windowHelper.createWindow();
    }
    hideMainWindow() {
        this.windowHelper.hideMainWindow();
    }
    showMainWindow() {
        this.windowHelper.showMainWindow();
    }
    toggleMainWindow() {
        console.log("Screenshots: ", this.screenshotHelper.getScreenshotQueue().length, "Extra screenshots: ", this.screenshotHelper.getExtraScreenshotQueue().length);
        // Send toggle-expand to the currently active window mode's window.
        // If we use getMainWindow(), it might return the launcher window when the overlay is hidden,
        // causing the IPC event to go to the wrong React tree and silently fail.
        const mode = this.windowHelper.getCurrentWindowMode();
        const targetWindow = mode === 'overlay' ? this.windowHelper.getOverlayWindow() : this.windowHelper.getLauncherWindow();
        if (targetWindow && !targetWindow.isDestroyed()) {
            targetWindow.webContents.send('toggle-expand');
        }
    }
    setWindowDimensions(width, height) {
        this.windowHelper.setWindowDimensions(width, height);
    }
    clearQueues() {
        this.screenshotHelper.clearQueues();
        // Clear problem info
        this.problemInfo = null;
        // Reset view to initial state
        this.setView("queue");
    }
    // Screenshot management methods
    async takeScreenshot() {
        if (!this.getMainWindow())
            throw new Error("No main window available");
        const wasOverlayVisible = this.windowHelper.getOverlayWindow()?.isVisible() ?? false;
        const screenshotPath = await this.screenshotHelper.takeScreenshot(() => this.hideMainWindow(), () => {
            if (wasOverlayVisible) {
                this.windowHelper.switchToOverlay();
            }
            else {
                this.showMainWindow();
            }
        });
        return screenshotPath;
    }
    async takeSelectiveScreenshot() {
        if (!this.getMainWindow())
            throw new Error("No main window available");
        const wasOverlayVisible = this.windowHelper.getOverlayWindow()?.isVisible() ?? false;
        const screenshotPath = await this.screenshotHelper.takeSelectiveScreenshot(() => this.hideMainWindow(), () => {
            if (wasOverlayVisible) {
                this.windowHelper.switchToOverlay();
            }
            else {
                this.showMainWindow();
            }
        });
        return screenshotPath;
    }
    async getImagePreview(filepath) {
        return this.screenshotHelper.getImagePreview(filepath);
    }
    async deleteScreenshot(path) {
        return this.screenshotHelper.deleteScreenshot(path);
    }
    // New methods to move the window
    moveWindowLeft() {
        this.windowHelper.moveWindowLeft();
    }
    moveWindowRight() {
        this.windowHelper.moveWindowRight();
    }
    moveWindowDown() {
        this.windowHelper.moveWindowDown();
    }
    moveWindowUp() {
        this.windowHelper.moveWindowUp();
    }
    centerAndShowWindow() {
        this.windowHelper.centerAndShowWindow();
    }
    createTray() {
        this.showTray();
    }
    showTray() {
        if (this.tray)
            return;
        // Try to find a template image first for macOS
        const resourcesPath = electron_1.app.isPackaged ? process.resourcesPath : electron_1.app.getAppPath();
        // Potential paths for tray icon
        const templatePath = path_1.default.join(resourcesPath, 'assets', 'iconTemplate.png');
        const defaultIconPath = electron_1.app.isPackaged
            ? path_1.default.join(resourcesPath, 'src/components/icon.png')
            : path_1.default.join(electron_1.app.getAppPath(), 'src/components/icon.png');
        let iconToUse = defaultIconPath;
        // Check if template exists (sync check is fine for startup/rare toggle)
        try {
            if (require('fs').existsSync(templatePath)) {
                iconToUse = templatePath;
                console.log('[Tray] Using template icon:', templatePath);
            }
            else {
                // Also check src/components for dev
                const devTemplatePath = path_1.default.join(electron_1.app.getAppPath(), 'src/components/iconTemplate.png');
                if (require('fs').existsSync(devTemplatePath)) {
                    iconToUse = devTemplatePath;
                    console.log('[Tray] Using dev template icon:', devTemplatePath);
                }
                else {
                    console.log('[Tray] Template icon not found, using default:', defaultIconPath);
                }
            }
        }
        catch (e) {
            console.error('[Tray] Error checking for icon:', e);
        }
        const trayIcon = electron_1.nativeImage.createFromPath(iconToUse).resize({ width: 16, height: 16 });
        // IMPORTANT: specific template settings for macOS if needed, but 'Template' in name usually suffices
        trayIcon.setTemplateImage(iconToUse.endsWith('Template.png'));
        this.tray = new electron_1.Tray(trayIcon);
        this.tray.setToolTip('Natively'); // This tooltip might also need update if we change global shortcut, but global shortcut is removed.
        this.updateTrayMenu();
        // Double-click to show window
        this.tray.on('double-click', () => {
            this.centerAndShowWindow();
        });
    }
    updateTrayMenu() {
        if (!this.tray)
            return;
        const keybindManager = KeybindManager_1.KeybindManager.getInstance();
        const screenshotAccel = keybindManager.getKeybind('general:take-screenshot') || 'CommandOrControl+H';
        console.log('[Main] updateTrayMenu called. Screenshot Accelerator:', screenshotAccel);
        // Update tooltip for verification
        this.tray.setToolTip('Natively');
        // Helper to format accelerator for display (e.g. CommandOrControl+H -> Cmd+H)
        const formatAccel = (accel) => {
            return accel
                .replace('CommandOrControl', 'Cmd')
                .replace('Command', 'Cmd')
                .replace('Control', 'Ctrl')
                .replace('OrControl', '') // Cleanup just in case
                .replace(/\+/g, '+');
        };
        const displayScreenshot = formatAccel(screenshotAccel);
        // We can also get the toggle visibility shortcut if desired
        const toggleKb = keybindManager.getKeybind('general:toggle-visibility');
        const toggleAccel = toggleKb || 'CommandOrControl+B';
        const displayToggle = formatAccel(toggleAccel);
        const contextMenu = electron_1.Menu.buildFromTemplate([
            {
                label: 'Show Natively',
                click: () => {
                    this.centerAndShowWindow();
                }
            },
            {
                label: `Toggle Window (${displayToggle})`,
                click: () => {
                    this.toggleMainWindow();
                }
            },
            {
                type: 'separator'
            },
            {
                label: `Take Screenshot (${displayScreenshot})`,
                accelerator: screenshotAccel,
                click: async () => {
                    try {
                        const screenshotPath = await this.takeScreenshot();
                        const preview = await this.getImagePreview(screenshotPath);
                        const mainWindow = this.getMainWindow();
                        if (mainWindow) {
                            mainWindow.webContents.send("screenshot-taken", {
                                path: screenshotPath,
                                preview
                            });
                        }
                    }
                    catch (error) {
                        console.error("Error taking screenshot from tray:", error);
                    }
                }
            },
            {
                type: 'separator'
            },
            {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: () => {
                    electron_1.app.quit();
                }
            }
        ]);
        this.tray.setContextMenu(contextMenu);
    }
    hideTray() {
        if (this.tray) {
            this.tray.destroy();
            this.tray = null;
        }
    }
    setHasDebugged(value) {
        this.hasDebugged = value;
    }
    getHasDebugged() {
        return this.hasDebugged;
    }
    setUndetectable(state) {
        // Guard: skip if state hasn't actually changed to prevent
        // duplicate dock hide/show cycles from renderer feedback loops
        if (this.isUndetectable === state)
            return;
        console.log(`[Stealth] setUndetectable(${state}) called`);
        this.isUndetectable = state;
        this.windowHelper.setContentProtection(state);
        this.settingsWindowHelper.setContentProtection(state);
        this.modelSelectorWindowHelper.setContentProtection(state);
        // Persist state via SettingsManager
        SettingsManager_1.SettingsManager.getInstance().set('isUndetectable', state);
        // Cancel pending disguise timers from prior dock/disguise transitions so
        // stale blur-reset or app.setName() callbacks cannot fire after a rapid toggle.
        this.clearDisguiseTimers();
        // Broadcast state change to all relevant windows
        this._broadcastToAllWindows('undetectable-changed', state);
        // --- STEALTH MODE LOGIC (restored from working version a820380) ---
        if (process.platform === 'darwin') {
            const activeWindow = this.windowHelper.getMainWindow();
            // Determine the truly active window to restore focus to
            const settingsWindow = this.settingsWindowHelper.getSettingsWindow();
            let targetFocusWindow = activeWindow;
            if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible()) {
                targetFocusWindow = settingsWindow;
            }
            // Temporarily ignore blur to prevent popups from closing during dock hide/show
            const modelSelectorWindow = this.modelSelectorWindowHelper.getWindow();
            const isModelSelectorVisible = modelSelectorWindow && !modelSelectorWindow.isDestroyed() && modelSelectorWindow.isVisible();
            if (targetFocusWindow && (targetFocusWindow === settingsWindow)) {
                this.settingsWindowHelper.setIgnoreBlur(true);
            }
            if (isModelSelectorVisible) {
                this.modelSelectorWindowHelper.setIgnoreBlur(true);
            }
            if (state) {
                console.log('[Stealth] Calling app.dock.hide()');
                this.settingsWindowHelper.closeWindow();
                this.modelSelectorWindowHelper.hideWindow();
                electron_1.app.dock.hide();
                this.hideTray();
                // Focus the window directly without calling .show() 
                // (.show() can cause macOS to re-register the dock icon)
                if (targetFocusWindow && !targetFocusWindow.isDestroyed()) {
                    targetFocusWindow.focus();
                }
            }
            else {
                console.log('[Stealth] Calling app.dock.show()');
                electron_1.app.dock.show();
                this.showTray();
                // Restore focus when coming back to foreground/dock mode
                if (targetFocusWindow && !targetFocusWindow.isDestroyed() && targetFocusWindow.isVisible()) {
                    targetFocusWindow.focus();
                }
            }
            // Re-enable blur handling after the transition logic has settled
            if (targetFocusWindow && (targetFocusWindow === settingsWindow)) {
                this.scheduleDisguiseTimer(() => {
                    this.settingsWindowHelper.setIgnoreBlur(false);
                }, 500);
            }
            if (isModelSelectorVisible) {
                this.scheduleDisguiseTimer(() => {
                    this.modelSelectorWindowHelper.setIgnoreBlur(false);
                }, 500);
            }
        }
    }
    getUndetectable() {
        return this.isUndetectable;
    }
    setConsciousModeEnabled(enabled) {
        if (this.consciousModeEnabled === enabled) {
            return true;
        }
        const persisted = SettingsManager_1.SettingsManager.getInstance().set('consciousModeEnabled', enabled);
        if (!persisted) {
            throw new Error('Unable to persist Conscious Mode');
        }
        this.consciousModeEnabled = enabled;
        this.intelligenceManager.setConsciousModeEnabled(enabled);
        this._broadcastToAllWindows('conscious-mode-changed', enabled);
        return true;
    }
    getConsciousModeEnabled() {
        return this.consciousModeEnabled;
    }
    setAccelerationModeEnabled(enabled) {
        const settings = SettingsManager_1.SettingsManager.getInstance();
        const previousEnabled = settings.getAccelerationModeEnabled();
        if (previousEnabled === enabled) {
            return true;
        }
        const persisted = settings.set('accelerationModeEnabled', enabled);
        if (!persisted) {
            throw new Error('Unable to persist Acceleration Mode');
        }
        (0, optimizations_1.syncOptimizationFlagsFromSettings)(settings.getAccelerationModeEnabled());
        this._broadcastToAllWindows('acceleration-mode-changed', enabled);
        return true;
    }
    getAccelerationModeEnabled() {
        return SettingsManager_1.SettingsManager.getInstance().getAccelerationModeEnabled();
    }
    setDisguise(mode) {
        this.disguiseMode = mode;
        SettingsManager_1.SettingsManager.getInstance().set('disguiseMode', mode);
        // Apply the disguise regardless of undetectable state
        // (disguise affects Activity Monitor name via process.title,
        //  dock icon only updates when NOT in stealth)
        this._applyDisguise(mode);
    }
    applyInitialDisguise() {
        this._applyDisguise(this.disguiseMode);
    }
    _applyDisguise(mode) {
        let appName = "Natively";
        let iconPath = "";
        const isWin = process.platform === 'win32';
        const isMac = process.platform === 'darwin';
        switch (mode) {
            case 'terminal':
                appName = isWin ? "Command Prompt " : "Terminal ";
                if (isWin) {
                    iconPath = electron_1.app.isPackaged
                        ? path_1.default.join(process.resourcesPath, "assets/fakeicon/win/terminal.png")
                        : path_1.default.join(electron_1.app.getAppPath(), "assets/fakeicon/win/terminal.png");
                }
                else {
                    iconPath = electron_1.app.isPackaged
                        ? path_1.default.join(process.resourcesPath, "assets/fakeicon/mac/terminal.png")
                        : path_1.default.join(electron_1.app.getAppPath(), "assets/fakeicon/mac/terminal.png");
                }
                break;
            case 'settings':
                appName = isWin ? "Settings " : "System Settings ";
                if (isWin) {
                    iconPath = electron_1.app.isPackaged
                        ? path_1.default.join(process.resourcesPath, "assets/fakeicon/win/settings.png")
                        : path_1.default.join(electron_1.app.getAppPath(), "assets/fakeicon/win/settings.png");
                }
                else {
                    iconPath = electron_1.app.isPackaged
                        ? path_1.default.join(process.resourcesPath, "assets/fakeicon/mac/settings.png")
                        : path_1.default.join(electron_1.app.getAppPath(), "assets/fakeicon/mac/settings.png");
                }
                break;
            case 'activity':
                appName = isWin ? "Task Manager " : "Activity Monitor ";
                if (isWin) {
                    iconPath = electron_1.app.isPackaged
                        ? path_1.default.join(process.resourcesPath, "assets/fakeicon/win/activity.png")
                        : path_1.default.join(electron_1.app.getAppPath(), "assets/fakeicon/win/activity.png");
                }
                else {
                    iconPath = electron_1.app.isPackaged
                        ? path_1.default.join(process.resourcesPath, "assets/fakeicon/mac/activity.png")
                        : path_1.default.join(electron_1.app.getAppPath(), "assets/fakeicon/mac/activity.png");
                }
                break;
            case 'none':
                appName = "Natively";
                if (isMac) {
                    iconPath = electron_1.app.isPackaged
                        ? path_1.default.join(process.resourcesPath, "natively.icns")
                        : path_1.default.join(electron_1.app.getAppPath(), "assets/natively.icns");
                }
                else if (isWin) {
                    iconPath = electron_1.app.isPackaged
                        ? path_1.default.join(process.resourcesPath, "assets/icons/win/icon.ico")
                        : path_1.default.join(electron_1.app.getAppPath(), "assets/icons/win/icon.ico");
                }
                else {
                    iconPath = electron_1.app.isPackaged
                        ? path_1.default.join(process.resourcesPath, "icon.png")
                        : path_1.default.join(electron_1.app.getAppPath(), "assets/icon.png");
                }
                break;
        }
        console.log(`[AppState] Applying disguise: ${mode} (${appName}) on ${process.platform}`);
        // 1. Update process title (affects Activity Monitor / Task Manager)
        process.title = appName;
        // 2. Update app name (affects macOS Menu / Dock)
        // Skip when undetectable — app.setName() causes macOS to re-register
        // the app and re-show the dock icon even after dock.hide()
        if (!this.isUndetectable) {
            electron_1.app.setName(appName);
        }
        if (isMac) {
            process.env.CFBundleName = appName.trim();
        }
        // 3. Update App User Model ID (Windows Taskbar grouping)
        if (isWin) {
            // Use unique AUMID per disguise to avoid grouping with the real app
            electron_1.app.setAppUserModelId(`com.natively.assistant.${mode}`);
        }
        // 4. Update Icons
        if (fs_1.default.existsSync(iconPath)) {
            const image = electron_1.nativeImage.createFromPath(iconPath);
            if (isMac) {
                // Skip dock icon update when dock is hidden to avoid potential flicker
                if (!this.isUndetectable) {
                    electron_1.app.dock.setIcon(image);
                }
            }
            else {
                // Windows/Linux: Update all window icons
                this.windowHelper.getLauncherWindow()?.setIcon(image);
                this.windowHelper.getOverlayWindow()?.setIcon(image);
                this.settingsWindowHelper.getSettingsWindow()?.setIcon(image);
            }
        }
        else {
            console.warn(`[AppState] Disguise icon not found: ${iconPath}`);
        }
        // 5. Update Window Titles
        const launcher = this.windowHelper.getLauncherWindow();
        if (launcher && !launcher.isDestroyed()) {
            launcher.setTitle(appName.trim());
            launcher.webContents.send('disguise-changed', mode);
        }
        const overlay = this.windowHelper.getOverlayWindow();
        if (overlay && !overlay.isDestroyed()) {
            overlay.setTitle(appName.trim());
            overlay.webContents.send('disguise-changed', mode);
        }
        const settingsWin = this.settingsWindowHelper.getSettingsWindow();
        if (settingsWin && !settingsWin.isDestroyed()) {
            settingsWin.setTitle(appName.trim());
            settingsWin.webContents.send('disguise-changed', mode);
        }
        // Cancel any stale forceUpdate timeouts from previous disguise changes
        this.clearDisguiseTimers();
        // Force periodic updates to ensure process title sticks
        const forceUpdate = () => {
            process.title = appName;
            // Only call app.setName when NOT in stealth — it causes dock to re-show
            if (isMac && !this.isUndetectable) {
                electron_1.app.setName(appName);
            }
        };
        const scheduleUpdate = (ms) => {
            this.scheduleDisguiseTimer(() => {
                forceUpdate();
            }, ms);
        };
        scheduleUpdate(200);
        scheduleUpdate(1000);
        scheduleUpdate(5000);
    }
    // Helper: broadcast an IPC event to all windows
    _broadcastToAllWindows(channel, ...args) {
        const windows = [
            this.windowHelper.getMainWindow(),
            this.windowHelper.getLauncherWindow(),
            this.windowHelper.getOverlayWindow(),
            this.settingsWindowHelper.getSettingsWindow(),
            this.modelSelectorWindowHelper.getWindow(),
        ];
        const sent = new Set();
        for (const win of windows) {
            if (win && !win.isDestroyed() && !sent.has(win.id)) {
                sent.add(win.id);
                win.webContents.send(channel, ...args);
            }
        }
    }
    getDisguise() {
        return this.disguiseMode;
    }
}
exports.AppState = AppState;
// Application initialization
async function initializeApp() {
    // 2. Wait for app to be ready
    await electron_1.app.whenReady();
    // 3. Set Content Security Policy headers for XSS protection
    electron_1.session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': "default-src 'self'; " +
                    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
                    "style-src 'self' 'unsafe-inline'; " +
                    "img-src 'self' data: blob: https:; " +
                    "font-src 'self' data:; " +
                    "connect-src 'self' https: wss: ws:; " +
                    "media-src 'self' blob:; " +
                    "object-src 'none'; " +
                    "frame-src 'self'; " +
                    "base-uri 'self';"
            }
        });
    });
    // 4. Initialize Managers
    // Initialize CredentialsManager and load keys explicitly
    // This fixes the issue where keys (especially in production) aren't loaded in time for RAG/LLM
    const { CredentialsManager } = require('./services/CredentialsManager');
    CredentialsManager.getInstance().init();
    // 4. Initialize State
    const appState = AppState.getInstance();
    // Explicitly load credentials into helpers
    appState.processingHelper.loadStoredCredentials();
    // Initialize IPC handlers before window creation
    (0, ipcHandlers_1.initializeIpcHandlers)(appState);
    // Apply the full disguise payload (names, dock icon, AUMID) early
    appState.applyInitialDisguise();
    electron_1.app.whenReady().then(() => {
        // Start the Ollama lifecycle manager
        OllamaManager_1.OllamaManager.getInstance().init().catch(console.error);
        // NOTE: CredentialsManager.init() and loadStoredCredentials() are already called
        // above before this block — do NOT call them again here to avoid double key-load.
        // Anonymous install ping - one-time, non-blocking
        // See electron/services/InstallPingManager.ts for privacy details
        const { sendAnonymousInstallPing } = require('./services/InstallPingManager');
        sendAnonymousInstallPing();
        // Load stored Google Service Account path (for Speech-to-Text)
        const storedServiceAccountPath = CredentialsManager.getInstance().getGoogleServiceAccountPath();
        if (storedServiceAccountPath) {
            console.log("[Init] Loading stored Google Service Account path");
            appState.updateGoogleCredentials(storedServiceAccountPath);
        }
        console.log("App is ready");
        appState.createWindow();
        // Apply initial stealth state based on isUndetectable setting
        if (appState.getUndetectable()) {
            // Stealth mode: hide dock and tray
            if (process.platform === 'darwin') {
                electron_1.app.dock.hide();
            }
        }
        else {
            // Normal mode: show dock and tray
            appState.showTray();
            if (process.platform === 'darwin') {
                electron_1.app.dock.show();
            }
        }
        // Register global shortcuts using KeybindManager
        KeybindManager_1.KeybindManager.getInstance().registerGlobalShortcuts();
        // Pre-create settings window in background for faster first open
        appState.settingsWindowHelper.preloadWindow();
        // Initialize CalendarManager
        try {
            const { CalendarManager } = require('./services/CalendarManager');
            const calMgr = CalendarManager.getInstance();
            calMgr.init();
            calMgr.on('start-meeting-requested', (event) => {
                console.log('[Main] Start meeting requested from calendar notification', event);
                appState.centerAndShowWindow();
                appState.startMeeting({
                    title: event.title,
                    calendarEventId: event.id,
                    source: 'calendar'
                });
            });
            calMgr.on('open-requested', () => {
                appState.centerAndShowWindow();
            });
            console.log('[Main] CalendarManager initialized');
        }
        catch (e) {
            console.error('[Main] Failed to initialize CalendarManager:', e);
        }
        // Recover unprocessed meetings (persistence check)
        appState.getIntelligenceManager().recoverUnprocessedMeetings().catch(err => {
            console.error('[Main] Failed to recover unprocessed meetings:', err);
        });
        // Note: We do NOT force dock show here anymore, respecting stealth mode.
    });
    electron_1.app.on("activate", () => {
        console.log("App activated");
        if (process.platform === 'darwin') {
            if (!appState.getUndetectable()) {
                electron_1.app.dock.show();
            }
        }
        // If no window exists, create it
        if (appState.getMainWindow() === null) {
            appState.createWindow();
        }
        else {
            // If the window exists but is hidden, clicking the dock icon should restore it
            if (!appState.isVisible()) {
                appState.toggleMainWindow();
            }
        }
    });
    // Quit when all windows are closed, except on macOS
    electron_1.app.on("window-all-closed", () => {
        if (process.platform !== "darwin") {
            electron_1.app.quit();
        }
    });
    // Scrub API keys from memory on quit to minimize exposure window
    electron_1.app.on("before-quit", () => {
        console.log("App is quitting, cleaning up resources...");
        appState.cleanupForQuit();
        electron_1.globalShortcut.unregisterAll();
        // Kill Ollama if we started it
        OllamaManager_1.OllamaManager.getInstance().stop();
        try {
            const { CredentialsManager } = require('./services/CredentialsManager');
            CredentialsManager.getInstance().scrubMemory();
            appState.processingHelper.getLLMHelper().scrubKeys();
            console.log('[Main] Credentials scrubbed from memory on quit');
        }
        catch (e) {
            console.error('[Main] Failed to scrub credentials on quit:', e);
        }
    });
    // app.dock?.hide() // REMOVED: User wants Dock icon visible
    electron_1.app.commandLine.appendSwitch("disable-background-timer-throttling");
}
// Start the application
initializeApp().catch(console.error);
//# sourceMappingURL=main.js.map