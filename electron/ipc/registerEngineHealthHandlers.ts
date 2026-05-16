/**
 * NAT-105: Engine Health IPC
 *
 * Exposes a single `get-engine-health` invoke handler that the renderer
 * uses to drive the engine-health status panel.  Each subsystem is probed
 * with a best-effort call and never throws — unknown = degraded.
 */
import type { AppState } from '../main';
import { isOptimizationActive } from '../config/optimizations';
import { resolveFoundationModelsIntentHelperPath } from '../llm/providers/FoundationModelsIntentHelperPath';
import type { SafeHandle } from './registerTypes';

export interface EngineHealthReport {
  ane: 'ok' | 'disabled' | 'error';
  foundationIntent: 'ok' | 'disabled' | 'unavailable';
  stealth: 'ok' | 'degraded' | 'off';
  ollamaMetal: 'ok' | 'unavailable' | 'unknown';
  workerThreadCount: number;
  timestamp: number;
}

type RegisterEngineHealthDeps = {
  appState: AppState;
  safeHandle: SafeHandle;
};

export function registerEngineHealthHandlers({ appState, safeHandle }: RegisterEngineHealthDeps): void {
  safeHandle('get-engine-health', async (): Promise<EngineHealthReport> => {
    const timestamp = Date.now();

    // --- ANE ---
    let ane: EngineHealthReport['ane'] = 'disabled';
    try {
      if (isOptimizationActive('useANEEmbeddings')) {
        const accel = (appState as any).accelerationManager;
        if (accel) {
          const provider = accel.getANEProvider?.();
          ane = provider?.isInitialized?.() ? 'ok' : 'error';
        } else {
          ane = 'error';
        }
      }
    } catch {
      ane = 'error';
    }

    // --- Foundation Models Intent ---
    let foundationIntent: EngineHealthReport['foundationIntent'] = 'disabled';
    try {
      if (isOptimizationActive('useFoundationModelsIntent')) {
        const helperPath = resolveFoundationModelsIntentHelperPath();
        foundationIntent = helperPath ? 'ok' : 'unavailable';
      }
    } catch {
      foundationIntent = 'unavailable';
    }

    // --- Stealth ---
    let stealth: EngineHealthReport['stealth'] = 'off';
    try {
      const isUndetectable: boolean = appState.getUndetectable?.() ?? false;
      if (isUndetectable) {
        const stealthMgr = (appState as any).stealthManager
          ?? (appState as any).getStealthManager?.();
        if (stealthMgr) {
          const degraded: boolean = stealthMgr.isDegraded?.() ?? false;
          stealth = degraded ? 'degraded' : 'ok';
        } else {
          stealth = 'ok';
        }
      }
    } catch {
      stealth = 'degraded';
    }

    // --- Ollama Metal ---
    // Ollama on macOS arm64 always uses Metal when running.
    // Probe the local API instead of using non-existent manager methods.
    let ollamaMetal: EngineHealthReport['ollamaMetal'] = 'unknown';
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 1200);
      const resp = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
      clearTimeout(tid);
      if (resp.ok) {
        ollamaMetal = process.platform === 'darwin' && process.arch === 'arm64' ? 'ok' : 'unavailable';
      } else {
        ollamaMetal = 'unavailable';
      }
    } catch {
      ollamaMetal = 'unavailable';
    }

    // --- Worker thread count ---
    let workerThreadCount = 4;
    try {
      const { getEffectiveWorkerCount } = await import('../config/optimizations');
      workerThreadCount = getEffectiveWorkerCount();
    } catch {
      // best effort
    }

    return { ane, foundationIntent, stealth, ollamaMetal, workerThreadCount, timestamp };
  });
}
