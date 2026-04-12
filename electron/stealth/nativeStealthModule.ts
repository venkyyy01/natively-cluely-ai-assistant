import path from 'node:path';

import type { NativeStealthBindings } from './StealthManager';

let cachedModule: NativeStealthBindings | null | undefined;
let loadAttempts = 0;
const MAX_LOAD_ATTEMPTS = 3;

export function loadNativeStealthModule(options?: { retryOnFailure?: boolean }): NativeStealthBindings | null {
  if (cachedModule !== undefined && cachedModule !== null) {
    return cachedModule;
  }
  
  if (!options?.retryOnFailure && cachedModule === null) {
    return null;
  }
  
  if (options?.retryOnFailure && loadAttempts >= MAX_LOAD_ATTEMPTS) {
    console.warn(`[NativeStealthModule] Max retry attempts (${MAX_LOAD_ATTEMPTS}) reached, giving up. Privacy protection is operating in Layer 0 mode only (setContentProtection).`);
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
    }
  }

  cachedModule = null;
  console.warn('[NativeStealthModule] All candidates failed. Privacy protection is DEGRADED - operating in Layer 0 mode only (setContentProtection). Native stealth APIs are unavailable.');
  return cachedModule;
}

export function clearNativeStealthModuleCache(): void {
  cachedModule = undefined;
  loadAttempts = 0;
  console.log('[NativeStealthModule] Cache cleared');
}
