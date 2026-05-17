import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

test('acceleratorToNative converts Electron accelerator strings to macOS keycode + modifiers', async () => {
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        app: { getPath: () => '/tmp', name: 'Natively' },
        globalShortcut: { unregisterAll: () => {}, register: () => true },
        Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
        BrowserWindow: { getAllWindows: (): any[] => [] },
        ipcMain: { handle: () => {} },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { acceleratorToNative } = await import('../services/KeybindManager');

    // Command+Alt+Shift+S → keycode 1 (S), modifiers = Command|Alt|Shift
    const result1 = acceleratorToNative('Command+Alt+Shift+S');
    assert.ok(result1);
    assert.equal(result1!.keycode, 1); // S = keycode 1
    assert.equal(result1!.modifiers, (1 << 20) | (1 << 19) | (1 << 17)); // Cmd|Alt|Shift

    // Command+Shift+H → keycode 4 (H), modifiers = Command|Shift
    const result2 = acceleratorToNative('Command+Shift+H');
    assert.ok(result2);
    assert.equal(result2!.keycode, 4); // H = keycode 4
    assert.equal(result2!.modifiers, (1 << 20) | (1 << 17)); // Cmd|Shift

    // Shift+Esc → keycode 53 (Escape), modifiers = Shift
    const result3 = acceleratorToNative('Shift+Esc');
    assert.ok(result3);
    assert.equal(result3!.keycode, 53); // Escape = keycode 53
    assert.equal(result3!.modifiers, 1 << 17); // Shift only

    // CommandOrControl+Enter → keycode 36 (Return), modifiers = Command (on macOS)
    const result4 = acceleratorToNative('CommandOrControl+Enter');
    assert.ok(result4);
    assert.equal(result4!.keycode, 36); // Return = keycode 36
    assert.equal(result4!.modifiers, 1 << 20); // Command

    // F14 → keycode 107, no modifiers
    const result5 = acceleratorToNative('F14');
    assert.ok(result5);
    assert.equal(result5!.keycode, 107); // F14 = keycode 107
    assert.equal(result5!.modifiers, 0); // No modifiers

    // Unknown key returns null
    const result6 = acceleratorToNative('Command+UnknownKey');
    assert.equal(result6, null);

    // No key part (only modifiers) returns null
    const result7 = acceleratorToNative('Command+Shift');
    assert.equal(result7, null);
  } finally {
    (Module as any)._load = originalLoad;
  }
});

test('buildNativeShortcutConfig produces correct JSON entries for global keybinds', async () => {
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        app: { getPath: () => '/tmp', name: 'Natively' },
        globalShortcut: { unregisterAll: () => {}, register: () => true },
        Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
        BrowserWindow: { getAllWindows: (): any[] => [] },
        ipcMain: { handle: () => {} },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { buildNativeShortcutConfig } = await import('../services/KeybindManager');

    const keybinds = new Map<string, any>();
    keybinds.set('general:take-screenshot', {
      id: 'general:take-screenshot',
      label: 'Take Screenshot',
      accelerator: 'Command+Alt+Shift+S',
      alternateAccelerators: ['F14', 'Command+Shift+S'],
      isGlobal: true,
      defaultAccelerator: 'Command+Alt+Shift+S',
    });
    keybinds.set('general:reset-cancel', {
      id: 'general:reset-cancel',
      label: 'Reset / Cancel',
      accelerator: 'CommandOrControl+R',
      isGlobal: false, // Not global — should be excluded
      defaultAccelerator: 'CommandOrControl+R',
    });

    const entries = buildNativeShortcutConfig(keybinds);

    // Should include 3 entries for the global keybind (primary + 2 alternates)
    assert.equal(entries.length, 3);

    // Primary: Command+Alt+Shift+S
    assert.equal(entries[0].actionId, 'general:take-screenshot');
    assert.equal(entries[0].keycode, 1); // S
    assert.equal(entries[0].modifiers, (1 << 20) | (1 << 19) | (1 << 17)); // Cmd|Alt|Shift

    // Alternate 1: F14
    assert.equal(entries[1].actionId, 'general:take-screenshot');
    assert.equal(entries[1].keycode, 107); // F14
    assert.equal(entries[1].modifiers, 0);

    // Alternate 2: Command+Shift+S
    assert.equal(entries[2].actionId, 'general:take-screenshot');
    assert.equal(entries[2].keycode, 1); // S
    assert.equal(entries[2].modifiers, (1 << 20) | (1 << 17)); // Cmd|Shift
  } finally {
    (Module as any)._load = originalLoad;
  }
});

test('stealth key monitor receives dual-binding mode and shortcut config on start', async () => {
  const originalLoad = (Module as any)._load;
  let dualBindingEnabled = false;
  let shortcutConfigJson = '';

  const mockStealthKeyMonitor = class {
    start(cb: (actionId: string) => void) {}
    stop() {}
    setDualBindingMode(enabled: boolean) { dualBindingEnabled = enabled; }
    getDualBindingMode() { return dualBindingEnabled; }
    updateShortcutConfig(configJson: string) { shortcutConfigJson = configJson; }
    isTapActive() { return true; }
  };

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        app: { getPath: () => '/tmp', name: 'Natively' },
        globalShortcut: { unregisterAll: () => {}, register: () => true },
        Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
        BrowserWindow: { getAllWindows: (): any[] => [] },
        ipcMain: { handle: () => {} },
      };
    }
    if (request === 'natively-audio') {
      return { StealthKeyMonitor: mockStealthKeyMonitor };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    // Clear module cache to pick up our mock
    const modulePath = require.resolve('../services/KeybindManager');
    delete require.cache[modulePath];

    const { KeybindManager } = require('../services/KeybindManager');

    // Reset singleton
    (KeybindManager as any).instance = undefined;
    const manager = KeybindManager.getInstance();

    // Enable stealth mode — this should start the monitor with dual-binding
    manager.setStealthMode(true);

    // Verify dual-binding was enabled
    assert.equal(dualBindingEnabled, true);

    // Verify shortcut config was passed
    assert.ok(shortcutConfigJson.length > 0);
    const parsed = JSON.parse(shortcutConfigJson);
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.length > 0);

    // Verify entries have the correct shape
    const firstEntry = parsed[0];
    assert.ok('actionId' in firstEntry);
    assert.ok('keycode' in firstEntry);
    assert.ok('modifiers' in firstEntry);
    assert.equal(typeof firstEntry.actionId, 'string');
    assert.equal(typeof firstEntry.keycode, 'number');
    assert.equal(typeof firstEntry.modifiers, 'number');
  } finally {
    (Module as any)._load = originalLoad;
  }
});

test('setKeybind syncs updated config to native monitor', async () => {
  const originalLoad = (Module as any)._load;
  let configUpdateCount = 0;
  let lastConfigJson = '';

  const mockStealthKeyMonitor = class {
    start(cb: (actionId: string) => void) {}
    stop() {}
    setDualBindingMode(enabled: boolean) {}
    getDualBindingMode() { return true; }
    updateShortcutConfig(configJson: string) {
      configUpdateCount++;
      lastConfigJson = configJson;
    }
    isTapActive() { return true; }
  };

  // Use a unique temp path to avoid polluting /tmp/keybinds.json
  const tmpDir = `/tmp/keybind-test-${Date.now()}`;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        app: { getPath: () => tmpDir, name: 'Natively' },
        globalShortcut: { unregisterAll: () => {}, register: () => true },
        Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
        BrowserWindow: { getAllWindows: (): any[] => [] },
        ipcMain: { handle: () => {} },
      };
    }
    if (request === 'natively-audio') {
      return { StealthKeyMonitor: mockStealthKeyMonitor };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    // Clear module cache
    const modulePath = require.resolve('../services/KeybindManager');
    delete require.cache[modulePath];

    const { KeybindManager } = require('../services/KeybindManager');

    (KeybindManager as any).instance = undefined;
    const manager = KeybindManager.getInstance();

    // Enable stealth mode to start the monitor
    manager.setStealthMode(true);
    const initialCount = configUpdateCount;

    // Change a keybind — should trigger another config sync
    manager.setKeybind('general:take-screenshot', 'Command+Shift+P');
    assert.equal(configUpdateCount, initialCount + 1);

    // Verify the new config includes the updated accelerator
    const parsed = JSON.parse(lastConfigJson);
    const screenshotEntries = parsed.filter((e: any) => e.actionId === 'general:take-screenshot');
    // Should have entries for the new accelerator + alternates
    assert.ok(screenshotEntries.length > 0);
    // P = keycode 35
    const hasNewKey = screenshotEntries.some((e: any) => e.keycode === 35);
    assert.ok(hasNewKey, 'Updated keybind should include keycode for P (35)');
  } finally {
    (Module as any)._load = originalLoad;
    // Clean up temp files
    const fs = require('fs');
    try { fs.unlinkSync(`${tmpDir}/keybinds.json`); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});
