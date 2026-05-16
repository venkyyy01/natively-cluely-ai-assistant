/**
 * NAT-501: IPC handlers for continuous screen RAG lifecycle.
 *
 * Channels:
 *   screen-rag:start   — start snapshot loop
 *   screen-rag:stop    — stop snapshot loop
 *   screen-rag:context — get current RAG context string
 */
import { ipcMain } from 'electron';
import { getScreenRAGManager, disposeScreenRAGManager } from '../rag/ScreenRAGManager';
import { isConsciousOptimizationActive } from '../config/optimizations';

export function registerScreenRAGHandlers(): void {
  ipcMain.handle('screen-rag:start', () => {
    if (!isConsciousOptimizationActive('useContinuousScreenRAG')) {
      return { ok: false, reason: 'useContinuousScreenRAG flag is OFF' };
    }
    getScreenRAGManager().start();
    return { ok: true };
  });

  ipcMain.handle('screen-rag:stop', () => {
    getScreenRAGManager().stop();
    return { ok: true };
  });

  ipcMain.handle('screen-rag:context', (_e, maxChars: number = 3000) => {
    return { context: getScreenRAGManager().getContext(maxChars) };
  });
}

export function disposeScreenRAGHandlers(): void {
  disposeScreenRAGManager();
  ipcMain.removeAllListeners('screen-rag:start');
  ipcMain.removeAllListeners('screen-rag:stop');
  ipcMain.removeAllListeners('screen-rag:context');
}
