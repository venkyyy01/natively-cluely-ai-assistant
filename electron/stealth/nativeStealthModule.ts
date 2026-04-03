import path from 'node:path';

import type { NativeStealthBindings } from './StealthManager';

let cachedModule: NativeStealthBindings | null | undefined;
let loadAttempts = 0;
const MAX_LOAD_ATTEMPTS = 3;

export function loadNativeStealthModule(options?: { retryOnFailure?: boolean }): NativeStealthBindings | null {
  if (cachedModule !== undefined && cachedModule !== null) {
    return cachedModule;
  }
  
  if (options?.retryOnFailure && loadAttempts >= MAX_LOAD_ATTEMPTS) {
    console.warn(`[NativeStealthModule] Max retry attempts (${MAX_LOAD_ATTEMPTS}) reached, giving up`);
    return cachedModule;
  }
  
  loadAttempts++;
  console.log(`[NativeStealthModule] Loading attempt #${loadAttempts}`);

  const candidates = [
    () => require('natively-audio'),
    () => {
      try {
        const electronModule = require('electron');
        const appPath = electronModule?.app?.getAppPath?.();
        if (!appPath) {
          return null;
        }
        return require(path.join(appPath, 'native-module'));
      } catch {
        return null;
      }
    },
    () => require(path.join(process.cwd(), 'native-module')),
  ];

  for (const candidate of candidates) {
    try {
      const mod = candidate();
      if (mod) {
        console.log('[NativeStealthModule] Successfully loaded native module');
        cachedModule = mod as NativeStealthBindings;
        return cachedModule;
      }
    } catch (error) {
      console.warn('[NativeStealthModule] Candidate failed:', error);
      // Fall through to the next candidate.
    }
  }

  cachedModule = null;
  console.warn('[NativeStealthModule] All candidates failed, will retry on next call if retryOnFailure=true');
  return cachedModule;
}

export function clearNativeStealthModuleCache(): void {
  cachedModule = undefined;
  loadAttempts = 0;
  console.log('[NativeStealthModule] Cache cleared');
}
