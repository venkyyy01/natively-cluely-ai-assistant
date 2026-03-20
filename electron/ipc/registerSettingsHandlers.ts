import { app } from 'electron';
import type { AppState } from '../main';
import { AI_RESPONSE_LANGUAGES, RECOGNITION_LANGUAGES } from '../config/languages';
import { ipcSchemas, parseIpcInput } from '../ipcValidation';
import type { SafeHandle, SafeHandleValidated } from './registerTypes';

type RegisterSettingsHandlersDeps = {
  appState: AppState;
  safeHandle: SafeHandle;
  safeHandleValidated: SafeHandleValidated;
};

export function registerSettingsHandlers({ appState, safeHandle, safeHandleValidated }: RegisterSettingsHandlersDeps): void {
  safeHandle('get-recognition-languages', async () => RECOGNITION_LANGUAGES);
  safeHandle('get-ai-response-languages', async () => AI_RESPONSE_LANGUAGES);

  safeHandleValidated('set-ai-response-language', (args) => [parseIpcInput(ipcSchemas.aiResponseLanguage, args[0], 'set-ai-response-language')] as const, async (_event, language) => {
    const { CredentialsManager } = require('../services/CredentialsManager');
    CredentialsManager.getInstance().setAiResponseLanguage(language);
    appState.processingHelper?.getLLMHelper?.().setAiResponseLanguage?.(language);
    return { success: true };
  });

  safeHandle('get-stt-language', async () => {
    const { CredentialsManager } = require('../services/CredentialsManager');
    return CredentialsManager.getInstance().getSttLanguage();
  });

  safeHandle('get-ai-response-language', async () => {
    const { CredentialsManager } = require('../services/CredentialsManager');
    return CredentialsManager.getInstance().getAiResponseLanguage();
  });

  safeHandleValidated('toggle-settings-window', (args) => [parseIpcInput(ipcSchemas.settingsWindowCoords, args[0] || {}, 'toggle-settings-window')] as const, (_event, { x, y }) => {
    appState.settingsWindowHelper.toggleWindow(x, y);
  });

  safeHandle('close-settings-window', () => {
    appState.settingsWindowHelper.closeWindow();
  });

  safeHandle('set-undetectable', async (_event, state: boolean) => {
    appState.setUndetectable(state);
    return { success: true };
  });

  safeHandle('set-disguise', async (_event, mode: 'terminal' | 'settings' | 'activity' | 'none') => {
    appState.setDisguise(mode);
    return { success: true };
  });

  safeHandle('get-undetectable', async () => appState.getUndetectable());
  safeHandle('get-disguise', async () => appState.getDisguise());

  safeHandle('set-open-at-login', async (_event, openAtLogin: boolean) => {
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: false,
      path: app.getPath('exe'),
    });
    return { success: true };
  });

  safeHandle('get-open-at-login', async () => app.getLoginItemSettings().openAtLogin);
}
