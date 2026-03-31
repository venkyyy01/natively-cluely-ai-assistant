import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { EventEmitter } from 'node:events';

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  public readyState = FakeWebSocket.CONNECTING;
  public sent: unknown[] = [];
  public closeCalls = 0;

  constructor(public url: string, public options: unknown) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  closeWith(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }
}

function installWebSocketMock(): () => void {
  const originalLoad = (Module as any)._load;
  FakeWebSocket.instances = [];

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'ws') {
      return FakeWebSocket;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

test('DeepgramStreamingSTT ignores stale socket close events after an in-place restart', async () => {
  const restoreWs = installWebSocketMock();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const scheduledTimeouts: Array<() => void> = [];

  (global as any).setTimeout = (fn: () => void) => {
    scheduledTimeouts.push(fn);
    return scheduledTimeouts.length;
  };
  (global as any).clearTimeout = () => {};
  (global as any).setInterval = () => 1;
  (global as any).clearInterval = () => {};

  const modulePath = require.resolve('../audio/DeepgramStreamingSTT');
  delete require.cache[modulePath];

  try {
    const { DeepgramStreamingSTT } = await import('../audio/DeepgramStreamingSTT');
    const stt = new DeepgramStreamingSTT('test-key');

    stt.start();
    assert.equal(FakeWebSocket.instances.length, 1);

    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.open();

    stt.setRecognitionLanguage('spanish');
    assert.equal(FakeWebSocket.instances.length, 2);
    const secondSocket = FakeWebSocket.instances[1]!;
    assert.equal(firstSocket.closeCalls, 1);

    firstSocket.closeWith(1006, 'stale-close');

    assert.equal(scheduledTimeouts.length, 0);
    assert.equal((stt as any).ws, secondSocket);

    stt.stop();
  } finally {
    restoreWs();
    (global as any).setTimeout = originalSetTimeout;
    (global as any).clearTimeout = originalClearTimeout;
    (global as any).setInterval = originalSetInterval;
    (global as any).clearInterval = originalClearInterval;
  }
});
