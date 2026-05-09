import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

test('default keybinds include overlay clickthrough toggle shortcut', async () => {
  const originalLoad = (Module as any)._load;
  const registered: string[] = [];

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        app: { getPath: () => '/tmp', name: 'Natively' },
        globalShortcut: {
          unregisterAll: () => {},
          register: (accelerator: string) => {
            registered.push(accelerator);
            return true;
          },
        },
        Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
        BrowserWindow: { getAllWindows: (): any[] => [] },
        ipcMain: { handle: () => {} },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { DEFAULT_KEYBINDS, KeybindManager } = await import('../services/KeybindManager');

    // --- Verify DEFAULT_KEYBINDS shape ---
    const shortcut = DEFAULT_KEYBINDS.find((item) => item.id === 'general:toggle-clickthrough');
    assert.ok(shortcut);
    assert.equal(shortcut?.isGlobal, true);
    assert.equal(shortcut?.accelerator, 'Command+Shift+M');
    assert.deepEqual(shortcut?.alternateAccelerators, ['Command+Alt+Shift+M']);

    assert.equal(DEFAULT_KEYBINDS.find((item) => item.id === 'general:toggle-visibility')?.accelerator, 'Command+Alt+Shift+V');
    assert.deepEqual(DEFAULT_KEYBINDS.find((item) => item.id === 'general:toggle-visibility')?.alternateAccelerators, ['F13']);
    assert.equal(DEFAULT_KEYBINDS.find((item) => item.id === 'general:take-screenshot')?.accelerator, 'Command+Alt+Shift+S');
    assert.deepEqual(DEFAULT_KEYBINDS.find((item) => item.id === 'general:take-screenshot')?.alternateAccelerators, ['F14', 'Command+Shift+S']);
    assert.equal(DEFAULT_KEYBINDS.find((item) => item.id === 'general:selective-screenshot')?.accelerator, 'Command+Alt+Shift+A');
    assert.deepEqual(DEFAULT_KEYBINDS.find((item) => item.id === 'general:selective-screenshot')?.alternateAccelerators, ['F15']);
    assert.equal(DEFAULT_KEYBINDS.find((item) => item.id === 'general:restore-full-stealth')?.accelerator, 'Shift+Esc');
    assert.equal(DEFAULT_KEYBINDS.find((item) => item.id === 'general:restore-full-stealth')?.isGlobal, true);

    assert.equal(DEFAULT_KEYBINDS.find((item) => item.id === 'chat:scrollUp')?.accelerator, 'Command+Up');
    assert.equal(DEFAULT_KEYBINDS.find((item) => item.id === 'chat:scrollUp')?.isGlobal, true);
    assert.equal(DEFAULT_KEYBINDS.find((item) => item.id === 'chat:scrollDown')?.accelerator, 'Command+Down');
    assert.equal(DEFAULT_KEYBINDS.find((item) => item.id === 'chat:scrollDown')?.isGlobal, true);
    assert.equal(DEFAULT_KEYBINDS.find((item) => item.id === 'window:move-up')?.accelerator, 'Command+Alt+Up');
    assert.equal(DEFAULT_KEYBINDS.find((item) => item.id === 'window:move-down')?.accelerator, 'Command+Alt+Down');

    const globalIds = DEFAULT_KEYBINDS.filter((item) => item.isGlobal).map((item) => item.id).sort();
    assert.deepEqual(globalIds, [
      'chat:scrollDown',
      'chat:scrollUp',
      'general:emergency-hide',
      'general:process-screenshots',
      'general:restore-full-stealth',
      'general:selective-screenshot',
      'general:take-screenshot',
      'general:toggle-clickthrough',
      'general:toggle-visibility',
    ]);

    // --- Verify actual global shortcut registrations ---
    // Trigger registration via singleton initialization
    (KeybindManager as any).instance = undefined;
    const manager = KeybindManager.getInstance();
    manager.setWindowHelper({});

    assert.ok(registered.includes('Command+Alt+Shift+V'));
    assert.ok(registered.includes('F13'));
    assert.ok(registered.includes('Command+Alt+Shift+S'));
    assert.ok(registered.includes('F14'));
    assert.ok(registered.includes('Command+Shift+S'));
    assert.ok(registered.includes('Command+Alt+Shift+A'));
    assert.ok(registered.includes('F15'));
    assert.ok(registered.includes('Shift+Esc'));
    assert.ok(registered.includes('Command+Shift+M'));
    assert.ok(registered.includes('Command+Alt+Shift+M'));
    assert.ok(registered.includes('Command+Up'));
    assert.ok(registered.includes('Command+Down'));
    assert.ok(registered.includes('CommandOrControl+Enter'));
  } finally {
    (Module as any)._load = originalLoad;
  }
});
