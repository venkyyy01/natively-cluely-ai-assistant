import { app, globalShortcut, Menu, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';

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
    isGlobal: boolean;   // Registered with globalShortcut
    defaultAccelerator: string;
}

export const DEFAULT_KEYBINDS: KeybindConfig[] = [
  // General
  { id: 'general:emergency-hide', label: 'Emergency Hide (Boss Key)', accelerator: 'Command+Shift+H', alternateAccelerators: ['Command+Shift+X'], isGlobal: true, defaultAccelerator: 'Command+Shift+H' },
  { id: 'general:toggle-visibility', label: 'Toggle Visibility', accelerator: 'Command+Alt+Shift+V', alternateAccelerators: ['F13'], isGlobal: true, defaultAccelerator: 'Command+Alt+Shift+V' },
  { id: 'general:toggle-clickthrough', label: 'Toggle Clickthrough', accelerator: 'Command+Shift+M', alternateAccelerators: ['Command+Alt+Shift+M'], isGlobal: true, defaultAccelerator: 'Command+Shift+M' },
  { id: 'general:restore-full-stealth', label: 'Restore Full Stealth', accelerator: 'Shift+Esc', isGlobal: true, defaultAccelerator: 'Shift+Esc' },
    { id: 'general:process-screenshots', label: 'Process Screenshots', accelerator: 'CommandOrControl+Enter', isGlobal: true, defaultAccelerator: 'CommandOrControl+Enter' },
    { id: 'general:reset-cancel', label: 'Reset / Cancel', accelerator: 'CommandOrControl+R', isGlobal: false, defaultAccelerator: 'CommandOrControl+R' },
    { id: 'general:take-screenshot', label: 'Take Screenshot', accelerator: 'Command+Alt+Shift+S', alternateAccelerators: ['F14', 'Command+Shift+S'], isGlobal: true, defaultAccelerator: 'Command+Alt+Shift+S' },
    { id: 'general:selective-screenshot', label: 'Selective Screenshot', accelerator: 'Command+Alt+Shift+A', alternateAccelerators: ['F15'], isGlobal: true, defaultAccelerator: 'Command+Alt+Shift+A' },

    // Chat - Window Local (Handled via Menu or Renderer logic, but centralized here)
    { id: 'chat:whatToAnswer', label: 'What to Answer', accelerator: 'CommandOrControl+1', isGlobal: false, defaultAccelerator: 'CommandOrControl+1' },
    { id: 'chat:shorten', label: 'Shorten', accelerator: 'CommandOrControl+2', isGlobal: false, defaultAccelerator: 'CommandOrControl+2' },
    { id: 'chat:followUp', label: 'Follow Up', accelerator: 'CommandOrControl+3', isGlobal: false, defaultAccelerator: 'CommandOrControl+3' },
    { id: 'chat:recap', label: 'Recap', accelerator: 'CommandOrControl+4', isGlobal: false, defaultAccelerator: 'CommandOrControl+4' },
    { id: 'chat:answer', label: 'Answer / Record', accelerator: 'CommandOrControl+5', isGlobal: false, defaultAccelerator: 'CommandOrControl+5' },
    { id: 'chat:scrollUp', label: 'Scroll Up', accelerator: 'Command+Up', isGlobal: true, defaultAccelerator: 'Command+Up' },
    { id: 'chat:scrollDown', label: 'Scroll Down', accelerator: 'Command+Down', isGlobal: true, defaultAccelerator: 'Command+Down' },

    // Window Movement
    { id: 'window:move-up', label: 'Move Window Up', accelerator: 'Command+Alt+Up', isGlobal: false, defaultAccelerator: 'Command+Alt+Up' },
    { id: 'window:move-down', label: 'Move Window Down', accelerator: 'Command+Alt+Down', isGlobal: false, defaultAccelerator: 'Command+Alt+Down' },
    { id: 'window:move-left', label: 'Move Window Left', accelerator: 'Command+Alt+Left', isGlobal: false, defaultAccelerator: 'Command+Alt+Left' },
    { id: 'window:move-right', label: 'Move Window Right', accelerator: 'Command+Alt+Right', isGlobal: false, defaultAccelerator: 'Command+Alt+Right' },
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
        this.filePath = path.join(app.getPath('userData'), 'keybinds.json');
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
        DEFAULT_KEYBINDS.forEach(kb => this.keybinds.set(kb.id, { ...kb }));

        // 2. Load Overrides
        try {
            if (fs.existsSync(this.filePath)) {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
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
            console.error('[KeybindManager] Failed to load keybinds:', error);
        }
    }

    private save() {
        try {
            const data = Array.from(this.keybinds.values()).map(kb => ({
                id: kb.id,
                accelerator: kb.accelerator
            }));
            const tmpPath = this.filePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
            fs.renameSync(tmpPath, this.filePath);
        } catch (error) {
            console.error('[KeybindManager] Failed to save keybinds:', error);
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
        this.broadcastUpdate();
    }

    public resetKeybinds() {
        this.keybinds.clear();
        DEFAULT_KEYBINDS.forEach(kb => this.keybinds.set(kb.id, { ...kb }));
        this.save();
        this.registerGlobalShortcuts();
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
     * Enable or disable stealth key mode. When enabled, shortcuts are handled
     * via CGEventTap (invisible to proctoring software) instead of globalShortcut
     * (which registers visible OS-level hotkeys).
     */
    public setStealthMode(enabled: boolean) {
        if (this.useStealthKeys === enabled) {
            return;
        }
        this.useStealthKeys = enabled;
        if (enabled) {
            // Unregister visible global shortcuts and switch to stealth tap
            globalShortcut.unregisterAll();
            this.startStealthKeyMonitor();
        } else {
            // Stop stealth tap and re-register visible shortcuts
            this.stopStealthKeyMonitor();
            this.registerGlobalShortcuts();
        }
    }

    private startStealthKeyMonitor() {
        if (this.stealthKeyMonitor) {
            return; // Already running
        }
        if (!StealthKeyMonitor) {
            console.warn('[KeybindManager] StealthKeyMonitor unavailable, falling back to globalShortcut');
            return;
        }
        try {
            this.stealthKeyMonitor = new StealthKeyMonitor();
            this.stealthKeyMonitor.start((actionId: string) => {
                this.onShortcutTriggeredCallbacks.forEach(cb => cb(actionId));
            });
            console.log('[KeybindManager] Stealth key monitor started (CGEventTap, invisible to proctoring)');
        } catch (e) {
            console.warn('[KeybindManager] Failed to start stealth key monitor, falling back to globalShortcut:', e);
            this.stealthKeyMonitor = null;
            // Fall back to visible global shortcuts
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
                        console.error(`[KeybindManager] Failed to register fallback shortcut:`, err);
                    }
                }
            });
        }
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

    public updateMenu() {
        const toggleKb = this.keybinds.get('general:toggle-visibility');
        const toggleAccelerator = toggleKb ? toggleKb.accelerator : 'CommandOrControl+B';

        const template: any[] = [
            {
                label: app.name,
                submenu: [
                    { role: 'about' },
                    { type: 'separator' },
                    { role: 'services' },
                    { type: 'separator' },
                    { role: 'hide', accelerator: 'CommandOrControl+Option+H' },
                    { role: 'hideOthers', accelerator: 'CommandOrControl+Option+Shift+H' },
                    { role: 'unhide' },
                    { type: 'separator' },
                    { role: 'quit' }
                ]
            },
            {
                role: 'editMenu'
            },
            {
                label: 'View',
                submenu: [
                    {
                        label: 'Toggle Visibility',
                        accelerator: toggleAccelerator,
                        click: () => {
                            // Require AppState dynamically to avoid circular dependencies
                            const { AppState } = require('../main');
                            AppState.getInstance().toggleMainWindow();
                        }
                    },
                    {
                        label: 'Toggle Clickthrough',
                        accelerator: this.getKeybind('general:toggle-clickthrough') || 'CommandOrControl+Shift+M',
                        click: () => {
                            this.windowHelper?.toggleOverlayClickthrough?.();
                        }
                    },
                    { type: 'separator' },
                    {
                        label: 'Move Window Up',
                        accelerator: this.getKeybind('window:move-up') || 'Command+Alt+Up',
                        click: () => this.windowHelper?.moveWindowUp()
                    },
                    {
                        label: 'Move Window Down',
                        accelerator: this.getKeybind('window:move-down') || 'Command+Alt+Down',
                        click: () => this.windowHelper?.moveWindowDown()
                    },
                    {
                        label: 'Move Window Left',
                        accelerator: this.getKeybind('window:move-left') || 'Command+Alt+Left',
                        click: () => this.windowHelper?.moveWindowLeft()
                    },
                    {
                        label: 'Move Window Right',
                        accelerator: this.getKeybind('window:move-right') || 'Command+Alt+Right',
                        click: () => this.windowHelper?.moveWindowRight()
                    },
                    { type: 'separator' },
                    { role: 'reload' },
                    { role: 'forceReload' },
                    { role: 'toggleDevTools' },
                    { type: 'separator' },
                    { role: 'resetZoom' },
                    { role: 'zoomIn' },
                    { role: 'zoomOut' },
                    { type: 'separator' },
                    { role: 'togglefullscreen' }
                ]
            },
            {
                role: 'windowMenu'
            },
            {
                role: 'help',
                submenu: [
                    {
                        label: 'Learn More',
                        click: async () => {
                            const { shell } = require('electron');
                            await shell.openExternal('https://electronjs.org');
                        }
                    }
                ]
            }
        ];

        const menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);
        console.log('[KeybindManager] Application menu updated');
    }

    private broadcastUpdate() {
        // Notify main process listeners
        this.onUpdateCallbacks.forEach(cb => cb());

        const windows = BrowserWindow.getAllWindows();
        const allKeybinds = this.getAllKeybinds();
        windows.forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('keybinds:update', allKeybinds);
            }
        });
    }

    public setupIpcHandlers() {
        ipcMain.handle('keybinds:get-all', () => {
            return this.getAllKeybinds();
        });

        ipcMain.handle('keybinds:set', (_, id: string, accelerator: string) => {
            console.log(`[KeybindManager] Set ${id} -> ${accelerator}`);
            this.setKeybind(id, accelerator);
            return true;
        });

        ipcMain.handle('keybinds:reset', () => {
            console.log('[KeybindManager] Reset defaults');
            this.resetKeybinds();
            return this.getAllKeybinds();
        });
    }
}
