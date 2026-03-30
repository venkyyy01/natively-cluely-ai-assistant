import path from 'node:path';

import type { NativeStealthBindings } from './StealthManager';

let cachedModule: NativeStealthBindings | null | undefined;

export function loadNativeStealthModule(): NativeStealthBindings | null {
  if (cachedModule !== undefined) {
    return cachedModule;
  }

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
        cachedModule = mod as NativeStealthBindings;
        return cachedModule;
      }
    } catch {
      // Fall through to the next candidate.
    }
  }

  cachedModule = null;
  return cachedModule;
}
