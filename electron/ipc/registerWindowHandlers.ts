import type { AppState } from '../main';
import { ipcSchemas, parseIpcInput } from '../ipcValidation';
import type { SafeHandle, SafeHandleValidated } from './registerTypes';

type RegisterWindowHandlersDeps = {
  appState: AppState;
  safeHandle: SafeHandle;
  safeHandleValidated: SafeHandleValidated;
};

const ok = <T>(data: T) => ({ success: true as const, data });

export function registerWindowHandlers({ appState, safeHandle, safeHandleValidated }: RegisterWindowHandlersDeps): void {
  safeHandleValidated(
    'update-content-dimensions',
    (args) => [parseIpcInput(ipcSchemas.contentDimensions, args[0], 'update-content-dimensions')] as const,
    async (event, { width, height }) => {
      if (width <= 0 || height <= 0) return;

      const senderWebContents = event.sender;
      const settingsWin = appState.settingsWindowHelper.getSettingsWindow();
      const overlayWin = appState.getWindowHelper().getOverlayWindow();
      const launcherWin = appState.getWindowHelper().getLauncherContentWindow();

      if (settingsWin && !settingsWin.isDestroyed() && settingsWin.webContents.id === senderWebContents.id) {
        appState.settingsWindowHelper.setWindowDimensions(settingsWin, width, height);
      } else if (overlayWin && !overlayWin.isDestroyed() && overlayWin.webContents.id === senderWebContents.id) {
        appState.getWindowHelper().setOverlayDimensions(width, height);
      } else if (launcherWin && !launcherWin.isDestroyed() && launcherWin.webContents.id === senderWebContents.id) {
        // No-op for launcher requests; launcher content is fixed-size.
      }
    },
  );

  safeHandleValidated(
    'set-window-mode',
    (args) => [parseIpcInput(ipcSchemas.windowMode, args[0], 'set-window-mode')] as const,
    async (_event, mode) => {
      appState.getWindowHelper().setWindowMode(mode);
      return { success: true };
    },
  );

  safeHandleValidated(
    'set-overlay-clickthrough',
    (args) => [parseIpcInput(ipcSchemas.booleanFlag, args[0], 'set-overlay-clickthrough')] as const,
    async (_event, enabled) => {
      appState.getWindowHelper().setOverlayClickthrough(enabled);
      return ok({ enabled });
    },
  );

  safeHandle('toggle-window', async () => {
    appState.toggleMainWindow();
    return ok(null);
  });

  safeHandle('show-window', async () => {
    appState.showMainWindow();
    return ok(null);
  });

  safeHandle('hide-window', async () => {
    appState.hideMainWindow();
    return ok(null);
  });

  safeHandle('move-window-left', async () => {
    appState.moveWindowLeft();
    return ok(null);
  });

  safeHandle('move-window-right', async () => {
    appState.moveWindowRight();
    return ok(null);
  });

  safeHandle('move-window-up', async () => {
    appState.moveWindowUp();
    return ok(null);
  });

  safeHandle('move-window-down', async () => {
    appState.moveWindowDown();
    return ok(null);
  });

  safeHandle('center-and-show-window', async () => {
    appState.centerAndShowWindow();
    return ok(null);
  });
}
