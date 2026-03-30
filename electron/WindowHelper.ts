
import { BrowserWindow, screen, app } from "electron"
import { AppState } from "./main"
import path from "node:path"
import { StealthManager } from "./stealth/StealthManager"
import { StealthRuntime } from "./stealth/StealthRuntime"

const isEnvDev = process.env.NODE_ENV === "development"
const isPackaged = app.isPackaged

console.log(`[WindowHelper] isEnvDev: ${isEnvDev}, isPackaged: ${isPackaged}`)

const isDev = isEnvDev && !isPackaged

const startUrl = isDev
  ? "http://localhost:5180"
  : `file://${path.join(app.getAppPath(), "dist/index.html")}`

export class WindowHelper {
  private launcherWindow: BrowserWindow | null = null
  private launcherContentWindow: BrowserWindow | null = null
  private overlayWindow: BrowserWindow | null = null
  private launcherRuntime: StealthRuntime | null = null
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

  // Initialize with explicit number type and 0 value
  private screenWidth: number = 0
  private screenHeight: number = 0

  // Movement variables (apply to active window)
  private step: number = 20
  private currentX: number = 0
  private currentY: number = 0
  private readonly stealthManager: StealthManager

  constructor(appState: AppState, stealthManager: StealthManager) {
    this.appState = appState
    this.stealthManager = stealthManager
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
      { win: this.overlayWindow, auxiliary: true },
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
        preload: path.join(__dirname, "preload.js"),
        scrollBounce: true,
        webSecurity: true,
      },
      show: false,
      skipTaskbar: this.contentProtection,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 14 },
      vibrancy: 'under-window',
      visualEffectState: 'followWindow',
      transparent: true,
      hasShadow: true,
      backgroundColor: "#00000000",
      focusable: true,
      resizable: true,
      movable: true,
      center: true,
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

    try {
      this.launcherRuntime = new StealthRuntime({
        stealthManager: this.stealthManager,
        startUrl: `${startUrl}?window=launcher`,
      })
      this.launcherWindow = this.launcherRuntime.createPrimaryStealthSurface(launcherSettings) as BrowserWindow
      this.launcherContentWindow = this.launcherRuntime.getContentWindow()
      console.log('[WindowHelper] StealthRuntime created successfully');
    } catch (err) {
      console.error('[WindowHelper] Failed to create BrowserWindow:', err);
      return;
    }

    this.launcherRuntime.applyStealth(this.contentProtection)

    this.launcherContentWindow?.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error(`[WindowHelper] did-fail-load: ${errorCode} ${errorDescription}`);
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
        preload: path.join(__dirname, "preload.js"),
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
      skipTaskbar: true, // Don't show separately in dock/taskbar
      hasShadow: false, // Prevent shadow from adding perceived size/artifacts
    }

    this.overlayWindow = new BrowserWindow(overlaySettings)
    this.applyStealth(this.overlayWindow, this.contentProtection, 'primary', true)

    if (process.platform === "darwin") {
      this.overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      this.overlayWindow.setHiddenInMissionControl(true)
      this.overlayWindow.setAlwaysOnTop(true, "floating")
    }
    this.setOverlayClickthrough(this.overlayClickthroughEnabled)

    this.overlayWindow.loadURL(`${startUrl}?window=overlay`).catch(e => {
      console.error('[WindowHelper] Failed to load Overlay URL:', e);
    })

    // --- 3. Startup Sequence ---
    this.launcherWindow.once('ready-to-show', () => {
      this.switchToLauncher()
      this.isWindowVisible = true
    })

    this.setupWindowListeners()
  }

  private setupWindowListeners(): void {
    if (!this.launcherWindow) return

    this.launcherWindow.on("move", () => {
      if (this.launcherWindow) {
        const bounds = this.launcherWindow.getBounds()
        this.launcherPosition = { x: bounds.x, y: bounds.y }
        this.appState.settingsWindowHelper.reposition(bounds)
      }
    })

    this.launcherWindow.on("resize", () => {
      if (this.launcherWindow) {
        const bounds = this.launcherWindow.getBounds()
        this.launcherSize = { width: bounds.width, height: bounds.height }
        this.appState.settingsWindowHelper.reposition(bounds)
      }
    })

      this.launcherWindow.on("closed", () => {
      this.launcherRuntime?.destroy()
      this.launcherRuntime = null
      this.launcherWindow = null
      this.launcherContentWindow = null
      // If launcher closes, we should probably quit app or close overlay
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.close()
      }
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
      return this.overlayWindow;
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
  public getCurrentWindowMode(): 'launcher' | 'overlay' { return this.currentWindowMode }

  public isVisible(): boolean {
    return this.isWindowVisible
  }

  public hideMainWindow(): void {
    // Hide BOTH
    this.launcherRuntime?.hide()
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
      const x = Math.floor(workArea.x + (workArea.width - targetWidth) / 2)
      const y = Math.floor(workArea.y + (workArea.height - 600) / 2)

      this.overlayWindow.setBounds({ x, y, width: targetWidth, height: targetHeight });

      if (process.platform === 'win32' && this.contentProtection) {
        // Opacity Shield: Show at 0 opacity first to prevent frame leak
        this.overlayWindow.setOpacity(0);
        this.overlayWindow.show();
        this.applyStealth(this.overlayWindow, true, 'primary', true);
        this.setOverlayClickthrough(this.overlayClickthroughEnabled)
        // Small delay to ensure Windows DWM processes the flag before making it opaque

        if (this.opacityTimeout) clearTimeout(this.opacityTimeout);
        this.opacityTimeout = setTimeout(() => {
          if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            this.overlayWindow.setOpacity(1);
            this.stealthManager.reapplyAfterShow(this.overlayWindow);
            if (!this.overlayClickthroughEnabled) {
              this.overlayWindow.focus();
            }
            this.overlayWindow.setAlwaysOnTop(true, "floating");
          }
        }, 60);
      } else {
        this.applyStealth(this.overlayWindow, this.contentProtection, 'primary', true);
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

    // Show Launcher FIRST
    if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
      if (process.platform === 'win32' && this.contentProtection) {
        // Opacity Shield: Show at 0 opacity first
        this.launcherWindow.setOpacity(0);
        this.launcherRuntime?.show();
        this.launcherRuntime?.applyStealth(true);

        if (this.opacityTimeout) clearTimeout(this.opacityTimeout);
        this.opacityTimeout = setTimeout(() => {
          if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
            this.launcherWindow.setOpacity(1);
            this.stealthManager.reapplyAfterShow(this.launcherWindow);
            this.launcherWindow.focus();
          }
        }, 60);
      } else {
        this.launcherRuntime?.applyStealth(this.contentProtection);
        this.launcherRuntime?.show();
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
