import type { WindowHelper } from "./WindowHelper"
import type { SettingsWindowHelper } from "./SettingsWindowHelper"
import type { ModelSelectorWindowHelper } from "./ModelSelectorWindowHelper"
import type { StealthManager } from "./stealth/StealthManager"
import type { ScreenshotHelper } from "./ScreenshotHelper"
import type { ProcessingHelper } from "./ProcessingHelper"
import type { IntelligenceManager } from "./IntelligenceManager"
import type { ThemeManager } from "./ThemeManager"
import type { RAGManager } from "./rag/RAGManager"
import type { MeetingCheckpointer } from "./MeetingCheckpointer"
import type { STTReconnector } from "./STTReconnector"
import type { Tray } from "electron"

export class AppState {
  private static instance: AppState | null = null

  windowHelper: WindowHelper | null = null
  settingsWindowHelper: SettingsWindowHelper | null = null
  modelSelectorWindowHelper: ModelSelectorWindowHelper | null = null
  stealthManager: StealthManager | null = null
  screenshotHelper: ScreenshotHelper | null = null
  processingHelper: ProcessingHelper | null = null

  intelligenceManager: IntelligenceManager | null = null
  themeManager: ThemeManager | null = null
  ragManager: RAGManager | null = null
  knowledgeOrchestrator: unknown = null
  checkpointer: MeetingCheckpointer | null = null
  sttReconnector: STTReconnector | null = null
  virtualDisplayCoordinator: import('./stealth/MacosVirtualDisplayClient').VirtualDisplayCoordinator | null = null
  tray: Tray | null = null
  disguiseMode: 'terminal' | 'settings' | 'activity' | 'none' = 'none'
  consciousModeEnabled: boolean = false

  view: "queue" | "solutions" = "queue"
  isUndetectable: boolean = false

  problemInfo: {
    problem_statement: string
    input_format: Record<string, unknown>
    output_format: Record<string, unknown>
    constraints: Array<Record<string, unknown>>
    test_cases: Array<Record<string, unknown>>
  } | null = null

  hasDebugged: boolean = false
  isMeetingActive: boolean = false
  meetingLifecycleState: 'idle' | 'starting' | 'active' | 'stopping' = 'idle'
  meetingStartSequence = 0
  meetingStartMutex: Promise<void> = Promise.resolve()
  nativeAudioConnected: boolean = false
  private _disguiseTimers: NodeJS.Timeout[] = []

  private _ollamaBootstrapPromise: Promise<void> | null = null
  audioRecoveryAttempts: number = 0
  readonly MAX_AUDIO_RECOVERY_ATTEMPTS = 3
  audioRecoveryBackoffMs: number = 5000
  currentMeetingId: string | null = null
  startAbortController: AbortController | null = null

  public readonly PROCESSING_EVENTS = {
    UNAUTHORIZED: "procesing-unauthorized",
    NO_SCREENSHOTS: "processing-no-screenshots",
    INITIAL_START: "initial-start",
    PROBLEM_EXTRACTED: "problem-extracted",
    SOLUTION_SUCCESS: "solution-success",
    INITIAL_SOLUTION_ERROR: "solution-error",
    DEBUG_START: "debug-start",
    DEBUG_SUCCESS: "debug-success",
    DEBUG_ERROR: "debug-error"
  } as const

  static getInstance(): AppState {
    if (!AppState.instance) {
      throw new Error('AppState not initialized')
    }
    return AppState.instance
  }

  static setInstance(instance: AppState): void {
    AppState.instance = instance
  }

  clearDisguiseTimers(): void {
    for (const timer of this._disguiseTimers) {
      clearTimeout(timer)
    }
    this._disguiseTimers = []
  }

  trackDisguiseTimer(timer: NodeJS.Timeout): void {
    this._disguiseTimers.push(timer)
  }

  scheduleDisguiseTimer(callback: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      try {
        callback()
      } finally {
        this._disguiseTimers = this._disguiseTimers.filter(t => t !== timer)
      }
    }, delayMs)
    this.trackDisguiseTimer(timer)
  }
}
