import path from "node:path";
import { app, BrowserWindow, screen } from "electron";
import type { AppState } from "./main";
import { attachRendererBridgeMonitor } from "./runtime/rendererBridgeHealth";
import {
	resolveRendererPreloadPath,
	resolveRendererStartUrl,
} from "./runtime/windowAssetPaths";
import {
	attachRevealSafetyNet,
	attachWindowCrashRecovery,
} from "./startup/rendererBridgeRecovery";
import { recordStartupFailure } from "./startup/StartupHealer";
import type { VisibilityIntent } from "./stealth/privacyShieldState";
import type { ProtectionEventType } from "./stealth/protectionStateTypes";
import {
	StartupProtectionGate,
	type StartupProtectionGateDecision,
} from "./stealth/StartupProtectionGate";
import type { StealthManager } from "./stealth/StealthManager";
import { StealthRuntime } from "./stealth/StealthRuntime";
import type { ProtectionSnapshot } from "./stealth/protectionStateTypes";

type ProtectionEventRecorder = {
	recordProtectionEvent?: (
		type: ProtectionEventType,
		context?: {
			source?: string;
			windowRole?: "primary" | "auxiliary" | "unknown";
			windowId?: string;
			visible?: boolean;
		},
	) => ProtectionSnapshot | undefined;
	requestWindowShow?: (
		win: BrowserWindow | null | undefined,
		context: {
			source: string;
			windowRole?: "primary" | "auxiliary" | "unknown";
		},
	) => void;
	requestWindowHide?: (
		win: BrowserWindow | null | undefined,
		context: {
			source: string;
			windowRole?: "primary" | "auxiliary" | "unknown";
		},
	) => void;
	setWindowOpacity?: (
		win: BrowserWindow | null | undefined,
		value: number,
		context: {
			source: string;
			windowRole?: "primary" | "auxiliary" | "unknown";
		},
	) => void;
	verifyManagedWindows?: () => boolean;
};

console.log(
	`[WindowHelper] isEnvDev: ${process.env.NODE_ENV === "development"}, isPackaged: ${app.isPackaged}`,
);

export class WindowHelper {
	private launcherWindow: BrowserWindow | null = null;
	private launcherContentWindow: BrowserWindow | null = null;
	private overlayWindow: BrowserWindow | null = null;
	private overlayContentWindow: BrowserWindow | null = null;
	private launcherRuntime: StealthRuntime | null = null;
	private overlayRuntime: StealthRuntime | null = null;
	private isWindowVisible: boolean = false;
	// Track current window mode (persists even when overlay is hidden via Cmd+B)
	private currentWindowMode: "launcher" | "overlay" = "launcher";

	private appState: AppState;
	private contentProtection: boolean = false;
	private overlayClickthroughEnabled: boolean = false;
	private opacityTimeout: NodeJS.Timeout | null = null;
	private readonly overlayContentProtection: boolean = true;
	private directLauncherLoaded: boolean = false;
	private pendingDirectLauncherReveal: boolean = false;
	private detachDirectLauncherBridgeMonitor: (() => void) | null = null;
	private detachDirectOverlayBridgeMonitor: (() => void) | null = null;

	// Movement variables (apply to active window)
	private step: number = 20;
	private readonly stealthManager: StealthManager;
	private readonly startupProtectionGate: StartupProtectionGate;
	private stealthHeartbeatListener: (() => void) | null = null;

	private launcherSize: { width: number; height: number } | null = null;
	private launcherPosition: { x: number; y: number } | null = null;
	private screenWidth = 0;
	private screenHeight = 0;
	private currentX = 0;
	private currentY = 0;

	constructor(appState: AppState, stealthManager: StealthManager) {
		this.appState = appState;
		this.stealthManager = stealthManager;
		this.startupProtectionGate = new StartupProtectionGate({
			logger: console,
			isStrictProtectionEnabled: () =>
				process.env.NATIVELY_STRICT_PROTECTION === "1",
			verifyProtection: () => this.verifyStartupProtection(),
			recordProtectionEvent: (type, context) => {
				const recorder = this.stealthManager as ProtectionEventRecorder;
				return recorder.recordProtectionEvent?.(type, context);
			},
			onBlocked: (decision) => this.handleStartupRevealBlocked(decision),
		});
	}

	public setStealthRuntimeHeartbeatListener(
		listener: (() => void) | null,
	): void {
		this.stealthHeartbeatListener = listener;
	}

	private shouldUseStealthRuntime(): boolean {
		return (
			process.platform !== "darwin" ||
			process.env.NATIVELY_FORCE_STEALTH_RUNTIME === "1"
		);
	}

	private applyLauncherSurfaceProtection(): void {
		if (this.launcherRuntime) {
			this.launcherRuntime.applyStealth(this.contentProtection);
			return;
		}

		if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
			this.applyStealth(
				this.launcherWindow,
				this.contentProtection,
				"primary",
				false,
			);
		}
	}

	private applyOverlaySurfaceProtection(): void {
		if (this.overlayRuntime) {
			this.overlayRuntime.applyStealth(this.contentProtection);
			return;
		}

		if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
			this.applyStealth(
				this.overlayWindow,
				this.contentProtection,
				"primary",
				false,
			);
		}
	}

	private recordProtectionEvent(
		type: ProtectionEventType,
		win: BrowserWindow | null,
		source: string,
		windowRole: "primary" | "auxiliary" | "unknown" = "primary",
	): void {
		if (!win || win.isDestroyed()) {
			return;
		}

		let windowId: string | undefined;
		try {
			windowId = win.getMediaSourceId?.();
		} catch {
			windowId = undefined;
		}

		const recorder = this.stealthManager as ProtectionEventRecorder;
		recorder.recordProtectionEvent?.(type, {
			source,
			windowRole,
			windowId,
			visible:
				typeof win.isVisible === "function" ? win.isVisible() : undefined,
		});
	}

	private requestWindowShow(
		win: BrowserWindow | null,
		source: string,
		windowRole: "primary" | "auxiliary" | "unknown" = "primary",
	): void {
		const manager = this.stealthManager as ProtectionEventRecorder;
		if (manager.requestWindowShow) {
			manager.requestWindowShow(win, { source, windowRole });
			return;
		}

		this.recordProtectionEvent("show-requested", win, source, windowRole);
		win?.show();
		this.recordProtectionEvent("shown", win, source, windowRole);
	}

	private requestWindowHide(
		win: BrowserWindow | null,
		source: string,
		windowRole: "primary" | "auxiliary" | "unknown" = "primary",
	): void {
		const manager = this.stealthManager as ProtectionEventRecorder;
		if (manager.requestWindowHide) {
			manager.requestWindowHide(win, { source, windowRole });
			return;
		}

		this.recordProtectionEvent("hide-requested", win, source, windowRole);
		win?.hide();
		this.recordProtectionEvent("hidden", win, source, windowRole);
	}

	private setWindowOpacity(
		win: BrowserWindow | null,
		value: number,
		source: string,
		windowRole: "primary" | "auxiliary" | "unknown" = "primary",
	): void {
		const manager = this.stealthManager as ProtectionEventRecorder;
		if (manager.setWindowOpacity) {
			manager.setWindowOpacity(win, value, { source, windowRole });
			return;
		}

		win?.setOpacity(value);
	}

	private showLauncherSurface(): void {
		if (this.launcherRuntime) {
			this.launcherRuntime.show();
			return;
		}

		this.requestWindowShow(
			this.launcherWindow,
			"WindowHelper.showLauncherSurface",
		);
		this.launcherWindow?.focus();
	}

	private hideLauncherSurface(): void {
		if (this.launcherRuntime) {
			this.launcherRuntime.hide();
			return;
		}

		this.requestWindowHide(
			this.launcherWindow,
			"WindowHelper.hideLauncherSurface",
		);
	}

	private createDirectWindow(
		options: Electron.BrowserWindowConstructorOptions,
	): BrowserWindow {
		const win = new BrowserWindow(options);
		this.recordProtectionEvent(
			"window-created",
			win,
			"WindowHelper.createDirectWindow",
			"unknown",
		);
		return win;
	}

	private loadDirectWindow(
		win: BrowserWindow,
		url: string,
		label: string,
	): void {
		void win.loadURL(url).catch((error) => {
			console.error(`[WindowHelper] ${label} direct load failed:`, error);
		});
	}

	private shouldStartRendererShielded(): boolean {
		const appState = this.appState as unknown as {
			shouldStartRendererShielded?: () => boolean;
		};
		return typeof appState.shouldStartRendererShielded === "function"
			? appState.shouldStartRendererShielded()
			: false;
	}

	private getStartupVisibilityIntent(): VisibilityIntent {
		const appState = this.appState as unknown as {
			getVisibilityIntent?: () => VisibilityIntent;
		};
		if (typeof appState.getVisibilityIntent === "function") {
			return appState.getVisibilityIntent();
		}

		return this.shouldStartRendererShielded()
			? "protected_shield"
			: "visible_app";
	}

	private verifyStartupProtection(): boolean {
		const manager = this.stealthManager as ProtectionEventRecorder;
		if (typeof manager.verifyManagedWindows !== "function") {
			return false;
		}

		return manager.verifyManagedWindows();
	}

	private handleStartupRevealBlocked(
		decision: StartupProtectionGateDecision,
	): void {
		this.pendingDirectLauncherReveal = false;
		const appState = this.appState as unknown as {
			setPrivacyShieldFault?: (key: string, reason: string) => void;
		};
		const reason =
			decision.reason === "startup-verification-timeout"
				? "Startup privacy protection verification timed out; sensitive content remains hidden."
				: "Startup privacy protection could not be verified; sensitive content remains hidden.";

		if (typeof appState.setPrivacyShieldFault === "function") {
			appState.setPrivacyShieldFault(
				"startup_protection_verification_failed",
				reason,
			);
			return;
		}

		this.hideMainWindow();
	}

	private async revealLauncherAfterStartupGate(source: string): Promise<void> {
		const decision = await this.startupProtectionGate.evaluateReveal({
			source,
			windowRole: "primary",
			intent: this.getStartupVisibilityIntent(),
		});

		if (!decision.allowReveal) {
			console.warn(
				`[WindowHelper] ${source}: startup gate blocked capture verification, revealing local protected UI`,
			);
		}

		this.switchToLauncher();
	}

	private buildRendererWindowUrl(
		baseUrl: string,
		windowKind: "launcher" | "overlay",
	): string {
		const separator = baseUrl.includes("?") ? "&" : "?";
		const privacyParam = this.shouldStartRendererShielded()
			? "&privacyShield=1"
			: "";
		return `${baseUrl}${separator}window=${windowKind}${privacyParam}`;
	}

	public setContentProtection(enable: boolean): void {
		this.contentProtection = enable;
		this.applyContentProtection(enable);
	}

	public setSkipTaskbar(enable: boolean): void {
		this.launcherWindow?.setSkipTaskbar(enable);
	}

	private applyStealth(
		win: BrowserWindow,
		enable: boolean,
		role: "primary" | "auxiliary",
		hideFromSwitcher: boolean,
	): void {
		this.stealthManager.applyToWindow(win, enable, { role, hideFromSwitcher });
	}

	private applyContentProtection(enable: boolean): void {
		const windows = [
			{ win: this.launcherWindow, auxiliary: false },
			{ win: this.overlayWindow, auxiliary: false },
		];
		windows.forEach(({ win, auxiliary }) => {
			if (win && !win.isDestroyed()) {
				this.applyStealth(
					win,
					enable,
					auxiliary ? "auxiliary" : "primary",
					auxiliary,
				);
			}
		});
	}

	public setWindowDimensions(width: number, height: number): void {
		const activeWindow = this.getVisibleMainWindow();
		if (!activeWindow || activeWindow.isDestroyed()) return;

		const [currentX, currentY] = activeWindow.getPosition();
		const primaryDisplay = screen.getPrimaryDisplay();
		const workArea = primaryDisplay.workAreaSize;
		const maxAllowedWidth = Math.floor(workArea.width * 0.9);
		const newWidth = Math.min(width, maxAllowedWidth);
		const newHeight = Math.ceil(height);
		const maxX = workArea.width - newWidth;
		const newX = Math.min(Math.max(currentX, 0), maxX);

		activeWindow.setBounds({
			x: newX,
			y: currentY,
			width: newWidth,
			height: newHeight,
		});

		// Update internal tracking if it's launcher
		if (activeWindow === this.launcherWindow) {
			this.launcherSize = { width: newWidth, height: newHeight };
			this.launcherPosition = { x: newX, y: currentY };
		}
	}

	// Dedicated method for overlay window resizing - decoupled from launcher
	public setOverlayDimensions(width: number, height: number): void {
		if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;
		console.log("[WindowHelper] setOverlayDimensions:", width, height);

		const [currentX, currentY] = this.overlayWindow.getPosition();
		const primaryDisplay = screen.getPrimaryDisplay();
		const workArea = primaryDisplay.workAreaSize;
		const maxAllowedWidth = Math.floor(workArea.width * 0.9);
		const maxAllowedHeight = Math.floor(workArea.height * 0.9);
		const newWidth = Math.min(Math.max(width, 300), maxAllowedWidth); // min 300, max 90%
		const newHeight = Math.min(Math.max(height, 1), maxAllowedHeight); // min 1, max 90%
		const maxX = workArea.width - newWidth;
		const maxY = workArea.height - newHeight;
		const newX = Math.min(Math.max(currentX, 0), maxX);
		const newY = Math.min(Math.max(currentY, 0), maxY);

		this.overlayWindow.setContentSize(newWidth, newHeight);
		this.overlayWindow.setPosition(newX, newY);
	}

	public setOverlayClickthrough(enabled: boolean): void {
		this.overlayClickthroughEnabled = enabled;
		if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;

		this.overlayWindow.setIgnoreMouseEvents(
			enabled,
			enabled ? { forward: true } : undefined,
		);
		this.overlayWindow.setFocusable(!enabled);
		if (enabled) {
			this.overlayWindow.blur();
		}
	}

	public toggleOverlayClickthrough(): boolean {
		const next = !this.overlayClickthroughEnabled;
		this.setOverlayClickthrough(next);
		return next;
	}

	public createWindow(): void {
		if (this.launcherWindow !== null) return; // Already created

		const startUrl = resolveRendererStartUrl({ electronDir: __dirname });
		const preloadPath = resolveRendererPreloadPath({ electronDir: __dirname });

		const primaryDisplay = screen.getPrimaryDisplay();
		const workArea = primaryDisplay.workArea;
		this.screenWidth = workArea.width;
		this.screenHeight = workArea.height;

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
			titleBarStyle: "hiddenInset",
			trafficLightPosition: { x: 14, y: 14 },
			hasShadow: true,
			focusable: true,
			resizable: true,
			movable: true,
			center: true,
			...(useStealthRuntime
				? {
						vibrancy: "under-window" as const,
						visualEffectState: "followWindow" as const,
						transparent: true,
						backgroundColor: "#00000000",
					}
				: {
						transparent: false,
						backgroundColor: "#050505",
					}),
			icon: (() => {
				const isMac = process.platform === "darwin";
				const isWin = process.platform === "win32";
				const mode = this.appState.getDisguise();

				if (mode === "none") {
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
				if (mode === "settings") iconName = "settings.png";
				if (mode === "activity") iconName = "activity.png";

				const platformDir = isWin ? "win" : "mac";
				return app.isPackaged
					? path.join(
							process.resourcesPath,
							`assets/fakeicon/${platformDir}/${iconName}`,
						)
					: path.resolve(
							__dirname,
							`../../assets/fakeicon/${platformDir}/${iconName}`,
						);
			})(),
		};

		console.log(`[WindowHelper] Icon Path: ${launcherSettings.icon}`);
		console.log(`[WindowHelper] Start URL: ${startUrl}`);
		console.log(`[WindowHelper] Preload Path: ${preloadPath}`);

		if (useStealthRuntime) {
			try {
				this.launcherRuntime = new StealthRuntime({
					stealthManager: this.stealthManager,
					startUrl: this.buildRendererWindowUrl(startUrl, "launcher"),
					onFault: (reason) => {
						this.appState.handleStealthRuntimeFault(reason);
					},
					onHeartbeat: () => {
						this.stealthHeartbeatListener?.();
					},
					onFirstFrame: () => {
						if (this.currentWindowMode === "launcher") {
							void this.revealLauncherAfterStartupGate(
								"WindowHelper.launcherRuntime.onFirstFrame",
							);
						}
					},
				});
				this.launcherWindow = this.launcherRuntime.createPrimaryStealthSurface(
					launcherSettings,
				) as BrowserWindow;
				this.launcherContentWindow = this.launcherRuntime.getContentWindow();
				console.log("[WindowHelper] StealthRuntime created successfully");
			} catch (err) {
				console.error("[WindowHelper] Failed to create BrowserWindow:", err);
				return;
			}
		} else {
			this.launcherRuntime = null;
			this.directLauncherLoaded = false;
			this.pendingDirectLauncherReveal = true;
			this.detachDirectLauncherBridgeMonitor?.();
			this.detachDirectLauncherBridgeMonitor = null;
			this.launcherWindow = this.createDirectWindow(launcherSettings);
			this.launcherContentWindow = this.launcherWindow;
			this.setWindowOpacity(
				this.launcherWindow,
				0,
				"WindowHelper.createWindow.launcherInitial",
			);
			this.requestWindowHide(
				this.launcherWindow,
				"WindowHelper.createWindow.launcherInitial",
			);
			this.applyLauncherSurfaceProtection();

			// NAT-SELF-HEAL: safety net — if bridge never settles, force reveal anyway
			const revealSafetyNet = attachRevealSafetyNet(
				"Launcher",
				this.launcherWindow,
				() => {
					this.directLauncherLoaded = true;
					this.pendingDirectLauncherReveal = false;
					console.warn(
						"[WindowHelper] Force-revealing launcher after safety-net timeout",
					);
					void this.revealLauncherAfterStartupGate(
						"WindowHelper.directLauncher.safetyNet",
					);
				},
			);

			this.detachDirectLauncherBridgeMonitor = attachRendererBridgeMonitor(
				"Launcher",
				this.launcherWindow,
				{
					expectedPreloadPath: preloadPath,
					url: this.buildRendererWindowUrl(startUrl, "launcher"),
					onSettled: (result) => {
						this.directLauncherLoaded = true;
						revealSafetyNet.cancel();
						console.log(
							`[WindowHelper] Direct launcher bridge settled: ${result}`,
						);

						if (
							!this.pendingDirectLauncherReveal ||
							this.currentWindowMode !== "launcher"
						) {
							return;
						}

						this.pendingDirectLauncherReveal = false;
						void this.revealLauncherAfterStartupGate(
							"WindowHelper.directLauncher.bridgeSettled",
						);
					},
				},
			);
			this.loadDirectWindow(
				this.launcherWindow,
				this.buildRendererWindowUrl(startUrl, "launcher"),
				"Launcher",
			);
			console.log("[WindowHelper] Using direct launcher window on macOS");
		}

		this.applyLauncherSurfaceProtection();

		// NAT-SELF-HEAL: auto-reload on load failure instead of permanent black screen
		let launcherLoadFailures = 0;
		const MAX_LAUNCHER_LOAD_FAILURES = 2;
		this.launcherContentWindow?.webContents.on(
			"did-fail-load",
			(_event, errorCode, errorDescription, validatedURL) => {
				console.error(
					`[WindowHelper] did-fail-load: ${errorCode} ${errorDescription} URL: ${validatedURL}`,
				);
				if (
					launcherLoadFailures < MAX_LAUNCHER_LOAD_FAILURES &&
					this.launcherContentWindow &&
					!this.launcherContentWindow.isDestroyed()
				) {
					launcherLoadFailures += 1;
					console.warn(
						`[WindowHelper] Auto-reloading launcher after load failure (${launcherLoadFailures}/${MAX_LAUNCHER_LOAD_FAILURES})`,
					);
					this.launcherContentWindow.webContents.reloadIgnoringCache();
				} else {
					console.error(
						"[WindowHelper] Launcher load failed permanently. Recording startup failure.",
					);
					recordStartupFailure();
				}
			},
		);

		this.launcherContentWindow?.webContents.on("did-finish-load", () => {
			console.log("[WindowHelper] Launcher content window did-finish-load");
			launcherLoadFailures = 0; // reset on success
		});

		this.launcherContentWindow?.webContents.on("dom-ready", () => {
			console.log("[WindowHelper] Launcher content window dom-ready");
		});

		// NAT-SELF-HEAL: crash recovery — recreate the window instead of leaving a dead frame
		if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
			attachWindowCrashRecovery("Launcher", this.launcherWindow, () => {
				console.warn("[WindowHelper] Recreating launcher window after crash");
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
		};

		if (useStealthRuntime) {
			try {
				this.overlayRuntime = new StealthRuntime({
					stealthManager: this.stealthManager,
					startUrl: this.buildRendererWindowUrl(startUrl, "overlay"),
					onFault: (reason) => {
						this.appState.handleStealthRuntimeFault(reason);
					},
					onHeartbeat: () => {
						this.stealthHeartbeatListener?.();
					},
					onFirstFrame: () => {
						if (this.currentWindowMode === "overlay" && this.isWindowVisible) {
							this.switchToOverlay();
						}
					},
				});
				this.overlayWindow = this.overlayRuntime.createPrimaryStealthSurface(
					overlaySettings,
				) as BrowserWindow;
				this.overlayContentWindow = this.overlayRuntime.getContentWindow();
				console.log(
					"[WindowHelper] StealthRuntime (overlay) created successfully",
				);
			} catch (err) {
				console.error(
					"[WindowHelper] Failed to create overlay BrowserWindow:",
					err,
				);
				this.launcherRuntime?.destroy();
				this.launcherRuntime = null;
				this.launcherContentWindow = null;
				this.launcherWindow = null;
				this.overlayRuntime = null;
				this.overlayContentWindow = null;
				this.overlayWindow = null;
				return;
			}
		} else {
			this.overlayRuntime = null;
			this.detachDirectOverlayBridgeMonitor?.();
			this.detachDirectOverlayBridgeMonitor = null;
			this.overlayWindow = this.createDirectWindow(overlaySettings);
			this.overlayContentWindow = this.overlayWindow;

			// NAT-SELF-HEAL: overlay crash recovery
			if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
				attachWindowCrashRecovery("Overlay", this.overlayWindow, () => {
					console.warn("[WindowHelper] Recreating overlay window after crash");
					if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
						this.overlayWindow.destroy();
					}
					this.overlayWindow = null;
					this.overlayContentWindow = null;
					// Overlay will be recreated on next toggle
				});
			}

			this.detachDirectOverlayBridgeMonitor = attachRendererBridgeMonitor(
				"Overlay",
				this.overlayWindow,
				{
					expectedPreloadPath: preloadPath,
					url: this.buildRendererWindowUrl(startUrl, "overlay"),
				},
			);
			this.loadDirectWindow(
				this.overlayWindow,
				this.buildRendererWindowUrl(startUrl, "overlay"),
				"Overlay",
			);
			console.log("[WindowHelper] Using direct overlay window on macOS");
		}

		this.applyOverlaySurfaceProtection();

		if (process.platform === "darwin") {
			this.overlayWindow.setVisibleOnAllWorkspaces(true, {
				visibleOnFullScreen: true,
			});
			this.overlayWindow.setAlwaysOnTop(true, "floating");
		}
		this.setOverlayClickthrough(this.overlayClickthroughEnabled);
		if (this.launcherRuntime) {
			console.log(
				"[WindowHelper] Waiting for first launcher frame before showing stealth shell",
			);
		}

		this.setupWindowListeners();
	}

	private setupWindowListeners(): void {
		const launcherWindow = this.launcherWindow;
		if (!launcherWindow) return;

		launcherWindow.on("move", () => {
			if (this.launcherWindow === launcherWindow) {
				const bounds = launcherWindow.getBounds();
				this.launcherPosition = { x: bounds.x, y: bounds.y };
				this.appState.settingsWindowHelper.reposition(bounds);
			}
		});

		launcherWindow.on("resize", () => {
			if (this.launcherWindow === launcherWindow) {
				const bounds = launcherWindow.getBounds();
				this.launcherSize = { width: bounds.width, height: bounds.height };
				this.appState.settingsWindowHelper.reposition(bounds);
			}
		});

		launcherWindow.on("closed", () => {
			if (this.launcherWindow !== launcherWindow) {
				return;
			}
			this.launcherRuntime?.destroy();
			this.launcherRuntime = null;
			this.detachDirectLauncherBridgeMonitor?.();
			this.detachDirectLauncherBridgeMonitor = null;
			this.detachDirectOverlayBridgeMonitor?.();
			this.detachDirectOverlayBridgeMonitor = null;
			this.launcherWindow = null;
			this.launcherContentWindow = null;
			if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
				this.overlayWindow.close();
			}
			this.overlayRuntime?.destroy();
			this.overlayRuntime = null;
			this.overlayContentWindow = null;
			this.overlayWindow = null;
			this.isWindowVisible = false;
		});

		// Listen for overlay close if independent closing acts as "Stop Meeting"
		if (this.overlayWindow) {
			this.overlayWindow.on("close", (e) => {
				// Prevent accidental closing via cmd+w if we want to enforce workflow?
				// Or treat as end meeting. simpler to treat as hiding for now.
				if (this.isWindowVisible && this.overlayWindow?.isVisible()) {
					e.preventDefault();
					this.switchToLauncher();
					// Notify backend meeting ended? Handled via IPC ideally.
				}
			});
		}
	}

	// Helper to get whichever window should be treated as "Main" for IPC
	public getMainWindow(): BrowserWindow | null {
		if (this.currentWindowMode === "overlay" && this.overlayWindow) {
			return this.overlayContentWindow || this.overlayWindow;
		}
		return this.launcherContentWindow;
	}

	public getVisibleMainWindow(): BrowserWindow | null {
		if (this.currentWindowMode === "overlay" && this.overlayWindow) {
			return this.overlayWindow;
		}
		return this.launcherWindow;
	}

	// Specific getters if needed
	public getLauncherWindow(): BrowserWindow | null {
		return this.launcherWindow;
	}
	public getLauncherContentWindow(): BrowserWindow | null {
		return this.launcherContentWindow;
	}
	public getOverlayWindow(): BrowserWindow | null {
		return this.overlayWindow;
	}
	public getOverlayContentWindow(): BrowserWindow | null {
		return this.overlayContentWindow || this.overlayWindow;
	}
	public getCurrentWindowMode(): "launcher" | "overlay" {
		return this.currentWindowMode;
	}

	public isVisible(): boolean {
		return this.isWindowVisible;
	}

	public hideMainWindow(): void {
		// Hide BOTH
		this.pendingDirectLauncherReveal = false;
		this.hideLauncherSurface();
		this.requestWindowHide(
			this.overlayWindow,
			"WindowHelper.hideMainWindow.overlay",
		);
		this.isWindowVisible = false;
	}

	public showMainWindow(): void {
		// Show the window corresponding to the current mode
		if (this.currentWindowMode === "overlay") {
			this.switchToOverlay();
		} else {
			this.switchToLauncher();
		}
	}

	public toggleMainWindow(): void {
		if (this.isWindowVisible) {
			this.hideMainWindow();
		} else {
			this.showMainWindow();
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
		console.log("[WindowHelper] Switching to OVERLAY");
		this.currentWindowMode = "overlay";

		// Show Overlay FIRST
		if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
			// Reset overlay position to center or last known?
			// For now, center it nicely
			const primaryDisplay = screen.getPrimaryDisplay();
			const workArea = primaryDisplay.workArea;
			const currentBounds = this.overlayWindow.getBounds();
			const targetWidth = Math.max(currentBounds.width, 600);
			const targetHeight = Math.max(currentBounds.height, 216);
			const centeredX = Math.floor(
				workArea.x + (workArea.width - targetWidth) / 2,
			);
			const centeredY = Math.floor(
				workArea.y + (workArea.height - targetHeight) / 2,
			);
			const maxX = workArea.x + Math.max(0, workArea.width - targetWidth);
			const maxY = workArea.y + Math.max(0, workArea.height - targetHeight);
			const x = Math.min(Math.max(centeredX, workArea.x), maxX);
			const y = Math.min(Math.max(centeredY, workArea.y), maxY);

			this.overlayWindow.setBounds({
				x,
				y,
				width: targetWidth,
				height: targetHeight,
			});

			if (process.platform === "win32" && this.contentProtection) {
				// Opacity Shield: Show at 0 opacity first to prevent frame leak
				this.setWindowOpacity(
					this.overlayWindow,
					0,
					"WindowHelper.switchToOverlay.win32",
				);
				this.requestWindowShow(
					this.overlayWindow,
					"WindowHelper.switchToOverlay.win32",
				);
				this.applyStealth(this.overlayWindow, true, "primary", false);
				this.setOverlayClickthrough(this.overlayClickthroughEnabled);
				// Small delay to ensure Windows DWM processes the flag before making it opaque

				if (this.opacityTimeout) clearTimeout(this.opacityTimeout);
				// CRITICAL: Reduced from 60ms to 16ms (1 frame at 60fps) to prevent frame leaks during screen capture
				this.opacityTimeout = setTimeout(() => {
					if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
						this.setWindowOpacity(
							this.overlayWindow,
							1,
							"WindowHelper.switchToOverlay.win32.restore",
						);
						this.stealthManager.reapplyAfterShow(this.overlayWindow);
						if (!this.overlayClickthroughEnabled) {
							this.overlayWindow.focus();
						}
						this.overlayWindow.setAlwaysOnTop(true, "floating");
					}
				}, 16);
			} else {
				this.applyStealth(
					this.overlayWindow,
					this.contentProtection,
					"primary",
					false,
				);
				this.setOverlayClickthrough(this.overlayClickthroughEnabled);
				this.requestWindowShow(
					this.overlayWindow,
					"WindowHelper.switchToOverlay",
				);
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
			this.requestWindowHide(
				this.launcherWindow,
				"WindowHelper.switchToOverlay.launcher",
			);
		}
	}

	public switchToLauncher(): void {
		console.log("[WindowHelper] Switching to LAUNCHER");
		this.currentWindowMode = "launcher";

		if (!this.launcherRuntime && !this.directLauncherLoaded) {
			console.log(
				"[WindowHelper] Delaying launcher reveal until direct renderer load completes",
			);
			this.pendingDirectLauncherReveal = true;
			if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
				this.setWindowOpacity(
					this.launcherWindow,
					0,
					"WindowHelper.switchToLauncher.delay",
				);
				this.requestWindowHide(
					this.launcherWindow,
					"WindowHelper.switchToLauncher.delay",
				);
			}
			if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
				this.requestWindowHide(
					this.overlayWindow,
					"WindowHelper.switchToLauncher.delayOverlay",
				);
			}
			this.isWindowVisible = false;
			return;
		}

		// Show Launcher FIRST
		if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
			if (process.platform === "win32" && this.contentProtection) {
				// Opacity Shield: Show at 0 opacity first
				this.setWindowOpacity(
					this.launcherWindow,
					0,
					"WindowHelper.switchToLauncher.win32",
				);
				this.showLauncherSurface();
				if (this.launcherRuntime) {
					this.launcherRuntime.applyStealth(true);
				} else {
					this.applyStealth(this.launcherWindow, true, "primary", false);
				}

				if (this.opacityTimeout) clearTimeout(this.opacityTimeout);
				// CRITICAL: Reduced from 60ms to 16ms (1 frame at 60fps) to prevent frame leaks during screen capture
				this.opacityTimeout = setTimeout(() => {
					if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
						this.setWindowOpacity(
							this.launcherWindow,
							1,
							"WindowHelper.switchToLauncher.win32.restore",
						);
						this.stealthManager.reapplyAfterShow(this.launcherWindow);
						this.launcherWindow.focus();
					}
				}, 16);
			} else {
				if (!this.launcherRuntime) {
					this.setWindowOpacity(
						this.launcherWindow,
						1,
						"WindowHelper.switchToLauncher",
					);
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
			this.requestWindowHide(
				this.overlayWindow,
				"WindowHelper.switchToLauncher.overlay",
			);
		}
	}

	// Simplified setWindowMode that just calls switchers
	public setWindowMode(mode: "launcher" | "overlay"): void {
		if (mode === "launcher") {
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

	public moveWindowRight(): void {
		this.moveActiveWindow(this.step, 0);
	}
	public moveWindowLeft(): void {
		this.moveActiveWindow(-this.step, 0);
	}
	public moveWindowDown(): void {
		this.moveActiveWindow(0, this.step);
	}
	public moveWindowUp(): void {
		this.moveActiveWindow(0, -this.step);
	}
}
