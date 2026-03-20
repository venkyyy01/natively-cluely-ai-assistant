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

  for (const candidate of getCandidates()) {
    try {
      const mod = candidate.load();
      cachedModule = mod;
      cachedError = null;
      console.log(`[NativeAudio] Loaded native module from ${candidate.label}`);
      return mod;
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      errors.push(`${candidate.label}: ${message}`);
    }
  }

  cachedModule = null;
  cachedError = new Error(
    [
      `Native audio module failed to load for ${process.platform}-${process.arch}.`,
      'Build it with `npm run build:native:current` for local development, or ensure packaged native binaries are present.',
      ...errors,
    ].join('\n')
  );

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
