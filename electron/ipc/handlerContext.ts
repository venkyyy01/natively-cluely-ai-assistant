import { app, ipcMain } from "electron"
import { AppState } from "../main"
import {
  type RuntimeCoordinatorLike,
  type SttSupervisorLike,
  type InferenceSupervisorLike,
  type WindowFacadeLike,
  type SettingsFacadeLike,
  type AudioFacadeLike,
  type IntelligenceManagerLike,
  type ScreenshotFacadeLike,
} from "./handlerTypes";

export type SafeHandle = (channel: string, listener: (event: any, ...args: any[]) => Promise<any> | any) => void;
export type SafeHandleValidated = <T extends unknown[]>(
  channel: string,
  parser: (args: unknown[]) => T,
  listener: (event: any, ...args: T) => Promise<any> | any,
) => void;

export type OkFn = <T>(data: T) => { success: true; data: T };
export type FailFn = (code: string, error: unknown, fallbackMessage: string) => { success: false; error: { code: string; message: string } };

export interface HandlerContext {
  safeHandle: SafeHandle;
  safeHandleValidated: SafeHandleValidated;
  ok: OkFn;
  fail: FailFn;
  getInferenceLlmHelper: () => ReturnType<AppState['processingHelper']['getLLMHelper']>;
  getRuntimeCoordinator: () => RuntimeCoordinatorLike | null;
  getSttSupervisor: () => SttSupervisorLike | null;
  getInferenceSupervisor: () => InferenceSupervisorLike | null;
  getWindowFacade: () => WindowFacadeLike | null;
  getSettingsFacade: () => SettingsFacadeLike | null;
  getAudioFacade: () => AudioFacadeLike | null;
  getIntelligenceManager: () => IntelligenceManagerLike;
  initializeInferenceLLMs: () => Promise<void>;
  getScreenshotFacade: () => ScreenshotFacadeLike | null;
  activeChatControllers: Map<string, AbortController>;
  streamChatStartedAt: Map<string, number>;
  appState: AppState;
}

export function createHandlerContext(appState: AppState): HandlerContext {
  const safeHandle: SafeHandle = (channel, listener) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, listener);
  };

  const safeHandleValidated: SafeHandleValidated = (channel, parser, listener) => {
    safeHandle(channel, (event, ...args) => listener(event, ...parser(args)));
  };

  const ok: OkFn = <T>(data: T) => ({ success: true as const, data });
  const fail: FailFn = (code, error, fallbackMessage) => ({
    success: false as const,
    error: {
      code,
      message: error instanceof Error ? error.message : fallbackMessage,
    },
  });

  const activeChatControllers = typeof appState.getActiveChatControllers === 'function'
    ? appState.getActiveChatControllers()
    : new Map<string, AbortController>();
  const streamChatStartedAt = typeof appState.getStreamChatStartedAt === 'function'
    ? appState.getStreamChatStartedAt()
    : new Map<string, number>();

  const getInferenceLlmHelper = () => {
    if (typeof appState.isStealthContainmentActive === 'function' && appState.isStealthContainmentActive()) {
      throw new Error('CONTAINMENT_ACTIVE');
    }

    try {
      const coordinator = (appState as { getCoordinator?: () => unknown }).getCoordinator?.() as
        | { getSupervisor?: (name: string) => unknown }
        | undefined;
      const supervisor = coordinator?.getSupervisor?.('inference') as
        | { getLLMHelper?: () => unknown }
        | undefined;
      const llmHelper = supervisor?.getLLMHelper?.();
      if (llmHelper) {
        return llmHelper as ReturnType<AppState['processingHelper']['getLLMHelper']>;
      }
    } catch (error) {
      if ((error as Error).message === 'CONTAINMENT_ACTIVE') {
        throw error;
      }
      if (app.isPackaged && process.env.NODE_ENV !== 'test') {
        throw new Error('INFERENCE_SUPERVISOR_UNAVAILABLE');
      }
    }

    if (app.isPackaged && process.env.NODE_ENV !== 'test') {
      throw new Error('INFERENCE_SUPERVISOR_UNAVAILABLE');
    }

    return appState.processingHelper.getLLMHelper();
  };

  const getRuntimeCoordinator = (): RuntimeCoordinatorLike | null => {
    try {
      const coordinator = (appState as { getCoordinator?: () => unknown }).getCoordinator?.() as RuntimeCoordinatorLike | undefined;
      if (typeof coordinator?.getSupervisor !== 'function') {
        return null;
      }
      return coordinator;
    } catch {
      return null;
    }
  };

  const getSttSupervisor = (): SttSupervisorLike | null => {
    const coordinator = getRuntimeCoordinator();
    return (coordinator?.getSupervisor?.('stt') as SttSupervisorLike | undefined) ?? null;
  };

  const getInferenceSupervisor = (): InferenceSupervisorLike | null => {
    const coordinator = getRuntimeCoordinator();
    return (coordinator?.getSupervisor?.('inference') as InferenceSupervisorLike | undefined) ?? null;
  };

  const getWindowFacade = (): WindowFacadeLike | null => {
    if ('getWindowFacade' in appState && typeof appState.getWindowFacade === 'function') {
      return appState.getWindowFacade() as WindowFacadeLike;
    }
    return null;
  };

  const getSettingsFacade = (): SettingsFacadeLike | null => {
    if ('getSettingsFacade' in appState && typeof appState.getSettingsFacade === 'function') {
      return appState.getSettingsFacade() as SettingsFacadeLike;
    }
    return null;
  };

  const getAudioFacade = (): AudioFacadeLike | null => {
    if ('getAudioFacade' in appState && typeof appState.getAudioFacade === 'function') {
      return appState.getAudioFacade() as AudioFacadeLike;
    }
    return null;
  };

  const getIntelligenceManager = (): IntelligenceManagerLike => {
    const supervisor = getInferenceSupervisor();
    const intelligenceManager = supervisor?.getIntelligenceManager?.();
    if (intelligenceManager) {
      return intelligenceManager as IntelligenceManagerLike;
    }
    return appState.getIntelligenceManager() as IntelligenceManagerLike;
  };

  const initializeInferenceLLMs = async (): Promise<void> => {
    const supervisor = getInferenceSupervisor();
    if (supervisor?.initializeLLMs) {
      await supervisor.initializeLLMs();
      return;
    }
    await appState.getIntelligenceManager().initializeLLMs();
  };

  const getScreenshotFacade = (): ScreenshotFacadeLike | null => {
    if ('getScreenshotFacade' in appState && typeof appState.getScreenshotFacade === 'function') {
      return appState.getScreenshotFacade() as ScreenshotFacadeLike;
    }
    return null;
  };

  return {
    safeHandle,
    safeHandleValidated,
    ok,
    fail,
    getInferenceLlmHelper,
    getRuntimeCoordinator,
    getSttSupervisor,
    getInferenceSupervisor,
    getWindowFacade,
    getSettingsFacade,
    getAudioFacade,
    getIntelligenceManager,
    initializeInferenceLLMs,
    getScreenshotFacade,
    activeChatControllers,
    streamChatStartedAt,
    appState,
  };
}
