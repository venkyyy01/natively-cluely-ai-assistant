import { app, session, globalShortcut } from "electron"
import { AppState } from "./AppState"
import { initializeIpcHandlers } from "../ipcHandlers"
import { CredentialsManager } from "../services/CredentialsManager"
import { OllamaManager } from '../services/OllamaManager'
import { KeybindManager } from "../services/KeybindManager"
import { SettingsManager } from "../services/SettingsManager"
import { refreshLogFilePath } from './logging'
import { initRedactorWithUserDataPath } from '../stealth/logRedactor'
import { installConsoleRedactor } from '../stealth/consoleRedactor'
import {
  runPreReadyHealing,
  markSessionHealthy,
  markSessionEnding,
  wasPreviousSessionUnclean,
} from '../startup/StartupHealer'
import { validateIntegrity } from '../integrity/IntegrityValidator'
import { applyAdaptiveAcceleration } from '../config/optimizations'
import { createPermissionWizard } from '../permissions/PermissionWizard'

// Application initialization

export async function initializeApp() {
  // NAT-SELF-HEAL: run synchronous cleanup BEFORE app.whenReady()
  // so we can clear stale caches and kill zombie processes before
  // Electron starts its renderer compositor.
  const previousUnclean = wasPreviousSessionUnclean();
  if (previousUnclean) {
    console.warn('[Bootstrap] Previous session exited uncleanly. Running startup healing...');
  }
  const startupHealth = runPreReadyHealing();
  console.log('[Bootstrap] Startup health:', startupHealth);

  // T-004: Install console redactor early when strict protection is enabled
  if (process.env.NATIVELY_STRICT_PROTECTION === '1') {
    installConsoleRedactor();
  }

  // NAT-INTEGRITY: Validate native modules and critical TS imports before proceeding.
  // Must run before app.whenReady() to detect corrupted installations early.
  const integrity = await validateIntegrity();
  if (!integrity.success) {
    for (const err of integrity.errors) {
      console.error(`[Integrity] ${err}`);
    }
    console.error('[Bootstrap] Integrity validation failed. Exiting.');
    app.quit();
    return;
  }
  console.log(`[Integrity] Validated ${integrity.moduleCount} modules in ${integrity.durationMs}ms`);

  // NAT-ADAPTIVE: Apply hardware-based acceleration before Chromium init.
  // Command-line switches must be appended before app.whenReady() to take effect.
  const hardwareProfile = applyAdaptiveAcceleration();
  console.log(`[Bootstrap] Adaptive acceleration applied: ${hardwareProfile.tier} tier (${hardwareProfile.cpuCores} cores, ${hardwareProfile.ramGB}GB RAM)`);

  // 2. Wait for app to be ready
  await app.whenReady()

  refreshLogFilePath()

  // S-7: Initialize log redactor with userData path for dynamic redaction
  try {
    initRedactorWithUserDataPath(app.getPath('userData'));
  } catch {
    // Best effort - if initialization fails, static patterns still apply
  }

  // 3. Set Content Security Policy headers for XSS protection
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const connectSrc = process.env.NODE_ENV === 'development'
      ? "connect-src 'self' https: wss: ws:; "
      : "connect-src 'self'; ";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': 
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' wasm-unsafe-eval; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob: https:; " +
          "font-src 'self' data:; " +
          connectSrc +
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
  const { CredentialsManager: CredentialsManagerClass } = require('../services/CredentialsManager');
  CredentialsManagerClass.getInstance().init();

  // 4. Initialize State
  const appState = AppState.getInstance()
  appState.registerShutdownHooks()

  // Explicitly load credentials into helpers
  appState.processingHelper.loadStoredCredentials();
  // NAT-037: warm stream prompt cache at startup so first user request
  // doesn't pay prompt-cache build cost on the TTFT-critical path.
  void appState.processingHelper
    .getLLMHelper()
    .warmStreamChatPromptCache()
    .catch((error: unknown) => {
      console.warn('[Init] Stream prompt cache warmup skipped:', error);
    });

  // Initialize IPC handlers before window creation
  initializeIpcHandlers(appState)

  // Apply the full disguise payload (names, dock icon, AUMID) early
  appState.applyInitialDisguise();

  app.whenReady().then(async () => {
    // Set a generic user-agent so outbound HTTP does not announce "Electron"
    try {
      session.defaultSession.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
    } catch (uaError) {
      console.warn('[Init] Failed to set generic user-agent:', uaError);
    }

    // NAT-PERMISSIONS: Use PermissionWizard for first-launch flow and revocation detection.
    // Replaces the standalone microphone check with a comprehensive sequential wizard.
    if (process.platform === 'darwin') {
      const wizard = createPermissionWizard();
      if (wizard.shouldRunWizard()) {
        await wizard.runWizard();
      } else {
        await wizard.checkRevocations();
      }
    }
    
    // Start the Ollama lifecycle manager
    OllamaManager.getInstance().init().catch(console.error);

    // NOTE: CredentialsManager.init() and loadStoredCredentials() are already called
    // above before this block — do NOT call them again here to avoid double key-load.

    // Load stored Google Service Account path (for Speech-to-Text)
    const storedServiceAccountPath = CredentialsManager.getInstance().getGoogleServiceAccountPath();
    if (storedServiceAccountPath) {
      console.log("[Init] Loading stored Google Service Account path");
      appState.updateGoogleCredentials(storedServiceAccountPath);
    }

  console.log("App is ready")

  // Apply dock stealth BEFORE window creation to prevent visible window before protection
  if (appState.getUndetectable()) {
    if (process.platform === 'darwin') {
      app.dock.hide();
      // BLUR-PROOF (macOS Phase 2): apply 'accessory' activation policy at
      // startup too so the very first window the OS sees is non-activating.
      try {
        app.setActivationPolicy?.('accessory');
      } catch (err) {
        console.warn('[bootstrap] setActivationPolicy(accessory) failed:', err);
      }
    }
  }

  appState.createWindow()

  // Apply Windows taskbar hide after window creation when stealth is persisted
  if (appState.getUndetectable() && process.platform === 'win32') {
    // Re-apply stealth state to ensure Windows taskbar hide runs after window exists
    appState.setUndetectable(true);
  }

  // Cursor stealth: re-apply the persisted user choice after the overlay
  // window exists. This is opt-in (off by default) and triggers the OS
  // Accessibility prompt the first time the user enables it. We do this
  // after createWindow() so the WindowHelper's overlay BrowserWindow is
  // constructed and the controller can attach lifecycle listeners.
  try {
    const cursorEnabledFromSettings =
      SettingsManager.getInstance().get('cursorHookEnabled') ?? false;
    if (cursorEnabledFromSettings) {
      // setCursorHookEnabled(true) returns false if the OS permission was
      // revoked between sessions or the native binding is missing. We log
      // the silent-degraded outcome so diagnostics show why the cursor
      // freeze isn't active even though Settings shows it as enabled.
      // The Settings UI separately polls getCursorHookStatus on mount and
      // surfaces a "permission needed" hint to the user.
      const installed = appState.getWindowHelper().setCursorHookEnabled(true);
      if (!installed) {
        console.warn(
          '[bootstrap] Cursor stealth was enabled in settings but native hook did not install (likely Accessibility permission denied or native module missing). User-facing toggle will display "permission needed" until the user re-enables.',
        );
      }
    }
  } catch (err) {
    console.warn('[bootstrap] Failed to restore cursor hook setting:', err);
  }

  // NAT-SELF-HEAL: window created and renderer bridge is on its way.
  // Mark session healthy so the next startup doesn't aggressively clear caches.
  markSessionHealthy();

  // Apply initial stealth state based on isUndetectable setting
  if (appState.getUndetectable()) {
    // Stealth mode: dock already hidden above
  } else {
    // Normal mode: show dock and tray
    appState.showTray();
    if (process.platform === 'darwin') {
      app.dock.show();
    }
  }
    // Register global shortcuts using KeybindManager.
    // If starting in stealth mode, use CGEventTap (invisible to proctoring)
    // instead of globalShortcut (visible to other apps).
    if (appState.getUndetectable()) {
      KeybindManager.getInstance().setStealthMode(true);
    }
    KeybindManager.getInstance().registerGlobalShortcuts()

    // Pre-create settings window in background for faster first open
    appState.settingsWindowHelper.preloadWindow()

    // Initialize CalendarManager
    try {
      const { CalendarManager } = require('../services/CalendarManager');
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

    // Hard deadline: if cleanup hangs (e.g. endMeeting() or waitForPendingSaves),
    // force-exit so ONNX sessions are not left alive for the system to SIGKILL.
    const QUIT_DEADLINE_MS = 12000;
    const quitDeadline = setTimeout(() => {
      console.error(`[Main] Quit cleanup exceeded ${QUIT_DEADLINE_MS}ms hard deadline, forcing exit`);
      isForceQuitting = true;
      app.exit();
    }, QUIT_DEADLINE_MS);
    quitDeadline.unref();

    if (appState.getIsMeetingActive()) {
      console.log("[Main] Meeting active during quit, ending meeting before exit...");
      try {
        await appState.endMeeting();
      } catch (err) {
        console.error("[Main] Error ending meeting on quit:", err);
      }
    }

    console.log("App is quitting, cleaning up resources...");

    // NAT-SELF-HEAL: mark that we're shutting down cleanly.
    // If we crash after this point, the next startup will still see unclean.
    markSessionEnding();

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
      const { CredentialsManager: CredMgr } = require('../services/CredentialsManager');
      CredMgr.getInstance().scrubMemory();
      console.log('[Main] Credentials scrubbed from memory on quit');
    } catch (err) {
      console.error('[Main] Failed to scrub credentials on quit:', err);
    }

    clearTimeout(quitDeadline);
    isForceQuitting = true;
    app.exit();
  })



  // app.dock?.hide() // REMOVED: User wants Dock icon visible
  app.commandLine.appendSwitch("disable-background-timer-throttling")
}
