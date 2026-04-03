import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { EventEmitter } from 'node:events';

class FakeRecognitionStream extends EventEmitter {
  public command = { writable: true };
  public writable = true;
  public ended = false;
  public destroyed = false;

  write(): void {}

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
    this.writable = false;
  }
}

class FakeSpeechClient {
  static streams: FakeRecognitionStream[] = [];

  constructor(_options: unknown) {}

  streamingRecognize(): FakeRecognitionStream {
    const stream = new FakeRecognitionStream();
    FakeSpeechClient.streams.push(stream);
    return stream;
  }
}

function installSpeechMock(): () => void {
  const originalLoad = (Module as any)._load;
  FakeSpeechClient.streams = [];

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === '@google-cloud/speech') {
      return { SpeechClient: FakeSpeechClient };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

test('GoogleSTT proactively rotates the stream before the vendor timeout window', async () => {
  const restoreSpeech = installSpeechMock();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const scheduledTimeouts: Array<{ delay: number; fn: () => void }> = [];

  (global as any).setTimeout = (fn: () => void, delay?: number) => {
    scheduledTimeouts.push({ fn, delay: Number(delay ?? 0) });
    return scheduledTimeouts.length;
  };
  (global as any).clearTimeout = () => {};

  const modulePath = require.resolve('../audio/GoogleSTT');
  delete require.cache[modulePath];

  try {
    const { GoogleSTT } = await import('../audio/GoogleSTT');
    const stt = new GoogleSTT();

    stt.start();

    assert.equal(FakeSpeechClient.streams.length, 1);

    const proactiveRestart = scheduledTimeouts.find((entry) => entry.delay === 270000);
    assert.ok(proactiveRestart, 'expected a proactive Google stream rollover timer at 270000ms');

    proactiveRestart.fn();

    assert.equal(FakeSpeechClient.streams.length, 2);
    stt.stop();
  } finally {
    restoreSpeech();
    (global as any).setTimeout = originalSetTimeout;
    (global as any).clearTimeout = originalClearTimeout;
  }
});
