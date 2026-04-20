import { app } from 'electron';
import fs from 'fs';
import path from 'path';

let cachedModule: any | null | undefined;
let cachedError: Error | null = null;

type Candidate = {
  label: string;
  abiDirectory?: string;
  load: () => any;
};

const NODE_MODULE_ABI_VERSION = process.versions.modules || 'unknown';

function readExpectedNodeAbiVersion(abiDirectory: string): string | null {
  const preferredFiles = [
    `index.${process.platform}-${process.arch}.node.abi`,
    'index.node.abi',
  ];
  for (const fileName of preferredFiles) {
    const filePath = path.join(abiDirectory, fileName);
    try {
      const expected = fs.readFileSync(filePath, 'utf8').trim();
      if (expected) {
        return expected;
      }
    } catch {
      // Continue trying fallback paths.
    }
  }

  try {
    const firstAbiFile = fs
      .readdirSync(abiDirectory)
      .find((file) => file.endsWith('.abi'));
    if (!firstAbiFile) {
      return null;
    }
    const expected = fs.readFileSync(path.join(abiDirectory, firstAbiFile), 'utf8').trim();
    return expected || null;
  } catch {
    return null;
  }
}

function assertNativeAbiCompatibility(candidate: Candidate): void {
  if (!candidate.abiDirectory) {
    return;
  }
  const expected = readExpectedNodeAbiVersion(candidate.abiDirectory);
  if (!expected || expected === NODE_MODULE_ABI_VERSION) {
    return;
  }
  throw new Error(
    `Native audio ABI mismatch: built for ${expected}, runtime is ${NODE_MODULE_ABI_VERSION}. Run \`npm run build:native:current\`.`,
  );
}

function resolveNativelyAudioPackageDir(): string | undefined {
  try {
    const packageJsonPath = require.resolve('natively-audio/package.json');
    return path.dirname(packageJsonPath);
  } catch {
    return undefined;
  }
}

function getCandidates(): Candidate[] {
  const packageDir = resolveNativelyAudioPackageDir();
  const candidates: Candidate[] = [
    {
      label: 'package:natively-audio',
      abiDirectory: packageDir,
      load: () => require('natively-audio'),
    },
  ];

  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : null;
  if (appPath) {
    candidates.push({
      label: `appPath:${path.join(appPath, 'native-module')}`,
      abiDirectory: path.join(appPath, 'native-module'),
      load: () => require(path.join(appPath, 'native-module')),
    });
  }

  const cwdPath = path.join(process.cwd(), 'native-module');
  if (!app?.isPackaged) {
    candidates.push({
      label: `cwd:${cwdPath}`,
      abiDirectory: cwdPath,
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
      assertNativeAbiCompatibility(candidate);
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
