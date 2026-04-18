import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

function installElectronMock(): () => void {
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: true,
          getAppPath(): string {
            return '/tmp';
          },
          getPath(): string {
            return '/tmp';
          },
          whenReady: async (): Promise<void> => undefined,
          on() {},
          commandLine: {
            appendSwitch() {},
          },
          dock: {
            show() {},
            hide() {},
          },
          quit() {},
          exit() {},
        },
        BrowserWindow: {
          getAllWindows: (): unknown[] => [],
        },
        Tray: class {},
        Menu: {},
        nativeImage: {},
        ipcMain: {},
        shell: {},
        systemPreferences: {},
        globalShortcut: {},
        session: {},
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

test('scheduleAudioPipelineHealthCheck reschedules periodic checks and detects stale audio windows', async () => {
  const restoreElectron = installElectronMock();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalWarn = console.warn;
  process.env.NODE_ENV = 'test';

  let AppState: typeof import('../main').AppState;

  try {
    ({ AppState } = await import('../main'));
  } catch (error) {
    restoreElectron();
    process.env.NODE_ENV = originalNodeEnv;
    throw error;
  }

  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const warnings: string[] = [];

  (global as typeof globalThis).setTimeout = (((callback: (...args: any[]) => void, delay?: number) => {
    scheduled.push({ callback: callback as () => void, delay: Number(delay) });
    return { unref() {} } as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
  (global as typeof globalThis).clearTimeout = (((_handle: unknown): void => undefined) as unknown as typeof clearTimeout);
  console.warn = (...args: any[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    const scheduleHealthCheck = (AppState.prototype as unknown as {
      scheduleAudioPipelineHealthCheck: (this: Record<string, any>) => void;
    }).scheduleAudioPipelineHealthCheck;

    const fakeState = Object.assign(Object.create(AppState.prototype), {
      isMeetingActive: true,
      AUDIO_PIPELINE_STARTUP_HEALTH_DELAY_MS: 8000,
      AUDIO_PIPELINE_PERIODIC_HEALTH_INTERVAL_MS: 60000,
      audioHealthCheckTimer: null,
      audioPipelineStats: {
        startedAt: Date.now() - 10_000,
        systemChunks: 3,
        microphoneChunks: 2,
        interviewerTranscripts: 1,
        userTranscripts: 1,
      },
      audioPipelineLastSnapshot: {
        systemChunks: 0,
        microphoneChunks: 0,
        interviewerTranscripts: 0,
        userTranscripts: 0,
      },
    });

    scheduleHealthCheck.call(fakeState);

    assert.equal(scheduled[0]?.delay, 8000);

    scheduled[0]?.callback();

    assert.equal(scheduled[1]?.delay, 60000);
    assert.equal(warnings.some((warning) => warning.includes('No audio chunks observed during the last health window.')), false);

    scheduled[1]?.callback();

    assert.equal(warnings.some((warning) => warning.includes('No audio chunks observed during the last health window.')), true);
  } finally {
    restoreElectron();
    process.env.NODE_ENV = originalNodeEnv;
    (global as typeof globalThis).setTimeout = originalSetTimeout;
    (global as typeof globalThis).clearTimeout = originalClearTimeout;
    console.warn = originalWarn;
  }
});
