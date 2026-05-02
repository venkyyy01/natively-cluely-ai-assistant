import path from 'node:path';

import type { NativeStealthBindings } from './StealthManager';

// ============================================================================
// T-019: Stealth health tracking for mission-critical reliability
// ============================================================================

export type StealthHealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'unknown';

export interface StealthHealth {
  status: StealthHealthStatus;
  lastError: string | null;
  lastCheckTimestamp: number;
  failureCount: number;
  successCount: number;
}

let _health: StealthHealth = {
  status: 'unknown',
  lastError: null,
  lastCheckTimestamp: 0,
  failureCount: 0,
  successCount: 0,
};

export function getStealthHealth(): Readonly<StealthHealth> {
  return _health;
}

// ============================================================================
// Module loading with TTL-based cache and attempt tracking
// ============================================================================

interface CachedModuleInfo {
  module: NativeStealthBindings | null;
  timestamp: number;
  attempts: number;
}

let cacheInfo: CachedModuleInfo | undefined;
const CACHE_TTL_SUCCESS_MS = 5 * 60 * 1000;
const CACHE_TTL_FAILURE_MS = 30 * 1000;
const MAX_LOAD_ATTEMPTS = 3;

export function loadNativeStealthModule(options?: {
  retryOnFailure?: boolean;
}): NativeStealthBindings | null {
  const now = Date.now();
  const retry = options?.retryOnFailure ?? true;

  // Check TTL cache
  if (cacheInfo) {
    const ttl =
      cacheInfo.module !== null ? CACHE_TTL_SUCCESS_MS : CACHE_TTL_FAILURE_MS;
    const expired = now - cacheInfo.timestamp > ttl;

    if (!expired) {
      if (cacheInfo.module !== null) {
        return cacheInfo.module;
      }

      // Failed load within TTL — only retry if caller explicitly wants to and
      // we haven't exceeded per-window attempt cap.
      if (retry && cacheInfo.attempts < MAX_LOAD_ATTEMPTS) {
        cacheInfo = undefined;
      } else {
        return null;
      }
    } else {
      // TTL expired — clear cache to force re-attempt
      cacheInfo = undefined;
    }
  }

  // Fresh attempt
  if (!cacheInfo) {
    cacheInfo = { module: null, timestamp: now, attempts: 0 };
  }

  if (cacheInfo.attempts >= MAX_LOAD_ATTEMPTS) {
    _health.status = 'unavailable';
    _health.lastError = 'Max load attempts exceeded within failure TTL';
    _health.lastCheckTimestamp = now;
    return null;
  }

  cacheInfo.attempts++;
  cacheInfo.timestamp = now;

  const candidates = [
    () => require('natively-audio'),
    () => {
      try {
        const electronModule = require('electron');
        const appPath = electronModule?.app?.getAppPath?.();
        if (!appPath) return null;
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
        cacheInfo.module = mod as NativeStealthBindings;
        _health.status = 'healthy';
        _health.lastError = null;
        _health.lastCheckTimestamp = now;
        _health.successCount++;
        return cacheInfo.module;
      }
    } catch (error) {
      // Individual candidate failed — try next
    }
  }

  cacheInfo.module = null;
  _health.status = 'unavailable';
  _health.lastError = 'All candidates failed — native module unavailable';
  _health.lastCheckTimestamp = now;
  _health.failureCount++;
  return null;
}

export function clearNativeStealthModuleCache(): void {
  cacheInfo = undefined;
}

export function getNativeStealthModuleCacheStatus(): {
  cached: boolean;
  successful: boolean;
  attempts: number;
  ageMs: number;
  ttlRemainingMs: number;
} | null {
  if (!cacheInfo) return null;

  const now = Date.now();
  const ageMs = now - cacheInfo.timestamp;
  const isSuccessfulLoad = cacheInfo.module !== null;
  const ttl = isSuccessfulLoad ? CACHE_TTL_SUCCESS_MS : CACHE_TTL_FAILURE_MS;
  const ttlRemainingMs = Math.max(0, ttl - ageMs);

  return {
    cached: true,
    successful: isSuccessfulLoad,
    attempts: cacheInfo.attempts,
    ageMs,
    ttlRemainingMs,
  };
}

// ============================================================================
// T-020: Health-aware native process list provider
// ============================================================================

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
}

/**
 * Creates a cached, health-aware process-list provider.
 *
 * - Loads the native module once and caches the reference.
 * - Re-validates on each call: if the module becomes unavailable, the cached
 *   reference is cleared so a retry is attempted after the failure TTL expires.
 * - Logs degradation clearly when the native module is unavailable.
 * - Returns empty array on failure (detectors treat this as "no data", not
 *   "all clear" — combine with `getStealthHealth()` for health awareness).
 */
export function createNativeProcessesProvider(options?: {
  logger?: Pick<Console, 'warn'>;
  label?: string;
}): () => ProcessInfo[] {
  const logger = options?.logger ?? console;
  const label = options?.label ?? 'NativeProcesses';

  let moduleRef: NativeStealthBindings | null | undefined;
  let lastHealthLog: StealthHealthStatus = 'unknown';

  return () => {
    const now = Date.now();

    // Load or refresh module reference
    if (moduleRef === undefined) {
      moduleRef = loadNativeStealthModule({ retryOnFailure: false });
    }

    const health = getStealthHealth();

    // If the module was previously available but health now says unavailable
    // (cache expired and reload failed), clear reference so we retry later.
    if (moduleRef !== null && health.status === 'unavailable') {
      moduleRef = undefined;
    }

    // Re-check if reference was cleared
    if (moduleRef === undefined) {
      moduleRef = loadNativeStealthModule({ retryOnFailure: false });
    }

    if (health.status !== lastHealthLog) {
      lastHealthLog = health.status;
      if (health.status === 'unavailable') {
        logger.warn(
          `[${label}] Native module unavailable — process detection degraded. ` +
            `Failure #${health.failureCount}. Last error: ${health.lastError}`,
        );
      } else if (health.status === 'healthy') {
        logger.warn(
          `[${label}] Native module recovered — process detection restored`,
        );
      }
    }

    if (!moduleRef || !moduleRef.getRunningProcesses) {
      return [];
    }

    try {
      return moduleRef.getRunningProcesses();
    } catch (error) {
      _health.status = 'degraded';
      _health.lastError = `getRunningProcesses() threw: ${String(error)}`;
      _health.lastCheckTimestamp = now;
      return [];
    }
  };
}
