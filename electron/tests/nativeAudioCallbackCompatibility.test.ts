import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

class FakeSystemAudioMonitor {
  getSampleRate(): number {
    return 48_000;
  }

  start(callback: (first: Uint8Array | null, second?: Uint8Array) => void): void {
    callback(null, Uint8Array.from([1, 2, 3, 4]));
  }

  stop(): void {}
}

class FakeMicrophoneMonitor {
  getSampleRate(): number {
    return 48_000;
  }

  start(callback: (first: Uint8Array | null, second?: Uint8Array) => void): void {
    callback(null, Uint8Array.from([5, 6, 7, 8]));
  }

  stop(): void {}
}

function installNativeAudioMocks(): () => void {
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === './nativeModule') {
      const nativeModule = {
        SystemAudioCapture: FakeSystemAudioMonitor,
        MicrophoneCapture: FakeMicrophoneMonitor,
      };

      return {
        loadNativeAudioModule: (): typeof nativeModule => nativeModule,
        assertNativeAudioAvailable: (): typeof nativeModule => nativeModule,
        getNativeAudioLoadError: (): null => null,
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

test('SystemAudioCapture forwards chunks when native callbacks include a leading error slot', async () => {
  const restore = installNativeAudioMocks();
  const modulePath = require.resolve('../audio/SystemAudioCapture');
  delete require.cache[modulePath];

  try {
    const { SystemAudioCapture } = await import('../audio/SystemAudioCapture');
    const capture = new SystemAudioCapture();
    let received: Buffer | null = null;

    capture.on('data', (chunk: Buffer) => {
      received = chunk;
    });

    capture.start();

    assert.ok(received);
    assert.deepEqual(Array.from(received!.values()), [1, 2, 3, 4]);
  } finally {
    restore();
  }
});

test('MicrophoneCapture forwards chunks when native callbacks include a leading error slot', async () => {
  const restore = installNativeAudioMocks();
  const modulePath = require.resolve('../audio/MicrophoneCapture');
  delete require.cache[modulePath];

  try {
    const { MicrophoneCapture } = await import('../audio/MicrophoneCapture');
    const capture = new MicrophoneCapture();
    let received: Buffer | null = null;

    capture.on('data', (chunk: Buffer) => {
      received = chunk;
    });

    capture.start();

    assert.ok(received);
    assert.deepEqual(Array.from(received!.values()), [5, 6, 7, 8]);
  } finally {
    restore();
  }
});
