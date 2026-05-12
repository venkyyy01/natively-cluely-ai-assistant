/**
 * DevTools Lockdown
 *
 * Prevents access to Chromium DevTools in packaged (production) builds.
 * - Blocks keyboard shortcuts: Ctrl+Shift+I, Cmd+Opt+I, F12
 * - Closes DevTools if opened by any means
 * - Allows DevTools when NATIVELY_ALLOW_DEVTOOLS=1
 * - No-op in development mode (app.isPackaged === false)
 */

import type { BrowserWindow, App, Event, Input } from 'electron';

export interface DevToolsLockdownOptions {
  /** Override: allow DevTools regardless of build type */
  forceAllow?: boolean;
  /** Logger */
  logger?: Pick<Console, 'log' | 'warn'>;
}

/**
 * Check if DevTools should be allowed based on environment and build type.
 */
export function isDevToolsAllowed(app: App): boolean {
  // Development mode: always allow
  if (!app.isPackaged) {
    return true;
  }

  // Environment variable override
  if (process.env.NATIVELY_ALLOW_DEVTOOLS === '1') {
    return true;
  }

  return false;
}

/**
 * Apply DevTools lockdown to a BrowserWindow.
 * No-op in development mode or when NATIVELY_ALLOW_DEVTOOLS=1.
 */
export function lockdownDevTools(
  win: BrowserWindow,
  app: App,
  options?: DevToolsLockdownOptions
): void {
  const logger = options?.logger;

  // If forceAllow is set, skip lockdown entirely
  if (options?.forceAllow) {
    logger?.log('[DevToolsLockdown] forceAllow is set, skipping lockdown');
    return;
  }

  // No-op in development mode or when env override is set
  if (isDevToolsAllowed(app)) {
    return;
  }

  // Block DevTools keyboard shortcuts
  win.webContents.on('before-input-event', (_event: Event, input: Input) => {
    if (isDevToolsShortcut(input)) {
      _event.preventDefault();
      logger?.log('[DevToolsLockdown] Blocked DevTools shortcut');
    }
  });

  // Close DevTools if opened by any means
  win.webContents.on('devtools-opened', () => {
    logger?.warn('[DevToolsLockdown] DevTools opened unexpectedly, closing');
    // Use setImmediate to avoid potential issues with closing during the event
    setImmediate(() => {
      if (!win.isDestroyed()) {
        win.webContents.closeDevTools();
      }
    });
  });
}

/**
 * Determine if the given keyboard input is a DevTools shortcut.
 */
function isDevToolsShortcut(input: Input): boolean {
  // Only handle keyDown events
  if (input.type !== 'keyDown') {
    return false;
  }

  // F12
  if (input.key === 'F12') {
    return true;
  }

  // Ctrl+Shift+I (Windows/Linux)
  if (input.control && input.shift && input.key.toLowerCase() === 'i') {
    return true;
  }

  // Cmd+Opt+I (macOS)
  if (input.meta && input.alt && input.key.toLowerCase() === 'i') {
    return true;
  }

  return false;
}
