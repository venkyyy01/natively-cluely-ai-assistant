/**
 * NAT-401: IPC handlers for code editor capture lifecycle.
 *
 * Channels:
 *   code-editor-capture:start  — start polling
 *   code-editor-capture:stop   — stop polling
 *   code-editor-capture:get    — get last captured text
 *
 * Push channel (main → renderer):
 *   code-editor-capture:change — { text: string, timestamp: number }
 */
import { ipcMain, BrowserWindow } from 'electron';
import {
  getCodeEditorCapture,
  disposeCodeEditorCapture,
} from '../coding/CodeEditorCapture';
import { isConsciousOptimizationActive } from '../config/optimizations';

let captureListenerAttached = false;

export function registerCodeEditorCaptureHandlers(mainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('code-editor-capture:start', () => {
    if (!isConsciousOptimizationActive('useCodeEditorCapture')) {
      return { ok: false, reason: 'useCodeEditorCapture flag is OFF' };
    }

    const capture = getCodeEditorCapture();

    if (!captureListenerAttached) {
      capture.on('code-change', (text: string, timestamp: number) => {
        const win = mainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('code-editor-capture:change', { text, timestamp });
        }
      });
      capture.on('capture-error', (err: Error) => {
        console.warn('[CodeEditorCapture] Capture error:', err.message);
      });
      captureListenerAttached = true;
    }

    capture.start();
    return { ok: true };
  });

  ipcMain.handle('code-editor-capture:stop', () => {
    getCodeEditorCapture().stop();
    return { ok: true };
  });

  ipcMain.handle('code-editor-capture:get', () => {
    return { text: getCodeEditorCapture().getLastText() };
  });
}

export function disposeCodeEditorCaptureHandlers(): void {
  disposeCodeEditorCapture();
  captureListenerAttached = false;
  ipcMain.removeAllListeners('code-editor-capture:start');
  ipcMain.removeAllListeners('code-editor-capture:stop');
  ipcMain.removeAllListeners('code-editor-capture:get');
}
