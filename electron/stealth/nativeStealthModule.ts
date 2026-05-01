import path from 'node:path';

import type { NativeStealthBindings } from './StealthManager';

interface CachedModuleInfo {
  module: NativeStealthBindings | null;
  timestamp: number;
  attempts: number;
}

// HIGH RELIABILITY FIX: TTL-based cache invalidation instead of permanent caching
let cacheInfo: CachedModuleInfo | undefined;
const CACHE_TTL_SUCCESS_MS = 5 * 60 * 1000; // 5 minutes for successful loads
const CACHE_TTL_FAILURE_MS = 30 * 1000; // 30 seconds for failed loads
const MAX_LOAD_ATTEMPTS = 3;

export function loadNativeStealthModule(options?: { retryOnFailure?: boolean }): NativeStealthBindings | null {
  const now = Date.now();
  
  // HIGH RELIABILITY FIX: Check if cached result is still valid
  if (cacheInfo) {
    const isSuccessfulLoad = cacheInfo.module !== null;
    const ttl = isSuccessfulLoad ? CACHE_TTL_SUCCESS_MS : CACHE_TTL_FAILURE_MS;
    const isExpired = (now - cacheInfo.timestamp) > ttl;
    
    if (!isExpired) {
      // Cache is still valid
      if (isSuccessfulLoad) {
        return cacheInfo.module;
      }
      
      // Failed load is still within TTL
      if (options?.retryOnFailure && cacheInfo.attempts >= MAX_LOAD_ATTEMPTS) {
        console.warn(`[NativeStealthModule] Max retry attempts (${MAX_LOAD_ATTEMPTS}) reached within TTL, waiting for cache expiry`);
        return null;
      }
    } else {
      // Cache expired, clear it
      console.log(`[NativeStealthModule] Cache expired (${isSuccessfulLoad ? 'success' : 'failure'} TTL), retrying load`);
      cacheInfo = undefined;
    }
  }
  
  if (!options?.retryOnFailure && cacheInfo && cacheInfo.module === null) {
    return null;
  }
  
  if (options?.retryOnFailure && cacheInfo && cacheInfo.attempts >= MAX_LOAD_ATTEMPTS) {
    console.warn(`[NativeStealthModule] Max retry attempts (${MAX_LOAD_ATTEMPTS}) reached, giving up. Privacy protection is operating in Layer 0 mode only (setContentProtection).`);
    return cacheInfo?.module || null;
  }
  
  if (options?.retryOnFailure && cacheInfo.attempts >= MAX_LOAD_ATTEMPTS) {
    console.warn(`[NativeStealthModule] Max retry attempts (${MAX_LOAD_ATTEMPTS}) reached, giving up until cache expires`);
    return null;
  }
  
  if (!cacheInfo) {
    cacheInfo = { module: null, timestamp: now, attempts: 0 };
  }
  cacheInfo.attempts++;
  cacheInfo.timestamp = now;
  
  console.log(`[NativeStealthModule] Loading attempt #${cacheInfo.attempts}`);

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
        cacheInfo.module = mod as NativeStealthBindings;
        return cacheInfo.module;
      }
    } catch (error) {
      console.warn('[NativeStealthModule] Candidate failed:', error);
    }
  }

  if (!cacheInfo) {
    cacheInfo = { module: null, timestamp: now, attempts: 0 };
  }
  cacheInfo.module = null;
  console.warn('[NativeStealthModule] All candidates failed. Privacy protection is DEGRADED - operating in Layer 0 mode only (setContentProtection). Native stealth APIs are unavailable.');
  return cacheInfo.module;
}

export function clearNativeStealthModuleCache(): void {
  cacheInfo = undefined;
  console.log('[NativeStealthModule] Cache cleared');
}

/**
 * HIGH RELIABILITY FIX: Get current cache status for debugging
 */
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
    ttlRemainingMs
  };
}
