import { shell } from 'electron';
import type { AppState } from '../main';
import { DatabaseManager } from '../db/DatabaseManager';
import { AudioDevices } from '../audio/AudioDevices';
import { ipcSchemas, parseIpcInput } from '../ipcValidation';
import type { SafeHandle, SafeHandleValidated } from './registerTypes';

type RegisterMeetingHandlersDeps = {
  appState: AppState;
  safeHandle: SafeHandle;
  safeHandleValidated: SafeHandleValidated;
};

type RuntimeCoordinatorLike = {
  shouldManageLifecycle?: () => boolean;
  activate?: (metadata?: unknown) => Promise<void>;
  deactivate?: () => Promise<void>;
  getSupervisor?: (name: string) => unknown;
};

type AudioSupervisorLike = {
  startAudioTest?: (deviceId?: string) => Promise<void>;
  stopAudioTest?: () => Promise<void>;
};

type SttSupervisorLike = {
  setRecognitionLanguage?: (language: string) => Promise<void>;
};

type InferenceSupervisorLike = {
  getRAGManager?: () => ReturnType<AppState['getRAGManager']>;
};

function getRuntimeCoordinator(appState: AppState): RuntimeCoordinatorLike | null {
  if (!('getCoordinator' in appState) || typeof appState.getCoordinator !== 'function') {
    return null;
  }

  return appState.getCoordinator() as RuntimeCoordinatorLike;
}

function getAudioSupervisor(appState: AppState): AudioSupervisorLike | null {
  const coordinator = getRuntimeCoordinator(appState);
  if (!coordinator?.shouldManageLifecycle?.() || typeof coordinator.getSupervisor !== 'function') {
    return null;
  }

  return coordinator.getSupervisor('audio') as AudioSupervisorLike;
}

function getSttSupervisor(appState: AppState): SttSupervisorLike | null {
  const coordinator = getRuntimeCoordinator(appState);
  if (!coordinator?.shouldManageLifecycle?.() || typeof coordinator.getSupervisor !== 'function') {
    return null;
  }

  return coordinator.getSupervisor('stt') as SttSupervisorLike;
}

function getInferenceRagManager(appState: AppState): ReturnType<AppState['getRAGManager']> {
  const coordinator = getRuntimeCoordinator(appState);
  if (coordinator?.shouldManageLifecycle?.() && typeof coordinator.getSupervisor === 'function') {
    const supervisor = coordinator.getSupervisor('inference') as InferenceSupervisorLike;
    if (typeof supervisor?.getRAGManager === 'function') {
      return supervisor.getRAGManager();
    }
  }

  return appState.getRAGManager();
}

export function registerMeetingHandlers({ appState, safeHandle, safeHandleValidated }: RegisterMeetingHandlersDeps): void {
  safeHandle('get-input-devices', async () => AudioDevices.getInputDevices());

  safeHandle('get-output-devices', async () => AudioDevices.getOutputDevices());

  safeHandle('start-audio-test', async (_event, deviceId?: string) => {
    const audioSupervisor = getAudioSupervisor(appState);
    if (audioSupervisor?.startAudioTest) {
      await audioSupervisor.startAudioTest(deviceId);
    } else {
      appState.startAudioTest(deviceId);
    }
    return { success: true };
  });

  safeHandle('stop-audio-test', async () => {
    const audioSupervisor = getAudioSupervisor(appState);
    if (audioSupervisor?.stopAudioTest) {
      await audioSupervisor.stopAudioTest();
    } else {
      appState.stopAudioTest();
    }
    return { success: true };
  });

  safeHandleValidated('set-recognition-language', (args) => [parseIpcInput(ipcSchemas.recognitionLanguage, args[0], 'set-recognition-language')] as const, async (_event, key) => {
    const sttSupervisor = getSttSupervisor(appState);
    if (sttSupervisor?.setRecognitionLanguage) {
      await sttSupervisor.setRecognitionLanguage(key);
    } else {
      appState.setRecognitionLanguage(key);
    }
    return { success: true };
  });

  safeHandleValidated('start-meeting', (args) => [parseIpcInput(ipcSchemas.startMeetingMetadata, args[0], 'start-meeting')] as const, async (_event, metadata) => {
    try {
      const coordinator = getRuntimeCoordinator(appState);
      if (coordinator?.shouldManageLifecycle?.() && typeof coordinator.activate === 'function') {
        await coordinator.activate(metadata);
      } else {
        await appState.startMeeting(metadata);
      }
      return { success: true };
    } catch (error: any) {
      console.error('Error starting meeting:', error);
      return { success: false, error: error.message };
    }
  });

  safeHandle('end-meeting', async () => {
    try {
      const coordinator = getRuntimeCoordinator(appState);
      if (coordinator?.shouldManageLifecycle?.() && typeof coordinator.deactivate === 'function') {
        await coordinator.deactivate();
      } else {
        await appState.endMeeting();
      }
      return { success: true };
    } catch (error: any) {
      console.error('Error ending meeting:', error);
      return { success: false, error: error.message };
    }
  });

  safeHandle('get-recent-meetings', async () => DatabaseManager.getInstance().getRecentMeetings(50));

  safeHandle('get-meeting-details', async (_event, id) => DatabaseManager.getInstance().getMeetingDetails(id));

  safeHandleValidated('update-meeting-title', (args) => [parseIpcInput(ipcSchemas.updateMeetingTitlePayload, args[0], 'update-meeting-title')] as const, async (_event, { id, title }) => {
    return DatabaseManager.getInstance().updateMeetingTitle(id, title);
  });

  safeHandleValidated('update-meeting-summary', (args) => [parseIpcInput(ipcSchemas.updateMeetingSummaryPayload, args[0], 'update-meeting-summary')] as const, async (_event, { id, updates }) => {
    return DatabaseManager.getInstance().updateMeetingSummary(id, updates);
  });

  safeHandle('seed-demo', async () => {
    DatabaseManager.getInstance().seedDemoMeeting();
    const ragManager = getInferenceRagManager(appState);
    if (ragManager && ragManager.isReady()) {
      ragManager.reprocessMeeting('demo-meeting').catch(console.error);
    }
    return { success: true };
  });

  safeHandle('flush-database', async () => {
    const result = DatabaseManager.getInstance().clearAllData();
    return { success: result };
  });

  safeHandle('open-external', async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        await shell.openExternal(url);
      } else {
        console.warn(`[IPC] Blocked potentially unsafe open-external: ${url}`);
      }
      return { success: true };
    } catch (error: any) {
      console.error('[IPC] Failed to open external URL:', error);
      return { success: false, error: error?.message || 'Failed to open external URL' };
    }
  });
}
