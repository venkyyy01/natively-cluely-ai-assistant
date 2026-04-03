import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

class FakeSystemAudioMonitor {
  static instances = 0;
  static sampleRate = 44100;
  static ready = false;
  static failInitialization = false;
  static runtimeErrorMessage: string | null = null;

  constructor(_deviceId?: string | null) {
    FakeSystemAudioMonitor.instances += 1;
  }

  getSampleRate(): number {
    return FakeSystemAudioMonitor.sampleRate;
  }

  isInitialized(): boolean {
    return FakeSystemAudioMonitor.ready;
  }

  start(_onData?: unknown, _onSpeechEnded?: unknown, onError?: (message: string) => void): void {
    setTimeout(() => {
      if (FakeSystemAudioMonitor.failInitialization) {
        FakeSystemAudioMonitor.sampleRate = 0;
        return;
      }
      FakeSystemAudioMonitor.ready = true;

      if (FakeSystemAudioMonitor.runtimeErrorMessage) {
        onError?.(FakeSystemAudioMonitor.runtimeErrorMessage);
      }
    }, 5);
  }
  stop(): void {}
}

function installSystemAudioMocks(): () => void {
  const originalLoad = (Module as any)._load;
  FakeSystemAudioMonitor.instances = 0;
  FakeSystemAudioMonitor.sampleRate = 44100;
  FakeSystemAudioMonitor.ready = false;
  FakeSystemAudioMonitor.failInitialization = false;
  FakeSystemAudioMonitor.runtimeErrorMessage = null;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === './nativeModule') {
      const nativeModule = {
        SystemAudioCapture: FakeSystemAudioMonitor,
      };

      return {
        loadNativeAudioModule: (): { SystemAudioCapture: typeof FakeSystemAudioMonitor } => nativeModule,
        assertNativeAudioAvailable: (): { SystemAudioCapture: typeof FakeSystemAudioMonitor } => nativeModule,
        getNativeAudioLoadError: (): null => null,
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

async function flushFakeMonitorTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('SystemAudioCapture keeps the fallback sample rate before start and only creates the native monitor when capture starts', { concurrency: false }, async () => {
  const restore = installSystemAudioMocks();
  const modulePath = require.resolve('../audio/SystemAudioCapture');
  delete require.cache[modulePath];

  try {
    const { SystemAudioCapture } = await import('../audio/SystemAudioCapture');
    const capture = new SystemAudioCapture();

    assert.equal(capture.getSampleRate(), 48000);
    assert.equal(FakeSystemAudioMonitor.instances, 0);

    capture.start();
    assert.equal(FakeSystemAudioMonitor.instances, 1);
    assert.equal(capture.getSampleRate(), 48000);
    await flushFakeMonitorTick();
    capture.stop();
  } finally {
    restore();
  }
});

test('SystemAudioCapture waits for the native monitor to report readiness before exposing the real sample rate', { concurrency: false }, async () => {
  const restore = installSystemAudioMocks();
  const modulePath = require.resolve('../audio/SystemAudioCapture');
  delete require.cache[modulePath];

  try {
    const { SystemAudioCapture } = await import('../audio/SystemAudioCapture');
    const capture = new SystemAudioCapture();

    capture.start();
    const rate = await capture.waitForReady(100, 1);

    assert.equal(rate, 44100);
    assert.equal(capture.getSampleRate(), 44100);
    await flushFakeMonitorTick();
    capture.stop();
  } finally {
    restore();
  }
});

test('SystemAudioCapture fails fast when the native monitor reports startup failure', { concurrency: false }, async () => {
  const restore = installSystemAudioMocks();
  FakeSystemAudioMonitor.failInitialization = true;
  const modulePath = require.resolve('../audio/SystemAudioCapture');
  delete require.cache[modulePath];

  try {
    const { SystemAudioCapture } = await import('../audio/SystemAudioCapture');
    const capture = new SystemAudioCapture();

    capture.start();

    await assert.rejects(
      () => capture.waitForReady(100, 1),
      /failed to initialize|Timed out waiting for native readiness/i,
    );
    await flushFakeMonitorTick();
    capture.stop();
  } finally {
    restore();
  }
});

test('SystemAudioCapture forwards native runtime errors through the wrapper event emitter', { concurrency: false }, async () => {
  const restore = installSystemAudioMocks();
  FakeSystemAudioMonitor.runtimeErrorMessage = 'loopback died';
  const modulePath = require.resolve('../audio/SystemAudioCapture');
  delete require.cache[modulePath];

  try {
    const { SystemAudioCapture } = await import('../audio/SystemAudioCapture');
    const capture = new SystemAudioCapture();

    const error = await new Promise<Error>((resolve) => {
      capture.once('error', resolve);
      capture.start();
    });

    assert.match(error.message, /loopback died/);
    await flushFakeMonitorTick();
    capture.stop();
  } finally {
    restore();
  }
});
