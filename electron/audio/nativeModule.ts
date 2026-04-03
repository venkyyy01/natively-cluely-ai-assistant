import { app } from 'electron';
import path from 'path';

interface CachedModuleInfo {
  module: any | null;
  error: Error | null;
  timestamp: number;
}

// HIGH RELIABILITY FIX: TTL-based cache invalidation instead of permanent caching
let cacheInfo: CachedModuleInfo | undefined;
const CACHE_TTL_SUCCESS_MS = 5 * 60 * 1000; // 5 minutes for successful loads
const CACHE_TTL_FAILURE_MS = 30 * 1000; // 30 seconds for failed loads

type Candidate = {
  label: string;
  load: () => any;
};

function getCandidates(): Candidate[] {
  const candidates: Candidate[] = [
    {
      label: 'package:natively-audio',
      load: () => require('natively-audio'),
    },
  ];

  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : null;
  if (appPath) {
    candidates.push({
      label: `appPath:${path.join(appPath, 'native-module')}`,
      load: () => require(path.join(appPath, 'native-module')),
    });
  }

  const cwdPath = path.join(process.cwd(), 'native-module');
  if (!app?.isPackaged) {
    candidates.push({
      label: `cwd:${cwdPath}`,
      load: () => require(cwdPath),
    });
  }

  return candidates;
}

export function loadNativeAudioModule(): any | null {
  const now = Date.now();
  
  // HIGH RELIABILITY FIX: Check if cached result is still valid
  if (cacheInfo) {
    const isSuccessfulLoad = cacheInfo.module !== null;
    const ttl = isSuccessfulLoad ? CACHE_TTL_SUCCESS_MS : CACHE_TTL_FAILURE_MS;
    const isExpired = (now - cacheInfo.timestamp) > ttl;
    
    if (!isExpired) {
      // Cache is still valid, return cached result
      return cacheInfo.module;
    } else {
      // Cache expired, clear it and retry
      console.log(`[NativeAudio] Cache expired (${isSuccessfulLoad ? 'success' : 'failure'} TTL), retrying load`);
      cacheInfo = undefined;
    }
  }

  const errors: string[] = [];
  console.log(`[NativeAudio] Loading native module for ${process.platform}-${process.arch}...`);

  for (const candidate of getCandidates()) {
    try {
      console.log(`[NativeAudio] Attempting to load from: ${candidate.label}`);
      const mod = candidate.load();
      
      // Verify the module has expected exports
      if (mod && typeof mod === 'object') {
        console.log(`[NativeAudio] Module exports:`, Object.keys(mod));
        
        if (mod.MicrophoneCapture && typeof mod.MicrophoneCapture === 'function') {
          // HIGH RELIABILITY FIX: Cache successful load with timestamp
          cacheInfo = {
            module: mod,
            error: null,
            timestamp: now
          };
          console.log(`[NativeAudio] ✅ Successfully loaded native module from ${candidate.label}`);
          console.log(`[NativeAudio] MicrophoneCapture constructor available:`, typeof mod.MicrophoneCapture);
          return mod;
        } else {
          console.warn(`[NativeAudio] ⚠️  Module loaded but missing MicrophoneCapture export from ${candidate.label}`);
          errors.push(`${candidate.label}: Missing MicrophoneCapture export`);
        }
      } else {
        console.warn(`[NativeAudio] ⚠️  Module loaded but not an object from ${candidate.label}`);
        errors.push(`${candidate.label}: Invalid module type (${typeof mod})`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      console.error(`[NativeAudio] ❌ Failed to load from ${candidate.label}:`, message);
      errors.push(`${candidate.label}: ${message}`);
    }
  }

  // HIGH RELIABILITY FIX: Cache failure with timestamp and TTL
  const failureError = new Error(
    [
      `❌ Native audio module failed to load for ${process.platform}-${process.arch}.`,
      'Possible solutions:',
      '1. Run `npm run build:native:current` for local development',
      '2. Ensure packaged native binaries are present',
      '3. Check microphone permissions on macOS',
      '4. Verify native-module directory exists',
      '',
      'Detailed errors:',
      ...errors,
    ].join('\n')
  );

  cacheInfo = {
    module: null,
    error: failureError,
    timestamp: now
  };

  console.error('[NativeAudio]', failureError.message);
  return null;
}

export function getNativeAudioLoadError(): Error | null {
  loadNativeAudioModule();
  return cacheInfo?.error || null;
}

export function assertNativeAudioAvailable(context: string): any {
  const mod = loadNativeAudioModule();
  if (!mod) {
    const error = getNativeAudioLoadError() || new Error('Native audio module unavailable');
    throw new Error(`[${context}] ${error.message}`);
  }
  return mod;
}

/**
 * HIGH RELIABILITY FIX: Clear native audio module cache for testing or after rebuild
 */
export function clearNativeAudioModuleCache(): void {
  cacheInfo = undefined;
  console.log('[NativeAudio] Cache cleared');
}

/**
 * HIGH RELIABILITY FIX: Get current cache status for debugging
 */
export function getNativeAudioModuleCacheStatus(): {
  cached: boolean;
  successful: boolean;
  ageMs: number;
  ttlRemainingMs: number;
  error?: string;
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
    ageMs,
    ttlRemainingMs,
    error: cacheInfo.error?.message
  };
}
