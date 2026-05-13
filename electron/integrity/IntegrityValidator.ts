// electron/integrity/IntegrityValidator.ts
// Runtime boot-time integrity checks for native modules and critical TS imports.
// Called from bootstrap.ts before app.whenReady() to detect corrupted or
// tampered installations early.

import path from 'path';
import { performance } from 'perf_hooks';

export interface IntegrityResult {
  success: boolean;
  moduleCount: number;
  durationMs: number;
  errors: string[];
}

/**
 * Relative paths to critical modules that must resolve at boot.
 * These are checked via require.resolve() against the app's dist-electron directory.
 */
export const CRITICAL_MODULES: string[] = [
  'main.js',
  'preload.js',
  'stealth/shellPreload.js',
];

/**
 * Validates app integrity at boot by verifying that:
 * 1. The native `natively-audio` module loads without error
 * 2. Critical TypeScript-compiled modules resolve correctly
 *
 * Must complete within 2000ms on an 8GB machine.
 */
export async function validateIntegrity(): Promise<IntegrityResult> {
  const start = performance.now();
  const errors: string[] = [];
  let moduleCount = 0;

  // 1. Verify native module (natively-audio) loads via require()
  try {
    require('natively-audio');
    moduleCount++;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const expectedPath = resolveNativeModulePath();
    const diagnostic = `Native module load failed — expected path: ${expectedPath}, error: ${errorMessage}`;
    errors.push(diagnostic);
    console.error(`[Integrity] native_module: ${expectedPath} — ${errorMessage}`);
  }

  // 2. Verify critical TypeScript imports resolve via require.resolve()
  const baseDir = path.resolve(__dirname, '..');
  for (const modulePath of CRITICAL_MODULES) {
    const fullPath = path.join(baseDir, modulePath);
    try {
      require.resolve(fullPath);
      moduleCount++;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      errors.push(`Unresolved module: ${fullPath} — ${errorMessage}`);
      console.error(`[Integrity] ts_import: ${fullPath} — ${errorMessage}`);
    }
  }

  const durationMs = Math.round((performance.now() - start) * 100) / 100;
  const success = errors.length === 0;

  if (success) {
    console.log(`[Integrity] Validated ${moduleCount} modules in ${durationMs}ms`);
  }

  return { success, moduleCount, durationMs, errors };
}

/**
 * Resolves the expected path for the natively-audio native module.
 * Used for diagnostic logging when the module fails to load.
 */
function resolveNativeModulePath(): string {
  try {
    return require.resolve('natively-audio');
  } catch {
    // If resolve itself fails, construct the expected path manually
    return path.resolve(__dirname, '../../node_modules/natively-audio');
  }
}
