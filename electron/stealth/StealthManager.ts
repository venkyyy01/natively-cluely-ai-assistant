import { isOptimizationActive } from '../config/optimizations';
import os from 'os';

export interface StealthConfig {
  enabled: boolean;
}

export interface StealthWindowOptions {
  contentProtection: boolean;
  skipTaskbar: boolean;
  excludeFromCapture: boolean;
}

export interface PlatformCapabilities {
  platform: string;
  supportsContentProtection: boolean;
  supportsNativeExclusion: boolean;
}

export class StealthManager {
  private config: StealthConfig;

  constructor(config: StealthConfig) {
    this.config = config;
  }

  getBrowserWindowOptions(): StealthWindowOptions {
    const enabled = this.config.enabled && isOptimizationActive('useStealthMode');

    return {
      contentProtection: enabled,
      skipTaskbar: enabled,
      excludeFromCapture: enabled,
    };
  }

  getPlatformCapabilities(): PlatformCapabilities {
    const platform = os.platform();

    return {
      platform,
      supportsContentProtection: platform === 'darwin' || platform === 'win32',
      supportsNativeExclusion: platform === 'darwin',
    };
  }

  applyToWindow(win: { setContentProtection: (v: boolean) => void; setSkipTaskbar?: (v: boolean) => void }): void {
    if (!this.config.enabled || !isOptimizationActive('useStealthMode')) {
      return;
    }

    try {
      win.setContentProtection(true);
    } catch (e) {
      console.warn('[StealthManager] setContentProtection failed:', e);
    }

    if (typeof win.setSkipTaskbar === 'function') {
      try {
        win.setSkipTaskbar(true);
      } catch (e) {
        console.warn('[StealthManager] setSkipTaskbar failed:', e);
      }
    }

    console.log('[StealthManager] Content protection enabled');
  }
}
