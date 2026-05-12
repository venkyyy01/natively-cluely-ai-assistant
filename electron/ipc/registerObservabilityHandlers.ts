/**
 * NAT-801: IPC handlers for observability diagnostics.
 *
 * Channels:
 *   obs:events  — returns recent events ring buffer (last N)
 *   obs:stats   — returns event kind counts
 *   obs:clear   — clears the ring buffer
 */
import { ipcMain } from 'electron';
import { getRecentEvents, getEventStats, clearEvents } from '../runtime/ObservabilityLogger';

export function registerObservabilityHandlers(): void {
  ipcMain.handle('obs:events', (_e, limit: number = 100) => {
    return { events: getRecentEvents(limit) };
  });

  ipcMain.handle('obs:stats', () => {
    return { stats: getEventStats() };
  });

  ipcMain.handle('obs:clear', () => {
    clearEvents();
    return { ok: true };
  });
}
