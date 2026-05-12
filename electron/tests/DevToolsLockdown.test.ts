/**
 * Unit tests for DevTools Lockdown.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.5
 *
 * Tests shortcut interception in packaged mode, DevTools closure,
 * environment variable override, and no restriction in dev mode.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { lockdownDevTools, isDevToolsAllowed } from '../utils/lockdownDevtools';
import type { BrowserWindow, App, Event, Input } from 'electron';

// --- Mock Factories ---

interface MockWebContents {
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  closeDevTools(): void;
  closeDevToolsCalled: number;
}

interface MockBrowserWindow {
  webContents: MockWebContents;
  destroyed: boolean;
  isDestroyed(): boolean;
}

function createMockWebContents(): MockWebContents {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    listeners,
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)!.push(handler);
    },
    closeDevTools() {
      this.closeDevToolsCalled++;
    },
    closeDevToolsCalled: 0,
  };
}

function createMockWindow(): MockBrowserWindow {
  return {
    webContents: createMockWebContents(),
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
}

function createMockApp(isPackaged: boolean): App {
  return { isPackaged } as unknown as App;
}

function createMockEvent(): Event & { defaultPrevented: boolean } {
  let prevented = false;
  return {
    get defaultPrevented() { return prevented; },
    preventDefault() { prevented = true; },
  } as unknown as Event & { defaultPrevented: boolean };
}

function createInput(overrides: Partial<Input> = {}): Input {
  return {
    type: 'keyDown',
    key: '',
    code: '',
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    modifiers: [],
    ...overrides,
  } as Input;
}

// Helper to trigger the before-input-event listener
function triggerBeforeInputEvent(win: MockBrowserWindow, event: Event, input: Input): void {
  const handlers = win.webContents.listeners.get('before-input-event') ?? [];
  for (const handler of handlers) {
    handler(event, input);
  }
}

// Helper to trigger the devtools-opened listener
function triggerDevToolsOpened(win: MockBrowserWindow): void {
  const handlers = win.webContents.listeners.get('devtools-opened') ?? [];
  for (const handler of handlers) {
    handler();
  }
}

// --- isDevToolsAllowed tests ---

test('isDevToolsAllowed returns true in development mode', () => {
  const app = createMockApp(false);
  assert.equal(isDevToolsAllowed(app), true);
});

test('isDevToolsAllowed returns false in packaged mode without env override', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  delete process.env.NATIVELY_ALLOW_DEVTOOLS;

  try {
    const app = createMockApp(true);
    assert.equal(isDevToolsAllowed(app), false);
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    }
  }
});

test('isDevToolsAllowed returns true in packaged mode with NATIVELY_ALLOW_DEVTOOLS=1', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  process.env.NATIVELY_ALLOW_DEVTOOLS = '1';

  try {
    const app = createMockApp(true);
    assert.equal(isDevToolsAllowed(app), true);
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    } else {
      delete process.env.NATIVELY_ALLOW_DEVTOOLS;
    }
  }
});

test('isDevToolsAllowed returns false when NATIVELY_ALLOW_DEVTOOLS is not "1"', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  process.env.NATIVELY_ALLOW_DEVTOOLS = '0';

  try {
    const app = createMockApp(true);
    assert.equal(isDevToolsAllowed(app), false);
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    } else {
      delete process.env.NATIVELY_ALLOW_DEVTOOLS;
    }
  }
});

// --- Shortcut Interception in Packaged Mode (Requirement 9.1) ---

test('blocks Ctrl+Shift+I in packaged mode', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  delete process.env.NATIVELY_ALLOW_DEVTOOLS;

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    lockdownDevTools(win as unknown as BrowserWindow, app);

    const event = createMockEvent();
    const input = createInput({ control: true, shift: true, key: 'I' });
    triggerBeforeInputEvent(win, event, input);

    assert.equal(event.defaultPrevented, true, 'Ctrl+Shift+I should be blocked');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    }
  }
});

test('blocks Ctrl+Shift+i (lowercase) in packaged mode', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  delete process.env.NATIVELY_ALLOW_DEVTOOLS;

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    lockdownDevTools(win as unknown as BrowserWindow, app);

    const event = createMockEvent();
    const input = createInput({ control: true, shift: true, key: 'i' });
    triggerBeforeInputEvent(win, event, input);

    assert.equal(event.defaultPrevented, true, 'Ctrl+Shift+i should be blocked');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    }
  }
});

test('blocks Cmd+Opt+I (macOS) in packaged mode', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  delete process.env.NATIVELY_ALLOW_DEVTOOLS;

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    lockdownDevTools(win as unknown as BrowserWindow, app);

    const event = createMockEvent();
    const input = createInput({ meta: true, alt: true, key: 'I' });
    triggerBeforeInputEvent(win, event, input);

    assert.equal(event.defaultPrevented, true, 'Cmd+Opt+I should be blocked');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    }
  }
});

test('blocks F12 in packaged mode', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  delete process.env.NATIVELY_ALLOW_DEVTOOLS;

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    lockdownDevTools(win as unknown as BrowserWindow, app);

    const event = createMockEvent();
    const input = createInput({ key: 'F12' });
    triggerBeforeInputEvent(win, event, input);

    assert.equal(event.defaultPrevented, true, 'F12 should be blocked');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    }
  }
});

test('does not block non-DevTools shortcuts in packaged mode', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  delete process.env.NATIVELY_ALLOW_DEVTOOLS;

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    lockdownDevTools(win as unknown as BrowserWindow, app);

    const event = createMockEvent();
    const input = createInput({ control: true, key: 'c' });
    triggerBeforeInputEvent(win, event, input);

    assert.equal(event.defaultPrevented, false, 'Ctrl+C should not be blocked');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    }
  }
});

test('does not block keyUp events even for DevTools keys', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  delete process.env.NATIVELY_ALLOW_DEVTOOLS;

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    lockdownDevTools(win as unknown as BrowserWindow, app);

    const event = createMockEvent();
    const input = createInput({ type: 'keyUp', key: 'F12' });
    triggerBeforeInputEvent(win, event, input);

    assert.equal(event.defaultPrevented, false, 'keyUp F12 should not be blocked');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    }
  }
});

// --- DevTools Closure (Requirement 9.2) ---

test('closes DevTools when opened in packaged mode', async () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  delete process.env.NATIVELY_ALLOW_DEVTOOLS;

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    lockdownDevTools(win as unknown as BrowserWindow, app);

    triggerDevToolsOpened(win);

    // closeDevTools is called via setImmediate, so we need to wait
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(win.webContents.closeDevToolsCalled, 1, 'DevTools should be closed');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    }
  }
});

test('does not close DevTools on destroyed window', async () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  delete process.env.NATIVELY_ALLOW_DEVTOOLS;

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    lockdownDevTools(win as unknown as BrowserWindow, app);

    // Mark window as destroyed before the setImmediate fires
    win.destroyed = true;
    triggerDevToolsOpened(win);

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(win.webContents.closeDevToolsCalled, 0, 'should not close DevTools on destroyed window');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    }
  }
});

// --- Environment Variable Override (Requirement 9.3) ---

test('does not block shortcuts when NATIVELY_ALLOW_DEVTOOLS=1 in packaged mode', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  process.env.NATIVELY_ALLOW_DEVTOOLS = '1';

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    lockdownDevTools(win as unknown as BrowserWindow, app);

    // No listeners should be registered
    const beforeInputHandlers = win.webContents.listeners.get('before-input-event') ?? [];
    assert.equal(beforeInputHandlers.length, 0, 'no shortcut listener when DevTools allowed');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    } else {
      delete process.env.NATIVELY_ALLOW_DEVTOOLS;
    }
  }
});

test('does not register devtools-opened listener when NATIVELY_ALLOW_DEVTOOLS=1', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  process.env.NATIVELY_ALLOW_DEVTOOLS = '1';

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    lockdownDevTools(win as unknown as BrowserWindow, app);

    const devtoolsHandlers = win.webContents.listeners.get('devtools-opened') ?? [];
    assert.equal(devtoolsHandlers.length, 0, 'no devtools-opened listener when DevTools allowed');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    } else {
      delete process.env.NATIVELY_ALLOW_DEVTOOLS;
    }
  }
});

// --- No Restriction in Dev Mode (Requirement 9.5) ---

test('does not register any listeners in development mode', () => {
  const win = createMockWindow();
  const app = createMockApp(false); // not packaged = dev mode
  lockdownDevTools(win as unknown as BrowserWindow, app);

  const beforeInputHandlers = win.webContents.listeners.get('before-input-event') ?? [];
  const devtoolsHandlers = win.webContents.listeners.get('devtools-opened') ?? [];

  assert.equal(beforeInputHandlers.length, 0, 'no shortcut listener in dev mode');
  assert.equal(devtoolsHandlers.length, 0, 'no devtools-opened listener in dev mode');
});

test('DevTools shortcuts are not intercepted in dev mode', () => {
  const win = createMockWindow();
  const app = createMockApp(false);
  lockdownDevTools(win as unknown as BrowserWindow, app);

  const event = createMockEvent();
  const input = createInput({ key: 'F12' });
  triggerBeforeInputEvent(win, event, input);

  assert.equal(event.defaultPrevented, false, 'F12 should not be blocked in dev mode');
});

// --- forceAllow Option ---

test('forceAllow option skips lockdown even in packaged mode', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  delete process.env.NATIVELY_ALLOW_DEVTOOLS;

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    lockdownDevTools(win as unknown as BrowserWindow, app, { forceAllow: true });

    const beforeInputHandlers = win.webContents.listeners.get('before-input-event') ?? [];
    const devtoolsHandlers = win.webContents.listeners.get('devtools-opened') ?? [];

    assert.equal(beforeInputHandlers.length, 0, 'no shortcut listener with forceAllow');
    assert.equal(devtoolsHandlers.length, 0, 'no devtools-opened listener with forceAllow');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    }
  }
});

// --- Logger Integration ---

test('logger.log is called when shortcut is blocked', () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  delete process.env.NATIVELY_ALLOW_DEVTOOLS;

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    const logs: string[] = [];
    const logger = { log: (msg: string) => logs.push(msg), warn: () => {} };

    lockdownDevTools(win as unknown as BrowserWindow, app, { logger });

    const event = createMockEvent();
    const input = createInput({ key: 'F12' });
    triggerBeforeInputEvent(win, event, input);

    assert.ok(logs.some(l => l.includes('Blocked DevTools shortcut')), 'should log blocked shortcut');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    }
  }
});

test('logger.warn is called when DevTools opened unexpectedly', async () => {
  const originalEnv = process.env.NATIVELY_ALLOW_DEVTOOLS;
  delete process.env.NATIVELY_ALLOW_DEVTOOLS;

  try {
    const win = createMockWindow();
    const app = createMockApp(true);
    const warnings: string[] = [];
    const logger = { log: () => {}, warn: (msg: string) => warnings.push(msg) };

    lockdownDevTools(win as unknown as BrowserWindow, app, { logger });

    triggerDevToolsOpened(win);
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
      warnings.some(w => w.includes('DevTools opened unexpectedly')),
      'should warn when DevTools opened'
    );
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_ALLOW_DEVTOOLS = originalEnv;
    }
  }
});
