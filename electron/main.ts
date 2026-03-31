import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, systemPreferences, globalShortcut, session } from "electron"
import { EventEmitter } from "events"
import { randomUUID } from "node:crypto"
import path from "path"
import fs from "fs"
import fsPromises from "fs/promises"
import { syncOptimizationFlagsFromSettings } from "./config/optimizations"
import { StealthManager } from "./stealth/StealthManager"
import { createMacosVirtualDisplayCoordinator, resolveMacosVirtualDisplayHelperPath } from "./stealth/macosVirtualDisplayIntegration"
if (!app.isPackaged) {
require('dotenv').config();
}

// Handle stdout/stderr errors at the process level to prevent EIO crashes
// This is critical for Electron apps that may have their terminal detached
process.stdout?.on?.('error', () => { });
process.stderr?.on?.('error', () => { });

process.on('uncaughtException', (err) => {
  void logToFileAsync('[CRITICAL] Uncaught Exception: ' + (err.stack || err.message || err));
});

process.on('unhandledRejection', (reason, promise) => {
  void logToFileAsync('[CRITICAL] Unhandled Rejection at: ' + promise + ' reason: ' + (reason instanceof Error ? reason.stack : reason));
});

const logFile = path.join(app.getPath('documents'), 'natively_debug.log');
const LOG_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const LOG_ROTATION_COUNT = 3; // Keep 3 rotated files

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

const isDev = process.env.NODE_ENV === "development";

// Log queue for non-blocking async writes
const LOG_QUEUE_MAX_SIZE = 10000;
let logQueue: string[] = [];
let logFlushInProgress = false;
let logRotationCheckPending = false;

/**
 * Rotate log files asynchronously if they exceed the maximum size.
 * Keeps LOG_ROTATION_COUNT rotated files (e.g., .log.1, .log.2, .log.3)
 */
async function rotateLogsIfNeededAsync(): Promise<void> {
  if (logRotationCheckPending) return;
  logRotationCheckPending = true;

  try {
    // Check if log file exists and exceeds max size
    try {
      const stats = await fsPromises.stat(logFile);
      if (stats.size < LOG_MAX_SIZE_BYTES) return;

      // Rotate existing files: .log.3 -> delete, .log.2 -> .log.3, .log.1 -> .log.2, .log -> .log.1
      for (let i = LOG_ROTATION_COUNT; i >= 1; i--) {
        const rotatedPath = `${logFile}.${i}`;
        try {
          await fsPromises.access(rotatedPath);
          if (i === LOG_ROTATION_COUNT) {
            await fsPromises.unlink(rotatedPath);
          } else {
            await fsPromises.rename(rotatedPath, `${logFile}.${i + 1}`);
          }
        } catch {
          // File doesn't exist, skip
        }
      }

      // Rename current log to .log.1
      await fsPromises.rename(logFile, `${logFile}.1`);
      originalLog(`[LogRotation] Rotated debug log (size was ${Math.round(stats.size / 1024 / 1024)}MB)`);
    } catch {
      // Log file doesn't exist yet, nothing to rotate
    }
  } catch (e) {
    originalError('[LogRotation] Failed to rotate logs:', e);
  } finally {
    logRotationCheckPending = false;
  }
}

/**
 * Flush the log queue to disk asynchronously
 */
async function flushLogQueue(): Promise<void> {
  if (logFlushInProgress || logQueue.length === 0) return;
  logFlushInProgress = true;

  const pending = logQueue.splice(0, logQueue.length);
  if (pending.length === 0) {
    logFlushInProgress = false;
    return;
  }

  try {
    await rotateLogsIfNeededAsync();
    const content = pending.map(msg => `${new Date().toISOString()} ${msg}`).join('\n') + '\n';
    await fsPromises.appendFile(logFile, content);
  } catch {
    // Ignore logging errors
  } finally {
    logFlushInProgress = false;
    if (logQueue.length > 0) {
      void flushLogQueue();
    }
  }
}

/**
 * Non-blocking async log to file
 */
async function logToFileAsync(msg: string): Promise<void> {
  if (logQueue.length >= LOG_QUEUE_MAX_SIZE) {
    logQueue.splice(0, logQueue.length - LOG_QUEUE_MAX_SIZE + 1);
  }
  logQueue.push(msg);
  void flushLogQueue();
}

// Synchronous version for backwards compatibility with console overrides
function logToFile(msg: string): void {
  void logToFileAsync(msg);
}

function isEnvFlagEnabled(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
}

console.log = (...args: any[]) => {
  const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logToFile('[LOG] ' + msg);
  try {
    originalLog.apply(console, args);
  } catch { }
};

console.warn = (...args: any[]) => {
  const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logToFile('[WARN] ' + msg);
  try {
    originalWarn.apply(console, args);
  } catch { }
};

console.error = (...args: any[]) => {
  const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logToFile('[ERROR] ' + msg);
  try {
    originalError.apply(console, args);
  } catch { }
};

import { initializeIpcHandlers } from "./ipcHandlers"
import { WindowHelper } from "./WindowHelper"
import { SettingsWindowHelper } from "./SettingsWindowHelper"
import { ModelSelectorWindowHelper } from "./ModelSelectorWindowHelper"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { KeybindManager } from "./services/KeybindManager"
import { ProcessingHelper } from "./ProcessingHelper"

import { IntelligenceManager } from "./IntelligenceManager"
import { SystemAudioCapture } from "./audio/SystemAudioCapture"
import { MicrophoneCapture } from "./audio/MicrophoneCapture"
import { AudioDevices, type AudioDevice } from "./audio/AudioDevices"
import { GoogleSTT } from "./audio/GoogleSTT"
import { RestSTT } from "./audio/RestSTT"
import { DeepgramStreamingSTT } from "./audio/DeepgramStreamingSTT"
import { SonioxStreamingSTT } from "./audio/SonioxStreamingSTT"
import { ElevenLabsStreamingSTT } from "./audio/ElevenLabsStreamingSTT"
import { OpenAIStreamingSTT } from "./audio/OpenAIStreamingSTT"
import { getNativeAudioLoadError } from "./audio/nativeModule"
import { ThemeManager } from "./ThemeManager"
import { RAGManager } from "./rag/RAGManager"
import { DatabaseManager } from "./db/DatabaseManager"
import { warmupIntentClassifier } from "./llm"
import { maybeHandleSuggestionTriggerFromTranscript } from "./ConsciousMode"
import { MeetingCheckpointer } from "./MeetingCheckpointer"
import { STTReconnector } from "./STTReconnector"

/** Unified type for all STT providers with optional extended capabilities */
type STTProvider = (GoogleSTT | RestSTT | DeepgramStreamingSTT | SonioxStreamingSTT | ElevenLabsStreamingSTT | OpenAIStreamingSTT) & {
  start: () => void;
  stop: () => void;
  on: EventEmitter['on'];
  removeAllListeners: EventEmitter['removeAllListeners'];
  finalize?: () => void;
  setAudioChannelCount?: (count: number) => void;
  notifySpeechEnded?: () => void;
  destroy?: () => void;
};

/** Type guard functions for STT provider optional methods */
function hasFinalize(stt: STTProvider): stt is STTProvider & { finalize: () => void } {
  return 'finalize' in stt && typeof stt.finalize === 'function';
}

function hasSetAudioChannelCount(stt: STTProvider): stt is STTProvider & { setAudioChannelCount: (count: number) => void } {
  return 'setAudioChannelCount' in stt && typeof stt.setAudioChannelCount === 'function';
}

function hasNotifySpeechEnded(stt: STTProvider): stt is STTProvider & { notifySpeechEnded: () => void } {
  return 'notifySpeechEnded' in stt && typeof stt.notifySpeechEnded === 'function';
}

function hasDestroy(stt: STTProvider): stt is STTProvider & { destroy: () => void } {
  return 'destroy' in stt && typeof stt.destroy === 'function';
}

/** Safe wrapper functions for STT provider optional methods */
function safeFinalize(stt: STTProvider | null): void {
  if (stt && hasFinalize(stt)) {
    try {
      stt.finalize();
    } catch (error) {
      console.error('[Main] Error calling finalize on STT provider:', error);
    }
  }
}

function safeSetAudioChannelCount(stt: STTProvider | null, count: number): void {
  if (stt && hasSetAudioChannelCount(stt)) {
    try {
      stt.setAudioChannelCount(count);
    } catch (error) {
      console.error('[Main] Error calling setAudioChannelCount on STT provider:', error);
    }
  }
}

function safeNotifySpeechEnded(stt: STTProvider | null): void {
  if (stt && hasNotifySpeechEnded(stt)) {
    try {
      stt.notifySpeechEnded();
    } catch (error) {
      console.error('[Main] Error calling notifySpeechEnded on STT provider:', error);
    }
  }
}

function safeDestroy(stt: STTProvider | null): void {
  if (stt && hasDestroy(stt)) {
    try {
      stt.destroy();
    } catch (error) {
      console.error('[Main] Error calling destroy on STT provider:', error);
    }
  }
}

// Premium: Knowledge modules loaded conditionally
let KnowledgeOrchestratorClass: any = null;
let KnowledgeDatabaseManagerClass: any = null;
try {
    KnowledgeOrchestratorClass = require('../premium/electron/knowledge/KnowledgeOrchestrator').KnowledgeOrchestrator;
    KnowledgeDatabaseManagerClass = require('../premium/electron/knowledge/KnowledgeDatabaseManager').KnowledgeDatabaseManager;
} catch {
    console.log('[Main] Knowledge modules not available — profile intelligence disabled.');
}

import { CredentialsManager } from "./services/CredentialsManager"
import { SettingsManager } from "./services/SettingsManager"
import { OllamaManager } from './services/OllamaManager'

export class AppState {
  private static instance: AppState | null = null

  private windowHelper: WindowHelper
  public settingsWindowHelper: SettingsWindowHelper
  public modelSelectorWindowHelper: ModelSelectorWindowHelper
  private stealthManager: StealthManager
  private screenshotHelper: ScreenshotHelper
  public processingHelper: ProcessingHelper

  private intelligenceManager: IntelligenceManager
  private themeManager: ThemeManager
  private ragManager: RAGManager | null = null
  private knowledgeOrchestrator: any = null
  private checkpointer: MeetingCheckpointer | null = null
  private sttReconnector: STTReconnector | null = null
  private virtualDisplayCoordinator: import('./stealth/MacosVirtualDisplayClient').VirtualDisplayCoordinator | null = null
  private tray: Tray | null = null
  private disguiseMode: 'terminal' | 'settings' | 'activity' | 'none' = 'none'
  private consciousModeEnabled: boolean = false

  // View management
  private view: "queue" | "solutions" = "queue"
  private isUndetectable: boolean = false

  private problemInfo: {
    problem_statement: string
    input_format: Record<string, any>
    output_format: Record<string, any>
    constraints: Array<Record<string, any>>
    test_cases: Array<Record<string, any>>
  } | null = null // Allow null

  private hasDebugged: boolean = false
  private isMeetingActive: boolean = false; // Guard for session state leaks
  private meetingLifecycleState: 'idle' | 'starting' | 'active' | 'stopping' = 'idle'
  private meetingStartSequence = 0
  private meetingStartMutex: Promise<void> = Promise.resolve() // Prevents race conditions
  private nativeAudioConnected: boolean = false;
  private _disguiseTimers: NodeJS.Timeout[] = []; // Track forceUpdate timeouts

  private clearDisguiseTimers(): void {
    for (const timer of this._disguiseTimers) {
      clearTimeout(timer)
    }
    this._disguiseTimers = []
  }

  private trackDisguiseTimer(timer: NodeJS.Timeout): void {
    this._disguiseTimers.push(timer)
  }

  private scheduleDisguiseTimer(callback: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      try {
        callback()
      } finally {
        this._disguiseTimers = this._disguiseTimers.filter(t => t !== timer)
      }
    }, delayMs)
    this.trackDisguiseTimer(timer)
  }
  private _ollamaBootstrapPromise: Promise<void> | null = null;
  private audioRecoveryAttempts: number = 0;
  private readonly MAX_AUDIO_RECOVERY_ATTEMPTS = 3;
  private audioRecoveryBackoffMs: number = 5000;
  private currentMeetingId: string | null = null;
  private startAbortController: AbortController | null = null;


  // Processing events
  public readonly PROCESSING_EVENTS = {
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

constructor() {
// 1. Load boot-critical settings first (used by WindowHelpers)
const settingsManager = SettingsManager.getInstance();
this.isUndetectable = settingsManager.get('isUndetectable') ?? false;
this.disguiseMode = settingsManager.get('disguiseMode') ?? 'none';
this.consciousModeEnabled = settingsManager.get('consciousModeEnabled') ?? false;

// 1a. Sync acceleration optimization flags from settings
const accelerationModeEnabled = settingsManager.getAccelerationModeEnabled();
syncOptimizationFlagsFromSettings(accelerationModeEnabled);

console.log(`[AppState] Initialized with isUndetectable=${this.isUndetectable}, disguiseMode=${this.disguiseMode}, consciousModeEnabled=${this.consciousModeEnabled}, accelerationModeEnabled=${accelerationModeEnabled}`);

// 2. Initialize Helpers with loaded state
// Feature flags default to ON with safe fallback to Layer 0 if broken
const enablePrivateMacosStealthApi =
  !(process as NodeJS.Process & { mas?: boolean }).mas && (
    isEnvFlagEnabled(process.env.NATIVELY_ENABLE_PRIVATE_MACOS_STEALTH_API) ??
    (settingsManager.get('enablePrivateMacosStealthApi') ?? true)
  )
const enableCaptureDetectionWatchdog =
  isEnvFlagEnabled(process.env.NATIVELY_ENABLE_CAPTURE_DETECTION_WATCHDOG) ??
  // Off by default. The heuristic matches common apps like Chrome/Slack and
  // visibly hides/restores the main window in normal desktop sessions.
  (settingsManager.get('enableCaptureDetectionWatchdog') ?? false)
const configuredCaptureToolPatterns = (settingsManager.get('captureToolPatterns') ?? [])
  .map((pattern) => {
    try {
      return new RegExp(pattern, 'i')
    } catch (error) {
      console.warn(`[Stealth] Ignoring invalid capture tool pattern: ${pattern}`, error)
      return null
    }
  })
  .filter((pattern): pattern is RegExp => pattern !== null)
const enableVirtualDisplayIsolation =
  process.platform === 'darwin' &&
  !(process as NodeJS.Process & { mas?: boolean }).mas &&
  (
    isEnvFlagEnabled(process.env.NATIVELY_ENABLE_VIRTUAL_DISPLAY_ISOLATION) ??
    (settingsManager.get('enableVirtualDisplayIsolation') ?? true)
  )

this.virtualDisplayCoordinator =
  process.platform === 'darwin' && enableVirtualDisplayIsolation
    ? (() => {
        const helperPath = resolveMacosVirtualDisplayHelperPath()
        if (!helperPath) {
          console.warn('[Stealth] macOS virtual display helper was requested but no helper binary was found')
          return null
        }

        console.log(`[Stealth] macOS virtual display helper: ${helperPath}`)
        return createMacosVirtualDisplayCoordinator(helperPath)
      })()
    : null

if (process.platform === 'darwin') {
  const macosStealthLevel = enableVirtualDisplayIsolation
    ? 'virtual-display'
    : enablePrivateMacosStealthApi
      ? 'native-plus-cgs'
      : this.isUndetectable
        ? 'native-baseline'
        : 'fallback-only'
  console.log(`[Stealth] macOS level=${macosStealthLevel}, helper=${this.virtualDisplayCoordinator ? 'connected' : 'none'}`)
}

this.stealthManager = new StealthManager({ enabled: this.isUndetectable }, {
  featureFlags: {
    enablePrivateMacosStealthApi,
    enableCaptureDetectionWatchdog,
    enableVirtualDisplayIsolation,
    enableSCStreamDetection: true,
  },
  captureToolPatterns: configuredCaptureToolPatterns.length > 0 ? configuredCaptureToolPatterns : undefined,
  virtualDisplayCoordinator: this.virtualDisplayCoordinator ?? undefined,
})
this.windowHelper = new WindowHelper(this, this.stealthManager)
this.settingsWindowHelper = new SettingsWindowHelper(this.stealthManager)
this.modelSelectorWindowHelper = new ModelSelectorWindowHelper(this.stealthManager)

this.stealthManager.on('stealth-degraded', (warnings: string[]) => {
  console.warn(`[Main] Stealth degraded: ${warnings.join(', ')}`);
  this._broadcastToAllWindows('stealth-degraded', warnings);
});
// 3. Initialize other helpers
this.screenshotHelper = new ScreenshotHelper(this.view)
this.processingHelper = new ProcessingHelper(this)

this.sttReconnector = new STTReconnector(async (speaker) => {
  if (!this.isMeetingActive) return;
  await this.reconnectSpeakerStt(speaker);
});
this.sttReconnector.on('reconnecting', (payload: { speaker: 'interviewer' | 'user'; attempt: number; delayMs: number }) => {
  this.broadcast('reconnecting', payload);
});
this.sttReconnector.on('reconnected', (payload: { speaker: 'interviewer' | 'user'; attempt: number }) => {
  this.broadcast('reconnected', payload);
});
this.sttReconnector.on('exhausted', ({ speaker }: { speaker: 'interviewer' | 'user' }) => {
  this.broadcast('meeting-audio-error', `Transcription connection failed permanently for ${speaker}`);
});

this.windowHelper.setContentProtection(this.isUndetectable);
this.settingsWindowHelper.setContentProtection(this.isUndetectable);
this.modelSelectorWindowHelper.setContentProtection(this.isUndetectable);

    // Initialize KeybindManager
    const keybindManager = KeybindManager.getInstance();
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
        } else if (actionId === 'general:toggle-clickthrough') {
          const enabled = this.windowHelper.toggleOverlayClickthrough();
          const mainWindow = this.getMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send('overlay-clickthrough-changed', enabled);
          }
        } else if (actionId === 'general:take-screenshot') {
          const screenshotPath = await this.takeScreenshot();
          const preview = await this.getImagePreview(screenshotPath);
          const mainWindow = this.getMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send("screenshot-taken", {
              path: screenshotPath,
              preview
            });
          }
        } else if (actionId === 'general:selective-screenshot') {
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
        } else if (actionId === 'chat:scrollUp' || actionId === 'chat:scrollDown') {
          const mainWindow = this.getMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send('global-shortcut-action', actionId);
          }
        }
      } catch (e: any) {
        if (e.message !== "Selection cancelled") {
          console.error(`[Main] Error handling global shortcut ${actionId}:`, e);
        }
      }
    });

// Inject WindowHelper into other helpers
this.settingsWindowHelper.setWindowHelper(this.windowHelper);
this.modelSelectorWindowHelper.setWindowHelper(this.windowHelper);


// Initialize IntelligenceManager with LLMHelper
this.intelligenceManager = new IntelligenceManager(this.processingHelper.getLLMHelper())
this.intelligenceManager.setConsciousModeEnabled(this.consciousModeEnabled)

// Initialize Checkpointer
this.checkpointer = new MeetingCheckpointer(
  DatabaseManager.getInstance(),
  () => this.intelligenceManager.getSessionTracker()
);

// Initialize ThemeManager
this.themeManager = ThemeManager.getInstance()

// Initialize RAGManager (requires database to be ready)
this.initializeRAGManager()

// Initialize KnowledgeOrchestrator (requires RAGManager for embeddings)
this.initializeKnowledgeOrchestrator()

// Check and prep Ollama embedding model
this.bootstrapOllamaEmbeddings().catch(err => console.error('[AppState] Ollama bootstrap failed:', err))

// Initialize AccelerationManager (Apple Silicon enhancement)
this.initializeAccelerationManager().catch(err => console.warn('[AppState] AccelerationManager init failed:', err))

this.setupIntelligenceEvents()

    // Pre-warm the zero-shot intent classifier in background
    warmupIntentClassifier();

    // Setup Ollama IPC
    this.setupOllamaIpcHandlers()

    // --- NEW SYSTEM AUDIO PIPELINE (SOX + NODE GOOGLE STT) ---
    // LAZY INIT: Do not setup pipeline here to prevent launch volume surge.
    // this.setupSystemAudioPipeline()
  }

  private broadcast(channel: string, ...args: any[]): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    });
  }

  private setNativeAudioConnected(connected: boolean): void {
    if (this.nativeAudioConnected === connected) {
      return;
    }

    this.nativeAudioConnected = connected;
    this.broadcast(connected ? 'native-audio-connected' : 'native-audio-disconnected');
  }

  public getNativeAudioStatus(): { connected: boolean } {
    return { connected: this.nativeAudioConnected };
  }

  private async ensureMeetingAudioAccess(): Promise<void> {
    const nativeLoadError = getNativeAudioLoadError();
    if (nativeLoadError) {
      throw new Error(nativeLoadError.message);
    }

    if (process.platform !== 'darwin') {
      return;
    }

    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus !== 'granted') {
      const granted = micStatus === 'not-determined'
        ? await systemPreferences.askForMediaAccess('microphone')
        : false;

      if (!granted) {
        throw new Error('Microphone access is blocked. Enable Natively in System Settings > Privacy & Security > Microphone.');
      }
    }

    const screenStatus = systemPreferences.getMediaAccessStatus('screen');
    if (screenStatus !== 'granted') {
      throw new Error('Screen Recording access is blocked. Enable Natively in System Settings > Privacy & Security > Screen Recording to capture system audio.');
    }
  }

  private async validateMeetingAudioSetup(metadata?: any): Promise<void> {
    await this.ensureMeetingAudioAccess();

    const inputDeviceId = metadata?.audio?.inputDeviceId;
    const outputDeviceId = metadata?.audio?.outputDeviceId;

    const inputDevices = AudioDevices.getInputDevices();
    if (inputDevices.length === 0) {
      throw new Error('No microphone devices were detected. Rebuild native audio with `npm run build:native:current` and confirm microphone permission is granted.');
    }

    if (inputDeviceId && inputDeviceId !== 'default' && !inputDevices.some((device: AudioDevice) => device.id === inputDeviceId)) {
      throw new Error(`Selected microphone is unavailable: ${inputDeviceId}`);
    }

    const outputDevices = AudioDevices.getOutputDevices();
    if (!outputDeviceId || outputDeviceId === 'default' || outputDeviceId === 'sck') {
      return;
    }

    if (outputDevices.length === 0) {
      throw new Error('No system audio output devices were detected. Rebuild native audio with `npm run build:native:current` and confirm Screen Recording permission is granted.');
    }

    if (!outputDevices.some((device: AudioDevice) => device.id === outputDeviceId)) {
      throw new Error(`Selected speaker output is unavailable: ${outputDeviceId}`);
    }
  }

  private async bootstrapOllamaEmbeddings() {
    this._ollamaBootstrapPromise = (async () => {
      try {
        const { OllamaBootstrap } = require('./rag/OllamaBootstrap');
        const bootstrap = new OllamaBootstrap();

        // Fire and forget — don't await this before showing the window
        const result = await bootstrap.bootstrap('nomic-embed-text', (status: string, percent: number) => {
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
      } catch (err) {
         console.error('[AppState] Failed to bootstrap Ollama:', err);
      }
    })();
  }

  private initializeRAGManager(): void {
    try {
      const db = DatabaseManager.getInstance();
      const sqliteDb = db.getDb();

      if (sqliteDb) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        const cm = CredentialsManager.getInstance();
        const openaiKey = cm.getOpenaiApiKey() || process.env.OPENAI_API_KEY;
        const geminiKey = cm.getGeminiApiKey() || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
        
        this.ragManager = new RAGManager({ 
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
} catch (error) {
console.error('[AppState] Failed to initialize RAGManager:', error);
}
}

private async initializeAccelerationManager(): Promise<void> {
try {
const { AccelerationManager } = await import('./services/AccelerationManager');
const accelerationManager = new AccelerationManager();
await accelerationManager.initialize();
console.log('[AppState] AccelerationManager initialized (Apple Silicon enhancement)');
} catch (error) {
console.warn('[AppState] AccelerationManager initialization skipped (optional):', error);
}
}

private initializeKnowledgeOrchestrator(): void {
// Initialize Knowledge Orchestrator
try {
      const db = DatabaseManager.getInstance();
      const sqliteDb = db.getDb();

      if (sqliteDb && KnowledgeDatabaseManagerClass && KnowledgeOrchestratorClass) {
        const knowledgeDb = new KnowledgeDatabaseManagerClass(sqliteDb);
        this.knowledgeOrchestrator = new KnowledgeOrchestratorClass(knowledgeDb);

        // Wire up LLM functions
        const llmHelper = this.processingHelper.getLLMHelper();

        // generateContent function for LLM calls
        this.knowledgeOrchestrator.setGenerateContentFn(async (contents: any[]) => {
          return await llmHelper.generateContentStructured(
            contents[0]?.text || ''
          );
        });

        // Embedding function — lazily delegate to the cascaded EmbeddingPipeline
        // (OpenAI → Gemini → Ollama → Local bundled model).
        // We await waitForReady() so uploads during boot wait for the pipeline
        // instead of immediately throwing 'not ready'.
        const self = this;
        this.knowledgeOrchestrator.setEmbedFn(async (text: string) => {
          const pipeline = self.ragManager?.getEmbeddingPipeline();
          if (!pipeline) throw new Error('RAG pipeline not available');
          await pipeline.waitForReady();
          return await pipeline.getEmbedding(text);
        });
        if (typeof this.knowledgeOrchestrator.setEmbedQueryFn === 'function') {
          this.knowledgeOrchestrator.setEmbedQueryFn(async (text: string) => {
            const pipeline = self.ragManager?.getEmbeddingPipeline();
            if (!pipeline) throw new Error('RAG pipeline not available');
            await pipeline.waitForReady();
            return await pipeline.getEmbeddingForQuery(text);
          });
        }

        // Attach KnowledgeOrchestrator to LLMHelper
        llmHelper.setKnowledgeOrchestrator(this.knowledgeOrchestrator);

        console.log('[AppState] KnowledgeOrchestrator initialized');
      }
    } catch (error) {
    console.error('[AppState] Failed to initialize KnowledgeOrchestrator:', error);
    }
  }

  // Update-related methods removed

  // New Property for System Audio & Microphone
  private systemAudioCapture: SystemAudioCapture | null = null;
  private microphoneCapture: MicrophoneCapture | null = null;
  private audioTestCapture: MicrophoneCapture | null = null; // For audio settings test
  private googleSTT: STTProvider | null = null; // Interviewer
  private googleSTT_User: STTProvider | null = null; // User

  // Listener references for proper cleanup (prevent memory leaks)
  private sttTranscriptListener_Interviewer: ((segment: { text: string, isFinal: boolean, confidence: number }) => void) | null = null;
  private sttErrorListener_Interviewer: ((err: Error) => void) | null = null;
  private sttTranscriptListener_User: ((segment: { text: string, isFinal: boolean, confidence: number }) => void) | null = null;
  private sttErrorListener_User: ((err: Error) => void) | null = null;

  private createSTTProvider(speaker: 'interviewer' | 'user'): STTProvider {
    const { CredentialsManager } = require('./services/CredentialsManager');
    const sttProvider = CredentialsManager.getInstance().getSttProvider();
    const sttLanguage = CredentialsManager.getInstance().getSttLanguage();

    let stt: STTProvider;

    if (sttProvider === 'deepgram') {
      const apiKey = CredentialsManager.getInstance().getDeepgramApiKey();
      if (apiKey) {
        console.log(`[Main] Using DeepgramStreamingSTT for ${speaker}`);
        stt = new DeepgramStreamingSTT(apiKey);
      } else {
        console.warn(`[Main] No API key for Deepgram STT, falling back to GoogleSTT`);
        stt = new GoogleSTT();
      }
    } else if (sttProvider === 'soniox') {
      const apiKey = CredentialsManager.getInstance().getSonioxApiKey();
      if (apiKey) {
        console.log(`[Main] Using SonioxStreamingSTT for ${speaker}`);
        stt = new SonioxStreamingSTT(apiKey);
      } else {
        console.warn(`[Main] No API key for Soniox STT, falling back to GoogleSTT`);
        stt = new GoogleSTT();
      }
    } else if (sttProvider === 'elevenlabs') {
      const apiKey = CredentialsManager.getInstance().getElevenLabsApiKey();
      if (apiKey) {
        console.log(`[Main] Using ElevenLabsStreamingSTT for ${speaker}`);
        stt = new ElevenLabsStreamingSTT(apiKey);
      } else {
        console.warn(`[Main] No API key for ElevenLabs STT, falling back to GoogleSTT`);
        stt = new GoogleSTT();
      }
    } else if (sttProvider === 'openai') {
      // OpenAI: WebSocket Realtime (gpt-4o-transcribe → gpt-4o-mini-transcribe) with whisper-1 REST fallback
      const apiKey = CredentialsManager.getInstance().getOpenAiSttApiKey();
      if (apiKey) {
        console.log(`[Main] Using OpenAIStreamingSTT (WebSocket+REST fallback) for ${speaker}`);
        stt = new OpenAIStreamingSTT(apiKey);
      } else {
        console.warn(`[Main] No API key for OpenAI STT, falling back to GoogleSTT`);
        stt = new GoogleSTT();
      }
    } else if (sttProvider === 'groq' || sttProvider === 'azure' || sttProvider === 'ibmwatson') {
      let apiKey: string | undefined;
      let region: string | undefined;
      let modelOverride: string | undefined;

      if (sttProvider === 'groq') {
        apiKey = CredentialsManager.getInstance().getGroqSttApiKey();
        modelOverride = CredentialsManager.getInstance().getGroqSttModel();
      } else if (sttProvider === 'azure') {
        apiKey = CredentialsManager.getInstance().getAzureApiKey();
        region = CredentialsManager.getInstance().getAzureRegion();
      } else if (sttProvider === 'ibmwatson') {
        apiKey = CredentialsManager.getInstance().getIbmWatsonApiKey();
        region = CredentialsManager.getInstance().getIbmWatsonRegion();
      }

      if (apiKey) {
        console.log(`[Main] Using RestSTT (${sttProvider}) for ${speaker}`);
        stt = new RestSTT(sttProvider, apiKey, modelOverride, region);
      } else {
        console.warn(`[Main] No API key for ${sttProvider} STT, falling back to GoogleSTT`);
        stt = new GoogleSTT();
      }
    } else {
      stt = new GoogleSTT();
    }

    stt.setRecognitionLanguage(sttLanguage);

    // Wire Transcript Events - store references for proper cleanup
    const sttEmitter = stt as EventEmitter

    const transcriptHandler = (segment: { text: string, isFinal: boolean, confidence: number }) => {
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
      helper.getOverlayContentWindow()?.webContents.send('native-audio-transcript', payload);

      void maybeHandleSuggestionTriggerFromTranscript({
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

    const errorHandler = (err: Error) => {
      console.error(`[Main] STT (${speaker}) Error:`, err);
      if (this.isMeetingActive) {
        this.sttReconnector?.onError(speaker);
      }
    };

    // Store listener references based on speaker
    if (speaker === 'interviewer') {
      this.sttTranscriptListener_Interviewer = transcriptHandler;
      this.sttErrorListener_Interviewer = errorHandler;
    } else {
      this.sttTranscriptListener_User = transcriptHandler;
      this.sttErrorListener_User = errorHandler;
    }

    sttEmitter.on('transcript', transcriptHandler);
    sttEmitter.on('error', errorHandler);

    return stt;
  }

  private async handleAudioCaptureError(source: 'system' | 'microphone', err: Error): Promise<void> {
    const noun = source === 'system' ? 'Audio pipeline' : 'Microphone';
    const failureMessage = source === 'system'
      ? 'Audio capture failed and recovery unsuccessful'
      : 'Microphone failed and recovery unsuccessful';
    const defaultErrorMessage = source === 'system'
      ? 'System audio capture failed'
      : 'Microphone capture failed';

    console.error(`[Main] ${source === 'system' ? 'SystemAudioCapture' : 'MicrophoneCapture'} Error:`, err);
    this.setNativeAudioConnected(false);

    if (this.isMeetingActive && this.audioRecoveryAttempts < this.MAX_AUDIO_RECOVERY_ATTEMPTS) {
      this.audioRecoveryAttempts += 1;
      const attempt = this.audioRecoveryAttempts;
      const delayMs = this.audioRecoveryBackoffMs * attempt;
      console.log(`[Main] Attempting ${noun.toLowerCase()} recovery (attempt ${attempt}/${this.MAX_AUDIO_RECOVERY_ATTEMPTS}, delay ${delayMs}ms)...`);

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

      if (!this.isMeetingActive) {
        return;
      }

      try {
        await this.reconfigureAudio();
        console.log(`[Main] ${noun} recovered successfully on attempt ${attempt}`);
        this.setNativeAudioConnected(true);
        return;
      } catch (recoveryErr) {
        console.error(`[Main] ${noun} recovery attempt ${attempt} failed:`, recoveryErr);
        if (this.audioRecoveryAttempts >= this.MAX_AUDIO_RECOVERY_ATTEMPTS) {
          this.broadcast('meeting-audio-error', failureMessage);
          return;
        }
      }
    }

    this.broadcast('meeting-audio-error', err.message || defaultErrorMessage);
  }

  private attachSystemAudioCaptureListeners(): void {
    if (!this.systemAudioCapture) {
      return;
    }

    this.systemAudioCapture.removeAllListeners();
    this.systemAudioCapture.on('data', (chunk: Buffer) => {
      this.googleSTT?.write(chunk);
    });
    this.systemAudioCapture.on('speech_ended', () => {
      safeNotifySpeechEnded(this.googleSTT);
    });
    this.systemAudioCapture.on('error', (err: Error) => {
      void this.handleAudioCaptureError('system', err);
    });
  }

  private attachMicrophoneCaptureListeners(): void {
    if (!this.microphoneCapture) {
      return;
    }

    this.microphoneCapture.removeAllListeners();
    this.microphoneCapture.on('data', (chunk: Buffer) => {
      this.googleSTT_User?.write(chunk);
    });
    this.microphoneCapture.on('speech_ended', () => {
      safeNotifySpeechEnded(this.googleSTT_User);
    });
    this.microphoneCapture.on('error', (err: Error) => {
      void this.handleAudioCaptureError('microphone', err);
    });
  }

  private cleanupSttProvider(speaker: 'interviewer' | 'user'): void {
    const isInterviewer = speaker === 'interviewer';
    const stt = isInterviewer ? this.googleSTT : this.googleSTT_User;
    if (!stt) {
      return;
    }

    const transcriptListener = isInterviewer
      ? this.sttTranscriptListener_Interviewer
      : this.sttTranscriptListener_User;
    const errorListener = isInterviewer
      ? this.sttErrorListener_Interviewer
      : this.sttErrorListener_User;
    const sttEmitter = stt as EventEmitter;

    if (transcriptListener) {
      sttEmitter.removeListener('transcript', transcriptListener);
    }
    if (errorListener) {
      sttEmitter.removeListener('error', errorListener);
    }

    stt.stop();
    stt.removeAllListeners();
    safeDestroy(stt);

    if (isInterviewer) {
      this.sttTranscriptListener_Interviewer = null;
      this.sttErrorListener_Interviewer = null;
      this.googleSTT = null;
    } else {
      this.sttTranscriptListener_User = null;
      this.sttErrorListener_User = null;
      this.googleSTT_User = null;
    }
  }

  private async reconnectSpeakerStt(speaker: 'interviewer' | 'user'): Promise<void> {
    this.cleanupSttProvider(speaker);

    if (speaker === 'interviewer') {
      this.googleSTT = this.createSTTProvider('interviewer');
      if (this.systemAudioCapture) {
        const rate = this.systemAudioCapture.getSampleRate();
        this.googleSTT?.setSampleRate(rate);
        safeSetAudioChannelCount(this.googleSTT, 1);
      }
      this.googleSTT?.start();
      return;
    }

    this.googleSTT_User = this.createSTTProvider('user');
    if (this.microphoneCapture) {
      const rate = this.microphoneCapture.getSampleRate() || 48000;
      this.googleSTT_User?.setSampleRate(rate);
      safeSetAudioChannelCount(this.googleSTT_User, 1);
    }
    this.googleSTT_User?.start();
  }

  private setupSystemAudioPipeline(): void {
    try {
      if (!this.systemAudioCapture) {
        this.systemAudioCapture = new SystemAudioCapture();
      }
      this.attachSystemAudioCaptureListeners();

      if (!this.microphoneCapture) {
        this.microphoneCapture = new MicrophoneCapture();
      }
      this.attachMicrophoneCaptureListeners();

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

    } catch (err) {
      console.error('[Main] Failed to setup System Audio Pipeline:', err);
    }
  }

  private async reconfigureAudio(inputDeviceId?: string, outputDeviceId?: string): Promise<void> {
    console.log(`[Main] Reconfiguring Audio: Input=${inputDeviceId}, Output=${outputDeviceId}`);

    // 1. System Audio (Output Capture) - use destroy() for full cleanup
    if (this.systemAudioCapture) {
      this.systemAudioCapture.removeAllListeners();
      this.systemAudioCapture.destroy();
      this.systemAudioCapture = null;
    }

    try {
      console.log('[Main] Initializing SystemAudioCapture...');
      this.systemAudioCapture = new SystemAudioCapture(outputDeviceId || undefined);
      const rate = this.systemAudioCapture.getSampleRate();
      console.log(`[Main] SystemAudioCapture rate: ${rate}Hz`);
      this.googleSTT?.setSampleRate(rate);

      this.systemAudioCapture.on('data', (chunk: Buffer) => {
        // console.log('[Main] SysAudio chunk', chunk.length);
        this.googleSTT?.write(chunk);
      });
      this.systemAudioCapture.on('speech_ended', () => {
        safeNotifySpeechEnded(this.googleSTT);
      });
      this.systemAudioCapture.on('error', (err: Error) => {
        void this.handleAudioCaptureError('system', err);
      });
      console.log('[Main] SystemAudioCapture initialized.');
    } catch (err) {
      console.warn('[Main] Failed to initialize SystemAudioCapture with preferred ID. Falling back to default.', err);
      try {
        this.systemAudioCapture = new SystemAudioCapture(); // Default
        const rate = this.systemAudioCapture.getSampleRate();
        console.log(`[Main] SystemAudioCapture (Default) rate: ${rate}Hz`);
        this.googleSTT?.setSampleRate(rate);

        this.systemAudioCapture.on('data', (chunk: Buffer) => {
          this.googleSTT?.write(chunk);
        });
      this.systemAudioCapture.on('speech_ended', () => {
        safeNotifySpeechEnded(this.googleSTT);
      });
        this.systemAudioCapture.on('error', (err: Error) => {
          void this.handleAudioCaptureError('system', err);
        });
      } catch (err2) {
        console.error('[Main] Failed to initialize SystemAudioCapture (Default):', err2);
      }
    }

    // 2. Microphone (Input Capture) - use destroy() for full cleanup
    if (this.microphoneCapture) {
      this.microphoneCapture.removeAllListeners();
      this.microphoneCapture.destroy();
      this.microphoneCapture = null;
    }

    try {
      console.log('[Main] Initializing MicrophoneCapture...');
      this.microphoneCapture = new MicrophoneCapture(inputDeviceId || undefined);
      const rate = this.microphoneCapture.getSampleRate();
      console.log(`[Main] MicrophoneCapture rate: ${rate}Hz`);
      this.googleSTT_User?.setSampleRate(rate);

      this.microphoneCapture.on('data', (chunk: Buffer) => {
        // console.log('[Main] Mic chunk', chunk.length);
        this.googleSTT_User?.write(chunk);
      });
      this.microphoneCapture.on('speech_ended', () => {
        safeNotifySpeechEnded(this.googleSTT_User);
      });
      this.microphoneCapture.on('error', (err: Error) => {
        void this.handleAudioCaptureError('microphone', err);
      });
      console.log('[Main] MicrophoneCapture initialized.');
    } catch (err) {
      console.warn('[Main] Failed to initialize MicrophoneCapture with preferred ID. Falling back to default.', err);
      try {
        this.microphoneCapture = new MicrophoneCapture(); // Default
        const rate = this.microphoneCapture.getSampleRate();
        console.log(`[Main] MicrophoneCapture (Default) rate: ${rate}Hz`);
        this.googleSTT_User?.setSampleRate(rate);

        this.microphoneCapture.on('data', (chunk: Buffer) => {
          this.googleSTT_User?.write(chunk);
        });
        this.microphoneCapture.on('speech_ended', () => {
          this.googleSTT_User?.notifySpeechEnded?.();
        });
        this.microphoneCapture.on('error', (err: Error) => {
          void this.handleAudioCaptureError('microphone', err);
        });
      } catch (err2) {
        console.error('[Main] Failed to initialize MicrophoneCapture (Default):', err2);
      }
    }
  }

  /**
   * Reconfigure STT provider mid-session (called from IPC when user changes provider)
   * Destroys existing STT instances and recreates them with the new provider
   */
  public async reconfigureSttProvider(): Promise<void> {
    console.log('[Main] Reconfiguring STT Provider...');

    // Stop existing STT instances - remove listeners using stored references first
    if (this.googleSTT) {
      const sttEmitter = this.googleSTT as EventEmitter;
      if (this.sttTranscriptListener_Interviewer) {
        sttEmitter.removeListener('transcript', this.sttTranscriptListener_Interviewer);
        this.sttTranscriptListener_Interviewer = null;
      }
      if (this.sttErrorListener_Interviewer) {
        sttEmitter.removeListener('error', this.sttErrorListener_Interviewer);
        this.sttErrorListener_Interviewer = null;
      }
      this.googleSTT.stop();
      this.googleSTT.removeAllListeners();
      safeDestroy(this.googleSTT);
      this.googleSTT = null;
    }
    if (this.googleSTT_User) {
      const sttEmitter = this.googleSTT_User as EventEmitter;
      if (this.sttTranscriptListener_User) {
        sttEmitter.removeListener('transcript', this.sttTranscriptListener_User);
        this.sttTranscriptListener_User = null;
      }
      if (this.sttErrorListener_User) {
        sttEmitter.removeListener('error', this.sttErrorListener_User);
        this.sttErrorListener_User = null;
      }
      this.googleSTT_User.stop();
      this.googleSTT_User.removeAllListeners();
      safeDestroy(this.googleSTT_User);
      this.googleSTT_User = null;
    }

    // Reinitialize the pipeline (will pick up the new provider from CredentialsManager)
    this.setupSystemAudioPipeline();

    // Start the new STT instances if a meeting is active
    if (this.isMeetingActive) {
      const interviewerStt = this.googleSTT as STTProvider | null;
      const userStt = this.googleSTT_User as STTProvider | null;
      interviewerStt?.start?.();
      userStt?.start?.();
    }

    console.log('[Main] STT Provider reconfigured');
  }


  public startAudioTest(deviceId?: string): void {
    console.log(`[Main] Starting Audio Test on device: ${deviceId || 'default'}`);
    this.stopAudioTest(); // Stop any existing test

    try {
      this.audioTestCapture = new MicrophoneCapture(deviceId || undefined);
      this.audioTestCapture.start();

      // Send to settings window if open, else main window
      const win = this.settingsWindowHelper.getSettingsWindow() || this.getMainWindow();

      this.audioTestCapture.on('data', (chunk: Buffer) => {
        // Calculate basic RMS for level meter
        if (!win || win.isDestroyed()) return;

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
          win.webContents.send('audio-level', level);
        }
      });

      this.audioTestCapture.on('error', (err: Error) => {
        console.error('[Main] AudioTest Error:', err);
      });

    } catch (err) {
      console.error('[Main] Failed to start audio test:', err);
    }
  }

  public stopAudioTest(): void {
    if (this.audioTestCapture) {
      console.log('[Main] Stopping Audio Test');
      this.audioTestCapture.stop();
      this.audioTestCapture = null;
    }
  }

  public finalizeMicSTT(): void {
    // We only want to finalize the user microphone, because the context is Manual Answer
    safeFinalize(this.googleSTT_User);
    console.log('[Main] STT finalized');
  }

  public async startMeeting(metadata?: any): Promise<void> {
    console.log('[Main] Starting Meeting...', metadata);
    this.audioRecoveryAttempts = 0;
    this.audioRecoveryBackoffMs = 5000;
    this.startAbortController = new AbortController();
    const { signal } = this.startAbortController;

    if (metadata && typeof metadata !== 'object') {
      throw new Error('startMeeting metadata must be an object or undefined');
    }
    if (metadata?.audio && (typeof metadata.audio.inputDeviceId !== 'string' || typeof metadata.audio.outputDeviceId !== 'string')) {
      throw new Error('startMeeting metadata.audio requires string inputDeviceId and outputDeviceId');
    }

    const currentMutex = this.meetingStartMutex;
    let settled = false;
    this.meetingStartMutex = currentMutex.then(async () => {
      if (signal.aborted) {
        console.log('[Main] Start meeting aborted (canceled by endMeeting)');
        return;
      }

      if (this.meetingLifecycleState === 'starting' || this.meetingLifecycleState === 'active') {
        console.warn(`[Main] Ignoring startMeeting while state=${this.meetingLifecycleState}`)
        return
      }

      this.meetingLifecycleState = 'starting'
      const startSequence = ++this.meetingStartSequence

      try {
        await this.validateMeetingAudioSetup(metadata);
      } catch (error) {
        this.currentMeetingId = null
        this.meetingLifecycleState = 'idle'
        throw error
      }

      if (signal.aborted) {
        console.log('[Main] Start meeting aborted after validation');
        this.meetingLifecycleState = 'idle';
        return;
      }

      this.currentMeetingId = randomUUID()
      this.isMeetingActive = true;
      if (metadata) {
        this.intelligenceManager.setMeetingMetadata(metadata);
      }

      this.getWindowHelper().getOverlayContentWindow()?.webContents.send('session-reset');
      this.getWindowHelper().getLauncherWindow()?.webContents.send('session-reset');

      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          console.log('[Main] Start meeting aborted before deferred step');
          this.meetingLifecycleState = 'idle';
          this.isMeetingActive = false;
          this.currentMeetingId = null;
          resolve();
          return;
        }

        setTimeout(async () => {
          if (signal.aborted) {
            console.log('[Main] Start meeting aborted during deferred step');
            this.meetingLifecycleState = 'idle';
            this.isMeetingActive = false;
            this.currentMeetingId = null;
            resolve();
            return;
          }

          if (startSequence !== this.meetingStartSequence || this.meetingLifecycleState !== 'starting') {
            console.warn('[Main] Skipping stale deferred meeting start')
            resolve()
            return
          }

          try {
            if (metadata?.audio) {
              await this.reconfigureAudio(metadata.audio.inputDeviceId, metadata.audio.outputDeviceId);
            }

            if (signal.aborted) {
              console.log('[Main] Start meeting aborted during audio reconfig');
              this.meetingLifecycleState = 'idle';
              this.isMeetingActive = false;
              this.currentMeetingId = null;
              resolve();
              return;
            }

            if (startSequence !== this.meetingStartSequence || this.meetingLifecycleState !== 'starting') {
              console.warn('[Main] Meeting start invalidated during async initialization')
              resolve()
              return
            }

            this.setupSystemAudioPipeline();
            this.systemAudioCapture?.start();
            this.googleSTT?.start();
            this.microphoneCapture?.start();
            this.googleSTT_User?.start();

            if (this.ragManager) {
              try {
                this.ragManager.startLiveIndexing('live-meeting-current');
              } catch (err) {
                console.error('[Main] Live indexing failed:', err);
              }
            }

            this.setNativeAudioConnected(true);
            this.meetingLifecycleState = 'active'
            console.log('[Main] Audio pipeline started successfully.');
            
            if (this.currentMeetingId) {
              this.checkpointer?.start(this.currentMeetingId);
            }
            
            resolve()
          } catch (err) {
            console.error('[Main] Error initializing audio pipeline:', err);
            this.setNativeAudioConnected(false);
            this.broadcast('meeting-audio-error', (err as Error).message || 'Audio pipeline failed to start');
            this.isMeetingActive = false;
            this.currentMeetingId = null;
            this.meetingLifecycleState = 'idle'
            reject(err)
          }
        }, 0);
      })
    }).then(
      () => { settled = true; },
      (err) => { settled = true; throw err; }
    ).catch((err) => {
      if (!settled) {
        console.error('[Main] startMeeting mutex error:', err);
      }
    });

    return this.meetingStartMutex;
  }

  public async endMeeting(): Promise<void> {
    console.log('[Main] Ending Meeting...');
    this.startAbortController?.abort();
    this.startAbortController = null;
    const meetingId = this.currentMeetingId;
    this.currentMeetingId = null;
    const endSequence = ++this.meetingStartSequence  // Increment sequence to invalidate any pending starts
    this.meetingLifecycleState = 'stopping'
    this.isMeetingActive = false; // Block new data immediately
    this.setNativeAudioConnected(false);

    // Wait for any pending meeting start operations to complete before proceeding
    // This prevents race conditions between start and end operations
    await this.meetingStartMutex.catch(() => {
      // Ignore errors from the mutex as we're ending the meeting anyway
      console.log('[Main] Ignoring pending meeting start errors during endMeeting');
    });

    this.sttReconnector?.stopAll();
    this.checkpointer?.stop();

    // 3. Stop System Audio
    try {
      this.systemAudioCapture?.removeAllListeners();
      this.systemAudioCapture?.stop();
      if (typeof this.systemAudioCapture?.destroy === 'function') {
        this.systemAudioCapture.destroy();
      }
      this.systemAudioCapture = null;
    } catch (error) {
      console.error('[Main] Failed to stop system audio during endMeeting:', error)
    }

    // Stop interviewer STT with proper listener cleanup
    try {
      if (this.googleSTT) {
        const sttEmitter = this.googleSTT as EventEmitter;
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
        this.googleSTT = null;
      }
    } catch (error) {
      console.error('[Main] Failed to stop interviewer STT during endMeeting:', error)
    }

    // 4. Stop Microphone
    try {
      this.microphoneCapture?.removeAllListeners();
      this.microphoneCapture?.stop();
      if (typeof this.microphoneCapture?.destroy === 'function') {
        this.microphoneCapture.destroy();
      }
      this.microphoneCapture = null;
    } catch (error) {
      console.error('[Main] Failed to stop microphone capture during endMeeting:', error)
    }

    // Stop user STT with proper listener cleanup
    try {
      if (this.googleSTT_User) {
        const sttEmitter = this.googleSTT_User as EventEmitter;
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
        this.googleSTT_User = null;
      }
    } catch (error) {
      console.error('[Main] Failed to stop user STT during endMeeting:', error)
    }

    // 4b. Stop JIT RAG live indexing (flush remaining segments)
    if (this.ragManager) {
      try {
        await this.ragManager.stopLiveIndexing();
      } catch (error) {
        console.error('[Main] Failed to stop live indexing during endMeeting:', error)
      }
    }

    // 4. Reset Intelligence Context & Save
    await this.intelligenceManager.stopMeeting(meetingId ?? undefined);

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
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('model-changed', defaultModel);
      });

    } catch (e) {
      console.error("[Main] Failed to revert model:", e);
    }

    // 6. Process meeting for RAG (embeddings)
    await this.processCompletedMeetingForRAG();

    // 7. Clean up JIT RAG provisional chunks (post-meeting RAG replaces them)
    if (this.ragManager) {
      this.ragManager.deleteMeetingData('live-meeting-current');
    }

    this.meetingLifecycleState = 'idle'
  }

  public async cleanupForQuit(): Promise<void> {
    await this.intelligenceManager.waitForPendingSaves(10000);
    this.meetingStartSequence += 1
    this.meetingLifecycleState = 'idle'
    this.isMeetingActive = false
    this.setNativeAudioConnected(false)
    this.currentMeetingId = null

    // Clear disguise timers to prevent memory leaks
    this.clearDisguiseTimers()

    this.sttReconnector?.stopAll();
    this.checkpointer?.destroy();

    // Remove intelligence event listeners to prevent memory leaks
    this.intelligenceManager.removeAllListeners()

    try {
      this.systemAudioCapture?.removeAllListeners()
      this.systemAudioCapture?.stop()
      if (typeof this.systemAudioCapture?.destroy === 'function') {
        this.systemAudioCapture.destroy()
      }
    } catch (error) {
      console.error('[Main] Failed to stop system audio during quit:', error)
    }

    // Stop interviewer STT with proper listener cleanup
    try {
      if (this.googleSTT) {
        const sttEmitter = this.googleSTT as EventEmitter
        if (this.sttTranscriptListener_Interviewer) {
          sttEmitter.removeListener('transcript', this.sttTranscriptListener_Interviewer)
          this.sttTranscriptListener_Interviewer = null
        }
        if (this.sttErrorListener_Interviewer) {
          sttEmitter.removeListener('error', this.sttErrorListener_Interviewer)
          this.sttErrorListener_Interviewer = null
        }
      this.googleSTT?.stop()
      this.googleSTT?.removeAllListeners()
      safeDestroy(this.googleSTT)
    }
  } catch (error) {
    console.error('[Main] Failed to stop interviewer STT during quit:', error)
  }

  try {
    this.microphoneCapture?.removeAllListeners()
    this.microphoneCapture?.stop()
    if (typeof this.microphoneCapture?.destroy === 'function') {
      this.microphoneCapture.destroy()
    }
  } catch (error) {
    console.error('[Main] Failed to stop microphone capture during quit:', error)
  }

  // Stop user STT with proper listener cleanup
  try {
    if (this.googleSTT_User) {
      const sttEmitter = this.googleSTT_User as EventEmitter
      if (this.sttTranscriptListener_User) {
        sttEmitter.removeListener('transcript', this.sttTranscriptListener_User)
        this.sttTranscriptListener_User = null
      }
      if (this.sttErrorListener_User) {
        sttEmitter.removeListener('error', this.sttErrorListener_User)
        this.sttErrorListener_User = null
      }
      this.googleSTT_User?.stop()
      this.googleSTT_User?.removeAllListeners()
      safeDestroy(this.googleSTT_User)
    }
    } catch (error) {
      console.error('[Main] Failed to stop user STT during quit:', error)
    }

    try {
      this.audioTestCapture?.stop()
    } catch (error) {
      console.error('[Main] Failed to stop audio test capture during quit:', error)
    }

    this.systemAudioCapture = null
    this.microphoneCapture = null
    this.audioTestCapture = null
    this.googleSTT = null
    this.googleSTT_User = null

    this.ragManager?.stopLiveIndexing().catch(err => {
      console.error('[Main] Failed to stop live indexing during quit:', err)
    })

    this.processingHelper.getLLMHelper().scrubKeys();

    this.virtualDisplayCoordinator?.dispose?.();
  }

  private async processCompletedMeetingForRAG(): Promise<void> {
    if (!this.ragManager) return;

    try {
      // Get the most recent meeting from database
      const meetings = DatabaseManager.getInstance().getRecentMeetings(1);
      if (meetings.length === 0) return;

      const meeting = DatabaseManager.getInstance().getMeetingDetails(meetings[0].id);
      if (!meeting || !meeting.transcript || meeting.transcript.length === 0) return;

      // Convert transcript to RAG format
      const segments = meeting.transcript.map(t => ({
        speaker: t.speaker,
        text: t.text,
        timestamp: t.timestamp
      }));

      // Generate summary from detailedSummary if available
      let summary: string | undefined;
      if (meeting.detailedSummary) {
        summary = [
          ...(meeting.detailedSummary.keyPoints || []),
          ...(meeting.detailedSummary.actionItems || []).map(a => `Action: ${a}`)
        ].join('. ');
      }

      const result = await this.ragManager.processMeeting(meeting.id, segments, summary);
      console.log(`[AppState] RAG processed meeting ${meeting.id}: ${result.chunkCount} chunks`);

    } catch (error) {
      console.error('[AppState] Failed to process meeting for RAG:', error);
    }
  }

  private setupIntelligenceEvents(): void {
    const mainWindow = this.getMainWindow.bind(this)

    // Forward intelligence events to renderer
    this.intelligenceManager.on('assist_update', (insight: string) => {
      // Send to both if both exist, though mostly overlay needs it
      const helper = this.getWindowHelper();
      const launcher = helper.getLauncherWindow();
      const overlay = helper.getOverlayWindow();
      if (launcher && !launcher.isDestroyed()) launcher.webContents.send('intelligence-assist-update', { insight });
      const overlayContent = this.getWindowHelper().getOverlayContentWindow();
      if (overlayContent && !overlayContent.isDestroyed()) overlayContent.webContents.send('intelligence-assist-update', { insight });
    })

    this.intelligenceManager.on('suggested_answer', (answer: string, question: string, confidence: number) => {
      const win = mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('intelligence-suggested-answer', { answer, question, confidence })
      }

    })

    this.intelligenceManager.on('suggested_answer_token', (token: string, question: string, confidence: number) => {
      const win = mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('intelligence-suggested-answer-token', { token, question, confidence })
      }
    })

    this.intelligenceManager.on('refined_answer_token', (token: string, intent: string) => {
      const win = mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('intelligence-refined-answer-token', { token, intent })
      }
    })

    this.intelligenceManager.on('refined_answer', (answer: string, intent: string) => {
      const win = mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('intelligence-refined-answer', { answer, intent })
      }

    })

    this.intelligenceManager.on('recap', (summary: string) => {
      const win = mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('intelligence-recap', { summary })
      }
    })

    this.intelligenceManager.on('recap_token', (token: string) => {
      const win = mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('intelligence-recap-token', { token })
      }
    })

    this.intelligenceManager.on('follow_up_questions_update', (questions: string) => {
      const win = mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('intelligence-follow-up-questions-update', { questions })
      }
    })

    this.intelligenceManager.on('follow_up_questions_token', (token: string) => {
      const win = mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('intelligence-follow-up-questions-token', { token })
      }
    })

    this.intelligenceManager.on('manual_answer_started', () => {
      const win = mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('intelligence-manual-started')
      }
    })

    this.intelligenceManager.on('manual_answer_result', (answer: string, question: string) => {
      const win = mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('intelligence-manual-result', { answer, question })
      }

    })

    this.intelligenceManager.on('mode_changed', (mode: string) => {
      const win = mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('intelligence-mode-changed', { mode })
      }
    })

    this.intelligenceManager.on('error', (error: Error, mode: string) => {
      console.error(`[IntelligenceManager] Error in ${mode}:`, error)
      const win = mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('intelligence-error', { error: error.message, mode })
      }
    })
  }





  public updateGoogleCredentials(keyPath: string): void {
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

  public setRecognitionLanguage(key: string): void {
    console.log(`[AppState] Setting recognition language to: ${key}`);
    const { CredentialsManager } = require('./services/CredentialsManager');
    CredentialsManager.getInstance().setSttLanguage(key);
    this.googleSTT?.setRecognitionLanguage(key);
    this.googleSTT_User?.setRecognitionLanguage(key);
    this.processingHelper.getLLMHelper().setSttLanguage(key);
  }

  public static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState()
    }
    return AppState.instance
  }

  // Getters and Setters
  public getIsMeetingActive(): boolean {
    return this.isMeetingActive;
  }

  public getMainWindow(): BrowserWindow | null {
    return this.windowHelper.getMainWindow()
  }

  public getWindowHelper(): WindowHelper {
    return this.windowHelper
  }

  public getIntelligenceManager(): IntelligenceManager {
    return this.intelligenceManager
  }

  public getThemeManager(): ThemeManager {
    return this.themeManager
  }

  public getRAGManager(): RAGManager | null {
    return this.ragManager;
  }

  public getKnowledgeOrchestrator(): any {
    return this.knowledgeOrchestrator;
  }

  public getView(): "queue" | "solutions" {
    return this.view
  }

  public setView(view: "queue" | "solutions"): void {
    this.view = view
    this.screenshotHelper.setView(view)
  }

  public isVisible(): boolean {
    return this.windowHelper.isVisible()
  }

  public getScreenshotHelper(): ScreenshotHelper {
    return this.screenshotHelper
  }

  public getProblemInfo(): any {
    return this.problemInfo
  }

  public setProblemInfo(problemInfo: any): void {
    this.problemInfo = problemInfo
  }

  public getScreenshotQueue(): string[] {
    return this.screenshotHelper.getScreenshotQueue()
  }

  public getExtraScreenshotQueue(): string[] {
    return this.screenshotHelper.getExtraScreenshotQueue()
  }

  // Window management methods
  public setupOllamaIpcHandlers(): void {
    ipcMain.handle('get-ollama-models', async () => {
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
          return data.models.map((m: any) => m.name);
        }
        return [];
      } catch (error) {
        // console.warn("Ollama detection failed:", error);
        return [];
      }
    });
  }

  public createWindow(): void {
    this.windowHelper.createWindow()
  }

  public hideMainWindow(): void {
    this.windowHelper.hideMainWindow()
  }

  public showMainWindow(): void {
    this.windowHelper.showMainWindow()
  }

  public toggleMainWindow(): void {
    console.log(
      "Screenshots: ",
      this.screenshotHelper.getScreenshotQueue().length,
      "Extra screenshots: ",
      this.screenshotHelper.getExtraScreenshotQueue().length
    )
    
    // Send toggle-expand to the currently active window mode's window.
    // If we use getMainWindow(), it might return the launcher window when the overlay is hidden,
    // causing the IPC event to go to the wrong React tree and silently fail.
    const mode = this.windowHelper.getCurrentWindowMode();
    const targetWindow = mode === 'overlay' ? this.windowHelper.getOverlayWindow() : this.windowHelper.getLauncherContentWindow();

    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send('toggle-expand');
    }
  }

  public setWindowDimensions(width: number, height: number): void {
    this.windowHelper.setWindowDimensions(width, height)
  }

  public clearQueues(): void {
    this.screenshotHelper.clearQueues()

    // Clear problem info
    this.problemInfo = null

    // Reset view to initial state
    this.setView("queue")
  }

  // Screenshot management methods
  public async takeScreenshot(): Promise<string> {
    if (!this.getMainWindow()) throw new Error("No main window available")

    const wasOverlayVisible = this.windowHelper.getOverlayWindow()?.isVisible() ?? false

    const screenshotPath = await this.screenshotHelper.takeScreenshot(
      () => this.hideMainWindow(),
      () => {
        if (wasOverlayVisible) {
          this.windowHelper.switchToOverlay()
        } else {
          this.showMainWindow()
        }
      }
    )

    return screenshotPath
  }

  public async takeSelectiveScreenshot(): Promise<string> {
    if (!this.getMainWindow()) throw new Error("No main window available")

    const wasOverlayVisible = this.windowHelper.getOverlayWindow()?.isVisible() ?? false

    const screenshotPath = await this.screenshotHelper.takeSelectiveScreenshot(
      () => this.hideMainWindow(),
      () => {
        if (wasOverlayVisible) {
          this.windowHelper.switchToOverlay()
        } else {
          this.showMainWindow()
        }
      }
    )

    return screenshotPath
  }

  public async getImagePreview(filepath: string): Promise<string> {
    return this.screenshotHelper.getImagePreview(filepath)
  }

  public async deleteScreenshot(
    path: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.screenshotHelper.deleteScreenshot(path)
  }

  // New methods to move the window
  public moveWindowLeft(): void {
    this.windowHelper.moveWindowLeft()
  }

  public moveWindowRight(): void {
    this.windowHelper.moveWindowRight()
  }
  public moveWindowDown(): void {
    this.windowHelper.moveWindowDown()
  }
  public moveWindowUp(): void {
    this.windowHelper.moveWindowUp()
  }

  public centerAndShowWindow(): void {
    this.windowHelper.centerAndShowWindow()
  }

  public createTray(): void {
    this.showTray();
  }

  public showTray(): void {
    if (this.tray) return;

    // Try to find a template image first for macOS
    const resourcesPath = app.isPackaged ? process.resourcesPath : app.getAppPath();

    // Potential paths for tray icon
    const templatePath = path.join(resourcesPath, 'assets', 'iconTemplate.png');
    const defaultIconPath = app.isPackaged
      ? path.join(resourcesPath, 'src/components/icon.png')
      : path.join(app.getAppPath(), 'src/components/icon.png');

    let iconToUse = defaultIconPath;

    // Check if template exists (sync check is fine for startup/rare toggle)
    try {
      if (require('fs').existsSync(templatePath)) {
        iconToUse = templatePath;
        console.log('[Tray] Using template icon:', templatePath);
      } else {
        // Also check src/components for dev
        const devTemplatePath = path.join(app.getAppPath(), 'src/components/iconTemplate.png');
        if (require('fs').existsSync(devTemplatePath)) {
          iconToUse = devTemplatePath;
          console.log('[Tray] Using dev template icon:', devTemplatePath);
        } else {
          console.log('[Tray] Template icon not found, using default:', defaultIconPath);
        }
      }
    } catch (e) {
      console.error('[Tray] Error checking for icon:', e);
    }

    const trayIcon = nativeImage.createFromPath(iconToUse).resize({ width: 16, height: 16 });
    // IMPORTANT: specific template settings for macOS if needed, but 'Template' in name usually suffices
    trayIcon.setTemplateImage(iconToUse.endsWith('Template.png'));

    this.tray = new Tray(trayIcon)
    this.tray.setToolTip('Natively') // This tooltip might also need update if we change global shortcut, but global shortcut is removed.
    this.updateTrayMenu();

    // Double-click to show window
    this.tray.on('double-click', () => {
      this.centerAndShowWindow()
    })
  }

  public updateTrayMenu() {
    if (!this.tray) return;

    const keybindManager = KeybindManager.getInstance();
    const screenshotAccel = keybindManager.getKeybind('general:take-screenshot') || 'Command+Alt+Shift+S';

    console.log('[Main] updateTrayMenu called. Screenshot Accelerator:', screenshotAccel);

    // Update tooltip for verification
    this.tray.setToolTip('Natively');

    // Helper to format accelerator for display (e.g. CommandOrControl+H -> Cmd+H)
    const formatAccel = (accel: string) => {
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
    const toggleAccel = toggleKb || 'Command+Alt+Shift+V';
    const displayToggle = formatAccel(toggleAccel);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Natively',
        click: () => {
          this.centerAndShowWindow()
        }
      },
      {
        label: `Toggle Window (${displayToggle})`,
        click: () => {
          this.toggleMainWindow()
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
            const screenshotPath = await this.takeScreenshot()
            const preview = await this.getImagePreview(screenshotPath)
            const mainWindow = this.getMainWindow()
            if (mainWindow) {
              mainWindow.webContents.send("screenshot-taken", {
                path: screenshotPath,
                preview
              })
            }
          } catch (error) {
            console.error("Error taking screenshot from tray:", error)
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
          app.quit()
        }
      }
    ])

    this.tray.setContextMenu(contextMenu)
  }

  public hideTray(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  public setHasDebugged(value: boolean): void {
    this.hasDebugged = value
  }

  public getHasDebugged(): boolean {
    return this.hasDebugged
  }

  public setUndetectable(state: boolean): void {
    // Guard: skip if state hasn't actually changed to prevent
    // duplicate dock hide/show cycles from renderer feedback loops
    if (this.isUndetectable === state) return;

    console.log(`[Stealth] setUndetectable(${state}) called`);

    this.isUndetectable = state
    this.stealthManager.setEnabled(state)
    this.windowHelper.setContentProtection(state)
    this.settingsWindowHelper.setContentProtection(state)
    this.modelSelectorWindowHelper.setContentProtection(state)

    // Persist state via SettingsManager
    SettingsManager.getInstance().set('isUndetectable', state);

    // Cancel pending disguise timers from prior dock/disguise transitions so
    // stale blur-reset or app.setName() callbacks cannot fire after a rapid toggle.
    this.clearDisguiseTimers()

    // Broadcast state change to all relevant windows
    this._broadcastToAllWindows('undetectable-changed', state);

    // --- STEALTH MODE LOGIC (restored from working version a820380) ---
    if (process.platform === 'darwin') {
      const activeWindow = this.windowHelper.getVisibleMainWindow();

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
        app.dock.hide();
        this.hideTray();

        // Focus the window directly without calling .show() 
        // (.show() can cause macOS to re-register the dock icon)
        if (targetFocusWindow && !targetFocusWindow.isDestroyed()) {
          targetFocusWindow.focus();
        }
      } else {
        console.log('[Stealth] Calling app.dock.show()');
        app.dock.show();
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
        }, 500)
      }
      if (isModelSelectorVisible) {
        this.scheduleDisguiseTimer(() => {
          this.modelSelectorWindowHelper.setIgnoreBlur(false);
        }, 500)
      }
    }
  }

  public getUndetectable(): boolean {
    return this.isUndetectable
  }

  public setConsciousModeEnabled(enabled: boolean): boolean {
    if (this.consciousModeEnabled === enabled) {
      return true
    }

    const persisted = SettingsManager.getInstance().set('consciousModeEnabled', enabled)
    if (!persisted) {
      throw new Error('Unable to persist Conscious Mode')
    }

    this.consciousModeEnabled = enabled
    this.intelligenceManager.setConsciousModeEnabled(enabled)
    this._broadcastToAllWindows('conscious-mode-changed', enabled)
    return true
  }

public getConsciousModeEnabled(): boolean {
  return this.consciousModeEnabled
}

public setAccelerationModeEnabled(enabled: boolean): boolean {
  const settings = SettingsManager.getInstance()
  const previousEnabled = settings.getAccelerationModeEnabled()
  if (previousEnabled === enabled) {
    return true
  }

  const persisted = settings.set('accelerationModeEnabled', enabled)
  if (!persisted) {
    throw new Error('Unable to persist Acceleration Mode')
  }

  syncOptimizationFlagsFromSettings(settings.getAccelerationModeEnabled())
  this._broadcastToAllWindows('acceleration-mode-changed', enabled)
  return true
}

public getAccelerationModeEnabled(): boolean {
  return SettingsManager.getInstance().getAccelerationModeEnabled()
}

public setDisguise(mode: 'terminal' | 'settings' | 'activity' | 'none'): void {
    this.disguiseMode = mode;
    SettingsManager.getInstance().set('disguiseMode', mode);

    // Apply the disguise regardless of undetectable state
    // (disguise affects Activity Monitor name via process.title,
    //  dock icon only updates when NOT in stealth)
    this._applyDisguise(mode);
  }

  public applyInitialDisguise(): void {
    this._applyDisguise(this.disguiseMode);
  }

  private _applyDisguise(mode: 'terminal' | 'settings' | 'activity' | 'none'): void {
    let appName = "Natively";
    let iconPath = "";

    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    switch (mode) {
      case 'terminal':
        appName = isWin ? "Command Prompt " : "Terminal ";
        if (isWin) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/win/terminal.png")
            : path.join(app.getAppPath(), "assets/fakeicon/win/terminal.png");
        } else {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/mac/terminal.png")
            : path.join(app.getAppPath(), "assets/fakeicon/mac/terminal.png");
        }
        break;
      case 'settings':
        appName = isWin ? "Settings " : "System Settings ";
        if (isWin) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/win/settings.png")
            : path.join(app.getAppPath(), "assets/fakeicon/win/settings.png");
        } else {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/mac/settings.png")
            : path.join(app.getAppPath(), "assets/fakeicon/mac/settings.png");
        }
        break;
      case 'activity':
        appName = isWin ? "Task Manager " : "Activity Monitor ";
        if (isWin) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/win/activity.png")
            : path.join(app.getAppPath(), "assets/fakeicon/win/activity.png");
        } else {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/mac/activity.png")
            : path.join(app.getAppPath(), "assets/fakeicon/mac/activity.png");
        }
        break;
      case 'none':
        appName = "Natively";
        if (isMac) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "natively.icns")
            : path.join(app.getAppPath(), "assets/natively.icns");
        } else if (isWin) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/icons/win/icon.ico")
            : path.join(app.getAppPath(), "assets/icons/win/icon.ico");
        } else {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "icon.png")
            : path.join(app.getAppPath(), "assets/icon.png");
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
      app.setName(appName);
    }

    if (isMac) {
      process.env.CFBundleName = appName.trim();
    }

    // 3. Update App User Model ID (Windows Taskbar grouping)
    if (isWin) {
      // Use unique AUMID per disguise to avoid grouping with the real app
      app.setAppUserModelId(`com.natively.assistant.${mode}`);
    }

    // 4. Update Icons
    if (fs.existsSync(iconPath)) {
      const image = nativeImage.createFromPath(iconPath);

      if (isMac) {
        // Skip dock icon update when dock is hidden to avoid potential flicker
        if (!this.isUndetectable) {
          app.dock.setIcon(image);
        }
      } else {
        // Windows/Linux: Update all window icons
        this.windowHelper.getLauncherWindow()?.setIcon(image);
        this.windowHelper.getOverlayWindow()?.setIcon(image);
        this.settingsWindowHelper.getSettingsWindow()?.setIcon(image);
      }
    } else {
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
    this.clearDisguiseTimers()

    // Force periodic updates to ensure process title sticks
    const forceUpdate = () => {
      process.title = appName;
      // Only call app.setName when NOT in stealth — it causes dock to re-show
      if (isMac && !this.isUndetectable) {
        app.setName(appName);
      }
    };

    const scheduleUpdate = (ms: number) => {
      this.scheduleDisguiseTimer(() => {
        forceUpdate();
      }, ms)
    };

    scheduleUpdate(200);
    scheduleUpdate(1000);
    scheduleUpdate(5000);
  }

  // Helper: broadcast an IPC event to all windows
  private _broadcastToAllWindows(channel: string, ...args: any[]): void {
    const windows = [
      this.windowHelper.getMainWindow(),
      this.windowHelper.getLauncherWindow(),
      this.windowHelper.getOverlayWindow(),
      this.settingsWindowHelper.getSettingsWindow(),
      this.modelSelectorWindowHelper.getWindow(),
    ];
    const sent = new Set<number>();
    for (const win of windows) {
      if (win && !win.isDestroyed() && !sent.has(win.id)) {
        sent.add(win.id);
        win.webContents.send(channel, ...args);
      }
    }
  }

  public getDisguise(): string {
    return this.disguiseMode;
  }
}

// Application initialization

async function initializeApp() {
  // 2. Wait for app to be ready
  await app.whenReady()

  // 3. Set Content Security Policy headers for XSS protection
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': 
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' wasm-unsafe-eval; " +
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
  const appState = AppState.getInstance()

  // Explicitly load credentials into helpers
  appState.processingHelper.loadStoredCredentials();

  // Initialize IPC handlers before window creation
  initializeIpcHandlers(appState)

  // Apply the full disguise payload (names, dock icon, AUMID) early
  appState.applyInitialDisguise();

  app.whenReady().then(() => {
    // Start the Ollama lifecycle manager
    OllamaManager.getInstance().init().catch(console.error);

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

    console.log("App is ready")

    appState.createWindow()

    // Apply initial stealth state based on isUndetectable setting
    if (appState.getUndetectable()) {
      // Stealth mode: hide dock and tray
      if (process.platform === 'darwin') {
        app.dock.hide();
      }
    } else {
      // Normal mode: show dock and tray
      appState.showTray();
      if (process.platform === 'darwin') {
        app.dock.show();
      }
    }
    // Register global shortcuts using KeybindManager
    KeybindManager.getInstance().registerGlobalShortcuts()

    // Pre-create settings window in background for faster first open
    appState.settingsWindowHelper.preloadWindow()

    // Initialize CalendarManager
    try {
      const { CalendarManager } = require('./services/CalendarManager');
      const calMgr = CalendarManager.getInstance();
      calMgr.init();

      calMgr.on('start-meeting-requested', (event: any) => {
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
    } catch (e) {
      console.error('[Main] Failed to initialize CalendarManager:', e);
    }

    // Recover unprocessed meetings (persistence check)
    appState.getIntelligenceManager().recoverUnprocessedMeetings().catch(err => {
      console.error('[Main] Failed to recover unprocessed meetings:', err);
    });


    // Note: We do NOT force dock show here anymore, respecting stealth mode.
  })

  app.on("activate", () => {
    console.log("App activated")
    if (process.platform === 'darwin') {
      if (!appState.getUndetectable()) {
        app.dock.show();
      }
    }
    
    // If no window exists, create it
    if (appState.getMainWindow() === null) {
      appState.createWindow()
    } else {
      // If the window exists but is hidden, clicking the dock icon should restore it
      if (!appState.isVisible()) {
        appState.toggleMainWindow();
      }
    }
  })

  // Quit when all windows are closed, except on macOS
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })

let isForceQuitting = false;

app.on("before-quit", async (e) => {
  if (isForceQuitting) return;

  e.preventDefault();
  console.log("[Main] App quitting, preventing default to ensure pending saves complete...");

  if (appState.getIsMeetingActive()) {
    console.log("[Main] Meeting active during quit, ending meeting before exit...");
    try {
      await appState.endMeeting();
    } catch (err) {
      console.error("[Main] Error ending meeting on quit:", err);
    }
  }

  console.log("App is quitting, cleaning up resources...");

  try {
    await appState.getIntelligenceManager()?.waitForPendingSaves(10000);
    console.log('[Main] All pending saves completed');
  } catch (err) {
    console.warn('[Main] Failed to wait for pending saves:', err);
  }

  await appState.cleanupForQuit();
  globalShortcut.unregisterAll();

  // Kill Ollama if we started it
  OllamaManager.getInstance().stop();

  try {
    const { CredentialsManager } = require('./services/CredentialsManager');
    CredentialsManager.getInstance().scrubMemory();
    appState.processingHelper.getLLMHelper().scrubKeys();
    console.log('[Main] Credentials scrubbed from memory on quit');
  } catch (err) {
    console.error('[Main] Failed to scrub credentials on quit:', err);
  }

  isForceQuitting = true;
  app.exit();
})



  // app.dock?.hide() // REMOVED: User wants Dock icon visible
  app.commandLine.appendSwitch("disable-background-timer-throttling")
}

// Start the application
initializeApp().catch(console.error)
