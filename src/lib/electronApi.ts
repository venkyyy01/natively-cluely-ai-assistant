import type { ElectronAPI } from '../types/electron';

type ElectronApiRecord = ElectronAPI & Record<string, unknown>;
type ElectronMethod<T extends keyof ElectronAPI> = Extract<ElectronAPI[T], (...args: any[]) => any>;

const createUnavailableElectronMethodError = (method: string): Error => {
  return new Error(
    `Electron API method '${method}' is unavailable. Restart the app or Electron dev process to reload the preload bridge.`
  );
};

let cachedRawElectronApi: ElectronAPI | null = null;
let cachedGuardedElectronApi: ElectronAPI | null = null;

function guardElectronAPI(api: ElectronAPI): ElectronAPI {
  const target = api as ElectronApiRecord;

  return new Proxy({} as ElectronApiRecord, {
    get(_currentTarget, property) {
      const value = target[property as keyof ElectronApiRecord];

      if (typeof value === 'function') {
        return value.bind(target);
      }

      return value;
    },
    has(_currentTarget, property) {
      return property in target;
    },
  }) as ElectronAPI;
}

export function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('Electron API bridge is unavailable');
  }

  if (cachedRawElectronApi !== window.electronAPI || !cachedGuardedElectronApi) {
    cachedRawElectronApi = window.electronAPI;
    cachedGuardedElectronApi = guardElectronAPI(window.electronAPI);
  }

  return cachedGuardedElectronApi;
}

export function requireElectronMethod<T extends keyof ElectronAPI>(method: T): ElectronMethod<T> {
  const api = getElectronAPI() as ElectronApiRecord;
  const candidate = api[method];

  if (typeof candidate !== 'function') {
    throw createUnavailableElectronMethodError(String(method));
  }

  return candidate.bind(api) as ElectronMethod<T>;
}

export function getOptionalElectronMethod<T extends keyof ElectronAPI>(method: T): ElectronMethod<T> | null {
  const api = window.electronAPI as ElectronApiRecord | undefined;
  const candidate = api?.[method];

  if (typeof candidate !== 'function') {
    return null;
  }

  return candidate.bind(api) as ElectronMethod<T>;
}

export function installElectronApiGuard(): void {
  if (!window.electronAPI) {
    return;
  }

  getElectronAPI();
}
