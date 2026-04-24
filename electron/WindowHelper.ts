
import { BrowserWindow, screen, app } from "electron"
import { AppState } from "./main"
import path from "node:path"
import { StealthManager } from "./stealth/StealthManager"
import { StealthRuntime } from "./stealth/StealthRuntime"
import { attachRendererBridgeMonitor } from "./runtime/rendererBridgeHealth"
import { resolveRendererPreloadPath, resolveRendererStartUrl } from "./runtime/windowAssetPaths"

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

  // Initialize with explicit number type and 0 value
  private screenWidth: number = 0
  private screenHeight: number = 0

  // Movement variables (apply to active window)
  private step: number = 20
  private currentX: number = 0
  private currentY: number = 0
  private readonly stealthManager: StealthManager
  private stealthHeartbeatListener: (() => void) | null = null

  constructor(appState: AppState, stealthManager: StealthManager) {
    this.appState = appState
    this.stealthManager = stealthManager
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
      this.applyStealth(this.launcherWindow, this.contentProtection, 'primary', false)
    }
  }

  private applyOverlaySurfaceProtection(): void {
    if (this.overlayRuntime) {
      this.overlayRuntime.applyStealth(this.contentProtection)
      return
    }

    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.applyStealth(this.overlayWindow, this.contentProtection, 'primary', false)
    }
  }

  private showLauncherSurface(): void {
    if (this.launcherRuntime) {
      this.launcherRuntime.show()
      return
    }

    this.launcherWindow?.show()
    this.launcherWindow?.focus()
  }

  private hideLauncherSurface(): void {
    if (this.launcherRuntime) {
      this.launcherRuntime.hide()
      return
    }

    this.launcherWindow?.hide()
  }

  private createDirectWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
    const win = new BrowserWindow(options)
    return win
  }

  private loadDirectWindow(win: BrowserWindow, url: string, label: string): void {
    void win.loadURL(url).catch((error) => {
      console.error(`[WindowHelper] ${label} direct load failed:`, error)
    })
  }

  public setContentProtection(enable: boolean): void {
    this.contentProtection = enable
    this.applyContentProtection(enable)
  }

  public setSkipTaskbar(enable: boolean): void {
    this.launcherWindow?.setSkipTaskbar(enable);
  }

  private applyStealth(win: BrowserWindow, enable: boolean, role: 'primary' | 'auxiliary', hideFromSwitcher: boolean): void {
    this.stealthManager.applyToWindow(win, enable, { role, hideFromSwitcher });
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

  public setOverlayClickthrough(enabled: boolean): void {
    this.overlayClickthroughEnabled = enabled
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return

    this.overlayWindow.setIgnoreMouseEvents(enabled, enabled ? { forward: true } : undefined)
    this.overlayWindow.setFocusable(!enabled)
    if (enabled) {
      this.overlayWindow.blur()
    }
  }

  public toggleOverlayClickthrough(): boolean {
    const next = !this.overlayClickthroughEnabled
    this.setOverlayClickthrough(next)
    return next
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
    skipTaskbar: this.contentProtection,
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
          startUrl: `${startUrl}?window=launcher`,
          onFault: (reason) => {
            this.appState.handleStealthRuntimeFault(reason)
          },
          onHeartbeat: () => {
            this.stealthHeartbeatListener?.()
          },
          onFirstFrame: () => {
            if (this.currentWindowMode === 'launcher') {
              this.switchToLauncher()
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
      this.launcherWindow.setOpacity(0)
      this.launcherWindow.hide()
      this.launcherContentWindow = this.launcherWindow
      this.detachDirectLauncherBridgeMonitor = attachRendererBridgeMonitor('Launcher', this.launcherWindow, {
        expectedPreloadPath: preloadPath,
        url: `${startUrl}?window=launcher`,
        onSettled: (result) => {
          this.directLauncherLoaded = true
          console.log(`[WindowHelper] Direct launcher bridge settled: ${result}`)

          if (!this.pendingDirectLauncherReveal || this.currentWindowMode !== 'launcher') {
            return
          }

          this.pendingDirectLauncherReveal = false
          this.switchToLauncher()
        },
      })
      this.loadDirectWindow(this.launcherWindow, `${startUrl}?window=launcher`, 'Launcher')
      console.log('[WindowHelper] Using direct launcher window on macOS');
    }

    this.applyLauncherSurfaceProtection()

    this.launcherContentWindow?.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error(`[WindowHelper] did-fail-load: ${errorCode} ${errorDescription} URL: ${validatedURL}`);
    });

    this.launcherContentWindow?.webContents.on('did-finish-load', () => {
      console.log('[WindowHelper] Launcher content window did-finish-load');
    });

    this.launcherContentWindow?.webContents.on('dom-ready', () => {
      console.log('[WindowHelper] Launcher content window dom-ready');
    });

    this.launcherContentWindow?.webContents.on('crashed', (_event, killed) => {
      console.error(`[WindowHelper] Launcher content window crashed (killed=${killed})`);
    });

    this.launcherContentWindow?.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[WindowHelper] Launcher render process gone: reason=${details.reason} exitCode=${details.exitCode}`);
    });

    // if (isDev) {
    //   this.launcherWindow.webContents.openDevTools({ mode: 'detach' }); // DEBUG: Open DevTools
    // }

// --- 2. Create Overlay Window (Hidden initially) ---
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
    focusable: true,
    resizable: true,
    movable: true,
    skipTaskbar: this.overlayContentProtection, // CRITICAL: Hide from taskbar when privacy protection is active
    hasShadow: false, // Prevent shadow from adding perceived size/artifacts
  }

    if (useStealthRuntime) {
      try {
        this.overlayRuntime = new StealthRuntime({
          stealthManager: this.stealthManager,
          startUrl: `${startUrl}?window=overlay`,
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
      this.detachDirectOverlayBridgeMonitor = attachRendererBridgeMonitor('Overlay', this.overlayWindow, {
        expectedPreloadPath: preloadPath,
        url: `${startUrl}?window=overlay`,
      })
      this.loadDirectWindow(this.overlayWindow, `${startUrl}?window=overlay`, 'Overlay')
      console.log('[WindowHelper] Using direct overlay window on macOS');
    }

    this.applyOverlaySurfaceProtection()

    if (process.platform === "darwin") {
      this.overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      this.overlayWindow.setAlwaysOnTop(true, "floating")
    }
    this.setOverlayClickthrough(this.overlayClickthroughEnabled)
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
        this.overlayWindow.close()
      }
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
    this.overlayWindow?.hide()
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
      // Reset overlay position to center or last known? 
      // For now, center it nicely
      const primaryDisplay = screen.getPrimaryDisplay()
      const workArea = primaryDisplay.workArea;
      const currentBounds = this.overlayWindow.getBounds();
      const targetWidth = Math.max(currentBounds.width, 600);
      const targetHeight = Math.max(currentBounds.height, 216);
      const centeredX = Math.floor(workArea.x + (workArea.width - targetWidth) / 2)
      const centeredY = Math.floor(workArea.y + (workArea.height - targetHeight) / 2)
      const maxX = workArea.x + Math.max(0, workArea.width - targetWidth)
      const maxY = workArea.y + Math.max(0, workArea.height - targetHeight)
      const x = Math.min(Math.max(centeredX, workArea.x), maxX)
      const y = Math.min(Math.max(centeredY, workArea.y), maxY)

      this.overlayWindow.setBounds({ x, y, width: targetWidth, height: targetHeight });

      if (process.platform === 'win32' && this.contentProtection) {
        // Opacity Shield: Show at 0 opacity first to prevent frame leak
        this.overlayWindow.setOpacity(0);
        this.overlayWindow.show();
        this.applyStealth(this.overlayWindow, true, 'primary', false);
        this.setOverlayClickthrough(this.overlayClickthroughEnabled)
        // Small delay to ensure Windows DWM processes the flag before making it opaque

    if (this.opacityTimeout) clearTimeout(this.opacityTimeout);
    // CRITICAL: Reduced from 60ms to 16ms (1 frame at 60fps) to prevent frame leaks during screen capture
    this.opacityTimeout = setTimeout(() => {
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.setOpacity(1);
        this.stealthManager.reapplyAfterShow(this.overlayWindow);
        if (!this.overlayClickthroughEnabled) {
          this.overlayWindow.focus();
        }
        this.overlayWindow.setAlwaysOnTop(true, "floating");
      }
    }, 16);
      } else {
        this.applyStealth(this.overlayWindow, this.contentProtection, 'primary', false);
        this.setOverlayClickthrough(this.overlayClickthroughEnabled)
        this.overlayWindow.show();
        this.stealthManager.reapplyAfterShow(this.overlayWindow);
        if (!this.overlayClickthroughEnabled) {
          this.overlayWindow.focus();
        }
        this.overlayWindow.setAlwaysOnTop(true, "floating");
      }
      this.isWindowVisible = true;
    }

    // Hide Launcher SECOND
    if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
      this.launcherWindow.hide();
    }
  }

  public switchToLauncher(): void {
    console.log('[WindowHelper] Switching to LAUNCHER');
    this.currentWindowMode = 'launcher';

    if (!this.launcherRuntime && !this.directLauncherLoaded) {
      console.log('[WindowHelper] Delaying launcher reveal until direct renderer load completes');
      this.pendingDirectLauncherReveal = true
      if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
        this.launcherWindow.setOpacity(0)
        this.launcherWindow.hide();
      }
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.hide();
      }
      this.isWindowVisible = false
      return
    }

    // Show Launcher FIRST
    if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
      if (process.platform === 'win32' && this.contentProtection) {
        // Opacity Shield: Show at 0 opacity first
        this.launcherWindow.setOpacity(0);
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
        this.launcherWindow.setOpacity(1);
        this.stealthManager.reapplyAfterShow(this.launcherWindow);
        this.launcherWindow.focus();
      }
    }, 16);
      } else {
        if (!this.launcherRuntime) {
          this.launcherWindow.setOpacity(1)
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
      this.overlayWindow.hide();
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
