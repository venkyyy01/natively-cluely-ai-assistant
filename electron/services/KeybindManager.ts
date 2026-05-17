import { app, BrowserWindow, globalShortcut, ipcMain, Menu } from "electron";
import fs from "fs";
import path from "path";

// ─── Accelerator → macOS keycode/modifiers conversion ───────────────────────
// Maps Electron accelerator key names to macOS virtual key codes (CGKeyCode).
const KEYCODE_MAP: Record<string, number> = {
    'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5, 'h': 4,
    'i': 34, 'j': 38, 'k': 40, 'l': 37, 'm': 46, 'n': 45, 'o': 31, 'p': 35,
    'q': 12, 'r': 15, 's': 1, 't': 17, 'u': 32, 'v': 9, 'w': 13, 'x': 7,
    'y': 16, 'z': 6,
    '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23, '6': 22, '7': 26,
    '8': 28, '9': 25,
    'return': 36, 'enter': 36, 'escape': 53, 'esc': 53, 'space': 49,
    'tab': 48, 'backspace': 51, 'delete': 117,
    'up': 126, 'down': 125, 'left': 123, 'right': 124,
    'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97,
    'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
    'f13': 105, 'f14': 107, 'f15': 113, 'f16': 106, 'f17': 64, 'f18': 79,
    'f19': 80, 'f20': 90,
    '-': 27, '=': 24, '[': 33, ']': 30, '\\': 42, ';': 41, "'": 39,
    ',': 43, '.': 47, '/': 44, '`': 50,
};

// CGEventFlags modifier bitmask values
const MODIFIER_COMMAND = 1 << 20;  // 1048576
const MODIFIER_SHIFT = 1 << 17;    // 131072
const MODIFIER_ALT = 1 << 19;      // 524288
const MODIFIER_CONTROL = 1 << 18;  // 262144

export interface NativeShortcutEntry {
    actionId: string;
    keycode: number;
    modifiers: number;
}

/**
 * Convert an Electron accelerator string (e.g. "Command+Alt+Shift+S") to
 * a macOS keycode + CGEventFlags modifiers pair.
 *
 * Returns null if the accelerator cannot be parsed (unknown key).
 */
export function acceleratorToNative(accelerator: string): { keycode: number; modifiers: number } | null {
    const parts = accelerator.split('+');
    let modifiers = 0;
    let keyPart: string | null = null;

    for (const part of parts) {
        const lower = part.toLowerCase().trim();
        switch (lower) {
            case 'command':
            case 'cmd':
            case 'commandorcontrol':
            case 'cmdorctrl':
                modifiers |= MODIFIER_COMMAND;
                break;
            case 'control':
            case 'ctrl':
                modifiers |= MODIFIER_CONTROL;
                break;
            case 'alt':
            case 'option':
                modifiers |= MODIFIER_ALT;
                break;
            case 'shift':
                modifiers |= MODIFIER_SHIFT;
                break;
            default:
                keyPart = lower;
                break;
        }
    }

    if (!keyPart) return null;

    const keycode = KEYCODE_MAP[keyPart];
    if (keycode === undefined) return null;

    return { keycode, modifiers };
}

/**
 * Build the JSON shortcut config array from the current keybind state.
 * Only includes global keybinds that can be converted to native format.
 */
export function buildNativeShortcutConfig(keybinds: Map<string, KeybindConfig>): NativeShortcutEntry[] {
    const entries: NativeShortcutEntry[] = [];

    keybinds.forEach(kb => {
        if (!kb.isGlobal) return;

        const allAccelerators = [kb.accelerator, ...(kb.alternateAccelerators || [])].filter(Boolean);
        for (const accel of allAccelerators) {
            const native = acceleratorToNative(accel);
            if (native) {
                entries.push({
                    actionId: kb.id,
                    keycode: native.keycode,
                    modifiers: native.modifiers,
                });
            }
        }
    });

    return entries;
}

// Stealth key monitor — uses CGEventTap instead of globalShortcut to avoid
// detection by proctoring software that enumerates registered hotkeys.
let StealthKeyMonitor: any = null;
try {
    const nativeModule = require('natively-audio');
    if (nativeModule?.StealthKeyMonitor) {
        StealthKeyMonitor = nativeModule.StealthKeyMonitor;
    }
} catch {
    // Native module unavailable — will fall back to globalShortcut
}

export interface KeybindConfig {
	id: string;
	label: string;
	accelerator: string; // Electron Accelerator string
	alternateAccelerators?: string[];
	isGlobal: boolean; // Registered with globalShortcut
	defaultAccelerator: string;
}

export const DEFAULT_KEYBINDS: KeybindConfig[] = [
  // General
  { id: 'general:emergency-hide', label: 'Emergency Hide (Boss Key)', accelerator: 'Command+Shift+H', alternateAccelerators: ['Command+Shift+X'], isGlobal: true, defaultAccelerator: 'Command+Shift+H' },
  { id: 'general:toggle-visibility', label: 'Toggle Visibility', accelerator: 'Command+Alt+Shift+V', alternateAccelerators: ['Command+B', 'CommandOrControl+Shift+Space', 'F13'], isGlobal: true, defaultAccelerator: 'Command+Alt+Shift+V' },
  { id: 'general:toggle-clickthrough', label: 'Toggle Clickthrough', accelerator: 'Command+Shift+M', alternateAccelerators: ['Command+Alt+Shift+M', 'Command+Shift+/'], isGlobal: true, defaultAccelerator: 'Command+Shift+M' },
  { id: 'general:restore-full-stealth', label: 'Restore Full Stealth', accelerator: 'Shift+Esc', isGlobal: true, defaultAccelerator: 'Shift+Esc' },
    { id: 'general:process-screenshots', label: 'Process Screenshots', accelerator: 'CommandOrControl+Enter', isGlobal: true, defaultAccelerator: 'CommandOrControl+Enter' },
    { id: 'general:reset-cancel', label: 'Reset / Cancel', accelerator: 'CommandOrControl+R', isGlobal: false, defaultAccelerator: 'CommandOrControl+R' },
    { id: 'general:take-screenshot', label: 'Take Screenshot', accelerator: 'Command+Alt+Shift+S', alternateAccelerators: ['F14', 'CommandOrControl+Shift+S', 'CommandOrControl+Shift+\\'], isGlobal: true, defaultAccelerator: 'Command+Alt+Shift+S' },
    { id: 'general:selective-screenshot', label: 'Selective Screenshot', accelerator: 'Command+Alt+Shift+A', alternateAccelerators: ['F15'], isGlobal: true, defaultAccelerator: 'Command+Alt+Shift+A' },
    { id: 'general:toggle-cursor-hook', label: 'Toggle Cursor Stealth', accelerator: 'CommandOrControl+Shift+-', isGlobal: true, defaultAccelerator: 'CommandOrControl+Shift+-' },

	// Chat - Window Local (Handled via Menu or Renderer logic, but centralized here)
	{
		id: "chat:whatToAnswer",
		label: "What to Answer",
		accelerator: "CommandOrControl+1",
		isGlobal: false,
		defaultAccelerator: "CommandOrControl+1",
	},
	{
		id: "chat:shorten",
		label: "Shorten",
		accelerator: "CommandOrControl+2",
		isGlobal: false,
		defaultAccelerator: "CommandOrControl+2",
	},
	{
		id: "chat:followUp",
		label: "Follow Up",
		accelerator: "CommandOrControl+3",
		isGlobal: false,
		defaultAccelerator: "CommandOrControl+3",
	},
	{
		id: "chat:recap",
		label: "Recap",
		accelerator: "CommandOrControl+4",
		isGlobal: false,
		defaultAccelerator: "CommandOrControl+4",
	},
	{
		id: "chat:answer",
		label: "Answer / Record",
		accelerator: "CommandOrControl+5",
		isGlobal: false,
		defaultAccelerator: "CommandOrControl+5",
	},
	{
		id: "chat:scrollUp",
		label: "Scroll Up",
		accelerator: "Command+Up",
		isGlobal: true,
		defaultAccelerator: "Command+Up",
	},
	{
		id: "chat:scrollDown",
		label: "Scroll Down",
		accelerator: "Command+Down",
		isGlobal: true,
		defaultAccelerator: "Command+Down",
	},

	// Window Movement
	{
		id: "window:move-up",
		label: "Move Window Up",
		accelerator: "Command+Alt+Up",
		isGlobal: false,
		defaultAccelerator: "Command+Alt+Up",
	},
	{
		id: "window:move-down",
		label: "Move Window Down",
		accelerator: "Command+Alt+Down",
		isGlobal: false,
		defaultAccelerator: "Command+Alt+Down",
	},
	{
		id: "window:move-left",
		label: "Move Window Left",
		accelerator: "Command+Alt+Left",
		isGlobal: false,
		defaultAccelerator: "Command+Alt+Left",
	},
	{
		id: "window:move-right",
		label: "Move Window Right",
		accelerator: "Command+Alt+Right",
		isGlobal: false,
		defaultAccelerator: "Command+Alt+Right",
	},
];

export class KeybindManager {
    private static instance: KeybindManager;
    private keybinds: Map<string, KeybindConfig> = new Map();
    private filePath: string;
    private windowHelper: any; // Type avoided for circular dep, passed in init
    private onUpdateCallbacks: (() => void)[] = [];
    private onShortcutTriggeredCallbacks: ((actionId: string) => void)[] = [];
    private stealthKeyMonitor: any = null;
    private useStealthKeys: boolean = false;

	private constructor() {
		this.filePath = path.join(app.getPath("userData"), "keybinds.json");
		this.load();
	}

	public onUpdate(callback: () => void) {
		this.onUpdateCallbacks.push(callback);
	}

	public onShortcutTriggered(callback: (actionId: string) => void) {
		this.onShortcutTriggeredCallbacks.push(callback);
	}

	public static getInstance(): KeybindManager {
		if (!KeybindManager.instance) {
			KeybindManager.instance = new KeybindManager();
		}
		return KeybindManager.instance;
	}

	public setWindowHelper(windowHelper: any) {
		this.windowHelper = windowHelper;
		// Re-register globals now that we have the helper
		this.registerGlobalShortcuts();
	}

	private load() {
		// 1. Load Defaults
		DEFAULT_KEYBINDS.forEach((kb) => this.keybinds.set(kb.id, { ...kb }));

		// 2. Load Overrides
		try {
			if (fs.existsSync(this.filePath)) {
				const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
				// Validate and merge
				for (const fileKb of data) {
					if (this.keybinds.has(fileKb.id)) {
						const current = this.keybinds.get(fileKb.id)!;
						current.accelerator = fileKb.accelerator;
						this.keybinds.set(fileKb.id, current);
					}
				}
			}
		} catch (error) {
			console.error("[KeybindManager] Failed to load keybinds:", error);
		}
	}

	private save() {
		try {
			const data = Array.from(this.keybinds.values()).map((kb) => ({
				id: kb.id,
				accelerator: kb.accelerator,
			}));
			const tmpPath = this.filePath + ".tmp";
			fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
			fs.renameSync(tmpPath, this.filePath);
		} catch (error) {
			console.error("[KeybindManager] Failed to save keybinds:", error);
		}
	}

	public getKeybind(id: string): string | undefined {
		return this.keybinds.get(id)?.accelerator;
	}

	public getAllKeybinds(): KeybindConfig[] {
		return Array.from(this.keybinds.values());
	}

	public setKeybind(id: string, accelerator: string) {
		if (!this.keybinds.has(id)) return;

		const kb = this.keybinds.get(id)!;
		kb.accelerator = accelerator;
		this.keybinds.set(id, kb);

        this.save();
        this.registerGlobalShortcuts(); // Re-register if it was a global one

        // If the stealth key monitor is running, update its shortcut config
        // so the native CGEventTap matches the new keybind immediately.
        this.syncShortcutConfigToNative();

        this.broadcastUpdate();
    }

    public resetKeybinds() {
        this.keybinds.clear();
        DEFAULT_KEYBINDS.forEach(kb => this.keybinds.set(kb.id, { ...kb }));
        this.save();
        this.registerGlobalShortcuts();

        // Sync reset config to native monitor if running
        this.syncShortcutConfigToNative();

        this.broadcastUpdate();
    }

	public registerGlobalShortcuts() {
		globalShortcut.unregisterAll();

        // In stealth mode, use CGEventTap-based monitor instead of globalShortcut.
        // globalShortcut uses RegisterEventHotKey which is visible to proctoring
        // software. CGEventTap is a passive listener that cannot be enumerated.
        if (StealthKeyMonitor && this.useStealthKeys) {
            this.startStealthKeyMonitor();
            this.updateMenu();
            return;
        }

        // Fallback: register via Electron's globalShortcut (visible to other apps)
        this.keybinds.forEach(kb => {
            if (kb.isGlobal && kb.accelerator && kb.accelerator.trim() !== '') {
                try {
                    const accelerators = [kb.accelerator, ...(kb.alternateAccelerators || [])].filter(Boolean);
                    accelerators.forEach((accelerator) => {
                        globalShortcut.register(accelerator, () => {
                            this.onShortcutTriggeredCallbacks.forEach(cb => cb(kb.id));
                        });
                    });
                } catch (e) {
                    console.error(`[KeybindManager] Failed to register global shortcut ${kb.accelerator}:`, e);
                }
            }
        });

		this.updateMenu();
	}

    /**
     * Check whether the native CGEventTap-based stealth key monitor is currently
     * active and healthy. Returns false if the monitor is not running or if the
     * native call fails for any reason.
     */
    public isStealthTapActive(): boolean {
        if (!this.stealthKeyMonitor) {
            return false;
        }
        try {
            return this.stealthKeyMonitor.isTapActive();
        } catch {
            return false;
        }
    }

    /**
     * Enable or disable stealth key mode. When enabled, shortcuts are handled
     * via CGEventTap (invisible to proctoring software) instead of globalShortcut
     * (which registers visible OS-level hotkeys).
     *
     * Transition strategy to avoid dropping registered shortcuts:
     *
     * - globalShortcut → CGEventTap (enabled=true):
     *   Per Requirement 4.4, globalShortcut registrations are removed BEFORE
     *   starting the event tap. There is a brief sub-millisecond gap where
     *   neither mechanism is active. This is acceptable because:
     *   (a) the gap is imperceptible to human input,
     *   (b) the requirement mandates zero globalShortcut registrations when
     *       the tap is installed.
     *
     * - CGEventTap → globalShortcut (enabled=false):
     *   globalShortcuts are registered FIRST while the tap is still running.
     *   The tap's dual-binding mode suppresses matched events so they don't
     *   double-fire through globalShortcut during the brief overlap. Once
     *   globalShortcuts are confirmed registered, the tap is stopped. This
     *   ensures no gap where shortcuts are unhandled.
     */
    public setStealthMode(enabled: boolean) {
        if (this.useStealthKeys === enabled) {
            return;
        }
        this.useStealthKeys = enabled;
        if (enabled) {
            // Transition: globalShortcut → CGEventTap
            // Unregister visible global shortcuts first (Requirement 4.4),
            // then start the stealth tap.
            if (typeof globalShortcut.unregisterAll === 'function') {
                globalShortcut.unregisterAll();
            }
            this.startStealthKeyMonitor();
        } else {
            // Transition: CGEventTap → globalShortcut
            // Register globalShortcuts first (while tap still suppresses duplicates),
            // then stop the tap. This eliminates any gap where shortcuts are unhandled.
            this.registerGlobalShortcuts();
            this.stopStealthKeyMonitor();
        }
    }

    private startStealthKeyMonitor() {
        if (this.stealthKeyMonitor) {
            return; // Already running
        }
        if (!StealthKeyMonitor) {
            console.warn('[KeybindManager] [DEGRADATION] StealthKeyMonitor native module not loaded — shortcuts will be registered via globalShortcut and ARE VISIBLE to proctoring software');
            this.registerFallbackGlobalShortcuts();
            return;
        }
        try {
            this.stealthKeyMonitor = new StealthKeyMonitor();
            this.stealthKeyMonitor.start((actionId: string) => {
                this.onShortcutTriggeredCallbacks.forEach(cb => cb(actionId));
            });

            // Enable dual-binding mode: the CGEventTap suppresses matched key events
            // so they don't propagate to the focused app or Electron's globalShortcut.
            this.stealthKeyMonitor.setDualBindingMode(true);

            // Pass the current keybind configuration to the native monitor
            this.syncShortcutConfigToNative();

            console.log('[KeybindManager] Stealth key monitor started (CGEventTap, invisible to proctoring, dual-binding enabled)');
        } catch (e) {
            console.warn('[KeybindManager] [DEGRADATION] Failed to start stealth key monitor (likely Accessibility permission denied) — shortcuts will be registered via globalShortcut and ARE VISIBLE to proctoring software:', e);
            this.stealthKeyMonitor = null;
            this.registerFallbackGlobalShortcuts();
        }
    }

    /**
     * Register all global shortcuts via Electron's globalShortcut as a fallback
     * when the native CGEventTap is unavailable. These shortcuts ARE visible to
     * proctoring software that enumerates registered OS-level hotkeys.
     */
    private registerFallbackGlobalShortcuts() {
        this.keybinds.forEach(kb => {
            if (kb.isGlobal && kb.accelerator && kb.accelerator.trim() !== '') {
                try {
                    const accelerators = [kb.accelerator, ...(kb.alternateAccelerators || [])].filter(Boolean);
                    accelerators.forEach((accelerator) => {
                        globalShortcut.register(accelerator, () => {
                            this.onShortcutTriggeredCallbacks.forEach(cb => cb(kb.id));
                        });
                    });
                } catch (err) {
                    console.error(`[KeybindManager] Failed to register fallback shortcut for ${kb.id}:`, err);
                }
            }
        });
    }

    private stopStealthKeyMonitor() {
        if (this.stealthKeyMonitor) {
            try {
                this.stealthKeyMonitor.stop();
            } catch (e) {
                console.warn('[KeybindManager] Error stopping stealth key monitor:', e);
            }
            this.stealthKeyMonitor = null;
        }
    }

    /**
     * Sync the current keybind configuration to the native stealth key monitor.
     * Converts all global keybind accelerators to the JSON format expected by
     * the Rust native module and pushes the config atomically.
     */
    private syncShortcutConfigToNative() {
        if (!this.stealthKeyMonitor) return;

        try {
            const entries = buildNativeShortcutConfig(this.keybinds);
            const configJson = JSON.stringify(entries);
            this.stealthKeyMonitor.updateShortcutConfig(configJson);
        } catch (e) {
            console.warn('[KeybindManager] Failed to sync shortcut config to native monitor:', e);
        }
    }

    public updateMenu() {
        const toggleKb = this.keybinds.get('general:toggle-visibility');
        const toggleAccelerator = toggleKb ? toggleKb.accelerator : 'CommandOrControl+B';

		const template: any[] = [
			{
				label: app.name,
				submenu: [
					{ role: "about" },
					{ type: "separator" },
					{ role: "services" },
					{ type: "separator" },
					{ role: "hide", accelerator: "CommandOrControl+Option+H" },
					{
						role: "hideOthers",
						accelerator: "CommandOrControl+Option+Shift+H",
					},
					{ role: "unhide" },
					{ type: "separator" },
					{ role: "quit" },
				],
			},
			{
				role: "editMenu",
			},
			{
				label: "View",
				submenu: [
					{
						label: "Toggle Visibility",
						accelerator: toggleAccelerator,
						click: () => {
							// Require AppState dynamically to avoid circular dependencies
							const { AppState } = require("../main");
							AppState.getInstance().toggleMainWindow();
						},
					},
					{
						label: "Toggle Clickthrough",
						accelerator:
							this.getKeybind("general:toggle-clickthrough") ||
							"CommandOrControl+Shift+M",
						click: () => {
							this.windowHelper?.toggleOverlayClickthrough?.();
						},
					},
					{ type: "separator" },
					{
						label: "Move Window Up",
						accelerator: this.getKeybind("window:move-up") || "Command+Alt+Up",
						click: () => this.windowHelper?.moveWindowUp(),
					},
					{
						label: "Move Window Down",
						accelerator:
							this.getKeybind("window:move-down") || "Command+Alt+Down",
						click: () => this.windowHelper?.moveWindowDown(),
					},
					{
						label: "Move Window Left",
						accelerator:
							this.getKeybind("window:move-left") || "Command+Alt+Left",
						click: () => this.windowHelper?.moveWindowLeft(),
					},
					{
						label: "Move Window Right",
						accelerator:
							this.getKeybind("window:move-right") || "Command+Alt+Right",
						click: () => this.windowHelper?.moveWindowRight(),
					},
					{ type: "separator" },
					{ role: "reload" },
					{ role: "forceReload" },
					{ role: "toggleDevTools" },
					{ type: "separator" },
					{ role: "resetZoom" },
					{ role: "zoomIn" },
					{ role: "zoomOut" },
					{ type: "separator" },
					{ role: "togglefullscreen" },
				],
			},
			{
				role: "windowMenu",
			},
			{
				role: "help",
				submenu: [
					{
						label: "Learn More",
						click: async () => {
							const { shell } = require("electron");
							await shell.openExternal("https://electronjs.org");
						},
					},
				],
			},
		];

		const menu = Menu.buildFromTemplate(template);
		Menu.setApplicationMenu(menu);
		console.log("[KeybindManager] Application menu updated");
	}

	private broadcastUpdate() {
		// Notify main process listeners
		this.onUpdateCallbacks.forEach((cb) => cb());

		const windows = BrowserWindow.getAllWindows();
		const allKeybinds = this.getAllKeybinds();
		windows.forEach((win) => {
			if (!win.isDestroyed()) {
				win.webContents.send("keybinds:update", allKeybinds);
			}
		});
	}

	public setupIpcHandlers() {
		ipcMain.handle("keybinds:get-all", () => {
			return this.getAllKeybinds();
		});

		ipcMain.handle("keybinds:set", (_, id: string, accelerator: string) => {
			console.log(`[KeybindManager] Set ${id} -> ${accelerator}`);
			this.setKeybind(id, accelerator);
			return true;
		});

		ipcMain.handle("keybinds:reset", () => {
			console.log("[KeybindManager] Reset defaults");
			this.resetKeybinds();
			return this.getAllKeybinds();
		});
	}
}
