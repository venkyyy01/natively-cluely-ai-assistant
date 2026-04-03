import { app } from 'electron';
import path from 'path';

let cachedModule: any | null | undefined;
let cachedError: Error | null = null;

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
  if (cachedModule !== undefined) {
    return cachedModule;
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
          cachedModule = mod;
          cachedError = null;
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

  cachedModule = null;
  cachedError = new Error(
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

  console.error('[NativeAudio]', cachedError.message);
  return null;
}

export function getNativeAudioLoadError(): Error | null {
  loadNativeAudioModule();
  return cachedError;
}

export function assertNativeAudioAvailable(context: string): any {
  const mod = loadNativeAudioModule();
  if (!mod) {
    const error = getNativeAudioLoadError() || new Error('Native audio module unavailable');
    throw new Error(`[${context}] ${error.message}`);
  }
  return mod;
}
