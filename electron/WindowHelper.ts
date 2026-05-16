
import { BrowserWindow, screen, app } from "electron"
import { AppState } from "./main"
import path from "node:path"
import { StealthManager } from "./stealth/StealthManager"
import { StealthRuntime } from "./stealth/StealthRuntime"
import { CursorHookController } from "./stealth/CursorHookController"
import { attachRendererBridgeMonitor } from "./runtime/rendererBridgeHealth"
import { resolveRendererPreloadPath, resolveRendererStartUrl } from "./runtime/windowAssetPaths"
import { attachRevealSafetyNet, attachWindowCrashRecovery } from "./startup/rendererBridgeRecovery"
import { recordStartupFailure } from "./startup/StartupHealer"
import type { ProtectionEventType } from "./stealth/protectionStateTypes"
import { StartupProtectionGate, type StartupProtectionGateDecision } from "./stealth/StartupProtectionGate"
import type { VisibilityIntent } from "./stealth/privacyShieldState"

type ProtectionEventRecorder = {
  recordProtectionEvent?: (
    type: ProtectionEventType,
    context?: {
      source?: string
      windowRole?: 'primary' | 'auxiliary' | 'unknown'
      windowId?: string
      visible?: boolean
    },
  ) => void
  requestWindowShow?: (
    win: BrowserWindow | null | undefined,
    context: { source: string; windowRole?: 'primary' | 'auxiliary' | 'unknown' },
  ) => void
  requestWindowHide?: (
    win: BrowserWindow | null | undefined,
    context: { source: string; windowRole?: 'primary' | 'auxiliary' | 'unknown' },
  ) => void
  setWindowOpacity?: (
    win: BrowserWindow | null | undefined,
    value: number,
    context: { source: string; windowRole?: 'primary' | 'auxiliary' | 'unknown' },
  ) => void
  verifyManagedWindows?: () => boolean
}

type BrowserWindowOptionsWithContentProtection = Electron.BrowserWindowConstructorOptions & {
  contentProtection?: boolean
}

console.log(`[WindowHelper] isEnvDev: ${process.env.NODE_ENV === "development"}, isPackaged: ${app.isPackaged}`)

export class WindowHelper {
  private launcherWindow: BrowserWindow | null = null
  private launcherContentWindow: BrowserWindow | null = null
  private overlayWindow: BrowserWindow | null = null
  private overlayContentWindow: BrowserWindow | null = null
  private launcherRuntime: StealthRuntime | null = null
  private overlayRuntime: StealthRuntime | null = null
  private isWindowVisible: boolean = false
  // Position/Size tracking for Launcher
  private launcherPosition: { x: number; y: number } | null = null
  private launcherSize: { width: number; height: number } | null = null
  // Track current window mode (persists even when overlay is hidden via Cmd+B)
  private currentWindowMode: 'launcher' | 'overlay' = 'launcher'

  private appState: AppState
  private contentProtection: boolean = false
  private overlayClickthroughEnabled: boolean = false
  private opacityTimeout: NodeJS.Timeout | null = null
  private readonly overlayContentProtection: boolean = true
  private directLauncherLoaded: boolean = false
  private pendingDirectLauncherReveal: boolean = false
  private detachDirectLauncherBridgeMonitor: (() => void) | null = null
  private detachDirectOverlayBridgeMonitor: (() => void) | null = null
  private overlayPositionInitialized: boolean = false
  // BLUR-PROOF: Whether the overlay is allowed to receive native foreground
  // activation. Default false on win32 + darwin so clicking the overlay does
  // NOT promote the Electron app to foreground (which would fire `blur` on
  // any focused browser tab — the canonical proctoring detection signal).
  // Toggle to `true` only when the user is actively typing into the overlay.
  private overlayInteractive: boolean = false
  // Cached HWND buffer so we can clear the WS_EX_NOACTIVATE bits on dispose
  // without having to read getNativeWindowHandle on a destroyed BrowserWindow.
  private overlayHwndBuffer: Buffer | null = null
  // CURSOR-FREEZE (macOS only): controls the CGEventTap-based hardware
  // cursor freeze. Lifecycle: created lazily on the first enable call after
  // the overlay window exists. Persists across overlay show/hide cycles.
  private cursorController: CursorHookController | null = null
  private cursorHookEnabled: boolean = false

  // Initialize with explicit number type and 0 value
  private screenWidth: number = 0
  private screenHeight: number = 0

  // Movement variables (apply to active window)
  private step: number = 20
  private currentX: number = 0
  private currentY: number = 0
  private readonly stealthManager: StealthManager
  private readonly startupProtectionGate: StartupProtectionGate
  private stealthHeartbeatListener: (() => void) | null = null
  private stealthReadyPromise: Promise<void>
  private stealthReadyResolve: (() => void) | null = null

  constructor(appState: AppState, stealthManager: StealthManager) {
    this.appState = appState
    this.stealthManager = stealthManager
    this.startupProtectionGate = new StartupProtectionGate({
      logger: console,
      isStrictProtectionEnabled: () => process.env.NATIVELY_STRICT_PROTECTION === '1',
      verifyProtection: () => this.verifyStartupProtection(),
      recordProtectionEvent: (type, context) => {
        const recorder = this.stealthManager as ProtectionEventRecorder
        return recorder.recordProtectionEvent?.(type, context)
      },
      onBlocked: (decision) => this.handleStartupRevealBlocked(decision),
      waitForStealthReady: () => this.waitForStealthReady(),
    })

    // Gate: stealthReadyPromise resolves only after StealthManager has fully
    // initialized and verified native module availability. If stealth is
    // disabled (not in undetectable mode), resolve immediately.
    if (!this.stealthManager.isEnabled?.()) {
      this.stealthReadyPromise = Promise.resolve()
    } else {
      this.stealthReadyPromise = new Promise<void>((resolve) => {
        this.stealthReadyResolve = resolve
      })

      // Safety timeout: don't block the app forever if stealth initialization
      // takes too long. Resolve after 5 seconds with a warning log.
      const timeoutMs = parseInt(process.env.NATIVELY_STEALTH_READY_TIMEOUT_MS || '5000', 10)
      setTimeout(() => {
        if (this.stealthReadyResolve) {
          console.warn(
            `[WindowHelper] stealthReadyPromise timed out after ${timeoutMs}ms — resolving anyway to avoid blocking the app`
          )
          this.stealthReadyResolve()
          this.stealthReadyResolve = null
        }
      }, timeoutMs)
    }
  }

  /**
   * Called by bootstrap code after StealthManager has fully initialized and
   * verified native module availability. Resolves the stealthReadyPromise gate
   * so that window creation can proceed safely.
   */
  public markStealthReady(): void {
    if (this.stealthReadyResolve) {
      this.stealthReadyResolve()
      this.stealthReadyResolve = null
    }
  }

  /**
   * Returns a promise that resolves once StealthManager is fully initialized.
   * Used by window creation code to ensure stealth protection is ready before
   * making windows visible.
   */
  public waitForStealthReady(): Promise<void> {
    return this.stealthReadyPromise
  }

  public setStealthRuntimeHeartbeatListener(listener: (() => void) | null): void {
    this.stealthHeartbeatListener = listener
  }

  private shouldUseStealthRuntime(): boolean {
    return process.platform !== "darwin" || process.env.NATIVELY_FORCE_STEALTH_RUNTIME === "1";
  }

  private applyLauncherSurfaceProtection(): void {
    if (this.launcherRuntime) {
      this.launcherRuntime.applyStealth(this.contentProtection)
      return
    }

    if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
      this.applyStealth(this.launcherWindow, this.contentProtection, 'primary', this.shouldHidePrimaryFromSwitcher(this.contentProtection))
    }
  }

  private applyOverlaySurfaceProtection(): void {
    if (this.overlayRuntime) {
      this.overlayRuntime.applyStealth(this.contentProtection)
      return
    }

    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.applyStealth(this.overlayWindow, this.contentProtection, 'primary', this.shouldHidePrimaryFromSwitcher(this.contentProtection))
    }
  }

  private shouldHidePrimaryFromSwitcher(enable: boolean = this.contentProtection): boolean {
    const appState = this.appState as unknown as { getUndetectable?: () => boolean }
    return enable || appState.getUndetectable?.() === true
  }

  private recordProtectionEvent(
    type: ProtectionEventType,
    win: BrowserWindow | null,
    source: string,
    windowRole: 'primary' | 'auxiliary' | 'unknown' = 'primary',
  ): void {
    if (!win || win.isDestroyed()) {
      return
    }

    let windowId: string | undefined
    try {
      windowId = win.getMediaSourceId?.()
    } catch {
      windowId = undefined
    }

    const recorder = this.stealthManager as ProtectionEventRecorder
    recorder.recordProtectionEvent?.(type, {
      source,
      windowRole,
      windowId,
      visible: typeof win.isVisible === 'function' ? win.isVisible() : undefined,
    })
  }

  /**
   * Verifies stealth protection on a window before allowing it to become visible.
   * Returns true if the window is safe to show, false if it should remain hidden.
   *
   * When verification fails:
   * - The window is kept hidden
   * - A 'verification-failed' protection event is emitted
   * - A fault event is recorded for diagnostics
   */
  private verifyProtectionBeforeShow(
    win: BrowserWindow | null,
    source: string,
    windowRole: 'primary' | 'auxiliary' | 'unknown' = 'primary',
  ): boolean {
    // Skip verification if stealth is not enabled or window is invalid
    if (!win || win.isDestroyed() || !this.stealthManager.isEnabled?.()) {
      return true
    }

    // Verify stealth protection including SCK exclusion on the window
    const verified = this.stealthManager.verifyStealth(win)
    if (!verified) {
      this.recordProtectionEvent('verification-failed', win, source, windowRole)
      if (this.canRevealAfterObserveOnlyProtectionFailure()) {
        console.warn(
          `[WindowHelper] Protection verification failed before show — observe-only reveal allowed for visible controls (source: ${source})`
        )
        return true
      }

      // Keep window hidden — do NOT show it in strict/faulted shield states.
      console.warn(
        `[WindowHelper] Protection verification failed before show — window remains hidden (source: ${source})`
      )
      return false
    }

    return true
  }

  private canRevealAfterObserveOnlyProtectionFailure(): boolean {
    if (process.env.NATIVELY_STRICT_PROTECTION === '1') {
      return false
    }

    const appState = this.appState as unknown as {
      getUndetectable?: () => boolean
      getVisibilityIntent?: () => VisibilityIntent
    }
    const intent = typeof appState.getVisibilityIntent === 'function'
      ? appState.getVisibilityIntent()
      : 'visible_app'

    if (intent === 'visible_app' || intent === 'visible_safe_controls') {
      return true
    }

    // A faulted privacy shield should hide sensitive renderer content, not the
    // whole local control surface. Keeping the window visible lets the user
    // recover/disable stealth while strict mode still fails closed above.
    return intent === 'faulted_shield' && appState.getUndetectable?.() === true
  }

  private requestWindowShow(
    win: BrowserWindow | null,
    source: string,
    windowRole: 'primary' | 'auxiliary' | 'unknown' = 'primary',
  ): void {
    // S-RACE-3: Verify stealth protection before allowing the window to become visible.
    // If verification fails, the window stays hidden and a fault event is emitted.
    if (!this.verifyProtectionBeforeShow(win, source, windowRole)) {
      return
    }

    const manager = this.stealthManager as ProtectionEventRecorder
    if (manager.requestWindowShow) {
      manager.requestWindowShow(win, { source, windowRole })
      return
    }

    this.recordProtectionEvent('show-requested', win, source, windowRole)
    win?.show()
    this.recordProtectionEvent('shown', win, source, windowRole)
  }

  private requestWindowHide(
    win: BrowserWindow | null,
    source: string,
    windowRole: 'primary' | 'auxiliary' | 'unknown' = 'primary',
  ): void {
    const manager = this.stealthManager as ProtectionEventRecorder
    if (manager.requestWindowHide) {
      manager.requestWindowHide(win, { source, windowRole })
      return
    }

    this.recordProtectionEvent('hide-requested', win, source, windowRole)
    win?.hide()
    this.recordProtectionEvent('hidden', win, source, windowRole)
  }

  private setWindowOpacity(
    win: BrowserWindow | null,
    value: number,
    source: string,
    windowRole: 'primary' | 'auxiliary' | 'unknown' = 'primary',
  ): void {
    const manager = this.stealthManager as ProtectionEventRecorder
    if (manager.setWindowOpacity) {
      manager.setWindowOpacity(win, value, { source, windowRole })
      return
    }

    win?.setOpacity(value)
  }

  private showLauncherSurface(): void {
    if (this.launcherRuntime) {
      this.launcherRuntime.show()
      return
    }

    this.requestWindowShow(this.launcherWindow, 'WindowHelper.showLauncherSurface')
    this.launcherWindow?.focus()
  }

  private hideLauncherSurface(): void {
    if (this.launcherRuntime) {
      this.launcherRuntime.hide()
      return
    }

    this.requestWindowHide(this.launcherWindow, 'WindowHelper.hideLauncherSurface')
  }

  /**
   * Creates a BrowserWindow with stealth protection applied synchronously.
   *
   * IMPORTANT: The window is always created hidden (`show: false` is enforced
   * regardless of the caller's options). Callers MUST await
   * `waitForStealthReady()` before making the window visible (via `show()`,
   * `setOpacity(1)`, or any other visibility mechanism). This ensures the
   * StealthManager has fully initialized and applied all protection layers
   * (Layer 0 + SCK exclusion on macOS 15+) before the window can be observed
   * by screen-capture tools.
   */
  private createDirectWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
    // S-RACE-2: Force show: false to guarantee the window is born hidden.
    // Even if callers pass show: true, we override it here to prevent any
    // possibility of the window becoming visible before stealth is applied.
    const win = new BrowserWindow({
      ...options,
      show: false,
      skipTaskbar: Boolean(options.skipTaskbar) || this.shouldHidePrimaryFromSwitcher(this.contentProtection),
    })
    // S-RACE-1: apply Layer-0 capture protection synchronously, before any
    // loadURL or show call can run. This closes the "born unprotected" race
    // where the window briefly existed in the OS window list without
    // setContentProtection / sharingType=.none. Subsequent applyStealth /
    // applyContentProtection calls re-assert the same state idempotently.
    this.stealthManager.applyInitialStealth(win, {
      role: 'primary',
      hideFromSwitcher: this.shouldHidePrimaryFromSwitcher(this.contentProtection),
      allowVirtualDisplayIsolation: true,
    })
    this.recordProtectionEvent('window-created', win, 'WindowHelper.createDirectWindow', 'unknown')
    return win
  }

  private loadDirectWindow(win: BrowserWindow, url: string, label: string): void {
    void win.loadURL(url).catch((error) => {
      console.error(`[WindowHelper] ${label} direct load failed:`, error)
    })
  }

  private shouldStartRendererShielded(): boolean {
    const appState = this.appState as unknown as { shouldStartRendererShielded?: () => boolean }
    return typeof appState.shouldStartRendererShielded === 'function'
      ? appState.shouldStartRendererShielded()
      : false
  }

  private getStartupVisibilityIntent(): VisibilityIntent {
    const appState = this.appState as unknown as { getVisibilityIntent?: () => VisibilityIntent }
    if (typeof appState.getVisibilityIntent === 'function') {
      return appState.getVisibilityIntent()
    }

    return this.shouldStartRendererShielded() ? 'protected_shield' : 'visible_app'
  }

  private verifyStartupProtection(): boolean {
    const manager = this.stealthManager as ProtectionEventRecorder
    if (typeof manager.verifyManagedWindows !== 'function') {
      return false
    }

    return manager.verifyManagedWindows()
  }

  private handleStartupRevealBlocked(decision: StartupProtectionGateDecision): void {
    this.pendingDirectLauncherReveal = false
    const appState = this.appState as unknown as {
      setPrivacyShieldFault?: (key: string, reason: string) => void
    }
    const reason = decision.reason === 'startup-verification-timeout'
      ? 'Startup privacy protection verification timed out; sensitive content remains hidden.'
      : 'Startup privacy protection could not be verified; sensitive content remains hidden.'

    if (typeof appState.setPrivacyShieldFault === 'function') {
      appState.setPrivacyShieldFault('startup_protection_verification_failed', reason)
      return
    }

    this.hideMainWindow()
  }

  private async revealLauncherAfterStartupGate(source: string): Promise<void> {
    if (this.shouldStartRendererShielded()) {
      console.warn(`[WindowHelper] ${source}: staying protected instead of revealing launcher`)
      this.hideMainWindow()
      return
    }

    const decision = await this.startupProtectionGate.evaluateReveal({
      source,
      windowRole: 'primary',
      intent: this.getStartupVisibilityIntent(),
    })

    if (!decision.allowReveal) {
      return
    }

    this.switchToLauncher()
  }

  private buildRendererWindowUrl(baseUrl: string, windowKind: 'launcher' | 'overlay'): string {
    const separator = baseUrl.includes('?') ? '&' : '?'
    const privacyParam = this.shouldStartRendererShielded() ? '&privacyShield=1' : ''
    return `${baseUrl}${separator}window=${windowKind}${privacyParam}`
  }

  public setContentProtection(enable: boolean): void {
    this.contentProtection = enable
    this.applyContentProtection(enable)
  }

  public setSkipTaskbar(enable: boolean): void {
    this.launcherWindow?.setSkipTaskbar(enable);
    this.overlayWindow?.setSkipTaskbar(enable);
  }

  private applyStealth(win: BrowserWindow, enable: boolean, role: 'primary' | 'auxiliary', hideFromSwitcher: boolean): void {
    this.stealthManager.applyToWindow(win, enable, {
      role,
      hideFromSwitcher: role === 'primary' ? this.shouldHidePrimaryFromSwitcher(enable) : hideFromSwitcher,
      allowVirtualDisplayIsolation: true,
    });
  }

  /**
   * Lazily resolve the native module without paying the cost on every call.
   * Returns null if the native module is unavailable (e.g. dev environment
   * without the prebuilt binary). All callers guard for null.
   */
  private getNativeStealthModule(): {
    applyWindowsNoActivate?: (handle: Buffer) => void
    clearWindowsNoActivate?: (handle: Buffer) => void
  } | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('natively-audio')
    } catch {
      return null
    }
  }

  /**
   * Apply WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW to the overlay HWND on Windows.
   * Idempotent — safe to call repeatedly. The kernel of the Windows
   * "blur-proof" stealth: with these bits set, clicking the overlay does
   * NOT raise WM_ACTIVATEAPP and the underlying browser keeps focus.
   */
  private applyWindowsOverlayNoActivate(): void {
    if (process.platform !== 'win32') return
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return

    let handle: Buffer | undefined
    try {
      handle = this.overlayWindow.getNativeWindowHandle?.()
    } catch (err) {
      console.warn('[WindowHelper] getNativeWindowHandle failed for overlay:', err)
      return
    }
    if (!handle) return
    this.overlayHwndBuffer = handle

    const native = this.getNativeStealthModule()
    if (!native?.applyWindowsNoActivate) return
    try {
      native.applyWindowsNoActivate(handle)
    } catch (err) {
      console.warn('[WindowHelper] applyWindowsNoActivate failed:', err)
    }
  }

  /**
   * Reverse of applyWindowsOverlayNoActivate. Called when the overlay needs
   * to receive native focus on demand (typing into an input field) or when
   * the overlay is being destroyed.
   */
  private clearWindowsOverlayNoActivate(): void {
    if (process.platform !== 'win32') return
    const handle = this.overlayHwndBuffer
      ?? (this.overlayWindow && !this.overlayWindow.isDestroyed()
        ? this.overlayWindow.getNativeWindowHandle?.()
        : undefined)
    if (!handle) return

    const native = this.getNativeStealthModule()
    if (!native?.clearWindowsNoActivate) return
    try {
      native.clearWindowsNoActivate(handle)
    } catch (err) {
      console.warn('[WindowHelper] clearWindowsNoActivate failed:', err)
    }
  }

  private applyContentProtection(enable: boolean): void {
    const windows = [
      { win: this.launcherWindow, auxiliary: false },
      { win: this.overlayWindow, auxiliary: false },
    ]
    windows.forEach(({ win, auxiliary }) => {
      if (win && !win.isDestroyed()) {
        this.applyStealth(win, enable, auxiliary ? 'auxiliary' : 'primary', auxiliary);
      }
    });
  }

  public setWindowDimensions(width: number, height: number): void {
    const activeWindow = this.getVisibleMainWindow();
    if (!activeWindow || activeWindow.isDestroyed()) return

    const [currentX, currentY] = activeWindow.getPosition()
    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workAreaSize
    const maxAllowedWidth = Math.floor(workArea.width * 0.9)
    const newWidth = Math.min(width, maxAllowedWidth)
    const newHeight = Math.ceil(height)
    const maxX = workArea.width - newWidth
    const newX = Math.min(Math.max(currentX, 0), maxX)

    activeWindow.setBounds({
      x: newX,
      y: currentY,
      width: newWidth,
      height: newHeight
    })

    // Update internal tracking if it's launcher
    if (activeWindow === this.launcherWindow) {
      this.launcherSize = { width: newWidth, height: newHeight }
      this.launcherPosition = { x: newX, y: currentY }
    }
  }

  // Dedicated method for overlay window resizing - decoupled from launcher
  public setOverlayDimensions(width: number, height: number): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return
    console.log('[WindowHelper] setOverlayDimensions:', width, height);

    const [currentX, currentY] = this.overlayWindow.getPosition()
    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workAreaSize
    const maxAllowedWidth = Math.floor(workArea.width * 0.9)
    const maxAllowedHeight = Math.floor(workArea.height * 0.9)
    const newWidth = Math.min(Math.max(width, 300), maxAllowedWidth) // min 300, max 90%
    const newHeight = Math.min(Math.max(height, 1), maxAllowedHeight) // min 1, max 90%
    const maxX = workArea.width - newWidth
    const maxY = workArea.height - newHeight
    const newX = Math.min(Math.max(currentX, 0), maxX)
    const newY = Math.min(Math.max(currentY, 0), maxY)

    this.overlayWindow.setContentSize(newWidth, newHeight)
    this.overlayWindow.setPosition(newX, newY)
  }

  public setOverlayBounds(bounds: { width: number; height: number; x?: number; y?: number }): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return

    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workArea
    const maxAllowedWidth = Math.floor(workArea.width * 0.9)
    const maxAllowedHeight = Math.floor(workArea.height * 0.9)
    const width = Math.min(Math.max(bounds.width, 300), maxAllowedWidth)
    const height = Math.min(Math.max(bounds.height, 1), maxAllowedHeight)
    const currentBounds = this.overlayWindow.getBounds()
    const minX = workArea.x
    const minY = workArea.y
    const maxX = workArea.x + Math.max(0, workArea.width - width)
    const maxY = workArea.y + Math.max(0, workArea.height - height)
    const x = Math.min(Math.max(bounds.x ?? currentBounds.x, minX), maxX)
    const y = Math.min(Math.max(bounds.y ?? currentBounds.y, minY), maxY)

    this.overlayWindow.setBounds({ x, y, width, height })
    this.overlayPositionInitialized = true
  }

  public setOverlayClickthrough(enabled: boolean): void {
    this.overlayClickthroughEnabled = enabled
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return

    this.overlayWindow.setIgnoreMouseEvents(enabled, enabled ? { forward: true } : undefined)
    // BLUR-PROOF: focusability is owned by `overlayInteractive`, NOT by
    // clickthrough state. Forcing setFocusable(true) when clickthrough is
    // turned off would drop WS_EX_NOACTIVATE on Windows and re-enable
    // foreground activation on macOS NSPanel — both of which would fire
    // `blur` in the underlying browser. When clickthrough is enabled we
    // explicitly drop focusability (since clicks pass through anyway);
    // when it is disabled we honour `overlayInteractive`.
    if (enabled) {
      this.overlayWindow.setFocusable(false)
    } else {
      this.overlayWindow.setFocusable(this.overlayInteractive)
    }
    if (enabled) {
      this.overlayWindow.blur()
    }
    // Re-assert WS_EX_NOACTIVATE on Windows whenever clickthrough flips —
    // setIgnoreMouseEvents and setFocusable both touch the EX style.
    if (process.platform === 'win32' && !this.overlayInteractive) {
      this.applyWindowsOverlayNoActivate()
    }
  }

  public toggleOverlayClickthrough(): boolean {
    const next = !this.overlayClickthroughEnabled
    this.setOverlayClickthrough(next)
    return next
  }

  /**
   * Toggle the overlay between non-activating (default) and activating
   * (interactive) modes.
   *
   * Non-activating (interactive=false): clicking the overlay does NOT
   * promote the Electron app to foreground. macOS stays an NSPanel; on
   * Windows we keep WS_EX_NOACTIVATE asserted on the HWND. Browsers do
   * not fire `blur` / `focusout` / `hasFocus()→false` when the user
   * interacts with the overlay. This is the default and the behaviour
   * proctors should never see a deviation from.
   *
   * Activating (interactive=true): the overlay can take native focus so
   * HTML <input> elements inside it can receive keystrokes. Use this
   * sparingly — it WILL fire one blur event in the underlying browser.
   * The renderer should call this on the user's deliberate action
   * (focusing a chat input) and switch back to non-activating on Esc /
   * blur / submit.
   */
  public setOverlayInteractive(enabled: boolean): void {
    if (this.overlayInteractive === enabled) return
    this.overlayInteractive = enabled

    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return

    if (process.platform === 'win32') {
      // setFocusable on Windows is the runtime equivalent of toggling the
      // WS_EX_NOACTIVATE bit. Pair it with an explicit native style flip
      // because Electron's setFocusable does not always update the EX style.
      try {
        this.overlayWindow.setFocusable(enabled)
      } catch (err) {
        console.warn('[WindowHelper] setFocusable failed:', err)
      }
      if (enabled) {
        this.clearWindowsOverlayNoActivate()
      } else {
        this.applyWindowsOverlayNoActivate()
        // Drop any focus the renderer may have grabbed while interactive.
        try {
          this.overlayWindow.blur()
        } catch (err) {
          console.warn('[WindowHelper] blur failed:', err)
        }
      }
    }
    // macOS: NSPanel is permanently non-activating regardless of this flag.
    // The renderer can still focus inputs via first-responder routing on the
    // panel — the panel becomes key without activating the app.
  }

  public isOverlayInteractive(): boolean {
    return this.overlayInteractive
  }

  /**
   * Enable or disable the cursor freeze hook. When enabled and the
   * overlay is visible, the OS hardware cursor is frozen at the overlay's
   * boundary by a low-level cursor hook (CGEventTap on macOS, WH_MOUSE_LL
   * on Windows) and the renderer paints a software cursor in its place.
   * The software cursor lives entirely inside the capture-excluded
   * overlay surface, so screen-share captures only see the frozen
   * hardware cursor at the overlay edge.
   *
   * No-op on platforms other than macOS / Windows.
   *
   * Returns true if the controller is now installed (or was already);
   * false if the OS permission was denied or the native binding is
   * unavailable. Callers should surface that to the user with a clear
   * message ("Grant Accessibility permission to enable cursor stealth"
   * on macOS) rather than silently re-trying.
   */
  public setCursorHookEnabled(enabled: boolean): boolean {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return false
    this.cursorHookEnabled = enabled
    if (!enabled) {
      this.cursorController?.disable()
      return false
    }

    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
      // Defer until the overlay window is created. createWindow() will pick
      // up the cursorHookEnabled flag and call enable() then.
      return true
    }

    if (!this.cursorController) {
      this.cursorController = new CursorHookController(this.overlayWindow)
    }
    return this.cursorController.enable()
  }

  public isCursorHookEnabled(): boolean {
    return this.cursorHookEnabled && (this.cursorController?.isEnabled() ?? false)
  }

  /**
   * Whether the user has requested cursor stealth (regardless of whether
   * the native hook is currently installed — useful for showing a
   * "permission needed" hint in Settings).
   */
  public isCursorHookRequested(): boolean {
    return this.cursorHookEnabled
  }

  public createWindow(): void {
    if (this.launcherWindow !== null) return // Already created

    const startUrl = resolveRendererStartUrl({ electronDir: __dirname })
    const preloadPath = resolveRendererPreloadPath({ electronDir: __dirname })

    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workArea
    this.screenWidth = workArea.width
    this.screenHeight = workArea.height

    // Fixed dimensions per user request
    const width = 1200;
    const height = 800;

    // Calculate centered X, and top-centered Y (5% from top)
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    // Ensure y is at least workArea.y (don't go offscreen top)
    const topMargin = Math.round(workArea.height * 0.05);
    const y = Math.round(workArea.y + topMargin);
    const useStealthRuntime = this.shouldUseStealthRuntime();

// --- 1. Create Launcher Window ---
    // S-RACE-3: createWindow() stealth ordering guarantee.
    // Both launcher and overlay windows are created exclusively via
    // createDirectWindow() (non-StealthRuntime path) or
    // StealthRuntime.createPrimaryStealthSurface() (StealthRuntime path).
    // createDirectWindow() enforces show:false and calls
    // stealthManager.applyInitialStealth() synchronously before returning,
    // ensuring Layer 0 + SCK exclusion are applied BEFORE any loadURL or
    // show call. loadDirectWindow() (loadURL) is called only AFTER
    // createDirectWindow() returns. Window visibility is gated by
    // revealLauncherAfterStartupGate() which awaits StartupProtectionGate
    // verification. No code path in createWindow() can make a window
    // visible without stealth protection applied first.
    const launcherSettings: Electron.BrowserWindowConstructorOptions = {
    width: width,
    height: height,
    x: x,
    y: y,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: preloadPath,
      scrollBounce: true,
      webSecurity: true,
    },
    show: false,
    paintWhenInitiallyHidden: true,
    skipTaskbar: this.shouldHidePrimaryFromSwitcher(this.contentProtection),
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 14 },
      hasShadow: true,
      focusable: true,
      resizable: true,
      movable: true,
      center: true,
      ...(useStealthRuntime ? {
        vibrancy: 'under-window' as const,
        visualEffectState: 'followWindow' as const,
        transparent: true,
        backgroundColor: "#00000000",
      } : {
        transparent: false,
        backgroundColor: "#050505",
      }),
      icon: (() => {
        const isMac = process.platform === "darwin";
        const isWin = process.platform === "win32";
        const mode = this.appState.getDisguise();

        if (mode === 'none') {
          if (isMac) {
            return app.isPackaged
              ? path.join(process.resourcesPath, "natively.icns")
              : path.resolve(__dirname, "../../assets/natively.icns");
          } else if (isWin) {
            return app.isPackaged
              ? path.join(process.resourcesPath, "assets/icons/win/icon.ico")
              : path.resolve(__dirname, "../../assets/icons/win/icon.ico");
          } else {
            return app.isPackaged
              ? path.join(process.resourcesPath, "icon.png")
              : path.resolve(__dirname, "../../assets/icon.png");
          }
        }

        // Disguise mode icons
        let iconName = "terminal.png";
        if (mode === 'settings') iconName = "settings.png";
        if (mode === 'activity') iconName = "activity.png";

        const platformDir = isWin ? "win" : "mac";
        return app.isPackaged
          ? path.join(process.resourcesPath, `assets/fakeicon/${platformDir}/${iconName}`)
          : path.resolve(__dirname, `../../assets/fakeicon/${platformDir}/${iconName}`);
      })()
    }

    console.log(`[WindowHelper] Icon Path: ${launcherSettings.icon}`);
    console.log(`[WindowHelper] Start URL: ${startUrl}`);
    console.log(`[WindowHelper] Preload Path: ${preloadPath}`);

    if (useStealthRuntime) {
      try {
        this.launcherRuntime = new StealthRuntime({
          stealthManager: this.stealthManager,
          startUrl: this.buildRendererWindowUrl(startUrl, 'launcher'),
          onFault: (reason) => {
            this.appState.handleStealthRuntimeFault(reason)
          },
          onHeartbeat: () => {
            this.stealthHeartbeatListener?.()
          },
          onFirstFrame: () => {
            if (this.currentWindowMode === 'launcher') {
              void this.revealLauncherAfterStartupGate('WindowHelper.launcherRuntime.onFirstFrame')
            }
          },
        })
        this.launcherWindow = this.launcherRuntime.createPrimaryStealthSurface(launcherSettings) as BrowserWindow
        this.launcherContentWindow = this.launcherRuntime.getContentWindow()
        console.log('[WindowHelper] StealthRuntime created successfully');
      } catch (err) {
        console.error('[WindowHelper] Failed to create BrowserWindow:', err);
        return;
      }
} else {
this.launcherRuntime = null
this.directLauncherLoaded = false
this.pendingDirectLauncherReveal = true
this.detachDirectLauncherBridgeMonitor?.()
this.detachDirectLauncherBridgeMonitor = null
this.launcherWindow = this.createDirectWindow(launcherSettings)
// Start hidden to prevent black screen - show after content loads
this.setWindowOpacity(this.launcherWindow, 0, 'WindowHelper.createWindow.launcherInitial')
this.requestWindowHide(this.launcherWindow, 'WindowHelper.createWindow.launcherInitial')
this.launcherContentWindow = this.launcherWindow

      // NAT-SELF-HEAL: safety net — if bridge never settles, force reveal anyway
      let revealSafetyNet = attachRevealSafetyNet('Launcher', this.launcherWindow, () => {
        this.directLauncherLoaded = true
        this.pendingDirectLauncherReveal = false
        console.warn('[WindowHelper] Force-revealing launcher after safety-net timeout');
        void this.revealLauncherAfterStartupGate('WindowHelper.directLauncher.safetyNet')
      })

      this.detachDirectLauncherBridgeMonitor = attachRendererBridgeMonitor('Launcher', this.launcherWindow, {
        expectedPreloadPath: preloadPath,
        url: this.buildRendererWindowUrl(startUrl, 'launcher'),
        onSettled: (result) => {
          this.directLauncherLoaded = true
          revealSafetyNet.cancel()
          console.log(`[WindowHelper] Direct launcher bridge settled: ${result}`)

          if (!this.pendingDirectLauncherReveal || this.currentWindowMode !== 'launcher') {
            return
          }

          this.pendingDirectLauncherReveal = false
          void this.revealLauncherAfterStartupGate('WindowHelper.directLauncher.bridgeSettled')
        },
      })
      this.loadDirectWindow(this.launcherWindow, this.buildRendererWindowUrl(startUrl, 'launcher'), 'Launcher')
      console.log('[WindowHelper] Using direct launcher window on macOS');
    }

    this.applyLauncherSurfaceProtection()

    // NAT-SELF-HEAL: auto-reload on load failure instead of permanent black screen
    let launcherLoadFailures = 0;
    const MAX_LAUNCHER_LOAD_FAILURES = 2;
    this.launcherContentWindow?.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error(`[WindowHelper] did-fail-load: ${errorCode} ${errorDescription} URL: ${validatedURL}`);
      if (launcherLoadFailures < MAX_LAUNCHER_LOAD_FAILURES && this.launcherContentWindow && !this.launcherContentWindow.isDestroyed()) {
        launcherLoadFailures += 1;
        console.warn(`[WindowHelper] Auto-reloading launcher after load failure (${launcherLoadFailures}/${MAX_LAUNCHER_LOAD_FAILURES})`);
        this.launcherContentWindow.webContents.reloadIgnoringCache();
      } else {
        console.error('[WindowHelper] Launcher load failed permanently. Recording startup failure.');
        recordStartupFailure();
      }
    });

    this.launcherContentWindow?.webContents.on('did-finish-load', () => {
      console.log('[WindowHelper] Launcher content window did-finish-load');
      launcherLoadFailures = 0; // reset on success
    });

    this.launcherContentWindow?.webContents.on('dom-ready', () => {
      console.log('[WindowHelper] Launcher content window dom-ready');
    });

    // NAT-SELF-HEAL: crash recovery — recreate the window instead of leaving a dead frame
    if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
      attachWindowCrashRecovery('Launcher', this.launcherWindow, () => {
        console.warn('[WindowHelper] Recreating launcher window after crash');
        recordStartupFailure();
        if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
          this.launcherWindow.destroy();
        }
        this.launcherWindow = null;
        this.launcherContentWindow = null;
        this.createWindow();
      });
    }

    // if (isDev) {
    //   this.launcherWindow.webContents.openDevTools({ mode: 'detach' }); // DEBUG: Open DevTools
    // }

// --- 2. Create Overlay Window (Hidden initially) ---
  // S-RACE-3: Same stealth ordering guarantee as launcher (see comment above).
  // Overlay is created via createDirectWindow() or StealthRuntime, ensuring
  // stealth is applied synchronously before loadURL or show.
  //
  // BLUR-PROOF FOCUS HANDLING:
  //  - macOS: `type: 'panel'` builds the overlay as an NSPanel with the
  //    NSWindowStyleMaskNonactivatingPanel bit. Clicks and key events reach
  //    the panel without `[NSApp activate]` running, so any underlying
  //    browser tab keeps key-window status — no `blur` or `focusout` event
  //    fires in the page.
  //  - win32: `focusable: false` is the Electron primitive for
  //    WS_EX_NOACTIVATE. When passed at construction time Electron sets the
  //    extended style on the HWND. We additionally re-assert
  //    `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` via a native helper after the
  //    HWND exists, in case Electron drops the bits on a later setBounds /
  //    show. With those bits set, clicking the overlay does NOT promote
  //    Electron to the foreground app, so Chrome does not fire blur.
  const overlaySettings: Electron.BrowserWindowConstructorOptions = {
    width: 600,
    height: 1,
    minWidth: 300,
    minHeight: 1,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: preloadPath,
      scrollBounce: true,
    },
    show: false,
    frame: false, // Frameless
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    // win32: born non-activating. macOS: NSPanel still allows first-responder
    // for the in-window input field, so leave focusable: true there.
    focusable: process.platform === 'win32' ? this.overlayInteractive : true,
    resizable: true,
    movable: true,
    skipTaskbar: this.overlayContentProtection, // CRITICAL: Hide from taskbar when privacy protection is active
    hasShadow: false, // Prevent shadow from adding perceived size/artifacts
    // macOS only: tag the overlay as a panel so AppKit instantiates it as
    // NSPanel with NSWindowStyleMaskNonactivatingPanel. No effect on other
    // platforms (Electron ignores the field there).
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
  }

    if (useStealthRuntime) {
      try {
        this.overlayRuntime = new StealthRuntime({
          stealthManager: this.stealthManager,
          startUrl: this.buildRendererWindowUrl(startUrl, 'overlay'),
          onFault: (reason) => {
            this.appState.handleStealthRuntimeFault(reason)
          },
          onHeartbeat: () => {
            this.stealthHeartbeatListener?.()
          },
          onFirstFrame: () => {
            if (this.currentWindowMode === 'overlay' && this.isWindowVisible) {
              this.switchToOverlay()
            }
          },
        })
        this.overlayWindow = this.overlayRuntime.createPrimaryStealthSurface(overlaySettings) as BrowserWindow
        this.overlayContentWindow = this.overlayRuntime.getContentWindow()
        console.log('[WindowHelper] StealthRuntime (overlay) created successfully');
      } catch (err) {
        console.error('[WindowHelper] Failed to create overlay BrowserWindow:', err);
        this.launcherRuntime?.destroy()
        this.launcherRuntime = null
        this.launcherContentWindow = null
        this.launcherWindow = null
        this.overlayRuntime = null
        this.overlayContentWindow = null
        this.overlayWindow = null
        return;
      }
    } else {
      this.overlayRuntime = null
      this.detachDirectOverlayBridgeMonitor?.()
      this.detachDirectOverlayBridgeMonitor = null
      this.overlayWindow = this.createDirectWindow(overlaySettings)
      this.overlayContentWindow = this.overlayWindow

      // NAT-SELF-HEAL: overlay crash recovery
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        attachWindowCrashRecovery('Overlay', this.overlayWindow, () => {
          console.warn('[WindowHelper] Recreating overlay window after crash');
          if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            this.overlayWindow.destroy();
          }
          this.overlayWindow = null;
          this.overlayContentWindow = null;
          // Overlay will be recreated on next toggle
        });
      }

      this.detachDirectOverlayBridgeMonitor = attachRendererBridgeMonitor('Overlay', this.overlayWindow, {
        expectedPreloadPath: preloadPath,
        url: this.buildRendererWindowUrl(startUrl, 'overlay'),
      })
      this.loadDirectWindow(this.overlayWindow, this.buildRendererWindowUrl(startUrl, 'overlay'), 'Overlay')
      console.log('[WindowHelper] Using direct overlay window on macOS');
    }

    this.applyOverlaySurfaceProtection()

    if (process.platform === "darwin") {
      this.overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      this.overlayWindow.setAlwaysOnTop(true, "floating")
    }

    // BLUR-PROOF (Windows): re-assert WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW on
    // the HWND. Electron sets WS_EX_NOACTIVATE when `focusable: false` is
    // passed at construction, but the bit is sometimes dropped on subsequent
    // calls (setBounds, setIgnoreMouseEvents, show). Calling the native
    // helper here is idempotent and survives Electron's internal toggles.
    if (process.platform === 'win32' && !this.overlayInteractive) {
      this.applyWindowsOverlayNoActivate()
    }

    this.setOverlayClickthrough(this.overlayClickthroughEnabled)

    // CURSOR-FREEZE: if the user enabled the cursor hook before the overlay
    // existed, install it now. Otherwise the controller is created lazily on
    // the first setCursorHookEnabled(true) call.
    if (process.platform === 'darwin' && this.cursorHookEnabled && !this.overlayWindow.isDestroyed()) {
      if (!this.cursorController) {
        this.cursorController = new CursorHookController(this.overlayWindow)
      }
      this.cursorController.enable()
    }

    if (this.launcherRuntime) {
      console.log('[WindowHelper] Waiting for first launcher frame before showing stealth shell');
    }

    this.setupWindowListeners()
  }

  private setupWindowListeners(): void {
    const launcherWindow = this.launcherWindow
    if (!launcherWindow) return

    launcherWindow.on("move", () => {
      if (this.launcherWindow === launcherWindow) {
        const bounds = launcherWindow.getBounds()
        this.launcherPosition = { x: bounds.x, y: bounds.y }
        this.appState.settingsWindowHelper.reposition(bounds)
      }
    })

    launcherWindow.on("resize", () => {
      if (this.launcherWindow === launcherWindow) {
        const bounds = launcherWindow.getBounds()
        this.launcherSize = { width: bounds.width, height: bounds.height }
        this.appState.settingsWindowHelper.reposition(bounds)
      }
    })

      launcherWindow.on("closed", () => {
      if (this.launcherWindow !== launcherWindow) {
        return
      }
      this.launcherRuntime?.destroy()
      this.launcherRuntime = null
      this.detachDirectLauncherBridgeMonitor?.()
      this.detachDirectLauncherBridgeMonitor = null
      this.detachDirectOverlayBridgeMonitor?.()
      this.detachDirectOverlayBridgeMonitor = null
      this.launcherWindow = null
      this.launcherContentWindow = null
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        // Drop the no-activate bits before destroying the HWND so any
        // recreated overlay starts from a clean style state.
        this.clearWindowsOverlayNoActivate()
        this.overlayWindow.close()
      }
      this.overlayHwndBuffer = null
      // Tear down the cursor controller — its CGEventTap holds a reference
      // to the overlay window via the bounds-listeners. Calling disable()
      // detaches listeners and stops the tap thread cleanly.
      this.cursorController?.disable()
      this.cursorController = null
      this.overlayRuntime?.destroy()
      this.overlayRuntime = null
      this.overlayContentWindow = null
      this.overlayWindow = null
      this.isWindowVisible = false
    })

    // Listen for overlay close if independent closing acts as "Stop Meeting"
    if (this.overlayWindow) {
      this.overlayWindow.on('close', (e) => {
        // Prevent accidental closing via cmd+w if we want to enforce workflow? 
        // Or treat as end meeting. simpler to treat as hiding for now.
        if (this.isWindowVisible && this.overlayWindow?.isVisible()) {
          e.preventDefault();
          this.switchToLauncher();
          // Notify backend meeting ended? Handled via IPC ideally.
        }
      })
    }
  }

  // Helper to get whichever window should be treated as "Main" for IPC
  public getMainWindow(): BrowserWindow | null {
    if (this.currentWindowMode === 'overlay' && this.overlayWindow) {
      return this.overlayContentWindow || this.overlayWindow;
    }
    return this.launcherContentWindow;
  }

  public getVisibleMainWindow(): BrowserWindow | null {
    if (this.currentWindowMode === 'overlay' && this.overlayWindow) {
      return this.overlayWindow;
    }
    return this.launcherWindow;
  }

  // Specific getters if needed
  public getLauncherWindow(): BrowserWindow | null { return this.launcherWindow }
  public getLauncherContentWindow(): BrowserWindow | null { return this.launcherContentWindow }
  public getOverlayWindow(): BrowserWindow | null { return this.overlayWindow }
  public getOverlayContentWindow(): BrowserWindow | null { return this.overlayContentWindow || this.overlayWindow }
  public getCurrentWindowMode(): 'launcher' | 'overlay' { return this.currentWindowMode }

  public isVisible(): boolean {
    return this.isWindowVisible
  }

  public hideMainWindow(): void {
    // Hide BOTH
    this.pendingDirectLauncherReveal = false
    this.hideLauncherSurface()
    this.requestWindowHide(this.overlayWindow, 'WindowHelper.hideMainWindow.overlay')
    this.isWindowVisible = false
  }

  public showMainWindow(): void {
    // Show the window corresponding to the current mode
    if (this.currentWindowMode === 'overlay') {
      this.switchToOverlay();
    } else {
      this.switchToLauncher();
    }
  }

  public toggleMainWindow(): void {
    if (this.isWindowVisible) {
      this.hideMainWindow()
    } else {
      this.showMainWindow()
    }
  }

  public toggleOverlayWindow(): void {
    this.toggleMainWindow();
  }

  public centerAndShowWindow(): void {
    // Default to launcher
    this.switchToLauncher();
    this.launcherWindow?.center();
  }

  // --- Swapping Logic ---

  public switchToOverlay(): void {
    console.log('[WindowHelper] Switching to OVERLAY');
    this.currentWindowMode = 'overlay';

    // Show Overlay FIRST
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      const primaryDisplay = screen.getPrimaryDisplay()
      const workArea = primaryDisplay.workArea;
      const currentBounds = this.overlayWindow.getBounds();
      const targetWidth = Math.max(currentBounds.width, 600);
      const targetHeight = Math.max(currentBounds.height, 216);
      const maxX = workArea.x + Math.max(0, workArea.width - targetWidth)
      const maxY = workArea.y + Math.max(0, workArea.height - targetHeight)
      const centeredX = Math.floor(workArea.x + (workArea.width - targetWidth) / 2)
      const centeredY = Math.floor(workArea.y + (workArea.height - targetHeight) / 2)
      const desiredX = this.overlayPositionInitialized ? currentBounds.x : centeredX
      const desiredY = this.overlayPositionInitialized ? currentBounds.y : centeredY
      const x = Math.min(Math.max(desiredX, workArea.x), maxX)
      const y = Math.min(Math.max(desiredY, workArea.y), maxY)

      this.overlayWindow.setBounds({ x, y, width: targetWidth, height: targetHeight });
      this.overlayPositionInitialized = true

      if (process.platform === 'win32' && this.contentProtection) {
        // Opacity Shield: Show at 0 opacity first to prevent frame leak
        this.setWindowOpacity(this.overlayWindow, 0, 'WindowHelper.switchToOverlay.win32');
        this.requestWindowShow(this.overlayWindow, 'WindowHelper.switchToOverlay.win32');
        this.applyStealth(this.overlayWindow, true, 'primary', false);
        // Re-assert WS_EX_NOACTIVATE — applyStealth may toggle styles that
        // implicitly clear the bit. No-op when the user has explicitly
        // requested interactive mode (typing).
        if (!this.overlayInteractive) {
          this.applyWindowsOverlayNoActivate();
        }
        this.setOverlayClickthrough(this.overlayClickthroughEnabled)
        // Small delay to ensure Windows DWM processes the flag before making it opaque

    if (this.opacityTimeout) clearTimeout(this.opacityTimeout);
    // CRITICAL: Reduced from 60ms to 16ms (1 frame at 60fps) to prevent frame leaks during screen capture
    this.opacityTimeout = setTimeout(() => {
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.setWindowOpacity(this.overlayWindow, 1, 'WindowHelper.switchToOverlay.win32.restore');
        this.stealthManager.reapplyAfterShow(this.overlayWindow);
        // BLUR-PROOF: do NOT call .focus() in non-interactive mode — that
        // would force WM_ACTIVATEAPP and steal foreground from the browser.
        if (!this.overlayClickthroughEnabled && this.overlayInteractive) {
          this.overlayWindow.focus();
        }
        this.overlayWindow.setAlwaysOnTop(true, "floating");
        // Final re-assertion — Electron sometimes drops EX styles after
        // setOpacity transitions on Windows 11. Idempotent.
        if (!this.overlayInteractive) {
          this.applyWindowsOverlayNoActivate();
        }
      }
    }, 16);
      } else {
        this.applyStealth(this.overlayWindow, this.contentProtection, 'primary', false);
        // Re-assert WS_EX_NOACTIVATE on the non-content-protected Windows
        // path too — applyStealth may have touched styles.
        if (process.platform === 'win32' && !this.overlayInteractive) {
          this.applyWindowsOverlayNoActivate();
        }
        this.setOverlayClickthrough(this.overlayClickthroughEnabled)
        // STEALTH: Use showInactive() on macOS to prevent stealing focus from the
        // browser. The overlay appears on screen but Chrome keeps key-window status,
        // so proctoring scripts never see a blur event. The user can click the overlay
        // input field when they need to type — NSPanel focus doesn't activate the app.
        if (process.platform === 'darwin') {
          this.overlayWindow!.showInactive();
        } else {
          this.requestWindowShow(this.overlayWindow, 'WindowHelper.switchToOverlay')
        }
        this.stealthManager.reapplyAfterShow(this.overlayWindow);
        // Only call focus() when:
        //   - Linux/other (no blur-proof primitive available), OR
        //   - Windows AND the user has opted into interactive mode for typing
        // Never on macOS (NSPanel handles activation; calling focus() would
        // promote the app and trigger blur on the browser).
        if (!this.overlayClickthroughEnabled && process.platform !== 'darwin') {
          if (process.platform === 'win32') {
            if (this.overlayInteractive) {
              this.overlayWindow.focus();
            }
          } else {
            this.overlayWindow.focus();
          }
        }
        this.overlayWindow.setAlwaysOnTop(true, "floating");
      }
      this.isWindowVisible = true;
    }

    // Hide Launcher SECOND
    if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
      this.requestWindowHide(this.launcherWindow, 'WindowHelper.switchToOverlay.launcher')
    }
  }

  public switchToLauncher(): void {
    console.log('[WindowHelper] Switching to LAUNCHER');
    this.currentWindowMode = 'launcher';

    if (!this.launcherRuntime && !this.directLauncherLoaded) {
      console.log('[WindowHelper] Delaying launcher reveal until direct renderer load completes');
      this.pendingDirectLauncherReveal = true
      if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
        this.setWindowOpacity(this.launcherWindow, 0, 'WindowHelper.switchToLauncher.delay')
        this.requestWindowHide(this.launcherWindow, 'WindowHelper.switchToLauncher.delay')
      }
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.requestWindowHide(this.overlayWindow, 'WindowHelper.switchToLauncher.delayOverlay')
      }
      this.isWindowVisible = false
      return
    }

    // Show Launcher FIRST
    if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
      if (process.platform === 'win32' && this.contentProtection) {
        // Opacity Shield: Show at 0 opacity first
        this.setWindowOpacity(this.launcherWindow, 0, 'WindowHelper.switchToLauncher.win32');
        this.showLauncherSurface();
        if (this.launcherRuntime) {
          this.launcherRuntime.applyStealth(true);
        } else {
          this.applyStealth(this.launcherWindow, true, 'primary', false);
        }

    if (this.opacityTimeout) clearTimeout(this.opacityTimeout);
    // CRITICAL: Reduced from 60ms to 16ms (1 frame at 60fps) to prevent frame leaks during screen capture
    this.opacityTimeout = setTimeout(() => {
      if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
        this.setWindowOpacity(this.launcherWindow, 1, 'WindowHelper.switchToLauncher.win32.restore');
        this.stealthManager.reapplyAfterShow(this.launcherWindow);
        this.launcherWindow.focus();
      }
    }, 16);
      } else {
        if (!this.launcherRuntime) {
          this.setWindowOpacity(this.launcherWindow, 1, 'WindowHelper.switchToLauncher')
        }
        this.applyLauncherSurfaceProtection();
        this.showLauncherSurface();
        this.stealthManager.reapplyAfterShow(this.launcherWindow);
        this.launcherWindow.focus();
      }
      this.isWindowVisible = true;
    }

    // Hide Overlay SECOND
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.requestWindowHide(this.overlayWindow, 'WindowHelper.switchToLauncher.overlay')
    }
  }

  // Simplified setWindowMode that just calls switchers
  public setWindowMode(mode: 'launcher' | 'overlay'): void {
    if (mode === 'launcher') {
      this.switchToLauncher();
    } else {
      this.switchToOverlay();
    }
  }

  // --- Window Movement (Applies to Overlay mostly, but generalized to active) ---
  private moveActiveWindow(dx: number, dy: number): void {
    const win = this.getVisibleMainWindow();
    if (!win) return;

    const [x, y] = win.getPosition();
    win.setPosition(x + dx, y + dy);

    this.currentX = x + dx;
    this.currentY = y + dy;
  }

  public moveWindowRight(): void { this.moveActiveWindow(this.step, 0) }
  public moveWindowLeft(): void { this.moveActiveWindow(-this.step, 0) }
  public moveWindowDown(): void { this.moveActiveWindow(0, this.step) }
  public moveWindowUp(): void { this.moveActiveWindow(0, -this.step) }
}
