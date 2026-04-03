import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

class FakeSystemAudioMonitor {
  static callbackMode: 'error-slot' | 'direct' | 'empty' = 'error-slot';
  static emitSpeechEnded = false;
  static startCalls = 0;
  static stopCalls = 0;

  getSampleRate(): number {
    return 48_000;
  }

  start(callback: (first: Uint8Array | null, second?: Uint8Array) => void, onSpeechEnded?: () => void): void {
    FakeSystemAudioMonitor.startCalls += 1;

    if (FakeSystemAudioMonitor.callbackMode === 'direct') {
      callback(Uint8Array.from([9, 8, 7]));
    } else if (FakeSystemAudioMonitor.callbackMode === 'empty') {
      callback(Uint8Array.from([]));
    } else {
      callback(null, Uint8Array.from([1, 2, 3, 4]));
    }

    if (FakeSystemAudioMonitor.emitSpeechEnded) {
      onSpeechEnded?.();
    }
  }

  stop(): void {
    FakeSystemAudioMonitor.stopCalls += 1;
  }
}

class FakeMicrophoneMonitor {
  static callbackMode: 'error-slot' | 'direct' | 'empty' = 'error-slot';
  static emitSpeechEnded = false;
  static instances = 0;
  static startCalls = 0;
  static stopCalls = 0;

  constructor() {
    FakeMicrophoneMonitor.instances += 1;
  }

  getSampleRate(): number {
    return 48_000;
  }

  start(callback: (first: Uint8Array | null, second?: Uint8Array) => void, onSpeechEnded?: () => void): void {
    FakeMicrophoneMonitor.startCalls += 1;

    if (FakeMicrophoneMonitor.callbackMode === 'direct') {
      callback(Uint8Array.from([8, 7, 6]));
    } else if (FakeMicrophoneMonitor.callbackMode === 'empty') {
      callback(Uint8Array.from([]));
    } else {
      callback(null, Uint8Array.from([5, 6, 7, 8]));
    }

    if (FakeMicrophoneMonitor.emitSpeechEnded) {
      onSpeechEnded?.();
    }
  }

  stop(): void {
    FakeMicrophoneMonitor.stopCalls += 1;
  }
}

function installNativeAudioMocks(): () => void {
  const originalLoad = (Module as any)._load;
  FakeSystemAudioMonitor.callbackMode = 'error-slot';
  FakeSystemAudioMonitor.emitSpeechEnded = false;
  FakeSystemAudioMonitor.startCalls = 0;
  FakeSystemAudioMonitor.stopCalls = 0;
  FakeMicrophoneMonitor.callbackMode = 'error-slot';
  FakeMicrophoneMonitor.emitSpeechEnded = false;
  FakeMicrophoneMonitor.instances = 0;
  FakeMicrophoneMonitor.startCalls = 0;
  FakeMicrophoneMonitor.stopCalls = 0;

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

test('SystemAudioCapture handles direct payload callbacks and lifecycle events without double-starting', async () => {
  const restore = installNativeAudioMocks();
  const modulePath = require.resolve('../audio/SystemAudioCapture');
  delete require.cache[modulePath];
  FakeSystemAudioMonitor.callbackMode = 'direct';
  FakeSystemAudioMonitor.emitSpeechEnded = true;

  try {
    const { SystemAudioCapture } = await import('../audio/SystemAudioCapture');
    const capture = new SystemAudioCapture('speaker-1');
    const received: number[][] = [];
    let started = 0;
    let speechEnded = 0;
    let stopped = 0;

    capture.on('data', (chunk: Buffer) => {
      received.push(Array.from(chunk.values()));
    });
    capture.on('start', () => {
      started += 1;
    });
    capture.on('speech_ended', () => {
      speechEnded += 1;
    });
    capture.on('stop', () => {
      stopped += 1;
    });

    capture.start();
    capture.start();
    capture.stop();

    assert.deepEqual(received, [[9, 8, 7]]);
    assert.equal(started, 1);
    assert.equal(speechEnded, 1);
    assert.equal(stopped, 1);
    assert.equal(FakeSystemAudioMonitor.startCalls, 1);
    assert.equal(FakeSystemAudioMonitor.stopCalls, 1);
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

test('MicrophoneCapture reinitializes a missing monitor and ignores empty chunks', async () => {
  const restore = installNativeAudioMocks();
  const modulePath = require.resolve('../audio/MicrophoneCapture');
  delete require.cache[modulePath];
  FakeMicrophoneMonitor.callbackMode = 'empty';
  FakeMicrophoneMonitor.emitSpeechEnded = true;

  try {
    const { MicrophoneCapture } = await import('../audio/MicrophoneCapture');
    const capture = new MicrophoneCapture();
    let dataEvents = 0;
    let speechEnded = 0;
    let started = 0;
    let stopped = 0;

    capture.on('data', () => {
      dataEvents += 1;
    });
    capture.on('speech_ended', () => {
      speechEnded += 1;
    });
    capture.on('start', () => {
      started += 1;
    });
    capture.on('stop', () => {
      stopped += 1;
    });

    (capture as unknown as { monitor: unknown }).monitor = null;

    capture.start();
    capture.start();
    capture.stop();

    assert.equal(dataEvents, 0);
    assert.equal(speechEnded, 1);
    assert.equal(started, 1);
    assert.equal(stopped, 1);
    assert.equal(FakeMicrophoneMonitor.instances, 2);
    assert.equal(FakeMicrophoneMonitor.startCalls, 1);
    assert.equal(FakeMicrophoneMonitor.stopCalls, 1);
  } finally {
    restore();
  }
});
