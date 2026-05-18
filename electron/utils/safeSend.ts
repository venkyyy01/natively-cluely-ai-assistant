import { BrowserWindow } from 'electron';

/**
 * NAT-H3: Safe wrapper around `webContents.send` that guards against
 * sending to a destroyed or loading window. Without this, any async
 * code path that holds a window reference can throw an uncaught
 * exception if the window is closed between the reference capture and
 * the send — crashing the main process.
 *
 * Usage:
 *   safeSend(mainWindow, 'channel-name', payload);
 *
 * Returns true if the message was sent, false if the window was
 * unavailable (destroyed, null, or webContents not ready).
 */
export function safeSend(
  win: BrowserWindow | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!win || win.isDestroyed()) return false;
  try {
    win.webContents.send(channel, ...args);
    return true;
  } catch (err) {
    // Window may have been destroyed between the check and the send
    // (race in async contexts). Swallow gracefully.
    console.warn(`[safeSend] Failed to send '${channel}':`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Broadcast a message to all non-destroyed BrowserWindows.
 * Useful for status updates that all renderers should receive.
 */
export function safeBroadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win, channel, ...args);
  }
}
