import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

class FakeSystemAudioMonitor {
  static instances = 0;
  static sampleRate = 44100;
  static ready = false;

  constructor(_deviceId?: string | null) {
    FakeSystemAudioMonitor.instances += 1;
  }

  getSampleRate(): number {
    return FakeSystemAudioMonitor.sampleRate;
  }

  isInitialized(): boolean {
    return FakeSystemAudioMonitor.ready;
  }

  start(): void {
    setTimeout(() => {
      FakeSystemAudioMonitor.ready = true;
    }, 5);
  }
  stop(): void {}
}

function installSystemAudioMocks(): () => void {
  const originalLoad = (Module as any)._load;
  FakeSystemAudioMonitor.instances = 0;
  FakeSystemAudioMonitor.ready = false;

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

test('SystemAudioCapture keeps the fallback sample rate before start and only creates the native monitor when capture starts', async () => {
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
  } finally {
    restore();
  }
});

test('SystemAudioCapture waits for the native monitor to report readiness before exposing the real sample rate', async () => {
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
  } finally {
    restore();
  }
});
