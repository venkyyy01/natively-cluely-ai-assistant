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
  public terminateCalls = 0;

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

  terminate(): void {
    this.terminateCalls += 1;
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

    assert.equal(scheduledTimeouts.length, 2);
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

test('DeepgramStreamingSTT buffers audio written before the websocket is open and flushes it on connect', async () => {
  const restoreWs = installWebSocketMock();
  const modulePath = require.resolve('../audio/DeepgramStreamingSTT');
  delete require.cache[modulePath];

  try {
    const { DeepgramStreamingSTT } = await import('../audio/DeepgramStreamingSTT');
    const stt = new DeepgramStreamingSTT('test-key');
    stt.setSampleRate(16000);

    stt.start();
    assert.equal(FakeWebSocket.instances.length, 1);

    const socket = FakeWebSocket.instances[0]!;
    stt.write(Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]));

    assert.equal(socket.sent.length, 0);
    assert.equal((stt as any).buffer.length, 1);

    socket.open();

    assert.equal((stt as any).buffer.length, 0);
    assert.equal(socket.sent.length, 2);
    assert.deepEqual(socket.sent[0], Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]));
    assert.equal(socket.sent[1], JSON.stringify({ type: 'KeepAlive' }));

    stt.stop();
  } finally {
    restoreWs();
  }
});

test('DeepgramStreamingSTT only emits final transcript events when Deepgram itself marks is_final (NAT-009)', async () => {
  const restoreWs = installWebSocketMock();
  const modulePath = require.resolve('../audio/DeepgramStreamingSTT');
  delete require.cache[modulePath];

  try {
    const { DeepgramStreamingSTT } = await import('../audio/DeepgramStreamingSTT');
    const stt = new DeepgramStreamingSTT('test-key');
    const transcripts: Array<{ text: string; isFinal: boolean; confidence: number }> = [];
    const telemetry: Array<{ kind: string; hadPendingInterim: boolean; pendingInterimLength: number }> = [];

    stt.on('transcript', (segment) => {
      transcripts.push(segment);
    });
    stt.on('telemetry', (entry) => {
      telemetry.push(entry);
    });

    stt.start();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'Results',
      channel: { alternatives: [{ transcript: 'hello there', confidence: 0.75 }] },
      is_final: false,
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'UtteranceEnd' })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'Results',
      channel: { alternatives: [{ transcript: 'general kenobi', confidence: 0.91 }] },
      is_final: true,
    })));

    // NAT-009 / audit A-10: the interim "hello there" must NOT be promoted to
    // final on UtteranceEnd. Only the second Results message, which Deepgram
    // itself marked is_final, may produce a final transcript event.
    assert.deepEqual(transcripts, [
      { text: 'hello there', isFinal: false, confidence: 0.75 },
      { text: 'general kenobi', isFinal: true, confidence: 0.91 },
    ]);

    assert.equal(telemetry.length, 1, 'one stt.utterance_end_seen telemetry event');
    assert.equal(telemetry[0]!.kind, 'stt.utterance_end_seen');
    assert.equal(telemetry[0]!.hadPendingInterim, true, 'telemetry records that an interim was in flight');
    assert.equal(telemetry[0]!.pendingInterimLength, 'hello there'.length);

    stt.stop();
  } finally {
    restoreWs();
  }
});

test('DeepgramStreamingSTT UtteranceEnd with no pending interim emits telemetry only, no transcript (NAT-009)', async () => {
  const restoreWs = installWebSocketMock();
  const modulePath = require.resolve('../audio/DeepgramStreamingSTT');
  delete require.cache[modulePath];

  try {
    const { DeepgramStreamingSTT } = await import('../audio/DeepgramStreamingSTT');
    const stt = new DeepgramStreamingSTT('test-key');
    const transcripts: Array<{ text: string; isFinal: boolean; confidence: number }> = [];
    const telemetry: Array<{ kind: string; hadPendingInterim: boolean; pendingInterimLength: number }> = [];

    stt.on('transcript', (segment) => {
      transcripts.push(segment);
    });
    stt.on('telemetry', (entry) => {
      telemetry.push(entry);
    });

    stt.start();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'UtteranceEnd' })));

    assert.deepEqual(transcripts, []);
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0]!.kind, 'stt.utterance_end_seen');
    assert.equal(telemetry[0]!.hadPendingInterim, false);
    assert.equal(telemetry[0]!.pendingInterimLength, 0);

    stt.stop();
  } finally {
    restoreWs();
  }
});

test('DeepgramStreamingSTT reconnects on close while active, including clean closes', async () => {
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
    const errors: Error[] = [];

    stt.on('error', (err) => {
      errors.push(err);
    });

    stt.start();
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.open();
    firstSocket.emit('error', new Error('ws exploded'));
    firstSocket.closeWith(1011, 'unexpected');

    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.message, 'ws exploded');
    assert.equal(scheduledTimeouts.length, 2);

    scheduledTimeouts[1]!();
    assert.equal(FakeWebSocket.instances.length, 2);

    const secondSocket = FakeWebSocket.instances[1]!;
    secondSocket.open();
    secondSocket.closeWith(1000, 'clean');

    assert.equal(scheduledTimeouts.length, 4);

    stt.stop();
  } finally {
    restoreWs();
    (global as any).setTimeout = originalSetTimeout;
    (global as any).clearTimeout = originalClearTimeout;
    (global as any).setInterval = originalSetInterval;
    (global as any).clearInterval = originalClearInterval;
  }
});

test('DeepgramStreamingSTT ignores inactive writes and malformed or non-transcript messages', async () => {
  const restoreWs = installWebSocketMock();
  const modulePath = require.resolve('../audio/DeepgramStreamingSTT');
  delete require.cache[modulePath];

  try {
    const { DeepgramStreamingSTT } = await import('../audio/DeepgramStreamingSTT');
    const stt = new DeepgramStreamingSTT('test-key');
    const transcripts: Array<{ text: string; isFinal: boolean; confidence: number }> = [];

    stt.on('transcript', (segment) => {
      transcripts.push(segment);
    });

    stt.write(Buffer.from([1, 2, 3, 4]));
    assert.equal((stt as any).buffer.length, 0);

    stt.start();
    assert.equal(FakeWebSocket.instances.length, 1);

    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.emit('message', Buffer.from('not-json'));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'Metadata' })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'Results',
      channel: { alternatives: [{ transcript: '', confidence: 0.5 }] },
      is_final: true,
    })));

    assert.deepEqual(transcripts, []);

    stt.stop();
  } finally {
    restoreWs();
  }
});

test('DeepgramStreamingSTT sends periodic keepalives and a graceful close message', async () => {
  const restoreWs = installWebSocketMock();
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const scheduledIntervals: Array<() => void> = [];

  (global as any).setInterval = (fn: () => void) => {
    scheduledIntervals.push(fn);
    return scheduledIntervals.length;
  };
  (global as any).clearInterval = () => {};

  const modulePath = require.resolve('../audio/DeepgramStreamingSTT');
  delete require.cache[modulePath];

  try {
    const { DeepgramStreamingSTT } = await import('../audio/DeepgramStreamingSTT');
    const stt = new DeepgramStreamingSTT('test-key');

    stt.start();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    assert.equal(scheduledIntervals.length, 3);

    scheduledIntervals[1]!();
    assert.equal(socket.sent[0], JSON.stringify({ type: 'KeepAlive' }));
    assert.equal(socket.sent[1], JSON.stringify({ type: 'KeepAlive' }));

    stt.stop();

    assert.equal(socket.sent[2], JSON.stringify({ type: 'CloseStream' }));
    assert.equal(socket.closeCalls, 1);
  } finally {
    restoreWs();
    (global as any).setInterval = originalSetInterval;
    (global as any).clearInterval = originalClearInterval;
  }
});

test('DeepgramStreamingSTT connection guard reconnects when socket disappears without new audio', async () => {
  const restoreWs = installWebSocketMock();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const scheduledIntervals: Array<() => void> = [];

  (global as any).setTimeout = (fn: () => void) => {
    return fn as unknown as number;
  };
  (global as any).clearTimeout = () => {};
  (global as any).setInterval = (fn: () => void) => {
    scheduledIntervals.push(fn);
    return scheduledIntervals.length;
  };
  (global as any).clearInterval = () => {};

  const modulePath = require.resolve('../audio/DeepgramStreamingSTT');
  delete require.cache[modulePath];

  try {
    const { DeepgramStreamingSTT } = await import('../audio/DeepgramStreamingSTT');
    const stt = new DeepgramStreamingSTT('test-key');

    stt.start();
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.open();

    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(scheduledIntervals.length, 3);

    (stt as any).ws = null;
    (stt as any).isConnecting = false;
    (stt as any).reconnectTimer = null;

    scheduledIntervals[0]!();

    assert.equal(FakeWebSocket.instances.length, 2);

    stt.stop();
  } finally {
    restoreWs();
    (global as any).setTimeout = originalSetTimeout;
    (global as any).clearTimeout = originalClearTimeout;
    (global as any).setInterval = originalSetInterval;
    (global as any).clearInterval = originalClearInterval;
  }
});

test('DeepgramStreamingSTT aborts hung connection attempts and schedules a reconnect', async () => {
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
    assert.equal(scheduledTimeouts.length, 1);

    scheduledTimeouts[0]!();

    const socket = FakeWebSocket.instances[0]!;
    assert.equal(socket.terminateCalls, 1);
    assert.equal(scheduledTimeouts.length, 2);

    stt.stop();
  } finally {
    restoreWs();
    (global as any).setTimeout = originalSetTimeout;
    (global as any).clearTimeout = originalClearTimeout;
    (global as any).setInterval = originalSetInterval;
    (global as any).clearInterval = originalClearInterval;
  }
});

test('DeepgramStreamingSTT recycles an open socket when inbound activity stalls during audio flow', async () => {
  const restoreWs = installWebSocketMock();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const scheduledTimeouts: Array<() => void> = [];
  const scheduledIntervals: Array<() => void> = [];

  (global as any).setTimeout = (fn: () => void) => {
    scheduledTimeouts.push(fn);
    return scheduledTimeouts.length;
  };
  (global as any).clearTimeout = () => {};
  (global as any).setInterval = (fn: () => void) => {
    scheduledIntervals.push(fn);
    return scheduledIntervals.length;
  };
  (global as any).clearInterval = () => {};

  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;

  const modulePath = require.resolve('../audio/DeepgramStreamingSTT');
  delete require.cache[modulePath];

  try {
    const { DeepgramStreamingSTT } = await import('../audio/DeepgramStreamingSTT');
    const stt = new DeepgramStreamingSTT('test-key');
    stt.setSampleRate(16000);

    stt.start();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    assert.equal(scheduledIntervals.length, 3);

    now = 1000;
    stt.write(Buffer.from([100, 0, 100, 0, 100, 0, 100, 0]));

    now = 16000;
    scheduledIntervals[2]!();

    assert.equal(socket.terminateCalls, 1);
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(scheduledTimeouts.length, 2);

    stt.stop();
  } finally {
    restoreWs();
    (global as any).setTimeout = originalSetTimeout;
    (global as any).clearTimeout = originalClearTimeout;
    (global as any).setInterval = originalSetInterval;
    (global as any).clearInterval = originalClearInterval;
    Date.now = originalNow;
  }
});
