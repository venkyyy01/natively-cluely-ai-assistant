import { ipcMain } from 'electron';
import type { HoverModeOrchestrator, HoverModeState } from '../hover/HoverModeOrchestrator';
import type { HoverResponse } from '../hover/HoverLLMResponder';

type SafeHandle = (channel: string, handler: (...args: any[]) => Promise<any>) => void;

interface HoverModeIpcPayload {
  cursorPosition: { x: number; y: number };
  type: 'code' | 'mcq' | 'subjective';
  content: string;
  language?: string;
  optionLabel?: string;
  justification?: string;
}

export interface RegisterHoverModeHandlersDeps {
  orchestrator: HoverModeOrchestrator;
  safeHandle: SafeHandle;
  getMainWindow: () => Electron.BrowserWindow | null;
}

export function registerHoverModeHandlers({
  orchestrator,
  safeHandle,
  getMainWindow,
}: RegisterHoverModeHandlersDeps): void {
  orchestrator.on('response', (payload: HoverResponse & { cursorPosition: { x: number; y: number } }) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hover-response', {
        cursorPosition: payload.cursorPosition,
        type: payload.type,
        content: payload.content,
        language: payload.language,
        optionLabel: payload.optionLabel,
        justification: payload.justification,
      } as HoverModeIpcPayload);
    }
  });

  orchestrator.on('state-changed', (state: HoverModeState) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hover-state-changed', state);
    }
  });

  safeHandle('enable-hover-mode', async () => {
    orchestrator.setEnabled(true);
    return { success: true, enabled: true };
  });

  safeHandle('disable-hover-mode', async () => {
    orchestrator.setEnabled(false);
    return { success: true, enabled: false };
  });

  safeHandle('get-hover-mode-state', async () => {
    return orchestrator.getState();
  });

  safeHandle('toggle-hover-mode', async () => {
    const currentState = orchestrator.isEnabled();
    orchestrator.setEnabled(!currentState);
    return { success: true, enabled: orchestrator.isEnabled() };
  });
}

export default registerHoverModeHandlers;
